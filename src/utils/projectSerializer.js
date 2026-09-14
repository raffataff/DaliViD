/**
 * DaliVid — projectSerializer.js
 * Save/Load project state to/from IndexedDB via idb-keyval.
 * Also provides JSON export/import for file-based save.
 */

import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval'
import useAppStore from '../store/useAppStore.js'
import useGraphStore from '../store/useGraphStore.js'
import useTimelineStore, { restoreTrackOrder } from '../store/useTimelineStore.js'
import { STARTER_TRANSITION_COMPOUND } from '../shaders/compoundPresets.js'
import { clearDetectedAlpha } from '../gl/alphaRegistry.js'
import { resetTransitionStatus } from '../gl/transitionStatus.js'
import { migrateTimeNodeParams, getDataNodeParams } from '../shaders/dataNodeParams.js'
import { getNodeSource } from '../shaders/shaderRegistry.js'
import { parseParams } from './paramParser.js'
import { clearHistory } from './history.js'
import { serializeCustomFontRefs, embedCustomFontData, restoreCustomFonts } from './fontRegistry.js'
import { collectUsedFontValues } from './fontUsage.js'
import { addToast } from '../components/common/Toast.jsx'
import useMediaStore from '../store/useMediaStore.js'
import { SCHEMA_VERSION, migrateV1toV2, mapNodes } from '../storage/schema.js'
import {
  writeProject, readProjectMigrating,
  listProjects as listStoredProjects, deleteProject as removeStoredProject,
} from '../storage/projectStore.js'

// Projects live in the vault now (see storage/projectStore.js). The legacy
// `dalivid_project_<id>` IndexedDB keys are still READ, and migrated into the
// vault on first open — `listProjects` unions both so nothing is stranded.
const AUTOSAVE_KEY = 'dalivid_autosave'

/**
 * Fields that exist only while the app is running and must never be written.
 *
 * `fileUrl` was always handled this way (a `blob:` URL in a saved file is
 * meaningless garbage that *looks* like a working reference). `imageSrc` now
 * joins it: from v2 an image's identity is `imageRefId`, and `imageSrc` is just
 * this session's resolution of it. Writing it back would re-inflate exactly the
 * base64 payload the whole change exists to remove — on `Streetlamp_vid_2108`
 * that is 389 KB of a 401 KB document, rewritten on every autosave.
 *
 * `imageSrc` is only dropped when there IS an `imageRefId` to replace it. A v1
 * project that has not been migrated yet keeps its data URL, so an interrupted
 * migration can never lose the image.
 */
function stripRuntimeParams(params) {
  if (!params || typeof params !== 'object') return params
  if (params.imageRefId && params.imageSrc !== undefined) {
    const out = { ...params }
    delete out.imageSrc
    return out
  }
  return params
}

/**
 * Remove runtime-only media fields from a fully-built document.
 *
 * Done as one pass over the finished document rather than at each of the four
 * places that map a node, because `subGraph` is deep-cloned wholesale — so a
 * compound's interior would keep its data URLs no matter how carefully the
 * top-level mapping was written. `mapNodes` is the single definition of "every
 * node, everywhere", which is exactly the recursion this needs.
 */
function stripRuntimeMedia(doc) {
  const out = { ...doc }

  if (doc.timeline?.clips) {
    out.timeline = {
      ...doc.timeline,
      clips: doc.timeline.clips.map(c => {
        const params = stripRuntimeParams(c.params)
        return params === c.params ? c : { ...c, params }
      }),
    }
  }

  out.graph = mapNodes(doc.graph, (n) => {
    const params = stripRuntimeParams(n?.params)
    return params === n?.params ? n : { ...n, params }
  })

  return out
}

/**
 * Plain-object copy of an edge transition, or null.
 * `params` is copied shallowly on purpose: values are scalars, colour strings,
 * or exposed-param values keyed by index — never nested objects.
 */
function serializeTransition(tr) {
  return tr && tr.type ? { type: tr.type, params: { ...(tr.params || {}) } } : null
}

