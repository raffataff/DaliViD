/**
 * DaliVid — transitionActions.js
 * The write side of the edge-transition model.
 *
 * `utils/clipTransitions.js` stays pure — it answers questions about geometry
 * and never touches a store. This module is its action peer: the handful of
 * multi-step mutations that assign, open and remove an edge's effect.
 *
 * It exists because those steps were duplicated in the Timeline's wedge menu and
 * the Inspector's picker and had already drifted. The Timeline gave a
 * zero-length edge a default region before assigning an effect; the Inspector
 * did not — so choosing a transition there stored the type, created the node
 * graph, opened the editor, and rendered absolutely nothing, with the panel
 * offering only a passive note that a length was missing. Anything that assigns
 * an effect must go through here.
 */

import useGraphStore from '../store/useGraphStore'
import useTimelineStore from '../store/useTimelineStore'
import { clearTransitionStatus } from '../gl/transitionStatus'
import {
  getTransitionDefaults, getTransitionLabel, getTransitionDescription,
  getTransitionCategory, TRANSITION_TYPES, TRANSITION_CATEGORIES,
} from '../shaders/transitionRegistry'
import { isTransitionCompound } from './compoundUtils'
import { buildTransitionSeedGraph } from '../shaders/compoundPresets'
import {
  GRAPH_TYPE, isGraphType, isCompoundType, compoundIdOf,
  getEdgeTransition, setEdgeTransitionPatch, ensureEdgeRegionPatch,
  transitionGraphKey, edgeRegion,
} from './clipTransitions'

/**
 * Every transition a user can choose, as one flat list of
 * `{ type, label, description, group }`.
 *
 * The same three groups were being assembled independently by the Inspector's
 * dropdown and the Timeline's effect menu, and the Media Pool's browser would
 * have made three. `type` is exactly what `applyEdgeType` takes, so a picker
 * never has to know the difference between a registry shader, a library
 * compound and a private graph.
 *
 * @param {Array} compoundLibrary
 */
export function transitionCatalog(compoundLibrary = []) {
  return [
    { type: '', label: 'Fade', description: 'Plain opacity ramp — the default when no effect is assigned.', group: 'Basic' },
    ...TRANSITION_TYPES.map(t => ({
      type: t,
      label: getTransitionLabel(t),
      description: getTransitionDescription(t),
      group: getTransitionCategory(t),
    })),
    {
      type: GRAPH_TYPE,
      label: 'Node Graph',
      description: 'Build this transition from nodes, private to the clip edge you apply it to.',
      group: 'Node Graph',
    },
    ...compoundLibrary.filter(isTransitionCompound).map(c => ({
      type: `compound:${c.id}`,
      label: c.name,
      description: c.description || 'Shared node transition from the compound library.',
      group: 'Node Graph',
      color: c.color,
    })),
  ]
}

/**
 * Catalog group names in display order. Derived from the registry's own category
 * list rather than hard-coded, so adding a category to a new transition surfaces
 * it in the browser and the dropdown with no UI edit — the same rule the shape
 * and transform param UIs already follow.
 */
export const CATALOG_GROUPS = ['Basic', ...TRANSITION_CATEGORIES, 'Node Graph']

/** The catalog split into `{ group, items }`, empty groups dropped. */
export function groupedTransitionCatalog(compoundLibrary = []) {
  const all = transitionCatalog(compoundLibrary)
  return CATALOG_GROUPS
    .map(group => ({ group, items: all.filter(e => e.group === group) }))
    .filter(g => g.items.length > 0)
}

/** Display name for whatever a `type` refers to, across all three kinds. */
export function transitionLabelOf(type, compoundLibrary = []) {
  if (!type) return 'Fade'
  if (isGraphType(type)) return 'Node Graph'
  if (isCompoundType(type)) {
    return compoundLibrary.find(c => c.id === compoundIdOf(type))?.name || 'Missing compound'
  }
  return getTransitionLabel(type)
}

/**
 * The sub-graph a "Convert to Node Graph" should start from, given what the edge
 * is carrying right now.
 *
 * Converting must PRESERVE the effect. Seeding the starter crossfade regardless
 * meant that converting a Film Burn silently discarded it and left a plain mix —
 * which is indistinguishable, from the outside, from the node graph being
 * broken. Three cases:
 *   · a shared library compound → fork a copy of it (unchanged behaviour)
 *   · a built-in shader         → that transition as a TRANSITION_FX node,
 *                                 carrying its current param values
 *   · nothing (plain Fade)      → the MIX_BLEND crossfade
 */
function seedGraphFor(clip, edge, compoundLibrary) {
  const prev = getEdgeTransition(clip, edge)
  if (isCompoundType(prev?.type)) {
    const entry = compoundLibrary.find(c => c.id === compoundIdOf(prev.type))
    if (entry?.subGraph) return entry.subGraph
  }
  const builtIn = prev?.type && !isGraphType(prev.type) && !isCompoundType(prev.type) ? prev.type : null
  return buildTransitionSeedGraph(builtIn, builtIn ? prev.params : null)
}

/** One edge's region read from LIVE store state (post-update, not from props). */
export function liveEdgeRegion(clipId, edge) {
  const clips = useTimelineStore.getState().clips
  const clip = clips.find(c => c.id === clipId)
  return clip ? edgeRegion(clip, clips, edge) : null
}

