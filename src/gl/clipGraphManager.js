/**
 * DaliVid — clipGraphManager.js
 * Bridges the graph store and the WebGL renderer.
 * Compiles node chains from topologically sorted graphs,
 * creates shader programs, and executes per-frame through FBOs.
 */

import { createShaderProgram } from './ShaderProgram.js'
import { getNodeSource } from '../shaders/shaderRegistry.js'
import { getExecutionOrder } from '../utils/topSort.js'
import { hexToVec3 } from '../utils/paramParser.js'
import { AUDIO_DRIVER_BANDS, injectAudioDrivers } from '../utils/audioDrivers.js'

// When true, the graph is evaluated as a true DAG (inputs resolved per-edge,
// multi-input effects supported). Set to false to fall back to the legacy
// linear executor if a regression is suspected.
const USE_DAG = true

// Texture input socket id → the sampler uniform it feeds. Covers every texture
// input socket in the node set; custom nodes only use the primary 'input'.
const TEXTURE_INPUT_SOCKETS = {
  input: 'u_texture',
  input_b: 'u_texture_b',
  disp_map: 'u_disp_map',
}

// The audio "driver" uniforms. These are auto-declared into every effect shader
// (so they can be used without a uniform line) and gated by the node's
// "Audio Drivers" socket: each is 0.0 unless the matching Audio Splitter band is
// wired in. Band ids match the splitter's output socket ids. (u_beat is handled
// separately as an always-live standard uniform.)
const AUDIO_DRIVERS_SOCKET = 'audio_drivers'

/**
 * Live values for each audio driver band, read from the audio store.
 */
function audioDriverValues(renderer) {
  const a = (renderer._getAudioStore && renderer._getAudioStore()) || {}
  const b = a.smoothedBands || []
  return {
    sub_bass: b[0] || 0,
    bass: a.bass || 0,
    low_mid: b[2] || 0,
    mid: a.mid || 0,
    high_mid: b[4] || 0,
    presence: b[5] || 0,
    treble: a.treble || 0,
    rms: a.rms || 0,
  }
}

/**
 * Apply gated audio drivers to a node's param set: every band defaults to 0.0,
 * and any band wired into the node's Audio Drivers socket gets its live value.
 * Unused uniforms are skipped at upload time, so this is safe for all nodes.
 *
 * Two wiring shapes are supported, so the same resolver works at the top level
 * and inside a compound:
 *   • Direct from an AUDIO_SPLITTER — the edge's fromSocket IS the band name.
 *   • From a compound EFFECT_INPUT terminal — the terminal node carries an
 *     `audioBand` tag; `nodeLookup` (id → node) is used to read it.
 */
function applyAudioDrivers(customParams, nodeId, edges, driverValsFor, nodeLookup = null) {
  for (const band of AUDIO_DRIVER_BANDS) customParams['u_' + band] = 0
  if (!edges || !driverValsFor) return
  for (const e of edges) {
    if (e.toNode !== nodeId || e.toSocket !== AUDIO_DRIVERS_SOCKET) continue
    // Per-edge value set: resolved from the producing splitter, so a splitter
    // fed by a stem AUDIO_INPUT drives with that stem's bands (see
    // executeGraphDAG's driverValsFor); a flat map still works via wrapping.
    const driverVals = typeof driverValsFor === 'function' ? driverValsFor(e.fromNode) : driverValsFor
    const band = (driverVals[e.fromSocket] !== undefined)
      ? e.fromSocket
      : nodeLookup?.[e.fromNode]?.audioBand
    if (band && driverVals[band] !== undefined) customParams['u_' + band] = driverVals[band]
  }
}

/**
 * Resolve an AUDIO_INPUT node's `audioSource` param to a stem filename, or
 * null for the timeline mix. Select controls store the OPTION INDEX (0 =
 * 'Timeline', 1+ = nth audio file in the same ordered list the dropdown
 * builds — unique audio-clip filenames in timeline order), but older values
 * may be the string itself; both shapes are accepted.
 */
export function resolveAudioSourceName(value, renderer) {
  if (value == null || value === 0 || value === 'Timeline') return null
  if (typeof value === 'string') return value
  const clips = renderer._getTimelineStore?.()?.clips || []
  const names = [...new Set(clips.filter(c => c.fileType === 'audio').map(c => c.filename))]
  return names[value - 1] ?? null
}

/**
 * Whether a per-stem analysis entry (audioStore.sources[name]) is carrying LIVE
 * signal this frame. A stem's analyser only sees audio while its clip is playing
 * under the playhead; once the clip stops (or the playhead parks off it) the
 * entry PERSISTS but decays to zeros. Callers use this to fall back to the
 * master (timeline) mix instead of driving visuals with an all-zero stem — the
 * dead-air symptom of selecting a not-currently-playing song as an audio source.
 */
export function stemHasSignal(s) {
  if (!s) return false
  const b = s.smoothedBands
  if (b) { for (let i = 0; i < b.length; i++) if (b[i] > 0.001) return true }
  return (s.rms || 0) > 0.001 || (s.beat || 0) > 0.001
}

/**
 * The value a TRANSITION_PROGRESS node yields this frame.
 * A live transition (renderer sets standardState.transitionProgress during the
 * overlap composite) always wins. Otherwise the node's Preview params apply:
 * auto_preview loops a triangle wave (0→1→0) at preview_speed cycles/sec so the
 * transition can be watched in the editor; unchecked, the static Preview slider
 * value is used. `src` may be a compiled chain entry or a raw graph node.
 */
