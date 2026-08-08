/**
 * DaliVid — transitionStatus.js
 * Tiny subscribable registry of "is this clip edge's transition actually
 * running?", written by the Renderer and read by the Inspector / Node Editor.
 *
 * Why a registry and not Zustand: the answer is only knowable inside the render
 * loop (it depends on a shader compiling, a graph resolving an output FBO, a
 * region existing at this instant), and a store write from there would
 * re-render the whole app every frame. This is the same pattern as
 * cameraRegistry / imageRegistry / alphaRegistry — a peer, not a new idea.
 *
 * Keyed by the clip EDGE (transitionGraphKey(clipId, edge)) rather than by
 * transition type, because that is the thing the UI has in hand: the Inspector
 * section and the Node Editor header both know which clip edge they are looking
 * at, and neither should have to care whether it is backed by a built-in
 * shader, a library compound or a private node graph.
 *
 * Entries are replaced only when the status actually CHANGES, so the object
 * identity is stable frame to frame and useSyncExternalStore does not tear or
 * loop.
 */

import { GRAPH_KEY_SEP } from '../utils/clipTransitions.js'

/** @typedef {{ ok: boolean, reason: string, message: string }} TransitionStatus */

// key → frozen status object
const statuses = new Map()
const listeners = new Set()

function emit() {
  for (const fn of listeners) fn()
}

/**
 * Record a status, but only notify when something changed. The renderer calls
 * this every frame a transition composites, so the equality check is what keeps
 * it free.
 * @param {string} key — transitionGraphKey(clipId, edge)
 * @param {boolean} ok
 * @param {string} [reason] — machine-readable tag ('empty' | 'compile' | 'no-output' | …)
 * @param {string} [message] — human sentence for the UI
 */
export function setTransitionStatus(key, ok, reason = '', message = '') {
  if (!key) return
  const prev = statuses.get(key)
  if (prev && prev.ok === ok && prev.reason === reason && prev.message === message) return
  statuses.set(key, Object.freeze({ ok, reason, message }))
  emit()
}

/** Forget an edge's status (clip deleted, transition removed, project loaded). */
export function clearTransitionStatus(key) {
  if (!statuses.delete(key)) return
  emit()
}

/** Forget every status whose key starts with `clipId` — both of a clip's edges. */
export function clearClipTransitionStatus(clipId) {
  let changed = false
  for (const key of [...statuses.keys()]) {
    if (key.startsWith(`${clipId}${GRAPH_KEY_SEP}`)) { statuses.delete(key); changed = true }
  }
  if (changed) emit()
}

/** Drop everything (project load). */
export function resetTransitionStatus() {
  if (statuses.size === 0) return
  statuses.clear()
  emit()
}

/**
 * @param {string} key
 * @returns {TransitionStatus|null} — null means "hasn't run yet", which is NOT
 *   the same as a failure: an edge whose playhead has never entered its region
 *   has simply never been evaluated.
 */
export function getTransitionStatus(key) {
  return statuses.get(key) || null
}

/** useSyncExternalStore subscribe. */
export function subscribeTransitionStatus(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