/**
 * Assign (or clear) one edge's effect, creating whatever it needs to actually
 * play: a region to run across, and — for a private node graph — the graph
 * itself, seeded from whatever the edge was using before.
 *
 * @param {object} clip
 * @param {string} edge — EDGE_HEAD | EDGE_TAIL
 * @param {string|null} type — '' / null means "plain opacity ramp"
 * @param {object|null} region — the edge's CURRENT region, from edgeRegion()
 * @param {(id: string, patch: object) => void} updateClip
 * @param {Array} compoundLibrary
 */
export function applyEdgeType(clip, edge, type, region, updateClip, compoundLibrary = []) {
  // Any health note belongs to the effect being replaced. The renderer sets a
  // fresh one the next time it composites this edge, so dropping it here just
  // stops the old warning describing the new effect.
  clearTransitionStatus(transitionGraphKey(clip.id, edge))

  // A region first, always. A head region backed by an overlap already has its
  // length from that overlap, so ensureEdgeRegionPatch returns null and the
  // handle is left alone.
  const patch = { ...(ensureEdgeRegionPatch(clip, edge, region) || {}) }

  if (!type) {
    // Back to the plain ramp. The private graph is deliberately KEPT: flipping
    // between effects to compare them must not destroy work, and the graph is
    // only reachable through this edge anyway (clearEdge is the destructive
    // one, and it is a separate, explicitly-labelled action).
    Object.assign(patch, setEdgeTransitionPatch(edge, null))
    updateClip(clip.id, patch)
    return
  }

  if (isGraphType(type)) {
    const key = transitionGraphKey(clip.id, edge)
    if (!useGraphStore.getState().clipGraphs[key]) {
      useGraphStore.getState().initTransitionGraph(clip.id, edge, seedGraphFor(clip, edge, compoundLibrary))
    }
    Object.assign(patch, setEdgeTransitionPatch(edge, { type: GRAPH_TYPE, params: {} }))
  } else {
    // Built-ins start from their registry defaults; compounds start empty — the
    // library entry's exposedParams carry their own.
    Object.assign(patch, setEdgeTransitionPatch(edge, {
      type,
      params: isCompoundType(type) ? {} : getTransitionDefaults(type),
    }))
  }

  updateClip(clip.id, patch)
}

/**
 * Apply a transition to one edge of a clip, resolving everything from ids.
 *
 * The single entry point for the "gesture" routes — the T shortcut, a drop from
 * the Transitions browser, a click on a clip-end hotspot — none of which have a
 * clip object or a region in hand, only an id and a place on the timeline. They
 * must not each re-derive the region (that is how the Timeline and the Inspector
 * drifted apart in the first place).
 *
 * @param {string} clipId
 * @param {string} edge
 * @param {string|null} type — null/'' = plain opacity ramp
 * @returns {boolean} false when the clip is gone
 */
export function applyTransitionById(clipId, edge, type) {
  const clip = useTimelineStore.getState().clips.find(c => c.id === clipId)
  if (!clip) return false
  applyEdgeType(
    clip, edge, type,
    liveEdgeRegion(clipId, edge),
    useTimelineStore.getState().updateClip,
    useGraphStore.getState().compoundLibrary,
  )
  return true
}

/**
 * Park the playhead where this edge's transition is actually visible.
 *
 * Deliberately not the exact midpoint of a two-frame region: `regionProgress`
 * is half-open (null at region.end), so a caller landing on the very end would
 * see no transition at all. 0.5 keeps that impossible while still showing the
 * frame where a transition is most legible.
 *
 * @returns {number|null} the time parked at, or null when there is no region
 */
export function playheadForRegion(region, setPlayheadTime) {
  if (!region) return null
  const t = region.start + region.dur * 0.5
  setPlayheadTime(t)
  return t
}

/**
 * Open one edge's private node graph in the Node Editor, converting the edge to
 * a graph transition first if it isn't one already.
 *
 * @param {object} clip
 * @param {string} edge
 * @param {object|null} region — CURRENT region (before any conversion)
 * @param {object} deps — { updateClip, compoundLibrary, enterClipGraph, setPlayheadTime }
 */
export function openEdgeGraphAction(clip, edge, region, deps) {
  const { updateClip, compoundLibrary, enterClipGraph, setPlayheadTime } = deps
  const tr = getEdgeTransition(clip, edge)
  if (!isGraphType(tr?.type)) {
    applyEdgeType(clip, edge, GRAPH_TYPE, region, updateClip, compoundLibrary)
  } else {
    // Already a graph transition — but the window can have been dragged back to
    // zero since, and opening an editor onto a graph that provably cannot run is
    // the failure this pass exists to remove. Assigning the effect guarantees a
    // window; re-opening it must too.
    const patch = ensureEdgeRegionPatch(clip, edge, region)
    if (patch) updateClip(clip.id, patch)
  }

  // Read the region back from the store, not from the argument: applyEdgeType
  // may have just created it, and parking against the pre-patch geometry would
  // land the playhead outside the window that now exists — opening the editor
  // on a frame where the transition isn't running, which is precisely the "it
  // does nothing" experience this whole pass is about.
  if (setPlayheadTime) playheadForRegion(liveEdgeRegion(clip.id, edge), setPlayheadTime)

  enterClipGraph(transitionGraphKey(clip.id, edge))
}
