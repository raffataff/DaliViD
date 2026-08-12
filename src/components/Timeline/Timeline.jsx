import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useWaveform } from '../../utils/waveformCache'
import useTimelineStore from '../../store/useTimelineStore'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import { IconChevronDown, IconPlus, IconLock } from '../common/Icons'
import ContextMenu from '../common/ContextMenu'
import { makeImageClipParams, makeTextClipParams, makeShapeClipParams, DEFAULT_GENERATOR_DURATION } from '../../utils/generatorClips'
import {
  EDGE_HEAD, EDGE_TAIL, edgeLabel, getEdgeTransition, setEdgeTransitionPatch,
  findPrevOverlap, findNextOverlap, headRegion, tailRegion, edgeRegion,
  edgeHasEffect, edgeDisplaySeconds, nearestEdge, TRANSITION_DRAG_TYPE,
  transitionGraphKey, isGraphType, GRAPH_TYPE,
} from '../../utils/clipTransitions'
import {
  applyEdgeType, openEdgeGraphAction, applyTransitionById, transitionLabelOf,
  groupedTransitionCatalog,
} from '../../utils/transitionActions'
import { clearTransitionStatus } from '../../gl/transitionStatus'
import './Timeline.css'

// How close to a clip's start/end (in px) still counts as "that edge" for a
// right-click, when no wedge is drawn there. Matches the width of the ⇄ hotspot
// that appears on hover, so the visible affordance and the invisible hit zone
// are the same target.
const EDGE_HIT_PX = 22

// Ruler tick spacings, in seconds — a 1-2-5 ladder extended into minutes and
// hours. `pickRulerStep` returns the smallest that is at least `minPx` wide on
// screen, so both the tick and the label spacing stay in a readable band no
// matter how far in or out the timeline is zoomed.
const RULER_STEPS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800, 3600, 7200, 21600,
]
function pickRulerStep(pxPerSec, minPx) {
  return RULER_STEPS.find(s => s * pxPerSec >= minPx) ?? RULER_STEPS[RULER_STEPS.length - 1]
}

/**
 * Timeline panel — horizontal ruler, tracks, clips, playhead, zoom.
 * Wired to Zustand stores for real state.
 */
