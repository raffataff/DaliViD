/**
 * DaliVid — googleFonts.js
 * Fetch a family from Google Fonts by name, once, and keep it.
 *
 * ── Read this before extending it ──
 * This project deliberately removed its Google Fonts `@import` (see the note in
 * main.jsx): a third-party origin in the render path is a blocking round trip,
 * an IP-address leak to Google on every visit, and something the production CSP
 * refuses. None of that is reintroduced here, and it must not be:
 *
 *   • Nothing is fetched at load. A request happens only when the user types a
 *     family name and presses the button.
 *   • Nothing is ever loaded BY URL. The woff2 is fetched as bytes and handed to
 *     the same FontFace ingest path as an uploaded file, so `font-src` stays
 *     'self' data: and the stylesheet never enters the render path.
 *   • The bytes are then stored in the project. After the first fetch the family
 *     is a local asset: it works offline, exports deterministically, and travels
 *     to other machines. Google is touched once per font, ever — not once per
 *     visit.
 *
 * The cost is two origins on `connect-src` in vite.config.js. That is a real
 * widening of a deliberately tight policy; if you want it gone, delete this
 * module, its two buttons, and that CSP entry.
 */

import { addFontBuffer, MAX_FONT_BYTES } from './fontRegistry.js'

const CSS_ENDPOINT = 'https://fonts.googleapis.com/css2'

/**
 * A starting point for the search box. Not a catalogue — Google publishes over a
 * thousand families and any of them can be typed in by name. These are simply
 * the ones people ask for, offered so the box isn't a blank prompt.
 */
export const POPULAR_GOOGLE_FONTS = [
  'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Nunito', 'Raleway', 'Rubik',
  'Work Sans', 'Barlow', 'Karla', 'Quicksand', 'Josefin Sans', 'Cabin',
  'Merriweather', 'Libre Baskerville', 'Cormorant Garamond', 'EB Garamond',
  'Bitter', 'Zilla Slab', 'Abril Fatface', 'Lobster', 'Righteous',
  'Fjalla One', 'Titan One', 'Bungee', 'Monoton', 'Orbitron', 'Audiowide',
  'Pacifico', 'Dancing Script', 'Satisfy', 'Shadows Into Light',
  'Press Start 2P', 'VT323', 'Space Mono', 'Fira Code', 'Courier Prime',
]

/**
 * Build the CSS request URL. The axis range is requested optimistically: a
 * variable family answers with one file covering 100–900, and a static family
 * answers 400 with the range quietly ignored.
 */
function cssUrl(family, withAxis) {
  const name = family.trim().replace(/\s+/g, '+')
  const spec = withAxis ? `${name}:wght@100..900` : name
  return `${CSS_ENDPOINT}?family=${spec}&display=swap`
}

/**
 * Pull the woff2 URL and weight range out of a Google Fonts stylesheet.
 *
 * Google returns one @font-face per unicode subset, all pointing at different
 * files. We want the Latin one: taking the first block would land on Cyrillic or
 * Greek for many families and produce a font with no English glyphs at all.
 *
 * Exported for testing — the parse is the part with edge cases, and it should be
 * checkable without a network round trip.
 *
 * @param {string} css
 * @returns {{ url: string, weights: [number, number], variable: boolean } | null}
 */
export function parseGoogleFontCss(css) {
  const blocks = String(css).split('@font-face').slice(1)
  if (!blocks.length) return null

  let best = null
  for (const block of blocks) {
    const url = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/)?.[1]
    if (!url) continue

    const range = block.match(/unicode-range:\s*([^;]+);/)?.[1] || ''
    // Google's latin subset is the only one whose range opens with U+0000-00FF
    // (latin-ext starts at U+0100, cyrillic at U+0301, greek at U+0370). A block
    // with no unicode-range at all covers everything, so it qualifies too.
    const isLatin = !range.trim() || /u\+0{1,4}-0{0,2}ff\b/i.test(range.replace(/\s/g, ''))

    const weightDecl = block.match(/font-weight:\s*([\d\s.]+);/)?.[1]?.trim() || '400'
    const nums = weightDecl.split(/\s+/).map(Number).filter(n => Number.isFinite(n) && n > 0)
    const weights = nums.length >= 2 ? [nums[0], nums[1]] : [nums[0] || 400, nums[0] || 400]

    const isItalic = /font-style:\s*italic/i.test(block)
    const candidate = { url, weights, variable: nums.length >= 2, isLatin, isItalic }

    // Prefer latin + upright. Keep the first acceptable one rather than the last
    // so a family whose latin block comes early isn't overwritten by a later
    // subset that also passes the loose range test.
    if (candidate.isLatin && !candidate.isItalic) return strip(candidate)
    if (!best) best = candidate
  }
  return best ? strip(best) : null
}

const strip = ({ url, weights, variable }) => ({ url, weights, variable })

/**
 * Fetch a family from Google Fonts and add it to the project as a normal
 * embedded font.
 *
 * @param {string} family — e.g. "Lobster", "Work Sans"
 * @returns {Promise<object>} the font descriptor
 * @throws {Error} with a message fit to show the user
 */
export async function addGoogleFont(family, { fetchImpl = fetch } = {}) {
  const name = String(family || '').trim()
  if (!name) throw new Error('Type a font family name first')

  // Try the variable-axis request, then plain. A static family rejects the axis
  // spec with a 400, which is information, not a failure.
  let css = null
  for (const withAxis of [true, false]) {
    let res
    try {
      res = await fetchImpl(cssUrl(name, withAxis))
    } catch {
      throw new Error(`Couldn't reach Google Fonts. Check your connection, or add the font from a file instead.`)
    }
    if (res.ok) { css = await res.text(); break }
    if (res.status !== 400) break
  }
  if (!css) throw new Error(`Google Fonts has no family called "${name}" — check the spelling`)

  const parsed = parseGoogleFontCss(css)
  if (!parsed) throw new Error(`Google Fonts returned nothing usable for "${name}"`)

  let buffer
  try {
    const res = await fetchImpl(parsed.url)
    if (!res.ok) throw new Error(String(res.status))
    buffer = await res.arrayBuffer()
  } catch {
    throw new Error(`Couldn't download "${name}" from Google Fonts`)
  }
  if (buffer.byteLength > MAX_FONT_BYTES) throw new Error(`"${name}" is unexpectedly large — not adding it`)

  // A woff2 is compressed, so its tables can't be introspected; the stylesheet's
  // own font-weight declaration is the only honest source for the range.
  return addFontBuffer(buffer, {
    name,
    weights: parsed.weights,
    variable: parsed.variable,
    source: 'google',
  })
}