function resolveTransitionProgress(src, standardState, liveNodes = null, nodeLookup = null) {
  if (standardState && standardState.transitionProgress != null) {
    return Math.max(0, Math.min(1, standardState.transitionProgress))
  }
  const id = src.nodeId ?? src.id
  const p = liveNodes?.[id]?.params ?? nodeLookup?.[id]?.params ?? src.params ?? {}
  if (p.auto_preview ?? true) {
    const speed = p.preview_speed ?? 0.25
    const t = (standardState?.time || 0) * speed
    return 1.0 - Math.abs(2.0 * (t - Math.floor(t)) - 1.0) // triangle 0→1→0
  }
  return Math.max(0, Math.min(1, p.preview ?? 0.5))
}

/**
 * Normalize node params into GPU-ready values.
 * Hex color strings ("#rrggbb") are converted to a normalized vec3 so they
 * don't reach gl.uniform3f as a string (which produces NaN).
 */
export function normalizeParams(params) {
  const out = {}
  if (!params) return out
  for (const key in params) {
    const value = params[key]
    out[key] = (typeof value === 'string' && value.charAt(0) === '#') ? hexToVec3(value) : value
  }
  return out
}

/**
 * Compile a graph into an executable chain of { nodeId, program, uniformLocations, params, type }.
 * @param {WebGL2RenderingContext} gl
 * @param {object} graph — { nodes, edges }
 * @returns {{ chain: Array, errors: Array }}
 */
export function compileGraph(gl, graph) {
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return { chain: [], errors: [] }
  }

  const { nodes, edges } = graph

  const outputNode = nodes.find(n =>
    n.type === 'OUTPUT' || n.type === 'CLIP_OUTPUT' || n.type === 'EFFECT_OUTPUT'
  )
  if (!outputNode) {
    return { chain: [], errors: [{ message: 'No OUTPUT node found in graph' }] }
  }

  const { order, hasCycle, cycleNodes } = getExecutionOrder(nodes, edges, outputNode.id)

  if (hasCycle) {
    return { chain: [], errors: [{ message: `Cycle detected involving nodes: ${[...cycleNodes].join(', ')}` }] }
  }

  const chain = []
  const errors = []

  for (const nodeId of order) {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) continue

    // Source/input nodes — no shader here, just mark as passthrough. IMAGE_INPUT
    // and TEXT_INPUT are sources too, but unlike the others they produce their OWN
    // texture (drawn into a per-node FBO by the renderer's image/text pass), not
    // the chain input.
    if (['CLIP_SOURCE', 'VIDEO_INPUT', 'CAMERA_INPUT', 'SCREEN_INPUT', 'EFFECT_INPUT', 'IMAGE_INPUT', 'TEXT_INPUT'].includes(node.type)) {
      chain.push({ nodeId: node.id, type: node.type, program: null, uniformLocations: {}, params: node.params || {}, bypassed: node.bypassed || false, name: node.name, isSource: true, isImage: node.type === 'IMAGE_INPUT', isText: node.type === 'TEXT_INPUT' })
      continue
    }

    // Audio / data nodes — no shader, data-routing only (TRANSITION_PROGRESS is
    // a CPU float source consumed by the executor's progress injection;
    // ENVELOPE is evaluated CPU-side in resolveFloatConnections).
    if (['AUDIO_INPUT', 'AUDIO_SPLITTER', 'MATH', 'TRANSITION_PROGRESS', 'ENVELOPE'].includes(node.type)) {
      chain.push({ nodeId: node.id, type: node.type, program: null, uniformLocations: {}, params: node.params || {}, bypassed: node.bypassed || false, name: node.name, isAudio: true })
      continue
    }

    // Output nodes — passthrough
    if (node.type === 'OUTPUT' || node.type === 'CLIP_OUTPUT' || node.type === 'EFFECT_OUTPUT') {
      chain.push({ nodeId: node.id, type: node.type, program: null, uniformLocations: {}, params: {}, bypassed: false, name: node.name, isOutput: true })
      continue
    }

    // Compound nodes — compile sub-graph recursively
    if (node.type === 'COMPOUND' && node.subGraph) {
      const subResult = compileGraph(gl, node.subGraph)
      chain.push({
        nodeId: node.id, type: 'COMPOUND', compoundNode: node, subChain: subResult.chain,
        program: null, uniformLocations: {}, params: {}, bypassed: node.bypassed || false,
        name: node.name, isCompound: true, subErrors: subResult.errors,
      })
      if (subResult.errors.length > 0) {
        errors.push({ nodeId: node.id, nodeName: node.name, errors: subResult.errors })
      }
      continue
    }

    // Get shader source — custom code or from registry (single source of truth),
    // then auto-declare the audio driver uniforms so they can be used in code.
    const shaderSrc = injectAudioDrivers(getNodeSource(node))
    if (!shaderSrc) {
      chain.push({ nodeId: node.id, type: node.type, program: null, uniformLocations: {}, params: node.params || {}, bypassed: true, name: node.name, error: `No shader source for type: ${node.type}` })
      continue
    }

    const result = createShaderProgram(gl, shaderSrc)
    if (!result.program) {
      console.error(`[DaliVid] Shader compile FAILED for node "${node.name}" (type: ${node.type}):`)
      for (const err of result.errors) { console.error(`  GLSL ${err.line}:${err.column}: ${err.message}`) }
      errors.push({ nodeId: node.id, nodeName: node.name, errors: result.errors })
      chain.push({ nodeId: node.id, type: node.type, program: null, uniformLocations: {}, params: node.params || {}, bypassed: true, name: node.name, compileError: true })
      continue
    }

    chain.push({
      nodeId: node.id, type: node.type, program: result.program,
      uniformLocations: result.uniformLocations, uniformTypes: result.uniformTypes,
      params: node.params || {}, bypassed: node.bypassed || false, name: node.name,
    })
  }

  // edges are returned so the DAG executor can resolve per-socket inputs.
  return { chain, errors, edges }
}

