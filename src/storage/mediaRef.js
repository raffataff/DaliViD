/**
 * DaliVid — storage/mediaRef.js
 * The MediaRef: what a clip stores instead of a `blob:` URL, and the only
 * handle on media the renderer is ever given.
 *
 * ── Why this type exists ──
 * Today a clip points at `URL.createObjectURL(file)`. That is session-scoped by
 * definition, so every reload loses the media and the only way back is matching
 * by filename — which cannot tell two different `intro.mp4` files apart, and
 * cannot recover a renamed one at all.
 *
 * A MediaRef replaces it with a content-addressed identity plus, on desktop, a
 * location the *trusted process* knows about. The id is opaque: it names bytes,
 * not a place. That is what lets the same clip resolve to an OPFS blob on the
 * web and a `dalivid-media://` stream on desktop with no change to the clip.
 *
 * ── The rule this module enforces ──
 * `path`, `mtimeMs` and `sig` are **link-mode, trusted-process-only**. They must
 * never reach the renderer and must never be written into a project document —
 * a `.dalivid.json` is a shareable, untrusted document and your directory
 * structure is local machine state. `stripRefPath` is the one gate; everything
 * that serialises or crosses a process boundary goes through it.
 *
 * Pure module: no I/O, no DOM, no storage. Hashing happens in `hash.js` and is
 * passed in already done.
 */

import { HASH_RE } from './hash.js'

/** What a MediaRef can point at. Fonts are NOT here — they have their own registry. */
export const MEDIA_KINDS = ['video', 'audio', 'image']

/**
 * `vault` — the bytes were copied into our storage; we own them and they cannot
 *   go missing. `link` — the file stays where the user put it and we hold a
 *   reference; fast and space-free, but it can move, change or vanish.
 */
export const MEDIA_MODES = ['vault', 'link']

export const MEDIA_REF_PREFIX = 'mr_'

/**
 * The shape of every id that may be resolved against the ref table.
 *
 * Validated by regex *and* resolved through a Map — never string-concatenated
 * into a path. That pairing is what makes `mr_../../etc/passwd` a lookup miss
 * rather than a traversal: it fails the pattern, and even if it didn't, there
 * is no code path that turns an id into a path by appending it to anything.
 */
export const MEDIA_REF_ID_RE = /^mr_[0-9a-f]{4,32}$/

/** Fields that exist only in link mode and never leave the trusted process. */
export const LOCAL_ONLY_REF_FIELDS = ['path', 'mtimeMs', 'sig']

/**
 * The id for a given content hash.
 *
 * Derived from the hash rather than randomly generated, so importing the same
 * file twice — in one project or in five — yields the same ref and therefore one
 * stored copy. Dedup falls out of the naming; there is no dedup pass.
 *
 * @param {string} hash — from `hashBytes`
 * @returns {string}
 */
export function refIdForHash(hash) {
  if (!isHash(hash)) throw new TypeError(`refIdForHash: not a hash: ${String(hash)}`)
  return MEDIA_REF_PREFIX + hash
}

/**
 * Build a MediaRef. Pure — the caller has already hashed the bytes and, for
 * link mode, stat'd the file.
 *
 * @param {object} init
 * @param {string} init.hash — content hash from `hashBytes`
 * @param {string} init.filename — display name; also the legacy relink-by-name bridge
 * @param {'video'|'audio'|'image'} init.kind
 * @param {string} [init.mime]
 * @param {number} init.bytes
 * @param {'vault'|'link'} [init.mode]
 * @param {number} [init.addedAt]
 * @param {string} [init.file] — the name these bytes have inside `media/`
 * @param {object} [init.meta] — probed properties OF THE FILE (duration, width,
 *   height, fps). Stored because they are facts about the bytes, not about the
 *   project, and re-probing them on load would mean spinning up a media element
 *   per pool entry just to render a duration label. Free-form and optional:
 *   nothing may depend on a given key being present.
 * @param {string} [init.path] — link mode only, trusted process only
 * @param {number} [init.mtimeMs] — link mode only
 * @param {string} [init.sig] — link mode only; from `headTailSig`
 * @returns {object} MediaRef
 */
