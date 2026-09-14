/**
 * DaliVid — storage/schema.js
 * The project document: what shape v2 is, whether a given document is one, and
 * how a v1 becomes one.
 *
 * ── What v2 changes ──
 * Two things, both about media, neither touching the edit itself:
 *   1. `media.refs[]` — the Media Pool, which today lives in React `useState`
 *      and is therefore gone on reload.
 *   2. `clip.mediaRefId` and `params.imageRefId` — a content-addressed handle
 *      replacing, respectively, nothing at all (video/audio bytes were never
 *      persisted) and a megabytes-long base64 data URL inlined into params.
 *
 * `clip.filename` stays populated **forever**. It is what lets a v2 project
 * degrade gracefully in a v1 build (falls back to relink-by-name, loses the
 * refs but not the edit) and what keeps the existing relink path alive as the
 * fallback when a ref cannot be resolved. Do not remove it.
 *
 * ── What this module deliberately does not do ──
 * No I/O. Migration steps that need bytes — decoding an inline image into a
 * blob — are split into a pure "find them" pass and a pure "replace them" pass
 * so the storage layer can do the actual write in between. That keeps the whole
 * of schema validation runnable in a Worker, in `node --test`, and later in the
 * Electron main process, where none of the browser image APIs exist.
 */

import { isMediaRef, hasLocalOnlyFields, isRefId } from './mediaRef.js'
import { getKnownNodeTypes } from './nodeTypes.js'

export const SCHEMA_VERSION = 2

/** Top-level keys a document may carry. Anything else is rejected — see `validateProject`. */
export const TOP_LEVEL_KEYS = [
  'version', 'savedAt', 'project', 'media', 'timeline', 'graph', 'fonts', 'ui',
]

/**
 * Size ceilings.
 *
 * A single global string cap does not work here, because the document contains
 * strings of three wildly different legitimate sizes: names and ids (short),
 * customised shader source (tens of KB), and — in v1 only — inlined image data
 * URLs (megabytes). One cap large enough for the third would not constrain the
 * first two at all, which is the whole point of having a cap.
 */
export const LIMITS = {
  /** Names, ids, filenames, colours, descriptions — anything not exempted below. */
  string: 64 * 1024,
  /** `shaderCode` / `customShaderSource`. A hand-written shader is big; it is not this big. */
  shaderSource: 1024 * 1024,
  /** v1 inline images (`params.imageSrc`). v2 documents should contain none at all. */
  dataUrl: 32 * 1024 * 1024,
  /** Whole serialised document. Matches the IPC cap in the plan (§5.3 rule 5). */
  document: 256 * 1024 * 1024,
  /** Sanity ceilings — a document past these is corrupt or hostile, not large. */
  nodes: 20000,
  clips: 20000,
  refs: 10000,
}