/**
 * Build a { nodeId → node } lookup for a graph, used to read LIVE param values
 * at execute time so slider changes take effect without recompiling the chain.
 */
export function buildNodeMap(graph) {
  const map = {}
  if (graph && graph.nodes) {
    for (const n of graph.nodes) map[n.id] = n
  }
  return map
}

/**
 * Blit/draw an FBO to a destination FBO (or the screen when dstId is null).
 */
function blitOrScreen(renderer, srcId, dstId) {
  if (!srcId) return
  const { gl, fbos } = renderer
  if (dstId !== null) {
    fbos.blit(srcId, dstId, renderer.width, renderer.height)
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, renderer.width, renderer.height)
    gl.useProgram(renderer.passthroughProgram.program)
    fbos.bindTexture(srcId, 0)
    const loc = renderer.passthroughProgram.uniformLocations.u_texture
    if (loc != null) gl.uniform1i(loc, 0)
    renderer.drawQuad()
  }
}

/**
 * Execute a compiled chain through FBOs. Dispatches to the DAG evaluator (which
 * resolves each node's inputs from the actual graph edges and supports
 * multi-input effects) or the legacy linear executor.
 * @param {object|null} liveNodes — optional { nodeId → node } map. When provided,
 *   each node's current params are read from it instead of the compile-time
 *   snapshot baked into the chain.
 * @param {Array|null} edges — graph edges; required for DAG evaluation.
 */
export function executeChain(renderer, chain, inputFBOId, outputFBOId, standardState, audioBindings = {}, liveNodes = null, edges = null, tapPointNodeId = null) {
  if (USE_DAG && edges) {
    return executeGraphDAG(renderer, chain, edges, inputFBOId, outputFBOId, standardState, audioBindings, liveNodes, tapPointNodeId)
  }
  return executeChainLinear(renderer, chain, inputFBOId, outputFBOId, standardState, audioBindings, liveNodes, edges)
}

/**
 * Execute a compound library entry's sub-graph as a CLIP TRANSITION.
 * The sub-graph's first two non-audio EFFECT_INPUT terminals are bound to the
 * outgoing (from) and incoming (to) frames, and standardState carries
 * transitionProgress so any TRANSITION_PROGRESS node inside yields the live
 * 0 → 1 overlap progress. Runs through the same DAG evaluator as everything
 * else, so inner compounds, image sources and multi-input effects all work.
 *
 * @param {object} renderer
 * @param {Array}  subChain  — compileGraph(entry.subGraph).chain
 * @param {object} subGraph  — the library entry's subGraph ({ nodes, edges })
 * @param {string} fromFBOId — outgoing side (accumulator incl. previous clip)
 * @param {string} toFBOId   — incoming clip's finished frame
 * @param {object} standardState
 * @param {number} progress  — 0..1 across the overlap window
 * @param {string} scopeId   — FBO namespace (per clip, e.g. `tr~<clipId>~`)
 * @param {object|null} liveNodes — optional { nodeId → { params } } overrides
 *   (used to apply the clip's exposed-param values without mutating the entry)
 * @returns {string|null} the FBO holding the transition result (by reference),
 *   or null when the graph is empty / has no resolvable output.
 */
export function executeTransitionCompound(renderer, subChain, subGraph, fromFBOId, toFBOId, standardState, progress, scopeId, liveNodes = null) {
  if (!subChain || subChain.length === 0 || !subGraph) return null

  // Bind FROM → 1st image terminal, TO → 2nd (same input_<i> ordering the
  // compound's sockets use). Audio-band terminals keep their tagged routing.
  const inTerms = (subGraph.nodes || []).filter(t => t.type === 'EFFECT_INPUT' && !t.audioBand)
  const terminalMap = {}
  if (inTerms[0]) terminalMap[inTerms[0].id] = fromFBOId
  if (inTerms[1]) terminalMap[inTerms[1].id] = toFBOId

  const state = { ...standardState, transitionProgress: Math.max(0, Math.min(1, progress)) }
  const outResolved = {}
  executeGraphDAG(
    renderer, subChain, subGraph.edges || [], fromFBOId, null,
    state, {}, liveNodes, null, scopeId, buildNodeMap(subGraph), terminalMap, outResolved
  )

  const outTerm = (subGraph.nodes || []).find(t => t.type === 'EFFECT_OUTPUT')
  return (outTerm && outResolved[outTerm.id]) || null
}

/**
 * DAG evaluator: each effect/compound node writes to its own output FBO and
 * reads its inputs from the FBOs produced by the nodes wired to its input
 * sockets. Supports branching and multi-input effects (e.g. Displacement,
 * blend). Nodes are walked in topological order (compileGraph already sorts
 * them), so a producer's output FBO is always ready before its consumer runs.
 */
