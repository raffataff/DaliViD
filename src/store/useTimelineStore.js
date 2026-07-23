/**
 * DaliVid — useTimelineStore.js
 * Manages tracks, clips, keyframes, markers, and in/out points.
 */

import { create } from 'zustand'

let clipCounter = 0
let trackCounter = 0

const useTimelineStore = create((set, get) => ({
  // ── Tracks ──
  tracks: [],

  // ── Clips ──
  clips: [],

  // ── Markers ──
  markers: [],

  // ── In/Out Points ──
  inPoint: null,
  outPoint: null,

  // ── Keyframes ──
  keyframes: [], // { clipId, nodeId, paramName, keys: [{ time, value, easing, bezierHandles }] }

  // ── Zoom ──
  timelineZoom: 1, // pixels per second multiplier
  timelineScrollLeft: 0,

  // ── Actions ──

  /**
   * Add a new track.
   */
  addTrack: (type = 'video', name = null) => {
    const id = `track_${Date.now()}_${++trackCounter}`
    const trackName = name || `${type === 'video' ? 'Video' : type === 'audio' ? 'Audio' : 'Automation'} ${get().tracks.filter(t => t.type === type).length + 1}`
    const colors = ['#00e5ff', '#ff00aa', '#ffaa00', '#44cc88', '#4488ff', '#ff8844']
    const color = colors[get().tracks.length % colors.length]

    const track = {
      id,
      name: trackName,
      type,
      muted: false,
      solo: false,
      locked: false,
      blendMode: 'Normal',
      opacity: 1.0,
      color,
      zOrder: get().tracks.length,
    }

    set((state) => ({
      tracks: [...state.tracks, track],
    }))

    return id
  },

  /**
   * Remove a track and all its clips.
   */
  removeTrack: (trackId) => {
    set((state) => ({
      tracks: state.tracks.filter(t => t.id !== trackId),
      clips: state.clips.filter(c => c.trackId !== trackId),
    }))
  },

  /**
   * Update a track's properties.
   */
  updateTrack: (trackId, updates) => {
    set((state) => ({
      tracks: state.tracks.map(t =>
        t.id === trackId ? { ...t, ...updates } : t
      ),
    }))
  },

  /**
   * Toggle track mute.
   */
  toggleMute: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(t =>
        t.id === trackId ? { ...t, muted: !t.muted } : t
      ),
    }))
  },

  /**
   * Toggle track solo (exclusive — only one solo at a time).
   */
  toggleSolo: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(t =>
        t.id === trackId ? { ...t, solo: !t.solo } : { ...t, solo: false }
      ),
    }))
  },

  /**
   * Toggle track lock.
   */
  toggleLock: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(t =>
        t.id === trackId ? { ...t, locked: !t.locked } : t
      ),
    }))
  },

  /**
   * Reorder tracks.
   */
  reorderTracks: (fromIndex, toIndex) => {
    set((state) => {
      const tracks = [...state.tracks]
      const [moved] = tracks.splice(fromIndex, 1)
      tracks.splice(toIndex, 0, moved)
      return { tracks: tracks.map((t, i) => ({ ...t, zOrder: i })) }
    })
  },

  /**
   * Add a clip to a track.
   */
  addClip: (trackId, clipData) => {
    const id = `clip_${Date.now()}_${++clipCounter}`
    const clip = {
      filename: clipData.filename || 'Untitled',
      fileUrl: clipData.fileUrl || null,
      fileType: clipData.fileType || 'video', // 'video' | 'audio' | 'camera' | 'screen' | 'image' | 'text'
      // Generator clips (text/image) keep their content + style here (text string,
      // image data URL, fit/transform). Empty for media-backed clips.
      params: clipData.params || {},
      timelineStart: clipData.timelineStart || 0,
      timelineEnd: clipData.timelineEnd || 10,
      sourceStart: clipData.sourceStart || 0,
      sourceEnd: clipData.sourceEnd || 10,
      speed: 1.0,
      opacity: 1.0,
      volume: 1.0,       // clip audio gain (0..1); multiplied by fades/transitions
      audioMuted: false, // hard-mute this clip's own audio (video sound, etc.)
      // 'Inherit' = use the track's blend mode; any concrete name (incl. 'Normal') overrides it.
      blendMode: 'Inherit',
      fadeIn: 0,  // seconds of linear opacity ramp at the clip's start
      fadeOut: 0, // seconds of linear opacity ramp at the clip's end
      // Transition-in: { type, params } from transitionRegistry — plays across
      // the overlap with the previous clip on the track. null = hard cut/blend.
      transition: null,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      metadata: {
        width: clipData.width || 1920,
        height: clipData.height || 1080,
        fps: clipData.fps || 30,
        duration: clipData.duration || 10,
      },
      hasEffects: false,
      ...clipData,
      id,
      trackId,
    }

    set((state) => ({
      clips: [...state.clips, clip],
    }))

    return id
  },

  /**
   * Remove a clip.
   */
  removeClip: (clipId) => {
    set((state) => ({
      clips: state.clips.filter(c => c.id !== clipId),
      keyframes: state.keyframes.filter(k => k.clipId !== clipId),
    }))
  },

  /**
   * Update a clip's properties.
   */
  updateClip: (clipId, updates) => {
    set((state) => ({
      clips: state.clips.map(c =>
        c.id === clipId ? { ...c, ...updates } : c
      ),
    }))
  },

  /**
   * Move a clip on the timeline.
   */
  moveClip: (clipId, newStart, newTrackId = null) => {
    set((state) => {
      const clip = state.clips.find(c => c.id === clipId)
      if (!clip) return state
      const duration = clip.timelineEnd - clip.timelineStart
      return {
        clips: state.clips.map(c =>
          c.id === clipId
            ? {
                ...c,
                timelineStart: newStart,
                timelineEnd: newStart + duration,
                trackId: newTrackId || c.trackId,
              }
            : c
        ),
      }
    })
  },

  /**
   * Trim a clip's left or right edge.
   */
  trimClip: (clipId, edge, newTime) => {
    set((state) => ({
      clips: state.clips.map(c => {
        if (c.id !== clipId) return c
        if (edge === 'left') {
          const newSourceStart = c.sourceStart + (newTime - c.timelineStart)
          return {
            ...c,
            timelineStart: Math.min(newTime, c.timelineEnd - (1 / 30)), // Min 1 frame
            sourceStart: Math.max(0, newSourceStart),
          }
        } else {
          return {
            ...c,
            timelineEnd: Math.max(newTime, c.timelineStart + (1 / 30)),
          }
        }
      }),
    }))
  },

  /**
   * Split a clip at the playhead.
   */
  splitClip: (clipId, splitTime) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return
    if (splitTime <= clip.timelineStart || splitTime >= clip.timelineEnd) return

    const rightId = `clip_${Date.now()}_${++clipCounter}`
    const splitSourceTime = clip.sourceStart + (splitTime - clip.timelineStart) * clip.speed

    set((state) => ({
      clips: state.clips.map(c => {
        if (c.id !== clipId) return c
        // Fades belong to the outer edges: the left half keeps the fade-in and
        // loses the fade-out (the cut is now its end), and vice versa — so a
        // split doesn't introduce a dip at the cut point.
        return { ...c, timelineEnd: splitTime, sourceEnd: splitSourceTime, fadeOut: 0 }
      }).concat({
        ...clip,
        id: rightId,
        timelineStart: splitTime,
        sourceStart: splitSourceTime,
        fadeIn: 0,
        // The right half starts at a hard cut — a transition-in belongs to the
        // original clip's start, so it stays with the left half only.
        transition: null,
      }),
    }))

    return rightId
  },

  /**
   * Get clips on a specific track, sorted by start time.
   */
  getClipsOnTrack: (trackId) => {
    return get().clips
      .filter(c => c.trackId === trackId)
      .sort((a, b) => a.timelineStart - b.timelineStart)
  },

  /**
   * Get the clip at a specific time on a track.
   */
  getClipAtTime: (trackId, time) => {
    return get().clips.find(c =>
      c.trackId === trackId &&
      time >= c.timelineStart &&
      time < c.timelineEnd
    )
  },

  // ── Markers ──
  addMarker: (time, label = '', color = '#ff3344') => {
    const id = `marker_${Date.now()}`
    set((state) => ({
      markers: [...state.markers, { id, time, label, color }],
    }))
    return id
  },

  removeMarker: (id) => {
    set((state) => ({
      markers: state.markers.filter(m => m.id !== id),
    }))
  },

  updateMarker: (id, updates) => {
    set((state) => ({
      markers: state.markers.map(m =>
        m.id === id ? { ...m, ...updates } : m
      ),
    }))
  },

  // ── In/Out Points ──
  setInPoint: (time) => set({ inPoint: time }),
  setOutPoint: (time) => set({ outPoint: time }),
  clearInOutPoints: () => set({ inPoint: null, outPoint: null }),

  // ── Keyframes ──
  addKeyframe: (clipId, nodeId, paramName, time, value, easing = 'linear') => {
    set((state) => {
      const existing = state.keyframes.find(
        k => k.clipId === clipId && k.nodeId === nodeId && k.paramName === paramName
      )
      if (existing) {
        return {
          keyframes: state.keyframes.map(k => {
            if (k.clipId === clipId && k.nodeId === nodeId && k.paramName === paramName) {
              return {
                ...k,
                // Re-keying at (almost) the same time REPLACES the key, so
                // dragging a slider with auto-key on doesn't stack duplicates.
                keys: [...k.keys.filter(key => Math.abs(key.time - time) > 0.001), { time, value, easing, bezierHandles: null }]
                  .sort((a, b) => a.time - b.time),
              }
            }
            return k
          }),
        }
      }
      return {
        keyframes: [
          ...state.keyframes,
          {
            clipId,
            nodeId,
            paramName,
            keys: [{ time, value, easing, bezierHandles: null }],
          },
        ],
      }
    })
  },

  removeKeyframe: (clipId, nodeId, paramName, time) => {
    set((state) => ({
      keyframes: state.keyframes.map(k => {
        if (k.clipId === clipId && k.nodeId === nodeId && k.paramName === paramName) {
          return {
            ...k,
            keys: k.keys.filter(key => key.time !== time),
          }
        }
        return k
      }).filter(k => k.keys.length > 0),
    }))
  },

  // ── Timeline Zoom ──
  // Very wide bounds so the timeline can zoom out to fit hour-long songs (the
  // lower the zoom, the more time fits on screen) and in for frame-level work.
  // Clamp stays finite/positive to avoid divide-by-zero and runaway scroll math.
  setTimelineZoom: (zoom) => set({ timelineZoom: Math.max(0.002, Math.min(50, zoom)) }),
  setTimelineScrollLeft: (scrollLeft) => set({ timelineScrollLeft: Math.max(0, scrollLeft) }),

  /**
   * Calculate total project duration from all clips.
   */
  calculateDuration: () => {
    const clips = get().clips
    if (clips.length === 0) return 0
    return Math.max(...clips.map(c => c.timelineEnd))
  },
}))

export default useTimelineStore
