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
 */

export const TEXT_REFERENCE_HEIGHT = 1080

// Font stacks offered in the UI (label → CSS font-family).
export const TEXT_FONTS = [
  { label: 'Sans', value: 'Inter, system-ui, Arial, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', value: '"Courier New", ui-monospace, monospace' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, sans-serif' },
  { label: 'Display', value: '"Arial Black", Gadget, sans-serif' },
]

// Defaults merged in when a text clip / node is created. Shader-uniform params
// (u_txt_scale, u_offset_x, …) come from the TEXT_INPUT shader's @param defaults
// and are intentionally NOT duplicated here.
export const DEFAULT_TEXT_PARAMS = {
  text: 'Text',
  fontFamily: TEXT_FONTS[0].value,
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

/** Stable cache key for a given text raster at a given output size. */
export function textSignature(params, width, height) {
  const p = params || {}
  const parts = [width, height]
  for (const k of CANVAS_KEYS) parts.push(k + '=' + (p[k] ?? DEFAULT_TEXT_PARAMS[k]))
  return parts.join('|')
}

/** Measure a run of text including manual letter spacing. */
function measureRun(ctx, str, letterSpacing) {
  if (!letterSpacing) return ctx.measureText(str).width
  let w = 0
  for (const ch of str) w += ctx.measureText(ch).width + letterSpacing
  return Math.max(0, w - letterSpacing)
}

/** Word-wrap `text` (respecting explicit newlines) to `maxWidth`. */
function wrapLines(ctx, text, maxWidth, letterSpacing) {
  const out = []
  for (const rawLine of String(text).split('\n')) {
    const words = rawLine.split(/(\s+)/) // keep whitespace tokens for spacing
    let cur = ''
    for (const token of words) {
      const trial = cur + token
      if (measureRun(ctx, trial, letterSpacing) > maxWidth && cur.trim() !== '') {
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

/** Draw one line's glyphs starting at (x, baselineY), honoring letter spacing. */
function drawRun(ctx, str, x, y, letterSpacing, doStroke, doFill) {
  if (!letterSpacing) {
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

  const s = canvas.height / TEXT_REFERENCE_HEIGHT
  const fontPx = Math.max(1, p.fontSize * s)
  const letterSpacing = (p.letterSpacing || 0) * s
  const italic = p.italic ? 'italic ' : ''
  ctx.font = `${italic}${p.fontWeight || '400'} ${fontPx}px ${p.fontFamily}`
  ctx.textAlign = 'left'          // alignment handled manually (letter spacing + wrap)
  ctx.textBaseline = 'alphabetic'

  const maxWidth = Math.max(1, clamp01(p.maxWidth) * canvas.width)
  const lines = wrapLines(ctx, p.text ?? '', maxWidth, letterSpacing)
  const lineH = fontPx * (p.lineHeight || 1.2)
  const blockH = lines.length * lineH

  let widest = 0
  const lineWidths = lines.map((ln) => {
    const w = measureRun(ctx, ln, letterSpacing)
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
    const y = top + i * lineH + fontPx * 0.8 // approx ascent baseline

    // Stroke first (under the fill) so the outline doesn't eat the glyph.
    if (doStroke) drawRun(ctx, lines[i], x, y, letterSpacing, true, false)
    drawRun(ctx, lines[i], x, y, letterSpacing, false, true)
  }

  return canvas
}
