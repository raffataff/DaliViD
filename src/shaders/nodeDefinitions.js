/**
 * DaliVid — nodeDefinitions.js
 * Defines socket layouts for every node type.
 * Enables multi-socket nodes and connection type validation.
 *
 * Socket types:
 *   'texture' — video/image data (cyan)
 *   'audio'   — audio signal routing (magenta)
 *   'float'   — single value for driving params (yellow)
 */

export const SOCKET_TYPES = {
  TEXTURE: 'texture',
  AUDIO: 'audio',
  FLOAT: 'float',
}

export const SOCKET_COLORS = {
  texture: '#00e5ff',
  audio: '#ff00aa',
  float: '#ffdd00',
}

/**
 * Can a connection be made between these socket types?
 * Same types always connect. Float can also connect to texture (modulation).
 */
export function canConnect(fromType, toType) {
  return fromType === toType
}

/**
 * Static socket definitions per node type.
 * Effect nodes use DEFAULT_EFFECT_DEF and get param inputs auto-generated.
 */
const NODE_DEFS = {
  // ── I/O ──
  VIDEO_INPUT: {
    inputs: [],
    outputs: [
      { id: 'output', type: 'texture', name: 'Video' },
      { id: 'audio_out', type: 'audio', name: 'Audio' },
    ],
    hasParamInputs: false,
  },
  CAMERA_INPUT: {
    inputs: [],
    outputs: [
      { id: 'output', type: 'texture', name: 'Video' },
      { id: 'audio_out', type: 'audio', name: 'Audio' },
    ],
    hasParamInputs: true,
  },
  AUDIO_INPUT: {
    inputs: [],
    outputs: [
      { id: 'audio_out', type: 'audio', name: 'Audio' },
    ],
    hasParamInputs: false,
  },
  AUDIO_SPLITTER: {
    inputs: [
      { id: 'audio_in', type: 'audio', name: 'Audio In' },
    ],
    outputs: [
      { id: 'sub_bass', type: 'float', name: 'Sub Bass' },
      { id: 'bass', type: 'float', name: 'Bass' },
      { id: 'low_mid', type: 'float', name: 'Low Mid' },
      { id: 'mid', type: 'float', name: 'Mid' },
      { id: 'high_mid', type: 'float', name: 'High Mid' },
      { id: 'presence', type: 'float', name: 'Presence' },
      { id: 'treble', type: 'float', name: 'Treble' },
      { id: 'rms', type: 'float', name: 'RMS' },
      { id: 'beat', type: 'float', name: 'Beat' },
    ],
    hasParamInputs: false,
  },
  AUDIO_VISUALIZER: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input' },
      { id: 'audio_in', type: 'audio', name: 'Audio In' },
    ],
    outputs: [
      { id: 'output', type: 'texture', name: 'Output' },
    ],
    hasParamInputs: true,
  },
  OUTPUT: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input' },
    ],
    outputs: [],
    hasParamInputs: false,
  },
  CLIP_SOURCE: {
    inputs: [],
    outputs: [
      { id: 'output', type: 'texture', name: 'Video' },
      { id: 'audio_out', type: 'audio', name: 'Audio' },
    ],
    hasParamInputs: false,
  },
  CLIP_OUTPUT: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input' },
    ],
    outputs: [],
    hasParamInputs: false,
  },
  EFFECT_INPUT: {
    inputs: [],
    outputs: [
      { id: 'output', type: 'texture', name: 'Output' },
    ],
    hasParamInputs: false,
  },
  EFFECT_OUTPUT: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input' },
    ],
    outputs: [],
    hasParamInputs: false,
  },
  // MATH_BLEND kept for backward compatibility (two texture inputs)
  MATH_BLEND: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input A' },
      { id: 'input_b', type: 'texture', name: 'Input B' },
      { id: 'audio_drivers', type: 'float', name: 'Audio Drivers' },
    ],
    outputs: [
      { id: 'output', type: 'texture', name: 'Output' },
    ],
    hasParamInputs: true,
  },
  // MIX_BLEND — texture-based mixing/blending (same shader as MATH_BLEND)
  MIX_BLEND: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input A' },
      { id: 'input_b', type: 'texture', name: 'Input B' },
      { id: 'audio_drivers', type: 'float', name: 'Audio Drivers' },
    ],
    outputs: [
      { id: 'output', type: 'texture', name: 'Output' },
    ],
    hasParamInputs: true,
  },
  // MATH — CPU-side math operations on float values, no GLSL shader
  MATH: {
    inputs: [],
    outputs: [
      { id: 'output', type: 'float', name: 'Output' },
    ],
    hasParamInputs: true,
  },
  // DISPLACEMENT has texture + displacement map inputs
  DISPLACEMENT: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input' },
      { id: 'disp_map', type: 'texture', name: 'Disp Map' },
      { id: 'audio_drivers', type: 'float', name: 'Audio Drivers' },
    ],
    outputs: [
      { id: 'output', type: 'texture', name: 'Output' },
    ],
    hasParamInputs: true,
  },
}

/**
 * Default definition for standard effect nodes (single texture in → out).
 */
const DEFAULT_EFFECT_DEF = {
  inputs: [
    { id: 'input', type: 'texture', name: 'Input' },
    { id: 'audio_drivers', type: 'float', name: 'Audio Drivers' },
  ],
  outputs: [
    { id: 'output', type: 'texture', name: 'Output' },
  ],
  hasParamInputs: true,
}

/**
 * Get the static definition for a node type.
 */
export function getNodeDef(nodeType) {
  return NODE_DEFS[nodeType] || DEFAULT_EFFECT_DEF
}

/**
 * Get all sockets for a node, including dynamically generated param inputs.
 * @param {string} nodeType
 * @param {Array} paramConfigs — parsed @param configs from the shader
 * @returns {{ inputs: Array, outputs: Array }}
 */
export function getNodeSockets(nodeType, paramConfigs = []) {
  const def = getNodeDef(nodeType)

  const inputs = [...def.inputs]
  const outputs = [...def.outputs]

  // Add param input sockets for effect nodes
  if (def.hasParamInputs && paramConfigs.length > 0) {
    for (const param of paramConfigs) {
      // Skip select and checkbox parameters — they don't get float sockets
      if (param.type === 'select' || param.type === 'checkbox') continue
      inputs.push({
        id: param.uniformName,
        type: 'float',
        name: param.name,
        isParam: true,
      })
    }
  }

  return { inputs, outputs }
}

/**
 * Compute the Y position of a socket relative to the node's top.
 * @param {number} socketIndex — index within the input or output array
 * @param {number} totalSockets — total count on that side
 * @returns {number} — Y offset from node top
 */
export function getSocketYOffset(socketIndex) {
  const HEADER_H = 30
  const SOCKET_SPACING = 22
  const FIRST_SOCKET_OFFSET = HEADER_H + 14
  return FIRST_SOCKET_OFFSET + socketIndex * SOCKET_SPACING
}

/**
 * Get the minimum card height based on socket count.
 */
export function getMinCardHeight(inputs, outputs, hasParams) {
  const maxSockets = Math.max(inputs.length, outputs.length)
  const HEADER_H = 30
  const SOCKET_AREA = maxSockets * 22 + 14
  const PARAM_AREA = hasParams ? 40 : 0 // thumbnail + collapsed params
  return HEADER_H + SOCKET_AREA + PARAM_AREA + 8
}

export default NODE_DEFS
