/**
 * DaliVid — historyRing.js
 * Pure slot arithmetic for a multi-frame history ring. No GL, no state: the
 * FEEDBACK_MACHINE node's delay is a ring of N+1 framebuffers, and this is the
 * index maths that decides which one is read and which is written each frame.
 */

/**
 * Slot arithmetic for a delay ring of `count` buffers.
 * read  — written `count - 1` ticks ago (the delayed frame)
 * write — the oldest slot, safe to overwrite this tick
 * last  — the most recently written slot
 */
export function ringSlots(tick, count) {
  const c = Math.max(2, count | 0)
  const t = ((tick % c) + c) % c
  return {
    read: (t + 1) % c,
    write: t,
    last: (t + c - 1) % c,
  }
}

/** Number of ring slots for a delay of `delayFrames`, capped by a byte budget. */
export function ringCount(delayFrames, width, height, bytesPerPixel = 8, budgetBytes = 512 * 1024 * 1024) {
  const delay = Math.max(1, Math.min(30, Math.round(Number(delayFrames) || 1)))
  const perFrame = Math.max(1, width * height * bytesPerPixel)
  const maxSlots = Math.max(2, Math.floor(budgetBytes / perFrame))
  return Math.min(delay + 1, maxSlots)
}
