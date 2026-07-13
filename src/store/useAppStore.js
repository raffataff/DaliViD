/**
 * DaliVid — useAppStore.js
 * Global application state: project settings, playback, UI state, autosave.
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

const useAppStore = create(
  subscribeWithSelector((set, get) => ({
    // ── Project Settings ──
    projectName: 'Untitled Project',
    projectId: crypto.randomUUID(),
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    colorSpace: 'sRGB',

    // ── Project Folder Workspace (FileSystem Access API) ──
    projectFolderHandle: null,
    projectFolderName: null,
    projectFolderPermission: 'prompt', // 'granted' | 'prompt' | 'denied'

    // ── Playback State ──
    isPlaying: false,
    playbackSpeed: 1,
    loop: false,
    playheadTime: 0, // seconds
    playheadFrame: 0,
    duration: 0, // total project duration in seconds

    // ── UI State ──
    panelSizes: {
      mediaPool: 260,
      inspector: 320,
      nodeEditor: 300,
      timeline: 200,
    },
    panelCollapsed: {
      nodeEditor: false,
      timeline: false,
    },
    activeMediaTab: 'videos',
    monacoOpen: false,
    monacoNodeId: null,
    scopesOpen: false,
    // When previewing a node inside a clip graph, route the preview through the
    // master effect chain (true) or show the node's raw output in isolation
    // (false). Lets you "tap" a node both with and without master FX applied.
    previewThroughMaster: false,
    exportModalOpen: false,
    newProjectModalOpen: false,
    welcomeShown: false,

    // ── Selection ──
    selectedNodeId: null,
    selectedClipId: null,
    selectedTrackId: null,
    selectedNodeIds: [], // marquee multi-selection
    inspectorContext: 'project', // 'node' | 'clip' | 'track' | 'project'

    // ── Graph Context ──
    graphLevel: 'master', // 'master' | 'clip'
    graphClipId: null,
    graphCompoundPath: [],

    // ── Autosave ──
    autosaveState: 'saved', // 'saved' | 'unsaved' | 'saving'
    lastSaveTime: null,

    // ── Audio Reactive ──
    audioReactiveEnabled: true,

    // ── Beat Grid / Snapping ──
    bpm: 120,
    beatOffset: 0,          // seconds — where beat 1 falls on the timeline
    beatGridEnabled: false, // draw beat/bar lines + include beats in snapping
    snapEnabled: true,      // timeline snapping (clip edges/playhead/markers)

    // ── Edit Mode ──
    editMode: 'overwrite', // 'overwrite' | 'insert'

    // ── Actions ──
    setProjectFolder: (handle, name) => set({
      projectFolderHandle: handle,
      projectFolderName: name,
      projectFolderPermission: 'granted',
      autosaveState: 'unsaved',
    }),

    setProjectFolderPermission: (permission) => set({
      projectFolderPermission: permission,
    }),

    disconnectProjectFolder: () => set({
      projectFolderHandle: null,
      projectFolderName: null,
      projectFolderPermission: 'prompt',
      autosaveState: 'unsaved',
    }),

    setProjectName: (name) => set({ projectName: name, autosaveState: 'unsaved' }),

    setProjectSettings: (settings) => set({
      ...settings,
      autosaveState: 'unsaved',
    }),

    setResolution: (width, height) => set({
      resolution: { width, height },
      autosaveState: 'unsaved',
    }),

    setFps: (fps) => set({ fps, autosaveState: 'unsaved' }),

    // Playback
    play: () => set({ isPlaying: true }),
    pause: () => set({ isPlaying: false }),
    togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
    setPlayheadTime: (time) => {
      const { fps } = get()
      set({
        playheadTime: Math.max(0, time),
        playheadFrame: Math.round(time * fps),
      })
    },
    stepFrame: (delta) => {
      const { playheadTime, fps } = get()
      const newTime = playheadTime + (delta / fps)
      set({
        playheadTime: Math.max(0, newTime),
        playheadFrame: Math.round(newTime * fps),
      })
    },
    skipToStart: () => set({ playheadTime: 0, playheadFrame: 0 }),
    skipToEnd: () => {
      const { duration, fps } = get()
      set({
        playheadTime: duration,
        playheadFrame: Math.round(duration * fps),
      })
    },
    setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),
    toggleLoop: () => set((state) => ({ loop: !state.loop })),

    // UI
    setPanelSize: (panel, size) => set((state) => ({
      panelSizes: { ...state.panelSizes, [panel]: size },
    })),
    togglePanelCollapse: (panel) => set((state) => ({
      panelCollapsed: {
        ...state.panelCollapsed,
        [panel]: !state.panelCollapsed[panel],
      },
    })),
    setActiveMediaTab: (tab) => set({ activeMediaTab: tab }),
    openMonaco: (nodeId) => set({ monacoOpen: true, monacoNodeId: nodeId }),
    closeMonaco: () => set({ monacoOpen: false, monacoNodeId: null }),
    toggleScopes: () => set((state) => ({ scopesOpen: !state.scopesOpen })),
    togglePreviewThroughMaster: () => set((state) => ({ previewThroughMaster: !state.previewThroughMaster })),
    setPreviewThroughMaster: (on) => set({ previewThroughMaster: !!on }),
    setExportModalOpen: (open) => set({ exportModalOpen: open }),
    setNewProjectModalOpen: (open) => set({ newProjectModalOpen: open }),
    setWelcomeShown: () => set({ welcomeShown: true }),

    // Selection
    selectNode: (nodeId) => set({
      selectedNodeId: nodeId,
      selectedClipId: null,
      selectedTrackId: null,
      selectedNodeIds: [],
      inspectorContext: nodeId ? 'node' : 'project',
    }),
    selectClip: (clipId) => set({
      selectedClipId: clipId,
      selectedNodeId: null,
      selectedTrackId: null,
      selectedNodeIds: [],
      inspectorContext: clipId ? 'clip' : 'project',
    }),
    selectTrack: (trackId) => set({
      selectedTrackId: trackId,
      selectedNodeId: null,
      selectedClipId: null,
      selectedNodeIds: [],
      inspectorContext: trackId ? 'track' : 'project',
    }),
    clearSelection: () => set({
      selectedNodeId: null,
      selectedClipId: null,
      selectedTrackId: null,
      selectedNodeIds: [],
      inspectorContext: 'project',
    }),
    setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),
    clearNodeSelection: () => set({ selectedNodeIds: [] }),

    // Graph Context
    enterClipGraph: (clipId) => set({
      graphLevel: 'clip',
      graphClipId: clipId,
      graphCompoundPath: [],
    }),
    exitClipGraph: () => set({
      graphLevel: 'master',
      graphClipId: null,
      graphCompoundPath: [],
    }),
    enterCompound: (compoundId) => set((state) => ({
      graphCompoundPath: [...state.graphCompoundPath, compoundId],
    })),
    exitCompound: () => set((state) => ({
      graphCompoundPath: state.graphCompoundPath.slice(0, -1),
    })),

    // Autosave
    markUnsaved: () => set({ autosaveState: 'unsaved' }),
    markSaving: () => set({ autosaveState: 'saving' }),
    markSaved: () => set({ autosaveState: 'saved', lastSaveTime: Date.now() }),

    // Audio
    toggleAudioReactive: () => set((state) => ({
      audioReactiveEnabled: !state.audioReactiveEnabled,
    })),

    // Beat grid / snapping
    setBpm: (bpm) => set({ bpm: Math.max(20, Math.min(300, bpm || 120)), autosaveState: 'unsaved' }),
    setBeatOffset: (sec) => set({ beatOffset: Math.max(0, sec || 0), autosaveState: 'unsaved' }),
    toggleBeatGrid: () => set((state) => ({ beatGridEnabled: !state.beatGridEnabled, autosaveState: 'unsaved' })),
    toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

    // Edit Mode
    toggleEditMode: () => set((state) => ({
      editMode: state.editMode === 'overwrite' ? 'insert' : 'overwrite',
    })),

    setDuration: (duration) => set({ duration }),
  }))
)

export default useAppStore
