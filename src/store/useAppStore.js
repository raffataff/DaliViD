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

    // ── Delivery: widescreen bars ──
    // Applied as the LAST pass of the master pipeline (Renderer._presentToScreen),
    // so it shows in the preview and is baked into exports. `aspect` is the target
    // ratio (2.39 = scope); bars are horizontal when the target is wider than the
    // project, vertical when narrower. For per-graph control use the LETTERBOX
    // node — both share one shader.
    masterBars: {
      enabled: false,
      aspect: 2.39,
      color: '#000000',
      opacity: 1,
      feather: 0,
      offset: 0,
      zoom: 0,
    },

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
    // How a clip's effect graph is previewed WHILE you are editing it:
    //   'isolated' — that clip's chain alone, full-screen. Cheapest (one clip
    //                renders, every other media element is paused), and the only
    //                mode where a node tap shows the node's RAW output.
    //   'master'   — isolated, then pushed through the master chain, so a tap
    //                can be judged with master FX applied.
    //   'context'  — the real full pipeline: every track, compositing, blend
    //                modes, opacity, fades, edge transitions, master and bars.
    //                Exactly how a TRANSITION graph has always previewed. Most
    //                truthful, most expensive — every active clip graph runs
    //                every frame, so it is opt-in rather than the default.
    // A transition graph ignores this entirely: it mixes two sides that only
    // exist in the composite, so it is always previewed in context.
    // View state, not project state — deliberately not serialized.
    clipPreviewMode: 'isolated', // 'isolated' | 'master' | 'context'
    // What "transparent" looks like in the preview. 'black' is the NLE default
    // and the one the present pass gets for free; 'checker' / 'white' cost one
    // extra pass and exist so you can SEE a key or an alpha source instead of
    // guessing whether that black area is picture or hole. `previewAlphaView`
    // replaces the picture with its alpha channel as greyscale (matte view).
    // View state, not project state — deliberately not serialized, so a project
    // never opens with a diagnostic view left on.
    previewBackdrop: 'black', // 'black' | 'checker' | 'white'
    previewAlphaView: false,
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
    // When the project was last downloaded as a .dalivid.json. Autosave only
    // reaches IndexedDB, which the browser is free to evict, so this is what
    // tells us whether a copy of the work exists anywhere durable.
    lastExportTime: null,

    // ── Audio Reactive ──
    audioReactiveEnabled: true,

    // ── Transitions ──
    // The effect applied by the T shortcut, the +/- hotspots on a clip's ends
    // and the Transitions tab's click-to-apply. Every professional NLE has this
    // ("Apply Default Video Transition"), and without one there is no way to add
    // a transition that doesn't involve first choosing which of two dozen it
    // should be. '' means the plain opacity ramp, which is a legitimate default.
    // A registry key, `compound:<libId>`, or 'graph'.
    defaultTransition: 'CROSSFADE',

    // ── Beat Grid / Snapping ──
    bpm: 120,
    beatOffset: 0,          // seconds — where beat 1 falls on the timeline
    beatGridEnabled: false, // draw beat/bar lines + include beats in snapping
    snapEnabled: true,      // timeline snapping (clip edges/playhead/markers)

    // ── Edit Mode ──
    editMode: 'overwrite', // 'overwrite' | 'insert'

    // ── Actions ──
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

    // Widescreen bars — patch-merge so callers only pass what changed.
    setMasterBars: (patch) => set((state) => ({
      masterBars: { ...state.masterBars, ...patch },
      autosaveState: 'unsaved',
    })),
    // Preview transparency display. No `autosaveState` bump — these are view
    // settings, not edits, and marking the project dirty for looking at it
    // would fight the unsaved-changes warning.
    setPreviewBackdrop: (previewBackdrop) => set({ previewBackdrop }),
    cyclePreviewBackdrop: () => set((state) => ({
      previewBackdrop: state.previewBackdrop === 'black' ? 'checker'
        : state.previewBackdrop === 'checker' ? 'white' : 'black',
    })),
    togglePreviewAlphaView: () => set((state) => ({ previewAlphaView: !state.previewAlphaView })),

    toggleMasterBars: () => set((state) => ({
      masterBars: { ...state.masterBars, enabled: !state.masterBars.enabled },
      autosaveState: 'unsaved',
    })),

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
    setClipPreviewMode: (mode) => set({ clipPreviewMode: mode }),
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
    markProjectExported: () => set({ lastExportTime: Date.now() }),

    // Audio
    toggleAudioReactive: () => set((state) => ({
      audioReactiveEnabled: !state.audioReactiveEnabled,
    })),

    // Transitions
    setDefaultTransition: (type) => set({ defaultTransition: type || '', autosaveState: 'unsaved' }),

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
