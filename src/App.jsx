import { useState, useCallback, useEffect, useRef } from 'react'
import './App.css'
import Toolbar from './components/Toolbar/Toolbar'
import MediaPool from './components/MediaPool/MediaPool'
import PreviewCanvas from './components/Preview/PreviewCanvas'
import Inspector from './components/Inspector/Inspector'
import NodeCanvas from './components/NodeEditor/NodeCanvas'
import Timeline from './components/Timeline/Timeline'
import ResizeHandle from './components/common/ResizeHandle'
import ExportModal from './components/Export/ExportModal'
import NewProjectModal from './components/common/NewProjectModal'
import ToastContainer, { addToast } from './components/common/Toast'
import WelcomeModal from './components/common/WelcomeModal'
import ShortcutsOverlay from './components/common/ShortcutsOverlay'
import useAppStore from './store/useAppStore'
import useGraphStore from './store/useGraphStore'
import useTimelineStore from './store/useTimelineStore'
import {
  saveProject, saveProjectToFolder,
  verifyDirectoryPermission
} from './utils/projectSerializer'

// Persist panel sizes to localStorage
const STORAGE_KEY = 'dalivid_panel_sizes'
const getStoredSizes = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : null
  } catch { return null }
}
const storeSizes = (sizes) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes))
  } catch (err) {
    console.error('Failed to store sizes:', err)
  }
}

const DEFAULT_SIZES = {
  mediaPool: 260,
  inspector: 320,
  nodeEditor: 300,
  timeline: 200,
}

