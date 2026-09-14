/**
 * DaliVid — projectMedia.js
 * Reconnecting a loaded project to its bytes.
 *
 * `deserializeProject` restores the *edit* synchronously, so a project opens at
 * once. This module does the part that needs storage, afterwards and without
 * blocking: resolve every MediaRef to a playable URL, hand those URLs to the
 * clips and image nodes that reference them, and — for a v1 project — move any
 * inlined base64 images out of the document and into the blob store.
 *
 * ── The two field pairs, and which is which ──
 * Both media kinds now have a *persistent* identity and a *runtime* resolution,
 * and only the first is ever written to a document:
 *
 *   video / audio   persistent `clip.mediaRefId`     runtime `clip.fileUrl`
 *   images          persistent `params.imageRefId`   runtime `params.imageSrc`
 *
 * `clip.fileUrl` already worked this way (the serializer has never saved it), so
 * images simply join a pattern the codebase already had. Keeping the runtime
 * field on the *same* key every consumer already reads is what makes this change
 * small: the renderer, the waveform cache, `ensureNodeImage` and the timeline
 * thumbnails are all untouched — they still receive a URL string and neither
 * know nor care that it now comes from OPFS.
 */

import useMediaStore from '../store/useMediaStore.js'
import useTimelineStore from '../store/useTimelineStore.js'
import useGraphStore from '../store/useGraphStore.js'
import { mapNodes, forEachNode } from '../storage/schema.js'
import { kindFor, MEDIA_REF_PREFIX } from '../storage/mediaRef.js'
import { collectAllRefIds } from '../storage/projectStore.js'
import { vault } from '../storage/index.js'

/**
 * Reconnect a freshly-deserialised project to its media.
 *
 * @param {object} data — the (already v2-migrated) project document
 * @returns {Promise<{resolved: number, missing: number, imagesMigrated: number}>}
 */
export async function restoreProjectMedia(data) {
  const media = useMediaStore.getState()

  // 1. Rebuild the runtime half of the pool from the document's refs.
  const { ok: resolved, missing } = await media.hydrate(data?.media?.refs || [])

  // 2. Hand the resolved URLs to everything that points at a ref.
  applyResolvedURLs()

  // 3. v1 only: lift inlined base64 images into the blob store. Runs last
  //    because it is the slow part and the project is already usable without it.
  const imagesMigrated = await migrateInlineImages()

  if (imagesMigrated > 0) applyResolvedURLs()

  return { resolved, missing, imagesMigrated }
}

/**
 * Push every resolved object URL into the runtime fields.
 *
 * Idempotent, and written to touch state only when something actually changes —
 * these are Zustand `setState` calls on the timeline and graph, so returning the
 * same object where nothing moved keeps React from re-rendering the whole editor
 * and keeps the undo snapshots referentially stable.
 */
export function applyResolvedURLs() {
  const { urlFor } = useMediaStore.getState()

  // ── Clips: video/audio bytes, and image generator clips ──
  const timeline = useTimelineStore.getState()
  let clipsChanged = false
  const clips = timeline.clips.map(c => {
    let next = c

    if (c.mediaRefId) {
      const url = urlFor(c.mediaRefId)
      if (url && c.fileUrl !== url) next = { ...next, fileUrl: url }
    }
    if (c.params?.imageRefId) {
      const url = urlFor(c.params.imageRefId)
      if (url && c.params.imageSrc !== url) {
        next = { ...next, params: { ...next.params, imageSrc: url } }
      }
    }

    if (next !== c) clipsChanged = true
    return next
  })
  if (clipsChanged) useTimelineStore.setState({ clips })

  // ── Nodes: IMAGE_INPUT at every depth, including compound interiors ──
  const graph = useGraphStore.getState()
  const section = {
    masterGraph: graph.masterGraph,
    clipGraphs: graph.clipGraphs,
    compoundLibrary: graph.compoundLibrary,
  }
  const mapped = mapNodes(section, (n) => {
    const refId = n?.params?.imageRefId
    if (!refId) return n
    const url = urlFor(refId)
    if (!url || n.params.imageSrc === url) return n
    return { ...n, params: { ...n.params, imageSrc: url } }
  })

  if (mapped !== section) {
    useGraphStore.setState({
      masterGraph: mapped.masterGraph,
      clipGraphs: mapped.clipGraphs,
      compoundLibrary: mapped.compoundLibrary,
      // Params changed, not topology — but IMAGE_INPUT's source is read from
      // params at execution time, so no recompile is needed for the picture to
      // update on the next frame.
    })
  }
}

/**
 * Move every inlined base64 image into the blob store.
 *
 * This is the change that shrinks the document. Measured on the projects on this
 * machine: `Streetlamp_vid_2108` is 389 KB of base64 inside a 401 KB document —
 * 97% — and autosave re-`JSON.stringify`s and rewrites all of it on a 2-second
 * debounce, on every keystroke in a text field.
 *
 * **Safe to interrupt.** `imageSrc` is only replaced once the bytes are
 * committed to the vault, and the serializer only drops `imageSrc` when an
 * `imageRefId` exists beside it — so a migration that dies halfway leaves a
 * project that is part-migrated and entirely intact, and finishes next time.
 *
 * @returns {Promise<number>} how many distinct images were moved
 */
