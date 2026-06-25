/**
 * DaliVid — compoundUtils.js
 * Utilities for compound effect creation, expansion, parameter exposure,
 * and auto-exposing inner node parameters.
 */

import { parseParams } from './paramParser'
import { getNodeSource } from '../shaders/shaderRegistry'

const EXCLUDED_FROM_SELECTION = new Set([
  'OUTPUT', 'CLIP_OUTPUT', 'EFFECT_OUTPUT',
  'CLIP_SOURCE', 'VIDEO_INPUT', 'CAMERA_INPUT',
  'AUDIO_INPUT', 'AUDIO_SPLITTER',
  'EFFECT_INPUT',
])

/**
 * Check if a node type is an I/O terminal that shouldn't be compoundable.
 */
export function isCompoundable(nodeType) {
  return !EXCLUDED_FROM_SELECTION.has(nodeType)
}

/**
 * Gather param configs for a sub-graph node (from shader source or hardcoded).
 */
function getSubNodeParamConfigs(node) {
  if (node.type === 'MATH') {
    return [
      { name: 'Value A', uniformName: 'value_a', type: 'slider', min: -100, max: 100, step: 0.01, default: 0 },
      { name: 'Value B', uniformName: 'value_b', type: 'slider', min: -100, max: 100, step: 0.01, default: 1 },
    ]
  }
  const shaderSrc = getNodeSource(node)
  if (!shaderSrc) return []
  return parseParams(shaderSrc)
}

/**
 * Determine if a param should be auto-exposed to the compound surface.
 */
function shouldAutoExpose(param) {
  if (param.type === 'slider' || param.type === 'color' || param.type === 'checkbox' || param.type === 'select') {
    return true
  }
  return false
}

/**
 * Create a compound effect from selected nodes.
 * @param {Array} selectedNodeIds — IDs of nodes to group
 * @param {Array} allNodes — all nodes in the graph
 * @param {Array} allEdges — all edges in the graph
 * @param {string} name — compound name
 * @param {string} color — accent color
 * @param {string} description — optional description
 * @returns {{ compoundNode, updatedEdges, removedNodeIds, warnings }}
 */
