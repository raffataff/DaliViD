/**
 * DaliVid — storage/webVault.js
 * The OPFS backend: content-addressed blob storage for media (and, later,
 * fonts), plus the playback URLs the renderer actually consumes.
 *
 * ── Why OPFS and not IndexedDB ──
 * A `blob:` URL from `URL.createObjectURL(file)` is session-scoped by
 * definition, which is *the* reason media does not survive a reload today.
 * OPFS gives us a real file we can re-open after a reload and hand back as a
 * fresh object URL — and it does so with **zero authority**: the origin private
 * file system is scoped to our origin, invisible to the user's disk, and needs
 * no permission prompt. That is the whole reason folder linking is not coming
 * back; see VAULT.md.
 *
 * ── What lives here and what does not ──
 * This module stores **bytes, keyed by content hash, and nothing else.** No
 * filename, no MIME type, no duration. All of that lives on the MediaRef, which
 * lives in the project document. That split is deliberate: it means a blob has
 * no metadata that can drift out of sync with the project, dedup is exact (the
 * same file imported into three projects is one blob), and there is no sidecar
 * index to corrupt, migrate, or keep transactionally consistent with the files.
 *
 * The consequence to remember: OPFS `File` objects come back with `type: ''`,
 * so `getPlaybackURL` must be told the MIME type from the ref. A `<video>` fed a
 * typeless blob URL will often still play, but not reliably across containers —
 * so this is not an optimisation to skip.
 */

import { hashBytes } from './hash.js'
import { isHash } from './mediaRef.js'

const BLOB_DIR = 'blobs'
/** Media inside a project folder, under real filenames. */
const MEDIA_DIR = 'media'
/** Suffix for a partial write. See `putBlob` for why this exists. */
const PART_SUFFIX = '.part'

/**
 * How old a `.part` file must be before the GC treats it as abandoned rather
 * than as an import currently writing into it. Generous on purpose: reclaiming
 * a few stray megabytes is never urgent, and killing a live import is.
 */
const PART_STALE_MS = 5 * 60 * 1000

/** hash → object URL. Module-level so repeated resolves reuse one URL per blob. */
const _urls = new Map()

let _rootPromise = null

/**
 * When set, the vault reads and writes here instead of OPFS.
 *
 * This is the OPEN PROJECT's folder. The entire file API below is written against a
 * `FileSystemDirectoryHandle`, and the OPFS root and a folder the user picked
 * are the same type — so pointing the vault at a real folder is a change of
 * root, not a second backend. See `projectFolders.js`.
 */
let _externalRoot = null

/** Thrown when the origin is out of storage. Callers must surface this, never swallow it. */
export class VaultQuotaError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'VaultQuotaError'
    this.code = 'QUOTA_EXCEEDED'
    this.cause = cause
  }
}

/** Thrown when OPFS is unavailable (old browser, exotic context). */
export class VaultUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VaultUnavailableError'
    this.code = 'VAULT_UNAVAILABLE'
  }
}

/** @returns {boolean} whether this browser can back the vault at all. */
export function isSupported() {
  if (_externalRoot) return true
  return typeof navigator !== 'undefined'
    && !!navigator.storage?.getDirectory
    && typeof FileSystemFileHandle !== 'undefined'
}

/**
 * Point the vault at a folder, or back at browser storage with null.
 *
 * **Revokes every cached playback URL.** Those URLs reference files in the root
 * being left behind; keeping them would leave clips pointing at bytes the vault
 * can no longer reach, which fails as `ERR_FILE_NOT_FOUND` at play time rather
 * than as anything legible. The caller reopens a project after switching.
 *
 * @param {FileSystemDirectoryHandle|null} handle
 */
export function setRootHandle(handle) {
  if (_externalRoot === handle) return
  revokeAllPlaybackURLs()
  _externalRoot = handle || null
  _rootPromise = null
}

/** True when the vault is pointed at a real folder rather than browser storage. */
export function isExternalRoot() {
  return !!_externalRoot
}

/** The vault root: a connected folder if there is one, otherwise OPFS. Memoised. */
function root() {
  if (_externalRoot) return Promise.resolve(_externalRoot)
  if (!isSupported()) {
    return Promise.reject(new VaultUnavailableError(
      'This browser has no Origin Private File System, so media cannot be stored.'
    ))
  }
  if (!_rootPromise) {
    _rootPromise = navigator.storage.getDirectory().catch(e => {
      _rootPromise = null
      throw e
    })
  }
  return _rootPromise
}