export async function migrateInlineImages() {
  const media = useMediaStore.getState()

  // Gather distinct data URLs across clips and every node at every depth.
  // Distinct, not per-use: the same image used by a clip and a node is one blob.
  const pending = new Map()   // dataUrl → filename

  for (const c of useTimelineStore.getState().clips) {
    const src = c.params?.imageSrc
    if (isDataURL(src) && !pending.has(src)) {
      pending.set(src, c.params?.imageName || c.filename || 'image')
    }
  }

  const graph = useGraphStore.getState()
  forEachNode(
    { masterGraph: graph.masterGraph, clipGraphs: graph.clipGraphs, compoundLibrary: graph.compoundLibrary },
    (n) => {
      const src = n?.params?.imageSrc
      if (isDataURL(src) && !pending.has(src)) {
        pending.set(src, n.params?.imageName || n.name || 'image')
      }
    },
  )

  if (pending.size === 0) return 0

  const byDataUrl = new Map()   // dataUrl → refId
  for (const [dataUrl, filename] of pending) {
    try {
      // `fetch` on a data: URL is the shortest correct decoder — it handles the
      // base64 and the mime type without a hand-rolled atob/Uint8Array dance.
      const blob = await fetch(dataUrl).then(r => r.blob())
      const ref = await media.ingestBytes(blob, {
        filename,
        kind: 'image',
        mime: blob.type || guessMimeFromDataURL(dataUrl),
      })
      byDataUrl.set(dataUrl, ref.id)
    } catch (e) {
      // One unreadable image must not abort the rest. It keeps its data URL and
      // keeps working exactly as before — this migration is an optimisation, so
      // failing it is never allowed to cost the user the picture.
      console.warn('[projectMedia] could not migrate an inline image:', e)
    }
  }

  if (byDataUrl.size === 0) return 0

  // Stamp the ref id beside the data URL. `imageSrc` is left in place here and
  // removed by the serializer on the next save, so nothing is ever without a
  // source at any instant.
  const timeline = useTimelineStore.getState()
  let clipsChanged = false
  const clips = timeline.clips.map(c => {
    const refId = byDataUrl.get(c.params?.imageSrc)
    if (!refId || c.params.imageRefId === refId) return c
    clipsChanged = true
    return { ...c, params: { ...c.params, imageRefId: refId } }
  })
  if (clipsChanged) useTimelineStore.setState({ clips })

  const g = useGraphStore.getState()
  const section = { masterGraph: g.masterGraph, clipGraphs: g.clipGraphs, compoundLibrary: g.compoundLibrary }
  const mapped = mapNodes(section, (n) => {
    const refId = byDataUrl.get(n?.params?.imageSrc)
    if (!refId || n.params.imageRefId === refId) return n
    return { ...n, params: { ...n.params, imageRefId: refId } }
  })
  if (mapped !== section) {
    useGraphStore.setState({
      masterGraph: mapped.masterGraph,
      clipGraphs: mapped.clipGraphs,
      compoundLibrary: mapped.compoundLibrary,
    })
  }

  return byDataUrl.size
}

/**
 * Every blob hash the open project still needs.
 *
 * Built from the pool plus a defensive sweep of what clips and nodes actually
 * reference, because the GC deletes anything not in this set and the cost of
 * being wrong is asymmetric: a hash missed here destroys media, while a stale
 * hash kept merely wastes space until the next sweep.
 *
 * @returns {Set<string>}
 */
export function collectReachableHashes() {
  const media = useMediaStore.getState()
  const hashes = new Set(media.refs.map(r => r.hash))

  const byId = new Map(media.refs.map(r => [r.id, r.hash]))
  const add = (refId) => {
    const h = byId.get(refId)
    if (h) hashes.add(h)
  }

  for (const c of useTimelineStore.getState().clips) {
    if (c.mediaRefId) add(c.mediaRefId)
    if (c.params?.imageRefId) add(c.params.imageRefId)
  }

  const g = useGraphStore.getState()
  forEachNode(
    { masterGraph: g.masterGraph, clipGraphs: g.clipGraphs, compoundLibrary: g.compoundLibrary },
    (n) => { if (n?.params?.imageRefId) add(n.params.imageRefId) },
  )

  return hashes
}

/**
 * Every blob hash that ANY project in this browser still needs.
 *
 * The open project's set comes from memory (authoritative — it includes media
 * imported but not yet saved); every other project's comes from its stored
 * document.
 *
 * **This is the set the GC must use.** `collectReachableHashes` alone describes
 * the open project only, so collecting against it deletes the media of every
 * other saved project — which is a real failure path the moment the app can
 * switch projects without reloading.
 *
 * @returns {Promise<Set<string>|null>} null if the scan failed, meaning it is
 *   not safe to collect at all.
 */
