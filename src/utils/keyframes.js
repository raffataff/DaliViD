/**
 * DaliViD — keyframes.js
 * Keyframe evaluation: turns the timeline store's keyframe tracks into
 * per-frame param overrides for the graph executor.
 *
 * Track shape (useTimelineStore.keyframes):
 *   { clipId, nodeId, paramName, keys: [{ time, value, easing }] }
 *
 * Conventions:
 *   - clipId is a real clip id for clip-graph params, or 'master' for the
 *     master graph.
 *   - Key times are CLIP-RELATIVE seconds for clips (so keys survive the clip
 *     being moved on the timeline) and absolute timeline seconds for 'master'.
 *   - Before the first key → first key's value; after the last → last key's
 *     value (standard NLE hold behaviour).
 */

// Easing functions applied to the 0..1 segment progress between two keys.
// The segment's LEFT key's easing governs the segment (like CSS transitions).
const EASING = {
  linear: (t) => t,
  step: () => 0, // hold the left key's value until the next key
  'ease-in': (t) => t * t,
  'ease-out': (t) => t * (2 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
}

/**
 * Evaluate one keyframe track at `time`. Returns the interpolated value.
 */
export function evaluateTrack(keys, time) {
  if (!keys || keys.length === 0) return undefined
  if (time <= keys[0].time) return keys[0].value
  const last = keys[keys.length - 1]
  if (time >= last.time) return last.value

  // Binary search for the segment containing `time`.
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keys[mid].time <= time) lo = mid
    else hi = mid
  }
  const a = keys[lo]
  const b = keys[hi]
  const span = b.time - a.time
  if (span <= 1e-9) return b.value
  const t = (time - a.time) / span
  const ease = EASING[a.easing] || EASING.linear
  // step easing means "hold a.value" — mix with eased t handles all cases.
  const k = a.easing === 'step' ? 0 : ease(t)
  return a.value + (b.value - a.value) * k
}

/**
 * Evaluate every keyframe track belonging to `clipId` at `time`.
 * @returns {{ [nodeId]: { [paramName]: value } } | null} null when no tracks match.
 */
export function evaluateKeyframes(keyframes, clipId, time) {
  if (!keyframes || keyframes.length === 0) return null
  let out = null
  for (const track of keyframes) {
    if (track.clipId !== clipId) continue
    const v = evaluateTrack(track.keys, time)
    if (v === undefined) continue
    if (!out) out = {}
    if (!out[track.nodeId]) out[track.nodeId] = {}
    out[track.nodeId][track.paramName] = v
  }
  return out
}

/**
 * Is there a key on this track at (or within `tolerance` of) `time`?
 * Returns the key or undefined.
 */
export function keyAtTime(keys, time, tolerance = 1 / 30) {
  if (!keys) return undefined
  return keys.find(k => Math.abs(k.time - time) <= tolerance)
}