/**
 * Migration: the combined TIME node was split into RAMP (plays once across a
 * span) and LFO (oscillates forever). `migrateTimeNodeParams` picks which one a
 * saved node meant from its Source and translates its params; both new types
 * expose the `value` and `seconds` output sockets TIME had, so edges are
 * untouched and no graph needs rewiring.
 *
 * Runs on every graph — master, each clip, compound interiors and the compound
 * library — because a TIME node could be saved at any depth. Nodes are only
 * copied when something actually changes, so a project with no TIME nodes keeps
 * its object identity (Zustand's snapshot-based undo depends on that).
 */
/**
 * Backfill any param the node's shader DECLARES but the saved node does not
 * carry, from that param's own `@param` default.
 *
 * **This is a whole CLASS of silent bug, not a one-off.** `uploadUniforms` skips
 * a uniform the node has no value for, so the shader runs on GLSL's implicit
 * ZERO — and a project saved before a shader gained a param has exactly that
 * gap. It is the same failure `SOURCE_PARAMS` already guards for TRANSITION_FX
 * ("switching Crossfade → Film Burn leaves every Film Burn uniform absent…"),
 * and the v0.15 AUDIO_VISUALIZER rework reintroduced it at scale: 39 new
 * uniforms, 18 with non-zero defaults. On a pre-v0.15 node that meant
 * `u_intensity` = 0, so `col *= u_intensity` erased the graphics ENTIRELY, and
 * `u_style` = 0 (Over) while the card's select displayed its default of 1 (Add)
 * — the UI and the shader disagreeing about the same control.
 *
 * Only ever ADDS keys, so a value the user actually set always wins, and the
 * node object is reused untouched when nothing is missing (Zustand's
 * snapshot-based undo depends on that identity).
 */
function backfillNodeParams(node) {
  if (!node?.type) return node
  let configs
  try {
    // getNodeSource resolves custom edits → attached shaderCode → registry, so a
    // Monaco-forked node backfills against ITS source, not the stock one.
    const src = getNodeSource(node)
    configs = src ? parseParams(src) : getDataNodeParams(node.type)
  } catch {
    return node // a node type with no resolvable source is simply not our problem
  }
  if (!configs || configs.length === 0) return node
  const params = node.params || {}
  let missing = null
  for (const c of configs) {
    if (!c?.uniformName || c.default === undefined) continue
    if (Object.prototype.hasOwnProperty.call(params, c.uniformName)) continue
    if (!missing) missing = {}
    missing[c.uniformName] = c.default
  }
  return missing ? { ...node, params: { ...params, ...missing } } : node
}

function migrateGraphNodes(nodes) {
  if (!Array.isArray(nodes)) return nodes
  let changed = false
  const out = nodes.map(n => {
    let node = n
    if (n?.type === 'TIME') {
      const { type, params } = migrateTimeNodeParams(n.params || {})
      const wasDefault = !n.name || /^(time|time \/ lfo)$/i.test(n.name)
      node = { ...n, type, params, name: wasDefault ? (type === 'RAMP' ? 'Ramp' : 'LFO') : n.name }
      changed = true
    }
    // After the TIME split, so a migrated RAMP/LFO is filled from ITS own config.
    const filled = backfillNodeParams(node)
    if (filled !== node) { node = filled; changed = true }
    if (node?.subGraph?.nodes) {
      const inner = migrateGraphNodes(node.subGraph.nodes)
      if (inner !== node.subGraph.nodes) {
        node = { ...node, subGraph: { ...node.subGraph, nodes: inner } }
        changed = true
      }
    }
    return node
  })
  return changed ? out : nodes
}

/**
 * Serialize the entire project state into a plain object.
 * @param {Function} getAppStore
 * @param {Function} getGraphStore
 * @param {Function} getTimelineStore
 * @returns {object}
 */