export default function Timeline({ collapsed, onToggleCollapse }) {
  const rulerRef = useRef(null)
  const tracksAreaRef = useRef(null)

  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)
  const addTrack = useTimelineStore(s => s.addTrack)
  const toggleMute = useTimelineStore(s => s.toggleMute)
  const toggleSolo = useTimelineStore(s => s.toggleSolo)
  const toggleLock = useTimelineStore(s => s.toggleLock)
  const moveTrackToIndex = useTimelineStore(s => s.moveTrackToIndex)
  const moveTrackBy = useTimelineStore(s => s.moveTrackBy)
  const moveClip = useTimelineStore(s => s.moveClip)
  const trimClip = useTimelineStore(s => s.trimClip)
  const updateClip = useTimelineStore(s => s.updateClip)
  const addClip = useTimelineStore(s => s.addClip)
  const splitClip = useTimelineStore(s => s.splitClip)
  const removeClip = useTimelineStore(s => s.removeClip)
  const duplicateClip = useTimelineStore(s => s.duplicateClip)
  const rippleDeleteClip = useTimelineStore(s => s.rippleDeleteClip)
  const timelineZoom = useTimelineStore(s => s.timelineZoom)
  const setTimelineZoom = useTimelineStore(s => s.setTimelineZoom)
  const timelineScrollLeft = useTimelineStore(s => s.timelineScrollLeft)
  const setTimelineScrollLeft = useTimelineStore(s => s.setTimelineScrollLeft)
  const keyframes = useTimelineStore(s => s.keyframes)
  const moveClipKeyframes = useTimelineStore(s => s.moveClipKeyframes)
  const removeClipKeyframesAtMs = useTimelineStore(s => s.removeClipKeyframesAtMs)
  const inPointStore = useTimelineStore(s => s.inPoint)
  const outPointStore = useTimelineStore(s => s.outPoint)
  const setInPoint = useTimelineStore(s => s.setInPoint)
  const setOutPoint = useTimelineStore(s => s.setOutPoint)
  const clearInOutPoints = useTimelineStore(s => s.clearInOutPoints)
  const addMarker = useTimelineStore(s => s.addMarker)
  const removeMarker = useTimelineStore(s => s.removeMarker)
  const updateMarker = useTimelineStore(s => s.updateMarker)
  const markers = useTimelineStore(s => s.markers)
  const calculateDuration = useTimelineStore(s => s.calculateDuration)

  const inPoint = inPointStore ?? 0
  const projectDuration = calculateDuration() || 30
  const outPoint = outPointStore ?? projectDuration

  const setPlayheadTime = useAppStore(s => s.setPlayheadTime)
  const bpm = useAppStore(s => s.bpm)
  const beatGridEnabled = useAppStore(s => s.beatGridEnabled)
  const snapEnabled = useAppStore(s => s.snapEnabled)
  const setBpm = useAppStore(s => s.setBpm)
  const setBeatOffset = useAppStore(s => s.setBeatOffset)
  const toggleBeatGrid = useAppStore(s => s.toggleBeatGrid)
  const toggleSnap = useAppStore(s => s.toggleSnap)
  const editMode = useAppStore(s => s.editMode)
  const toggleEditMode = useAppStore(s => s.toggleEditMode)
  const selectClip = useAppStore(s => s.selectClip)
  const selectTrack = useAppStore(s => s.selectTrack)
  const selectedClipId = useAppStore(s => s.selectedClipId)
  const selectedTrackId = useAppStore(s => s.selectedTrackId)
  const enterClipGraph = useAppStore(s => s.enterClipGraph)
  const defaultTransition = useAppStore(s => s.defaultTransition)
  const clipGraphs = useGraphStore(s => s.clipGraphs)
  const initClipGraph = useGraphStore(s => s.initClipGraph)
  const compoundLibrary = useGraphStore(s => s.compoundLibrary)

  const pxPerSec = 80 * timelineZoom
  const TRACK_HEADER_W = 160

  // (Playhead scrubbing lives below `applySnap`, which it depends on.)

  // ── Viewport width ──
  // Measured, not assumed. Zoom-fit, scroll clamping and mark culling all need
  // it, and the culling used to use a hard-coded 2500px window — so on a monitor
  // wider than that, the right-hand end of the ruler had no marks or beat lines
  // at all, and on a narrow one it built ~2× the DOM it needed.
  // The ruler and every clip lane share a left edge (a 160px header/spacer sits
  // left of both), so ONE measurement and ONE content origin serve both.
  const [viewportWidth, setViewportWidth] = useState(0)
  useEffect(() => {
    const el = rulerRef.current
    if (!el) { setViewportWidth(0); return }
    setViewportWidth(el.clientWidth)
    const ro = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed])

  // Clamp a scroll position to the content. Without an upper bound you can pan
  // into unbounded empty space, and zooming OUT leaves you parked past the end
  // with a blank timeline and no obvious way back.
  // The playhead counts as content, so scrubbing past the last clip still lets
  // the view follow it.
  const clampScrollLeft = useCallback((x, pps = pxPerSec) => {
    const extent = Math.max(projectDuration, useAppStore.getState().playheadTime) * pps
    // Stop when the end of the content reaches the middle of the view.
    const max = Math.max(0, extent - viewportWidth / 2)
    return Math.max(0, Math.min(max, x))
  }, [projectDuration, pxPerSec, viewportWidth])

  // Zoom by `factor`, keeping `anchorTime` pinned to the pixel it currently
  // occupies. Zoom used to change the scale and nothing else, which pins t=0
  // instead — so everything fanned out from the far left and the thing you were
  // looking at slid off screen.
  // The store owns the zoom limits, so the new zoom is read BACK from it rather
  // than re-clamped here; otherwise the anchor maths would use a value the store
  // rejected and the view would drift at the extremes.
  const zoomBy = useCallback((factor, anchorTime = null) => {
    const prev = useTimelineStore.getState().timelineZoom
    setTimelineZoom(prev * factor)
    const next = useTimelineStore.getState().timelineZoom
    if (next === prev) return

    const scroll = useTimelineStore.getState().timelineScrollLeft
    const prevPps = 80 * prev
    const nextPps = 80 * next
    const t = anchorTime != null ? anchorTime : (scroll + viewportWidth / 2) / prevPps
    const anchorX = t * prevPps - scroll // where the anchor sits on screen now
    setTimelineScrollLeft(clampScrollLeft(t * nextPps - anchorX, nextPps))
  }, [setTimelineZoom, setTimelineScrollLeft, clampScrollLeft, viewportWidth])

  // Keyboard zoom anchors on the playhead when it's visible (Premiere's
  // behaviour — you're almost always zooming to look at where you are), and on
  // the middle of the view when it isn't, so it can't teleport somewhere else.
  const zoomAtPlayhead = useCallback((factor) => {
    const scroll = useTimelineStore.getState().timelineScrollLeft
    const ph = useAppStore.getState().playheadTime
    const x = ph * pxPerSec - scroll
    zoomBy(factor, x >= 0 && x <= viewportWidth ? ph : null)
  }, [pxPerSec, viewportWidth, zoomBy])

  const handleTimelineWheel = useCallback((e) => {
    // Firefox reports wheel deltas in LINES (deltaMode 1, ~3 per notch) and some
    // configurations in PAGES (2). Unnormalised, one notch zoomed 30× further in
    // Chrome than in Firefox.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (viewportWidth || 800) : 1
    const dx = e.deltaX * unit
    const dy = e.deltaY * unit
    const scroll = useTimelineStore.getState().timelineScrollLeft

    // A tilt wheel / horizontal trackpad swipe PANS.
    // This is the "it always scrolls left" bug: a horizontal tick has deltaY 0,
    // so it fell through to the zoom branch, where `deltaY > 0` was false and it
    // therefore zoomed IN by 10% — in both tilt directions. Zoom anchoring at
    // time 0 then pushed the picture rightward, which reads as the view sliding
    // left. Two bugs that looked like one.
    if (Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault()
      setTimelineScrollLeft(clampScrollLeft(scroll + dx))
      return
    }

    // Shift+wheel = horizontal pan, for mice with no tilt wheel.
    if (e.shiftKey) {
      e.preventDefault()
      setTimelineScrollLeft(clampScrollLeft(scroll + dy))
      return
    }

    // Alt+wheel scrolls the track list. The lanes are a native scroll container,
    // but plain wheel is taken by zoom and preventDefault'd — so a project with
    // more tracks than fit could previously only be scrolled by dragging the
    // scrollbar.
    if (e.altKey) {
      const area = tracksAreaRef.current
      if (area) { e.preventDefault(); area.scrollTop += dy }
      return
    }

    // Everything else zooms at the cursor. `ctrlKey` lands here too: that is how
    // browsers report a trackpad pinch, and preventDefault stops it zooming the
    // whole page instead.
    e.preventDefault()
    if (dy === 0) return
    // Exponential, so a slow scroll and a fast flick feel the same per unit of
    // travel. Clamped so one huge delta (or a coarse deltaMode) can't jump the
    // entire zoom range in a single event.
    const factor = Math.min(2, Math.max(0.5, Math.pow(1.002, -dy)))

    const rect = rulerRef.current?.getBoundingClientRect()
    // Over the 160px track header, cursorX is negative — anchor on the left edge
    // of the lane rather than on a negative time.
    const cursorX = rect ? Math.max(0, e.clientX - rect.left) : viewportWidth / 2
    zoomBy(factor, (cursorX + scroll) / pxPerSec)
  }, [pxPerSec, viewportWidth, setTimelineScrollLeft, clampScrollLeft, zoomBy])

  // Zoom to fit — scale so the whole project fills the visible ruler width and
  // reset the scroll. This is the standard "fit sequence to window" control found
  // in professional NLEs/DAWs (Premiere/Resolve's `\`, etc.).
  const handleZoomFit = useCallback(() => {
    const width = viewportWidth || rulerRef.current?.clientWidth || 0
    const dur = calculateDuration() || 30
    if (width <= 0 || dur <= 0) return
    setTimelineZoom((width - 24) / (dur * 80)) // 80 = base px/sec
    setTimelineScrollLeft(0)
  }, [calculateDuration, viewportWidth, setTimelineZoom, setTimelineScrollLeft])

  // Re-clamp whenever the zoom, the panel width or the project length changes by
  // any route (keyboard zoom, window resize, project load, deleting the last
  // clip). Without this you can be left parked in empty space showing nothing.
  useEffect(() => {
    const cur = useTimelineStore.getState().timelineScrollLeft
    const clamped = clampScrollLeft(cur)
    if (clamped !== cur) setTimelineScrollLeft(clamped)
  }, [clampScrollLeft, setTimelineScrollLeft])

  // Follow the playhead when it leaves the visible window — during playback it
  // otherwise just runs off the right edge a few seconds in and you have to
  // chase it, and a jump (In/Out, "Playhead to Clip Start") could land somewhere
  // you can't see.
  //
  // Subscribed imperatively rather than via a hook selector: playheadTime
  // changes every frame, so a subscribed Timeline would re-render the whole
  // panel 60×/sec. This only writes when the view actually has to page.
  useEffect(() => {
    if (viewportWidth <= 0) return
    return useAppStore.subscribe(
      (s) => s.playheadTime,
      (t) => {
        // Never fight a manual scrub — that gesture owns the scroll, and it has
        // its own edge auto-scroll.
        if (document.body.classList.contains('is-scrubbing')) return
        const scroll = useTimelineStore.getState().timelineScrollLeft
        const x = t * pxPerSec - scroll
        const margin = Math.min(80, viewportWidth * 0.1)
        if (x >= margin && x <= viewportWidth - margin) return
        // Page, don't centre. Re-centring every frame slides the entire timeline
        // continuously under the eye, which is much harder to read than one jump
        // per screenful.
        setTimelineScrollLeft(Math.max(0, t * pxPerSec - margin))
      }
    )
  }, [pxPerSec, viewportWidth, setTimelineScrollLeft])

  // Attach native wheel listeners because React 18 makes onWheel passive,
  // which silently prevents e.preventDefault() from working.
  useEffect(() => {
    const el = rulerRef.current
    if (!el) return
    el.addEventListener('wheel', handleTimelineWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleTimelineWheel)
  }, [handleTimelineWheel])

  useEffect(() => {
    const el = tracksAreaRef.current
    if (!el) return
    el.addEventListener('wheel', handleTimelineWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleTimelineWheel)
  }, [handleTimelineWheel])

  // ── Beat grid lines (beats faint, bars strong) ──
  // Rendered inside the same translated container as the ruler marks. Beats are
  // skipped when they'd be denser than ~7px so zoomed-out views stay readable.
  const generateBeatLines = () => {
    if (!beatGridEnabled || !bpm || bpm <= 0 || viewportWidth <= 0) return null
    const app = useAppStore.getState()
    const spb = 60 / bpm // seconds per beat
    const beatPx = spb * pxPerSec
    if (beatPx < 3) return null
    const showBeats = beatPx >= 7
    const lines = []
    const startBeat = Math.max(0, Math.floor((timelineScrollLeft / pxPerSec - app.beatOffset) / spb) - 1)
    // Culled to the MEASURED viewport (was a hard-coded 2500px, which left the
    // right of a wide panel bare and over-drew on a narrow one).
    const endTime = (timelineScrollLeft + viewportWidth) / pxPerSec
    for (let b = startBeat; ; b++) {
      const t = app.beatOffset + b * spb
      if (t > endTime) break
      if (t < 0) continue
      const isBar = b % 4 === 0
      if (!isBar && !showBeats) continue
      lines.push(
        <div
          key={`beat_${b}`}
          className={`timeline__beat-line ${isBar ? 'timeline__beat-line--bar' : ''}`}
          style={{ left: t * pxPerSec }}
        />
      )
    }
    return lines
  }

  // ── Tap tempo ──
  // Tap along with the song: BPM = average of the recent tap intervals.
  // A gap > 2.5s starts a fresh measurement. Alt+click sets the beat OFFSET
  // to the playhead instead (aligns beat 1 with the downbeat).
  const tapTimesRef = useRef([])
  const handleTapTempo = useCallback((e) => {
    if (e.altKey) {
      setBeatOffset(useAppStore.getState().playheadTime)
      return
    }
    const now = performance.now()
    const taps = tapTimesRef.current
    if (taps.length > 0 && now - taps[taps.length - 1] > 2500) taps.length = 0
    taps.push(now)
    if (taps.length > 8) taps.shift()
    if (taps.length >= 2) {
      const intervals = []
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1])
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length
      setBpm(Math.round((60000 / avgMs) * 10) / 10)
    }
  }, [setBpm, setBeatOffset])

  // Generate ruler time marks.
  //
  // Both spacings come off the same 1-2-5 ladder, so marks stay in a readable
  // pixel band at ANY zoom. The old fixed table bottomed out at "10s apart below
  // 20px/sec" — at the minimum zoom (0.16 px/sec) that put marks 1.6px apart and
  // built ~1500 DOM nodes for a solid grey bar — and topped out at 0.5s, so past
  // ~300px/sec the labels were unreadably dense and every one of them read the
  // same whole second.
  const generateRulerMarks = () => {
    if (pxPerSec <= 0 || viewportWidth <= 0) return null
    const minor = pickRulerStep(pxPerSec, 14) // tick only
    let major = pickRulerStep(pxPerSec, 72)   // labelled, full-height
    // The ladder isn't uniformly divisible (15 isn't a multiple of 2), and where
    // it isn't, labels land only on the LCM of the two steps — e.g. every 30s on
    // a 2s tick, so half the expected labels vanish. Round the labelled step up
    // to an exact multiple of the tick step.
    if (Math.abs(major / minor - Math.round(major / minor)) > 1e-6) {
      major = Math.ceil(major / minor) * minor
    }

    const startIdx = Math.max(0, Math.floor((timelineScrollLeft / pxPerSec) / minor))
    const endIdx = Math.ceil(((timelineScrollLeft + viewportWidth) / pxPerSec) / minor)

    const marks = []
    for (let i = startIdx; i <= endIdx; i++) {
      // Indexed rather than accumulated (`t += minor`), which drifts on floats
      // and made mark positions disagree with the beat grid over long timelines.
      const t = i * minor
      const ratio = t / major
      const isMajor = Math.abs(ratio - Math.round(ratio)) < 1e-6
      marks.push(
        <div
          key={i}
          className={`timeline__ruler-mark ${isMajor ? 'timeline__ruler-mark--major' : ''}`}
          style={{ left: t * pxPerSec }}
        >
          {isMajor && (
            <span className="timeline__ruler-label mono">
              {formatTimecode(t, major)}
            </span>
          )}
        </div>
      )
    }
    return marks
  }

  // ── Snapping ──
  // Snap targets (seconds): other clips' edges, markers, in/out, playhead, 0.
  // Collected once at drag start; the beat grid is evaluated analytically in
  // applySnap so it never needs enumerating.
  // `includePlayhead` exists for the playhead's OWN drag: it is the thing being
  // moved, so leaving it in the target list would snap it to itself and pin it
  // in place. Every other caller wants it.
  const collectSnapPoints = useCallback((excludeClipId = null, includePlayhead = true) => {
    const state = useTimelineStore.getState()
    const pts = [0]
    if (includePlayhead) pts.push(useAppStore.getState().playheadTime)
    for (const c of state.clips) {
      if (c.id === excludeClipId) continue
      pts.push(c.timelineStart, c.timelineEnd)
    }
    for (const m of state.markers) pts.push(m.time)
    if (state.inPoint != null) pts.push(state.inPoint)
    if (state.outPoint != null) pts.push(state.outPoint)
    return pts
  }, [])

  // Snap a time to the nearest target within a zoom-scaled pixel threshold.
  // Shift (passed as `disable`) bypasses snapping entirely.
  const applySnap = useCallback((time, snapPoints, disable = false) => {
    const app = useAppStore.getState()
    if (disable || !app.snapEnabled) return time
    const threshold = 8 / pxPerSec // 8 screen px, in seconds
    let best = time
    let bestDist = threshold
    for (const p of snapPoints) {
      const d = Math.abs(p - time)
      if (d < bestDist) { bestDist = d; best = p }
    }
    if (app.beatGridEnabled && app.bpm > 0) {
      const spb = 60 / app.bpm
      const nearest = Math.round((time - app.beatOffset) / spb) * spb + app.beatOffset
      const d = Math.abs(nearest - time)
      if (d < bestDist) { bestDist = d; best = nearest }
    }
    return Math.max(0, best)
  }, [pxPerSec])

  // ── Playhead scrubbing ──
  // One gesture, two entry points. Pressing anywhere on the ruler jumps there
  // and keeps dragging; pressing the playhead's own grab strip drags it WITHOUT
  // jumping (the cursor keeps its offset from the line, so it doesn't teleport
  // a few px the instant you touch it). Both land here so they can never drift
  // apart, and so missing the ~10px arrow still gives you the drag you meant
  // instead of a single jump.
  const [scrubbing, setScrubbing] = useState(false)
  const beginScrub = useCallback((e, grabHandle = false) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const snapPoints = collectSnapPoints(null, false)

    // Read the rect and scroll live rather than closing over them: the ruler can
    // resize mid-drag, and the auto-scroll below moves the scroll under us.
    const timeAt = (clientX, shiftKey, offsetPx) => {
      const rect = rulerRef.current?.getBoundingClientRect()
      if (!rect) return useAppStore.getState().playheadTime
      const scroll = useTimelineStore.getState().timelineScrollLeft
      const x = clientX + offsetPx - rect.left + scroll
      return applySnap(Math.max(0, x / pxPerSec), snapPoints, shiftKey)
    }

    let grabOffset = 0
    if (grabHandle) {
      const rect = rulerRef.current?.getBoundingClientRect()
      if (rect) {
        const scroll = useTimelineStore.getState().timelineScrollLeft
        const headX = rect.left + useAppStore.getState().playheadTime * pxPerSec - scroll
        grabOffset = headX - e.clientX
      }
    } else {
      setPlayheadTime(timeAt(e.clientX, e.shiftKey, 0))
    }

    setScrubbing(true)
    document.body.classList.add('is-scrubbing')

    // Auto-scroll while the drag sits near either edge, so the playhead can be
    // taken past the visible window on a zoomed-in timeline — otherwise "drag it
    // where I want" stops dead at the panel border.
    const EDGE_PX = 32
    const MAX_SCROLL_SPEED = 1200 // px/sec at full deflection
    let pointer = { x: e.clientX, shift: e.shiftKey }
    let prevT = 0
    let raf = 0

    const tick = (t) => {
      raf = requestAnimationFrame(tick)
      const dt = prevT ? Math.min(0.05, (t - prevT) / 1000) : 0
      prevT = t
      const rect = rulerRef.current?.getBoundingClientRect()
      if (!rect || dt === 0) return

      let push = 0
      if (pointer.x > rect.right - EDGE_PX) push = (pointer.x - (rect.right - EDGE_PX)) / EDGE_PX
      else if (pointer.x < rect.left + EDGE_PX) push = (pointer.x - (rect.left + EDGE_PX)) / EDGE_PX
      if (push === 0) return

      const speed = Math.max(-1, Math.min(1, push)) * MAX_SCROLL_SPEED
      // Zustand `set` is synchronous, so the playhead below reads the new scroll.
      // clampScrollLeft counts the playhead as content, so dragging past the last
      // clip still lets the view follow instead of stopping at the content edge.
      setTimelineScrollLeft(clampScrollLeft(useTimelineStore.getState().timelineScrollLeft + speed * dt))
      setPlayheadTime(timeAt(pointer.x, pointer.shift, grabOffset))
    }
    raf = requestAnimationFrame(tick)

    const onMove = (me) => {
      pointer = { x: me.clientX, shift: me.shiftKey }
      setPlayheadTime(timeAt(me.clientX, me.shiftKey, grabOffset))
    }
    const onUp = () => {
      cancelAnimationFrame(raf)
      setScrubbing(false)
      document.body.classList.remove('is-scrubbing')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, setPlayheadTime, setTimelineScrollLeft, collectSnapPoints, applySnap, clampScrollLeft])

  // A scrub that is still live when the panel unmounts (collapse, project load)
  // would leave the body class stuck on and every cursor in the app wrong.
  useEffect(() => () => document.body.classList.remove('is-scrubbing'), [])

  const handlePlayheadGrab = useCallback((e) => beginScrub(e, true), [beginScrub])

  // ── Track stacking order ──
  // `tracks` is bottom-to-top: index 0 is the BACK of the picture, which is what
  // the Renderer composites first (ascending zOrder). The panel renders it
  // REVERSED so the top row is the FRONT layer, as in Premiere/Resolve. Only the
  // view is flipped — the array stays the single source of truth, so no saved
  // project's picture moves.
  const displayTracks = useMemo(() => [...tracks].reverse(), [tracks])

  // Drag a track header to restack. Reorders LIVE (rather than dropping a ghost
  // at the end) so the picture updates as you drag and you can judge the
  // composite while choosing where to land.
  const [draggingTrackId, setDraggingTrackId] = useState(null)
  const handleTrackHeaderMouseDown = useCallback((e, track) => {
    if (e.button !== 0) return
    // The M / S / L buttons live inside the header; a press on one must not arm
    // a drag, or the row slides out from under the click.
    if (e.target.closest('button')) return

    selectTrack(track.id)

    const startY = e.clientY
    let dragging = false

    const onMove = (me) => {
      // 4px of slop, so a plain click still just selects the track.
      if (!dragging) {
        if (Math.abs(me.clientY - startY) < 4) return
        dragging = true
        setDraggingTrackId(track.id)
        document.body.classList.add('is-reordering')
      }

      const area = tracksAreaRef.current
      if (!area) return
      const rect = area.getBoundingClientRect()
      // Measure a real row rather than hard-coding 48px, so a CSS change to the
      // track height can't silently desync the drop target from the picture.
      const rowH = area.querySelector('.timeline__track')?.getBoundingClientRect().height || 48
      const count = useTimelineStore.getState().tracks.length
      if (!count || rowH <= 0) return

      const row = Math.max(0, Math.min(count - 1,
        Math.floor((me.clientY - rect.top + area.scrollTop) / rowH)))
      // Display row → array index. The list is reversed, so this is the one
      // conversion the whole feature hinges on.
      moveTrackToIndex(track.id, count - 1 - row)
    }

    const onUp = () => {
      setDraggingTrackId(null)
      document.body.classList.remove('is-reordering')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [selectTrack, moveTrackToIndex])

  useEffect(() => () => document.body.classList.remove('is-reordering'), [])

  // Snap a moving clip by whichever of its two edges lands closest to a target.
  const snapClipStart = useCallback((start, duration, snapPoints, disable = false) => {
    const snappedByStart = applySnap(start, snapPoints, disable)
    const snappedByEnd = applySnap(start + duration, snapPoints, disable) - duration
    const dStart = Math.abs(snappedByStart - start)
    const dEnd = Math.abs(snappedByEnd - start)
    return Math.max(0, dEnd < dStart ? snappedByEnd : snappedByStart)
  }, [applySnap])

  // Clip dragging
  const [draggingClip, setDraggingClip] = useState(null)
  const [trimming, setTrimming] = useState(null) // { clipId, edge }

  // Clip body drag (move). Snaps either clip edge to targets; Shift disables.
  const handleClipMouseDown = useCallback((e, clip) => {
    e.stopPropagation()
    selectClip(clip.id)

    // Right/middle press selects but must NOT arm a drag — otherwise the
    // context menu opens with a live mousemove handler attached and the clip
    // slides out from under the menu.
    if (e.button !== 0) return

    const startX = e.clientX
    const originalStart = clip.timelineStart
    const duration = clip.timelineEnd - clip.timelineStart
    const snapPoints = collectSnapPoints(clip.id)

    const onMove = (me) => {
      const dx = me.clientX - startX
      const dt = dx / pxPerSec

      const hoveredEl = document.elementFromPoint(me.clientX, me.clientY)
      const trackEl = hoveredEl?.closest('.timeline__track')
      let targetTrackId = clip.trackId
      if (trackEl) {
        const trackId = trackEl.getAttribute('data-track-id')
        const trackType = trackEl.getAttribute('data-track-type')

        // Clip compatibility: visual clips (video/camera/screen/image/text) live on
        // video tracks; audio clips on audio tracks.
        const isCompatible = (clip.fileType === 'audio')
          ? trackType === 'audio'
          : trackType === 'video'

        if (trackId && isCompatible) {
          targetTrackId = trackId
        }
      }

      const newStart = snapClipStart(Math.max(0, originalStart + dt), duration, snapPoints, me.shiftKey)
      moveClip(clip.id, newStart, targetTrackId)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setDraggingClip(null)
    }

    setDraggingClip(clip.id)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, selectClip, moveClip, collectSnapPoints, snapClipStart])

  // ── Drag & drop generator clips (text / image) onto a video track ──
  //
  // A transition drag is the other thing that lands here, and it needs a hover
  // highlight (which of the clip's two edges will it land on?) that a generator
  // drag must NOT get. `getData` is blocked outside `drop`, so the two are told
  // apart by the marker MIME type the Transitions browser sets alongside the
  // payload — `types` is readable during dragover, values are not.
  const [transitionDrop, setTransitionDrop] = useState(null) // { clipId, edge }

  /** The clip under a client-x on this track, and which of its edges is nearer. */
  const edgeAtPointer = useCallback((e, track) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const t = (e.clientX - rect.left + timelineScrollLeft) / pxPerSec
    const all = useTimelineStore.getState().clips
    const hit = all.find(c => c.trackId === track.id && t >= c.timelineStart && t <= c.timelineEnd)
    return hit ? { clipId: hit.id, edge: nearestEdge(hit, t) } : null
  }, [pxPerSec, timelineScrollLeft])

  const handleTrackDragOver = useCallback((e, track) => {
    if (!e.dataTransfer.types.includes('application/dalivid-drag')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const isTransition = e.dataTransfer.types.includes(TRANSITION_DRAG_TYPE)
    setTransitionDrop(isTransition && track?.type === 'video' ? edgeAtPointer(e, track) : null)
  }, [edgeAtPointer])

  // dragleave bubbles up from every clip inside the lane, so an unconditional
  // clear makes the highlight strobe as the pointer crosses child elements.
  // Only a leave that actually exits the lane counts.
  const handleTrackDragLeave = useCallback((e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    setTransitionDrop(null)
  }, [])

  const handleTrackDrop = useCallback((e, track) => {
    const raw = e.dataTransfer.getData('application/dalivid-drag')
    setTransitionDrop(null)
    if (!raw) return
    let payload
    try { payload = JSON.parse(raw) } catch { return }

    // A transition dropped from the browser lands on the nearer edge of the clip
    // under the cursor — drop on the front half for an In, the back half for an
    // Out. Same gesture as dropping a transition on a cut in any NLE, and it is
    // the reason `transitionCatalog` types are directly consumable: no branch
    // here for built-in vs library vs private graph.
    if (payload.kind === 'transition') {
      e.preventDefault()
      e.stopPropagation()
      if (track.type !== 'video') return
      const target = edgeAtPointer(e, track)
      if (!target) return
      applyTransitionById(target.clipId, target.edge, payload.transitionType ?? null)
      selectClip(target.clipId)
      return
    }

    // A drop makes a generator CLIP. Media-Pool image cards and text/shape preset
    // cards all land here; node-graph drags (kind:'node' with no generator type)
    // are ignored.
    const clipType = payload.clipType
      || (payload.imageSrc ? 'image' : null)
      || (payload.nodeType === 'IMAGE_INPUT' ? 'image' : null)
      || (payload.nodeType === 'TEXT_INPUT' ? 'text' : null)
      || (payload.nodeType === 'SHAPE_INPUT' ? 'shape' : null)
    if (!['image', 'text', 'shape'].includes(clipType) || track.type !== 'video') return

    e.preventDefault()
    e.stopPropagation()

    // Drop time from the cursor x within the (scrolled) clip lane.
    const rect = e.currentTarget.getBoundingClientRect()
    const start = Math.max(0, (e.clientX - rect.left + timelineScrollLeft) / pxPerSec)
    const duration = DEFAULT_GENERATOR_DURATION

    let filename, params
    if (clipType === 'image') {
      filename = payload.imageName || payload.name || 'Image'
      params = makeImageClipParams({ imageSrc: payload.imageSrc || null, imageName: filename })
    } else if (clipType === 'shape') {
      filename = payload.name || 'Shape'
      params = makeShapeClipParams(payload.params || {})
    } else {
      params = makeTextClipParams(payload.params || {})
      filename = (params.text || 'Text').split('\n')[0].slice(0, 24) || 'Text'
    }

    const clipId = addClip(track.id, {
      filename, fileType: clipType,
      timelineStart: start, timelineEnd: start + duration,
      sourceStart: 0, sourceEnd: duration,
      params,
    })
    initClipGraph(clipId, filename, clipType)
    selectClip(clipId)
  }, [pxPerSec, timelineScrollLeft, addClip, initClipGraph, selectClip, edgeAtPointer])

  // Trim handle drag (left or right edge). Edge snaps to targets; Shift disables.
  const handleTrimMouseDown = useCallback((e, clip, edge) => {
    e.stopPropagation()
    if (e.button !== 0) return // right-click belongs to the context menu
    e.preventDefault()
    selectClip(clip.id)

    const startX = e.clientX
    const originalTime = edge === 'left' ? clip.timelineStart : clip.timelineEnd
    const snapPoints = collectSnapPoints(clip.id)

    const onMove = (me) => {
      const dx = me.clientX - startX
      const dt = dx / pxPerSec
      const snapped = applySnap(Math.max(0, originalTime + dt), snapPoints, me.shiftKey)
      trimClip(clip.id, edge, snapped)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setTrimming(null)
    }

    setTrimming({ clipId: clip.id, edge })
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, selectClip, trimClip, collectSnapPoints, applySnap])

  // Fade handle drag — sets the clip's fadeIn / fadeOut duration (seconds).
  // The fade-in handle lives at the end of the fade-in ramp (drag right =
  // longer); the fade-out handle at the start of its ramp (drag left = longer).
  const handleFadeMouseDown = useCallback((e, clip, side) => {
    e.stopPropagation()
    if (e.button !== 0) return // right-click belongs to the context menu
    e.preventDefault()
    selectClip(clip.id)

    const startX = e.clientX
    const original = side === 'in' ? (clip.fadeIn || 0) : (clip.fadeOut || 0)
    const duration = clip.timelineEnd - clip.timelineStart

    const onMove = (me) => {
      const dx = me.clientX - startX
      const dt = (side === 'in' ? dx : -dx) / pxPerSec
      const next = Math.max(0, Math.min(duration, original + dt))
      updateClip(clip.id, side === 'in' ? { fadeIn: next } : { fadeOut: next })
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, selectClip, updateClip])

  // Drag Left Marker (In Point)
  const handleInMarkerMouseDown = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const originalIn = useTimelineStore.getState().inPoint ?? 0

    const onMove = (me) => {
      const dx = me.clientX - startX
      const dt = dx / pxPerSec
      const currentOut = useTimelineStore.getState().outPoint ?? projectDuration
      const newIn = Math.max(0, Math.min(originalIn + dt, currentOut - 0.1))
      setInPoint(newIn)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, setInPoint, projectDuration])

  // Drag Right Marker (Out Point)
  const handleOutMarkerMouseDown = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const originalOut = useTimelineStore.getState().outPoint ?? projectDuration

    const onMove = (me) => {
      const dx = me.clientX - startX
      const dt = dx / pxPerSec
      const currentIn = useTimelineStore.getState().inPoint ?? 0
      const newOut = Math.max(currentIn + 0.1, originalOut + dt)
      setOutPoint(newOut)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, setOutPoint, projectDuration])

  // Marker drag (move along the ruler). Alt+click deletes; double-click renames.
  const handleMarkerMouseDown = useCallback((e, marker) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.altKey) {
      removeMarker(marker.id)
      return
    }
    const startX = e.clientX
    const originalTime = marker.time
    const snapPoints = collectSnapPoints()
    const onMove = (me) => {
      const dt = (me.clientX - startX) / pxPerSec
      updateMarker(marker.id, { time: applySnap(Math.max(0, originalTime + dt), snapPoints, me.shiftKey) })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, removeMarker, updateMarker, collectSnapPoints, applySnap])

  // Keyframe-marker drag. Diamonds are clip-relative and merged per ms column,
  // so a drag shifts the whole column (all params/nodes keyed at that time).
  // Times are clip-relative but snapping targets are absolute, so convert
  // through the clip origin. Alt+click deletes the column (marker convention).
  const [draggingKf, setDraggingKf] = useState(null) // { clipId, ms }
  const handleKeyframeMouseDown = useCallback((e, clip, ms) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.altKey) {
      removeClipKeyframesAtMs(clip.id, ms)
      return
    }
    const startX = e.clientX
    const originalRel = ms / 1000
    const duration = clip.timelineEnd - clip.timelineStart
    const snapPoints = collectSnapPoints(clip.id)
    let currentMs = ms // the column moves under us; re-match it each step

    const onMove = (me) => {
      const dt = (me.clientX - startX) / pxPerSec
      const abs = applySnap(clip.timelineStart + originalRel + dt, snapPoints, me.shiftKey)
      const rel = Math.max(0, Math.min(duration, abs - clip.timelineStart))
      moveClipKeyframes(clip.id, currentMs, rel)
      currentMs = Math.round(rel * 1000)
      setDraggingKf({ clipId: clip.id, ms: currentMs }) // highlight follows the column
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setDraggingKf(null)
    }
    setDraggingKf({ clipId: clip.id, ms })
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, collectSnapPoints, applySnap, moveClipKeyframes, removeClipKeyframesAtMs])

  const handleMarkerRename = useCallback((marker) => {
    const label = window.prompt('Marker label:', marker.label || '')
    if (label !== null) updateMarker(marker.id, { label })
  }, [updateMarker])

  // Split selected clip at playhead. The right half is a brand-new clip id, so
  // it needs its own effect graph — a deep copy of the original's, so the split
  // doesn't strip effects from one side (and the clip editor can open it).
  const handleSplitAtPlayhead = useCallback(() => {
    if (!selectedClipId) return
    const currentPlayheadTime = useAppStore.getState().playheadTime
    const clip = useTimelineStore.getState().clips.find(c => c.id === selectedClipId)
    const rightId = splitClip(selectedClipId, currentPlayheadTime)
    if (rightId) {
      useGraphStore.getState().duplicateClipGraph(
        selectedClipId, rightId,
        clip?.filename || 'Clip',
        clip?.fileType === 'audio' ? 'audio' : 'video'
      )
    }
  }, [selectedClipId, splitClip])

  // Delete selected clip
  const handleDeleteClip = useCallback(() => {
    if (!selectedClipId) return
    removeClip(selectedClipId)
  }, [selectedClipId, removeClip])

  // ─────────────────────────────────────────────────────────────────────────
  // Clip right-click menu
  // ─────────────────────────────────────────────────────────────────────────

  // The playhead is SNAPSHOTTED into the menu state on open rather than
  // subscribed: playheadTime changes every frame during playback, and
  // subscribing would re-render the entire Timeline 60×/s just to keep one
  // menu item's enabled state fresh. The menu is modal-ish and short-lived, so
  // a snapshot is both cheaper and more predictable.
  // `view` drives which item list the one menu renders: the clip's actions, one
  // edge's actions, or that edge's effect picker. Re-using a single menu (the
  // Media Pool's confirm-step pattern) rather than nesting fly-outs keeps the
  // interaction one-handed — the pointer never has to traverse a submenu.
  const [clipMenu, setClipMenu] = useState(null) // { x, y, clipId, playhead, view, edge }

  /**
   * Right-click on a clip. Landing inside a fade wedge opens THAT edge's menu
   * directly — the wedge is the transition, so right-clicking it should talk
   * about the transition, not about the clip. Anywhere else opens the clip menu.
   */
  const openClipMenu = useCallback((e, clip) => {
    e.preventDefault()
    e.stopPropagation()
    selectClip(clip.id)

    // Hit-test against the DRAWN wedges (edgeDisplaySeconds), not the raw
    // regions — otherwise right-clicking a visible wedge whose transition is
    // currently inert would fall through to the clip menu.
    const all = useTimelineStore.getState().clips
    const headSecs = edgeDisplaySeconds(clip, EDGE_HEAD, headRegion(clip, findPrevOverlap(clip, all)))
    const tailSecs = edgeDisplaySeconds(clip, EDGE_TAIL, tailRegion(clip, findNextOverlap(clip, all)))
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const t = clip.timelineStart + (px / Math.max(1, rect.width)) *
      (clip.timelineEnd - clip.timelineStart)

    // The wedge, OR a fixed pixel zone at each end when there is no wedge yet.
    //
    // Without the pixel fallback, a clip with no fades has zero-width wedges, so
    // there is physically nothing to right-click and the edge menus are reachable
    // only from a submenu of the clip menu. That made "add a transition to this
    // cut" — the single most common transition gesture in any NLE — the least
    // discoverable thing in the app. The zone is capped at a third of the clip so
    // a very short clip still has a middle that opens clip actions.
    const zonePx = Math.min(EDGE_HIT_PX, rect.width / 3)
    let edge = null
    if (headSecs > 0 && t < clip.timelineStart + headSecs) edge = EDGE_HEAD
    else if (tailSecs > 0 && t >= clip.timelineEnd - tailSecs) edge = EDGE_TAIL
    else if (px < zonePx) edge = EDGE_HEAD
    else if (px > rect.width - zonePx) edge = EDGE_TAIL

    setClipMenu({
      x: e.clientX,
      y: e.clientY,
      clipId: clip.id,
      playhead: useAppStore.getState().playheadTime,
      view: edge ? 'edge' : 'clip',
      edge: edge || EDGE_HEAD,
    })
  }, [selectClip])

  const closeClipMenu = useCallback(() => setClipMenu(null), [])
  // `group` is reset on every view change so the effect picker always opens on
  // its category list rather than on whichever category was browsed last time.
  const setMenuView = useCallback((view, edge) => {
    setClipMenu(m => (m ? { ...m, view, edge: edge || m.edge, group: null } : m))
  }, [])

  // Duplicate: the copy needs its own deep-copied effect graph (same reasoning
  // as split) — otherwise the two clips would share one graph object.
  const handleDuplicateClip = useCallback((clip) => {
    const newId = duplicateClip(clip.id)
    if (!newId) return
    useGraphStore.getState().duplicateClipGraph(
      clip.id, newId,
      clip.filename || 'Clip',
      clip.fileType === 'audio' ? 'audio' : 'video'
    )
    selectClip(newId)
  }, [duplicateClip, selectClip])

  // Split at an explicit time (the menu's snapshotted playhead), so the result
  // matches what the user saw when they opened the menu.
  const handleSplitClipAt = useCallback((clip, time) => {
    const rightId = splitClip(clip.id, time)
    if (rightId) {
      useGraphStore.getState().duplicateClipGraph(
        clip.id, rightId,
        clip.filename || 'Clip',
        clip.fileType === 'audio' ? 'audio' : 'video'
      )
    }
  }, [splitClip])

  const handleRemoveClip = useCallback((clipId, ripple) => {
    if (ripple) rippleDeleteClip(clipId)
    else removeClip(clipId)
    // Drop the orphaned graph too — the Media Pool derives its Images tab by
    // scanning clip graphs, so a lingering one resurrects deleted cards.
    useGraphStore.getState().removeClipGraph(clipId)
  }, [removeClip, rippleDeleteClip])

  // ─────────────────────────────────────────────────────────────────────────
  // Edge transitions (the fade wedges)
  // ─────────────────────────────────────────────────────────────────────────

  /** The live region for one edge, recomputed from current clip positions. */
  const edgeRegionOf = useCallback((clip, edge) => {
    return edgeRegion(clip, useTimelineStore.getState().clips, edge)
  }, [])

  /**
   * Assign an effect to one edge. Shared with the Inspector's picker via
   * `applyEdgeType` so the two routes cannot drift — they used to, and the
   * Inspector's silently produced transitions with no window to play in.
   */
  const setEdgeType = useCallback((clip, edge, type) => {
    applyEdgeType(clip, edge, type, edgeRegionOf(clip, edge), updateClip, compoundLibrary)
  }, [updateClip, edgeRegionOf, compoundLibrary])

  /** Open this edge's node graph in the editor, converting to one if needed. */
  const openEdgeGraph = useCallback((clip, edge) => {
    openEdgeGraphAction(clip, edge, edgeRegionOf(clip, edge), {
      updateClip, compoundLibrary, enterClipGraph, setPlayheadTime,
    })
  }, [edgeRegionOf, updateClip, compoundLibrary, enterClipGraph, setPlayheadTime])

  /**
   * Apply the project's default transition to one edge — the payload behind the
   * ⇄ hotspots, the T shortcut and a click in the Transitions browser. One
   * gesture, no picker: choosing between two dozen effects before you can have
   * any transition at all is the thing every NLE avoids with a default.
   */
  const applyDefaultTransition = useCallback((clipId, edge) => {
    applyTransitionById(clipId, edge, useAppStore.getState().defaultTransition)
    selectClip(clipId)
  }, [selectClip])

  const defaultTransitionLabel = transitionLabelOf(defaultTransition, compoundLibrary)

  /** Clear the edge entirely: no effect, no ramp, no graph. */
  const clearEdge = useCallback((clip, edge) => {
    updateClip(clip.id, {
      ...setEdgeTransitionPatch(edge, null),
      [edge === EDGE_TAIL ? 'fadeOut' : 'fadeIn']: 0,
    })
    useGraphStore.getState().removeTransitionGraph(clip.id, edge)
    // The edge no longer composites, so nothing will ever overwrite a stale
    // health note left over from the effect just removed.
    clearTransitionStatus(transitionGraphKey(clip.id, edge))
  }, [updateClip])

  const promoteEdgeGraph = useCallback((clip, edge) => {
    const name = `${clip.filename || 'Clip'} ${edgeLabel(edge)}`
    useGraphStore.getState().promoteTransitionGraph(clip.id, edge, name)
  }, [])

  // Built fresh each render from live clip state, so a toggle (Reverse, Mute)
  // updates its own ✓ without closing the menu.
  const menuClip = clipMenu ? clips.find(c => c.id === clipMenu.clipId) : null

  /** Human name for whatever effect an edge currently carries. */
  const edgeEffectLabel = (clip, edge) => {
    const type = getEdgeTransition(clip, edge)?.type
    if (!type) return 'Fade (opacity ramp)'
    if (isGraphType(type)) return 'Node Graph (this clip)'
    return transitionLabelOf(type, compoundLibrary)
  }

  // ── Menu view: one edge's actions ──
  const edgeMenuItems = (clip, edge) => {
    const tr = getEdgeTransition(clip, edge)
    const region = edgeRegionOf(clip, edge)
    const isGraph = isGraphType(tr?.type)
    const hasGraph = !!clipGraphs[transitionGraphKey(clip.id, edge)]
    const items = []

    if (!region) {
      items.push({
        label: 'No region yet',
        icon: '◺',
        disabled: true,
        hint: edge === EDGE_TAIL
          ? 'Drag the right fade handle (or pick an effect below — one will be created)'
          : 'Overlap the previous clip, drag the left fade handle, or pick an effect below',
      })
    } else if (region.mode === 'crossfade') {
      items.push({
        label: `Crossfade with “${region.prev.filename}”`,
        icon: '⇄',
        disabled: true,
        hint: 'The overlap between the two clips sets this transition’s length — drag either clip to change it',
      })
    } else {
      items.push({
        label: edge === EDGE_TAIL ? 'Out to nothing' : 'In from nothing',
        icon: '◺',
        disabled: true,
        hint: 'Mixes with whatever is behind this clip — lower tracks, else black',
      })
    }
    items.push({ separator: true })

    // The one-click route, first, so the common case never requires choosing
    // from a list of two dozen. Hidden once the edge already has an effect —
    // "apply the default" over an existing choice is a silent overwrite.
    if (!tr?.type) {
      items.push({
        label: `Apply Default: ${defaultTransitionLabel}`,
        icon: '★',
        hint: 'Same as pressing T, or clicking the ⇄ hotspot on this end of the clip',
        onSelect: () => applyDefaultTransition(clip.id, edge),
      })
    }
    items.push({
      label: `Effect: ${edgeEffectLabel(clip, edge)}`,
      icon: '⇄',
      hint: 'Choose what plays across this region',
      keepOpen: true, // switches this menu to the picker rather than dismissing
      onSelect: () => setMenuView('edgeType', edge),
    })
    items.push({
      label: isGraph ? 'Open Node Graph' : (hasGraph ? 'Back to Node Graph' : 'Convert to Node Graph'),
      icon: '❖',
      hint: 'Build this transition from nodes — FROM and TO are wired in, Transition Progress drives it',
      onSelect: () => openEdgeGraph(clip, edge),
    })
    if (isGraph) {
      items.push({
        label: 'Save to Library',
        icon: '⇪',
        hint: 'Publish a copy other clips can use. This clip keeps its own editable version.',
        onSelect: () => promoteEdgeGraph(clip, edge),
      })
    }
    items.push({ separator: true })

    if (tr?.type) {
      items.push({
        label: 'Remove Effect',
        icon: '↺',
        hint: 'Keep the region, hand it back to the plain opacity ramp',
        onSelect: () => setEdgeType(clip, edge, null),
      })
    }
    items.push({
      label: 'Clear This Edge',
      icon: '✕',
      danger: true,
      hint: 'Remove the effect and collapse the region to zero',
      onSelect: () => clearEdge(clip, edge),
    })
    items.push({ separator: true })
    items.push({
      label: `Other edge: ${edgeLabel(edge === EDGE_TAIL ? EDGE_HEAD : EDGE_TAIL)}`,
      icon: '⇥',
      onSelect: () => setMenuView('edge', edge === EDGE_TAIL ? EDGE_HEAD : EDGE_TAIL),
      keepOpen: true,
    })
    items.push({
      label: 'Clip Actions…',
      icon: '☰',
      onSelect: () => setMenuView('clip'),
      keepOpen: true,
    })
    return items
  }

  // ── Menu view: effect picker for one edge ──
  //
  // Built from the shared catalog and split by its `category`, with one category
  // shown at a time. A flat list of every built-in was fine at nine entries and
  // is unusable at thirty-plus — and duplicating the grouping here rather than
  // reading `groupedTransitionCatalog` would let it drift from the Media Pool
  // and the Inspector, which is exactly what this pass has been undoing.
  const edgeTypeMenuItems = (clip, edge) => {
    const current = getEdgeTransition(clip, edge)?.type || null
    const groups = groupedTransitionCatalog(compoundLibrary)
    const openGroup = clipMenu?.group || null

    if (!openGroup) {
      const items = []
      for (const { group, items: entries } of groups) {
        // The single-entry groups (Basic's "Fade") are worth showing inline —
        // burying one item behind a category is pure friction.
        if (entries.length === 1) {
          const e = entries[0]
          items.push({
            label: e.label,
            icon: '◺',
            checked: (current || '') === e.type,
            hint: e.description,
            onSelect: () => setEdgeType(clip, edge, e.type || null),
          })
          continue
        }
        const hasCurrent = entries.some(e => e.type === current)
        items.push({
          label: `${group}…`,
          icon: hasCurrent ? '●' : '⇄',
          hint: `${entries.length} transitions`,
          keepOpen: true,
          onSelect: () => setClipMenu(m => (m ? { ...m, group } : m)),
        })
      }
      return items
    }

    const entries = groups.find(g => g.group === openGroup)?.items || []
    const items = entries.map(e => ({
      label: e.type === GRAPH_TYPE ? 'Node Graph (this clip)' : e.label,
      icon: e.group === 'Node Graph' ? '❖' : '⇄',
      checked: (current || '') === e.type,
      hint: e.description,
      // A private graph wants the editor opened, not just the type assigned.
      onSelect: () => (e.type === GRAPH_TYPE
        ? openEdgeGraph(clip, edge)
        : setEdgeType(clip, edge, e.type || null)),
    }))
    items.push({ separator: true })
    items.push({
      label: 'All categories…',
      icon: '↩',
      keepOpen: true,
      onSelect: () => setClipMenu(m => (m ? { ...m, group: null } : m)),
    })
    return items
  }

  // ── Menu view: the clip's own actions ──
  const clipActionItems = (clip, playhead) => {
    const isMedia = clip.fileType === 'video' || clip.fileType === 'audio' // file-backed, seekable
    const hasAudio = isMedia
    const canSplit = playhead > clip.timelineStart + 0.001 && playhead < clip.timelineEnd - 0.001
    const items = []

    if (isMedia) {
      items.push({
        label: 'Reverse Clip',
        icon: '◀',
        checked: !!clip.reversed,
        keepOpen: true,
        hint: clip.reversed
          ? 'Play forwards again'
          : 'Play this clip backwards. Preview is seek-driven and silent; the export renders reversed audio.',
        onSelect: () => updateClip(clip.id, { reversed: !clip.reversed }),
      })
    }
    if ((clip.speed || 1) !== 1) {
      items.push({
        label: 'Reset Speed to 1×',
        icon: '⏱',
        onSelect: () => updateClip(clip.id, { speed: 1 }),
      })
    }
    if (items.length) items.push({ separator: true })

    items.push({
      label: 'Split at Playhead',
      icon: '⑂',
      shortcut: 'S',
      disabled: !canSplit,
      hint: canSplit ? '' : 'Move the playhead inside this clip first',
      onSelect: () => handleSplitClipAt(clip, playhead),
    })
    items.push({
      label: 'Duplicate',
      icon: '⧉',
      hint: 'Copy the clip (and its effect graph) directly after it',
      onSelect: () => handleDuplicateClip(clip),
    })
    items.push({ separator: true })

    items.push({
      label: 'Open Effects Graph',
      icon: '❖',
      hint: 'Same as double-clicking the clip',
      onSelect: () => { enterClipGraph(clip.id); setPlayheadTime(clip.timelineStart) },
    })
    if (hasAudio) {
      items.push({
        label: 'Mute Clip Audio',
        icon: '♪',
        checked: !!clip.audioMuted,
        keepOpen: true,
        onSelect: () => updateClip(clip.id, { audioMuted: !clip.audioMuted }),
      })
    }
    items.push({ separator: true })

    // The two edges, each showing what it currently carries. Right-clicking the
    // wedge itself lands on the same view — this is the discoverable route in.
    for (const edge of [EDGE_HEAD, EDGE_TAIL]) {
      items.push({
        label: `${edgeLabel(edge)}: ${edgeEffectLabel(clip, edge)}`,
        icon: edge === EDGE_TAIL ? '◹' : '◺',
        hint: 'Or right-click the fade wedge on the clip itself',
        onSelect: () => setMenuView('edge', edge),
        keepOpen: true,
      })
    }
    if ((clip.fadeIn || 0) > 0 || (clip.fadeOut || 0) > 0) {
      items.push({
        label: 'Clear Both Edges',
        icon: '✕',
        hint: 'Zero both regions and drop their effects',
        onSelect: () => { clearEdge(clip, EDGE_HEAD); clearEdge(clip, EDGE_TAIL) },
      })
    }
    items.push({ separator: true })

    items.push({
      label: 'Set In/Out to Clip',
      icon: '⇥',
      hint: 'Scope playback and range exports to this clip',
      onSelect: () => { setInPoint(clip.timelineStart); setOutPoint(clip.timelineEnd) },
    })
    items.push({
      label: 'Playhead to Clip Start',
      icon: '↦',
      onSelect: () => setPlayheadTime(clip.timelineStart),
    })
    items.push({ separator: true })

    items.push({
      label: 'Delete',
      icon: '✕',
      shortcut: 'Del',
      danger: true,
      onSelect: () => handleRemoveClip(clip.id, false),
    })
    items.push({
      label: 'Ripple Delete',
      icon: '⇤',
      danger: true,
      hint: 'Delete and pull later clips on this track back to close the gap',
      onSelect: () => handleRemoveClip(clip.id, true),
    })

    return items
  }

  const clipMenuItems = (() => {
    if (!menuClip) return []
    if (clipMenu.view === 'edge') return edgeMenuItems(menuClip, clipMenu.edge)
    if (clipMenu.view === 'edgeType') return edgeTypeMenuItems(menuClip, clipMenu.edge)
    return clipActionItems(menuClip, clipMenu.playhead)
  })()

  const clipMenuHeader = (() => {
    if (!menuClip) return ''
    const name = menuClip.filename || 'Clip'
    if (clipMenu.view === 'edge') {
      const r = edgeRegionOf(menuClip, clipMenu.edge)
      return `${edgeLabel(clipMenu.edge)} — ${r ? `${r.dur.toFixed(2)}s` : 'no region'} · ${name}`
    }
    if (clipMenu.view === 'edgeType') {
      return clipMenu.group
        ? `${clipMenu.group} · ${edgeLabel(clipMenu.edge)}`
        : `${edgeLabel(clipMenu.edge)} effect · ${name}`
    }
    return name
  })()

  // Keyboard shortcuts for timeline
  useEffect(() => {
    const handleKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return
      // Don't steal Ctrl/Cmd combos (Save, Export, etc.) handled globally.
      if (e.ctrlKey || e.metaKey) return

      const playhead = useAppStore.getState().playheadTime

      switch (e.code) {
        // S — split selected clip at playhead
        case 'KeyS':
          if (selectedClipId) { e.preventDefault(); handleSplitAtPlayhead() }
          break

        // Delete / Backspace — remove selected clip
        case 'Delete':
        case 'Backspace':
          if (selectedClipId) { e.preventDefault(); handleDeleteClip() }
          break

        // \ — zoom timeline to fit the whole project (NLE standard)
        case 'Backslash':
          e.preventDefault(); handleZoomFit()
          break

        // = / + — zoom in,  - / _ — zoom out (anchored on the playhead)
        case 'Equal':
        case 'NumpadAdd':
          e.preventDefault(); zoomAtPlayhead(1.25)
          break
        case 'Minus':
        case 'NumpadSubtract':
          e.preventDefault(); zoomAtPlayhead(0.8)
          break

        // I / O — set In / Out points at the playhead
        case 'KeyI':
          e.preventDefault(); setInPoint(playhead)
          break
        case 'KeyO':
          e.preventDefault(); setOutPoint(playhead)
          break
        // X — clear In/Out points
        case 'KeyX':
          e.preventDefault(); clearInOutPoints()
          break

        // M — drop a marker at the playhead
        case 'KeyM':
          e.preventDefault(); addMarker(playhead)
          break

        // ↑ / ↓ — restack the selected track one place. Up is toward the top
        // row, which is the FRONT of the picture, hence +1 on the array index.
        case 'ArrowUp':
          if (selectedTrackId) { e.preventDefault(); moveTrackBy(selectedTrackId, +1) }
          break
        case 'ArrowDown':
          if (selectedTrackId) { e.preventDefault(); moveTrackBy(selectedTrackId, -1) }
          break

        // 1 / 2 — jump playhead to In / Out points
        case 'Numpad1':
        case 'Digit1':
          e.preventDefault(); setPlayheadTime(inPoint)
          break
        case 'Numpad2':
        case 'Digit2':
          e.preventDefault(); setPlayheadTime(outPoint)
          break

        default:
          break
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectedClipId, handleSplitAtPlayhead, handleDeleteClip, handleZoomFit,
      zoomAtPlayhead, setInPoint, setOutPoint, clearInOutPoints,
      addMarker, inPoint, outPoint, setPlayheadTime, selectedTrackId, moveTrackBy])



  return (
    <>
      <div className="panel__header" onDoubleClick={onToggleCollapse}>
        <button
          className={`panel__collapse-btn ${collapsed ? 'panel__collapse-btn--collapsed' : ''}`}
          onClick={onToggleCollapse}
        >
          <IconChevronDown />
        </button>
        <span className="panel__header-title">Timeline</span>
        <div style={{ flex: 1 }} />
        {/* ── Beat grid / snapping controls ── */}
        <input
          className="timeline__bpm-input mono"
          type="number"
          min={20}
          max={300}
          step={0.1}
          value={bpm}
          onChange={(e) => setBpm(parseFloat(e.target.value))}
          title="Project BPM"
        />
        <button
          className="timeline__mode-btn"
          onClick={handleTapTempo}
          data-tooltip="Tap along to set BPM (Alt+click: set beat offset to playhead)"
        >
          TAP
        </button>
        <button
          className={`timeline__mode-btn ${beatGridEnabled ? 'timeline__mode-btn--active' : ''}`}
          onClick={toggleBeatGrid}
          data-tooltip="Beat grid: draw beat/bar lines and snap to beats"
        >
          GRID
        </button>
        <button
          className={`timeline__mode-btn ${snapEnabled ? 'timeline__mode-btn--active' : ''}`}
          onClick={toggleSnap}
          data-tooltip="Snapping: clip edges, playhead, markers, in/out (hold Shift to bypass)"
        >
          SNAP
        </button>
        <button
          className={`timeline__mode-btn ${editMode === 'insert' ? 'timeline__mode-btn--active' : ''}`}
          onClick={toggleEditMode}
          data-tooltip={editMode === 'overwrite' ? 'Switch to Insert Mode' : 'Switch to Overwrite Mode'}
        >
          {editMode === 'overwrite' ? 'OVERWRITE' : 'INSERT'}
        </button>
        <button className="timeline__mode-btn" onClick={handleZoomFit} data-tooltip="Zoom to fit project">
          FIT
        </button>
        <button className="panel__header-btn" onClick={handleSplitAtPlayhead} data-tooltip="Split at Playhead (S)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M6 1v10M2 3l4 3-4 3" /></svg>
        </button>
        <button className="panel__header-btn" onClick={() => addTrack('video')} data-tooltip="Add Video Track">
          <IconPlus />
        </button>
        <button className="panel__header-btn" onClick={() => addTrack('audio')} data-tooltip="Add Audio Track">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 4v4M6 2v8M9 4v4" /></svg>
        </button>
      </div>

      {!collapsed && (
        <div className="timeline__container">
          {/* ── Ruler ── */}
          <div className="timeline__ruler-area">
            <div className="timeline__track-header-spacer" />
            <div
              className="timeline__ruler"
              ref={rulerRef}
              onMouseDown={beginScrub}
            >
              <div className="timeline__ruler-marks" style={{ transform: `translateX(-${timelineScrollLeft}px)` }}>
                {generateBeatLines()}
                {generateRulerMarks()}
              </div>
              {/* Loop Highlight and Markers */}
              <div
                className="timeline__loop-highlight"
                style={{
                  left: `${inPoint * pxPerSec - timelineScrollLeft}px`,
                  width: `${(outPoint - inPoint) * pxPerSec}px`
                }}
              />
              <div
                className="timeline__in-marker"
                style={{
                  left: `${inPoint * pxPerSec - timelineScrollLeft}px`
                }}
                onMouseDown={handleInMarkerMouseDown}
                title={`In Point: ${formatTimecode(inPoint)}`}
              />
              <div
                className="timeline__out-marker"
                style={{
                  left: `${outPoint * pxPerSec - timelineScrollLeft - 10}px`
                }}
                onMouseDown={handleOutMarkerMouseDown}
                title={`Out Point: ${formatTimecode(outPoint)}`}
              />
              {/* Markers (M drops one at the playhead; drag to move, Alt+click
                  to delete, double-click to rename) */}
              {markers.map(marker => (
                <div
                  key={marker.id}
                  className="timeline__marker"
                  style={{
                    left: `${marker.time * pxPerSec - timelineScrollLeft}px`,
                    borderTopColor: marker.color || '#ff3344',
                  }}
                  onMouseDown={(e) => handleMarkerMouseDown(e, marker)}
                  onDoubleClick={(e) => { e.stopPropagation(); handleMarkerRename(marker) }}
                  title={`${marker.label || 'Marker'} — ${formatTimecode(marker.time)} (drag to move, Alt+click to delete, double-click to rename)`}
                >
                  {marker.label && <span className="timeline__marker-label">{marker.label}</span>}
                </div>
              ))}
              {/* Playhead on ruler — draggable */}
              <TimelinePlayhead
                pxPerSec={pxPerSec}
                timelineScrollLeft={timelineScrollLeft}
                onGrab={handlePlayheadGrab}
                scrubbing={scrubbing}
              />
            </div>
          </div>

          {/* ── Keyframe lane (selected node) ── */}
          <KeyframeLane
            pxPerSec={pxPerSec}
            timelineScrollLeft={timelineScrollLeft}
            applySnap={applySnap}
            collectSnapPoints={collectSnapPoints}
          />

          {/* ── Tracks ── */}
          <div className="timeline__tracks-area" ref={tracksAreaRef}>
            {tracks.length === 0 && (
              <div className="timeline__empty">
                <p>No tracks — click + to add a track</p>
              </div>
            )}
            {displayTracks.map(track => {
              const trackClips = clips.filter(c => c.trackId === track.id)
              return (
                <div
                  key={track.id}
                  className={`timeline__track${draggingTrackId === track.id ? ' timeline__track--dragging' : ''}${selectedTrackId === track.id ? ' timeline__track--selected' : ''}`}
                  data-track-id={track.id}
                  data-track-type={track.type}
                >
                  {/* Track Header — drag to restack (↑/↓ moves it one place) */}
                  <div
                    className="timeline__track-header"
                    style={{ borderLeftColor: track.color }}
                    onMouseDown={(e) => handleTrackHeaderMouseDown(e, track)}
                    title={`${track.name} — drag to restack, ↑/↓ moves it one layer (higher rows render in front)`}
                  >
                    <span className="timeline__track-grip" aria-hidden="true" />
                    <span className="timeline__track-name">{track.name}</span>
                    <div className="timeline__track-controls">
                      <button
                        className={`timeline__track-btn ${track.muted ? 'timeline__track-btn--active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleMute(track.id) }}
                        data-tooltip="Mute"
                      >
                        M
                      </button>
                      <button
                        className={`timeline__track-btn ${track.solo ? 'timeline__track-btn--active timeline__track-btn--solo' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleSolo(track.id) }}
                        data-tooltip="Solo"
                      >
                        S
                      </button>
                      <button
                        className={`timeline__track-btn ${track.locked ? 'timeline__track-btn--active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleLock(track.id) }}
                        data-tooltip="Lock"
                      >
                        <IconLock size={10} />
                      </button>
                    </div>
                    <div className="timeline__track-type" style={{ color: track.color }}>
                      {track.type === 'video' ? 'V' : 'A'}
                    </div>
                  </div>

                  {/* Track Clip Region */}
                  <div
                    className="timeline__track-clips"
                    onDragOver={(e) => handleTrackDragOver(e, track)}
                    onDragLeave={handleTrackDragLeave}
                    onDrop={(e) => handleTrackDrop(e, track)}
                  >
                    <div style={{ transform: `translateX(-${timelineScrollLeft}px)`, position: 'relative', height: '100%' }}>
                      {trackClips.map(clip => {
                        const left = clip.timelineStart * pxPerSec
                        const width = (clip.timelineEnd - clip.timelineStart) * pxPerSec
                        const hasGraph = clipGraphs[clip.id] && clipGraphs[clip.id].nodes.length > 2
                        const isTrimming = trimming?.clipId === clip.id
                        // Fade overlays / handles show for any composited visual
                        // clip (video/camera/screen + text/image generators); the
                        // compositor's opacity ramp applies to all of them.
                        const isVideoClip = clip.fileType === 'video' || clip.fileType === 'camera' || clip.fileType === 'screen'
                        const supportsFades = isVideoClip || clip.fileType === 'image' || clip.fileType === 'text' || clip.fileType === 'shape'
                        // Wedge lengths come from edgeDisplaySeconds, which
                        // resolves the region-vs-ramp question the same way the
                        // compositor does — so the wedge is always exactly the
                        // window that will actually be processed.
                        const headR = supportsFades ? headRegion(clip, findPrevOverlap(clip, clips)) : null
                        const tailR = supportsFades ? tailRegion(clip, findNextOverlap(clip, clips)) : null
                        const headFx = supportsFades && edgeHasEffect(clip, EDGE_HEAD, headR)
                        const tailFx = supportsFades && edgeHasEffect(clip, EDGE_TAIL, tailR)
                        const fadeInW = Math.min(width, edgeDisplaySeconds(clip, EDGE_HEAD, headR) * pxPerSec)
                        const fadeOutW = Math.min(width, edgeDisplaySeconds(clip, EDGE_TAIL, tailR) * pxPerSec)
                        // Which edge a transition being dragged over would land
                        // on. Shown as a lit band so the drop is aimed rather
                        // than guessed — the two edges of one clip are a single
                        // pointer target otherwise.
                        const dropEdge = transitionDrop?.clipId === clip.id ? transitionDrop.edge : null
                        return (
                          <div
                            key={clip.id}
                            className={`timeline__clip ${selectedClipId === clip.id ? 'timeline__clip--selected' : ''} ${draggingClip === clip.id ? 'timeline__clip--dragging' : ''} ${isTrimming ? 'timeline__clip--trimming' : ''}`}
                            style={{
                              left,
                              width: Math.max(4, width),
                              backgroundColor: `${track.color}22`,
                              borderColor: `${track.color}55`,
                            }}
                            onMouseDown={(e) => handleClipMouseDown(e, clip)}
                            onContextMenu={(e) => openClipMenu(e, clip)}
                            onDoubleClick={() => {
                              enterClipGraph(clip.id)
                              setPlayheadTime(clip.timelineStart)
                            }}
                          >
                            {dropEdge && (
                              <div
                                className={`timeline__clip-drop-edge timeline__clip-drop-edge--${dropEdge === EDGE_TAIL ? 'out' : 'in'}`}
                              />
                            )}
                            {/* Left trim handle */}
                            <div
                              className="timeline__clip-trim timeline__clip-trim--left"
                              onMouseDown={(e) => handleTrimMouseDown(e, clip, 'left')}
                            />
                            {/* Right trim handle */}
                            <div
                              className="timeline__clip-trim timeline__clip-trim--right"
                              onMouseDown={(e) => handleTrimMouseDown(e, clip, 'right')}
                            />
                            {/* Image clips show a faded thumbnail behind the label. */}
                            {clip.fileType === 'image' && clip.params?.imageSrc && (
                              <img
                                className="timeline__clip-thumb"
                                src={clip.params.imageSrc}
                                alt=""
                                draggable={false}
                                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35, pointerEvents: 'none', borderRadius: 'inherit' }}
                              />
                            )}
                            {/* Edge regions. Plain ramp = shaded wedge + diagonal.
                                A region owned by a transition is tinted and drops
                                the diagonal (the ramp isn't what's happening any
                                more) and names its effect, so you can read the
                                whole edge model straight off the timeline. */}
                            {fadeInW > 1 && (
                              <svg
                                className={`timeline__clip-fade ${headFx ? 'timeline__clip-fade--transition' : ''}`}
                                style={{ left: 0, width: fadeInW }}
                                viewBox="0 0 1 1"
                                preserveAspectRatio="none"
                              >
                                <polygon points="0,0 1,0 0,1" />
                                {!headFx && <line x1="0" y1="1" x2="1" y2="0" vectorEffect="non-scaling-stroke" />}
                              </svg>
                            )}
                            {fadeOutW > 1 && (
                              <svg
                                className={`timeline__clip-fade ${tailFx ? 'timeline__clip-fade--transition' : ''}`}
                                style={{ right: 0, width: fadeOutW }}
                                viewBox="0 0 1 1"
                                preserveAspectRatio="none"
                              >
                                <polygon points="0,0 1,0 1,1" />
                                {!tailFx && <line x1="0" y1="0" x2="1" y2="1" vectorEffect="non-scaling-stroke" />}
                              </svg>
                            )}
                            {headFx && fadeInW > 34 && (
                              <div className="timeline__clip-edge-label" style={{ left: 3, maxWidth: fadeInW - 6 }}>
                                {edgeEffectLabel(clip, EDGE_HEAD)}
                              </div>
                            )}
                            {tailFx && fadeOutW > 34 && (
                              <div className="timeline__clip-edge-label" style={{ right: 3, maxWidth: fadeOutW - 6, textAlign: 'right' }}>
                                {edgeEffectLabel(clip, EDGE_TAIL)}
                              </div>
                            )}
                            {/* Region handles (visible on hover/selection). The
                                head handle is hidden only while a CROSSFADE is
                                actually running there: the overlap sets that
                                length, so a handle editing fadeIn would move
                                nothing visible and read as broken. Move either
                                clip to retime a crossfade. */}
                            {supportsFades && width > 24 && (
                              <>
                                {!(headFx && headR?.mode === 'crossfade') && (
                                  <div
                                    className="timeline__clip-fade-handle"
                                    style={{ left: Math.max(1, Math.min(width - 11, fadeInW - 5)) }}
                                    onMouseDown={(e) => handleFadeMouseDown(e, clip, 'in')}
                                    title={`Transition in: ${(clip.fadeIn || 0).toFixed(2)}s (${edgeEffectLabel(clip, EDGE_HEAD)}) — drag to retime, right-click the wedge to change the effect`}
                                  />
                                )}
                                <div
                                  className="timeline__clip-fade-handle"
                                  style={{ left: Math.max(1, Math.min(width - 11, width - fadeOutW - 5)) }}
                                  onMouseDown={(e) => handleFadeMouseDown(e, clip, 'out')}
                                  title={`Transition out: ${(clip.fadeOut || 0).toFixed(2)}s (${edgeEffectLabel(clip, EDGE_TAIL)}) — drag to retime, right-click the wedge to change the effect`}
                                />
                              </>
                            )}
                            <div className="timeline__clip-header" style={{ backgroundColor: `${track.color}33` }}>
                              {clip.reversed && (
                                <span
                                  className="timeline__clip-reversed"
                                  title="Reversed — plays the source backwards (preview audio is silent; the export renders reversed audio)"
                                >
                                  ◀
                                </span>
                              )}
                              <span className="timeline__clip-name">{clip.filename}</span>
                              {clip.speed && clip.speed !== 1 && (
                                <span className="timeline__clip-speed mono">{clip.speed.toFixed(1)}×</span>
                              )}
                            </div>
                            {/* Audio waveform (real peaks, decoded once per file) */}
                            {clip.fileType === 'audio' && (
                              <ClipWaveform clip={clip} width={Math.max(4, width)} color={track.color} />
                            )}
                            {(hasGraph || clip.hasEffects) && (
                              <div className="timeline__clip-fx-badge" style={{ color: track.color }}>FX</div>
                            )}
                            {/* Add-transition hotspots. Appear on hover at each
                                end of the clip and apply the default transition
                                in one click — the equivalent of dropping the
                                default onto a cut in Premiere/Resolve. They sit
                                exactly where the invisible right-click edge zone
                                is (EDGE_HIT_PX), so hovering teaches you where
                                to right-click. Hidden once that edge already
                                carries an effect: the wedge is the affordance
                                from then on. */}
                            {supportsFades && width > 3 * EDGE_HIT_PX && (
                              <>
                                {!headFx && (
                                  <button
                                    className="timeline__clip-edge-add timeline__clip-edge-add--in"
                                    title={`Add ${defaultTransitionLabel} to this clip's start (T)`}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={(e) => { e.stopPropagation(); applyDefaultTransition(clip.id, EDGE_HEAD) }}
                                  >⇄</button>
                                )}
                                {!tailFx && (
                                  <button
                                    className="timeline__clip-edge-add timeline__clip-edge-add--out"
                                    title={`Add ${defaultTransitionLabel} to this clip's end (T)`}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={(e) => { e.stopPropagation(); applyDefaultTransition(clip.id, EDGE_TAIL) }}
                                  >⇄</button>
                                )}
                              </>
                            )}
                            {/* Fallback marker for wedges too narrow to fit a label. */}
                            {((headFx && fadeInW <= 34) || (tailFx && fadeOutW <= 34)) && (
                              <div
                                className="timeline__clip-transition-badge"
                                title={`Edge transitions — in: ${edgeEffectLabel(clip, EDGE_HEAD)}, out: ${edgeEffectLabel(clip, EDGE_TAIL)}`}
                              >⇄</div>
                            )}
                            {clip.audioMuted && (
                              <div className="timeline__clip-audio-muted" title="Clip audio muted">♪×</div>
                            )}
                            {/* Keyframe diamonds (clip-relative key times, all params merged) */}
                            {keyframes.some(k => k.clipId === clip.id) && (
                              <div className="timeline__clip-keyframes">
                                {[...new Set(
                                  keyframes
                                    .filter(k => k.clipId === clip.id)
                                    .flatMap(k => k.keys.map(key => Math.round(key.time * 1000)))
                                )].map(ms => (
                                  <div
                                    key={ms}
                                    className={`timeline__keyframe ${draggingKf?.clipId === clip.id && draggingKf?.ms === ms ? 'timeline__keyframe--dragging' : ''}`}
                                    style={{ left: (ms / 1000) * pxPerSec, bottom: 3 }}
                                    title={`Keyframe @ ${(ms / 1000).toFixed(2)}s (clip time) — drag to move, Shift bypasses snap, Alt+click to delete`}
                                    onMouseDown={(e) => handleKeyframeMouseDown(e, clip, ms)}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            })}

            {/* Playhead line across all tracks */}
            <TimelinePlayheadLine
              pxPerSec={pxPerSec}
              timelineScrollLeft={timelineScrollLeft}
              trackHeaderWidth={TRACK_HEADER_W}
            />
          </div>
        </div>
      )}

      {clipMenu && menuClip && (
        <ContextMenu
          x={clipMenu.x}
          y={clipMenu.y}
          header={clipMenuHeader}
          items={clipMenuItems}
          onClose={closeClipMenu}
        />
      )}
    </>
  )
}

/**
 * Real waveform for an audio clip: canvas of mirrored peak bars covering the
 * clip's source range. Decodes once per file (waveformCache); shows nothing
 * until peaks are ready (the clip body itself is the placeholder).
 */
function ClipWaveform({ clip, width, color }) {
  const canvasRef = useRef(null)
  const wf = useWaveform(clip.fileUrl)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !wf || !wf.peaks || wf.duration <= 0) return
    const w = Math.max(1, Math.round(width))
    const h = 26
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = color || '#00e5ff'
    ctx.globalAlpha = 0.75

    const { peaks, duration } = wf
    const srcStart = Math.max(0, clip.sourceStart || 0)
    const srcEnd = Math.min(duration, clip.sourceEnd || duration)
    const srcSpan = Math.max(0.001, srcEnd - srcStart)
    const mid = h / 2
    for (let x = 0; x < w; x += 2) {
      // Reversed clips read the source tail-first, so the drawn waveform has to
      // mirror too — otherwise the peaks wouldn't line up with what you hear.
      const t = clip.reversed
        ? srcEnd - (x / w) * srcSpan
        : srcStart + (x / w) * srcSpan
      const bucket = Math.min(peaks.length - 1, Math.floor((t / duration) * peaks.length))
      const p = peaks[bucket] || 0
      const barH = Math.max(1, p * (h - 2))
      ctx.fillRect(x, mid - barH / 2, 1.5, barH)
    }
  }, [wf, width, color, clip.sourceStart, clip.sourceEnd, clip.reversed])

  if (!wf) return null
  return <canvas ref={canvasRef} className="timeline__clip-waveform-canvas" />
}

