/**
 * DaliVid — textRenderer.js
 * Canvas-2D text rasterizer shared by the TEXT timeline clip and the TEXT_INPUT
 * node. Given a text/style param bag and an output resolution, it draws the text
 * (wrapped, aligned, with optional box / stroke / shadow) into a canvas that the
 * Renderer uploads as a texture.
 *
 * Sizing is resolution-independent: every px-based param (font size, padding,
 * stroke, shadow, letter spacing) is authored against a 1080-tall reference and
 * scaled by (height / 1080). So a title looks identical in the preview and in a
 * higher-resolution export — the raster just gets sharper.
 *
 * Only the fields that actually change the pixels live in CANVAS_KEYS, so the
 * signature (cache key) is stable across per-frame shader-side transforms
 * (u_txt_scale / audio reactivity), which are applied later in the TEXT shader.
 *
 * The typeface itself comes from fontRegistry: `params.fontFamily` holds a font
 * *id*, not a CSS stack, and the registry resolves it (tolerating the legacy CSS
 * stacks older projects saved). The signature folds in that font's load state so
 * a raster drawn before a webfont arrived is replaced rather than cached.
 */

import { fontStack, fontStateToken, clampWeight, requestFont } from './fontRegistry.js'

export const TEXT_REFERENCE_HEIGHT = 1080

// Defaults merged in when a text clip / node is created. Shader-uniform params
// (u_txt_scale, u_offset_x, …) come from the TEXT_INPUT shader's @param defaults
// and are intentionally NOT duplicated here.
export const DEFAULT_TEXT_PARAMS = {
  text: 'Text',
  fontFamily: 'inter',   // fontRegistry id — see resolveFont for legacy values
  fontSize: 96,          // px @ 1080-tall reference
  fontWeight: '700',
  italic: false,
  color: '#ffffff',
  align: 'center',       // 'left' | 'center' | 'right'
  lineHeight: 1.2,
  letterSpacing: 0,      // px @ reference
  posX: 0.5,             // 0..1 anchor within the frame
  posY: 0.5,
  maxWidth: 0.85,        // wrap width as a fraction of frame width
  bgColor: '#000000',
  bgOpacity: 0,          // 0 = no background box
  padding: 18,           // box padding, px @ reference
  strokeColor: '#000000',
  strokeWidth: 0,        // outline width, px @ reference (0 = none)
  shadowColor: '#000000',
  shadowBlur: 0,         // px @ reference
  shadowX: 0,
  shadowY: 0,
}

// The only params that affect the raster — used for the cache signature so
// per-frame shader transforms / audio don't force a re-raster.
const CANVAS_KEYS = Object.keys(DEFAULT_TEXT_PARAMS)

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/**
 * Stable cache key for a given text raster at a given output size.
 *
 * `fontStateToken` is what makes the cache correct across an async font load:
 * a raster drawn while the face was still downloading gets a different key from
 * the one drawn after it landed, so the fallback-font version is superseded on
 * the next frame instead of living forever.
 */
export function textSignature(params, width, height) {
  const p = params || {}
  const parts = [width, height]
  for (const k of CANVAS_KEYS) parts.push(k + '=' + (p[k] ?? DEFAULT_TEXT_PARAMS[k]))
  parts.push('font=' + fontStateToken(p.fontFamily ?? DEFAULT_TEXT_PARAMS.fontFamily))
  return parts.join('|')
}

/**
 * Whether this canvas implementation supports native letter spacing, and
 * whether its measureText includes a trailing gap after the final glyph.
 *
 * Native spacing matters for quality, not just tidiness: the old approach drew
 * one glyph at a time, which defeats kerning and ligatures and costs a draw
 * call per character. Chrome's implementation follows CSS letter-spacing and
 * appends a gap after the last glyph too, which would bias every centred line
 * by half a space — so it is measured once here rather than assumed.
 */
