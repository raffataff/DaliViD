import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import {
  saveProject, importProjectFromJSON, deserializeProject,
  exportProjectAsJSON, pickMediaFiles, relinkMediaFromFiles, getExpectedMediaFilenames
} from '../../utils/projectSerializer'
import { addToast } from '../common/Toast'
import { ASPECT_PRESETS, aspectLabel } from '../../utils/aspectPresets'
import {
  IconPlay, IconPause, IconSkipStart, IconSkipEnd,
  IconStepBack, IconStepForward,
  IconSave, IconImportVideo,
  IconExport, IconLoop, IconAudioReactive, IconNewProject
} from '../common/Icons'
import './Toolbar.css'

export default function Toolbar() {
  const isPlaying = useAppStore(s => s.isPlaying)
  const togglePlay = useAppStore(s => s.togglePlay)
  const stepFrame = useAppStore(s => s.stepFrame)
  const skipToStart = useAppStore(s => s.skipToStart)
  const skipToEnd = useAppStore(s => s.skipToEnd)
  const playbackSpeed = useAppStore(s => s.playbackSpeed)
  const setPlaybackSpeed = useAppStore(s => s.setPlaybackSpeed)
  const loop = useAppStore(s => s.loop)
  const toggleLoop = useAppStore(s => s.toggleLoop)
  const audioReactiveEnabled = useAppStore(s => s.audioReactiveEnabled)
  const toggleAudioReactive = useAppStore(s => s.toggleAudioReactive)
  const autosaveState = useAppStore(s => s.autosaveState)
  const setExportModalOpen = useAppStore(s => s.setExportModalOpen)
  const resolution = useAppStore(s => s.resolution)
  const masterBars = useAppStore(s => s.masterBars)
  const toggleMasterBars = useAppStore(s => s.toggleMasterBars)
  const setMasterBars = useAppStore(s => s.setMasterBars)

  const projectName = useAppStore(s => s.projectName)

  const [renderFps, setRenderFps] = useState(0)
  const frameCountRef = useRef(0)
  const lastFpsTime = useRef(performance.now())

  // FPS counter
  useEffect(() => {
    let animId
    const updateFps = () => {
      frameCountRef.current++
      const now = performance.now()
      if (now - lastFpsTime.current >= 1000) {
        setRenderFps(frameCountRef.current)
        frameCountRef.current = 0
        lastFpsTime.current = now
      }
      animId = requestAnimationFrame(updateFps)
    }
    animId = requestAnimationFrame(updateFps)
    return () => cancelAnimationFrame(animId)
  }, [])

  // Quick save → browser storage only. Durable copies come from "Save Project
  // File"; this is the fast, no-dialog path used by Ctrl+S and autosave.
  const handleSaveProject = useCallback(async () => {
    const appState = useAppStore.getState()
    try {
      appState.markSaving()
      await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
      appState.markSaved()
      addToast({ message: 'Saved to this browser. Use "Save Project File" for a copy on disk.', type: 'info' })
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to save project', type: 'error' })
    }
  }, [])

  // Download the whole edit as a single .dalivid.json. The zero-authority save
  // path: no directory handle, no persisted grant, nothing the app can read back
  // on its own. Video/audio bytes aren't included (images are, as data URLs), so
  // opening it again goes through the relink prompt below.
  const handleSaveProjectFile = useCallback(async () => {
    try {
      const appState = useAppStore.getState()
      // The Save As dialog goes FIRST: showSaveFilePicker needs transient user
      // activation, and awaiting the IndexedDB write before it can outlive that
      // window (which would silently demote us to a Downloads-folder dump).
      const how = await exportProjectAsJSON(
        useAppStore.getState, useGraphStore.getState, useTimelineStore.getState
      )
      if (how === 'cancelled') return

      appState.markSaving()
      // Keep the browser-cache copy in step so the autosave dot isn't lying
      // about the state of the project the user just wrote to disk.
      await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
      appState.markSaved()
      // Records that a durable copy now exists — drives the unload warning.
      appState.markProjectExported()
      addToast({
        message: how === 'picker' ? 'Project file saved' : 'Project file downloaded',
        type: 'success',
      })
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to save project file', type: 'error' })
    }
  }, [])

  // After a JSON import, offer to relink media by filename. Runs as a separate
  // user gesture (a file input) so the import itself needs no disk access.
  const relinkImportedMedia = useCallback(async () => {
    const expected = getExpectedMediaFilenames(useTimelineStore.getState().clips)
    if (expected.length === 0) {
      addToast({ message: 'No file-backed media in this project — nothing to relink.', type: 'info' })
      return
    }

    addToast({
      message: `Select the ${expected.length} media file${expected.length > 1 ? 's' : ''} for this project: ${expected.slice(0, 3).join(', ')}${expected.length > 3 ? '…' : ''}`,
      type: 'info',
      duration: 7000,
    })

    const files = await pickMediaFiles()
    if (!files || files.length === 0) {
      addToast({ message: 'Media not relinked — clips will be offline until you re-import them.', type: 'warning', duration: 8000 })
      return
    }

    const { restoredCount, missing } = relinkMediaFromFiles(
      files,
      useTimelineStore.getState().clips,
      useTimelineStore.getState().updateClip
    )

    if (missing.length > 0) {
      addToast({
        message: `Relinked ${restoredCount} clip${restoredCount === 1 ? '' : 's'}. Still missing: ${missing.join(', ')}`,
        type: 'warning',
        duration: 9000,
      })
    } else {
      addToast({ message: `Relinked ${restoredCount} clip${restoredCount === 1 ? '' : 's'}`, type: 'success' })
    }
  }, [])

  const handleLoadProject = useCallback(async () => {
    const data = await importProjectFromJSON()
    if (!data) return
    try {
      deserializeProject(data, useAppStore.getState)
      addToast({ message: `Project "${data.project?.name || 'Loaded'}" imported`, type: 'success' })
      await relinkImportedMedia()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to load project', type: 'error' })
    }
  }, [relinkImportedMedia])

  const handleExportFrame = useCallback(() => {
    const previewCanvas = document.querySelector('#preview-canvas canvas')
    if (!previewCanvas) {
      addToast({ message: 'No preview canvas found', type: 'error' })
      return
    }
    try {
      const dataUrl = previewCanvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `frame_${Date.now()}.png`
      a.click()
      addToast({ message: 'Frame exported as PNG', type: 'success' })
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to export frame', type: 'error' })
    }
  }, [])

  const barsEnabled = !!masterBars?.enabled

  // Resolution label
  const resLabel = resolution.height <= 480 ? '480p' :
                   resolution.height <= 720 ? '720p' :
                   resolution.height <= 1080 ? '1080p' :
                   resolution.height <= 2160 ? '4K' : `${resolution.width}×${resolution.height}`

  return (
    <div className="toolbar" id="toolbar">
      {/* ── Left Section ── */}
      <div className="toolbar__section toolbar__section--left">
        <div className="toolbar__logo">
          <span className="toolbar__logo-text">DALIVID</span>
        </div>

        <div className="toolbar__divider" />

        <button className="toolbar__btn" data-tooltip="New Project"
          onClick={() => useAppStore.getState().setNewProjectModalOpen(true)}>
          <IconNewProject />
        </button>
        <button className="toolbar__btn" data-tooltip="Save Project (Ctrl+S)"
          onClick={handleSaveProject}>
          <IconSave />
        </button>
        <button className="toolbar__btn toolbar__btn--small" data-tooltip="Save Project File — downloads the whole edit, no disk access needed"
          onClick={handleSaveProjectFile}>
          <IconSave />
          <span style={{ fontSize: '10px' }}>.json</span>
        </button>
        <button className="toolbar__btn toolbar__btn--small" data-tooltip="Open Project File — pick a .dalivid.json, then relink its media"
          onClick={handleLoadProject}>
          <IconImportVideo />
          <span style={{ fontSize: '10px' }}>.json</span>
        </button>
        <button className="toolbar__btn toolbar__btn--small" data-tooltip="Relink Media — re-attach video/audio files to this project's clips"
          onClick={relinkImportedMedia}>
          <IconImportVideo />
          <span style={{ fontSize: '10px' }}>link</span>
        </button>

        <div className="toolbar__divider" />

        <ToolbarProjectName name={projectName} />
      </div>

      {/* ── Center Section — Playback ── */}
      <div className="toolbar__section toolbar__section--center">
        <div className="toolbar__playback">
          <button className="toolbar__transport-btn" data-tooltip="Skip to Start (Home)" onClick={skipToStart}>
            <IconSkipStart />
          </button>
          <button className="toolbar__transport-btn" data-tooltip="Step Back 1 Frame (←)" onClick={() => stepFrame(-1)}>
            <IconStepBack />
          </button>
          <button
            className={`toolbar__transport-btn toolbar__transport-btn--play ${isPlaying ? 'active' : ''}`}
            data-tooltip={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            onClick={togglePlay}
          >
            {isPlaying ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>
          <button className="toolbar__transport-btn" data-tooltip="Step Forward 1 Frame (→)" onClick={() => stepFrame(1)}>
            <IconStepForward />
          </button>
          <button className="toolbar__transport-btn" data-tooltip="Skip to End (End)" onClick={skipToEnd}>
            <IconSkipEnd />
          </button>
        </div>

        <ToolbarTimecode />

        <select
          className="toolbar__speed-select"
          value={playbackSpeed}
          onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
        >
          <option value={0.25}>0.25×</option>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>

        <button
          className={`toolbar__toggle-btn ${loop ? 'toolbar__toggle-btn--active' : ''}`}
          onClick={toggleLoop}
          data-tooltip="Loop Playback (L)"
        >
          <IconLoop />
        </button>
      </div>

      {/* ── Right Section ── */}
      <div className="toolbar__section toolbar__section--right">
        <span className="toolbar__resolution-label mono">{resLabel}</span>

        <button className="toolbar__btn" onClick={handleExportFrame} data-tooltip="Export Frame (Ctrl+Shift+E)">
          <IconExport size={14} />
        </button>

        <button className="toolbar__btn toolbar__btn--export"
          onClick={() => setExportModalOpen(true)} data-tooltip="Export Video">
          <IconExport size={14} />
          <span>Export</span>
        </button>

        {/* Widescreen bars: one click to frame the whole output (preview + export).
            The aspect picker only appears once bars are on, so the toolbar stays
            quiet by default; full controls live in Inspector → Project. */}
        <button
          className={`toolbar__toggle-btn ${barsEnabled ? 'toolbar__toggle-btn--active' : ''}`}
          onClick={toggleMasterBars}
          data-tooltip={barsEnabled
            ? `Widescreen bars ON (${aspectLabel(masterBars?.aspect)}) — click to remove`
            : 'Add widescreen bars (letterbox the output)'}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="1" y="1" width="12" height="12" rx="1.5" />
            <rect x="1" y="1.5" width="12" height="3" fill="currentColor" stroke="none" opacity="0.85" />
            <rect x="1" y="9.5" width="12" height="3" fill="currentColor" stroke="none" opacity="0.85" />
          </svg>
        </button>
        {barsEnabled && (
          <select
            className="toolbar__speed-select"
            value={String(masterBars?.aspect ?? 2.39)}
            onChange={(e) => setMasterBars({ aspect: parseFloat(e.target.value) })}
            data-tooltip="Delivery aspect ratio"
          >
            {ASPECT_PRESETS.map(a => (
              <option key={a.label} value={String(a.value)}>{a.short}</option>
            ))}
          </select>
        )}

        <button
          className={`toolbar__toggle-btn ${audioReactiveEnabled ? 'toolbar__toggle-btn--active toolbar__toggle-btn--cyan' : ''}`}
          onClick={toggleAudioReactive}
          data-tooltip="Toggle Audio Reactive"
        >
          <IconAudioReactive />
        </button>

        <div className="toolbar__fps mono" data-tooltip="Render FPS">
          {renderFps} <span className="text-muted">fps</span>
        </div>

        <div
          className={`toolbar__autosave-dot toolbar__autosave-dot--${autosaveState}`}
          data-tooltip={
            autosaveState === 'saved' ? 'All changes saved' :
            autosaveState === 'unsaved' ? 'Unsaved changes' :
            'Autosaving...'
          }
        />
      </div>
    </div>
  )
}

function formatTimecode(seconds, fps) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const f = Math.floor((seconds % 1) * fps)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}

function ToolbarTimecode() {
  const playheadTime = useAppStore(s => s.playheadTime)
  const fps = useAppStore(s => s.fps)
  return <div className="toolbar__timecode mono">{formatTimecode(playheadTime, fps)}</div>
}

function ToolbarProjectName({ name }) {
  const setProjectName = useAppStore(s => s.setProjectName)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef(null)

  useEffect(() => { setDraft(name) }, [name])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const submit = useCallback(() => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== name) setProjectName(trimmed)
    setEditing(false)
  }, [draft, name, setProjectName])

  const isUntitled = useMemo(() => !name || name === 'Untitled Project', [name])

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="toolbar__project-name-input mono"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={submit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          if (e.key === 'Escape') { setDraft(name); setEditing(false) }
        }}
      />
    )
  }

  return (
    <button
      className={`toolbar__project-name ${isUntitled ? 'toolbar__project-name--untitled' : ''}`}
      data-tooltip="Click to rename project"
      onClick={() => setEditing(true)}
    >
      <span className="toolbar__project-name-icon">▸</span>
      <span className="toolbar__project-name-text">{name || 'Untitled Project'}</span>
    </button>
  )
}

