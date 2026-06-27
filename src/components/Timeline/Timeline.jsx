import { useState, useRef, useCallback, useEffect } from 'react'
import useTimelineStore from '../../store/useTimelineStore'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import { IconChevronDown, IconPlus, IconLock } from '../common/Icons'
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
  const splitClip = useTimelineStore(s => s.splitClip)
  const removeClip = useTimelineStore(s => s.removeClip)
  const timelineZoom = useTimelineStore(s => s.timelineZoom)
  const setTimelineZoom = useTimelineStore(s => s.setTimelineZoom)
  const timelineScrollLeft = useTimelineStore(s => s.timelineScrollLeft)
  const setTimelineScrollLeft = useTimelineStore(s => s.setTimelineScrollLeft)
  const inPointStore = useTimelineStore(s => s.inPoint)
  const outPointStore = useTimelineStore(s => s.outPoint)
  const setInPoint = useTimelineStore(s => s.setInPoint)
  const setOutPoint = useTimelineStore(s => s.setOutPoint)
  const clearInOutPoints = useTimelineStore(s => s.clearInOutPoints)
  const addMarker = useTimelineStore(s => s.addMarker)
  const calculateDuration = useTimelineStore(s => s.calculateDuration)

  const inPoint = inPointStore ?? 0
  const projectDuration = calculateDuration() || 30
  const outPoint = outPointStore ?? projectDuration

  const setPlayheadTime = useAppStore(s => s.setPlayheadTime)
  const editMode = useAppStore(s => s.editMode)
  const toggleEditMode = useAppStore(s => s.toggleEditMode)
  const selectClip = useAppStore(s => s.selectClip)
  const selectTrack = useAppStore(s => s.selectTrack)
  const selectedClipId = useAppStore(s => s.selectedClipId)
  const enterClipGraph = useAppStore(s => s.enterClipGraph)
  const clipGraphs = useGraphStore(s => s.clipGraphs)

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

  // Clip dragging
  const [draggingClip, setDraggingClip] = useState(null)
  const [trimming, setTrimming] = useState(null) // { clipId, edge }

  // Clip body drag (move)
  const handleClipMouseDown = useCallback((e, clip) => {
    e.stopPropagation()
    selectClip(clip.id)
    
    const startX = e.clientX
    const originalStart = clip.timelineStart

    const onMove = (me) => {
      const dx = me.clientX - startX
      const dt = dx / pxPerSec

      const hoveredEl = document.elementFromPoint(me.clientX, me.clientY)
      const trackEl = hoveredEl?.closest('.timeline__track')
      let targetTrackId = clip.trackId
      if (trackEl) {
        const trackId = trackEl.getAttribute('data-track-id')
        const trackType = trackEl.getAttribute('data-track-type')
        
        // Helper to check clip compatibility (video/camera on video tracks, audio on audio tracks)
        const isCompatible = (clip.fileType === 'video' || clip.fileType === 'camera')
          ? trackType === 'video'
          : (clip.fileType === 'audio' ? trackType === 'audio' : false)

        if (trackId && isCompatible) {
          targetTrackId = trackId
        }
      }

      moveClip(clip.id, Math.max(0, originalStart + dt), targetTrackId)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setDraggingClip(null)
    }

    setDraggingClip(clip.id)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, selectClip, moveClip])

  // Trim handle drag (left or right edge)
  const handleTrimMouseDown = useCallback((e, clip, edge) => {
    e.stopPropagation()
    e.preventDefault()
    selectClip(clip.id)

    const startX = e.clientX
    const originalTime = edge === 'left' ? clip.timelineStart : clip.timelineEnd

    const onMove = (me) => {
      const dx = me.clientX - startX
      const dt = dx / pxPerSec
      trimClip(clip.id, edge, Math.max(0, originalTime + dt))
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setTrimming(null)
    }

    setTrimming({ clipId: clip.id, edge })
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pxPerSec, selectClip, trimClip])

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

  // Split selected clip at playhead
  const handleSplitAtPlayhead = useCallback(() => {
    if (!selectedClipId) return
    const currentPlayheadTime = useAppStore.getState().playheadTime
    splitClip(selectedClipId, currentPlayheadTime)
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
                  >
                    <div style={{ transform: `translateX(-${timelineScrollLeft}px)`, position: 'relative', height: '100%' }}>
                      {trackClips.map(clip => {
                        const left = clip.timelineStart * pxPerSec
                        const width = (clip.timelineEnd - clip.timelineStart) * pxPerSec
                        const hasGraph = clipGraphs[clip.id] && clipGraphs[clip.id].nodes.length > 2
                        const isTrimming = trimming?.clipId === clip.id
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
                            <div className="timeline__clip-header" style={{ backgroundColor: `${track.color}33` }}>
                              <span className="timeline__clip-name">{clip.filename}</span>
                              {clip.speed && clip.speed !== 1 && (
                                <span className="timeline__clip-speed mono">{clip.speed.toFixed(1)}×</span>
                              )}
                            </div>
                            {/* Audio waveform placeholder */}
                            {clip.fileType === 'audio' && (
                              <div className="timeline__clip-waveform">
                                {Array.from({ length: Math.max(1, Math.floor(width / 3)) }, (_, i) => (
                                  <div key={i} className="timeline__clip-waveform-bar" style={{
                                    height: `${20 + Math.sin(i * 0.7) * 30 + Math.cos(i * 1.3) * 20}%`,
                                    backgroundColor: track.color,
                                  }} />
                                ))}
                              </div>
                            )}
                            {(hasGraph || clip.hasEffects) && (
                              <div className="timeline__clip-fx-badge" style={{ color: track.color }}>FX</div>
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