let _spacingSupport = null
function spacingSupport(ctx) {
  if (_spacingSupport) return _spacingSupport
  if (!('letterSpacing' in ctx)) {
    _spacingSupport = { native: false, trailing: false }
    return _spacingSupport
  }
  const prevFont = ctx.font
  const prevSpacing = ctx.letterSpacing
  try {
    ctx.font = '100px sans-serif'
    ctx.letterSpacing = '0px'
    const plain = ctx.measureText('AA').width
    ctx.letterSpacing = '100px'
    const spaced = ctx.measureText('AA').width
    const added = spaced - plain
    // Two characters: 100px of extra advance means gaps go between glyphs only,
    // 200px means one is also appended after the last.
    _spacingSupport = { native: added > 50, trailing: added > 150 }
  } catch {
    _spacingSupport = { native: false, trailing: false }
  } finally {
    ctx.letterSpacing = prevSpacing ?? '0px'
    ctx.font = prevFont
  }
  return _spacingSupport
}

/**
 * Measure a run of text including letter spacing, excluding any trailing gap.
 * @param {CanvasRenderingContext2D} ctx — already configured with font + spacing
 */
function measureRun(ctx, str, letterSpacing, support) {
  if (!str) return 0
  if (!letterSpacing) return ctx.measureText(str).width
  if (support.native) {
    const w = ctx.measureText(str).width
    // Strip the gap the platform appends after the final glyph so a centred
    // line stays optically centred.
    return support.trailing ? Math.max(0, w - letterSpacing) : w
  }
  let w = 0
  for (const ch of str) w += ctx.measureText(ch).width + letterSpacing
  return Math.max(0, w - letterSpacing)
}

/** Word-wrap `text` (respecting explicit newlines) to `maxWidth`. */
function wrapLines(ctx, text, maxWidth, letterSpacing, support) {
  const out = []
  for (const rawLine of String(text).split('\n')) {
    const words = rawLine.split(/(\s+)/) // keep whitespace tokens for spacing
    let cur = ''
    for (const token of words) {
      const trial = cur + token
      if (measureRun(ctx, trial, letterSpacing, support) > maxWidth && cur.trim() !== '') {
        out.push(cur.replace(/\s+$/, ''))
        cur = token.replace(/^\s+/, '')
      } else {
        cur = trial
      }
    }
    out.push(cur.replace(/\s+$/, ''))
  }
  return out.length ? out : ['']
}

/**
 * Draw one line's glyphs starting at (x, baselineY).
 *
 * With native spacing this is a single fillText/strokeText, which keeps kerning
 * pairs and ligatures intact and costs one draw call instead of one per glyph.
 * The per-character path is only the fallback for a canvas without the feature.
 */
function drawRun(ctx, str, x, y, letterSpacing, doStroke, doFill, support) {
  if (!letterSpacing || support.native) {
    if (doStroke) ctx.strokeText(str, x, y)
    if (doFill) ctx.fillText(str, x, y)
    return
  }
  let cx = x
  for (const ch of str) {
    if (doStroke) ctx.strokeText(ch, cx, y)
    if (doFill) ctx.fillText(ch, cx, y)
    cx += ctx.measureText(ch).width + letterSpacing
  }
}

/**
 * Rasterize text into `canvas` at width×height. Background is transparent
 * except for the optional text box, so the result composites over lower layers.
 * @returns {HTMLCanvasElement} the same canvas
 */