function executeGraphDAG(renderer, chain, edges, inputFBOId, outputFBOId, standardState, audioBindings, liveNodes, tapPointNodeId = null, scopeId = '', nodeLookup = null, terminalInputs = null, outputResolved = null) {
  const { fbos } = renderer

  if (!chain || chain.length === 0) {
    // Compound context (outputResolved) routes outputs by reference; an empty
    // sub-chain contributes nothing, so the parent falls back to its primary input.
    if (!outputResolved) blitOrScreen(renderer, inputFBOId, outputFBOId)
    return
  }

  const byId = {}
  for (const n of chain) byId[n.nodeId] = n

  // Only texture-carrying edges matter for routing pixels.
  const texEdges = (edges || []).filter(e => e.toSocket in TEXTURE_INPUT_SOCKETS)

  // Float wiring (splitter bands / MATH / ENVELOPE → param sockets) is
  // resolved against THIS graph's nodes and edges — live params preferred —
  // so it works while executing any graph, at any compound depth.
  const floatNodes = chain.map(n => ({
    id: n.nodeId,
    type: n.type,
    params: liveNodes?.[n.nodeId]?.params ?? nodeLookup?.[n.nodeId]?.params ?? n.params,
  }))
  const floatOverrides = resolveFloatConnections(renderer, floatNodes, edges || [])

  // Audio driver values per producing splitter: master mix by default, or a
  // stem's analysis when the splitter's upstream AUDIO_INPUT names a file.
  const masterDriverVals = audioDriverValues(renderer)
  const audioStoreState = renderer._getAudioStore?.()
  const driverValsCache = new Map()
  const driverVals = (fromNodeId) => {
    if (driverValsCache.has(fromNodeId)) return driverValsCache.get(fromNodeId)
    let vals = masterDriverVals
    const src = byId[fromNodeId] ?? nodeLookup?.[fromNodeId]
    if (src && src.type === 'AUDIO_SPLITTER') {
      const inEdge = (edges || []).find(e => e.toNode === fromNodeId && e.toSocket === 'audio_in')
      const feeder = inEdge && (nodeLookup?.[inEdge.fromNode] ?? byId[inEdge.fromNode])
      const name = feeder?.type === 'AUDIO_INPUT' ? resolveAudioSourceName(feeder.params?.audioSource, renderer) : null
      const s = name ? audioStoreState?.sources?.[name] : null
      // Use the stem's own bands only while it's actually playing; otherwise keep
      // the master mix so a selected-but-idle song doesn't zero out the drivers.
      if (s && stemHasSignal(s)) {
        const b = s.smoothedBands || []
        vals = {
          sub_bass: b[0] || 0, bass: s.bass || 0, low_mid: b[2] || 0, mid: s.mid || 0,
          high_mid: b[4] || 0, presence: b[5] || 0, treble: s.treble || 0, rms: s.rms || 0,
        }
      }
    }
    driverValsCache.set(fromNodeId, vals)
    return vals
  }
  const nodeOutput = {} // nodeId → FBO id holding its (default) output this frame
  // nodeId → { outputSocketId → FBO id } for multi-output producers (compounds).
  const nodeOutputBySocket = {}

  const ensureFBO = (id) => {
    if (!fbos.has(id)) fbos.create(id, renderer.width, renderer.height)
    else fbos.resize(id, renderer.width, renderer.height)
    return id
  }

  // Node-keyed FBOs are namespaced by scopeId so a compound's inner nodes — and
  // duplicate instances of the same compound — never collide with each other or
  // with the top-level graph. scopeId is '' at the top level, so keys (and the
  // cleanup in releaseClipResources) are unchanged there.
  const nFBO = (nodeId) => `__n_${scopeId}${nodeId}`
  // The FBO an IMAGE_INPUT source draws into (its own image, not the chain input).
  const imageFBO = (nodeId) => `__img_${scopeId}${nodeId}`
  // The FBO a TEXT_INPUT source draws into (its own rasterized text).
  const textFBO = (nodeId) => `__txt_${scopeId}${nodeId}`

  // ── Image source pre-pass ──
  // IMAGE_INPUT nodes are skipped in the main loop (they're sources), so render
  // each one's image into its dedicated FBO up front. resolveProducer then hands
  // that FBO to whatever consumes the node, exactly like the composited video
  // feeds an ordinary source.
  for (const n of chain) {
    if (!n.isImage) continue
    const fboId = ensureFBO(imageFBO(n.nodeId))
    const liveParams = liveNodes?.[n.nodeId]?.params ?? n.params
    const cp = normalizeParams(liveParams)
    const ov = floatOverrides[n.nodeId]
    if (ov) Object.assign(cp, ov)
    renderer.renderImageNode(n.nodeId, fboId, standardState, cp)
  }

  // ── Text source pre-pass ── (mirror of the image pre-pass)
  // NOTE: text params are NOT run through normalizeParams — its canvas fields
  // (color / bgColor / …) are hex strings the rasterizer needs verbatim, and the
  // TEXT shader has no color uniform. Float overrides (scale/offset/…) still apply.
  for (const n of chain) {
    if (!n.isText) continue
    const fboId = ensureFBO(textFBO(n.nodeId))
    const liveParams = liveNodes?.[n.nodeId]?.params ?? n.params
    const cp = { ...(liveParams || {}) }
    const ov = floatOverrides[n.nodeId]
    if (ov) Object.assign(cp, ov)
    renderer.renderTextNode(n.nodeId, fboId, standardState, cp)
  }

  // The FBO produced by a node, following bypass/compile-error passthrough.
  // fromSocket identifies WHICH output is wanted — relevant for multi-output
  // producers (compounds expose output_<i>); regular nodes have a single output.
  const resolveProducer = (nodeId, guard, fromSocket = null) => {
    if (guard.has(nodeId)) return inputFBOId
    guard.add(nodeId)
    const src = byId[nodeId]
    if (src && src.isImage) return imageFBO(nodeId)
    if (src && src.isText) return textFBO(nodeId)
    if (!src || src.isSource) {
      // Inside a compound, an EFFECT_INPUT terminal maps to the FBO wired to the
      // matching outer input socket (terminalInputs). Otherwise a source resolves
      // to the chain input (the compound's primary input, or the composited video).
      if (terminalInputs && terminalInputs[nodeId] != null) return terminalInputs[nodeId]
      return inputFBOId
    }
    if (src.bypassed || src.compileError) {
      return resolveSocket(nodeId, 'input', guard) ?? inputFBOId
    }
    // Multi-output producer: route the specific output socket to its own FBO.
    // (Unknown/legacy fromSocket falls back to the default output below.)
    const bySocket = nodeOutputBySocket[nodeId]
    if (fromSocket && bySocket && bySocket[fromSocket] != null) return bySocket[fromSocket]
    return nodeOutput[nodeId] ?? inputFBOId
  }

  // The FBO feeding a (nodeId, socket), or null if nothing is wired to it.
  const resolveSocket = (nodeId, socket, guard = new Set()) => {
    const edge = texEdges.find(e => e.toNode === nodeId && e.toSocket === socket)
    if (!edge) return null
    return resolveProducer(edge.fromNode, guard, edge.fromSocket)
  }

  let lastProducedFBO = null

  for (let i = 0; i < chain.length; i++) {
    const node = chain[i]
    if (node.isSource || node.isOutput || node.isAudio) continue
    if (node.bypassed || node.compileError) continue
    if (!node.program && !node.isCompound) continue

    // Primary texture input: wired source, or the chain input (composited video)
    // when nothing is connected to the node's 'input' socket.
    const primaryInput = resolveSocket(node.nodeId, 'input') ?? inputFBOId

    if (node.isCompound) {
      const sub = node.compoundNode?.subGraph
      // Map each external input (input_<i>) to its producer FBO, keyed by the
      // inner EFFECT_INPUT terminal it feeds. This makes a mid-chain compound read
      // its upstream producer (not the global chain input) and routes true
      // multi-input compounds. The i-th EFFECT_INPUT terminal (in sub-graph order)
      // corresponds to socket input_<i>, matching createCompound/expandCompound.
      // Audio-band terminals are driven via applyAudioDrivers, so they're skipped.
      const terminalMap = {}
      const inTerms = (sub?.nodes || []).filter(t => t.type === 'EFFECT_INPUT')
      for (let k = 0; k < inTerms.length; k++) {
        if (inTerms[k].audioBand) continue
        const inEdge = (edges || []).find(e => e.toNode === node.nodeId && e.toSocket === `input_${k}`)
        if (inEdge) terminalMap[inTerms[k].id] = resolveProducer(inEdge.fromNode, new Set(), inEdge.fromSocket)
      }
      // Evaluate the compound's sub-graph with the SAME DAG evaluator, so inner
      // image sources, multi-input effects and branching all "just work". Inner
      // FBOs are namespaced under this compound's id (plus any enclosing scope).
      // Terminals not in terminalMap fall back to primaryInput; buildNodeMap(sub)
      // lets each terminal resolve its tagged audio band. outResolved is filled
      // with the FBO feeding each EFFECT_OUTPUT terminal (by reference — no blit).
      const outResolved = {}
      executeGraphDAG(
        renderer, node.subChain, sub?.edges || [], primaryInput, null,
        standardState, {}, null, null, `${scopeId}${node.nodeId}~`, buildNodeMap(sub), terminalMap, outResolved
      )
      // Route each output socket (output_<i>) to the inner FBO feeding the matching
      // EFFECT_OUTPUT terminal, so downstream consumers of a multi-output compound
      // each read the correct output (resolved by the consuming edge's fromSocket).
      const outTerms = (sub?.nodes || []).filter(t => t.type === 'EFFECT_OUTPUT')
      const socketFBO = {}
      for (let k = 0; k < outTerms.length; k++) {
        const fbo = outResolved[outTerms[k].id]
        if (fbo) socketFBO[`output_${k}`] = fbo
      }
      const defaultFBO = socketFBO['output_0'] ?? Object.values(socketFBO)[0] ?? primaryInput
      nodeOutput[node.nodeId] = defaultFBO
      nodeOutputBySocket[node.nodeId] = socketFBO
      lastProducedFBO = defaultFBO
      continue
    }

    // Build the parameter set (live params + audio bindings + float modulation).
    const liveParams = liveNodes?.[node.nodeId]?.params ?? node.params
    const customParams = normalizeParams(liveParams)
    for (const [key, value] of Object.entries(audioBindings)) {
      if (key.startsWith(node.nodeId + '.')) {
        customParams[key.substring(node.nodeId.length + 1)] = value
      }
    }
    const nodeOverrides = floatOverrides[node.nodeId]
    if (nodeOverrides) Object.assign(customParams, nodeOverrides)

    // Transition progress: any param socket wired from a TRANSITION_PROGRESS
    // node is driven by the live progress value. During a clip transition the
    // renderer sets standardState.transitionProgress (0 → 1 over the overlap);
    // otherwise the progress node's own Preview params drive it, so a
    // transition compound can be authored and watched right in the editor.
    // Resolved per recursion level (each level has its own chain/edges), so it
    // works at the top level and at any compound depth — unlike
    // resolveFloatConnections, which only sees the top-level graph.
    if (edges) {
      for (const e of edges) {
        if (e.toNode !== node.nodeId) continue
        const src = byId[e.fromNode] ?? nodeLookup?.[e.fromNode]
        if (!src || src.type !== 'TRANSITION_PROGRESS') continue
        customParams[e.toSocket] = resolveTransitionProgress(src, standardState, liveNodes, nodeLookup)
      }
    }

    // Gated audio drivers: 0 unless wired into this node's Audio Drivers socket.
    // nodeLookup lets a compound's EFFECT_INPUT terminal resolve its tagged band.
    applyAudioDrivers(customParams, node.nodeId, edges, driverVals, nodeLookup)

    // Secondary texture inputs (input_b, disp_map). Fall back to the primary
    // input when nothing is wired, so a lone multi-input node stays well-defined.
    const extraTextures = []
    let unit = 2
    for (const socket in TEXTURE_INPUT_SOCKETS) {
      if (socket === 'input') continue
      const uniform = TEXTURE_INPUT_SOCKETS[socket]
      if (node.uniformLocations[uniform] == null) continue
      const srcFBO = resolveSocket(node.nodeId, socket) ?? primaryInput
      extraTextures.push({ uniform, fboId: srcFBO, unit: unit++ })
    }

    // Feedback nodes (u_prev_frame) need their own previous output preserved.
    const isFeedback = node.uniformLocations.u_prev_frame !== undefined
    let outId
    if (isFeedback) {
      const ppId = `__npp_${scopeId}${node.nodeId}`
      let pp = fbos.getPingPong(ppId)
      if (!pp) pp = fbos.createPingPong(ppId, renderer.width, renderer.height)
      else fbos.resizePingPong(ppId, renderer.width, renderer.height)
      const prevFrameFBOId = `${ppId}_${pp.current}`
      outId = `${ppId}_${1 - pp.current}`
      renderer.executePass(node, primaryInput, outId, standardState, customParams, prevFrameFBOId, extraTextures)
      pp.swap() // current now points at the buffer we just wrote
    } else {
      outId = ensureFBO(nFBO(node.nodeId))
      renderer.executePass(node, primaryInput, outId, standardState, customParams, null, extraTextures)
    }

    nodeOutput[node.nodeId] = outId
    lastProducedFBO = outId
  }

  // Final image. A preview "tap point" (set via a node's Preview button) wins when
  // it points at a real, non-output node: we show that node's own output so you can
  // solo any stage of the graph. resolveProducer follows bypass/compile-error/source
  // passthrough, so the tap is well-defined even on a skipped node. With no tap (or
  // the tap pointing at OUTPUT) we fall back to whatever feeds the OUTPUT node, then
  // the last produced node, then the raw input.
  // Compound context: record the FBO feeding EACH EFFECT_OUTPUT terminal so the
  // parent can route every output socket independently (by reference — no blit).
  if (outputResolved) {
    for (const n of chain) {
      if (!n.isOutput) continue
      outputResolved[n.nodeId] = resolveSocket(n.nodeId, 'input') ?? lastProducedFBO ?? inputFBOId
    }
    return
  }

  const outputNode = chain.find(n => n.isOutput)
  let finalFBO = null
  if (tapPointNodeId && tapPointNodeId !== outputNode?.nodeId && byId[tapPointNodeId]) {
    finalFBO = resolveProducer(tapPointNodeId, new Set())
  }
  if (!finalFBO) finalFBO = outputNode ? resolveSocket(outputNode.nodeId, 'input') : null
  if (!finalFBO) finalFBO = lastProducedFBO ?? inputFBOId

  blitOrScreen(renderer, finalFBO, outputFBOId)
}

