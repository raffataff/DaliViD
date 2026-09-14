/**
 * DaliVid — storage/hash.js
 * The single content-addressing primitive, shared by fonts, media blobs and
 * project media references.
 *
 * Lifted verbatim out of `fontRegistry.js`, which proved the model: a font is
 * identified by what it *is*, not by what it was called, so re-importing the
 * same file twice stores one copy and two projects sharing a face share the
 * bytes. Media wants exactly the same property, so the function moved here
 * rather than being copied — one hashing scheme means a blob written by the
 * font path and a blob written by the media path are interchangeable.
 *
 * Nothing in this module touches storage, the DOM or the network. It is pure
 * (given WebCrypto) so it runs unchanged in the renderer, in a Worker, in
 * `node --test`, and — later — in the Electron main process.
 */

/** Hex length of a hash produced by `hashBytes`: SHA-256 truncated to 10 bytes. */
export const HASH_HEX_LENGTH = 20

/**
 * Shape a hash may take. The FNV fallback below is shorter and starts with 'f',
 * so the range is deliberately loose rather than pinned to HASH_HEX_LENGTH.
 * Anything matching this is safe to use as a filename component and as the tail
 * of a MediaRef id.
 */
export const HASH_RE = /^[0-9a-f]{4,32}$/

/** How much of each end `headTailSig` reads. See the note on that function. */
export const SIG_WINDOW_BYTES = 1024 * 1024

/**
 * SHA-256 of the bytes, truncated to 10 bytes / 20 hex chars, used as content
 * identity.
 *
 * 80 bits is far more than enough to distinguish the files one person imports:
 * a collision needs ~2^40 (a trillion) distinct blobs before it becomes likely,
 * and the consequence of one would be a wrong picture, not a security failure —
 * nothing here is an authentication decision.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<string>} lowercase hex
 */
export async function hashBytes(buffer) {
  const view = toUint8(buffer)
  if (globalThis.crypto?.subtle) {
    // `digest` wants an ArrayBuffer or a view; hand it a view so a Uint8Array
    // that is a window onto a larger buffer hashes only its own bytes.
    const digest = await globalThis.crypto.subtle.digest('SHA-256', view)
    return [...new Uint8Array(digest).slice(0, 10)]
      .map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // Non-secure context (plain http:// on a LAN IP). FNV-1a over the bytes is
  // not cryptographic but is fine for de-duplicating a handful of local files.
  let h = 0x811c9dc5
  for (let i = 0; i < view.length; i++) { h ^= view[i]; h = (h * 0x01000193) >>> 0 }
  return 'f' + h.toString(16).padStart(8, '0') + view.length.toString(16)
}

/**
 * Drift signature for a file we reference in place rather than copy: SHA-256 of
 * `[first 1 MiB][last 1 MiB][size as u64 LE]`.
 *
 * **Why not just hash the file.** Hashing a 4 GB source at import is 20–40 s of
 * disk I/O, on the import path, for every file. This is O(2 MiB) regardless of
 * size — a 40 GB source costs the same as a 40 MB one.
 *
 * **Why not just size + mtime.** Those miss the case that actually loses work:
 * a *different* file that has taken the same name and path (a re-export, a
 * restored backup, a colleague's copy). Reading real bytes from both ends
 * catches it.
 *
 * This is drift detection, not authentication. It is not adversary-proof and
 * does not need to be — nothing trusts it with a security decision, it only
 * decides whether to report a reference as `ok` or `changed`.
 *
 * @param {Blob|File|ArrayBuffer|Uint8Array} input
 * @returns {Promise<string>} lowercase hex, same alphabet as `hashBytes`
 */
export async function headTailSig(input) {
  const size = byteLengthOf(input)
  const window = SIG_WINDOW_BYTES

  let head, tail
  if (size <= window * 2) {
    // Small enough that the two windows would overlap — read it once. Hashing
    // the whole file here is not a special case to remember: it is strictly
    // more information than the head/tail pair, for less I/O than reading both.
    head = await readRange(input, 0, size)
    tail = new Uint8Array(0)
  } else {
    head = await readRange(input, 0, window)
    tail = await readRange(input, size - window, size)
  }

  const composed = new Uint8Array(head.length + tail.length + 8)
  composed.set(head, 0)
  composed.set(tail, head.length)
  // Size as u64 LE. Included so two files that happen to share both windows —
  // the same header and the same trailer, e.g. a truncated copy — still differ.
  new DataView(composed.buffer).setBigUint64(
    head.length + tail.length, BigInt(size), true
  )
  return hashBytes(composed)
}

/** Byte length of anything `headTailSig` accepts. */
function byteLengthOf(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return input.size
  if (input instanceof Uint8Array) return input.byteLength
  if (input instanceof ArrayBuffer) return input.byteLength
  throw new TypeError('headTailSig: expected a Blob, File, ArrayBuffer or Uint8Array')
}

/** Read `[start, end)` out of anything `headTailSig` accepts, as a Uint8Array. */
async function readRange(input, start, end) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    // Blob.slice does not read: only the awaited arrayBuffer() touches the disk,
    // so a multi-GB File never becomes resident.
    return new Uint8Array(await input.slice(start, end).arrayBuffer())
  }
  return toUint8(input).subarray(start, end)
}

/** ArrayBuffer | Uint8Array → Uint8Array, without copying. */
function toUint8(buffer) {
  if (buffer instanceof Uint8Array) return buffer
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer)
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }
  throw new TypeError('hashBytes: expected an ArrayBuffer or a typed array')
}