export function renderTextToCanvas(canvas, params, width, height) {
  const p = { ...DEFAULT_TEXT_PARAMS, ...(params || {}) }
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Kick off the webfont fetch if this is the first time we've seen this family.
  // Fire-and-forget by design: this function runs inside the frame loop and must
  // stay synchronous, so the raster below may use a fallback face. The load
  // state is part of the cache signature, so the moment the real face lands this
  // entry is superseded and redrawn.
  requestFont(p.fontFamily, !!p.italic)

  const s = canvas.height / TEXT_REFERENCE_HEIGHT
  const fontPx = Math.max(1, p.fontSize * s)
  const letterSpacing = (p.letterSpacing || 0) * s
  const italic = p.italic ? 'italic ' : ''
  // Clamped to what the face actually ships: asking a 400-only display font for
  // 900 gets a smeared synthetic bold rather than a heavier cut.
  const weight = clampWeight(p.fontFamily, p.fontWeight || '400')

  ctx.font = `${italic}${weight} ${fontPx}px ${fontStack(p.fontFamily)}`
  ctx.textAlign = 'left'          // alignment handled manually (letter spacing + wrap)
  ctx.textBaseline = 'alphabetic'
  // Prefer true outline advances over hinted integer ones: the raster is
  // supersampled and then filtered by the GPU, so geometric precision scales
  // cleanly where hinting would quantise spacing at large sizes.
  if ('textRendering' in ctx) ctx.textRendering = 'geometricPrecision'

  const support = spacingSupport(ctx)
  if (support.native) ctx.letterSpacing = `${letterSpacing}px`

  const maxWidth = Math.max(1, clamp01(p.maxWidth) * canvas.width)
  const lines = wrapLines(ctx, p.text ?? '', maxWidth, letterSpacing, support)
  const lineH = fontPx * (p.lineHeight || 1.2)

  // Vertical placement from the font's own metrics rather than a fixed 0.8×em
  // guess. Ascent varies a lot between typefaces — a display face like Anton and
  // a text face like Source Serif sit at noticeably different heights — so the
  // guess made posY mean something slightly different for every font.
  const metrics = ctx.measureText('Hxg')
  const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontPx * 0.8
  const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontPx * 0.2
  const blockH = (lines.length - 1) * lineH + ascent + descent

  let widest = 0
  const lineWidths = lines.map((ln) => {
    const w = measureRun(ctx, ln, letterSpacing, support)
    if (w > widest) widest = w
    return w
  })

  const cx = p.posX * canvas.width
  const top = p.posY * canvas.height - blockH / 2

  // Background box behind the whole block.
  if ((p.bgOpacity || 0) > 0 && widest > 0) {
    const pad = (p.padding || 0) * s
    const boxW = widest + pad * 2
    const boxH = blockH + pad * 2
    ctx.save()
    ctx.globalAlpha = clamp01(p.bgOpacity)
    ctx.fillStyle = p.bgColor
    ctx.fillRect(cx - boxW / 2, top - pad, boxW, boxH)
    ctx.restore()
  }

  ctx.shadowColor = (p.shadowBlur > 0 || p.shadowX || p.shadowY) ? p.shadowColor : 'transparent'
  ctx.shadowBlur = Math.max(0, (p.shadowBlur || 0) * s)
  ctx.shadowOffsetX = (p.shadowX || 0) * s
  ctx.shadowOffsetY = (p.shadowY || 0) * s

  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  ctx.strokeStyle = p.strokeColor
  ctx.lineWidth = Math.max(0, (p.strokeWidth || 0) * s)
  ctx.fillStyle = p.color

  const doStroke = (p.strokeWidth || 0) > 0

  for (let i = 0; i < lines.length; i++) {
    const lineW = lineWidths[i]
    let x
    if (p.align === 'left') x = cx - widest / 2
    else if (p.align === 'right') x = cx + widest / 2 - lineW
    else x = cx - lineW / 2
    const y = top + ascent + i * lineH

    // Stroke first (under the fill) so the outline doesn't eat the glyph.
    if (doStroke) drawRun(ctx, lines[i], x, y, letterSpacing, true, false, support)
    drawRun(ctx, lines[i], x, y, letterSpacing, false, true, support)
  }

  // Leave the shared context clean — a stale letterSpacing would otherwise bleed
  // into whatever draws into this canvas next.
  if (support.native) ctx.letterSpacing = '0px'

  return canvas
}
