/**
 * DaliVid — TransitionStatusNote
 * Shows why a clip edge's transition isn't playing, in the two places the user
 * would be looking when they notice: the Inspector's edge section and the Node
 * Editor header.
 *
 * Before this, every failure path in the renderer was a console.warn followed by
 * a silent fallback to a hard cut — so a transition that had failed to compile,
 * had no OUTPUT terminal, or pointed at a deleted library entry looked exactly
 * like a transition that was working normally but subtle. This subscribes to the
 * renderer's transitionStatus registry rather than to a store, because the
 * answer is only knowable inside the render loop and a per-frame store write
 * would re-render the app (same reasoning as the alpha-detection readout).
 */

import { useSyncExternalStore, useCallback } from 'react'
import { getTransitionStatus, subscribeTransitionStatus } from '../../gl/transitionStatus'
import './TransitionStatusNote.css'

/**
 * @param {string} graphKey — transitionGraphKey(clipId, edge)
 * @param {boolean} [compact] — single-line variant for the Node Editor header
 */
export default function TransitionStatusNote({ graphKey, compact = false }) {
  const getSnapshot = useCallback(() => getTransitionStatus(graphKey), [graphKey])
  const status = useSyncExternalStore(subscribeTransitionStatus, getSnapshot, getSnapshot)

  // null = "has never been evaluated", which is NOT a failure: the playhead has
  // simply never been inside this region. Saying anything here would be wrong.
  if (!status || status.ok) return null

  if (compact) {
    return (
      <span className="transition-status transition-status--compact" title={status.message}>
        ⚠ {status.message}
      </span>
    )
  }

  return (
    <div className="transition-status" role="status">
      <span className="transition-status__icon" aria-hidden="true">⚠</span>
      <span>{status.message}</span>
    </div>
  )
}
