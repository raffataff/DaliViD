/**
 * DaliVid — imageProcessing.js
 * Import-time image normalization for IMAGE_INPUT sources.
 *
 * Images are embedded in the project as data URLs (node.params.imageSrc), which
 * the serializer saves and autosave re-writes frequently. A raw phone photo can
 * be 10–20 MB, so we downscale to a sane edge and re-encode (WebP → JPEG/PNG
 * fallback) on import. This keeps project files and autosaves small without
 * affecting the visual result for processed/displaced sources.
 *
 * 2048 px is also the WebGL2-guaranteed minimum MAX_TEXTURE_SIZE, so a capped
 * image uploads safely on any GPU. (The renderer additionally clamps to the real
 * GL limit for images that bypass this path — e.g. loaded from an old project.)
 */

export const DEFAULT_MAX_EDGE = 2048

/**
 * Load a File (or existing data URL) and return a downscaled, re-encoded data URL.
 * @param {File|string} input — an image File, or a data: URL string
 * @param {{ maxEdge?: number, quality?: number }} [opts]
 * @returns {Promise<{ dataUrl: string, width: number, height: number }>}
 */
export async function prepareImageDataURL(input, { maxEdge = DEFAULT_MAX_EDGE, quality = 0.9 } = {}) {
  const { img, revoke, mime } = await loadImage(input)
  try {
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) throw new Error('Image has no dimensions')

    const scale = Math.min(1, maxEdge / Math.max(w, h))
    const tw = Math.max(1, Math.round(w * scale))
    const th = Math.max(1, Math.round(h * scale))

    const canvas = document.createElement('canvas')
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, tw, th)

    // Preserve alpha for formats that can carry it; flatten others to JPEG.
    const hasAlpha = /png|webp|gif|svg/i.test(mime || '')
    const dataUrl = encode(canvas, hasAlpha, quality)
    return { dataUrl, width: tw, height: th }
  } finally {
    revoke?.()
  }
}

/** Human-readable byte size (e.g. "14.2 MB"). */
export function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Approximate the decoded byte size of a data URL (for display). */
export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  // 4 base64 chars → 3 bytes, minus padding.
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(b64.length * 3 / 4) - padding)
}

/** Prefer WebP (small + alpha); fall back to PNG (alpha) or JPEG (opaque). */
function encode(canvas, hasAlpha, quality) {
  const webp = canvas.toDataURL('image/webp', quality)
  if (webp.startsWith('data:image/webp')) return webp
  return hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality)
}

/** Load an image from a File or data URL into an HTMLImageElement. */
function loadImage(input) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let revoke = null
    let mime = ''
    if (typeof input === 'string') {
      mime = (input.match(/^data:([^;]+)/) || [])[1] || ''
      img.src = input
    } else {
      mime = input.type || ''
      const url = URL.createObjectURL(input)
      revoke = () => URL.revokeObjectURL(url)
      img.src = url
    }
    img.onload = () => resolve({ img, revoke, mime })
    img.onerror = () => { revoke?.(); reject(new Error('Failed to load image')) }
  })
}
