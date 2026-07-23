/**
 * DaliVid — textRegistry.js
 * In-memory raster cache mapping a TEXT source id (TEXT_INPUT nodeId OR a text
 * clip id) → its rasterized text canvas.
 *
 * The single source of truth for text is the node/clip `params` (text + style),
 * which the serializer saves automatically. This module only caches the drawn
 * canvas so the Renderer doesn't re-rasterize every frame. The entry re-renders
 * whenever the raster signature changes (a style/text edit, or a resolution
 * change from preview → export), not when per-frame shader transforms change.
 *
 * Peer to imageRegistry.js.
 */

import { renderTextToCanvas, textSignature } from '../utils/textRenderer.js'

const _texts = new Map() // id → { canvas, signature, uploadedSignature }

/**
 * Ensure the cached raster for `id` matches its params at width×height.
 * Re-rasterizes only when the signature changes. Returns the cache entry.
 * @returns {{ canvas: HTMLCanvasElement, signature: string, uploadedSignature: string|null }}
 */
export function ensureText(id, params, width, height) {
  const signature = textSignature(params, width, height)
  let entry = _texts.get(id)
  if (entry && entry.signature === signature) return entry

  if (!entry) {
    entry = { canvas: document.createElement('canvas'), signature: '', uploadedSignature: null }
    _texts.set(id, entry)
  }
  renderTextToCanvas(entry.canvas, params, width, height)
  entry.signature = signature
  // Force the Renderer to re-upload the texture (pixels changed).
  entry.uploadedSignature = null
  return entry
}

/** Get the cache entry for an id, or undefined. */
export function getText(id) {
  return _texts.get(id)
}

/** Drop the cached raster for an id (e.g. when the node/clip is deleted). */
export function removeText(id) {
  _texts.delete(id)
}

/** Clear all cached rasters (e.g. on project close). */
export function clearTexts() {
  _texts.clear()
}
