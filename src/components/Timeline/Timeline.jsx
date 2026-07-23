import { useState, useRef, useCallback, useEffect } from 'react'
import { useWaveform } from '../../utils/waveformCache'
import useTimelineStore from '../../store/useTimelineStore'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import { IconChevronDown, IconPlus, IconLock } from '../common/Icons'
import { makeImageClipParams, makeTextClipParams, DEFAULT_GENERATOR_DURATION } from '../../utils/generatorClips'
import './Timeline.css'

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
  const timelineZoom = useTimelineStore(s => s.timelineZoom)
  const setTimelineZoom = useTimelineStore(s => s.setTimelineZoom)
  const timelineScrollLeft = useTimelineStore(s => s.timelineScrollLeft)
  const setTimelineScrollLeft = useTimelineStore(s => s.setTimelineScrollLeft)
  const keyframes = useTimelineStore(s => s.keyframes)
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

    // A drop makes a generator CLIP. Media-Pool image cards and text-preset cards
    // both land here; node-graph drags (kind:'node' with no image) are ignored.
    const clipType = payload.clipType
      || (payload.imageSrc ? 'image' : null)
      || (payload.nodeType === 'IMAGE_INPUT' ? 'image' : null)
      || (payload.nodeType === 'TEXT_INPUT' ? 'text' : null)
    if ((clipType !== 'image' && clipType !== 'text') || track.type !== 'video') return

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
                        const supportsFades = isVideoClip || clip.fileType === 'image' || clip.fileType === 'text'
                        const fadeInW = Math.min(width, (clip.fadeIn || 0) * pxPerSec)
                        const fadeOutW = Math.min(width, (clip.fadeOut || 0) * pxPerSec)
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
                            {/* Fade ramps: shaded wedge = attenuated region, diagonal = the opacity ramp */}
                            {supportsFades && fadeInW > 1 && (
                              <svg
                                className="timeline__clip-fade"
                                style={{ left: 0, width: fadeInW }}
                                viewBox="0 0 1 1"
                                preserveAspectRatio="none"
                              >
                                <polygon points="0,0 1,0 0,1" />
                                <line x1="0" y1="1" x2="1" y2="0" vectorEffect="non-scaling-stroke" />
                              </svg>
                            )}
                            {supportsFades && fadeOutW > 1 && (
                              <svg
                                className="timeline__clip-fade"
                                style={{ right: 0, width: fadeOutW }}
                                viewBox="0 0 1 1"
                                preserveAspectRatio="none"
                              >
                                <polygon points="0,0 1,0 1,1" />
                                <line x1="0" y1="0" x2="1" y2="1" vectorEffect="non-scaling-stroke" />
                              </svg>
                            )}
                            {/* Fade handles (visible on hover/selection) */}
                            {supportsFades && width > 24 && (
                              <>
                                <div
                                  className="timeline__clip-fade-handle"
                                  style={{ left: Math.max(1, Math.min(width - 11, fadeInW - 5)) }}
                                  onMouseDown={(e) => handleFadeMouseDown(e, clip, 'in')}
                                  title={`Fade in: ${(clip.fadeIn || 0).toFixed(2)}s — drag`}
                                />
                                <div
                                  className="timeline__clip-fade-handle"
                                  style={{ left: Math.max(1, Math.min(width - 11, width - fadeOutW - 5)) }}
                                  onMouseDown={(e) => handleFadeMouseDown(e, clip, 'out')}
                                  title={`Fade out: ${(clip.fadeOut || 0).toFixed(2)}s — drag`}
                                />
                              </>
                            )}
                            <div className="timeline__clip-header" style={{ backgroundColor: `${track.color}33` }}>
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
                            {clip.transition?.type && (
                              <div className="timeline__clip-transition-badge" title="Has a transition-in — plays over the overlap with the previous clip">⇄</div>
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
                                    className="timeline__keyframe"
                                    style={{ left: (ms / 1000) * pxPerSec, bottom: 3 }}
                                    title={`Keyframe @ ${(ms / 1000).toFixed(2)}s (clip time)`}
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
      const t = srcStart + (x / w) * srcSpan
      const bucket = Math.min(peaks.length - 1, Math.floor((t / duration) * peaks.length))
      const p = peaks[bucket] || 0
      const barH = Math.max(1, p * (h - 2))
      ctx.fillRect(x, mid - barH / 2, 1.5, barH)
    }
  }, [wf, width, color, clip.sourceStart, clip.sourceEnd])

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