/**
 * m:ss, with sub-second precision only when the caller says the context is that
 * fine (`step` = the ruler's label spacing). Zoomed past ~1s per label, every
 * mark used to print the same whole second.
 *
 * Truncates rather than rounds — `toFixed(0)` on 59.7 gives "60", i.e. "1:60".
 */
function formatTimecode(seconds, step = 1) {
  const neg = seconds < 0
  const abs = Math.abs(seconds) + 1e-6 // absorb i*step float drift
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  const p = Math.pow(10, decimals)
  const m = Math.floor(abs / 60)
  const rest = Math.floor((abs - m * 60) * p) / p
  const width = decimals ? 3 + decimals : 2
  return `${neg ? '-' : ''}${m}:${rest.toFixed(decimals).padStart(width, '0')}`
}

/**
 * Playhead head on the ruler. The marker itself is a zero-width div whose arrow
 * and stem are pseudo-elements — about 10×6px of hit area, which is not a
 * draggable thing — so the interactive part is an explicit grab strip child.
 * The marker is `pointer-events: none` and only the strip is `auto`, which also
 * stops the arrow from silently swallowing ruler presses next to it.
 */
function TimelinePlayhead({ pxPerSec, timelineScrollLeft, onGrab, scrubbing }) {
  const playheadTime = useAppStore(s => s.playheadTime)
  const playheadX = playheadTime * pxPerSec
  return (
    <div
      className={`timeline__playhead-marker${scrubbing ? ' timeline__playhead-marker--dragging' : ''}`}
      style={{ left: `${playheadX - timelineScrollLeft}px` }}
    >
      <div
        className="timeline__playhead-grab"
        onMouseDown={onGrab}
        title="Drag to scrub — Shift bypasses snapping"
      />
    </div>
  )
}

