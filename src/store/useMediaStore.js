/**
 * DaliVid — useMediaStore.js
 * The Media Pool, as project state.
 *
 * ── What changed and why ──
 * The pool used to be four `useState` arrays inside `MediaPool.jsx`. That is why
 * media did not survive a reload: the entries died with the component, and the
 * bytes died with the `blob:` URLs, which are session-scoped by definition. The
 * only way back was relink-by-filename, which cannot tell two different
 * `intro.mp4` files apart and cannot recover a renamed one at all.
 *
 * Now the pool is a list of **MediaRefs** — content-addressed handles whose
 * bytes live in the vault. Refs are serialised into the project document under
 * `media.refs`; on load they are re-resolved to fresh object URLs and the clips
 * that reference them start playing again with no prompt.
 *
 * ── The two halves, and why they are separate ──
 * `refs` is **persistent** — it is written to the project file.
 * `urls` is **runtime** — object URLs, valid only for this page load, rebuilt by
 * `hydrate` on every open. Keeping them apart is what stops a `blob:` URL ever
 * being written into a saved document, where it would be meaningless garbage
 * that *looks* like a working reference.
 */

import { create } from 'zustand'
import { vault, VaultQuotaError } from '../storage/index.js'
import { createRef, kindFor, stripRefPath, isRefId } from '../storage/mediaRef.js'
import { hashBytes } from '../storage/hash.js'

/**
 * Above this, an import asks before copying instead of copying silently.
 *
 * 2 GB is a deliberate placeholder, not a measured optimum: it is comfortably
 * above "a folder of clips from a shoot" and comfortably below "my entire media
 * drive", which is the only distinction that matters for the question being
 * asked. Nobody should have a 40 GB copy started on their behalf.
 *
 * TODO: expose as a user preference (Settings → Storage) so this stops being a
 * constant. Agreed 2026-08-26 to ship the constant first.
 */
export const COPY_PROMPT_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024