export function createCompound(selectedNodeIds, allNodes, allEdges, name = 'New Compound', color = '#ff00aa', description = '') {
  const selected = new Set(selectedNodeIds)
  const warnings = []

  // Classify edges
  const internalEdges = []
  const inputEdges = []  // from outside → inside
  const outputEdges = [] // from inside → outside
  const unrelatedEdges = []

  for (const edge of allEdges) {
    const fromSelected = selected.has(edge.fromNode)
    const toSelected = selected.has(edge.toNode)

    if (fromSelected && toSelected) {
      internalEdges.push(edge)
    } else if (!fromSelected && toSelected) {
      inputEdges.push(edge)
    } else if (fromSelected && !toSelected) {
      outputEdges.push(edge)
    } else {
      unrelatedEdges.push(edge)
    }
  }

  // Build sub-graph nodes
  const subNodes = allNodes.filter(n => selected.has(n.id))

  // Create one EFFECT_INPUT per external input edge
  const inputNodes = inputEdges.map((edge, i) => ({
    id: `compound_input_${Date.now()}_${i}`,
    type: 'EFFECT_INPUT',
    name: 'INPUT',
    position: { x: -220, y: 200 + i * 60 },
    locked: true,
    params: {},
  }))

  // Create one EFFECT_OUTPUT per external output edge
  const outputNodes = outputEdges.map((edge, i) => ({
    id: `compound_output_${Date.now()}_${i}`,
    type: 'EFFECT_OUTPUT',
    name: 'OUTPUT',
    position: { x: 600 + i * 0, y: 200 + i * 60 },
    locked: true,
    params: {},
  }))

  // Wire sub-graph: internal edges
  const subEdges = [...internalEdges]

  // Wire each EFFECT_INPUT terminal to its destination
  for (let i = 0; i < inputEdges.length; i++) {
    subEdges.push({
      id: `edge_compound_in_${Date.now()}_${i}`,
      fromNode: inputNodes[i].id,
      fromSocket: 'output',
      toNode: inputEdges[i].toNode,
      toSocket: inputEdges[i].toSocket,
    })
  }

  // Wire each source to its EFFECT_OUTPUT terminal
  for (let i = 0; i < outputEdges.length; i++) {
    subEdges.push({
      id: `edge_compound_out_${Date.now()}_${i}`,
      fromNode: outputEdges[i].fromNode,
      fromSocket: outputEdges[i].fromSocket,
      toNode: outputNodes[i].id,
      toSocket: 'input',
    })
  }

  // Auto-expose inner node params
  const exposedParams = []
  for (const subNode of subNodes) {
    const paramConfigs = getSubNodeParamConfigs(subNode)
    for (const param of paramConfigs) {
      if (shouldAutoExpose(param)) {
        const value = subNode.params?.[param.uniformName] ?? param.default
        exposedParams.push({
          displayName: `${subNode.name} → ${param.name}`,
          innerNodeId: subNode.id,
          uniformName: param.uniformName,
          paramConfig: { ...param },
          value,
          mappings: [{
            nodeId: subNode.id,
            uniformName: param.uniformName,
            scaleFactor: 1.0,
            offset: 0.0,
          }],
        })
      }
    }
  }

  // Create the compound node for the parent graph
  const compoundId = `compound_${Date.now()}`
  const compoundNode = {
    id: compoundId,
    type: 'COMPOUND',
    name,
    color,
    description,
    position: calculateCentroid(subNodes),
    params: {},
    bypassed: false,
    subGraph: {
      nodes: [...inputNodes, ...subNodes, ...outputNodes],
      edges: subEdges,
    },
    exposedParams,
    nodeCount: subNodes.length,
  }

  // Build new parent edges
  const updatedEdges = [...unrelatedEdges]

  // Re-wire external inputs to the compound node (input_0, input_1, ...)
  for (let i = 0; i < inputEdges.length; i++) {
    updatedEdges.push({
      id: `edge_to_compound_${Date.now()}_${i}`,
      fromNode: inputEdges[i].fromNode,
      fromSocket: inputEdges[i].fromSocket,
      toNode: compoundId,
      toSocket: `input_${i}`,
    })
  }

  // Re-wire external outputs from the compound node (output_0, output_1, ...)
  for (let i = 0; i < outputEdges.length; i++) {
    updatedEdges.push({
      id: `edge_from_compound_${Date.now()}_${i}`,
      fromNode: compoundId,
      fromSocket: `output_${i}`,
      toNode: outputEdges[i].toNode,
      toSocket: outputEdges[i].toSocket,
    })
  }

  return {
    compoundNode,
    updatedEdges,
    removedNodeIds: selectedNodeIds,
    warnings,
  }
}

/**
 * Expand (detach) a compound node back into individual nodes.
 */