/** The `/blobs` directory, created on first use. Browser-storage layout only. */
async function blobDir(create = true) {
  return (await root()).getDirectoryHandle(BLOB_DIR, { create })
}

/** The project folder's `media/` directory. Folder layout only. */
async function mediaDir(create = true) {
  return (await root()).getDirectoryHandle(MEDIA_DIR, { create })
}

/**
 * Store bytes under a real filename inside `media/`.
 *
 * Dedup still happens on content: an existing file of the same name AND size is
 * treated as already stored. A different file that wants a taken name gets a
 * numeric suffix, so two `intro.mp4` from different folders can both live here —
 * which is exactly the case filename-only relinking could never handle.
 */
async function putNamedBlob(blob, hash, filename) {
  const dir = await mediaDir()
  const wanted = safeFileName(filename || hash)

  // Reuse the name if it already holds these exact bytes.
  try {
    const existing = await (await dir.getFileHandle(wanted)).getFile()
    if (existing.size === blob.size) {
      return { hash, bytes: blob.size, deduped: true, file: wanted }
    }
  } catch { /* free */ }

  const name = await uniqueName(dir, wanted)
  const partName = `${name}.part`
  try {
    const partHandle = await dir.getFileHandle(partName, { create: true })
    const writable = await partHandle.createWritable()
    try { await writable.write(blob) } finally { await writable.close() }

    if (!await tryMove(partHandle, name)) {
      const finalHandle = await dir.getFileHandle(name, { create: true })
      const w = await finalHandle.createWritable()
      try { await w.write(blob) } finally { await w.close() }
      await dir.removeEntry(partName).catch(() => {})
    }
  } catch (e) {
    await dir.removeEntry(partName).catch(() => {})
    const quota = asQuotaError(e, `${formatBytes(blob.size)} of media`)
    if (quota) throw quota
    throw e
  }

  return { hash, bytes: blob.size, deduped: false, file: name }
}

/** A filename safe for every filesystem we might be sitting on. */
function safeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|]/g, '_')     // illegal on Windows
    .replace(/^\.+/, '')                 // no leading dots — hidden, or `..`
    .slice(0, 120)
    .trim()
  return cleaned || 'media'
}

/** `beach.mp4` → `beach (2).mp4` when the name is taken by different bytes. */
async function uniqueName(dir, wanted) {
  const dot = wanted.lastIndexOf('.')
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted
  const ext = dot > 0 ? wanted.slice(dot) : ''

  let candidate = wanted
  for (let n = 2; n < 1000; n++) {
    let taken = true
    try {
      await dir.getFileHandle(candidate)
    } catch {
      taken = false
    }
    if (!taken) return candidate
    candidate = `${stem} (${n})${ext}`
  }
  return `${stem} (${Date.now()})${ext}`
}

/**
 * Rename a handle into place, reporting whether it worked.
 *
 * `move()` is present on every file handle but only implemented for the origin
 * private file system, so a `typeof` check says nothing about whether the call
 * will succeed on a folder the user picked. Trying it is the only test there is.
 *
 * @returns {Promise<boolean>} false when the caller must fall back to a copy
 */
async function tryMove(handle, name) {
  if (typeof handle.move !== 'function') return false
  try {
    await handle.move(name)
    return true
  } catch {
    return false
  }
}