const useMediaStore = create((set, get) => ({
  // ── Persistent ──────────────────────────────────────────────────────────
  /** @type {Array<object>} MediaRef[] — serialised into the project's `media.refs`. */
  refs: [],

  // ── Runtime ─────────────────────────────────────────────────────────────
  /** refId → object URL. Rebuilt on every load; never serialised. */
  urls: {},
  /**
   * refId → 'ok' | 'missing'. A ref whose blob is not in the vault: the project
   * came from another machine, or the blob was GC'd. The clip stays on the
   * timeline and reports offline rather than silently rendering black.
   */
  status: {},
  /** True while an import is writing bytes, so the UI can show progress. */
  importing: false,

  // ── Reads ───────────────────────────────────────────────────────────────

  getRef: (refId) => get().refs.find(r => r.id === refId) || null,

  /** The playable URL for a ref, or null if it never resolved. */
  urlFor: (refId) => (refId ? get().urls[refId] || null : null),

  refsOfKind: (kind) => get().refs.filter(r => r.kind === kind),

  /** Every content hash the pool references — the GC's reachable set. */
  reachableHashes: () => new Set(get().refs.map(r => r.hash)),

  // ── Writes ──────────────────────────────────────────────────────────────

  /**
   * Ingest a File into the vault and register it in the pool.
   *
   * Hashing happens first and dedup falls out of it: re-importing a file you
   * already have writes nothing, returns the ref you already had, and every clip
   * pointing at it keeps working.
   *
   * @param {File} file
   * @param {{ kind?: string, session?: boolean, meta?: object }} [opts]
   *   `session: true` skips the vault copy — the entry works for this session
   *   only, which is the escape hatch for someone who does not want 40 GB
   *   duplicated. It is recorded on the ref so the UI can warn on close.
   *   `meta` carries probed facts about the file (duration/width/height/fps).
   * @returns {Promise<object>} the MediaRef
   */
  ingestFile: async (file, { kind, session = false, meta } = {}) => {
    const resolvedKind = kind || kindFor(file.type, file.name)
    if (!resolvedKind) throw new Error(`Unsupported file type: ${file.name}`)

    const hash = await hashBytes(await file.arrayBuffer())

    const existing = get().refs.find(r => r.hash === hash)
    if (existing && get().urls[existing.id]) {
      // Already held. Fill in metadata if this probe learned something the
      // stored ref lacks (an older import, or one that failed to decode).
      if (meta && !existing.meta) {
        set(state => ({
          refs: state.refs.map(r => (r.id === existing.id ? { ...r, meta: { ...meta } } : r)),
        }))
        return get().getRef(existing.id)
      }
      return existing
    }

    let url
    let storedAs
    if (session) {
      // Not copied — this URL is the File itself and dies with the page.
      url = URL.createObjectURL(file)
    } else {
      // `filename` is a request, not a guarantee: in a project folder the vault
      // may add a suffix to avoid clobbering a different file of the same name,
      // and `storedAs` is what it actually used.
      const put = await vault.putBlob(file, { hash, filename: file.name })
      storedAs = put.file
      url = await vault.getPlaybackURL(hash, file.type, storedAs)
    }

    const ref = {
      ...createRef({
        hash,
        filename: file.name,
        kind: resolvedKind,
        mime: file.type || '',
        bytes: file.size,
        meta,
        file: storedAs,
      }),
      // Runtime-only marker; stripped before the ref reaches a document.
      ...(session ? { sessionOnly: true } : {}),
    }

    set(state => ({
      refs: state.refs.some(r => r.id === ref.id) ? state.refs : [...state.refs, ref],
      urls: { ...state.urls, [ref.id]: url },
      status: { ...state.status, [ref.id]: 'ok' },
    }))
    return ref
  },

  /**
   * Ingest raw bytes already in hand — a recording, a generated frame, or an
   * image decoded out of a v1 project's data URL.
   * @returns {Promise<object>} the MediaRef
   */
  ingestBytes: async (bytes, { filename, kind, mime = '', meta }) => {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime })
    const hash = await hashBytes(await blob.arrayBuffer())

    const existing = get().refs.find(r => r.hash === hash)
    if (existing && get().urls[existing.id]) return existing

    const put = await vault.putBlob(blob, { hash, filename: filename || 'untitled' })
    const url = await vault.getPlaybackURL(hash, mime || blob.type, put.file)

    const ref = createRef({
      hash,
      filename: filename || 'untitled',
      kind: kind || kindFor(mime || blob.type, filename || '') || 'image',
      mime: mime || blob.type || '',
      bytes: blob.size,
      meta,
      file: put.file,
    })

    set(state => ({
      refs: state.refs.some(r => r.id === ref.id) ? state.refs : [...state.refs, ref],
      urls: { ...state.urls, [ref.id]: url },
      status: { ...state.status, [ref.id]: 'ok' },
    }))
    return ref
  },

  /**
   * Resolve a loaded project's `media.refs` against the vault.
   *
   * Every ref is re-resolved. One whose bytes are not there is marked `missing`
   * rather than dropped — the project still legitimately references it, and
   * dropping it would discard the user's record of what the clip is supposed
   * to be.
   *
   * **MERGES, and does not revoke.** It used to replace the whole ref list and
   * call `revokeAllPlaybackURLs()` first, which was a real bug with real teeth:
   * this runs inside `restoreProjectMedia`, which is deliberately async, so
   * anything the user imported while it was still in flight had its URL revoked
   * and its ref dropped — and the next GC then deleted those bytes from disk as
   * unreachable. Media the user was watching vanished mid-playback.
   *
   * Merging costs nothing (refs are content-addressed, so an id collision is the
   * same file) and removes the entire class of load-race. Revoking belongs to
   * `clear()`, i.e. closing a project — the one moment we actually know nothing
   * is using them.
   *
   * @param {Array<object>} refs — from the project document
   */
  hydrate: async (refs) => {
    const clean = (refs || []).filter(r => r && isRefId(r.id))

    const urls = {}
    const status = {}
    await Promise.all(clean.map(async (ref) => {
      const url = await vault.getPlaybackURL(ref.hash, ref.mime, ref.file)
      if (url) { urls[ref.id] = url; status[ref.id] = 'ok' }
      else status[ref.id] = 'missing'
    }))

    set(state => {
      // Keep anything already in the store that the document does not mention —
      // that is precisely the media imported during the restore.
      const byId = new Map(state.refs.map(r => [r.id, r]))
      for (const ref of clean) if (!byId.has(ref.id)) byId.set(ref.id, ref)
      return {
        refs: [...byId.values()],
        urls: { ...state.urls, ...urls },
        status: { ...state.status, ...status },
      }
    })

    const ok = Object.keys(urls).length
    return { ok, missing: clean.length - ok }
  },

  /** Add a ref built elsewhere (e.g. the image migration path). */
  addRef: (ref, url) => set(state => ({
    refs: state.refs.some(r => r.id === ref.id) ? state.refs : [...state.refs, ref],
    urls: url ? { ...state.urls, [ref.id]: url } : state.urls,
    status: { ...state.status, [ref.id]: url ? 'ok' : 'missing' },
  })),

  /**
   * Forget a ref. Does NOT delete the blob — that is `gcBlobs`' job, on save,
   * once nothing anywhere references the hash. Two projects can share a blob,
   * so deleting here would take media out from under the other one.
   */
  removeRef: (refId) => set(state => {
    const refs = state.refs.filter(r => r.id !== refId)
    const urls = { ...state.urls }; delete urls[refId]
    const status = { ...state.status }; delete status[refId]
    return { refs, urls, status }
  }),

  setImporting: (importing) => set({ importing }),

  /** Drop everything. Called when a project closes so URLs do not leak across projects. */
  clear: () => {
    vault.revokeAllPlaybackURLs?.()
    set({ refs: [], urls: {}, status: {}, importing: false })
  },

  /**
   * The pool as it goes into a project document: local-only fields removed, and
   * session-only entries dropped.
   *
   * Session entries are excluded deliberately — their bytes were never copied,
   * so saving the ref would produce a document that claims to have media it
   * cannot possibly resolve on the next open.
   */
  serializeRefs: () => get().refs
    .filter(r => !r.sessionOnly)
    .map(r => {
      const clean = stripRefPath(r)
      delete clean.sessionOnly
      return clean
    }),

  /** Refs whose bytes are not in the vault and will not survive a reload. */
  sessionOnlyRefs: () => get().refs.filter(r => r.sessionOnly),
}))

export { VaultQuotaError }
export default useMediaStore