/**
 * Legacy linear executor — walks the chain in topological order and pipes each
 * node's output into the next. Kept as a fallback (see USE_DAG). Does not
 * respect per-socket wiring or multi-input effects.
 */
function executeChainLinear(renderer, chain, inputFBOId, outputFBOId, standardState, audioBindings = {}, liveNodes = null, edges = null) {
  const gl = renderer.gl
  const fbos = renderer.fbos

  if (!chain || chain.length === 0) return
  const driverVals = audioDriverValues(renderer)

  // Separate compound nodes from regular effect nodes
  const regularNodes = chain.filter(n =>
    n.program && !n.bypassed && !n.compileError && !n.isSource && !n.isOutput
  )
  const compoundNodes = chain.filter(n =>
    n.isCompound && !n.bypassed && n.subChain
  )

  if (regularNodes.length === 0 && compoundNodes.length === 0) {
    if (inputFBOId) {
      if (outputFBOId !== null) {
        fbos.blit(inputFBOId, outputFBOId, renderer.width, renderer.height)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, renderer.width, renderer.height)
        gl.useProgram(renderer.passthroughProgram.program)
        fbos.bindTexture(inputFBOId, 0)
        const loc = renderer.passthroughProgram.uniformLocations.u_texture
        if (loc != null) gl.uniform1i(loc, 0)
        renderer.drawQuad()
      }
    }
    return
  }

  const floatOverrides = resolveFloatConnections(renderer)

  const ppId = '__chain_pp'
  let pp = fbos.getPingPong(ppId)
  if (!pp) {
    pp = fbos.createPingPong(ppId, renderer.width, renderer.height)
  } else {
    fbos.resizePingPong(ppId, renderer.width, renderer.height)
  }

  let currentInputId = inputFBOId
  let effectIndex = 0
  const totalEffects = regularNodes.length + compoundNodes.length

  // Process nodes in chain order — walk the chain and execute each effect or compound
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i]
    if (node.isSource || node.isOutput || node.isAudio || !node.program && !node.isCompound) continue
    if (node.bypassed || node.compileError) continue

    const isLast = (effectIndex === totalEffects - 1)
    let targetFBOId
    if (isLast && outputFBOId === null) {
      targetFBOId = `${ppId}_${pp.current}`
    } else if (isLast) {
      targetFBOId = outputFBOId
    } else {
      targetFBOId = `${ppId}_${pp.current}`
    }

    if (node.isCompound) {
      // Evaluate the compound's sub-graph with the DAG evaluator (same as the
      // primary path), so inner image sources and multi-input effects work.
      const sub = node.compoundNode?.subGraph
      executeGraphDAG(renderer, node.subChain, sub?.edges || [], currentInputId, targetFBOId, standardState, {}, null, null, `${node.nodeId}~`, buildNodeMap(sub))
    } else {
      // Regular effect node — prefer live params over the compile-time snapshot
      const liveParams = liveNodes?.[node.nodeId]?.params ?? node.params
      const customParams = normalizeParams(liveParams)
      for (const [key, value] of Object.entries(audioBindings)) {
        if (key.startsWith(node.nodeId + '.')) {
          const paramName = key.substring(node.nodeId.length + 1)
          customParams[paramName] = value
        }
      }
      const nodeOverrides = floatOverrides[node.nodeId]
      if (nodeOverrides) {
        Object.assign(customParams, nodeOverrides)
      }

      // Gated audio drivers: 0 unless wired into this node's Audio Drivers socket.
      applyAudioDrivers(customParams, node.nodeId, edges, driverVals)

      let prevFrameFBOId = null
      if (node.uniformLocations.u_prev_frame !== undefined) {
        const feedbackPPId = `__fb_${node.nodeId}`
        let feedbackPP = fbos.getPingPong(feedbackPPId)
        if (!feedbackPP) {
          feedbackPP = fbos.createPingPong(feedbackPPId, renderer.width, renderer.height)
        }
        prevFrameFBOId = `${feedbackPPId}_${feedbackPP.current}`
      }

      renderer.executePass(node, currentInputId, targetFBOId, standardState, customParams, prevFrameFBOId)

      if (node.uniformLocations.u_prev_frame !== undefined) {
        const feedbackPPId = `__fb_${node.nodeId}`
        const feedbackPP = fbos.getPingPong(feedbackPPId)
        if (feedbackPP) {
          fbos.blit(targetFBOId, `${feedbackPPId}_${1 - feedbackPP.current}`, renderer.width, renderer.height)
          feedbackPP.swap()
        }
      }
    }

    currentInputId = targetFBOId
    if (!isLast) pp.swap()
    effectIndex++
  }

  if (outputFBOId === null && currentInputId) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, renderer.width, renderer.height)
    gl.useProgram(renderer.passthroughProgram.program)
    fbos.bindTexture(currentInputId, 0)
    const loc = renderer.passthroughProgram.uniformLocations.u_texture
    if (loc != null) gl.uniform1i(loc, 0)
    renderer.drawQuad()
  }
}

