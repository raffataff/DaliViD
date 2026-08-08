/**
 * DaliVid — clipTransitions.js
 * Single source of truth for a clip's EDGE TRANSITIONS (head / tail).
 *
 * The model, in one paragraph: every clip has two edge regions — a HEAD at its
 * start and a TAIL at its end — and each region is exactly the fade wedge you
 * see on the clip corner. A region with no transition type is a plain linear
 * opacity ramp (what fades have always been). Give the region a type and a
 * shader (or a node graph) owns that window instead, driven by `u_progress`
 * 0 → 1 across it. So "fade", "crossfade" and "transition" are one concept with
 * one duration and one handle, which is the whole point of this module:
 * Renderer, Timeline, Inspector and ExportModal all derive their geometry here
 * so the picture, the wedge you drag and the exported audio can't drift apart.
 *
 * What the region mixes against:
 *   HEAD, with a previous clip overlapping the start → CROSSFADE. The region is
 *     the overlap (the NLE convention: the overlap IS the transition duration),
 *     FROM = everything composited so far (which includes the outgoing clip).
 *   HEAD, with nothing before it → FROM NOTHING. The region is `fadeIn`, and
 *     FROM = whatever is behind (lower tracks, else black). A "fade in" is just
 *     this with the default ramp; any transition can play the same role.
 *   TAIL → TO NOTHING. The region is `fadeOut`, TO = whatever is behind. This is
 *     the case the old overlap-only model simply could not express: it lived on
 *     the INCOMING clip, so the last clip in a sequence had no way to wipe out.
 *
 * A tail is suppressed while a later clip overlaps it — that cut already belongs
 * to the incoming clip's head, and running both would cross-dissolve twice.
 */

// Regions shorter than this are treated as absent — guards divide-by-zero and
// stops sub-frame slivers from flickering a transition on for one frame.
export const MIN_REGION = 0.001

// Length given to an edge that has no region yet when an effect is assigned to
// it. A transition needs a WINDOW as well as a type, and the two are set from
// different places (the wedge handle vs. the effect picker) — so assigning an
// effect to a zero-length edge produced a transition that was stored, editable,
// and completely invisible. One second is the NLE default and is trimmed by
// dragging the wedge, exactly like a fade.
export const DEFAULT_EDGE_SECONDS = 1

export const EDGE_HEAD = 'in'
export const EDGE_TAIL = 'out'
export const EDGES = [EDGE_HEAD, EDGE_TAIL]

// Marker MIME type set alongside the normal drag payload when a TRANSITION is
// dragged. `dataTransfer.getData` is blocked outside the `drop` event, so a
// dragover handler can only inspect `types` — this is how the Timeline knows to
// highlight the clip edge a drop would land on instead of treating the drag as
// a new generator clip.
export const TRANSITION_DRAG_TYPE = 'application/dalivid-transition'

