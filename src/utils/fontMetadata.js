/**
 * DaliVid — fontMetadata.js
 * Minimal OpenType/TrueType introspection for user-supplied font files.
 *
 * Two things we want from a dropped font that the browser will not tell us:
 *
 *   1. Its real family name — "HelveticaNeue-CondensedBlack.otf" is a filename,
 *      "Helvetica Neue" is what belongs in the picker.
 *   2. Its actual weight range — a variable font's `fvar` wght axis, or a static
 *      font's single `OS/2` usWeightClass. Without this the Weight dropdown
 *      offers 100–900 for a font that only has 400, and the browser silently
 *      fakes the rest by smearing outlines.
 *
 * Only bare sfnt containers (.ttf / .otf / .ttc) are parsed. WOFF and WOFF2
 * compress their table data (per-table zlib / whole-file Brotli), so reading
 * them would mean shipping a decompressor for a marginal gain — those fall back
 * to the filename and an open weight range, which degrades gracefully because
 * the browser clamps an out-of-range weight to the nearest one it has.
 *
 * Everything here is best-effort: any malformed table returns null rather than
 * throwing, because a font that fails to introspect can still render fine.
 */

/** Weight range assumed when a font won't tell us its own (WOFF/WOFF2). */
export const DEFAULT_WEIGHT_RANGE = [100, 900]

/**
 * Read family name + weight range out of a font binary.
 * @param {ArrayBuffer} buffer — raw font file bytes
 * @returns {{ family: string|null, weights: [number, number]|null, variable: boolean }}
 */
export function readSfntMetadata(buffer) {
  const empty = { family: null, weights: null, variable: false }
  try {
    const view = new DataView(buffer)
    const tables = readTableDirectory(view)
    if (!tables) return empty

    const fvar = tables.get('fvar')
    const wght = fvar ? readWghtAxis(view, fvar.offset) : null

    let weights = wght
    if (!weights) {
      const os2 = tables.get('OS/2')
      // usWeightClass lives at offset 4 in the OS/2 table (after version +
      // xAvgCharWidth). A static font reports one weight for both ends.
      if (os2 && os2.offset + 6 <= view.byteLength) {
        const w = view.getUint16(os2.offset + 4)
        if (w >= 1 && w <= 1000) weights = [w, w]
      }
    }

    const nameTable = tables.get('name')
    const family = nameTable ? readFamilyName(view, nameTable.offset) : null

    return { family, weights, variable: !!wght }
  } catch {
    return empty
  }
}

/**
 * Parse the sfnt table directory into name → {offset, length}.
 * Handles the plain `\0\1\0\0` / `OTTO` / `true` tags and TrueType Collections
 * (`ttcf`, where we simply read the first font in the collection).
 */
function readTableDirectory(view) {
  if (view.byteLength < 12) return null
  let base = 0
  const tag = readTag(view, 0)

  if (tag === 'ttcf') {
    if (view.byteLength < 16) return null
    base = view.getUint32(12) // offset of the first font's table directory
    if (base + 12 > view.byteLength) return null
  } else if (tag !== 'OTTO' && tag !== 'true' && tag !== 'typ1' && view.getUint32(0) !== 0x00010000) {
    return null // not an sfnt (most likely WOFF/WOFF2 — handled by the caller)
  }

  const numTables = view.getUint16(base + 4)
  // A directory entry is 16 bytes; bail rather than walk off the end of a
  // truncated file (numTables is attacker-controlled for our purposes).
  if (base + 12 + numTables * 16 > view.byteLength) return null

  const tables = new Map()
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16
    const offset = view.getUint32(rec + 8)
    const length = view.getUint32(rec + 12)
    if (offset + length > view.byteLength) continue // skip a bogus entry, keep the rest
    tables.set(readTag(view, rec), { offset, length })
  }
  return tables
}

/** Read a 4-byte ASCII table tag. */
function readTag(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  )
}

/**
 * Find the `wght` axis in a variable font's `fvar` table.
 * @returns {[number, number]|null} [min, max], rounded to whole weights
 */
function readWghtAxis(view, offset) {
  if (offset + 16 > view.byteLength) return null
  const axesArrayOffset = view.getUint16(offset + 4)
  const axisCount = view.getUint16(offset + 8)
  const axisSize = view.getUint16(offset + 10)
  if (!axisCount || axisSize < 20) return null

  for (let i = 0; i < axisCount; i++) {
    const a = offset + axesArrayOffset + i * axisSize
    if (a + 20 > view.byteLength) return null
    if (readTag(view, a) !== 'wght') continue
    // Axis bounds are Fixed 16.16 — divide the signed 32-bit value by 65536.
    const min = Math.round(view.getInt32(a + 4) / 65536)
    const max = Math.round(view.getInt32(a + 12) / 65536)
    if (min > 0 && max >= min) return [min, max]
  }
  return null
}

/**
 * Pull the human family name out of the `name` table.
 *
 * Preference order is Typographic Family (id 16) over Font Family (id 1): for a
 * family like "Helvetica Neue Condensed Black", id 1 carries the RIBBI-split
 * name ("Helvetica Neue Cond Black") while id 16 carries the real family the
 * designer intended. Windows/Unicode encodings are UTF-16BE; Macintosh Roman
 * (platform 1) is close enough to Latin-1 for a display label.
 */
function readFamilyName(view, offset) {
  if (offset + 6 > view.byteLength) return null
  const count = view.getUint16(offset + 2)
  const stringOffset = offset + view.getUint16(offset + 4)
  if (offset + 6 + count * 12 > view.byteLength) return null

  let best = null
  let bestScore = -1
  for (let i = 0; i < count; i++) {
    const rec = offset + 6 + i * 12
    const platformID = view.getUint16(rec)
    const nameID = view.getUint16(rec + 6)
    if (nameID !== 1 && nameID !== 16) continue

    // Typographic Family wins over Font Family; a Unicode/Windows record wins
    // over a Mac one when both carry the same nameID.
    const score = (nameID === 16 ? 2 : 0) + (platformID === 3 || platformID === 0 ? 1 : 0)
    if (score <= bestScore) continue

    const length = view.getUint16(rec + 8)
    const strOff = stringOffset + view.getUint16(rec + 10)
    if (!length || strOff + length > view.byteLength) continue

    const str = platformID === 1
      ? decodeLatin1(view, strOff, length)
      : decodeUtf16BE(view, strOff, length)
    const clean = str.replace(/\0/g, '').trim()
    if (!clean) continue

    best = clean
    bestScore = score
  }
  return best
}

function decodeUtf16BE(view, offset, length) {
  let out = ''
  for (let i = 0; i + 1 < length; i += 2) out += String.fromCharCode(view.getUint16(offset + i))
  return out
}

function decodeLatin1(view, offset, length) {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}