/** Keys whose string values are measured against `LIMITS.shaderSource`. */
const SHADER_SOURCE_KEYS = new Set(['shaderCode', 'customShaderSource'])
/** Keys whose string values are measured against `LIMITS.dataUrl`. */
const DATA_URL_KEYS = new Set(['imageSrc', 'data'])

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structurally validate a project document.
 *
 * **Errors vs warnings, and why both.** A validator with only one severity has
 * to choose between rejecting projects it should have opened and accepting ones
 * it should have refused. So:
 *   - `errors` — the document is malformed, unsafe, or would not load. Reject.
 *   - `warnings` — the document loads, but something in it is inconsistent (a
 *     clip on a track that isn't there, a ref nothing points at). Report, open.
 *
 * **`untrusted`.** An unknown node `type` is a warning when reading our own
 * vault — a project written by a *newer* build must not become unopenable by an
 * older one — and an error on the import path, where the document arrived from
 * outside and an unrecognised type is exactly what should not reach the
 * compiler. One flag, set by the caller who knows where the bytes came from.
 *
 * @param {object} doc
 * @param {object} [opts]
 * @param {boolean} [opts.untrusted] — document came from outside the vault
 * @param {Set<string>} [opts.knownNodeTypes] — override the registry (tests)
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateProject(doc, { untrusted = false, knownNodeTypes } = {}) {
  const errors = []
  const warnings = []
  const err = (m) => { if (errors.length < 100) errors.push(m) }
  const warn = (m) => { if (warnings.length < 100) warnings.push(m) }

  if (!isPlainObject(doc)) {
    return { ok: false, errors: ['document is not an object'], warnings }
  }

  // ── Top level ──────────────────────────────────────────────────────────────
  // Strict here and only here. Rejecting unknown keys *nested* inside would
  // turn every future field the app adds into a document older builds refuse to
  // open — the exact forward-compatibility trap `filename` exists to avoid.
  for (const k of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.includes(k)) err(`unknown top-level key: ${k}`)
  }

  const version = doc.version
  if (version !== 1 && version !== 2) err(`unsupported version: ${JSON.stringify(version)}`)
  if (doc.savedAt !== undefined && typeof doc.savedAt !== 'string') err('savedAt must be a string')

  // ── project ────────────────────────────────────────────────────────────────
  const p = doc.project
  if (!isPlainObject(p)) {
    err('project section missing')
  } else {
    if (!isNonEmptyString(p.id)) err('project.id missing')
    if (!isNonEmptyString(p.name)) err('project.name missing')
    if (!isPositive(p.fps)) err('project.fps must be a positive number')
    if (!isPlainObject(p.resolution) || !isPositive(p.resolution.width) || !isPositive(p.resolution.height)) {
      err('project.resolution must be {width, height} of positive numbers')
    }
  }

  // ── media (v2) ─────────────────────────────────────────────────────────────
  const refIds = new Set()
  if (doc.media !== undefined) {
    if (!isPlainObject(doc.media) || !Array.isArray(doc.media.refs)) {
      err('media must be { refs: [] }')
    } else if (doc.media.refs.length > LIMITS.refs) {
      err(`media.refs too long: ${doc.media.refs.length}`)
    } else {
      doc.media.refs.forEach((ref, i) => {
        if (!isMediaRef(ref)) { err(`media.refs[${i}] is not a valid MediaRef`); return }
        // A path in a document is a leak, not a convenience: project files get
        // emailed, and a path is local machine state. `stripRefPath` is the gate
        // and this is the assertion that it was actually used.
        if (hasLocalOnlyFields(ref)) err(`media.refs[${i}] (${ref.id}) carries a local-only field (path/mtimeMs/sig)`)
        if (refIds.has(ref.id)) err(`media.refs duplicate id: ${ref.id}`)
        refIds.add(ref.id)
      })
    }
  } else if (version === 2) {
    err('v2 document missing media section')
  }

  // ── timeline ───────────────────────────────────────────────────────────────
  const t = doc.timeline
  const trackIds = new Set()
  if (!isPlainObject(t)) {
    err('timeline section missing')
  } else {
    if (!Array.isArray(t.tracks)) err('timeline.tracks must be an array')
    else {
      t.tracks.forEach((tr, i) => {
        if (!isPlainObject(tr)) { err(`timeline.tracks[${i}] is not an object`); return }
        if (!isNonEmptyString(tr.id)) err(`timeline.tracks[${i}].id missing`)
        else trackIds.add(tr.id)
      })
    }

    if (!Array.isArray(t.clips)) err('timeline.clips must be an array')
    else if (t.clips.length > LIMITS.clips) err(`timeline.clips too long: ${t.clips.length}`)
    else {
      t.clips.forEach((c, i) => {
        if (!isPlainObject(c)) { err(`timeline.clips[${i}] is not an object`); return }
        const at = `timeline.clips[${i}]${isNonEmptyString(c.id) ? ` (${c.id})` : ''}`
        if (!isNonEmptyString(c.id)) err(`${at}.id missing`)
        if (!isFinite_(c.timelineStart) || !isFinite_(c.timelineEnd)) err(`${at} has non-finite timeline bounds`)
        else if (c.timelineEnd < c.timelineStart) err(`${at} ends before it starts`)
        // Dangling, not fatal: the clip simply renders nowhere, and telling the
        // user beats refusing to open the project it is in.
        if (isNonEmptyString(c.trackId) && trackIds.size && !trackIds.has(c.trackId)) {
          warn(`${at} references missing track ${c.trackId}`)
        }
        checkRefField(c.mediaRefId, `${at}.mediaRefId`, refIds, err, warn)
        if (isPlainObject(c.params)) {
          checkRefField(c.params.imageRefId, `${at}.params.imageRefId`, refIds, err, warn)
        }
      })
    }

    for (const k of ['markers', 'keyframes']) {
      if (t[k] !== undefined && !Array.isArray(t[k])) err(`timeline.${k} must be an array`)
    }
  }

  // ── graph ──────────────────────────────────────────────────────────────────
  const known = knownNodeTypes || safeKnownNodeTypes(warn)
  let nodeCount = 0
  const g = doc.graph
  if (!isPlainObject(g)) {
    err('graph section missing')
  } else {
    const visitGraph = (graph, at) => {
      if (!isPlainObject(graph)) { err(`${at} is not a graph`); return }
      if (!Array.isArray(graph.nodes)) { err(`${at}.nodes must be an array`); return }
      if (!Array.isArray(graph.edges)) err(`${at}.edges must be an array`)

      const ids = new Set()
      graph.nodes.forEach((n, i) => {
        if (++nodeCount > LIMITS.nodes) return
        if (!isPlainObject(n)) { err(`${at}.nodes[${i}] is not an object`); return }
        const nAt = `${at}.nodes[${i}]${isNonEmptyString(n.id) ? ` (${n.id})` : ''}`
        if (!isNonEmptyString(n.id)) err(`${nAt}.id missing`)
        else if (ids.has(n.id)) err(`${nAt}.id is duplicated`)
        else ids.add(n.id)

        if (!isNonEmptyString(n.type)) err(`${nAt}.type missing`)
        else if (known && !known.has(n.type)) {
          const msg = `${nAt} has unknown node type: ${n.type}`
          if (untrusted) err(msg); else warn(msg)
        }

        if (n.position !== undefined
            && (!isPlainObject(n.position) || !isFinite_(n.position.x) || !isFinite_(n.position.y))) {
          err(`${nAt}.position must be {x, y}`)
        }
        if (n.params !== undefined && !isPlainObject(n.params)) err(`${nAt}.params must be an object`)
        if (isPlainObject(n.params)) {
          checkRefField(n.params.imageRefId, `${nAt}.params.imageRefId`, refIds, err, warn)
        }
        if (n.subGraph !== undefined) visitGraph(n.subGraph, `${nAt}.subGraph`)
      })

      if (Array.isArray(graph.edges)) {
        graph.edges.forEach((e, i) => {
          if (!isPlainObject(e)) { err(`${at}.edges[${i}] is not an object`); return }
          for (const f of ['fromNode', 'toNode', 'fromSocket', 'toSocket']) {
            if (!isNonEmptyString(e[f])) err(`${at}.edges[${i}].${f} missing`)
          }
        })
      }
    }

    visitGraph(g.masterGraph, 'graph.masterGraph')

    if (g.clipGraphs !== undefined) {
      if (!isPlainObject(g.clipGraphs)) err('graph.clipGraphs must be an object')
      else for (const [key, sub] of Object.entries(g.clipGraphs)) visitGraph(sub, `graph.clipGraphs[${key}]`)
    }

    if (g.compoundLibrary !== undefined) {
      if (!Array.isArray(g.compoundLibrary)) err('graph.compoundLibrary must be an array')
      else g.compoundLibrary.forEach((c, i) => {
        if (!isPlainObject(c)) { err(`graph.compoundLibrary[${i}] is not an object`); return }
        if (!isNonEmptyString(c.id)) err(`graph.compoundLibrary[${i}].id missing`)
        if (c.subGraph !== undefined) visitGraph(c.subGraph, `graph.compoundLibrary[${i}].subGraph`)
      })
    }
  }
  if (nodeCount > LIMITS.nodes) err(`too many nodes: ${nodeCount} > ${LIMITS.nodes}`)

  // ── fonts / ui ─────────────────────────────────────────────────────────────
  if (doc.fonts !== undefined && !Array.isArray(doc.fonts)) err('fonts must be an array')
  if (doc.ui !== undefined && !isPlainObject(doc.ui)) err('ui must be an object')

  // ── Size ceilings ──────────────────────────────────────────────────────────
  // One walk, at the end, so a document that already failed structurally still
  // reports its structural faults rather than only "a string was too long".
  checkStringLimits(doc, err)

  return { ok: errors.length === 0, errors, warnings }
}

