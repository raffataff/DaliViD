/**
 * DaliVid — TransitionGraphBar
 * The header strip shown while a clip edge's private transition graph is open.
 *
 * It exists because a transition graph was, in practice, un-previewable. The
 * graph only composites while the playhead sits inside its region, and a region
 * is typically well under a second — a handful of pixels of timeline at normal
 * zoom. The old header said "Scrub the transition region to preview", which was
 * accurate and nearly impossible to act on. `TRANSITION_PROGRESS`'s own Preview
 * / auto-preview params can't help either: `resolveTransitionProgress` gives the
 * live region progress priority whenever the renderer supplies one, and the
 * renderer only runs the graph when it does — so inside a real clip transition
 * those params are unreachable by construction.
 *
 * So this drives the PLAYHEAD rather than introducing a second, competing notion
 * of progress. One source of truth: what you scrub here is exactly what renders,
 * exports and plays, and the timeline stays in sync because it is the same
 * number.
 *
 * It also states what the graph itself cannot: which real footage is bound to
 * FROM and which to TO for this edge. That answer is different for a head and a
 * tail, and it's the single most confusing thing about authoring a transition
 * out to nothing.
 */

import { useCallback } from 'react'
import useTimelineStore from '../../store/useTimelineStore'
import useAppStore from '../../store/useAppStore'
import {
  EDGE_TAIL, edgeRegion, regionProgress, ensureEdgeRegionPatch,
} from '../../utils/clipTransitions'
import TransitionStatusNote from '../common/TransitionStatusNote'
import './TransitionGraphBar.css'

export default function TransitionGraphBar({ clipId, edge, graphKey }) {
  const clips = useTimelineStore(s => s.clips)
  const updateClip = useTimelineStore(s => s.updateClip)
  const playheadTime = useAppStore(s => s.playheadTime)
  const setPlayheadTime = useAppStore(s => s.setPlayheadTime)

  const clip = clips.find(c => c.id === clipId) || null
  const region = clip ? edgeRegion(clip, clips, edge) : null

  // regionProgress is half-open — null at region.end — so a scrub to 1.0 would
  // land one frame past the window and stop the transition compositing at all.
  // Nudging the top of the range inside keeps "fully arrived" reachable.
  const scrubTo = useCallback((p) => {
    if (!region) return
    setPlayheadTime(region.start + region.dur * Math.min(Math.max(p, 0), 0.999))
  }, [region, setPlayheadTime])

  const createWindow = useCallback(() => {
    if (!clip) return
    const patch = ensureEdgeRegionPatch(clip, edge, null)
    if (!patch) return
    updateClip(clip.id, patch)
    // Land inside the window we just made, so the graph starts previewing
    // immediately instead of waiting for the user to guess where it went.
    const dur = patch.fadeOut ?? patch.fadeIn ?? 0
    setPlayheadTime(edge === EDGE_TAIL
      ? Math.max(clip.timelineStart, clip.timelineEnd - dur) + dur * 0.5
      : clip.timelineStart + dur * 0.5)
  }, [clip, edge, updateClip, setPlayheadTime])

  if (!clip) return null

  const progress = region ? regionProgress(region, playheadTime) : null
  const inWindow = progress != null

  // What the two image terminals are actually bound to this frame. Head and
  // tail swap the sides (see Renderer._compositeEdgeTransition), which is the
  // fact the node names alone can't convey.
  const fromLabel = edge === EDGE_TAIL
    ? `this clip (${clip.filename || 'clip'})`
    : (region?.mode === 'crossfade' ? `“${region.prev.filename}”` : 'what’s behind (lower tracks, else black)')
  const toLabel = edge === EDGE_TAIL
    ? 'what’s behind (lower tracks, else black)'
    : `this clip (${clip.filename || 'clip'})`

  return (
    <div className="tr-bar">
      {!region ? (
        <div className="tr-bar__row">
          <span className="tr-bar__warn">
            This edge has no window, so the graph never runs.
          </span>
          <button className="tr-bar__btn tr-bar__btn--primary" onClick={createWindow}>
            Create 1s window
          </button>
        </div>
      ) : (
        <>
          <div className="tr-bar__row">
            <span className="tr-bar__label">Progress</span>
            <input
              className="tr-bar__scrub"
              type="range" min={0} max={1} step={0.001}
              value={progress ?? 0}
              onChange={(e) => scrubTo(parseFloat(e.target.value))}
              title="Scrubs the playhead across this transition — what you see is exactly what renders"
            />
            <span className="tr-bar__value mono">{((progress ?? 0) * 100).toFixed(0)}%</span>
            {!inWindow && (
              <button className="tr-bar__btn" onClick={() => scrubTo(0.5)} title="The playhead is outside this transition, so nothing is compositing">
                Jump in
              </button>
            )}
          </div>
          <div className="tr-bar__row tr-bar__row--meta">
            <span className="tr-bar__io"><b>FROM</b> {fromLabel}</span>
            <span className="tr-bar__io"><b>TO</b> {toLabel}</span>
            <span className="tr-bar__dur mono">{region.dur.toFixed(2)}s</span>
          </div>
          {/* Nodes are added unconnected, so the one thing worth stating is what
              a working graph needs: something reaching OUTPUT, and Progress
              wired to whatever should ramp. */}
          <div className="tr-bar__row tr-bar__row--meta">
            <span className="tr-bar__tip">
              Wire an effect into <b>OUTPUT</b>, and <b>Transition Progress</b> into whichever
              param should ramp across the cut. Stack <b>Transition FX</b> nodes to combine effects.
            </span>
          </div>
        </>
      )}
      <TransitionStatusNote graphKey={graphKey} compact />
    </div>
  )
}
