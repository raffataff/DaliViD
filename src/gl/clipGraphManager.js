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
const AUDIO_DRIVER_BANDS = ['sub_bass', 'bass', 'low_mid', 'mid', 'high_mid', 'presence', 'treble', 'rms']
// All audio uniforms auto-declared into every effect (the 8 gated bands plus the
// always-live u_beat). u_beat is not gated — it's uploaded by uploadStandardUniforms.
const AUDIO_DECLARE_UNIFORMS = [...AUDIO_DRIVER_BANDS, 'beat']
const AUDIO_DRIVERS_SOCKET = 'audio_drivers'

/**
 * Inject `uniform float u_<name>;` declarations for any audio uniform the shader
 * doesn't already declare. Done at compile time so users can reference the
 * drivers in code without adding the declaration themselves. The editable source
 * is left untouched — only the compiled string carries the injected lines.
 */
function injectAudioDrivers(source) {
  if (!source) return source
  const missing = AUDIO_DECLARE_UNIFORMS.filter(name => {
    const re = new RegExp(`uniform\\s+(?:lowp\\s+|mediump\\s+|highp\\s+)?float\\s+u_${name}\\b`)
    return !re.test(source)
  })
  if (missing.length === 0) return source
  const decls = missing.map(name => `uniform float u_${name};`).join('\n')
  const lines = source.split('\n')
  // Insert after the precision line (or #version, or at the very top).
  let idx = lines.findIndex(l => /\bprecision\b/.test(l))
  if (idx === -1) idx = lines.findIndex(l => /#version/.test(l))
  if (idx === -1) return `${decls}\n${source}`
  lines.splice(idx + 1, 0, decls)
  return lines.join('\n')
}

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
 */
function applyAudioDrivers(customParams, nodeId, edges, driverVals) {
  for (const band of AUDIO_DRIVER_BANDS) customParams['u_' + band] = 0
  if (!edges) return
  for (const e of edges) {
    if (e.toNode === nodeId && e.toSocket === AUDIO_DRIVERS_SOCKET && driverVals[e.fromSocket] !== undefined) {
      customParams['u_' + e.fromSocket] = driverVals[e.fromSocket]
    }
  }
}

/**
 * Normalize node params into GPU-ready values.
 * Hex color strings ("#rrggbb") are converted to a normalized vec3 so they
 * don't reach gl.uniform3f as a string (which produces NaN).
 */
function normalizeParams(params) {
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

    // Source/input nodes — no shader, just mark as passthrough
    if (['CLIP_SOURCE', 'VIDEO_INPUT', 'CAMERA_INPUT', 'EFFECT_INPUT'].includes(node.type)) {
      chain.push({ nodeId: node.id, type: node.type, program: null, uniformLocations: {}, params: node.params || {}, bypassed: node.bypassed || false, name: node.name, isSource: true })
      continue
    }

    // Audio nodes — no shader, data-routing only
    if (['AUDIO_INPUT', 'AUDIO_SPLITTER', 'MATH'].includes(node.type)) {
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
export function executeChain(renderer, chain, inputFBOId, outputFBOId, standardState, audioBindings = {}, liveNodes = null, edges = null) {
  if (USE_DAG && edges) {
    return executeGraphDAG(renderer, chain, edges, inputFBOId, outputFBOId, standardState, audioBindings, liveNodes)
  }
  return executeChainLinear(renderer, chain, inputFBOId, outputFBOId, standardState, audioBindings, liveNodes, edges)
}

/**
 * DAG evaluator: each effect/compound node writes to its own output FBO and
 * reads its inputs from the FBOs produced by the nodes wired to its input
 * sockets. Supports branching and multi-input effects (e.g. Displacement,
 * blend). Nodes are walked in topological order (compileGraph already sorts
 * them), so a producer's output FBO is always ready before its consumer runs.
 */
function executeGraphDAG(renderer, chain, edges, inputFBOId, outputFBOId, standardState, audioBindings, liveNodes) {
  const { fbos } = renderer

  if (!chain || chain.length === 0) {
    blitOrScreen(renderer, inputFBOId, outputFBOId)
    return
  }

  const byId = {}
  for (const n of chain) byId[n.nodeId] = n

  // Only texture-carrying edges matter for routing pixels.
  const texEdges = (edges || []).filter(e => e.toSocket in TEXTURE_INPUT_SOCKETS)

  const floatOverrides = resolveFloatConnections(renderer)
  const driverVals = audioDriverValues(renderer)
  const nodeOutput = {} // nodeId → FBO id holding its output this frame

  const ensureFBO = (id) => {
    if (!fbos.has(id)) fbos.create(id, renderer.width, renderer.height)
    else fbos.resize(id, renderer.width, renderer.height)
    return id
  }

  // The FBO produced by a node, following bypass/compile-error passthrough.
  const resolveProducer = (nodeId, guard) => {
    if (guard.has(nodeId)) return inputFBOId
    guard.add(nodeId)
    const src = byId[nodeId]
    if (!src || src.isSource) return inputFBOId
    if (src.bypassed || src.compileError) {
      return resolveSocket(nodeId, 'input', guard) ?? inputFBOId
    }
    return nodeOutput[nodeId] ?? inputFBOId
  }

  // The FBO feeding a (nodeId, socket), or null if nothing is wired to it.
  const resolveSocket = (nodeId, socket, guard = new Set()) => {
    const edge = texEdges.find(e => e.toNode === nodeId && e.toSocket === socket)
    if (!edge) return null
    return resolveProducer(edge.fromNode, guard)
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
      const outId = ensureFBO(`__n_${node.nodeId}`)
      const compoundPPId = `__compound_pp_${node.nodeId}`
      let compoundPP = fbos.getPingPong(compoundPPId)
      if (!compoundPP) compoundPP = fbos.createPingPong(compoundPPId, renderer.width, renderer.height)
      else fbos.resizePingPong(compoundPPId, renderer.width, renderer.height)
      executeSubChain(renderer, node.subChain, primaryInput, outId, standardState, compoundPPId, compoundPP)
      nodeOutput[node.nodeId] = outId
      lastProducedFBO = outId
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

    // Gated audio drivers: 0 unless wired into this node's Audio Drivers socket.
    applyAudioDrivers(customParams, node.nodeId, edges, driverVals)

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
      const ppId = `__npp_${node.nodeId}`
      let pp = fbos.getPingPong(ppId)
      if (!pp) pp = fbos.createPingPong(ppId, renderer.width, renderer.height)
      else fbos.resizePingPong(ppId, renderer.width, renderer.height)
      const prevFrameFBOId = `${ppId}_${pp.current}`
      outId = `${ppId}_${1 - pp.current}`
      renderer.executePass(node, primaryInput, outId, standardState, customParams, prevFrameFBOId, extraTextures)
      pp.swap() // current now points at the buffer we just wrote
    } else {
      outId = ensureFBO(`__n_${node.nodeId}`)
      renderer.executePass(node, primaryInput, outId, standardState, customParams, null, extraTextures)
    }

    nodeOutput[node.nodeId] = outId
    lastProducedFBO = outId
  }

  // Final image = whatever feeds the OUTPUT node, else the last node, else input.
  const outputNode = chain.find(n => n.isOutput)
  let finalFBO = outputNode ? resolveSocket(outputNode.nodeId, 'input') : null
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
      // Execute compound sub-chain
      const compoundPPId = `__compound_pp_${node.nodeId}`
      let compoundPP = fbos.getPingPong(compoundPPId)
      if (!compoundPP) {
        compoundPP = fbos.createPingPong(compoundPPId, renderer.width, renderer.height)
      } else {
        fbos.resizePingPong(compoundPPId, renderer.width, renderer.height)
      }

      // Execute sub-chain through its own ping-pong
      executeSubChain(renderer, node.subChain, currentInputId, targetFBOId, standardState, compoundPPId, compoundPP)
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

/**
 * Execute a compound sub-chain through its own ping-pong FBO context.
 */
function executeSubChain(renderer, subChain, inputFBOId, outputFBOId, standardState, ppId, pp) {
  const fbos = renderer.fbos
  const gl = renderer.gl
  const effectNodes = subChain.filter(n =>
    n.program && !n.bypassed && !n.compileError && !n.isSource && !n.isOutput
  )

  if (effectNodes.length === 0) {
    if (inputFBOId && outputFBOId) {
      fbos.blit(inputFBOId, outputFBOId, renderer.width, renderer.height)
    }
    return
  }

  let currentInputId = inputFBOId

  for (let i = 0; i < effectNodes.length; i++) {
    const node = effectNodes[i]
    const isLast = (i === effectNodes.length - 1)

    let targetFBOId
    if (isLast && outputFBOId) {
      targetFBOId = outputFBOId
    } else if (isLast) {
      targetFBOId = `${ppId}_${pp.current}`
    } else {
      targetFBOId = `${ppId}_${pp.current}`
    }

    const customParams = normalizeParams(node.params)

    let prevFrameFBOId = null
    if (node.uniformLocations.u_prev_frame !== undefined) {
      const feedbackPPId = `__fb_sub_${node.nodeId}`
      let feedbackPP = fbos.getPingPong(feedbackPPId)
      if (!feedbackPP) {
        feedbackPP = fbos.createPingPong(feedbackPPId, renderer.width, renderer.height)
      }
      prevFrameFBOId = `${feedbackPPId}_${feedbackPP.current}`
    }

    renderer.executePass(node, currentInputId, targetFBOId, standardState, customParams, prevFrameFBOId)

    if (node.uniformLocations.u_prev_frame !== undefined) {
      const feedbackPPId = `__fb_sub_${node.nodeId}`
      const feedbackPP = fbos.getPingPong(feedbackPPId)
      if (feedbackPP) {
        fbos.blit(targetFBOId, `${feedbackPPId}_${1 - feedbackPP.current}`, renderer.width, renderer.height)
        feedbackPP.swap()
      }
    }

    currentInputId = targetFBOId
    if (!isLast) pp.swap()
  }

  if (!outputFBOId && currentInputId) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, renderer.width, renderer.height)
    gl.useProgram(renderer.passthroughProgram.program)
    fbos.bindTexture(currentInputId, 0)
    const loc = renderer.passthroughProgram.uniformLocations.u_texture
    if (loc != null) gl.uniform1i(loc, 0)
    renderer.drawQuad()
  }
}

/**
 * Resolve float connections in a graph.
 */
export function resolveFloatConnections(renderer) {
  const overrides = {}
  const graphStore = renderer._getGraphStore?.()
  if (!graphStore) return overrides
  const appStore = renderer._getAppStore?.()
  const audioStore = renderer._getAudioStore?.()
  if (!audioStore) return overrides

  const graphLevel = appStore?.graphLevel || 'master'
  const graphClipId = appStore?.graphClipId || null
  const graph = graphLevel === 'master' ? graphStore.masterGraph : graphStore.clipGraphs?.[graphClipId]
  if (!graph) return overrides

  const SPLITTER_VALUES = {
    'sub_bass': audioStore.smoothedBands?.[0] || 0, 'bass': audioStore.bass || 0,
    'low_mid': audioStore.smoothedBands?.[2] || 0, 'mid': audioStore.mid || 0,
    'high_mid': audioStore.smoothedBands?.[4] || 0, 'presence': audioStore.smoothedBands?.[5] || 0,
    'treble': audioStore.treble || 0, 'rms': audioStore.rms || 0, 'beat': audioStore.beat || 0,
  }

  const floatValues = {}
  for (const node of graph.nodes) {
    if (node.type === 'AUDIO_SPLITTER') {
      for (const [socketId, value] of Object.entries(SPLITTER_VALUES)) {
        floatValues[`${node.id}.${socketId}`] = value
      }
    }
    if (node.type === 'MATH') {
      const params = node.params || {}
      floatValues[`${node.id}.value_a`] = params.value_a ?? 0
      floatValues[`${node.id}.value_b`] = params.value_b ?? 1
    }
  }

  const evaluated = new Set()
  let progress = true
  while (progress) {
    progress = false
    for (const node of graph.nodes) {
      if (node.type !== 'MATH' || evaluated.has(node.id)) continue
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

export function getClipSourceTime(clip, playheadTime) {
  const clipLocalTime = playheadTime - clip.timelineStart
  const sourceTime = clip.sourceStart + clipLocalTime * (clip.speed || 1)
  return Math.max(clip.sourceStart, Math.min(clip.sourceEnd, sourceTime))
}
