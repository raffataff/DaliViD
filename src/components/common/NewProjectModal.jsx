import { useState, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import useTimelineStore from '../../store/useTimelineStore'
import useGraphStore from '../../store/useGraphStore'
import { IconClose } from './Icons'
import { addToast } from './Toast'
import './NewProjectModal.css'

export default function NewProjectModal() {
  const isOpen = useAppStore(s => s.newProjectModalOpen)
  const setOpen = useAppStore(s => s.setNewProjectModalOpen)

  const [projectName, setProjectName] = useState('Untitled Project')
  const [fps, setFps] = useState(30)
  const [resolutionStr, setResolutionStr] = useState('1920x1080')

  const handleClose = useCallback(() => {
    setOpen(false)
    // Reset state for next time
    setProjectName('Untitled Project')
  }, [setOpen])

  // Projects live in browser storage and are exported via "Save Project File".
  // DaliViD asks for no disk access at all to create one.
  const handleCreateProject = async () => {
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

      addToast({
        message: `Project "${projectName}" created. Use "Save Project File" to keep a copy on disk.`,
        type: 'success',
        duration: 7000,
      })

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
            <span className="text-muted" style={{ fontSize: '11px' }}>
              Your project is kept in this browser as you work. Use <strong>Save Project File</strong>
              {' '}to download a copy you can keep, back up or move to another machine.
            </span>
          </div>
        </div>

        <div className="new-project-modal__footer">
          <button className="new-project-modal__cancel-btn" onClick={handleClose}>
            Cancel
          </button>
          <button
            className="new-project-modal__create-btn new-project-modal__create-btn--active"
            onClick={handleCreateProject}
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  )
}