// Per-node envelope-follower state (smoothed value + last timestamp). Module-
// level so it persists across frames; entries are tiny and keyed by node id.
const _envelopeState = new Map()

/**
 * Evaluate an ENVELOPE node: classic attack/release follower over its input,
 * then threshold gate (renormalized) and gain. `now` is seconds — the export's
 * frame-locked time when active, so envelopes behave identically offline.
 */
function evaluateEnvelope(node, input, now) {
  const p = node.params || {}
  const attack = Math.max(0.001, p.attack ?? 0.05)
  const release = Math.max(0.001, p.release ?? 0.35)
  const threshold = Math.min(0.99, Math.max(0, p.threshold ?? 0))
  const gain = p.gain ?? 1

  let st = _envelopeState.get(node.id)
  if (!st) {
    st = { value: 0, t: now }
    _envelopeState.set(node.id, st)
  }
  // dt clamped so tab-switches or export time-jumps can't blow up the smoothing.
  // Repeat calls within one frame see dt ≈ 0, so multiple resolve passes per
  // frame (top level + DOM display) don't double-advance the envelope.
  const dt = Math.min(Math.max(now - st.t, 0), 0.25)
  st.t = now

  const x = Math.max(0, input)
  const tau = x > st.value ? attack : release
  st.value += (x - st.value) * (1 - Math.exp(-dt / tau))

  return Math.max(0, (st.value - threshold) / Math.max(1e-6, 1 - threshold)) * gain
}