/** `QuotaExceededError` arrives under two different names depending on the path. */
function asQuotaError(e, what) {
  const name = e?.name || ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_FILE_NO_DEVICE_SPACE') {
    return new VaultQuotaError(`Not enough browser storage to save ${what}.`, e)
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Blobs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store bytes under their content hash.
 *
 * Idempotent and deduplicating: storing the same bytes twice writes once and
 * reports `deduped: true`. That is not a nicety — it is what makes "the same
 * clip in three projects costs one copy" true, and it falls out of the naming
 * rather than needing a dedup pass.
 *
 * @param {Blob|File|ArrayBuffer|Uint8Array} input
 * @param {{ hash?: string }} [opts] — pass a precomputed hash to skip re-hashing
 * @returns {Promise<{hash: string, bytes: number, deduped: boolean}>}
 */
export async function putBlob(input, { hash: knownHash, filename } = {}) {
  const blob = toBlob(input)
  const hash = knownHash || await hashBytes(await blob.arrayBuffer())
  if (!isHash(hash)) throw new TypeError(`putBlob: bad hash: ${String(hash)}`)

  // In a project folder, media is stored under its own name so the folder is
  // legible to the person who owns it. Identity is still the content hash — the
  // name is a label, and `file` on the MediaRef is what resolves it back.
  if (_externalRoot) return putNamedBlob(blob, hash, filename)

  const dir = await blobDir()

  const existing = await statBlob(hash)
  // Size is the integrity check. Re-hashing on every write would defeat content
  // addressing's whole cost advantage, but a zero-length or short file is the
  // signature of an interrupted write, so that one we do catch and redo.
  if (existing && existing.bytes === blob.size) {
    return { hash, bytes: blob.size, deduped: true }
  }

  // Write to a partial name and rename into place. A blob is named by its own
  // content, so a torn write would otherwise leave a *short file under the right
  // name* — which every future dedup check would then accept as valid, forever.
  const partName = hash + PART_SUFFIX
  try {
    const partHandle = await dir.getFileHandle(partName, { create: true })
    const writable = await partHandle.createWritable()
    try {
      await writable.write(blob)
    } finally {
      await writable.close()
    }

    if (!await tryMove(partHandle, hash)) {
      // No usable `move()`: copy across, then drop the partial. Still strictly
      // better than writing under the final name directly, because the final
      // name only appears once the bytes are all present.
      const finalHandle = await dir.getFileHandle(hash, { create: true })
      const w = await finalHandle.createWritable()
      try {
        await w.write(blob)
      } finally {
        await w.close()
      }
      await dir.removeEntry(partName).catch(() => {})
    }
  } catch (e) {
    await dir.removeEntry(partName).catch(() => {})
    const quota = asQuotaError(e, `${formatBytes(blob.size)} of media`)
    if (quota) throw quota
    throw e
  }

  return { hash, bytes: blob.size, deduped: false }
}

/**
 * Size of a stored blob, or null if it is not here.
 * @returns {Promise<{bytes: number}|null>}
 */
export async function statBlob(hash, file) {
  if (_externalRoot) {
    if (!file) return null
    try {
      const dir = await mediaDir(false)
      return { bytes: (await (await dir.getFileHandle(file)).getFile()).size }
    } catch {
      return null
    }
  }
  if (!isHash(hash)) return null
  try {
    const dir = await blobDir(false)
    const f = await (await dir.getFileHandle(hash)).getFile()
    return { bytes: f.size }
  } catch {
    return null
  }
}

/**
 * The stored bytes as a File. Use for SMALL things (fonts, images).
 * For video and audio use `getPlaybackURL`, which never materialises the file.
 * @returns {Promise<File|null>}
 */
export async function getBlobFile(hash, file) {
  if (_externalRoot) {
    if (!file) return null
    try {
      const dir = await mediaDir(false)
      return await (await dir.getFileHandle(file)).getFile()
    } catch {
      return null
    }
  }
  if (!isHash(hash)) return null
  try {
    const dir = await blobDir(false)
    return await (await dir.getFileHandle(hash)).getFile()
  } catch {
    return null
  }
}

/** @returns {Promise<ArrayBuffer|null>} */
export async function getBlobBytes(hash, file) {
  const f = await getBlobFile(hash, file)
  return f ? await f.arrayBuffer() : null
}

/**
 * A URL a `<video>` / `<audio>` / `<img>` can play, for a stored blob.
 *
 * **This is the function that makes media survive a reload.** It is still an
 * object URL — the browser gives us nothing cheaper — but it is now
 * *recreatable*, because the bytes are in OPFS rather than in a `File` the page
 * happened to be holding. Reload, resolve again, and the clip plays.
 *
 * Cached per hash: two clips cut from one source share a URL, and re-resolving
 * during a re-render does not leak a new one every time.
 *
 * @param {string} hash
 * @param {string} [mime] — from the MediaRef. OPFS files have no type of their
 *   own, and some containers will not play from a typeless blob URL.
 * @returns {Promise<string|null>}
 */
export async function getPlaybackURL(hash, mime = '', file) {
  // Cache by whatever identifies the bytes in the ACTIVE root. Keying on hash in
  // folder mode would let a URL made in one project resolve in the next, which
  // is how you end up playing the wrong footage after switching projects.
  const key = _externalRoot ? `f:${file || ''}` : hash
  if (!_externalRoot && !isHash(hash)) return null
  if (_externalRoot && !file) return null

  const cached = _urls.get(key)
  if (cached) return cached

  const blobFile = await getBlobFile(hash, file)
  if (!blobFile) return null

  // Re-wrap so the URL carries a usable type. `new Blob([file])` does not read
  // the file — it references it — so this stays O(1) regardless of size.
  const typed = mime ? new Blob([blobFile], { type: mime }) : blobFile
  const url = URL.createObjectURL(typed)
  _urls.set(key, url)
  return url
}

/** Drop and revoke the cached URL for one blob. */
export function revokePlaybackURL(hash, file) {
  const key = _externalRoot ? `f:${file || ''}` : hash
  const url = _urls.get(key)
  if (url) {
    URL.revokeObjectURL(url)
    _urls.delete(key)
  }
}

/** Drop and revoke every cached URL. Call on project close. */
export function revokeAllPlaybackURLs() {
  for (const url of _urls.values()) URL.revokeObjectURL(url)
  _urls.clear()
}

/** Remove a blob permanently. */
export async function deleteBlob(hash, file) {
  revokePlaybackURL(hash, file)
  if (_externalRoot) {
    if (!file) return
    try {
      const dir = await mediaDir(false)
      await dir.removeEntry(file)
    } catch { /* already gone */ }
    return
  }
  if (!isHash(hash)) return
  try {
    const dir = await blobDir(false)
    await dir.removeEntry(hash)
  } catch { /* already gone */ }
}

/**
 * Every hash currently stored, with its size.
 * @returns {Promise<Array<{hash: string, bytes: number}>>}
 */
export async function listBlobs() {
  const out = []
  if (_externalRoot) {
    try {
      const dir = await mediaDir(false)
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue
        if (name.endsWith(PART_SUFFIX)) continue
        // No hash: in a project folder the file's NAME is its identity, and the
        // MediaRef carries the hash. Re-hashing every file to list them would
        // read the whole folder off disk to draw a size column.
        out.push({ file: name, hash: null, bytes: (await handle.getFile()).size })
      }
    } catch { /* no media dir yet */ }
    return out
  }
  try {
    const dir = await blobDir(false)
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue
      if (name.endsWith(PART_SUFFIX)) continue   // an interrupted write; `gcBlobs` sweeps these
      if (!isHash(name)) continue
      out.push({ hash: name, file: name, bytes: (await handle.getFile()).size })
    }
  } catch { /* no blob dir yet */ }
  return out
}