// The line across the tracks stays non-interactive on purpose: a grab strip here
// would sit on top of clips wherever the playhead crosses one and steal their
// drag/select presses. The ruler above is the scrub surface (as in Premiere and
// Resolve).
function TimelinePlayheadLine({ pxPerSec, timelineScrollLeft, trackHeaderWidth }) {
  const playheadTime = useAppStore(s => s.playheadTime)
  const playheadX = playheadTime * pxPerSec
  return (
    <div
      className="timeline__playhead-line"
      style={{ left: `${trackHeaderWidth + playheadX - timelineScrollLeft}px` }}
    />
  )
}

/**
 * Keyframe lane — shows the SELECTED node's keyframes as one draggable diamond
 * per key, grouped by param (one row each). Works for both master-graph
 * (absolute time) and clip-graph (clip-relative, offset by the clip's start)
 * params, so master keyframes are finally visible/editable. Per-key drag
 * (snap-aware, Shift bypasses), Alt+click deletes a single key, and right-click
 * opens Clear-keyframe options. (No Delete-key handler here on purpose: the node
 * editor's global Delete listener would also fire and remove the selected node.)
 */
function KeyframeLane({ pxPerSec, timelineScrollLeft, applySnap, collectSnapPoints }) {
  const selectedNodeId = useAppStore(s => s.selectedNodeId)
  const graphLevel = useAppStore(s => s.graphLevel)
  const graphClipId = useAppStore(s => s.graphClipId)
  const keyframes = useTimelineStore(s => s.keyframes)
  const clips = useTimelineStore(s => s.clips)
  const moveKeyframe = useTimelineStore(s => s.moveKeyframe)
  const removeKeyframe = useTimelineStore(s => s.removeKeyframe)
  const clearParamKeyframes = useTimelineStore(s => s.clearParamKeyframes)
  const clearNodeKeyframes = useTimelineStore(s => s.clearNodeKeyframes)
  const masterGraph = useGraphStore(s => s.masterGraph)
  const clipGraphs = useGraphStore(s => s.clipGraphs)

  const [selectedKey, setSelectedKey] = useState(null) // { paramName, time }
  const [menu, setMenu] = useState(null) // { x, y, paramName, time }

  const clipKey = graphLevel === 'master' ? 'master' : graphClipId
  const baseClip = graphLevel === 'master' ? null : clips.find(c => c.id === clipKey)
  const base = baseClip ? baseClip.timelineStart : 0
  const duration = baseClip ? (baseClip.timelineEnd - baseClip.timelineStart) : Infinity
  const tracks = selectedNodeId
    ? keyframes.filter(k => k.clipId === clipKey && k.nodeId === selectedNodeId)
    : []
  const graph = graphLevel === 'master' ? masterGraph : clipGraphs[clipKey]
  const node = graph?.nodes.find(n => n.id === selectedNodeId)
  const nodeName = node?.name || node?.type || 'Node'

  // Nothing to show unless a node is selected (and, for clips, the clip exists).
  if (!selectedNodeId || (graphLevel !== 'master' && !baseClip)) return null

  const startDrag = (e, paramName, time) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.altKey) { removeKeyframe(clipKey, selectedNodeId, paramName, time); return }
    setSelectedKey({ paramName, time })
    const startX = e.clientX
    const snapPoints = collectSnapPoints()
    let curTime = time
    const onMove = (me) => {
      const dt = (me.clientX - startX) / pxPerSec
      const absSnapped = applySnap(base + time + dt, snapPoints, me.shiftKey)
      let rel = absSnapped - base
      rel = Math.max(0, duration === Infinity ? rel : Math.min(duration, rel))
      moveKeyframe(clipKey, selectedNodeId, paramName, curTime, rel)
      curTime = rel
      setSelectedKey({ paramName, time: rel })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const openMenu = (e, paramName, time) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedKey({ paramName, time })
    setMenu({ x: e.clientX, y: e.clientY, paramName, time })
  }

  return (
    <div className="timeline__kf-lane">
      <div className="timeline__kf-lane-header" title={`Keyframes for ${nodeName}`}>
        <span className="timeline__kf-lane-title">◆ {nodeName}</span>
      </div>
      <div className="timeline__kf-lane-body">
        {tracks.length === 0 ? (
          <div className="timeline__kf-lane-empty">
            No keyframes on this node — add one with the ◆ button in the Inspector
          </div>
        ) : (
          tracks.map(tr => (
            <div className="timeline__kf-row" key={tr.paramName}>
              <span className="timeline__kf-row-label">{tr.paramName}</span>
              {tr.keys.map(key => {
                const isSel = selectedKey?.paramName === tr.paramName &&
                  Math.abs(selectedKey.time - key.time) < 1e-4
                return (
                  <div
                    key={key.time}
                    className={`timeline__kf-key ${isSel ? 'timeline__kf-key--selected' : ''}`}
                    style={{ left: (base + key.time) * pxPerSec - timelineScrollLeft }}
                    title={`${tr.paramName} = ${Number(key.value).toFixed(3)} @ ${(base + key.time).toFixed(2)}s — drag to move (Shift = no snap), Alt+click to delete, right-click for options`}
                    onMouseDown={(e) => startDrag(e, tr.paramName, key.time)}
                    onContextMenu={(e) => openMenu(e, tr.paramName, key.time)}
                  />
                )
              })}
            </div>
          ))
        )}
      </div>

      {menu && (
        <>
          <div className="timeline__kf-menu-overlay" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="timeline__kf-menu" style={{ left: menu.x, top: menu.y }}>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={() => { removeKeyframe(clipKey, selectedNodeId, menu.paramName, menu.time); setMenu(null); setSelectedKey(null) }}>
              Delete keyframe
            </button>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={() => { clearParamKeyframes(clipKey, selectedNodeId, menu.paramName); setMenu(null); setSelectedKey(null) }}>
              Clear “{menu.paramName}” keyframes
            </button>
            <button onMouseDown={(e) => e.stopPropagation()} onClick={() => { clearNodeKeyframes(clipKey, selectedNodeId); setMenu(null); setSelectedKey(null) }}>
              Clear all keyframes on {nodeName}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
