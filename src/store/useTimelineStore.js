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
      fileType: clipData.fileType || 'video', // 'video' | 'audio' | 'camera' | 'screen' | 'image' | 'text' | 'shape'
      // Generator clips (text/image) keep their content + style here (text string,
      // image data URL, fit/transform). Empty for media-backed clips.
      params: clipData.params || {},
      timelineStart: clipData.timelineStart || 0,
      timelineEnd: clipData.timelineEnd || 10,
      sourceStart: clipData.sourceStart || 0,
      sourceEnd: clipData.sourceEnd || 10,
      speed: 1.0,
      // Play the source backwards: sourceEnd → sourceStart across the clip's
      // timeline span. Purely a source-time mapping (see getClipSourceTime), so
      // trimming/moving/splitting keep working unchanged.
      reversed: false,
      opacity: 1.0,
      volume: 1.0,       // clip audio gain (0..1); multiplied by fades/transitions
      audioMuted: false, // hard-mute this clip's own audio (video sound, etc.)
      // 'Inherit' = use the track's blend mode; any concrete name (incl. 'Normal') overrides it.
      blendMode: 'Inherit',
      // Edge regions. fadeIn/fadeOut are the region LENGTHS in seconds and, on
      // their own, a plain linear opacity ramp. Give the matching edge a
      // transition and that shader/graph owns the window instead — same handle,
      // same duration, richer effect (see utils/clipTransitions.js).
      fadeIn: 0,
      fadeOut: 0,
      // { type, params } | null. transitionIn plays across the overlap with the
      // previous clip when there is one, otherwise across fadeIn from nothing;
      // transitionOut plays across fadeOut, out to whatever is behind the clip.
      transitionIn: null,
      transitionOut: null,
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
    const elapsed = (splitTime - clip.timelineStart) * clip.speed
    // A reversed clip walks the source backwards, so the cut lands the OTHER way
    // round: the left half plays sourceEnd → split, the right half split →
    // sourceStart. Getting this wrong silently swaps the two halves' content.
    const splitSourceTime = clip.reversed
      ? clip.sourceEnd - elapsed
      : clip.sourceStart + elapsed

    set((state) => ({
      clips: state.clips.map(c => {
        if (c.id !== clipId) return c
        // Edges belong to the OUTER boundaries: the left half keeps the head
        // region and loses the tail (the cut is now its end), the right half
        // vice versa — so a split doesn't introduce a dip, or replay a
        // transition, at the cut point.
        const left = { timelineEnd: splitTime, fadeOut: 0, transitionOut: null }
        return c.reversed
          ? { ...c, ...left, sourceStart: splitSourceTime }
          : { ...c, ...left, sourceEnd: splitSourceTime }
      }).concat({
        ...clip,
        id: rightId,
        timelineStart: splitTime,
        ...(clip.reversed ? { sourceEnd: splitSourceTime } : { sourceStart: splitSourceTime }),
        fadeIn: 0,
        transitionIn: null,
        transition: null, // legacy field — never let a stale copy resurrect
      }),
    }))

    return rightId
  },

  /**
   * Duplicate a clip, dropping the copy immediately after the original on the
   * same track (the NLE convention — no overlap, no hunting for a free slot).
   * Returns the new id so the caller can clone the clip's effect graph too.
   */
  duplicateClip: (clipId) => {
    const clip = get().clips.find(c => c.id === clipId)
    if (!clip) return null
    const newId = `clip_${Date.now()}_${++clipCounter}`
    const duration = clip.timelineEnd - clip.timelineStart

    set((state) => ({
      clips: [...state.clips, {
        ...clip,
        id: newId,
        timelineStart: clip.timelineEnd,
        timelineEnd: clip.timelineEnd + duration,
        // The copy butts up against the original, so it starts on a hard cut —
        // a head transition here would play over its own source clip. The tail
        // is still the sequence's outer edge, so it comes along.
        transitionIn: null,
        transition: null,
      }],
    }))

    return newId
  },

  /**
   * Ripple delete: remove a clip and close the gap by pulling every LATER clip
   * on the same track back by its duration. Only that track shifts, matching
   * Premiere/Resolve's per-track ripple (a global ripple would desync other
   * tracks against the audio).
   */
  rippleDeleteClip: (clipId) => {
    const clip = get().clips.find(c => c.id === clipId)
    if (!clip) return
    const duration = clip.timelineEnd - clip.timelineStart

    set((state) => ({
      clips: state.clips
        .filter(c => c.id !== clipId)
        .map(c => (
          c.trackId === clip.trackId && c.timelineStart >= clip.timelineEnd
            ? { ...c, timelineStart: c.timelineStart - duration, timelineEnd: c.timelineEnd - duration }
            : c
        )),
      keyframes: state.keyframes.filter(k => k.clipId !== clipId),
    }))
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

  // Move every key sitting on one clip-time COLUMN to a new time. The timeline
  // draws one diamond per rounded-millisecond column (merged across all of a
  // clip's params/nodes), so dragging that diamond shifts the whole column —
  // matched by `fromMs` (an integer ms) and re-stamped to `toTime` seconds.
  // Keeps each track sorted and collapses any exact collision at the target.
  moveClipKeyframes: (clipId, fromMs, toTime) => {
    const dest = Math.max(0, toTime)
    set((state) => ({
      keyframes: state.keyframes.map(k => {
        if (k.clipId !== clipId) return k
        let changed = false
        const moved = k.keys.map(key => {
          if (Math.round(key.time * 1000) === fromMs) {
            changed = true
            return { ...key, time: dest }
          }
          return key
        })
        if (!changed) return k
        // Sort, then drop exact-time duplicates (a key dragged onto an existing
        // one merges — the moved key, sorted-stable, wins).
        const sorted = moved.sort((a, b) => a.time - b.time)
        const deduped = sorted.filter((key, i) =>
          i === 0 || Math.abs(key.time - sorted[i - 1].time) > 1e-4
        )
        return { ...k, keys: deduped }
      }),
    }))
  },

  // Delete every key on one clip-time column (Alt+click a timeline diamond).
  removeClipKeyframesAtMs: (clipId, fromMs) => {
    set((state) => ({
      keyframes: state.keyframes.map(k => {
        if (k.clipId !== clipId) return k
        return { ...k, keys: k.keys.filter(key => Math.round(key.time * 1000) !== fromMs) }
      }).filter(k => k.keys.length > 0),
    }))
  },

  // Move ONE key of one param from `oldTime` to `newTime` (the keyframe-lane
  // drag). Preserves its value/easing, re-sorts, and merges an exact collision.
  moveKeyframe: (clipId, nodeId, paramName, oldTime, newTime) => {
    const dest = Math.max(0, newTime)
    set((state) => ({
      keyframes: state.keyframes.map(k => {
        if (k.clipId !== clipId || k.nodeId !== nodeId || k.paramName !== paramName) return k
        const moved = k.keys.map(key =>
          Math.abs(key.time - oldTime) < 1e-4 ? { ...key, time: dest } : key
        )
        const sorted = moved.sort((a, b) => a.time - b.time)
        const deduped = sorted.filter((key, i) =>
          i === 0 || Math.abs(key.time - sorted[i - 1].time) > 1e-4
        )
        return { ...k, keys: deduped }
      }),
    }))
  },

  // Remove one param's whole keyframe track (right-click → Clear param).
  clearParamKeyframes: (clipId, nodeId, paramName) => {
    set((state) => ({
      keyframes: state.keyframes.filter(
        k => !(k.clipId === clipId && k.nodeId === nodeId && k.paramName === paramName)
      ),
    }))
  },

  // Remove every keyframe track belonging to a node (right-click → Clear all).
  clearNodeKeyframes: (clipId, nodeId) => {
    set((state) => ({
      keyframes: state.keyframes.filter(k => !(k.clipId === clipId && k.nodeId === nodeId)),
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