/**
 * Delete every blob not in `reachable`, plus any leftover partial writes.
 *
 * **Never run this during an export.** An export holds object URLs it resolved
 * earlier; deleting the file underneath one is exactly the kind of failure that
 * shows up as a corrupt output file thirty minutes in.
 *
 * **A blob with a live playback URL is never deleted, whatever `reachable`
 * says.** This guard is not redundant with the caller's reachability sweep — it
 * is the backstop for the case that actually bit: anything that empties the ref
 * list (a late-arriving project restore, a load race) makes media the user is
 * *currently watching* look unreachable, and without this the bytes are deleted
 * out from under a playing `<video>`. An object URL exists only because
 * something asked to play those bytes, so it is a direct statement of "in use"
 * that cannot go stale the way a derived set can.
 *
 * The asymmetry is the whole argument: wrongly keeping a blob wastes space
 * until the next sweep; wrongly deleting one destroys the user's media.
 *
 * @param {Iterable<string>} reachable — hashes referenced by any project
 * @returns {Promise<{deleted: number, freed: number, kept: number, pinned: number}>}
 */
export async function gcBlobs(reachable) {
  const keep = reachable instanceof Set ? reachable : new Set(reachable || [])
  let deleted = 0
  let freed = 0
  let kept = 0
  let pinned = 0

  // A project folder holds exactly one project's media, so "unreachable" is a
  // local question with a local answer — no scan of other projects, and no way
  // for this sweep to touch another project's files. `keep` is filenames here.
  if (_externalRoot) {
    let dir
    try {
      dir = await mediaDir(false)
    } catch {
      return { deleted, freed, kept, pinned }
    }
    const cutoff = Date.now() - PART_STALE_MS
    const doomed = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue
      if (name.endsWith(PART_SUFFIX)) {
        if ((await handle.getFile()).lastModified < cutoff) doomed.push([name, 0])
        continue
      }
      if (keep.has(name)) { kept++; continue }
      if (_urls.has(`f:${name}`)) { pinned++; continue }
      doomed.push([name, (await handle.getFile()).size])
    }
    for (const [name, bytes] of doomed) {
      await dir.removeEntry(name).catch(() => {})
      deleted++
      freed += bytes
    }
    return { deleted, freed, kept, pinned }
  }

  // Sweep abandoned partial writes — but only ones old enough to be certain they
  // are abandoned. A `.part` file is also what an import currently in flight is
  // writing into, and deleting that out from under `putBlob` fails the import
  // for no reason. Age is the only thing that distinguishes the two.
  try {
    const dir = await blobDir(false)
    const cutoff = Date.now() - PART_STALE_MS
    const stale = []
    for await (const [name, handle] of dir.entries()) {
      if (!name.endsWith(PART_SUFFIX)) continue
      try {
        if ((await handle.getFile()).lastModified < cutoff) stale.push(name)
      } catch { /* vanished under us — nothing to do */ }
    }
    for (const name of stale) await dir.removeEntry(name).catch(() => {})
  } catch { /* no blob dir yet */ }

  for (const { hash, bytes } of await listBlobs()) {
    if (keep.has(hash)) { kept++; continue }
    // Something is holding a URL for these bytes right now. Never delete.
    if (_urls.has(hash)) { pinned++; continue }
    await deleteBlob(hash)
    deleted++
    freed += bytes
  }
  return { deleted, freed, kept, pinned }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic file API (paths are vault-relative, e.g. "projects/<id>/project.json")