export function expandCompound(compoundNode, parentEdges) {
  const subGraph = compoundNode.subGraph
  if (!subGraph) return null

  // Filter out ALL terminal nodes (there may be multiple EFFECT_INPUT/OUTPUT)
  const innerNodes = subGraph.nodes.filter(
    n => n.type !== 'EFFECT_INPUT' && n.type !== 'EFFECT_OUTPUT'
  )

  const offsetNodes = innerNodes.map(n => ({
    ...n,
    position: {
      x: n.position.x + compoundNode.position.x,
      y: n.position.y + compoundNode.position.y,
    },
  }))

  // Collect all terminal node IDs
  const terminalIds = new Set(
    subGraph.nodes
      .filter(n => n.type === 'EFFECT_INPUT' || n.type === 'EFFECT_OUTPUT')
      .map(n => n.id)
  )

  const innerEdges = subGraph.edges.filter(
    e => !terminalIds.has(e.fromNode) && !terminalIds.has(e.toNode)
  )

  // Map: terminal ID → inner edges connected to it
  const inputTerminalEdges = {} // terminalId → { toNode, toSocket }
  const outputTerminalEdges = {} // terminalId → { fromNode, fromSocket }
  for (const edge of subGraph.edges) {
    if (terminalIds.has(edge.fromNode)) {
      outputTerminalEdges[edge.fromNode] = { fromNode: edge.toNode, fromSocket: edge.toSocket }
    }
    if (terminalIds.has(edge.toNode)) {
      inputTerminalEdges[edge.toNode] = { toNode: edge.fromNode, toSocket: edge.fromSocket }
    }
  }

  const incomingEdges = parentEdges.filter(e => e.toNode === compoundNode.id)
  const outgoingEdges = parentEdges.filter(e => e.fromNode === compoundNode.id)

  const newParentEdges = parentEdges.filter(
    e => e.fromNode !== compoundNode.id && e.toNode !== compoundNode.id
  )

  // For each incoming parent edge (connected to compound input_N),
  // bridge to the corresponding inner node
  for (const inEdge of incomingEdges) {
    // Find which input terminal this maps to
    const inputTerminals = subGraph.nodes.filter(n => n.type === 'EFFECT_INPUT')
    for (const term of inputTerminals) {
      const innerEdge = subGraph.edges.find(e => e.fromNode === term.id)
      if (innerEdge) {
        newParentEdges.push({
          ...inEdge,
          id: `edge_expanded_in_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          toNode: innerEdge.toNode,
          toSocket: innerEdge.toSocket,
        })
        break
      }
    }
  }

  // For each outgoing parent edge (from compound output_N),
  // bridge from the corresponding inner node
  for (const outEdge of outgoingEdges) {
    const outputTerminals = subGraph.nodes.filter(n => n.type === 'EFFECT_OUTPUT')
    for (const term of outputTerminals) {
      const innerEdge = subGraph.edges.find(e => e.toNode === term.id)
      if (innerEdge) {
        newParentEdges.push({
          ...outEdge,
          id: `edge_expanded_out_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          fromNode: innerEdge.fromNode,
          fromSocket: innerEdge.fromSocket,
        })
        break
      }
    }
  }

  return {
    expandedNodes: offsetNodes,
    expandedEdges: innerEdges,
    updatedParentEdges: newParentEdges,
  }
}

/**
 * Update a single exposed param value on a compound node.
 * Propagates through the mappings chain to the inner node param.
 */
export function updateExposedParam(compoundNode, exposedParamIndex, value) {
  const ep = compoundNode.exposedParams?.[exposedParamIndex]
  if (!ep) return compoundNode

  const mapping = ep.mappings?.[0]
  if (!mapping) {
    return {
      ...compoundNode,
      exposedParams: compoundNode.exposedParams.map((p, i) =>
        i === exposedParamIndex ? { ...p, value } : p
      ),
    }
  }

  const innerValue = value * mapping.scaleFactor + mapping.offset

  // Update the params on the inner sub-graph node
  const newSubGraph = {
    ...compoundNode.subGraph,
    nodes: compoundNode.subGraph.nodes.map(n =>
      n.id === mapping.nodeId
        ? { ...n, params: { ...n.params, [mapping.uniformName]: innerValue } }
        : n
    ),
  }

  return {
    ...compoundNode,
    subGraph: newSubGraph,
    exposedParams: compoundNode.exposedParams.map((p, i) =>
      i === exposedParamIndex ? { ...p, value } : p
    ),
  }
}

/**
 * Calculate centroid position of a set of nodes.
 */
function calculateCentroid(nodes) {
  if (nodes.length === 0) return { x: 200, y: 200 }
  const sumX = nodes.reduce((s, n) => s + (n.position?.x || 0), 0)
  const sumY = nodes.reduce((s, n) => s + (n.position?.y || 0), 0)
  return { x: sumX / nodes.length, y: sumY / nodes.length }
}

/**
 * Check maximum compound nesting depth.
 */
export function checkNestingDepth(compoundNode, depth = 0) {
  if (depth >= 5) return false
  const subNodes = compoundNode.subGraph?.nodes || []
  for (const node of subNodes) {
    if (node.type === 'COMPOUND') {
      if (!checkNestingDepth(node, depth + 1)) return false
    }
  }
  return true
}
