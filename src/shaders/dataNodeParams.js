/**
 * DaliVid — dataNodeParams.js
 *
 * Param configs for the SHADERLESS "data" nodes (MATH, ENVELOPE,
 * TRANSITION_PROGRESS, TIME). Every other node's controls are parsed from its
 * GLSL `@param` directives (shaderRegistry → paramParser), but these nodes have
 * no shader — they're evaluated CPU-side in `resolveFloatConnections`.
 *
 * This file is their single source of truth: the node card, the Inspector, the
 * compound param surface and the float-socket generator (`getNodeSockets`, which
 * turns each non-select/checkbox config into a float input socket) all read it.
 * Previously the same lists were hardcoded in three places and drifted.
 */

// Option lists are exported so the evaluator can map a stored string back to an
// index (selects persist either the index or the label — see CompoundParamRow).
export const MATH_OPERATIONS = [
  'Add', 'Subtract', 'Multiply', 'Divide', 'Sine', 'Cosine',
  'Absolute', 'Min', 'Max', 'Greater Than', 'Less Than',
]

// TIME sources. 'Playhead' is the default because it is DETERMINISTIC: the value
// depends only on timeline position, so scrubbing shows the real animation and an
// export is pixel-identical to the preview. 'Free Run' uses the render clock
// (keeps moving while paused — live/VJ use, not frame-accurate on export).
export const TIME_SOURCES = ['Playhead', 'Clip Time', 'Clip Progress', 'Free Run']

export const TIME_WAVES = [
  'Sine', 'Triangle', 'Saw Up', 'Saw Down', 'Square',
  'Bounce', 'Random Hold', 'Smooth Random', 'Linear',
]

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
    { name: 'Preview', uniformName: 'preview', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5 },
    { name: 'Preview Speed', uniformName: 'preview_speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.25 },
  ],
  // TIME — an LFO / ramp generator. Wire its Value output into any float param
  // socket and that param animates without a single keyframe.
  TIME: [
    { name: 'Source', uniformName: 'source', type: 'select', options: TIME_SOURCES, default: 0 },
    { name: 'Wave', uniformName: 'wave', type: 'select', options: TIME_WAVES, default: 0 },
    { name: 'Beat Sync', uniformName: 'beat_sync', type: 'checkbox', default: false },
    // Rate is cycles/second normally; with Clip Progress it is cycles per clip.
    { name: 'Rate', uniformName: 'rate', type: 'slider', min: 0, max: 20, step: 0.01, default: 1 },
    { name: 'Beats / Cycle', uniformName: 'beats', type: 'slider', min: 0.25, max: 32, step: 0.25, default: 4 },
    { name: 'Phase', uniformName: 'phase', type: 'slider', min: 0, max: 1, step: 0.001, default: 0 },
    { name: 'Min', uniformName: 'min', type: 'slider', min: -100, max: 100, step: 0.01, default: 0 },
    { name: 'Max', uniformName: 'max', type: 'slider', min: -100, max: 100, step: 0.01, default: 1 },
    { name: 'Pulse Width', uniformName: 'pulse_width', type: 'slider', min: 0.01, max: 0.99, step: 0.01, default: 0.5 },
    { name: 'Smooth', uniformName: 'smooth', type: 'checkbox', default: false },
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
