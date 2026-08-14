/**
 * DaliVid — dataNodeParams.js
 *
 * Param configs for the SHADERLESS "data" nodes (MATH, ENVELOPE,
 * TRANSITION_PROGRESS, RAMP, LFO). Every other node's controls are parsed from
 * its GLSL `@param` directives (shaderRegistry → paramParser), but these nodes
 * have no shader — they're evaluated CPU-side in `resolveFloatConnections`.
 *
 * This file is their single source of truth: the node card, the Inspector, the
 * compound param surface and the float-socket generator (`getNodeSockets`, which
 * turns each non-select/checkbox config into a float input socket) all read it.
 * Previously the same lists were hardcoded in three places and drifted.
 *
 * RAMP and LFO replace the old combined TIME node. TIME wore two jobs — "play
 * once across a span" and "oscillate forever" — which made `Rate` mean three
 * different things depending on the Source and Beat Sync, and put ten controls
 * on one card where at most six were ever live. `TIME` is kept here only as the
 * migration source (see `migrateTimeNodeParams`); nothing creates one.
 */

// Option lists are exported so the evaluator can map a stored string back to an
// index (selects persist either the index or the label — see CompoundParamRow).
export const MATH_OPERATIONS = [
  'Add', 'Subtract', 'Multiply', 'Divide', 'Sine', 'Cosine',
  'Absolute', 'Min', 'Max', 'Greater Than', 'Less Than',
]

/**
 * RAMP spans — each normalises a time window to 0…1, which is the whole point of
 * the node: "Clip" + defaults IS a keyframe pair from the clip's first frame to
 * its last, and it re-times itself when the clip is moved, trimmed or retimed.
 * All three are DETERMINISTIC (functions of timeline position), so scrubbing
 * shows the real animation and an export is pixel-identical to the preview.
 */
export const RAMP_SPANS = ['Clip', 'Timeline', 'In / Out Range']

// Shaping applied to the 0…1 progress before it is remapped into Start…End.
export const RAMP_EASINGS = ['Linear', 'Smooth', 'Ease In', 'Ease Out']

/**
 * LFO time bases. 'Playhead' is the default because it is deterministic (see
 * above). 'Clip Time' restarts the oscillator at each clip's first frame.
 * 'Free Run' uses the render clock — it keeps moving while paused, which is what
 * you want live/VJ but is not frame-accurate on export.
 */
export const LFO_BASES = ['Playhead', 'Clip Time', 'Free Run']

export const LFO_WAVES = [
  'Sine', 'Triangle', 'Saw Up', 'Saw Down', 'Square',
  'Bounce', 'Random Hold', 'Smooth Random', 'Linear',
]

// Legacy — the TIME node's source list, kept so saved projects can be migrated.
export const TIME_SOURCES = ['Playhead', 'Clip Time', 'Clip Progress', 'Free Run']
export const TIME_WAVES = LFO_WAVES

