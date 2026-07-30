/**
 * DaliVid — projectSerializer.js
 * Save/Load project state to/from IndexedDB via idb-keyval.
 * Also provides JSON export/import for file-based save.
 */

import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval'
import useAppStore from '../store/useAppStore.js'
import useGraphStore from '../store/useGraphStore.js'
import useTimelineStore from '../store/useTimelineStore.js'
import { STARTER_TRANSITION_COMPOUND } from '../shaders/compoundPresets.js'
import { clearHistory } from './history.js'

const PROJECT_PREFIX = 'dalivid_project_'
const AUTOSAVE_KEY = 'dalivid_autosave'

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

  return {
    version: 1,
    savedAt: new Date().toISOString(),

    project: {
      name: app.projectName,
      id: app.projectId,
      fps: app.fps,
      resolution: { ...app.resolution },
      colorSpace: app.colorSpace,
      bpm: app.bpm,
      beatOffset: app.beatOffset,
      beatGridEnabled: app.beatGridEnabled,
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
        fileType: c.fileType,
        timelineStart: c.timelineStart,
        timelineEnd: c.timelineEnd,
        sourceStart: c.sourceStart,
        sourceEnd: c.sourceEnd,
        speed: c.speed,
        opacity: c.opacity,
        volume: c.volume == null ? 1 : c.volume,
        audioMuted: !!c.audioMuted,
        blendMode: c.blendMode,
        fadeIn: c.fadeIn || 0,
        fadeOut: c.fadeOut || 0,
        transition: c.transition
          ? { type: c.transition.type, params: { ...(c.transition.params || {}) } }
          : null,
        transform: { ...c.transform },
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
          audioBindings: { ...n.audioBindings },
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
              audioBindings: n.audioBindings ? { ...n.audioBindings } : {},
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

    ui: {
      graphLevel: app.graphLevel,
      graphClipId: app.graphClipId,
      graphCompoundPath: [...app.graphCompoundPath],
      editMode: app.editMode,
    },
  }
}

/**
 * Deserialize a project into store actions.
 * @param {object} data — serialized project
 * @param {Function} getAppStore
 * @param {Function} getGraphStore
 * @param {Function} getTimelineStore
 */
export function deserializeProject(data, getAppStore) {
  if (!data || data.version !== 1) {
    console.error('[ProjectSerializer] Unsupported project version:', data?.version)
    return false
  }

  const app = getAppStore()

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
      tracks: data.timeline.tracks || [],
      // Migration: clip blendMode 'Normal' used to mean "fall back to the track's
      // mode" — that behaviour is now the explicit 'Inherit' value (an explicit
      // 'Normal' is a real override). Mapping legacy 'Normal'/unset to 'Inherit'
      // keeps old projects rendering identically.
      clips: (data.timeline.clips || []).map(c => ({
        fadeIn: 0,
        fadeOut: 0,
        ...c,
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
        nodes: data.graph.masterGraph?.nodes || [],
        edges: data.graph.masterGraph?.edges || [],
        tapPointNodeId: data.graph.masterGraph?.tapPointNodeId || null,
        compiledChain: [],
        compileErrors: [],
      },
      clipGraphs: Object.fromEntries(
        Object.entries(data.graph.clipGraphs || {}).map(([clipId, g]) => [
          clipId,
          {
            nodes: g.nodes || [],
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
        ? data.graph.compoundLibrary
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
  const key = `${PROJECT_PREFIX}${data.project.id}`
  await idbSet(key, data)
  console.log('[ProjectSerializer] Saved project:', data.project.name)
  return data
}

/**
 * Autosave to IndexedDB.
 */
export async function autosave(getAppStore, getGraphStore, getTimelineStore) {
  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)
  await idbSet(AUTOSAVE_KEY, data)
  return data
}

/**
 * Load project from IndexedDB by ID.
 */
export async function loadProject(projectId) {
  const key = `${PROJECT_PREFIX}${projectId}`
  const data = await idbGet(key)
  return data || null
}

/**
 * Load autosave.
 */
export async function loadAutosave() {
  return await idbGet(AUTOSAVE_KEY) || null
}

/**
 * List all saved projects.
 */
export async function listProjects() {
  const allKeys = await idbKeys()
  const projectKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(PROJECT_PREFIX))
  const projects = []
  for (const key of projectKeys) {
    const data = await idbGet(key)
    if (data) {
      projects.push({
        id: data.project.id,
        name: data.project.name,
        savedAt: data.savedAt,
      })
    }
  }
  return projects.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}

/**
 * Delete a saved project.
 */
export async function deleteProject(projectId) {
  const key = `${PROJECT_PREFIX}${projectId}`
  await idbDel(key)
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