export function serializeProject(getAppStore, getGraphStore, getTimelineStore) {
  const app = getAppStore()
  const graph = getGraphStore()
  const timeline = getTimelineStore()

  const doc = {
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),

    // The Media Pool. Until v2 this did not persist at all — it lived in
    // `useState` inside MediaPool.jsx, so every reload lost it and the only way
    // back was matching by filename. Refs are content-addressed, so a reload
    // re-resolves them against the vault with no prompt.
    //
    // `serializeRefs` strips local-only fields and drops session-only entries:
    // their bytes were never copied into the vault, so saving them would produce
    // a document claiming media it cannot possibly resolve on the next open.
    media: {
      refs: useMediaStore.getState().serializeRefs(),
    },

    project: {
      name: app.projectName,
      id: app.projectId,
      fps: app.fps,
      resolution: { ...app.resolution },
      colorSpace: app.colorSpace,
      bpm: app.bpm,
      beatOffset: app.beatOffset,
      beatGridEnabled: app.beatGridEnabled,
      // The effect the T shortcut / edge hotspots apply. A project setting
      // because it is an editorial preference, like the beat grid.
      defaultTransition: app.defaultTransition,
      // Delivery framing (widescreen bars) is a project setting, not a node.
      masterBars: { ...app.masterBars },
    },

    timeline: {
      tracks: timeline.tracks.map(t => ({
        id: t.id,
        name: t.name,
        type: t.type,
        muted: t.muted,
        solo: t.solo,
        locked: t.locked,
        blendMode: t.blendMode,
        opacity: t.opacity,
        color: t.color,
        zOrder: t.zOrder,
      })),
      clips: timeline.clips.map(c => ({
        id: c.id,
        trackId: c.trackId,
        filename: c.filename,
        // KEPT FOREVER, alongside mediaRefId. It is the downgrade path (a v2
        // project opened by a v1 build falls back to relink-by-name and loses
        // the refs, not the edit) and the fallback when a ref cannot resolve.
        // Costs nothing. See VAULT.md.
        mediaRefId: c.mediaRefId || null,
        fileType: c.fileType,
        timelineStart: c.timelineStart,
        timelineEnd: c.timelineEnd,
        sourceStart: c.sourceStart,
        sourceEnd: c.sourceEnd,
        speed: c.speed,
        reversed: !!c.reversed,
        opacity: c.opacity,
        volume: c.volume == null ? 1 : c.volume,
        audioMuted: !!c.audioMuted,
        blendMode: c.blendMode,
        // Alpha interpretation (see utils/alphaModes). Omitted rather than
        // defaulted on save so an untouched clip stays on 'auto' and picks up
        // any future improvement to detection instead of being frozen to
        // whatever this session decided.
        alphaMode: c.alphaMode || undefined,
        alphaMatte: c.alphaMatte || undefined,
        fadeIn: c.fadeIn || 0,
        fadeOut: c.fadeOut || 0,
        // Edge transitions. `transition` (head-only, pre-edge-model) is written
        // as null rather than omitted so a project saved by this version and
        // reopened by an older one degrades to plain fades instead of throwing.
        transitionIn: serializeTransition(c.transitionIn || c.transition),
        transitionOut: serializeTransition(c.transitionOut),
        transition: null,
        // Pan / zoom / rotate framing (uniform-keyed; see utils/clipTransform.js).
        // Kept null when unset so the renderer can skip the pass on load.
        transform: c.transform ? { ...c.transform } : null,
        // Generator clips (text/image) carry their content + style here (text
        // string, image data URL, fit/transform). Self-contained — no external
        // file, so text/image clips survive save/load with no re-import.
        params: c.params ? { ...c.params } : {},
        metadata: { ...c.metadata },
        hasEffects: c.hasEffects,
        // Note: fileUrl (blob URL) is NOT saved — user must re-import files
      })),
      markers: timeline.markers.map(m => ({ ...m })),
      inPoint: timeline.inPoint,
      outPoint: timeline.outPoint,
      keyframes: timeline.keyframes.map(k => ({
        ...k,
        keys: k.keys.map(key => ({ ...key })),
      })),
    },

    graph: {
      masterGraph: {
        nodes: graph.masterGraph.nodes.map(n => ({
          id: n.id,
          type: n.type,
          name: n.name,
          position: { ...n.position },
          params: { ...n.params },
          shaderCode: n.shaderCode,
          customShaderSource: n.customShaderSource,
          bypassed: n.bypassed,
          locked: n.locked,
          // Card geometry. Not cosmetic enough to drop: a graph you collapsed and
          // sized IS the layout you arranged, and losing it on reload is the same
          // class of bug as the terminal tags below. undefined values are dropped
          // by JSON.stringify, so an untouched node costs nothing.
          collapsed: n.collapsed || undefined,
          width: n.width,
          height: n.height,
          audioBindings: { ...n.audioBindings },
          // Terminal tags on EFFECT_INPUT nodes. Both were being dropped, and
          // both matter on reload: `terminalRole` is how a transition binds FROM
          // vs TO (without it the two sides fall back to array order and can
          // swap), and `audioBand` is how a compound's band terminal routes its
          // splitter band. undefined values are dropped by JSON.stringify, so
          // ordinary nodes cost nothing.
          terminalRole: n.terminalRole,
          audioBand: n.audioBand ?? undefined,
          // COMPOUND nodes carry their whole interior — without these fields a
          // saved compound loses its sub-graph on reload and compiles to
          // nothing. undefined values are dropped by JSON.stringify.
          subGraph: n.subGraph ? JSON.parse(JSON.stringify(n.subGraph)) : undefined,
          exposedParams: n.exposedParams ? JSON.parse(JSON.stringify(n.exposedParams)) : undefined,
          color: n.color,
          description: n.description,
          nodeCount: n.nodeCount,
        })),
        edges: graph.masterGraph.edges.map(e => ({ ...e })),
        tapPointNodeId: graph.masterGraph.tapPointNodeId,
      },
      clipGraphs: Object.fromEntries(
        Object.entries(graph.clipGraphs).map(([clipId, g]) => [
          clipId,
          {
            nodes: g.nodes.map(n => ({
              id: n.id,
              type: n.type,
              name: n.name,
              position: { ...n.position },
              params: { ...n.params },
              shaderCode: n.shaderCode,
              customShaderSource: n.customShaderSource,
              bypassed: n.bypassed,
              locked: n.locked,
              // See masterGraph note — card geometry.
              collapsed: n.collapsed || undefined,
              width: n.width,
              height: n.height,
              audioBindings: n.audioBindings ? { ...n.audioBindings } : {},
              // See masterGraph note — transition graphs live in clipGraphs, so
              // this is the map that actually carries FROM/TO roles.
              terminalRole: n.terminalRole,
              audioBand: n.audioBand ?? undefined,
              // See masterGraph note: compounds must keep their interior.
              subGraph: n.subGraph ? JSON.parse(JSON.stringify(n.subGraph)) : undefined,
              exposedParams: n.exposedParams ? JSON.parse(JSON.stringify(n.exposedParams)) : undefined,
              color: n.color,
              description: n.description,
              nodeCount: n.nodeCount,
            })),
            edges: g.edges.map(e => ({ ...e })),
            tapPointNodeId: g.tapPointNodeId,
          }
        ])
      ),
      compoundLibrary: graph.compoundLibrary.map(c => ({
        id: c.id,
        name: c.name,
        version: c.version,
        subGraph: c.subGraph,
        exposedParams: c.exposedParams,
      })),
    },

    // Metadata for the user-added fonts this project references — deliberately
    // NOT the font binaries. This object is rewritten by autosave on a debounce
    // as the user types, and a font is megabytes; the bytes live under their own
    // IndexedDB keys and are only inlined by exportProjectAsJSON, which runs
    // once when the user asks for a file. Restricting the list to fonts actually
    // in use also keeps one project from carrying someone's whole font library.
    fonts: serializeCustomFontRefs(collectUsedFontValues(graph, timeline)),

    ui: {
      graphLevel: app.graphLevel,
      graphClipId: app.graphClipId,
      graphCompoundPath: [...app.graphCompoundPath],
      editMode: app.editMode,
    },
  }

  return stripRuntimeMedia(doc)
}