export const DATA_NODE_PARAMS = {
  MATH: [
    { name: 'Operation', uniformName: 'operation', type: 'select', options: MATH_OPERATIONS, default: 0 },
    { name: 'Value A', uniformName: 'value_a', type: 'slider', min: -100, max: 100, step: 0.01, default: 0 },
    { name: 'Value B', uniformName: 'value_b', type: 'slider', min: -100, max: 100, step: 0.01, default: 1 },
  ],
  ENVELOPE: [
    { name: 'Attack', uniformName: 'attack', type: 'slider', min: 0.001, max: 1, step: 0.001, default: 0.05 },
    { name: 'Release', uniformName: 'release', type: 'slider', min: 0.01, max: 2, step: 0.01, default: 0.35 },
    { name: 'Threshold', uniformName: 'threshold', type: 'slider', min: 0, max: 0.95, step: 0.01, default: 0 },
    { name: 'Gain', uniformName: 'gain', type: 'slider', min: 0, max: 4, step: 0.05, default: 1 },
  ],
  TRANSITION_PROGRESS: [
    { name: 'Auto Preview', uniformName: 'auto_preview', type: 'checkbox', default: true },
    { name: 'Preview', uniformName: 'preview', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, showIf: { param: 'auto_preview', equals: false } },
    { name: 'Preview Speed', uniformName: 'preview_speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.25, showIf: { param: 'auto_preview', equals: true } },
  ],
  // RAMP — plays ONCE across a span. Defaults give a clean 0 → 1 over the clip,
  // so wiring `Value` into any float socket is a two-keyframe animation with no
  // keyframes. End may be below Start (a countdown) — it's a remap, not a range.
  RAMP: [
    { name: 'Span', uniformName: 'span', type: 'select', options: RAMP_SPANS, default: 0 },
    { name: 'Start', uniformName: 'start', type: 'slider', min: -100, max: 100, step: 0.01, default: 0 },
    { name: 'End', uniformName: 'end', type: 'slider', min: -100, max: 100, step: 0.01, default: 1 },
    { name: 'Ease', uniformName: 'ease', type: 'select', options: RAMP_EASINGS, default: 0 },
    // Cycles > 1 repeats the ramp within the span (4 = four sweeps per clip).
    { name: 'Cycles', uniformName: 'cycles', type: 'slider', min: 0, max: 32, step: 0.25, default: 1 },
    { name: 'Ping-Pong', uniformName: 'ping_pong', type: 'checkbox', default: false },
    { name: 'Offset', uniformName: 'offset', type: 'slider', min: 0, max: 1, step: 0.001, default: 0 },
  ],
  // LFO — oscillates forever. Its time base is always seconds, so `Rate` has
  // exactly one meaning (cycles per second) unless Beat Sync takes over.
  LFO: [
    { name: 'Wave', uniformName: 'wave', type: 'select', options: LFO_WAVES, default: 0 },
    { name: 'Time Base', uniformName: 'base', type: 'select', options: LFO_BASES, default: 0 },
    { name: 'Beat Sync', uniformName: 'beat_sync', type: 'checkbox', default: false },
    { name: 'Rate', uniformName: 'rate', type: 'slider', min: 0, max: 20, step: 0.01, default: 1, showIf: { param: 'beat_sync', equals: false } },
    { name: 'Beats / Cycle', uniformName: 'beats', type: 'slider', min: 0.25, max: 32, step: 0.25, default: 4, showIf: { param: 'beat_sync', equals: true } },
    { name: 'Phase', uniformName: 'phase', type: 'slider', min: 0, max: 1, step: 0.001, default: 0 },
    { name: 'Min', uniformName: 'min', type: 'slider', min: -100, max: 100, step: 0.01, default: 0 },
    { name: 'Max', uniformName: 'max', type: 'slider', min: -100, max: 100, step: 0.01, default: 1 },
    { name: 'Pulse Width', uniformName: 'pulse_width', type: 'slider', min: 0.01, max: 0.99, step: 0.01, default: 0.5, showIf: { param: 'wave', equals: 'Square' } },
    // Linear is unbounded by design, so the S-curve would be meaningless there.
    { name: 'Smooth', uniformName: 'smooth', type: 'checkbox', default: false, showIf: { param: 'wave', notEquals: 'Linear' } },
  ],
}

/** Param configs for a shaderless data node, or [] for anything else. */
export function getDataNodeParams(nodeType) {
  return DATA_NODE_PARAMS[nodeType] || []
}

/**
 * Read a select param that may be stored as an index (number) or as the option
 * label (string), returning a safe index. Both shapes exist in saved projects.
 */
export function selectIndex(value, options, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return (value >= 0 && value < options.length) ? Math.round(value) : fallback
  }
  if (typeof value === 'string') {
    const i = options.indexOf(value)
    if (i >= 0) return i
    const n = parseInt(value, 10)
    if (Number.isFinite(n) && n >= 0 && n < options.length) return n
  }
  return fallback
}

/**
 * Resolve a `showIf` clause against the node's live params.
 *
 * Controls whose value can't do anything are noise, and noise is what made the
 * old TIME card hard to read (Beats/Cycle with Beat Sync off, Pulse Width on a
 * Sine wave). A config may carry `showIf: { param, equals }` or
 * `showIf: { param, notEquals }`; `equals` accepts a single value or an array.
 *
 * **`showIf` may also be an ARRAY of clauses, which are ANDed.** A GLSL shader
 * declares one `@showif` line per clause and `paramParser` accumulates them, so
 * a control can depend on two other params at once — `ARRAY`'s Spacing Y is
 * both "Grid mode only" and "Centered anchor only". A single clause stays a
 * plain object and takes exactly the path it always did.
 *
 * Select params compare by LABEL (`equals: 'Square'`) but may be *stored* as an
 * index, so the stored value is normalised through the referenced config's
 * option list first — the same both-shapes tolerance as `selectIndex`.
 *
 * Note this only hides CONTROLS. Sockets stay unconditional (`getNodeSockets`
 * never sees showIf), because a hidden param can still legitimately be driven
 * by a wire and removing its socket would strand the noodle. Callers pass
 * `alwaysShow` (the node's connected input socket ids) so a wired param keeps
 * its row — and therefore its socket anchor — whatever the mode says.
 *
 * @param {object} config     — the param config being tested
 * @param {object} params     — the node's current params
 * @param {Array}  allConfigs — sibling configs, used to resolve select labels
 * @param {Set}    alwaysShow — uniform names that must stay visible
 */
