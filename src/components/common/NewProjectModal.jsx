import { useState, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import useTimelineStore from '../../store/useTimelineStore'
import useGraphStore from '../../store/useGraphStore'
import { IconClose, IconFolder } from './Icons'
import { addToast } from './Toast'
import { 
  verifyDirectoryPermission, 
  saveProjectFolderHandle, 
  saveProjectToFolder 
} from '../../utils/projectSerializer'
import './NewProjectModal.css'

export default function NewProjectModal() {
  const isOpen = useAppStore(s => s.newProjectModalOpen)
  const setOpen = useAppStore(s => s.setNewProjectModalOpen)
  const setProjectFolder = useAppStore(s => s.setProjectFolder)
  const disconnectProjectFolder = useAppStore(s => s.disconnectProjectFolder)

  const [projectName, setProjectName] = useState('Untitled Project')
  const [fps, setFps] = useState(30)
  const [resolutionStr, setResolutionStr] = useState('1920x1080')
  const [folderHandle, setFolderHandle] = useState(null)

  const handleClose = useCallback(() => {
    setOpen(false)
    // Reset state for next time
    setProjectName('Untitled Project')
    setFolderHandle(null)
  }, [setOpen])

  const handleSelectFolder = async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      if (handle) {
        const hasPermission = await verifyDirectoryPermission(handle, true)
        if (hasPermission) {
          setFolderHandle(handle)
        } else {
          addToast({ message: 'Permission denied for selected folder', type: 'error' })
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err)
        addToast({ message: 'Failed to select folder', type: 'error' })
      }
    }
  }

  const handleCreateProject = async () => {
    if (!folderHandle) return

    try {
      const [widthStr, heightStr] = resolutionStr.split('x')
      const width = parseInt(widthStr, 10)
      const height = parseInt(heightStr, 10)
      const projectId = crypto.randomUUID()

      // Reset application state for the new project
      useAppStore.setState({
        projectName: projectName || 'Untitled Project',
        projectId,
        fps,
        resolution: { width, height },
        duration: 0,
        playheadTime: 0,
        playheadFrame: 0,
        autosaveState: 'unsaved',
      })

      useTimelineStore.setState({
        tracks: [],
        clips: [],
        markers: [],
        keyframes: [],
        inPoint: null,
        outPoint: null,
      })
      
      useGraphStore.setState({
        masterGraph: {
          nodes: [],
          edges: [],
          tapPointNodeId: null,
          compiledChain: [],
          compileErrors: []
        },
        clipGraphs: {},
        // Bump so the renderer recompiles (clears) for the new empty project.
        topologyVersion: useGraphStore.getState().topologyVersion + 1,
      })

      // Ensure previous folder is cleanly disconnected
      disconnectProjectFolder()

      // Link new folder to app store
      setProjectFolder(folderHandle, folderHandle.name)
      await saveProjectFolderHandle(projectId, folderHandle)

      // Initialize folder structure and save the initial project.json
      await folderHandle.getDirectoryHandle('media', { create: true })
      await folderHandle.getDirectoryHandle('audio', { create: true })
      await folderHandle.getDirectoryHandle('renders', { create: true })
      
      await saveProjectToFolder(
        folderHandle, 
        useAppStore.getState, 
        useGraphStore.getState, 
        useTimelineStore.getState
      )

      addToast({ message: `Project "${projectName}" created successfully!`, type: 'success' })
      handleClose()
    } catch (err) {
      console.error('Failed to create project:', err)
      addToast({ message: `Error creating project: ${err.message}`, type: 'error' })
    }
  }

  if (!isOpen) return null

  return (
    <div className="new-project-modal__overlay" onClick={handleClose}>
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

          <div className="new-project-modal__folder-section">
            <div className="new-project-modal__field">
              <label>Workspace Folder (Required)</label>
              {!folderHandle ? (
                <button className="new-project-modal__folder-btn" onClick={handleSelectFolder}>
                  <IconFolder /> Select Local Folder
                </button>
              ) : (
                <div className="new-project-modal__folder-display">
                  <IconFolder /> <strong>{folderHandle.name}</strong>
                  <button 
                    className="new-project-modal__close" 
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setFolderHandle(null)}
                    title="Change Folder"
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              )}
              <span className="text-muted" style={{ fontSize: '11px', marginTop: '4px' }}>
                All imported media and renders will be automatically organized here.
              </span>
            </div>
          </div>
        </div>

        <div className="new-project-modal__footer">
          <button className="new-project-modal__cancel-btn" onClick={handleClose}>
            Cancel
          </button>
          <button 
            className={`new-project-modal__create-btn ${folderHandle ? 'new-project-modal__create-btn--active' : ''}`}
            onClick={handleCreateProject}
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  )
}