/**
 * Deserialize a project into store actions.
 * @param {object} data — serialized project
 * @param {Function} getAppStore
 * @param {Function} getGraphStore
 * @param {Function} getTimelineStore
 */
export function deserializeProject(data, getAppStore) {
  if (!data || (data.version !== 1 && data.version !== SCHEMA_VERSION)) {
    console.error('[ProjectSerializer] Unsupported project version:', data?.version)
    return false
  }

  // v1 → v2 is pure and idempotent: it adds `media.refs` and `mediaRefId: null`
  // and nothing else, so a v1 project opens exactly as it always did. Converting
  // its inlined images into blobs needs bytes written to storage, so that half
  // runs afterwards in `restoreProjectMedia` — deliberately not blocking the
  // open, the same way `restoreCustomFonts` below does not.
  data = migrateV1toV2(data)

  const app = getAppStore()

  // Alpha detections are keyed by FILENAME so splits of one file share a probe.
  // That means they must not survive a project load: a different project can
  // legitimately have a different "logo.webm", and inheriting the old verdict
  // would apply the wrong interpretation to it.
  clearDetectedAlpha()

  // Same reasoning for transition health: a status is a claim about a clip edge
  // in the OLD project, and clip ids are reused across a save/load round trip.
  // The renderer re-evaluates every edge it composites, so clearing costs
  // nothing and stops a stale warning outliving the thing it described.
  resetTransitionStatus()

  // Re-register the project's custom fonts. Deliberately not awaited: a project
  // must open at once, and text that is briefly drawn in a fallback corrects
  // itself as each face lands (the font's load state is part of the text raster
  // signature, so the renderer redraws it on the next frame).
  if (data.fonts?.length) {
    restoreCustomFonts(data.fonts).then(({ missing }) => {
      if (!missing.length) return
      addToast({
        message: missing.length === 1
          ? `This project uses the font "${missing[0]}", which isn't on this machine. Add the font file in Media Pool → Fonts to restore it.`
          : `${missing.length} fonts used by this project aren't on this machine. Add them in Media Pool → Fonts to restore them.`,
        type: 'warning',
        duration: 8000,
      })
    })
  }

  // Restore project settings
  if (data.project) {
    app.setProjectSettings({
      projectName: data.project.name,
      projectId: data.project.id,
      fps: data.project.fps,
      resolution: data.project.resolution,
      colorSpace: data.project.colorSpace,
      bpm: data.project.bpm ?? 120,
      beatOffset: data.project.beatOffset ?? 0,
      beatGridEnabled: !!data.project.beatGridEnabled,
      // `??` not `||`: '' is a real choice (plain opacity ramp), so only a
      // genuinely absent field should fall back to the crossfade.
      defaultTransition: data.project.defaultTransition ?? 'CROSSFADE',
      // Older projects have no bars block — fall back to the "off" defaults so a
      // missing field can't silently letterbox someone's edit.
      masterBars: {
        enabled: false, aspect: 2.39, color: '#000000', opacity: 1, feather: 0, offset: 0, zoom: 0,
        ...(data.project.masterBars || {}),
      },
    })
  }

  // Restore timeline — need to set state directly via Zustand
  if (data.timeline) {
    useTimelineStore.setState({
      // Rebuilt from the saved zOrders so index == zOrder, which the panel's
      // reversed row order now depends on. Sorting by zOrder (rather than
      // trusting array order) is what guarantees a legacy project still renders
      // exactly as it did — see restoreTrackOrder.
      tracks: restoreTrackOrder(data.timeline.tracks || []),
      // Two migrations, both of which keep older projects rendering identically:
      //
      // 1. clip blendMode 'Normal' used to mean "fall back to the track's mode" —
      //    that is now the explicit 'Inherit' value (an explicit 'Normal' is a
      //    real override), so legacy 'Normal'/unset maps to 'Inherit'.
      // 2. `clip.transition` was a head-only transition tied to the overlap with
      //    the previous clip. It is now `transitionIn`, one of two edge
      //    transitions. Same semantics on load — a clip with an overlap still
      //    crossfades across exactly that overlap — so the only visible change
      //    is that the clip now also has a tail slot it can use.
      clips: (data.timeline.clips || []).map(c => ({
        fadeIn: 0,
        fadeOut: 0,
        transitionOut: null,
        ...c,
        transitionIn: c.transitionIn || c.transition || null,
        transition: null,
        blendMode: (!c.blendMode || c.blendMode === 'Normal') ? 'Inherit' : c.blendMode,
      })),
      markers: data.timeline.markers || [],
      inPoint: data.timeline.inPoint,
      outPoint: data.timeline.outPoint,
      keyframes: data.timeline.keyframes || [],
    })
  }

  // Restore graph
  if (data.graph) {
    useGraphStore.setState({
      masterGraph: {
        nodes: migrateGraphNodes(data.graph.masterGraph?.nodes || []),
        edges: data.graph.masterGraph?.edges || [],
        tapPointNodeId: data.graph.masterGraph?.tapPointNodeId || null,
        compiledChain: [],
        compileErrors: [],
      },
      clipGraphs: Object.fromEntries(
        Object.entries(data.graph.clipGraphs || {}).map(([clipId, g]) => [
          clipId,
          {
            nodes: migrateGraphNodes(g.nodes || []),
            edges: g.edges || [],
            tapPointNodeId: g.tapPointNodeId || null,
            compiledChain: [],
            compileErrors: [],
          }
        ])
      ),
      // Older projects saved before the starter transition existed get it
      // re-seeded so node transitions stay discoverable; a project with its own
      // library keeps exactly what it saved.
      compoundLibrary: (data.graph.compoundLibrary && data.graph.compoundLibrary.length > 0)
        ? data.graph.compoundLibrary.map(c => (
          c.subGraph?.nodes
            ? { ...c, subGraph: { ...c.subGraph, nodes: migrateGraphNodes(c.subGraph.nodes) } }
            : c
        ))
        : [STARTER_TRANSITION_COMPOUND],
      // Bump so the renderer recompiles the freshly-loaded graph.
      topologyVersion: useGraphStore.getState().topologyVersion + 1,
    })
  }

  // Restore UI state
  if (data.ui) {
    useAppStore.setState({
      graphLevel: data.ui.graphLevel || 'master',
      graphClipId: data.ui.graphClipId || null,
      graphCompoundPath: data.ui.graphCompoundPath || [],
      editMode: data.ui.editMode || 'overwrite',
    })
  }

  // Loading a project is not an undoable edit — Ctrl+Z must never restore the
  // previously open project's state into this one.
  clearHistory()

  return true
}