//
// Deliberately dumb: these move bytes and know nothing about projects, backups
// or rotation. All of that logic lives in `projectStore.js` so it is shared
// verbatim with the desktop backend later — the split the whole storage layer
// exists to preserve.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split and validate a vault-relative path.
 *
 * Every segment is checked against a strict pattern. Ids reaching here come from
 * project documents, which are untrusted input, and OPFS `getDirectoryHandle`
 * would happily accept `..` — so this is the traversal guard, not a formality.
 */
function splitPath(path) {
  const parts = String(path).split('/').filter(Boolean)
  if (!parts.length) throw new TypeError('vault path is empty')
  for (const p of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(p) || p === '.' || p === '..') {
      throw new TypeError(`unsafe vault path segment: ${p}`)
    }
  }
  return parts
}

/** Walk to the directory holding `path`'s last segment. */
async function dirFor(parts, create) {
  let dir = await root()
  for (const seg of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(seg, { create })
  }
  return dir
}

/** @returns {Promise<string|null>} the file's text, or null if absent. */
export async function readText(path) {
  const parts = splitPath(path)
  try {
    const dir = await dirFor(parts, false)
    const file = await (await dir.getFileHandle(parts.at(-1))).getFile()
    return await file.text()
  } catch {
    return null
  }
}

/**
 * Write text so that a reader never sees a half-written file.
 *
 * Writes a sibling `.tmp` and renames it into place. The rename is the atomic
 * step: `project.json` either still holds the previous version or holds the
 * complete new one, never a truncated mixture. Without it a crash mid-write
 * leaves a syntactically broken project — and since there is only ever one copy,
 * that is the whole edit gone.
 *
 * Where `move()` is unavailable (pre-111 Chromium) the caller's backup is the
 * safety net, so `projectStore` takes one before calling this.
 */