/**
 * Resolve float connections in a graph (Audio Splitter bands, MATH chains and
 * ENVELOPE followers wired into param sockets).
 *
 * When `nodesArg`/`edgesArg` are provided, THAT graph is evaluated — the DAG
 * executor passes its own chain and edges, so float wiring works in every
 * executing graph (master, each clip, compound interiors), not just the one
 * open in the editor. Without them it falls back to the currently-viewed
 * graph, which is what the DOM param-display pass wants.
 */
export function resolveFloatConnections(renderer, nodesArg = null, edgesArg = null) {
  const overrides = {}
  const graphStore = renderer._getGraphStore?.()
  if (!graphStore) return overrides
  const appStore = renderer._getAppStore?.()
  const audioStore = renderer._getAudioStore?.()
  if (!audioStore) return overrides

  let graph
  if (nodesArg && edgesArg) {
    graph = { nodes: nodesArg, edges: edgesArg }
  } else {
    const graphLevel = appStore?.graphLevel || 'master'
    const graphClipId = appStore?.graphClipId || null
    graph = graphLevel === 'master' ? graphStore.masterGraph : graphStore.clipGraphs?.[graphClipId]
  }
  if (!graph) return overrides

  const SPLITTER_VALUES = {
    'sub_bass': audioStore.smoothedBands?.[0] || 0, 'bass': audioStore.bass || 0,
    'low_mid': audioStore.smoothedBands?.[2] || 0, 'mid': audioStore.mid || 0,
    'high_mid': audioStore.smoothedBands?.[4] || 0, 'presence': audioStore.smoothedBands?.[5] || 0,
    'treble': audioStore.treble || 0, 'rms': audioStore.rms || 0, 'beat': audioStore.beat || 0,
  }

  // Per-stem analysis: a splitter fed by an AUDIO_INPUT whose "Audio Source"
  // names a file uses THAT file's analysis (audioStore.sources) instead of the
  // master mix — so drums can drive one effect while vocals drive another.
  const splitterValuesFor = (splitterId) => {
    const inEdge = graph.edges.find(e => e.toNode === splitterId && e.toSocket === 'audio_in')
    const feeder = inEdge && graph.nodes.find(n => n.id === inEdge.fromNode)
    const name = feeder?.type === 'AUDIO_INPUT' ? resolveAudioSourceName(feeder.params?.audioSource, renderer) : null
    const s = name ? audioStore.sources?.[name] : null
    // Fall back to the master (timeline) mix when no stem is selected OR the
    // selected stem has no live signal (its clip isn't playing under the
    // playhead). Previously only the `!s` case fell back, so a stem that had
    // played once but was now idle stayed a truthy all-zero entry and drove the
    // splitter to silence — the reported "nothing comes out" dead-air bug.
    if (!s || !stemHasSignal(s)) return SPLITTER_VALUES
    const b = s.smoothedBands || []
    return {
      'sub_bass': b[0] || 0, 'bass': s.bass || 0,
      'low_mid': b[2] || 0, 'mid': s.mid || 0,
      'high_mid': b[4] || 0, 'presence': b[5] || 0,
      'treble': s.treble || 0, 'rms': s.rms || 0, 'beat': s.beat || 0,
    }
  }

  const floatValues = {}
  for (const node of graph.nodes) {
    if (node.type === 'AUDIO_SPLITTER') {
      const vals = splitterValuesFor(node.id)
      for (const [socketId, value] of Object.entries(vals)) {
        floatValues[`${node.id}.${socketId}`] = value
      }
    }
    if (node.type === 'MATH') {
      const params = node.params || {}
      floatValues[`${node.id}.value_a`] = params.value_a ?? 0
      floatValues[`${node.id}.value_b`] = params.value_b ?? 1
    }
  }

  // Envelope followers use the export's frame-locked time when active so the
  // offline render matches live playback; otherwise wall-clock seconds.
  const now = (renderer._timeOverride != null) ? renderer._timeOverride : performance.now() / 1000

  const evaluated = new Set()
  let progress = true
  while (progress) {
    progress = false
    for (const node of graph.nodes) {
      if ((node.type !== 'MATH' && node.type !== 'ENVELOPE') || evaluated.has(node.id)) continue

      // ENVELOPE: single float input → smoothed output. If its producer is a
      // MATH/ENVELOPE that hasn't been evaluated yet, retry on the next pass.
      if (node.type === 'ENVELOPE') {
        const edge = graph.edges.find(e => e.toNode === node.id && e.toSocket === 'input')
        let input = 0
        if (edge) {
          const srcKey = `${edge.fromNode}.${edge.fromSocket}`
          if (floatValues[srcKey] === undefined) {
            const producer = graph.nodes.find(n => n.id === edge.fromNode)
            if (producer && (producer.type === 'MATH' || producer.type === 'ENVELOPE') && !evaluated.has(producer.id)) {
              continue // dependency not ready — another pass is coming
            }
          } else {
            input = floatValues[srcKey]
          }
        }
        floatValues[`${node.id}.output`] = evaluateEnvelope(node, input, now)
        evaluated.add(node.id)
        progress = true
        continue
      }

      const params = node.params || {}
      const operation = params.operation ?? 0
      let valueA = params.value_a ?? 0
      let valueB = params.value_b ?? 1
      for (const edge of graph.edges) {
        if (edge.toNode === node.id) {
          const srcKey = `${edge.fromNode}.${edge.fromSocket}`
          if (floatValues[srcKey] !== undefined) {
            if (edge.toSocket === 'value_a') valueA = floatValues[srcKey]
            else if (edge.toSocket === 'value_b') valueB = floatValues[srcKey]
          }
        }
      }
      floatValues[`${node.id}.output`] = evaluateMathOperation(operation, valueA, valueB)
      evaluated.add(node.id)
      progress = true
    }
  }

  for (const edge of graph.edges) {
    const srcKey = `${edge.fromNode}.${edge.fromSocket}`
    const floatValue = floatValues[srcKey]
    if (floatValue === undefined) continue
    if (!overrides[edge.toNode]) overrides[edge.toNode] = {}
    overrides[edge.toNode][edge.toSocket] = floatValue
  }

  return overrides
}