export function createRef({
  hash, filename, kind, mime = '', bytes,
  mode = 'vault', addedAt = Date.now(), meta, file,
  path, mtimeMs, sig,
} = {}) {
  if (!isHash(hash)) throw new TypeError(`createRef: bad hash: ${String(hash)}`)
  if (!MEDIA_KINDS.includes(kind)) throw new TypeError(`createRef: bad kind: ${String(kind)}`)
  if (!MEDIA_MODES.includes(mode)) throw new TypeError(`createRef: bad mode: ${String(mode)}`)
  if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError(`createRef: bad bytes: ${String(bytes)}`)
  if (typeof filename !== 'string' || !filename) throw new TypeError('createRef: filename required')

  const ref = {
    id: refIdForHash(hash),
    mode,
    hash,
    filename,
    kind,
    mime: String(mime || ''),
    bytes,
    addedAt,
  }

  // The name the bytes actually have inside the project's `media/` folder.
  // Usually `filename`, but a second file wanting a taken name gets a suffix —
  // so this, not `filename`, is what resolves a ref back to its bytes.
  if (file) ref.file = String(file)

  if (meta && typeof meta === 'object') ref.meta = { ...meta }

  if (mode === 'link') {
    // Deliberately only attached in link mode. A vault ref carrying a path would
    // be a path with no reason to exist, and the one place it could leak from is
    // the place it should never have been.
    if (path !== undefined) ref.path = path
    if (mtimeMs !== undefined) ref.mtimeMs = mtimeMs
    if (sig !== undefined) ref.sig = sig
  } else if (path !== undefined || mtimeMs !== undefined || sig !== undefined) {
    throw new TypeError('createRef: path/mtimeMs/sig are link-mode only')
  }

  return ref
}

/** The key a ref is stored and looked up under. */
export function refKey(refOrId) {
  const id = typeof refOrId === 'string' ? refOrId : refOrId?.id
  if (!isRefId(id)) throw new TypeError(`refKey: not a ref id: ${String(id)}`)
  return id
}

/**
 * The ref as it may be written into a project document or handed to the
 * renderer: local-only fields removed.
 *
 * Send someone a project file and they get refs with no paths — every link-mode
 * ref reports `missing` on their machine and the repair flow handles it. That is
 * the correct behaviour, not a shortcoming.
 *
 * @param {object} ref
 * @returns {object} a copy, always — never the same object
 */
export function stripRefPath(ref) {
  const out = { ...ref }
  for (const f of LOCAL_ONLY_REF_FIELDS) delete out[f]
  return out
}

/** True if the ref carries anything that must not cross a boundary. */
export function hasLocalOnlyFields(ref) {
  return !!ref && LOCAL_ONLY_REF_FIELDS.some(f => ref[f] !== undefined)
}

/** @returns {boolean} true for a well-formed content hash. */
export function isHash(value) {
  return typeof value === 'string' && HASH_RE.test(value)
}

/** @returns {boolean} true for a well-formed ref id. Cheap enough to call at every boundary. */
export function isRefId(value) {
  return typeof value === 'string' && MEDIA_REF_ID_RE.test(value)
}

/**
 * Structural check on a whole ref. Used by the schema validator and by every
 * boundary that accepts one.
 * @returns {boolean}
 */
export function isMediaRef(value) {
  if (!value || typeof value !== 'object') return false
  if (!isRefId(value.id)) return false
  if (!isHash(value.hash)) return false
  if (value.id !== refIdForHash(value.hash)) return false
  if (!MEDIA_MODES.includes(value.mode)) return false
  if (!MEDIA_KINDS.includes(value.kind)) return false
  if (typeof value.filename !== 'string' || !value.filename) return false
  if (!Number.isFinite(value.bytes) || value.bytes < 0) return false
  if (value.mime !== undefined && typeof value.mime !== 'string') return false
  if (value.addedAt !== undefined && !Number.isFinite(value.addedAt)) return false
  return true
}

/**
 * Guess a kind from a MIME type or filename. Used at import so the caller does
 * not repeat this in three places; not authoritative — the caller may override.
 * @returns {'video'|'audio'|'image'|null}
 */
export function kindFor(mime = '', filename = '') {
  const m = String(mime).toLowerCase()
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('image/')) return 'image'
  const ext = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (!ext) return null
  if (['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) return 'image'
  return null
}
