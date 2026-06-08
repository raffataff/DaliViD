/**
 * DaliVid — clipGraphManager.js
 * Bridges the graph store and the WebGL renderer.
 * Compiles node chains from topologically sorted graphs,
 * creates shader programs, and executes per-frame through FBOs.
 */

import { createShaderProgram } from './ShaderProgram.js'
import { getShaderSource } from '../shaders/shaderRegistry.js'
import { getExecutionOrder } from '../utils/topSort.js'

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

    // Get shader source — custom code or from registry
    const shaderSrc = node.customShaderSource || node.shaderCode || getShaderSource(node.type)
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

  return { chain, errors }
}

/**
 * Execute a compiled chain through FBOs.
 */
export function executeChain(renderer, chain, inputFBOId, outputFBOId, standardState, audioBindings = {}) {
  const gl = renderer.gl
  const fbos = renderer.fbos

  if (!chain || chain.length === 0) return

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
      // Regular effect node
      const customParams = { ...node.params }
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

    const customParams = { ...node.params }

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