/**
 * The names of the files the OPEN project still needs, inside its `media/`.
 *
 * A project folder holds one project, so this is the whole reachable set — no
 * scan of other projects, and no way for a sweep here to reach another one.
 * That is the simplification per-project folders buy.
 */
export function collectReachableFiles() {
  const media = useMediaStore.getState()
  const files = new Set()
  const byId = new Map()
  for (const r of media.refs) {
    if (r.file) { files.add(r.file); byId.set(r.id, r.file) }
  }

  // Same defensive sweep as the hash version: a name missed here is a deleted
  // file, a stale one is a few wasted bytes until the next sweep.
  const add = (refId) => { const f = byId.get(refId); if (f) files.add(f) }
  for (const c of useTimelineStore.getState().clips) {
    if (c.mediaRefId) add(c.mediaRefId)
    if (c.params?.imageRefId) add(c.params.imageRefId)
  }
  const g = useGraphStore.getState()
  forEachNode(
    { masterGraph: g.masterGraph, clipGraphs: g.clipGraphs, compoundLibrary: g.compoundLibrary },
    (n) => { if (n?.params?.imageRefId) add(n.params.imageRefId) },
  )
  return files
}

export async function collectAllReachableHashes() {
  const hashes = collectReachableHashes()
  try {
    for (const id of await collectAllRefIds()) {
      const hash = id.slice(MEDIA_REF_PREFIX.length)
      if (hash) hashes.add(hash)
    }
  } catch (err) {
    // A partial answer is worse than no answer: it would read as "these blobs
    // are unreachable" and delete them.
    console.warn('[projectMedia] Could not scan saved projects — skipping GC:', err)
    return null
  }
  return hashes
}

/**
 * Delete blobs that no project references any more.
 *
 * **Never call this during an export.** An export holds object URLs resolved
 * earlier; removing the file underneath one surfaces as a corrupt output file
 * half an hour in, which is about the worst failure this app can produce.
 */
export async function collectGarbage() {
  // In a project folder the sweep is local and exact: this folder's `media/`
  // against this project's refs.
  if (vault.isExternalRoot?.()) return vault.gcBlobs(collectReachableFiles())

  const reachable = await collectAllReachableHashes()
  if (!reachable) return { deleted: 0, freed: 0, kept: 0, pinned: 0, skipped: true }
  return vault.gcBlobs(reachable)
}

/**
 * Attach a freshly-ingested ref to every clip that was waiting for that
 * filename — the relink path, and what makes a v1 project's one relink its last.
 *
 * @param {object} ref
 * @returns {number} clips relinked
 */
export function relinkClipsToRef(ref) {
  const url = useMediaStore.getState().urlFor(ref.id)
  const timeline = useTimelineStore.getState()
  let changed = 0

  const clips = timeline.clips.map(c => {
    if (c.mediaRefId === ref.id && c.fileUrl === url) return c
    // Match on filename AND kind: an audio clip and a video clip can legitimately
    // share a name, and relinking one to the other's bytes would be silent
    // corruption of the edit rather than a visible failure.
    const sameKind = c.fileType === ref.kind
    if (!sameKind || c.filename !== ref.filename) return c
    changed++
    return { ...c, mediaRefId: ref.id, fileUrl: url || c.fileUrl }
  })

  if (changed) useTimelineStore.setState({ clips })
  return changed
}

function isDataURL(v) {
  return typeof v === 'string' && v.startsWith('data:')
}

function guessMimeFromDataURL(dataUrl) {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1] : 'image/png'
}

/**
 * Read duration/dimensions off a media file before it is ingested.
 *
 * These are facts about the FILE and they end up on `ref.meta`, so a restored
 * pool card renders a real duration instead of `0:00`. The probe only ever runs
 * at import, so a ref that misses it never gets another chance.
 *
 * Resolves with defaults rather than rejecting: a file we cannot probe is still
 * a file worth storing, and a missing duration must not cost the user the
 * relink. The timeout covers containers that fire neither `loadedmetadata` nor
 * `error` — a hung promise here would stall the whole import loop.
 *
 * @param {File} file
 * @param {'video'|'audio'} kind
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} meta suitable for `createRef`
 */
export function probeMediaFile(file, kind, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video')
    el.preload = 'metadata'

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      // `duration` is Infinity on some streamed containers, which would render
      // as a broken label and give any auto-created clip a nonsense length.
      const duration = Number.isFinite(el.duration) && el.duration > 0
        ? el.duration
        : (kind === 'audio' ? 30 : 10)

      const meta = kind === 'audio'
        ? { duration }
        : { width: el.videoWidth || 1920, height: el.videoHeight || 1080, duration, fps: 30 }

      URL.revokeObjectURL(url)
      el.removeAttribute('src')
      resolve(meta)
    }

    const timer = setTimeout(finish, timeoutMs)
    el.onloadedmetadata = finish
    el.onerror = finish
    el.src = url
  })
}

/** Re-exported so callers do not need a second import to classify a File. */
export { kindFor }