/**
 * Save project to IndexedDB.
 */
export async function saveProject(getAppStore, getGraphStore, getTimelineStore) {
  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)

  // Into the vault: validated before any I/O, written atomically, and with the
  // previous version rotated into `backups/` first. `idbSet` had none of those
  // properties — one bad serialise landed straight on top of the only copy.
  await writeProject(data.project.id, data)

  // The autosave slot stays in IndexedDB and stays the fast path. It is the
  // "reopen what I had" pointer, rewritten every couple of seconds; it is not
  // the durable record, and giving it backups would mint one per keystroke.
  await idbSet(AUTOSAVE_KEY, data)

  console.log('[ProjectSerializer] Saved project:', data.project.name)
  return data
}

/**
 * Autosave to IndexedDB.
 *
 * Deliberately does NOT go through `writeProject`. Autosave fires two seconds
 * after any change, so routing it through validation + backup rotation would
 * spend that budget continuously and fill the backup history with keystrokes.
 * Durability is the explicit save's job; this is a crash-recovery pointer.
 */
export async function autosave(getAppStore, getGraphStore, getTimelineStore) {
  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)
  await idbSet(AUTOSAVE_KEY, data)
  return data
}

/**
 * Load a project by id, migrating it out of IndexedDB into the vault if that is
 * still where it lives.
 */