export function isParamVisible(config, params = {}, allConfigs = [], alwaysShow = null) {
  const rule = config?.showIf
  if (!rule) return true
  if (alwaysShow && alwaysShow.has(config.uniformName)) return true

  const test = (r) => {
    if (!r || !r.param) return true

    const ref = allConfigs.find(c => c.uniformName === r.param)
    const raw = params[r.param] ?? ref?.default

    // Normalise to something comparable with the rule's operand.
    let actual = raw
    if (ref?.type === 'select' && Array.isArray(ref.options)) {
      actual = ref.options[selectIndex(raw, ref.options, 0)]
    } else if (ref?.type === 'checkbox') {
      actual = !!raw
    }

    if ('notEquals' in r) {
      const list = Array.isArray(r.notEquals) ? r.notEquals : [r.notEquals]
      return !list.includes(actual)
    }
    const list = Array.isArray(r.equals) ? r.equals : [r.equals]
    return list.includes(actual)
  }

  return Array.isArray(rule) ? rule.every(test) : test(rule)
}

/** Convenience wrapper: the visible subset of a node's param configs. */
export function visibleDataParams(configs, params, alwaysShow = null) {
  if (!configs?.length) return configs || []
  if (!configs.some(c => c.showIf)) return configs // fast path — most nodes
  return configs.filter(c => isParamVisible(c, params, configs, alwaysShow))
}

/**
 * Migrate a saved TIME node into a RAMP or an LFO.
 *
 * The split is exact rather than lossy: TIME's four sources map 1:1 onto the two
 * nodes. 'Clip Progress' was the span-normalised one, so it becomes a RAMP (its
 * wave choice becomes an easing / ping-pong, which is what those waves were
 * being used for across a clip); the other three were seconds-based oscillator
 * bases, so they become an LFO and keep their wave verbatim.
 *
 * Socket ids are preserved across the split — both nodes expose `value` and
 * `seconds` — so every existing edge out of a migrated node still lands.
 *
 * @returns {{ type: string, params: object }}
 */
export function migrateTimeNodeParams(params = {}) {
  const src = selectIndex(params.source, TIME_SOURCES, 0)
  const min = params.min ?? 0
  const max = params.max ?? 1

  if (src !== 2) {
    return {
      type: 'LFO',
      params: {
        wave: params.wave ?? 0,
        // Playhead → Playhead, Clip Time → Clip Time, Free Run → Free Run.
        base: src === 1 ? 1 : (src === 3 ? 2 : 0),
        beat_sync: !!params.beat_sync,
        rate: params.rate ?? 1,
        beats: params.beats ?? 4,
        phase: params.phase ?? 0,
        min, max,
        pulse_width: params.pulse_width ?? 0.5,
        smooth: !!params.smooth,
      },
    }
  }

  // Clip Progress → RAMP. The wave was doing an easing's job across the span.
  const wave = selectIndex(params.wave, TIME_WAVES, 0)
  const SAW_DOWN = 3
  // Sine / Triangle / Bounce all went up then back down over the clip.
  const pingPong = wave === 0 || wave === 1 || wave === 5
  // Sine, Bounce and an explicit Smooth flag all wanted eased ends.
  const ease = (wave === 0 || wave === 5 || params.smooth) ? 1 : 0

  return {
    type: 'RAMP',
    params: {
      span: 0, // Clip Progress was always the clip's window
      start: wave === SAW_DOWN ? max : min,
      end: wave === SAW_DOWN ? min : max,
      ease,
      cycles: params.rate ?? 1,
      ping_pong: pingPong,
      offset: params.phase ?? 0,
    },
  }
}