/** Human label for an edge, used by the Timeline menu and the Inspector. */
export function edgeLabel(edge) {
  return edge === EDGE_TAIL ? 'Transition Out' : 'Transition In'
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// ── Per-clip transition graphs ───────────────────────────────────────────────
// A "graph" transition is stored in useGraphStore.clipGraphs under a synthetic
// key, NOT in a separate map. That is deliberate: every graph action in the
// store (addNode / addEdge / setNodeParam / …) and the whole Node Editor are
// already keyed by (graphLevel, clipId), so a synthetic clip id makes a
// transition graph editable through the existing plumbing with no new branches
// — and the serializer, which maps clipGraphs generically, persists it for free.

export const GRAPH_KEY_SEP = '::tr:'

/** clipGraphs key holding this clip edge's private transition graph. */
export function transitionGraphKey(clipId, edge) {
  return `${clipId}${GRAPH_KEY_SEP}${edge}`
}

/** true for a key produced by transitionGraphKey (i.e. not a real clip id). */
export function isTransitionGraphKey(key) {
  return typeof key === 'string' && key.includes(GRAPH_KEY_SEP)
}

/** Split a transition-graph key back into { clipId, edge }, or null. */
export function parseTransitionGraphKey(key) {
  if (!isTransitionGraphKey(key)) return null
  const i = key.indexOf(GRAPH_KEY_SEP)
  const edge = key.slice(i + GRAPH_KEY_SEP.length)
  if (edge !== EDGE_HEAD && edge !== EDGE_TAIL) return null
  return { clipId: key.slice(0, i), edge }
}

// ── Transition type helpers ──────────────────────────────────────────────────

/** `type` value for a per-clip node graph. */
export const GRAPH_TYPE = 'graph'
/** Prefix for a shared compound-library transition. */
export const COMPOUND_PREFIX = 'compound:'

export const isGraphType = (type) => type === GRAPH_TYPE
export const isCompoundType = (type) => typeof type === 'string' && type.startsWith(COMPOUND_PREFIX)
export const compoundIdOf = (type) => (isCompoundType(type) ? type.slice(COMPOUND_PREFIX.length) : null)

/**
 * This clip edge's transition descriptor, or null.
 * `clip.transition` is the pre-edge-model field (transition-in only) and is
 * still read here so an in-memory clip from an older session — or one restored
 * by undo from a pre-migration snapshot — keeps rendering.
 */
export function getEdgeTransition(clip, edge) {
  if (!clip) return null
  if (edge === EDGE_TAIL) return clip.transitionOut || null
  return clip.transitionIn || clip.transition || null
}

/**
 * updateClip patch that sets one edge's transition. Writing the head also
 * clears the legacy field, so the two can never disagree afterwards.
 */
export function setEdgeTransitionPatch(edge, transition) {
  return edge === EDGE_TAIL
    ? { transitionOut: transition }
    : { transitionIn: transition, transition: null }
}

/**
 * updateClip patch guaranteeing `edge` has a window for an effect to play
 * across, or `null` when it already has one.
 *
 * Every route that assigns an effect must apply this, and that is the whole
 * reason it lives here rather than in one caller: the Timeline's wedge menu did
 * it and the Inspector's picker did not, so choosing a transition from the
 * Inspector on a clip whose handle sat at zero assigned the type, created the
 * node graph, opened the editor — and rendered nothing, with no way to tell
 * from the UI that a length was the missing ingredient.
 *
 * A head region backed by an overlap already takes its length from that
 * overlap, so `region` non-null is left alone. The default is capped at half
 * the clip so a short clip doesn't end up entirely inside its own transition.
 *
 * @param {object} clip
 * @param {string} edge — EDGE_HEAD | EDGE_TAIL
 * @param {object|null} region — the edge's current region (headRegion/tailRegion)
 * @returns {object|null} a patch to merge into updateClip, or null if unneeded
 */
export function ensureEdgeRegionPatch(clip, edge, region) {
  if (region) return null
  const half = Math.max(0.1, (clip.timelineEnd - clip.timelineStart) / 2)
  const len = Math.min(DEFAULT_EDGE_SECONDS, half)
  return { [edge === EDGE_TAIL ? 'fadeOut' : 'fadeIn']: len }
}

// ── Region geometry ──────────────────────────────────────────────────────────

/**
 * The clip on `clip`'s track that overlaps its START (the outgoing side of a
 * crossfade), or null. When several qualify the latest-starting one wins — it
 * is the one visually adjacent to the cut.
 */
export function findPrevOverlap(clip, clips) {
  if (!clip) return null
  let best = null
  for (const c of clips) {
    if (c === clip || c.id === clip.id || c.trackId !== clip.trackId) continue
    if (c.timelineStart >= clip.timelineStart || c.timelineEnd <= clip.timelineStart) continue
    if (!best || c.timelineStart > best.timelineStart) best = c
  }
  return best
}

/**
 * The clip that overlaps `clip`'s END, or null. Its presence suppresses the
 * tail region: that cut is already owned by its own head transition.
 */
export function findNextOverlap(clip, clips) {
  if (!clip) return null
  let best = null
  for (const c of clips) {
    if (c === clip || c.id === clip.id || c.trackId !== clip.trackId) continue
    if (c.timelineStart <= clip.timelineStart || c.timelineStart >= clip.timelineEnd) continue
    if (!best || c.timelineStart < best.timelineStart) best = c
  }
  return best
}

/**
 * The head region: `{ start, end, dur, mode, prev }`, or null when there is
 * none. `mode` is 'crossfade' (mixes with the overlapping previous clip) or
 * 'nothing' (mixes with whatever is behind — lower tracks, else black).
 *
 * An overlap outranks `fadeIn`: two clips overlapping by 1s is an unambiguous
 * 1s crossfade, and honouring a separate fadeIn on top would dip the incoming
 * clip twice inside the same window.
 */
export function headRegion(clip, prevOverlap) {
  if (!clip) return null
  if (prevOverlap) {
    const end = Math.min(prevOverlap.timelineEnd, clip.timelineEnd)
    const dur = end - clip.timelineStart
    if (dur > MIN_REGION) {
      return { start: clip.timelineStart, end, dur, mode: 'crossfade', prev: prevOverlap }
    }
  }
  const dur = clip.fadeIn || 0
  if (dur <= MIN_REGION) return null
  return {
    start: clip.timelineStart,
    end: Math.min(clip.timelineEnd, clip.timelineStart + dur),
    dur,
    mode: 'nothing',
    prev: null,
  }
}

/**
 * The tail region, or null. Always mode 'nothing' — a tail mixes toward what is
 * behind the clip. `nextOverlap` present ⇒ null (see the module header).
 */
export function tailRegion(clip, nextOverlap) {
  if (!clip || nextOverlap) return null
  const dur = clip.fadeOut || 0
  if (dur <= MIN_REGION) return null
  return {
    start: Math.max(clip.timelineStart, clip.timelineEnd - dur),
    end: clip.timelineEnd,
    dur,
    mode: 'nothing',
    prev: null,
  }
}

/**
 * One edge's region resolved straight from the live clip list — the head/tail
 * split and the neighbour lookup in a single call, so a caller can't get the
 * pairing wrong (tail with findPrevOverlap, say) or forget that neighbours must
 * come from the FULL list rather than the currently-active clips.
 */
export function edgeRegion(clip, clips, edge) {
  return edge === EDGE_TAIL
    ? tailRegion(clip, findNextOverlap(clip, clips))
    : headRegion(clip, findPrevOverlap(clip, clips))
}

/**
 * Which edge of `clip` the time `t` belongs to — the near half is the head, the
 * far half the tail.
 *
 * Every "apply a transition here" gesture needs this: the T shortcut, a drop
 * from the Transitions browser, a click on a clip-end hotspot. Splitting at the
 * midpoint (rather than at a fixed distance from each end) means the answer is
 * always defined, however short the clip and however far from an end you land.
 */
export function nearestEdge(clip, t) {
  const mid = (clip.timelineStart + clip.timelineEnd) / 2
  return t >= mid ? EDGE_TAIL : EDGE_HEAD
}

/**
 * Whether a transition actually governs this edge — i.e. there is both a region
 * for it to play across and an effect assigned to it. An effect with no region
 * is inert, which is why this is not just `!!getEdgeTransition(...)`.
 */
export function edgeHasEffect(clip, edge, region) {
  return !!(region && getEdgeTransition(clip, edge)?.type)
}

/**
 * How long the edge's wedge should be drawn, in seconds.
 *
 * This is NOT always the region length. A tail suppressed by an overlapping
 * next clip still runs its plain `fadeOut` ramp — the transition is what's
 * blocked, not the fade — and a head backed by an overlap only borrows the
 * overlap's length once a transition is actually on it. Drawing the region
 * unconditionally would show a wedge where the picture doesn't fade, or hide
 * one where it does; this returns whichever length the compositor will really
 * use, so the wedge you drag is the ramp you see.
 */
export function edgeDisplaySeconds(clip, edge, region) {
  if (edgeHasEffect(clip, edge, region)) return region.dur
  return (edge === EDGE_TAIL ? clip.fadeOut : clip.fadeIn) || 0
}

/** 0 → 1 across a region at `t`, or null when `t` is outside it. */
export function regionProgress(region, t) {
  if (!region || region.dur <= MIN_REGION) return null
  if (t < region.start || t >= region.end) return null
  return clamp01((t - region.start) / region.dur)
}

/**
 * Everything the compositor needs for one clip this frame, computed once and
 * shared with the audio path so sound always tracks picture.
 *
 * `headTransition` / `tailTransition` are non-null only when a typed transition
 * actually OWNS the window right now. `fade` is the plain opacity ramp with any
 * owned window removed from it — that removal is the fix for the old "why is my
 * transition also fading?" double-dip, where a clip carrying both a fade handle
 * and a transition got the ramp applied on top of the shader's own mix.
 *
 * @param {object} clip
 * @param {object|null} prevOverlap — clip overlapping this one's start
 * @param {object|null} nextOverlap — clip overlapping this one's end
 * @param {number} t — playhead time
 */
export function clipEdgeState(clip, prevOverlap, nextOverlap, t) {
  const head = headRegion(clip, prevOverlap)
  const tail = tailRegion(clip, nextOverlap)

  // "Has an effect" is a property of the EDGE, not of this instant — see the
  // ramp note below for why that distinction matters.
  const headTr = head ? getEdgeTransition(clip, EDGE_HEAD) : null
  const tailTr = tail ? getEdgeTransition(clip, EDGE_TAIL) : null
  const headHasEffect = !!headTr?.type
  const tailHasEffect = !!tailTr?.type

  const headP = regionProgress(head, t)
  const tailP = regionProgress(tail, t)

  // A composite pass has one FROM and one TO, so at most one transition can run
  // per frame. On a clip short enough that its two regions overlap
  // (fadeIn + fadeOut > duration) the head wins, so a clip's entrance is never
  // cut short by its own exit; the tail still gets the frames after the head
  // region ends.
  const headLive = headHasEffect && headP != null
  const tailLive = tailHasEffect && tailP != null && !headLive

  // Plain ramps for the edges no shader took over.
  //
  // The suppression is per EDGE, not per frame: an edge carrying a transition
  // has NO ramp at any point in the clip. Suppressing it only inside the region
  // was wrong, because the region and `fadeIn` need not be the same length — a
  // 2s fadeIn on a clip that crossfades over a 0.5s overlap would see the ramp
  // resume at 25% the moment the crossfade finished, snapping the picture back
  // down right after it had fully arrived.
  let fade = 1
  if (!headHasEffect && clip.fadeIn > 0) {
    fade *= clamp01((t - clip.timelineStart) / clip.fadeIn)
  }
  if (!tailHasEffect && clip.fadeOut > 0) {
    fade *= clamp01((clip.timelineEnd - t) / clip.fadeOut)
  }

  return {
    head, tail,
    headProgress: headP,
    tailProgress: tailP,
    headTransition: headLive ? headTr : null,
    tailTransition: tailLive ? tailTr : null,
    fade,
  }
}

/**
 * The audible level a clip's own envelope implies: volume × mute × the same
 * ramps the picture uses. A transition-owned window contributes its progress
 * directly (head ramps up, tail ramps down), so a shader transition crossfades
 * the sound exactly like the default fade does.
 *
 * Takes no time argument on purpose — everything time-dependent is already
 * resolved in `edgeState`, so the sound is by construction reading the same
 * instant the picture did rather than re-deriving it.
 *
 * Shared by the live renderer and the offline export mixdown.
 */
export function clipEnvelopeGain(clip, edgeState) {
  if (!clip || clip.audioMuted) return 0
  let g = clip.volume == null ? 1 : clamp01(clip.volume)
  g *= edgeState.fade
  if (edgeState.headTransition && edgeState.headProgress != null) g *= edgeState.headProgress
  if (edgeState.tailTransition && edgeState.tailProgress != null) g *= 1 - edgeState.tailProgress
  return g
}
