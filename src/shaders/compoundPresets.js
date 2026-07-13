/**
 * DaliVid — compoundPresets.js
 * Pre-built compound effect presets and user compound instantiation.
 */

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

  // ── Image Reactors ──────────────────────────────────────────────────────────
  // These start with an IMAGE_INPUT source so "1+ image → reactive visuals" works
  // in a single drag. The image node reacts on its own (always-live bass zoom /
  // beat punch); the downstream effects' `audioWire` bands are auto-connected to
  // the graph's Audio Splitter on drop, so the whole chain pulses to the music.
  // Drop the preset, then click "Load Image" on the Image node.
  {
    id: 'image_reactor', name: 'Image Reactor',
    description: 'Image → feedback trails + chromatic + bloom, pulsing to the beat. Load an image on the Image node.',
    category: 'Image', color: '#ff44aa',
    subGraph: {
      nodes: [
        { type: 'IMAGE_INPUT', name: 'Image', relPos: { x: 0, y: 0 }, params: { u_fit: 0, u_img_scale: 1.0, u_bass_zoom: 0.5, u_beat_punch: 0.4 } },
        { type: 'FEEDBACK', name: 'Feedback Trail', relPos: { x: 220, y: 0 }, params: { u_feedback: 0.82, u_fb_zoom: 1.006, u_fb_rotate: 0.004 }, audioWire: ['mid', 'sub_bass'] },
        { type: 'CHROMATIC_ABERRATION', name: 'RGB Split', relPos: { x: 440, y: 0 }, params: { u_offset: 0.006, u_radial: true }, audioWire: ['treble'] },
        { type: 'BLOOM', name: 'Glow', relPos: { x: 660, y: 0 }, params: { u_threshold: 0.5, u_bloom_intensity: 1.3, u_radius: 8 }, audioWire: ['bass', 'presence'] },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
  {
    id: 'image_kaleido', name: 'Image Kaleido',
    description: 'Image → kaleidoscope mandala + hue spin + bloom, reacting to highs and bass. Load an image on the Image node.',
    category: 'Image', color: '#44ccff',
    subGraph: {
      nodes: [
        { type: 'IMAGE_INPUT', name: 'Image', relPos: { x: 0, y: 0 }, params: { u_fit: 0, u_img_scale: 1.1, u_bass_zoom: 0.3, u_beat_punch: 0.3 } },
        { type: 'KALEIDOSCOPE', name: 'Kaleidoscope', relPos: { x: 220, y: 0 }, params: { u_segments: 8, u_zoom: 1.0 }, audioWire: ['treble', 'bass'] },
        { type: 'COLOR_INVERSION', name: 'Hue Spin', relPos: { x: 440, y: 0 }, params: { u_hue_shift: 0.0, u_saturation: 1.4, u_brightness: 1.1 }, audioWire: ['treble', 'mid', 'bass'] },
        { type: 'BLOOM', name: 'Glow', relPos: { x: 660, y: 0 }, params: { u_threshold: 0.5, u_bloom_intensity: 1.2, u_radius: 6 }, audioWire: ['bass'] },
      ],
      edges: [
        { from: 0, fromSocket: 'output', to: 1, toSocket: 'input' },
        { from: 1, fromSocket: 'output', to: 2, toSocket: 'input' },
        { from: 2, fromSocket: 'output', to: 3, toSocket: 'input' },
      ],
    },
  },
  {
    id: 'image_datamosh', name: 'Image Datamosh',
    description: 'Image → glitch + pixelate + CRT for a broken, beat-punched feed. Load an image on the Image node.',
    category: 'Image', color: '#ff3344',
    subGraph: {
      nodes: [
        { type: 'IMAGE_INPUT', name: 'Image', relPos: { x: 0, y: 0 }, params: { u_fit: 0, u_img_scale: 1.0, u_bass_zoom: 0.2, u_beat_punch: 0.5 } },
        { type: 'GLITCH', name: 'Glitch', relPos: { x: 220, y: 0 }, params: { u_intensity: 0.25, u_block_size: 20, u_speed: 2.0 }, audioWire: ['bass', 'treble'] },
        { type: 'PIXELATE', name: 'Pixelate', relPos: { x: 440, y: 0 }, params: { u_size: 6 }, audioWire: ['treble'] },
        { type: 'CRT', name: 'CRT', relPos: { x: 660, y: 0 }, params: { u_curvature: 0.03, u_scanline_intensity: 0.35, u_vignette: 0.4 }, audioWire: ['bass', 'treble'] },
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
 * @param {string} [splitterId] — id of the active graph's AUDIO_SPLITTER. When
 *   provided, any preset node with an `audioWire` band list has those bands
 *   auto-connected to its Audio Drivers socket, so the chain reacts on drop.
 */
export function instantiatePreset(presetId, addNode, addEdge, graphLevel, clipId, basePos = { x: 200, y: 200 }, splitterId = null) {
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
  // Auto-wire audio drivers from the graph's Audio Splitter (if present), so
  // presets that declare `audioWire` bands are reactive without manual patching.
  if (splitterId) {
    preset.subGraph.nodes.forEach((nodeDef, i) => {
      if (!nodeDef.audioWire) return
      for (const band of nodeDef.audioWire) {
        addEdge(graphLevel, clipId, splitterId, band, nodeIds[i], 'audio_drivers')
      }
    })
  }
  return nodeIds
}

/**
 * Instantiate a user-created compound from the compound library.
 * Creates a COMPOUND node containing a deep copy of the sub-graph.
 */
export function instantiateUserCompound(libraryEntry, addNode, addEdge, graphLevel, clipId, basePos = { x: 200, y: 200 }) {
  if (!libraryEntry?.subGraph) return null

  const subGraph = libraryEntry.subGraph

  // Fresh ids for every sub-graph node so multiple instances of the same
  // library entry never share inner ids (FBO keys are scoped by the compound
  // node id, but exposed-param mappings and edges must stay self-consistent).
  const idMap = {} // old ID → new ID
  let seq = 0
  const stamp = Date.now()
  for (const node of subGraph.nodes) {
    idMap[node.id] = `node_${stamp}_uc${++seq}`
  }

  // Deep-copy the sub-graph with remapped ids. The interior lives entirely
  // inside the compound node — nothing is added to the parent graph directly.
  const newSubGraph = {
    nodes: subGraph.nodes.map(n => ({
      ...n, id: idMap[n.id], params: { ...n.params },
    })),
    edges: subGraph.edges.map(e => ({
      ...e, id: `edge_compound_${stamp}_${Math.random().toString(36).substr(2, 4)}`,
      fromNode: idMap[e.fromNode], toNode: idMap[e.toNode],
    })),
  }

  // Remap exposed-param targets to the copied inner nodes.
  const newExposedParams = (libraryEntry.exposedParams || []).map(ep => ({
    ...ep,
    innerNodeId: idMap[ep.innerNodeId] || ep.innerNodeId,
    paramConfig: { ...ep.paramConfig },
    mappings: (ep.mappings || []).map(m => ({
      ...m, nodeId: idMap[m.nodeId] || m.nodeId,
    })),
  }))

  const innerCount = subGraph.nodes.filter(
    n => n.type !== 'EFFECT_INPUT' && n.type !== 'EFFECT_OUTPUT'
  ).length

  // One COMPOUND node carries the whole copied interior.
  const compoundId = addNode(graphLevel, clipId, {
    type: 'COMPOUND', name: libraryEntry.name,
    color: libraryEntry.color || '#ff00aa',
    description: libraryEntry.description || '',
    position: basePos,
    params: {},
    subGraph: newSubGraph,
    exposedParams: newExposedParams,
    nodeCount: innerCount,
  })

  return compoundId
}

/**
 * Starter NODE-GRAPH TRANSITION — a compound library entry seeded into new
 * projects (see useGraphStore / deserializeProject). Any library compound with
 * ≥ 2 image inputs qualifies as a clip transition (isTransitionCompound) and
 * appears in the clip Inspector's Transition-In list as "compound:<id>".
 *
 * This one is deliberately minimal — FROM/TO mixed by a TRANSITION_PROGRESS
 * node — so it doubles as the reference pattern: drop it into any graph from
 * the search menu ("My Compounds"), expand it, remix the inside, and re-save a
 * selection as a new compound to grow a personal transition library.
 */
export const STARTER_TRANSITION_COMPOUND = {
  id: 'lib_transition_node_crossfade',
  name: 'Node Crossfade (Starter)',
  version: 1,
  isUserCreated: false,
  color: '#00e5ff',
  description: 'Transition built from nodes: FROM/TO inputs mixed by Transition Progress. Expand & remix it — any compound with two image inputs works as a clip transition.',
  createdAt: '2026-07-02T00:00:00.000Z',
  nodeCount: 2,
  exposedParams: [
    {
      displayName: 'Mix → Operation',
      innerNodeId: 'tstart_mix',
      uniformName: 'u_operation',
      paramConfig: {
        name: 'Operation', uniformName: 'u_operation', uniformType: 'int',
        type: 'select', options: ['Mix', 'Add', 'Multiply', 'Screen', 'Difference', 'Overlay'],
        min: 0, max: 5, step: 1, default: 0,
      },
      value: 0,
      mappings: [{ nodeId: 'tstart_mix', uniformName: 'u_operation', scaleFactor: 1.0, offset: 0.0 }],
    },
  ],
  subGraph: {
    nodes: [
      { id: 'tstart_in_from', type: 'EFFECT_INPUT', name: 'FROM (outgoing)', position: { x: -220, y: 140 }, locked: true, params: {}, audioBand: null },
      { id: 'tstart_in_to', type: 'EFFECT_INPUT', name: 'TO (incoming)', position: { x: -220, y: 260 }, locked: true, params: {}, audioBand: null },
      { id: 'tstart_progress', type: 'TRANSITION_PROGRESS', name: 'Transition Progress', position: { x: -220, y: 380 }, params: { auto_preview: true, preview: 0.5, preview_speed: 0.25 } },
      { id: 'tstart_mix', type: 'MIX_BLEND', name: 'Mix / Blend', position: { x: 120, y: 200 }, params: { u_mix: 0.5, u_operation: 0 } },
      { id: 'tstart_out', type: 'EFFECT_OUTPUT', name: 'OUTPUT', position: { x: 460, y: 200 }, locked: true, params: {} },
    ],
    edges: [
      { id: 'tstart_e1', fromNode: 'tstart_in_from', fromSocket: 'output', toNode: 'tstart_mix', toSocket: 'input' },
      { id: 'tstart_e2', fromNode: 'tstart_in_to', fromSocket: 'output', toNode: 'tstart_mix', toSocket: 'input_b' },
      { id: 'tstart_e3', fromNode: 'tstart_progress', fromSocket: 'progress', toNode: 'tstart_mix', toSocket: 'u_mix' },
      { id: 'tstart_e4', fromNode: 'tstart_mix', fromSocket: 'output', toNode: 'tstart_out', toSocket: 'input' },
    ],
  },
}

export default COMPOUND_PRESETS