/** A ref-id-shaped field: must be absent/null, or a valid id, ideally a known one. */
function checkRefField(value, at, refIds, err, warn) {
  if (value === undefined || value === null) return
  if (!isRefId(value)) { err(`${at} is not a valid MediaRef id: ${JSON.stringify(value)}`); return }
  // Dangling refs are recoverable — the media is offline and the repair flow
  // handles it. Refusing to open the project would be the worse outcome.
  if (refIds.size && !refIds.has(value)) warn(`${at} points at a ref not in media.refs: ${value}`)
}

/**
 * Walk the document once, measuring strings against the cap that applies to
 * their key, and the whole thing against `LIMITS.document`.
 */
function checkStringLimits(doc, err) {
  let total = 0
  let reported = 0
  const seen = new Set()

  const walk = (value, key, path) => {
    if (reported > 20 || total > LIMITS.document) return
    if (typeof value === 'string') {
      total += value.length
      const cap = SHADER_SOURCE_KEYS.has(key) ? LIMITS.shaderSource
        : DATA_URL_KEYS.has(key) ? LIMITS.dataUrl
          : LIMITS.string
      if (value.length > cap) {
        reported++
        err(`${path} is ${value.length} chars, over the ${cap} limit for this field`)
      }
      return
    }
    if (!value || typeof value !== 'object') return
    // Cyclic structures cannot be JSON, so anything revisited here is already a
    // fault; bail rather than loop forever on it.
    if (seen.has(value)) { reported++; err(`${path} is a circular reference`); return }
    seen.add(value)
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], key, `${path}[${i}]`)
    } else {
      for (const k of Object.keys(value)) walk(value[k], k, `${path}.${k}`)
    }
    seen.delete(value)
  }

  walk(doc, '', 'document')
  if (total > LIMITS.document) err(`document is too large: ${total} chars > ${LIMITS.document}`)
}