export async function loadProject(projectId) {
  return await readProjectMigrating(projectId)
}

/**
 * Load autosave.
 */
export async function loadAutosave() {
  return await idbGet(AUTOSAVE_KEY) || null
}

/**
 * List all saved projects — vault and legacy IndexedDB together.
 */
export async function listProjects() {
  return await listStoredProjects()
}

/**
 * Delete a saved project.
 */
export async function deleteProject(projectId) {
  await removeStoredProject(projectId)
}

/**
 * Save the project to a .dalivid.json file the user chooses.
 *
 * Prefers `showSaveFilePicker` (a real Save As dialog) over the anchor download,
 * so the file lands where the user wants it and re-saving can overwrite the same
 * file instead of piling up `project (3).json` in Downloads. Like the recording
 * sink, the picker grants write access to exactly ONE user-named file and nothing
 * is persisted between sessions — it stays inside the zero-standing-authority
 * model that replaced folder linking.
 *
 * The picker needs transient user activation, so this must be called straight
 * from a click handler and it opens the dialog *before* serializing (a project
 * with big image data URLs can spend real time in JSON.stringify).
 *
 * @returns {Promise<'picker'|'download'|'cancelled'>} how, or whether, it saved.
 */
export async function exportProjectAsJSON(getAppStore, getGraphStore, getTimelineStore) {
  const safeName = (getAppStore().projectName || 'project').replace(/[^a-zA-Z0-9_-]/g, '_')

  // 1. Save As dialog (primary). Grab the handle first, while activation is live.
  let fileHandle = null
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: `${safeName}.dalivid.json`,
        startIn: 'documents',
        types: [{
          description: 'DaliViD Project',
          accept: { 'application/json': ['.dalivid.json', '.json'] },
        }],
      })
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'  // user dismissed the dialog
      console.warn('[ProjectSerializer] Save picker unavailable, falling back to download:', err)
    }
  }

  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)

  // A downloaded project file is the copy that leaves this machine, so it is the
  // one that has to carry its fonts. Saves to IndexedDB skip this — the bytes
  // are already there under their own keys, and re-encoding them into base64 on
  // every autosave would be the single most expensive thing the editor does.
  if (data.fonts?.length) data.fonts = await embedCustomFontData(data.fonts)

  const json = JSON.stringify(data, null, 2)

  if (fileHandle) {
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(json)
      await writable.close()
    } catch (err) {
      await writable.abort?.()
      throw err
    }
    return 'picker'
  }

  // 2. Anchor download fallback (Firefox/Safari, or a blocked picker). Timestamped
  // because there's no dialog here to ask about overwriting.
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeName}_${Date.now()}.dalivid.json`
  a.click()
  URL.revokeObjectURL(url)
  return 'download'
}

/**
 * Import project from a JSON file.
 * @returns {Promise<object|null>}
 */
export function importProjectFromJSON() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.dalivid.json'
    input.onchange = (e) => {
      const file = e.target.files[0]
      if (!file) { resolve(null); return }

      const reader = new FileReader()
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result)
          resolve(data)
        } catch (err) {
          console.error('[ProjectSerializer] Invalid JSON:', err)
          resolve(null)
        }
      }
      reader.readAsText(file)
    }
    input.click()
  })
}

/**
 * Prompt for media files to relink after a JSON import.
 *
 * A file input grants a one-shot read of exactly the files the user picked in
 * that gesture. No handle is created, nothing is persisted, and the grant dies
 * with the page — so a tampered bundle gets nothing unless the user actively
 * picks files for it. This is why folder linking could be removed outright.
 */
export function pickMediaFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = 'video/*,audio/*'
    input.addEventListener('change', (e) => resolve([...(e.target.files || [])]), { once: true })
    // Chrome fires 'cancel' on dismissal; without it the promise would hang and
    // the caller's toast would never fire.
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}

/**
 * Relink timeline media from user-picked files, matching by filename.
 *
 * The folder-free restore path: a JSON export keeps the edit (and images, which
 * are inlined as data URLs in node.params.imageSrc) but not video/audio bytes,
 * so on import we ask for the media once and rebuild blob URLs by name.
 * Live sources and generator clips are skipped — they have no on-disk media.
 */
export function relinkMediaFromFiles(files, clips, updateClipAction) {
  const byName = new Map()
  for (const file of files) {
    if (!byName.has(file.name)) byName.set(file.name, file)
  }

  const urlByName = new Map()
  const missing = []
  const unused = new Set(byName.keys())
  let restoredCount = 0

  for (const clip of clips) {
    if (!clip.filename) continue
    // Live sources (camera/screen) are MediaStream-backed and generators
    // (text/image) are self-contained in params — neither has on-disk media,
    // so neither belongs in the "missing" list.
    if (clip.fileType === 'camera' || clip.fileType === 'screen') continue
    if (clip.fileType === 'text' || clip.fileType === 'image') continue

    const file = byName.get(clip.filename)
    if (!file) {
      if (!missing.includes(clip.filename)) missing.push(clip.filename)
      continue
    }
    unused.delete(clip.filename)

    // One blob URL per file, not per clip: splits and reuse mean several clips
    // commonly share a source, and a URL each would leak them.
    let url = urlByName.get(clip.filename)
    if (!url) {
      url = URL.createObjectURL(file)
      urlByName.set(clip.filename, url)
    }
    updateClipAction(clip.id, { fileUrl: url })
    restoredCount++
  }

  console.log(`[ProjectSerializer] Relinked ${restoredCount} clip(s) from ${urlByName.size} file(s).`)
  return { restoredCount, missing, unused: [...unused] }
}

/**
 * Filenames a project's clips expect on disk — used to tell the user what to
 * pick before the relink prompt opens.
 */
export function getExpectedMediaFilenames(clips) {
  const names = []
  for (const clip of (clips || [])) {
    if (!clip.filename) continue
    if (clip.fileType === 'camera' || clip.fileType === 'screen') continue
    if (clip.fileType === 'text' || clip.fileType === 'image') continue
    if (!names.includes(clip.filename)) names.push(clip.filename)
  }
  return names
}

/**
 * Delete any directory handles persisted by the old project-folder feature.
 *
 * Folder linking is gone (see CLAUDE.md). Handles written by earlier versions
 * are still sitting in IndexedDB under `project_folder_<id>`, and a stored
 * handle is a standing readwrite grant over the user's folder that they can no
 * longer see or revoke from inside the app — so we actively clear them on
 * startup rather than leaving them to rot.
 */
export async function purgeStoredFolderHandles() {
  try {
    const allKeys = await idbKeys()
    const stale = allKeys.filter(k => typeof k === 'string' && k.startsWith('project_folder_'))
    for (const key of stale) await idbDel(key)
    if (stale.length > 0) {
      console.log(`[ProjectSerializer] Cleared ${stale.length} stored folder handle(s) from a previous version.`)
    }
  } catch (err) {
    console.warn('[ProjectSerializer] Could not purge stored folder handles:', err)
  }
}

/**
 * Ask the browser not to evict this origin's storage.
 *
 * Autosave now lives only in IndexedDB, which is best-effort by default and can
 * be cleared under storage pressure — so this is the difference between "your
 * project survives" and "your project quietly vanished". Chrome usually grants
 * it silently for engaged sites; a refusal is not an error, it just means the
 * "Save Project File" download is the only durable copy.
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    const granted = await navigator.storage.persist()
    console.log(`[ProjectSerializer] Persistent storage ${granted ? 'granted' : 'not granted'}.`)
    return granted
  } catch (err) {
    console.warn('[ProjectSerializer] Persistent storage request failed:', err)
    return false
  }
}
