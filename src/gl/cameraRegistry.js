/**
 * DaliVid — cameraRegistry.js
 * In-memory registry mapping a timeline clipId → its live stream (camera OR
 * screen capture) MediaStream.
 *
 * Live-source clips are backed by a getUserMedia / getDisplayMedia MediaStream
 * rather than a file URL, and a MediaStream can't be serialized into the
 * timeline/clip state. This tiny module lets the capture UI (MediaPool) hand a
 * stream to the Renderer, which reads it back by clipId each frame to upload
 * frames to a texture. (Exports keep the `Camera` name — screen streams reuse
 * them unchanged.)
 */

const _streams = new Map() // clipId → MediaStream

/** Register (or replace) the live stream for a camera clip. */
export function setCameraStream(clipId, stream) {
  const existing = _streams.get(clipId)
  if (existing && existing !== stream) {
    existing.getTracks().forEach(t => t.stop())
  }
  _streams.set(clipId, stream)
}

/** Get the live stream for a camera clip, or undefined if none. */
export function getCameraStream(clipId) {
  return _streams.get(clipId)
}

/** Stop and remove the stream for a camera clip. */
export function removeCameraStream(clipId) {
  const stream = _streams.get(clipId)
  if (stream) {
    stream.getTracks().forEach(t => t.stop())
    _streams.delete(clipId)
  }
}

/** Stop and remove all camera streams (e.g., on project close). */
export function clearCameraStreams() {
  for (const stream of _streams.values()) {
    stream.getTracks().forEach(t => t.stop())
  }
  _streams.clear()
}