export default function App() {
   const [sizes, setSizes] = useState(() => getStoredSizes() || DEFAULT_SIZES)
   const [collapsed, setCollapsed] = useState({
     nodeEditor: false,
     timeline: false,
   })
   const [viewportTooSmall, setViewportTooSmall] = useState(false)
   const [showShortcuts, setShowShortcuts] = useState(false)
   const bodyRef = useRef(null)
   const autosaveTimerRef = useRef(null)

   // Zustand actions for keyboard shortcuts
   const togglePlay = useAppStore(s => s.togglePlay)
   const stepFrame = useAppStore(s => s.stepFrame)
   const skipToStart = useAppStore(s => s.skipToStart)
   const skipToEnd = useAppStore(s => s.skipToEnd)
   const toggleLoop = useAppStore(s => s.toggleLoop)
   const setExportModalOpen = useAppStore(s => s.setExportModalOpen)
const clearSelection = useAppStore(s => s.clearSelection)

    const toggleCollapse = useCallback((panel) => {
      setCollapsed(prev => ({ ...prev, [panel]: !prev[panel] }))
    }, [])

    // ── Save / Autosave (defined first — used by keyboard shortcut handler below) ──
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

   // Debounced autosave: triggers 2 seconds after last unsaved change
   const triggerAutosave = useCallback(() => {
     if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
     autosaveTimerRef.current = setTimeout(async () => {
       const appState = useAppStore.getState()
       if (appState.autosaveState === 'unsaved') {
         await handleSaveProject()
       }
     }, 2000)
   }, [handleSaveProject])

   // Subscribe to autosaveState changes to trigger debounced save
   useEffect(() => {
     const unsub = useAppStore.subscribe(
       (state) => state.autosaveState,
       (state) => {
         if (state === 'unsaved') triggerAutosave()
       }
     )
     return () => {
       unsub()
       if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
     }
   }, [triggerAutosave])

   // Viewport check
   useEffect(() => {
     const check = () => {
       setViewportTooSmall(window.innerWidth < 1280 || window.innerHeight < 768)
     }
     check()
     window.addEventListener('resize', check)
     return () => window.removeEventListener('resize', check)
   }, [])

   // Persist sizes on change
   useEffect(() => {
     storeSizes(sizes)
   }, [sizes])

   // ── Global Keyboard Shortcuts ──
   useEffect(() => {
     const handleKeyDown = (e) => {
       const tag = e.target.tagName
       const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable

       // Space — Play/Pause (unless in input field)
       if (e.code === 'Space' && !isInput) {
         e.preventDefault()
         togglePlay()
         return
       }

       // Arrow keys — step frames
       if (e.code === 'ArrowLeft' && !isInput) {
         e.preventDefault()
         stepFrame(-1)
         return
       }
       if (e.code === 'ArrowRight' && !isInput) {
         e.preventDefault()
         stepFrame(1)
         return
       }

       // Home / End — skip
       if (e.code === 'Home' && !isInput) {
         e.preventDefault()
         skipToStart()
         return
       }
       if (e.code === 'End' && !isInput) {
         e.preventDefault()
         skipToEnd()
         return
       }

       // L — toggle loop
       if (e.code === 'KeyL' && !isInput && !e.ctrlKey && !e.metaKey) {
         e.preventDefault()
         toggleLoop()
         return
       }

       // Escape — clear selection
       if (e.code === 'Escape') {
         clearSelection()
         return
       }

       // Delete / Backspace — delete selected node
       if ((e.code === 'Delete' || e.code === 'Backspace') && !isInput) {
         // Node deletion handled by NodeCanvas listening to selectedNodeId
         return
       }

       // Ctrl+S — Save (prevent default browser save)
       if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
         e.preventDefault()
         handleSaveProject()
         return
       }

       // Ctrl+Shift+E — Export
       if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyE') {
         e.preventDefault()
         setExportModalOpen(true)
         return
       }

       // F — fit to window (when node canvas is focused)
       if (e.code === 'KeyF' && !isInput && !e.ctrlKey && !e.metaKey) {
         // NodeCanvas handles this internally via its own listener
         return
       }

       // Shift + ? — Show shortcuts
       if (e.key === '?' && !isInput) {
         e.preventDefault()
         setShowShortcuts(prev => !prev)
         return
       }
     }

     window.addEventListener('keydown', handleKeyDown)
     return () => window.removeEventListener('keydown', handleKeyDown)
   }, [togglePlay, stepFrame, skipToStart, skipToEnd, toggleLoop, clearSelection, setExportModalOpen, handleSaveProject])

   const handleResize = useCallback((panel, delta) => {
     setSizes(prev => {
       const newSizes = { ...prev }
       switch (panel) {
         case 'mediaPool':
           newSizes.mediaPool = Math.max(180, prev.mediaPool + delta)
           break
         case 'inspector':
           newSizes.inspector = Math.max(220, prev.inspector - delta)
           break
         case 'nodeEditor':
           newSizes.nodeEditor = Math.max(120, prev.nodeEditor - delta)
           break
         case 'timeline':
           newSizes.timeline = Math.max(80, prev.timeline - delta)
           break
       }
       return newSizes
     })
   }, [])

  return (
    <div className="app">
      {viewportTooSmall && (
        <div className="viewport-warning">
          <div className="viewport-warning__content">
            <h2>Viewport Too Small</h2>
            <p>DaliVid requires a minimum viewport of 1280×768px.</p>
            <p>Please resize your browser window or use a larger display.</p>
          </div>
        </div>
      )}

      <Toolbar />

      <div className="app__body" ref={bodyRef}>
        {/* ── Top Row: Media Pool | Preview | Inspector ── */}
        <div className="app__top-row">
          <div
            className="panel panel--media-pool"
            style={{ width: sizes.mediaPool, minWidth: 180 }}
          >
            <MediaPool />
          </div>

          <ResizeHandle
            direction="horizontal"
            onResize={(delta) => handleResize('mediaPool', delta)}
          />

          <div className="panel panel--preview">
            <PreviewCanvas />
          </div>

          <ResizeHandle
            direction="horizontal"
            onResize={(delta) => handleResize('inspector', delta)}
          />

          <div
            className="panel panel--inspector"
            style={{ width: sizes.inspector, minWidth: 220 }}
          >
            <Inspector />
          </div>
        </div>

        {/* ── Node Editor ── */}
        <ResizeHandle
          direction="vertical"
          onResize={(delta) => handleResize('nodeEditor', delta)}
        />
        <div
          className={`panel panel--node-editor ${collapsed.nodeEditor ? 'panel--collapsed' : ''}`}
          style={{ height: collapsed.nodeEditor ? 28 : sizes.nodeEditor }}
        >
          <NodeCanvas
            collapsed={collapsed.nodeEditor}
            onToggleCollapse={() => toggleCollapse('nodeEditor')}
          />
        </div>

        {/* ── Timeline ── */}
        <ResizeHandle
          direction="vertical"
          onResize={(delta) => handleResize('timeline', delta)}
        />
        <div
          className={`panel panel--timeline ${collapsed.timeline ? 'panel--collapsed' : ''}`}
          style={{ height: collapsed.timeline ? 28 : sizes.timeline }}
        >
          <Timeline
            collapsed={collapsed.timeline}
            onToggleCollapse={() => toggleCollapse('timeline')}
          />
        </div>
      </div>

      {/* ── Overlays ── */}
      <ExportModal />
      <NewProjectModal />
      <WelcomeModal />
      <ShortcutsOverlay isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <ToastContainer />
    </div>
  )
}
