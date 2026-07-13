/**
 * DaliViD — history.js
 * Global undo/redo across the graph and timeline stores (Ctrl+Z / Ctrl+Shift+Z).
 *
 * Snapshots are REFERENCE captures, not deep copies: every store action in the
 * codebase updates immutably (Zustand convention — spread/map, never in-place
 * mutation), so holding the previous top-level references is enough to restore
 * them. That makes each snapshot O(1) even when clip graphs embed large image
 * data URLs.
 *
 * Rapid successive changes (a slider drag emits dozens of store updates)
 * coalesce into a single undo step via a time window: the first change in a
 * burst pushes the pre-change state; the rest just refresh the window.
 *
 * Watched state:
 *   graph:    masterGraph, clipGraphs, compoundLibrary
 *   timeline: tracks, clips, markers, keyframes, inPoint, outPoint
 * (playhead, zoom, scroll and other view state are deliberately not undoable)
 */

import useGraphStore from '../store/useGraphStore'
import useTimelineStore from '../store/useTimelineStore'
import useAppStore from '../store/useAppStore'

const MAX_HISTORY = 50
const COALESCE_MS = 400

const undoStack = []
const redoStack = []
let isRestoring = false
let lastChangeTime = 0
let started = false

function captureGraph(s) {
  return {
    masterGraph: s.masterGraph,
    clipGraphs: s.clipGraphs,
    compoundLibrary: s.compoundLibrary,
  }
}

function captureTimeline(s) {
  return {
    tracks: s.tracks,
    clips: s.clips,
    markers: s.markers,
    keyframes: s.keyframes,
    inPoint: s.inPoint,
    outPoint: s.outPoint,
  }
}

function graphChanged(prev, next) {
  return prev.masterGraph !== next.masterGraph
    || prev.clipGraphs !== next.clipGraphs
    || prev.compoundLibrary !== next.compoundLibrary
}

function timelineChanged(prev, next) {
  return prev.tracks !== next.tracks
    || prev.clips !== next.clips
    || prev.markers !== next.markers
    || prev.keyframes !== next.keyframes
    || prev.inPoint !== next.inPoint
    || prev.outPoint !== next.outPoint
}

/**
 * Record the pre-change state of both stores. `prevGraph`/`prevTimeline` are
 * the changed store's previous state; the other store's CURRENT state is its
 * own before-state (it didn't change in this event).
 */
function recordChange(prevGraph, prevTimeline) {
  if (isRestoring) return
  const now = performance.now()
  const inBurst = now - lastChangeTime < COALESCE_MS
  lastChangeTime = now
  if (inBurst) return // coalesce: the burst's first snapshot already captured pre-state

  undoStack.push({
    graph: prevGraph ? captureGraph(prevGraph) : captureGraph(useGraphStore.getState()),
    timeline: prevTimeline ? captureTimeline(prevTimeline) : captureTimeline(useTimelineStore.getState()),
  })
  if (undoStack.length > MAX_HISTORY) undoStack.shift()
  redoStack.length = 0 // a new change invalidates the redo branch
}

function applySnapshot(snap) {
  isRestoring = true
  try {
    useGraphStore.setState({
      ...snap.graph,
      // Recompile everything against the restored graphs.
      topologyVersion: useGraphStore.getState().topologyVersion + 1,
    })
    useTimelineStore.setState({ ...snap.timeline })
    useAppStore.getState().markUnsaved?.()
  } finally {
    isRestoring = false
  }
}

export function undo() {
  if (undoStack.length === 0) return false
  const current = {
    graph: captureGraph(useGraphStore.getState()),
    timeline: captureTimeline(useTimelineStore.getState()),
  }
  const snap = undoStack.pop()
  redoStack.push(current)
  applySnapshot(snap)
  return true
}

export function redo() {
  if (redoStack.length === 0) return false
  const current = {
    graph: captureGraph(useGraphStore.getState()),
    timeline: captureTimeline(useTimelineStore.getState()),
  }
  const snap = redoStack.pop()
  undoStack.push(current)
  applySnapshot(snap)
  return true
}

export function canUndo() { return undoStack.length > 0 }
export function canRedo() { return redoStack.length > 0 }

/** Wipe history — called after loading/creating a project so Ctrl+Z can't
 *  cross project boundaries. */
export function clearHistory() {
  undoStack.length = 0
  redoStack.length = 0
  lastChangeTime = 0
}

/** Subscribe to both stores. Call once at app startup; safe to call again. */
export function initHistory() {
  if (started) return
  started = true

  useGraphStore.subscribe((state, prevState) => {
    if (!prevState || !graphChanged(prevState, state)) return
    recordChange(prevState, null)
  })

  useTimelineStore.subscribe((state, prevState) => {
    if (!prevState || !timelineChanged(prevState, state)) return
    recordChange(null, prevState)
  })
}
