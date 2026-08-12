/**
 * DaliVid — localFonts.js
 * Browsing the typefaces already installed on the user's machine, via the Local
 * Font Access API (`queryLocalFonts`).
 *
 * ── The design decision worth stating ──
 * A picked system font is NOT stored as a reference to "whatever Helvetica means
 * on this computer". `FontData.blob()` hands us the actual font file, so a face
 * chosen here goes through the same ingest path as an uploaded one and is
 * embedded in the project.
 *
 * That costs a few hundred KB. What it buys is that the project renders
 * identically on the next machine, in the export, and in six months when the
 * user has reinstalled their OS — none of which is true of a font referenced by
 * name. A video editor that silently substitutes a typeface between preview and
 * delivery is worse than one that asks for a bit of disk.
 *
 * The API needs a user gesture and a permission grant, and only exists in
 * Chromium. Everything here degrades to "not available" rather than throwing,
 * since the file picker remains a complete alternative.
 */

/** Whether this browser can enumerate installed fonts at all. */
export function localFontsSupported() {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function'
}

let _cache = null

/**
 * Ask for the installed font list, grouped into families.
 *
 * Must be called from a user gesture — the permission prompt is gated on one.
 * The result is cached for the session because enumeration on a machine with a
 * large font library is not instant and the list cannot change under us in a
 * way that matters mid-edit.
 *
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<Array<{ family: string, faces: Array<{ postscriptName: string, fullName: string, style: string, data: FontData }> }>>}
 * @throws {Error} with a readable message when unsupported or denied
 */
export async function listLocalFontFamilies({ refresh = false } = {}) {
  if (!localFontsSupported()) {
    throw new Error('This browser cannot list installed fonts — use "Add font from file" instead (Chrome and Edge support it)')
  }
  if (_cache && !refresh) return _cache

  let fonts
  try {
    fonts = await window.queryLocalFonts()
  } catch (err) {
    // NotAllowedError is the user declining, or the prompt being suppressed
    // because the call didn't come from a gesture.
    if (err?.name === 'NotAllowedError') {
      throw new Error('Permission to read installed fonts was declined. You can still add fonts from a file.')
    }
    throw new Error(`Could not read installed fonts: ${err?.message || err}`)
  }

  const byFamily = new Map()
  for (const data of fonts) {
    const family = data.family || data.fullName || data.postscriptName
    if (!family) continue
    if (!byFamily.has(family)) byFamily.set(family, [])
    byFamily.get(family).push({
      postscriptName: data.postscriptName,
      fullName: data.fullName || data.postscriptName,
      style: data.style || 'Regular',
      data,
    })
  }

  _cache = [...byFamily.entries()]
    .map(([family, faces]) => ({ family, faces: faces.sort(byStyleOrder) }))
    .sort((a, b) => a.family.localeCompare(b.family))

  return _cache
}

/**
 * Sort a family's faces so the one a user most likely wants is first.
 * Regular before Bold before everything else, uprights before italics.
 */
function byStyleOrder(a, b) {
  const rank = (s) => {
    const style = String(s.style).toLowerCase()
    const italic = /italic|oblique/.test(style) ? 1 : 0
    // Rank on the weight alone, with the slant stripped, so the italics repeat
    // the upright order rather than sorting alphabetically among themselves —
    // "Italic, Bold Italic", not "Bold Italic, Italic".
    const weight = style.replace(/italic|oblique/g, '').trim()
    let w = 5
    if (!weight || /^(regular|book|normal|roman)$/.test(weight)) w = 0
    else if (/^medium$/.test(weight)) w = 1
    else if (/^(semi ?bold|demi ?bold)$/.test(weight)) w = 2
    else if (/^bold$/.test(weight)) w = 3
    return italic * 10 + w
  }
  return rank(a) - rank(b) || a.fullName.localeCompare(b.fullName)
}

/**
 * Read the raw bytes of one installed face.
 * @param {{ data: FontData, fullName: string }} face — an entry from listLocalFontFamilies
 * @returns {Promise<{ buffer: ArrayBuffer, name: string }>}
 */
export async function readLocalFace(face) {
  try {
    const blob = await face.data.blob()
    return { buffer: await blob.arrayBuffer(), name: face.fullName }
  } catch (err) {
    // Some system faces (and anything the OS marks as protected) refuse to hand
    // over their bytes. Nothing to do but say so.
    throw new Error(`"${face.fullName}" can't be read from this computer (${err?.name || 'blocked'})`)
  }
}
