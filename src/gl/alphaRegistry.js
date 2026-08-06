/**
 * DaliVid — alphaRegistry.js
 * In-memory registry mapping a media source key → the alpha interpretation the
 * Renderer's GPU probe detected for it (see `utils/alphaModes`).
 *
 * Same shape as `cameraRegistry` / `imageRegistry`: detection is a *render-time*
 * fact about the decoded pixels, so it has no business in the serialized project
 * or in a Zustand store (it would be a store write from inside the render loop,
 * i.e. a re-render every frame). The Inspector subscribes instead, so the
 * "Detected: …" readout updates the moment the probe settles and stays silent
 * the rest of the time.
 *
 * Keys are `alphaSourceKey(clip)` — the filename — so every split, duplicate and
 * re-import of one file shares a single detection.
 */

const _detected = new Map() // sourceKey → 'ignore' | 'straight' | 'premultiplied'
const _listeners = new Set()

/** Record a detection and notify subscribers (no-op when unchanged). */
export function setDetectedAlpha(key, mode) {
  if (!key || _detected.get(key) === mode) return
  _detected.set(key, mode)
  for (const cb of _listeners) {
    try { cb(key, mode) } catch (e) { console.warn('[alphaRegistry] listener failed:', e) }
  }
}

/** The detected mode for a source key, or null if it hasn't been probed yet. */
export function getDetectedAlpha(key) {
  if (!key) return null
  return _detected.get(key) ?? null
}

/**
 * Subscribe to detections. Returns an unsubscribe function.
 * The callback receives `(key, mode)`.
 */
export function onAlphaDetected(cb) {
  _listeners.add(cb)
  return () => _listeners.delete(cb)
}

/** Forget every detection (project close / new project). */
export function clearDetectedAlpha() {
  if (_detected.size === 0) return
  _detected.clear()
  for (const cb of _listeners) {
    try { cb(null, null) } catch { /* ignore */ }
  }
}
