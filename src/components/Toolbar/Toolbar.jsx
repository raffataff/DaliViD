import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import {
  saveProject, importProjectFromJSON, deserializeProject,
  saveProjectToFolder, loadProjectFromFolder, restoreMediaFilesFromFolder,
  verifyDirectoryPermission, saveProjectFolderHandle, loadProjectFolderHandle
} from '../../utils/projectSerializer'
import { addToast } from '../common/Toast'
import {
  IconPlay, IconPause, IconSkipStart, IconSkipEnd,
  IconStepBack, IconStepForward,
  IconSave, IconFolder, IconImportVideo,
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

  const projectFolderHandle = useAppStore(s => s.projectFolderHandle)
  const projectFolderName = useAppStore(s => s.projectFolderName)
  const projectFolderPermission = useAppStore(s => s.projectFolderPermission)
  const setProjectFolder = useAppStore(s => s.setProjectFolder)
  const disconnectProjectFolder = useAppStore(s => s.disconnectProjectFolder)
  const projectId = useAppStore(s => s.projectId)
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

  const handleSaveProject = useCallback(async () => {
    const appState = useAppStore.getState()
    const folderHandle = appState.projectFolderHandle
    try {
      appState.markSaving()
      if (folderHandle) {
        const hasPermission = await verifyDirectoryPermission(folderHandle, true)
        if (hasPermission) {
          await saveProjectToFolder(folderHandle, useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
          await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
          appState.markSaved()
          addToast({ message: 'Project saved to folder', type: 'success' })
        } else {
          addToast({ message: 'Permission denied to save in folder', type: 'error' })
        }
      } else {
        await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
        appState.markSaved()
        addToast({ message: 'Project saved to browser cache. Link a folder for full save.', type: 'info' })
      }
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to save project', type: 'error' })
    }
  }, [])

  const handleLoadProject = useCallback(async () => {
    const data = await importProjectFromJSON()
    if (!data) return
    try {
      deserializeProject(data, useAppStore.getState)
      addToast({ message: `Project "${data.project?.name || 'Loaded'}" imported`, type: 'success' })
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to load project', type: 'error' })
    }
  }, [])

  const handleLoadFromFolder = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      addToast({ message: 'File System Access API not supported', type: 'error' })
      return
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      const data = await loadProjectFromFolder(dirHandle)
      if (!data) {
        addToast({ message: 'No project.json found in folder', type: 'error' })
        return
      }
      deserializeProject(data, useAppStore.getState)
      const timeline = useTimelineStore.getState()
      if (timeline.clips?.length > 0) {
        await restoreMediaFilesFromFolder(dirHandle, timeline.clips, useTimelineStore.getState().updateClip)
      }
      useAppStore.getState().setProjectFolder(dirHandle, dirHandle.name)
      await saveProjectFolderHandle(useAppStore.getState().projectId, dirHandle)
      addToast({ message: `Project loaded from "${dirHandle.name}"`, type: 'success' })
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err)
        addToast({ message: 'Failed to load project from folder', type: 'error' })
      }
    }
  }, [])

  const handleConnectFolder = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      addToast({ message: 'File System Access API not supported', type: 'error' })
      return
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      const hasPermission = await verifyDirectoryPermission(dirHandle, true)
      if (!hasPermission) {
        addToast({ message: 'Permission denied', type: 'error' })
        return
      }
      useAppStore.getState().setProjectFolder(dirHandle, dirHandle.name)
      await saveProjectFolderHandle(useAppStore.getState().projectId, dirHandle)
      addToast({ message: `Linked to folder "${dirHandle.name}"`, type: 'success' })
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err)
        addToast({ message: 'Failed to connect folder', type: 'error' })
      }
    }
  }, [])

  const handleReconnectFolder = useCallback(async () => {
    const appState = useAppStore.getState()
    try {
      const dirHandle = await loadProjectFolderHandle(appState.projectId)
      if (!dirHandle) {
        addToast({ message: 'Saved folder handle not found. Link a new folder.', type: 'error' })
        return
      }
      const hasPermission = await verifyDirectoryPermission(dirHandle, true)
      if (hasPermission) {
        useAppStore.getState().setProjectFolder(dirHandle, dirHandle.name)
        addToast({ message: `Re-connected to "${dirHandle.name}"`, type: 'success' })
      } else {
        useAppStore.getState().setProjectFolderPermission('denied')
        addToast({ message: 'Permission denied. Click to retry.', type: 'error' })
      }
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to re-connect folder', type: 'error' })
    }
  }, [])

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
        <button className="toolbar__btn" data-tooltip="Load Project from Folder"
          onClick={handleLoadFromFolder}>
          <IconFolder />
        </button>
        <button className="toolbar__btn toolbar__btn--small" data-tooltip="Import JSON file"
          onClick={handleLoadProject}>
          <IconImportVideo />
          <span style={{ fontSize: '10px' }}>.json</span>
        </button>

        <div className="toolbar__divider" />

        <ToolbarProjectName name={projectName} />

        <div className="toolbar__divider" />

        {projectFolderHandle ? (
          projectFolderPermission === 'granted' ? (
            <div className="toolbar__folder-badge toolbar__folder-badge--active" data-tooltip={`Connected to folder: ${projectFolderName}`}>
              <span className="dot dot--green"></span>
              <span className="text" style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectFolderName}</span>
              <button className="toolbar__folder-disconnect" onClick={disconnectProjectFolder} title="Disconnect Folder">×</button>
            </div>
          ) : (
            <button className="toolbar__btn toolbar__btn--warning animate-pulse" onClick={handleReconnectFolder} data-tooltip="Click to Re-connect Project Folder">
              <span className="dot dot--orange"></span>
              <span>Re-connect Folder</span>
            </button>
          )
        ) : (
          <button className="toolbar__btn toolbar__btn--cyan" onClick={handleConnectFolder} data-tooltip="Link a local folder to auto-save and auto-restore media across sessions">
            <span>Link Folder</span>
          </button>
        )}
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

