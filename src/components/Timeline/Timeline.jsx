import { useState, useRef, useCallback, useEffect } from 'react'
import { useWaveform } from '../../utils/waveformCache'
import useTimelineStore from '../../store/useTimelineStore'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import { IconChevronDown, IconPlus, IconLock } from '../common/Icons'
import ContextMenu from '../common/ContextMenu'
import { makeImageClipParams, makeTextClipParams, makeShapeClipParams, DEFAULT_GENERATOR_DURATION } from '../../utils/generatorClips'
import {
  EDGE_HEAD, EDGE_TAIL, edgeLabel, getEdgeTransition, setEdgeTransitionPatch,
  findPrevOverlap, findNextOverlap, headRegion, tailRegion,
  edgeHasEffect, edgeDisplaySeconds,
  transitionGraphKey, GRAPH_TYPE, isGraphType, isCompoundType, compoundIdOf,
} from '../../utils/clipTransitions'
import { TRANSITION_TYPES, getTransitionLabel, getTransitionDefaults } from '../../shaders/transitionRegistry'
import { isTransitionCompound } from '../../utils/compoundUtils'
import './Timeline.css'

// Default length given to an edge with no region yet when the user assigns a
// transition to it. Without this, picking an effect on a clip whose fade handle
// is still at zero would appear to do nothing at all.
const DEFAULT_EDGE_SECONDS = 1

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
  const enterClipGraph = useAppStore(s => s.enterClipGraph)
  const clipGraphs = useGraphStore(s => s.clipGraphs)
  const initClipGraph = useGraphStore(s => s.initClipGraph)
  const compoundLibrary = useGraphStore(s => s.compoundLibrary)

  const pxPerSec = 80 * timelineZoom
  const TRACK_HEADER_W = 160

  // Click on ruler to set playhead
  const handleRulerClick = useCallback((e) => {
    const rect = rulerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left + timelineScrollLeft
    const time = Math.max(0, x / pxPerSec)
    setPlayheadTime(time)
  }, [timelineScrollLeft, pxPerSec, setPlayheadTime])

  // Zoom via scroll, pan via Shift+scroll
  const handleRulerWheel = useCallback((e) => {
    if (e.shiftKey) {
      // Shift+scroll = horizontal pan
      setTimelineScrollLeft(timelineScrollLeft + e.deltaX + e.deltaY)
    } else {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setTimelineZoom(timelineZoom * delta)
    }
  }, [timelineZoom, timelineScrollLeft, setTimelineZoom, setTimelineScrollLeft])

  // Zoom to fit — scale so the whole project fills the visible ruler width and
  // reset the scroll. This is the standard "fit sequence to window" control found
  // in professional NLEs/DAWs (Premiere/Resolve's `\`, etc.).
  const handleZoomFit = useCallback(() => {
    const el = rulerRef.current
    if (!el) return
    const width = el.clientWidth
    const dur = calculateDuration() || 30
    if (width <= 0 || dur <= 0) return
    const targetZoom = (width - 24) / (dur * 80) // 80 = base px/sec
    setTimelineZoom(targetZoom)
    setTimelineScrollLeft(0)
  }, [calculateDuration, setTimelineZoom, setTimelineScrollLeft])

  // Attach native wheel listeners because React 18 makes onWheel passive,
  // which silently prevents e.preventDefault() from working.
  useEffect(() => {
    const el = rulerRef.current
    if (!el) return
    el.addEventListener('wheel', handleRulerWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleRulerWheel)
  }, [handleRulerWheel])

  useEffect(() => {
    const el = tracksAreaRef.current
    if (!el) return
    el.addEventListener('wheel', handleRulerWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleRulerWheel)
  }, [handleRulerWheel])

  // ── Beat grid lines (beats faint, bars strong) ──
  // Rendered inside the same translated container as the ruler marks. Beats are
  // skipped when they'd be denser than ~7px so zoomed-out views stay readable.
  const generateBeatLines = () => {
    if (!beatGridEnabled || !bpm || bpm <= 0) return null
    const app = useAppStore.getState()
    const spb = 60 / bpm // seconds per beat
    const beatPx = spb * pxPerSec
    if (beatPx < 3) return null
    const showBeats = beatPx >= 7
    const lines = []
    const totalSeconds = Math.max(300, Math.ceil(projectDuration * 1.1))
    const startBeat = Math.max(0, Math.floor((timelineScrollLeft / pxPerSec - app.beatOffset) / spb) - 1)
    const endTime = (timelineScrollLeft + 2500) / pxPerSec
    for (let b = startBeat; ; b++) {
      const t = app.beatOffset + b * spb
      if (t > endTime || t > totalSeconds) break
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

  // Generate ruler time marks
  const generateRulerMarks = () => {
    const marks = []
    // Determine spacing based on zoom
    let interval = 1 // seconds between marks
    if (pxPerSec < 20) interval = 10
    else if (pxPerSec < 40) interval = 5
    else if (pxPerSec < 80) interval = 2
    else if (pxPerSec > 300) interval = 0.5

    // Span the whole project (plus headroom), not a fixed 5 minutes, so long
    // songs get ruler marks across their full length. Off-screen marks are
    // skipped below, so this stays cheap regardless of duration.
    const totalSeconds = Math.max(300, Math.ceil(projectDuration * 1.1))
    for (let s = 0; s <= totalSeconds; s += interval) {
      const x = s * pxPerSec
      if (x < timelineScrollLeft - 100 || x > timelineScrollLeft + 2500) continue

      const isMinor = (s * 10) % 50 !== 0
      marks.push(
        <div
          key={s}
          className={`timeline__ruler-mark ${isMinor ? '' : 'timeline__ruler-mark--major'}`}
          style={{ left: x }}
        >
          {!isMinor && (
            <span className="timeline__ruler-label mono">
              {formatTimecode(s)}
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
  const collectSnapPoints = useCallback((excludeClipId = null) => {
    const state = useTimelineStore.getState()
    const pts = [0, useAppStore.getState().playheadTime]
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
  const handleTrackDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/dalivid-drag')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleTrackDrop = useCallback((e, track) => {
    const raw = e.dataTransfer.getData('application/dalivid-drag')
    if (!raw) return
    let payload
    try { payload = JSON.parse(raw) } catch { return }

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
  }, [pxPerSec, timelineScrollLeft, addClip, initClipGraph, selectClip])

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
    const t = clip.timelineStart + ((e.clientX - rect.left) / Math.max(1, rect.width)) *
      (clip.timelineEnd - clip.timelineStart)

    let edge = null
    if (headSecs > 0 && t < clip.timelineStart + headSecs) edge = EDGE_HEAD
    else if (tailSecs > 0 && t >= clip.timelineEnd - tailSecs) edge = EDGE_TAIL

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
  const setMenuView = useCallback((view, edge) => {
    setClipMenu(m => (m ? { ...m, view, edge: edge || m.edge } : m))
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
    const all = useTimelineStore.getState().clips
    return edge === EDGE_TAIL
      ? tailRegion(clip, findNextOverlap(clip, all))
      : headRegion(clip, findPrevOverlap(clip, all))
  }, [])

  /**
   * Assign an effect to one edge. Two things have to happen together or the
   * result looks broken: the region needs a non-zero length (assigning a
   * transition to an edge whose handle is still at 0 would otherwise be a
   * no-op), and a 'graph' type needs its graph to exist before the renderer
   * looks for it.
   */
  const setEdgeType = useCallback((clip, edge, type) => {
    const patch = {}

    // Give the edge a default length if it has none. A head region backed by an
    // overlap already has its length from the overlap, so it's left alone.
    const region = edgeRegionOf(clip, edge)
    if (!region) {
      const maxLen = Math.max(0.1, (clip.timelineEnd - clip.timelineStart) / 2)
      const len = Math.min(DEFAULT_EDGE_SECONDS, maxLen)
      patch[edge === EDGE_TAIL ? 'fadeOut' : 'fadeIn'] = len
    }

    if (!type) {
      // "Fade" — hand the window back to the plain opacity ramp. The private
      // graph is deliberately kept: switching effects to compare them shouldn't
      // throw away a graph the user built.
      Object.assign(patch, setEdgeTransitionPatch(edge, null))
      updateClip(clip.id, patch)
      return
    }

    if (isGraphType(type)) {
      const key = transitionGraphKey(clip.id, edge)
      if (!useGraphStore.getState().clipGraphs[key]) {
        // Seed from the compound this edge was already using, if any, so
        // "Crossfade → Node Graph" opens on the thing you were just looking at.
        const prev = getEdgeTransition(clip, edge)
        const seed = isCompoundType(prev?.type)
          ? compoundLibrary.find(c => c.id === compoundIdOf(prev.type))?.subGraph
          : null
        useGraphStore.getState().initTransitionGraph(clip.id, edge, seed || null)
      }
      Object.assign(patch, setEdgeTransitionPatch(edge, { type: GRAPH_TYPE, params: {} }))
    } else {
      // Built-ins start from their registry defaults; compounds start empty —
      // the library entry's exposedParams carry their own defaults.
      const params = isCompoundType(type) ? {} : getTransitionDefaults(type)
      Object.assign(patch, setEdgeTransitionPatch(edge, { type, params }))
    }

    updateClip(clip.id, patch)
  }, [updateClip, edgeRegionOf, compoundLibrary])

  /** Open this edge's node graph in the editor, converting to one if needed. */
  const openEdgeGraph = useCallback((clip, edge) => {
    const tr = getEdgeTransition(clip, edge)
    if (!isGraphType(tr?.type)) setEdgeType(clip, edge, GRAPH_TYPE)

    // Park the playhead mid-region so the editor opens on the transition
    // half-way through — the frame where you can actually see what it does.
    // Read the region AFTER setEdgeType, which may have just created it.
    const clipNow = useTimelineStore.getState().clips.find(c => c.id === clip.id) || clip
    const region = edgeRegionOf(clipNow, edge)
    if (region) setPlayheadTime(region.start + region.dur * 0.5)

    enterClipGraph(transitionGraphKey(clip.id, edge))
  }, [setEdgeType, edgeRegionOf, enterClipGraph, setPlayheadTime])

  /** Clear the edge entirely: no effect, no ramp, no graph. */
  const clearEdge = useCallback((clip, edge) => {
    updateClip(clip.id, {
      ...setEdgeTransitionPatch(edge, null),
      [edge === EDGE_TAIL ? 'fadeOut' : 'fadeIn']: 0,
    })
    useGraphStore.getState().removeTransitionGraph(clip.id, edge)
  }, [updateClip])

  const promoteEdgeGraph = useCallback((clip, edge) => {
    const name = `${clip.filename || 'Clip'} ${edgeLabel(edge)}`
    useGraphStore.getState().promoteTransitionGraph(clip.id, edge, name)
  }, [])

  // Built fresh each render from live clip state, so a toggle (Reverse, Mute)
  // updates its own ✓ without closing the menu.
  const menuClip = clipMenu ? clips.find(c => c.id === clipMenu.clipId) : null
  // Library compounds usable as a transition (≥ 2 image inputs to bind FROM/TO).
  const transitionCompounds = compoundLibrary.filter(isTransitionCompound)

  /** Human name for whatever effect an edge currently carries. */
  const edgeEffectLabel = (clip, edge) => {
    const tr = getEdgeTransition(clip, edge)
    if (!tr?.type) return 'Fade (opacity ramp)'
    if (isGraphType(tr.type)) return 'Node Graph (this clip)'
    if (isCompoundType(tr.type)) {
      return compoundLibrary.find(c => c.id === compoundIdOf(tr.type))?.name || 'Missing compound'
    }
    return getTransitionLabel(tr.type)
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
  const edgeTypeMenuItems = (clip, edge) => {
    const current = getEdgeTransition(clip, edge)?.type || null
    const items = [{
      label: 'Fade (opacity ramp)',
      icon: '◺',
      checked: !current,
      hint: 'The default — a straight linear ramp across the region',
      onSelect: () => setEdgeType(clip, edge, null),
    }, { separator: true }]

    for (const t of TRANSITION_TYPES) {
      items.push({
        label: getTransitionLabel(t),
        icon: '⇄',
        checked: current === t,
        onSelect: () => setEdgeType(clip, edge, t),
      })
    }

    items.push({ separator: true })
    items.push({
      label: 'Node Graph (this clip)',
      icon: '❖',
      checked: isGraphType(current),
      hint: 'A graph owned by this clip edge — edit it without touching anything else',
      onSelect: () => openEdgeGraph(clip, edge),
    })
    for (const c of transitionCompounds) {
      items.push({
        label: c.name,
        icon: '❖',
        checked: current === `compound:${c.id}`,
        hint: c.description || 'Shared transition from the compound library',
        onSelect: () => setEdgeType(clip, edge, `compound:${c.id}`),
      })
    }
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
    if (clipMenu.view === 'edgeType') return `${edgeLabel(clipMenu.edge)} effect · ${name}`
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

        // = / + — zoom in,  - / _ — zoom out
        case 'Equal':
        case 'NumpadAdd':
          e.preventDefault(); setTimelineZoom(timelineZoom * 1.25)
          break
        case 'Minus':
        case 'NumpadSubtract':
          e.preventDefault(); setTimelineZoom(timelineZoom * 0.8)
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
      timelineZoom, setTimelineZoom, setInPoint, setOutPoint, clearInOutPoints,
      addMarker, inPoint, outPoint, setPlayheadTime])



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
              onClick={handleRulerClick}
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
              {/* Playhead on ruler */}
              <TimelinePlayhead pxPerSec={pxPerSec} timelineScrollLeft={timelineScrollLeft} />
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
            {tracks.map(track => {
              const trackClips = clips.filter(c => c.trackId === track.id)
              return (
                <div key={track.id} className="timeline__track" data-track-id={track.id} data-track-type={track.type}>
                  {/* Track Header */}
                  <div
                    className="timeline__track-header"
                    style={{ borderLeftColor: track.color }}
                    onClick={() => selectTrack(track.id)}
                  >
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
                    onDragOver={handleTrackDragOver}
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

function formatTimecode(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function TimelinePlayhead({ pxPerSec, timelineScrollLeft }) {
  const playheadTime = useAppStore(s => s.playheadTime)
  const playheadX = playheadTime * pxPerSec
  return (
    <div
      className="timeline__playhead-marker"
      style={{ left: `${playheadX - timelineScrollLeft}px` }}
    />
  )
}

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