export async function writeTextAtomic(path, text) {
  const parts = splitPath(path)
  const name = parts.at(-1)
  const tmpName = `${name}.tmp`
  const dir = await dirFor(parts, true)

  try {
    const tmp = await dir.getFileHandle(tmpName, { create: true })
    const w = await tmp.createWritable()
    try {
      await w.write(text)
    } finally {
      await w.close()
    }

    // **`move()` has to be TRIED, not just tested for.** It exists on the
    // prototype of every file handle, but Chrome only implements it inside the
    // origin private file system — on a handle from `showDirectoryPicker` it
    // rejects. Checking `typeof` therefore passes and the call then throws, and
    // because the catch below cleans up and rethrows, the result was a project
    // folder that never received its `project.json` at all.
    if (!await tryMove(tmp, name)) {
      const finalHandle = await dir.getFileHandle(name, { create: true })
      const fw = await finalHandle.createWritable()
      try {
        await fw.write(text)
      } finally {
        await fw.close()
      }
      await dir.removeEntry(tmpName).catch(() => {})
    }
  } catch (e) {
    await dir.removeEntry(tmpName).catch(() => {})
    const quota = asQuotaError(e, 'the project')
    if (quota) throw quota
    throw e
  }

  return { bytes: text.length }
}

/** Copy one vault file to another path. Used for backup rotation. */
export async function copyFile(fromPath, toPath) {
  const text = await readText(fromPath)
  if (text == null) return false
  await writeTextAtomic(toPath, text)
  return true
}

/**
 * Entries directly inside a vault directory.
 * @returns {Promise<Array<{name: string, kind: string, bytes: number, lastModified: number}>>}
 */
export async function list(dirPath) {
  const out = []
  try {
    const parts = dirPath ? splitPath(dirPath) : []
    let dir = await root()
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create: false })
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const f = await handle.getFile()
        out.push({ name, kind: 'file', bytes: f.size, lastModified: f.lastModified })
      } else {
        out.push({ name, kind: 'directory', bytes: 0, lastModified: 0 })
      }
    }
  } catch { /* directory does not exist yet */ }
  return out
}

/** Remove a file, or a directory and everything under it. */
export async function remove(path, { recursive = false } = {}) {
  const parts = splitPath(path)
  try {
    const dir = await dirFor(parts, false)
    await dir.removeEntry(parts.at(-1), { recursive })
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Housekeeping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What this backend can do. The UI reads this instead of sniffing for Electron.
 * @returns {Promise<object>}
 */
export async function capabilities() {
  const est = await usage()
  return {
    backend: _externalRoot ? 'folder' : 'web',
    blobs: isSupported(),
    link: false,              // referencing files in place needs a trusted process
    nativeDialogs: false,
    streamingExport: false,
    // In folder mode the files are ordinary files on the user's disk: the
    // browser cannot evict them, so eviction is not a risk to report.
    persisted: _externalRoot ? true : est.persisted,
    quotaBytes: est.quota,
  }
}

/**
 * Storage in use and available.
 *
 * `navigator.storage.estimate()` reports the whole origin, so `blobs` is
 * measured directly and `other` is whatever else the origin holds (projects and
 * fonts in IndexedDB, today).
 */
export async function usage() {
  let quota = null
  let total = null
  let persisted = false

  // `navigator.storage.estimate()` describes the ORIGIN's storage, which says
  // nothing at all about a folder on the user's disk. Reporting it in folder
  // mode would show a quota that does not apply and a usage figure that does
  // not include the folder — worse than reporting nothing.
  if (!_externalRoot) {
    try {
      const est = await navigator.storage?.estimate?.()
      quota = est?.quota ?? null
      total = est?.usage ?? null
    } catch { /* not available */ }
    try {
      persisted = await navigator.storage?.persisted?.() ?? false
    } catch { /* not available */ }
  }

  const list = await listBlobs()
  const blobBytes = list.reduce((n, b) => n + b.bytes, 0)

  if (_externalRoot) {
    return {
      blobs: blobBytes,
      blobCount: list.length,
      total: blobBytes,
      quota: null,          // the disk's free space is not something we can see
      persisted: true,      // real files; nothing evicts them
      other: null,
      external: true,
    }
  }

  return {
    blobs: blobBytes,
    blobCount: list.length,
    total,
    quota,
    persisted,
    other: total == null ? null : Math.max(0, total - blobBytes),
    external: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Anything byte-ish → Blob, without copying where possible. */
function toBlob(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return input
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return new Blob([input])
  throw new TypeError('putBlob: expected a Blob, File, ArrayBuffer or typed array')
}

/** Local copy so this module has no UI dependency. */
function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
