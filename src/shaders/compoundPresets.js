/**
 * DaliVid — compoundPresets.js
 * Pre-built compound effect presets and user compound instantiation.
 */

import { parseParams } from '../utils/paramParser'
import { getShaderSource } from './shaderRegistry'

export const COMPOUND_PRESETS = [
  {
    id: 'psychedelic_pulse', name: 'Psychedelic Pulse',
    description: 'Audio-reactive kaleidoscope + chromatic aberration + feedback',
    category: 'Creative', color: '#ff44cc',
    subGraph: {
      nodes: [
        { type: 'KALEIDOSCOPE', name: 'Kaleidoscope', relPos: { x: 0, y: 0 }, params: { u_segments: 8, u_zoom: 1.2 } },
        { type: 'CHROMATIC_ABERRATION', name: 'Chromatic Split', relPos: { x: 220, y: 0 }, params: { u_offset: 0.008, u_radial: true } },
        { type: 'FEEDBACK', name: 'Feedback Trail', relPos: { x: 440, y: 0 }, params: { u_feedback: 0.7, u_fb_zoom: 1.003, u_fb_rotate: 0.01 } },
        { type: 'COLOR_INVERSION', name: 'Hue Shift', relPos: { x: 660, y: 0 }, params: { u_hue_shift: 0.0, u_saturation: 1.4, u_brightness: 1.1 } },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
  {
    id: 'digital_decay', name: 'Digital Decay',
    description: 'Glitch + pixel sort + CRT scanlines for a broken digital aesthetic',
    category: 'Distortion', color: '#ff3344',
    subGraph: {
      nodes: [
        { type: 'GLITCH', name: 'Glitch', relPos: { x: 0, y: 0 }, params: { u_intensity: 0.4, u_block_size: 24, u_speed: 3.0 } },
        { type: 'PIXEL_SORT', name: 'Pixel Sort', relPos: { x: 220, y: 0 }, params: { u_threshold_lo: 0.15, u_threshold_hi: 0.85, u_intensity: 0.6 } },
        { type: 'CRT', name: 'CRT Overlay', relPos: { x: 440, y: 0 }, params: { u_curvature: 0.03, u_scanline_intensity: 0.4, u_vignette: 0.5 } },
        { type: 'NOISE', name: 'Film Grain', relPos: { x: 660, y: 0 }, params: { u_amount: 0.12 } },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
  {
    id: 'dreamy_glow', name: 'Dreamy Glow',
    description: 'Bloom + blur + color grading for a soft dreamy look',
    category: 'Color', color: '#ffcc44',
    subGraph: {
      nodes: [
        { type: 'BLOOM', name: 'Bloom', relPos: { x: 0, y: 0 }, params: { u_threshold: 0.5, u_bloom_intensity: 1.5, u_radius: 12 } },
        { type: 'BLUR', name: 'Soft Blur', relPos: { x: 220, y: 0 }, params: { u_radius: 2.0 } },
        { type: 'LUT', name: 'Warm Grade', relPos: { x: 440, y: 0 }, params: { u_temperature: 0.3, u_contrast: 1.1, u_gamma: 0.9, u_lift: 0.02 } },
        { type: 'VIGNETTE', name: 'Vignette', relPos: { x: 660, y: 0 }, params: { u_size: 0.6, u_softness: 0.5 } },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
  {
    id: 'cyberpunk_edge', name: 'Cyberpunk Edge',
    description: 'Edge detection + chromatic aberration + color shift for neon aesthetics',
    category: 'Stylize', color: '#00e5ff',
    subGraph: {
      nodes: [
        { type: 'EDGE_DETECTION', name: 'Edge Detect', relPos: { x: 0, y: 0 }, params: { u_threshold: 0.08, u_strength: 2.0, u_show_original: true } },
        { type: 'CHROMATIC_ABERRATION', name: 'RGB Split', relPos: { x: 220, y: 0 }, params: { u_offset: 0.006, u_radial: false } },
        { type: 'COLOR_INVERSION', name: 'Neon Color', relPos: { x: 440, y: 0 }, params: { u_hue_shift: 0.6, u_saturation: 2.0, u_brightness: 1.3 } },
        { type: 'BLOOM', name: 'Neon Glow', relPos: { x: 660, y: 0 }, params: { u_threshold: 0.4, u_bloom_intensity: 2.0, u_radius: 6 } },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
  {
    id: 'retro_vhs', name: 'Retro VHS',
    description: 'CRT + glitch + noise + chromatic for VHS tape look',
    category: 'Distortion', color: '#cc8844',
    subGraph: {
      nodes: [
        { type: 'CHROMATIC_ABERRATION', name: 'Tape Bleed', relPos: { x: 0, y: 0 }, params: { u_offset: 0.003, u_radial: false } },
        { type: 'CRT', name: 'Scanlines', relPos: { x: 220, y: 0 }, params: { u_curvature: 0.02, u_scanline_intensity: 0.5, u_vignette: 0.3 } },
        { type: 'GLITCH', name: 'Tracking', relPos: { x: 440, y: 0 }, params: { u_intensity: 0.15, u_block_size: 32, u_speed: 1.0 } },
        { type: 'NOISE', name: 'Tape Noise', relPos: { x: 660, y: 0 }, params: { u_amount: 0.2, u_animated: true } },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
  {
    id: 'fluid_morph', name: 'Fluid Morph',
    description: 'Fluid warp + voronoi + feedback for organic flowing visuals',
    category: 'Creative', color: '#44ccff',
    subGraph: {
      nodes: [
        { type: 'FLUID_WARP', name: 'Flow', relPos: { x: 0, y: 0 }, params: { u_strength: 0.06, u_speed: 0.8, u_warp_scale: 4.0, u_octaves: 3 } },
        { type: 'VORONOI', name: 'Cells', relPos: { x: 220, y: 0 }, params: { u_cells: 6, u_edge_width: 0.015, u_animate: true, u_color_mode: 0 } },
        { type: 'FEEDBACK', name: 'Trail', relPos: { x: 440, y: 0 }, params: { u_feedback: 0.6, u_fb_zoom: 1.002 } },
        { type: 'BLOOM', name: 'Glow', relPos: { x: 660, y: 0 }, params: { u_threshold: 0.5, u_bloom_intensity: 1.2, u_radius: 8 } },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
]

/**
 * Instantiate a compound preset into the graph store.
 */
export function instantiatePreset(presetId, addNode, addEdge, graphLevel, clipId, basePos = { x: 200, y: 200 }) {
  const preset = COMPOUND_PRESETS.find(p => p.id === presetId)
  if (!preset) return null

  const nodeIds = []
  for (const nodeDef of preset.subGraph.nodes) {
    const nodeId = addNode(graphLevel, clipId, {
      type: nodeDef.type, name: nodeDef.name,
      position: { x: basePos.x + nodeDef.relPos.x, y: basePos.y + nodeDef.relPos.y },
      params: { ...nodeDef.params },
    })
    nodeIds.push(nodeId)
  }
  for (const edgeDef of preset.subGraph.edges) {
    addEdge(graphLevel, clipId, nodeIds[edgeDef.from], edgeDef.fromSocket, nodeIds[edgeDef.to], edgeDef.toSocket)
  }
  return nodeIds
}

/**
 * Instantiate a user-created compound from the compound library.
 * Creates a COMPOUND node containing a deep copy of the sub-graph.
 */
export function instantiateUserCompound(libraryEntry, addNode, addEdge, graphLevel, clipId, basePos = { x: 200, y: 200 }) {
  if (!libraryEntry?.subGraph) return null

  const idMap = {} // old ID -> new ID
  const subGraph = libraryEntry.subGraph

  // Skip terminal nodes (EFFECT_INPUT/OUTPUT) — they stay inside the compound
  const innerNodes = subGraph.nodes.filter(n => n.type !== 'EFFECT_INPUT' && n.type !== 'EFFECT_OUTPUT')

  // Create all inner nodes with new IDs
  for (const node of subGraph.nodes) {
    const newNode = { ...node, id: newNodeId(), params: { ...node.params } }
    idMap[node.id] = newNode.id
    // Don't add terminal nodes to the graph — they stay in sub-graph only
    if (node.type !== 'EFFECT_INPUT' && node.type !== 'EFFECT_OUTPUT') {
      addNode(graphLevel, clipId, {
        type: newNode.type, name: newNode.name,
        position: { x: basePos.x + node.relPos?.x || 0, y: basePos.y + node.relPos?.y || 0 },
        params: newNode.params, shaderCode: newNode.shaderCode || null,
        audioBindings: newNode.audioBindings || {},
      })
    }
  }

  // Create edges between inner nodes
  for (const edge of subGraph.edges) {
    const newFromId = idMap[edge.fromNode]
    const newToId = idMap[edge.toNode]
    if (newFromId && newToId) {
      addEdge(graphLevel, clipId, newFromId, edge.fromSocket, newToId, edge.toSocket)
    }
  }

  // Build the sub-graph for the compound node
  const newSubGraph = {
    nodes: subGraph.nodes.map(n => ({
      ...n, id: idMap[n.id], params: { ...n.params },
    })),
    edges: subGraph.edges.map(e => ({
      ...e, id: `edge_compound_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      fromNode: idMap[e.fromNode], toNode: idMap[e.toNode],
    })),
  }

  // Build exposed params with remapped inner node IDs
  const newExposedParams = (libraryEntry.exposedParams || []).map(ep => ({
    ...ep,
    innerNodeId: idMap[ep.innerNodeId] || ep.innerNodeId,
    paramConfig: { ...ep.paramConfig },
    mappings: ep.mappings.map(m => ({
      ...m, nodeId: idMap[m.nodeId] || m.nodeId,
    })),
  }))

  // Create the compound node
  const compoundId = addNode(graphLevel, clipId, {
    type: 'COMPOUND', name: libraryEntry.name,
    color: libraryEntry.color || '#ff00aa',
    description: libraryEntry.description || '',
    position: basePos,
    params: {},
    subGraph: newSubGraph,
    exposedParams: newExposedParams,
    nodeCount: innerNodes.length,
  })

  return compoundId
}

export default COMPOUND_PRESETS