/**
 * The registry-backed type set, but never fatal.
 *
 * A validator that throws because the shader registry could not be imported
 * (a Worker, the main process, a test) would take the project down with it.
 * Skipping the type check there is strictly better than that.
 */
function safeKnownNodeTypes(warn) {
  try {
    return getKnownNodeTypes()
  } catch {
    warn('node types could not be checked: the shader registry is unavailable here')
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v1 → v2. Pure, idempotent, and deliberately conservative.
 *
 * It adds the v2 *shape* and nothing else: an empty `media.refs`, and
 * `mediaRefId: null` on every clip. The project then opens exactly as it does
 * today and shows the existing relink prompt. The user relinks once, those
 * files are ingested as MediaRefs, and that is the last relink the project ever
 * needs.
 *
 * Inline images are NOT converted here — that needs bytes written to storage,
 * which this module must not do. `collectInlineImages` / `replaceInlineImages`
 * are the two pure halves; the storage layer supplies the middle.
 *
 * @param {object} doc
 * @returns {object} a v2 document — the same object when already v2
 */
export function migrateV1toV2(doc) {
  if (!isPlainObject(doc)) throw new TypeError('migrateV1toV2: not a document')
  if (doc.version === SCHEMA_VERSION && isPlainObject(doc.media)) return doc

  const out = { ...doc, version: SCHEMA_VERSION }

  out.media = isPlainObject(doc.media) && Array.isArray(doc.media.refs)
    ? { ...doc.media, refs: [...doc.media.refs] }
    : { refs: [] }

  if (isPlainObject(doc.timeline) && Array.isArray(doc.timeline.clips)) {
    out.timeline = {
      ...doc.timeline,
      clips: doc.timeline.clips.map(c => (
        // `null` rather than absent: an explicit "this clip has no ref yet" is
        // distinguishable from a field a future bug forgot to write.
        isPlainObject(c) && c.mediaRefId === undefined ? { ...c, mediaRefId: null } : c
      )),
    }
  }

  return out
}

/**
 * Every inline image data URL in the document, with the location that holds it.
 *
 * Images live in two places and both matter: a generator clip's
 * `params.imageSrc`, and an `IMAGE_INPUT` node's — at any graph depth, including
 * inside compound interiors and the compound library. Missing the nested ones
 * would leave the largest strings in the document exactly where they are.
 *
 * @param {object} doc
 * @returns {Array<{ dataUrl: string, at: string }>} deduplicated by URL
 */
export function collectInlineImages(doc) {
  const out = []
  const seen = new Set()
  const add = (dataUrl, at) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return
    if (seen.has(dataUrl)) return
    seen.add(dataUrl)
    out.push({ dataUrl, at })
  }

  if (isPlainObject(doc?.timeline) && Array.isArray(doc.timeline.clips)) {
    doc.timeline.clips.forEach((c, i) => add(c?.params?.imageSrc, `timeline.clips[${i}]`))
  }
  forEachNode(doc?.graph, (node, at) => add(node?.params?.imageSrc, at))
  return out
}

/**
 * Replace every inline image data URL with the ref id it was stored under.
 * Pure counterpart to `collectInlineImages`; the caller does the storing.
 *
 * @param {object} doc
 * @param {Map<string, string>|object} byDataUrl — data URL → MediaRef id
 * @returns {object} a new document, or the same one when nothing matched
 */
export function replaceInlineImages(doc, byDataUrl) {
  const lookup = byDataUrl instanceof Map
    ? (u) => byDataUrl.get(u)
    : (u) => byDataUrl?.[u]

  let changed = false

  const swapParams = (params) => {
    const src = params?.imageSrc
    if (typeof src !== 'string' || !src.startsWith('data:')) return params
    const refId = lookup(src)
    if (!refId) return params
    changed = true
    const next = { ...params, imageRefId: refId }
    delete next.imageSrc
    return next
  }

  const out = { ...doc }

  if (isPlainObject(doc?.timeline) && Array.isArray(doc.timeline.clips)) {
    const clips = doc.timeline.clips.map(c => {
      if (!isPlainObject(c?.params)) return c
      const params = swapParams(c.params)
      return params === c.params ? c : { ...c, params }
    })
    out.timeline = { ...doc.timeline, clips }
  }

  out.graph = mapNodes(doc?.graph, (node) => {
    if (!isPlainObject(node?.params)) return node
    const params = swapParams(node.params)
    return params === node.params ? node : { ...node, params }
  })

  return changed ? out : doc
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph traversal — one definition of "every node, everywhere"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Visit every node in the whole graph section: master, every clip graph, every
 * compound library entry, and every `subGraph` beneath any of them.
 *
 * Kept in one place because the recursion is where this class of pass goes
 * wrong — `migrateGraphNodes` in projectSerializer had to learn the same shape,
 * and a migration that silently skips compound interiors looks like it worked.
 */
export function forEachNode(graphSection, fn) {
  if (!isPlainObject(graphSection)) return
  const visit = (graph, at) => {
    if (!isPlainObject(graph) || !Array.isArray(graph.nodes)) return
    graph.nodes.forEach((n, i) => {
      const nodeAt = `${at}.nodes[${i}]`
      fn(n, nodeAt)
      if (n?.subGraph) visit(n.subGraph, `${nodeAt}.subGraph`)
    })
  }
  visit(graphSection.masterGraph, 'graph.masterGraph')
  if (isPlainObject(graphSection.clipGraphs)) {
    for (const [k, sub] of Object.entries(graphSection.clipGraphs)) visit(sub, `graph.clipGraphs[${k}]`)
  }
  if (Array.isArray(graphSection.compoundLibrary)) {
    graphSection.compoundLibrary.forEach((c, i) => visit(c?.subGraph, `graph.compoundLibrary[${i}].subGraph`))
  }
}

/**
 * `forEachNode`'s mapping twin: rebuild the graph section with `fn` applied to
 * every node at every depth. Returns the same object when nothing changed, so
 * an unaffected document keeps referential identity (which the Zustand snapshot
 * undo depends on).
 */
export function mapNodes(graphSection, fn) {
  if (!isPlainObject(graphSection)) return graphSection
  let changed = false

  const visitGraph = (graph) => {
    if (!isPlainObject(graph) || !Array.isArray(graph.nodes)) return graph
    let graphChanged = false
    const nodes = graph.nodes.map(n => {
      let node = fn(n)
      if (node !== n) graphChanged = true
      if (node?.subGraph) {
        const sub = visitGraph(node.subGraph)
        if (sub !== node.subGraph) { node = { ...node, subGraph: sub }; graphChanged = true }
      }
      return node
    })
    if (!graphChanged) return graph
    changed = true
    return { ...graph, nodes }
  }

  const out = { ...graphSection }
  out.masterGraph = visitGraph(graphSection.masterGraph)

  if (isPlainObject(graphSection.clipGraphs)) {
    const clipGraphs = {}
    for (const [k, sub] of Object.entries(graphSection.clipGraphs)) clipGraphs[k] = visitGraph(sub)
    out.clipGraphs = clipGraphs
  }
  if (Array.isArray(graphSection.compoundLibrary)) {
    out.compoundLibrary = graphSection.compoundLibrary.map(c => {
      if (!c?.subGraph) return c
      const sub = visitGraph(c.subGraph)
      return sub === c.subGraph ? c : { ...c, subGraph: sub }
    })
  }

  return changed ? out : graphSection
}

// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }
function isFinite_(v) { return typeof v === 'number' && Number.isFinite(v) }
function isPositive(v) { return isFinite_(v) && v > 0 }
