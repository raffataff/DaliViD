import { useState, useCallback, useRef } from 'react'
import useAppStore from '../../store/useAppStore'
import useTimelineStore from '../../store/useTimelineStore'
import useGraphStore from '../../store/useGraphStore'
import useMediaStore from '../../store/useMediaStore'
import { saveProject } from '../../utils/projectSerializer'
import {
  isFolderSupported, pickFolder, readProjectDoc, createProjectIn,
} from '../../storage/index.js'
import { IconClose } from './Icons'
import { addToast } from './Toast'
import './NewProjectModal.css'

export default function NewProjectModal() {
  const isOpen = useAppStore(s => s.newProjectModalOpen)
  const setOpen = useAppStore(s => s.setNewProjectModalOpen)

  const [projectName, setProjectName] = useState('Untitled Project')
  const [fps, setFps] = useState(30)
  const [resolutionStr, setResolutionStr] = useState('1920x1080')
  const [busy, setBusy] = useState(false)

  // The folder this project will live in. Held here, not committed anywhere,
  // until Create — picking a folder and then cancelling must leave no trace.
  const [folder, setFolder] = useState(null)        // { handle, name, occupied }

  const supported = isFolderSupported()

  // True only when the mouse went DOWN on the backdrop itself. Without this,
  // dragging to select the project name and releasing outside the dialog fires
  // a click on the overlay — the browser dispatches it on the common ancestor —
  // and the modal closes mid-edit.
  const pressedOnOverlay = useRef(false)

  const handleClose = useCallback(() => {
    setOpen(false)
    setProjectName('Untitled Project')
    setFolder(null)
  }, [setOpen])

  const handleOverlayMouseDown = useCallback((e) => {
    pressedOnOverlay.current = e.target === e.currentTarget
  }, [])

  const handleOverlayClick = useCallback((e) => {
    if (e.target !== e.currentTarget) return
    if (!pressedOnOverlay.current) return
    pressedOnOverlay.current = false
    handleClose()
  }, [handleClose])

  const chooseFolder = useCallback(async () => {
    setBusy(true)
    try {
      const handle = await pickFolder()
      if (!handle) return                            // dialog closed
      // A folder that already holds a project is almost always a mistake — the
      // user meant to OPEN it. Creating here would write a second project.json
      // over the first, so this is flagged, not silently allowed.
      const existing = await readProjectDoc(handle)
      setFolder({
        handle,
        name: handle.name,
        occupied: existing ? (existing.project?.name || 'a project') : null,
      })
    } catch (err) {
      console.error('[NewProjectModal] folder pick failed:', err)
      addToast({ message: err.message || 'Could not use that folder.', type: 'error', duration: 9000 })
    } finally {
      setBusy(false)
    }
  }, [])

  const canCreate = !!folder && !folder.occupied && !busy

  const handleCreateProject = useCallback(async () => {
    if (!canCreate) return
    setBusy(true)
    try {
      const [widthStr, heightStr] = resolutionStr.split('x')
      const width = parseInt(widthStr, 10)
      const height = parseInt(heightStr, 10)
      const projectId = crypto.randomUUID()
      const name = projectName || 'Untitled Project'

      // Save the OUTGOING project first, into ITS folder, while that is still
      // the vault's root. After this point the root belongs to the new project.
      if (useTimelineStore.getState().clips.length > 0) {
        try {
          await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
        } catch (err) {
          console.warn('[NewProjectModal] could not save the previous project:', err)
        }
      }

      // Point the vault at the new folder before anything is written.
      await createProjectIn(folder.handle, { id: projectId, name })

      useAppStore.setState({
        projectName: name,
        projectId,
        fps,
        resolution: { width, height },
        duration: 0,
        playheadTime: 0,
        playheadFrame: 0,
        autosaveState: 'unsaved',
      })

      useTimelineStore.setState({
        tracks: [], clips: [], markers: [], keyframes: [], inPoint: null, outPoint: null,
      })

      // Back to the default master graph — Master Output, Timeline Audio and the
      // Audio Splitter — not an empty one. See `resetForNewProject`.
      useGraphStore.getState().resetForNewProject()

      // The pool is project state and goes with the project. Safe here: the
      // outgoing project was saved above and nothing can still be playing.
      useMediaStore.getState().clear()

      // Write project.json immediately, so the folder is a real project even if
      // the user closes the tab without touching anything.
      await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
      useAppStore.getState().markSaved()

      // Read it back before claiming success. A write that lands in the wrong
      // place — or not at all — is otherwise completely silent, and the user
      // only finds out when the folder refuses to reopen days later.
      if (!await readProjectDoc(folder.handle)) {
        addToast({
          message: 'The project was created but its project.json could not be read back from that folder. Check the browser console and try a different folder.',
          type: 'error',
          duration: 14000,
        })
        return
      }

      addToast({ message: `Created "${name}" in ${folder.name}.`, type: 'success', duration: 7000 })
      handleClose()
    } catch (err) {
      console.error('Failed to create project:', err)
      addToast({ message: `Error creating project: ${err.message}`, type: 'error' })
    } finally {
      setBusy(false)
    }
  }, [canCreate, folder, fps, projectName, resolutionStr, handleClose])

  if (!isOpen) return null

  return (
    <div
      className="new-project-modal__overlay"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      <div className="new-project-modal" onClick={e => e.stopPropagation()}>
        <div className="new-project-modal__header">
          <h3>Create New Project</h3>
          <button className="new-project-modal__close" onClick={handleClose}>
            <IconClose />
          </button>
        </div>

        <div className="new-project-modal__body">
          <div className="new-project-modal__field">
            <label>Project Name</label>
            <input
              type="text"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="e.g. My Awesome Video"
              autoFocus
            />
          </div>

          <div className="new-project-modal__settings-row">
            <div className="new-project-modal__field">
              <label>Resolution</label>
              <select value={resolutionStr} onChange={e => setResolutionStr(e.target.value)}>
                <option value="1280x720">720p (1280x720)</option>
                <option value="1920x1080">1080p (1920x1080)</option>
                <option value="2560x1440">1440p (2560x1440)</option>
                <option value="3840x2160">4K (3840x2160)</option>
              </select>
            </div>

            <div className="new-project-modal__field">
              <label>Frame Rate</label>
              <select value={fps} onChange={e => setFps(Number(e.target.value))}>
                <option value={24}>24 fps</option>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </div>
          </div>

          <div className="new-project-modal__field">
            <label>Project Folder</label>
            {!supported ? (
              <p className="npm__folder-warn">
                Creating a project needs a folder to keep it in, and this browser can&rsquo;t open
                one. Chrome, Edge or Opera can.
              </p>
            ) : (
              <>
                <div className="npm__folder">
                  <span className={`npm__folder-name${folder ? '' : ' npm__folder-name--empty'}`}>
                    {folder ? folder.name : 'No folder chosen'}
                  </span>
                  <button className="npm__folder-btn" disabled={busy} onClick={chooseFolder}>
                    {folder ? 'Change…' : 'Choose folder…'}
                  </button>
                </div>
                {folder?.occupied && (
                  <p className="npm__folder-warn">
                    That folder already holds “{folder.occupied}”. Pick an empty folder, or open
                    that project from the Projects window instead.
                  </p>
                )}
                <p className="npm__folder-hint">
                  This project and its media live here. Back the folder up, or move it to another
                  machine, and the whole project goes with it.
                </p>
              </>
            )}
          </div>
        </div>

        <div className="new-project-modal__footer">
          <button className="new-project-modal__cancel-btn" onClick={handleClose}>
            Cancel
          </button>
          <button
            className="new-project-modal__create-btn new-project-modal__create-btn--active"
            onClick={handleCreateProject}
            disabled={!canCreate}
          >
            {busy ? 'Working…' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  )
}
