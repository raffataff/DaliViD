/**
 * DaliVid — imageRegistry.js
 * In-memory decode cache mapping an IMAGE_INPUT nodeId → its decoded image.
 *
 * The single source of truth for an image is the node's `params.imageSrc`
 * (a data URL), which is serialized with the project automatically. This module
 * only caches the decoded HTMLImageElement so the Renderer doesn't re-decode the
 * data URL every frame. When the src changes (user loads a new image, or a
 * project is loaded), the entry is rebuilt from the new src.
 */

const _images = new Map() // nodeId → { src, img, ready, width, height, uploadedSrc }

/**
 * Ensure the decoded image for a node matches `src`. Returns the cache entry.
 * Decoding is async — the entry's `ready` flag flips to true once loaded.
 * @param {string} nodeId
 * @param {string} src — data URL (or any image URL)
 * @returns {{ src, img, ready, width, height, uploadedSrc }|null}
 */
export function ensureNodeImage(nodeId, src) {
  if (!src) {
    _images.delete(nodeId)
    return null
  }
  const existing = _images.get(nodeId)
  if (existing && existing.src === src) return existing

  const entry = { src, img: new Image(), ready: false, width: 0, height: 0, uploadedSrc: null }
  entry.img.decoding = 'async'
  entry.img.onload = () => {
    entry.ready = true
    entry.width = entry.img.naturalWidth || entry.img.width || 1
    entry.height = entry.img.naturalHeight || entry.img.height || 1
  }
  entry.img.onerror = () => {
    entry.ready = false
    console.warn('[DaliVid] Failed to decode image for node', nodeId)
  }
  // crossOrigin only matters for remote URLs; harmless for data URLs.
  if (!src.startsWith('data:')) entry.img.crossOrigin = 'anonymous'
  entry.img.src = src
  _images.set(nodeId, entry)
  return entry
}

/** Get the cache entry for a node, or undefined. */
export function getNodeImage(nodeId) {
  return _images.get(nodeId)
}

/**
 * Drop the cached decoded image for a node (e.g. when the node is deleted).
 * GPU resources (the `__img_<id>` FBO + `img_<id>` texture) are freed separately
 * by the Renderer via the `nodeLifecycle` removal hook.
 */
export function removeNodeImage(nodeId) {
  _images.delete(nodeId)
}

/** Clear all cached images (e.g. on project close). */
export function clearNodeImages() {
  _images.clear()
}