function evaluateMathOperation(operation, a, b) {
  switch (operation) {
    case 0: return a + b
    case 1: return a - b
    case 2: return a * b
    case 3: return b !== 0 ? a / b : 0
    case 4: return Math.sin(a)
    case 5: return Math.cos(a)
    case 6: return Math.abs(a)
    case 7: return Math.min(a, b)
    case 8: return Math.max(a, b)
    case 9: return a > b ? 1.0 : 0.0
    case 10: return a < b ? 1.0 : 0.0
    default: return a + b
  }
}

export function getActiveClip(clips, trackId, time) {
  return clips.find(c => c.trackId === trackId && time >= c.timelineStart && time < c.timelineEnd) || null
}

/**
 * All clips active on a track at `time`, sorted by start time ascending. When
 * clips overlap in time on one track, the later-starting clip is composited last
 * (on top), matching standard NLE behaviour (spec §C).
 */
export function getActiveClips(clips, trackId, time) {
  return clips
    .filter(c => c.trackId === trackId && time >= c.timelineStart && time < c.timelineEnd)
    .sort((a, b) => a.timelineStart - b.timelineStart)
}

export function getClipSourceTime(clip, playheadTime) {
  const clipLocalTime = playheadTime - clip.timelineStart
  const sourceTime = clip.sourceStart + clipLocalTime * (clip.speed || 1)
  return Math.max(clip.sourceStart, Math.min(clip.sourceEnd, sourceTime))
}
