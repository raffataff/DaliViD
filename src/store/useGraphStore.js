/**
 * DaliVid — useGraphStore.js
 * Manages node graph state for master graph and all per-clip graphs.
 * Handles nodes, edges, topology, and compilation state.
 */

import { create } from 'zustand'
import { createCompound, updateExposedParam, expandCompound } from '../utils/compoundUtils'
import { STARTER_TRANSITION_COMPOUND } from '../shaders/compoundPresets'
import { removeNodeImage } from '../gl/imageRegistry'
import { emitNodeRemoved } from '../gl/nodeLifecycle'

let nodeCounter = 0
function newNodeId() {
  return `node_${Date.now()}_${++nodeCounter}`
}

function newEdgeId() {
  return `edge_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
}

// updateNode() updates that require a shader recompile (change topology, baked
// flags, or source). Plain param/position/name edits are intentionally excluded
// so dragging a slider doesn't recompile the graph every frame.
const RECOMPILE_KEYS = ['bypassed', 'customShaderSource', 'shaderCode', 'type', 'subGraph']

function createDefaultMasterGraph() {
  const outputId = `node_master_output`
  const audioInId = `node_audio_in`
  const splitterId = `node_audio_splitter`
  return {
    nodes: [
      {
        id: outputId, type: 'OUTPUT', name: 'Master Output',
        position: { x: 800, y: 200 }, params: { u_gain: 1.0, u_dither: false },
        shaderCode: null, bypassed: false, locked: true, previewTapPoint: false, audioBindings: {},
      },
      {
        id: audioInId, type: 'AUDIO_INPUT', name: 'Timeline Audio',
        position: { x: 50, y: 400 }, params: {},
        shaderCode: null, bypassed: false, locked: true, previewTapPoint: false, audioBindings: {},
      },
      {
        id: splitterId, type: 'AUDIO_SPLITTER', name: 'Audio Splitter',
        position: { x: 300, y: 400 }, params: {},
        shaderCode: null, bypassed: false, locked: true, previewTapPoint: false, audioBindings: {},
      },
    ],
    edges: [
      { id: `edge_audio_default`, fromNode: audioInId, fromSocket: 'audio_out', toNode: splitterId, toSocket: 'audio_in' },
    ],
    tapPointNodeId: outputId, compiledChain: [], compileErrors: [],
  }
}

const useGraphStore = create((set, get) => ({
  masterGraph: createDefaultMasterGraph(),
  clipGraphs: {},
  // Seeded with the starter node-graph transition so the clip Inspector's
  // "Custom (Node Graph)" list is never empty and the pattern is discoverable.
  compoundLibrary: [STARTER_TRANSITION_COMPOUND],
  undoStack: [],
  redoStack: [],

  // Bumped only when graph structure / shader source / baked flags change.
  // The renderer watches this to decide when to recompile (vs. just re-reading
  // live param values each frame).
  topologyVersion: 0,

  getActiveGraph: (graphLevel, clipId) => {
    const state = get()
    if (graphLevel === 'master') return state.masterGraph
    return state.clipGraphs[clipId] || null
  },

  addNode: (graphLevel, clipId, nodeData) => {
    const id = newNodeId()
    const node = {
      type: nodeData.type, name: nodeData.name || nodeData.type,
      position: nodeData.position || { x: 200, y: 200 },
      params: nodeData.params || {}, shaderCode: nodeData.shaderCode || null,
      bypassed: false, previewTapPoint: false, audioBindings: {},
      ...nodeData, id,
    }
    set((state) => {
      if (graphLevel === 'master') {
        return { masterGraph: { ...state.masterGraph, nodes: [...state.masterGraph.nodes, node] }, topologyVersion: state.topologyVersion + 1 }
      }
      const graph = state.clipGraphs[clipId] || { nodes: [], edges: [], tapPointNodeId: null, compiledChain: [], compileErrors: [] }
      return { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, nodes: [...graph.nodes, node] } }, topologyVersion: state.topologyVersion + 1 }
    })
    return id
  },

  removeNode: (graphLevel, clipId, nodeId) => {
    // Free the decoded-image cache and, via the lifecycle hook, all GPU resources
    // this node owns — its output/feedback FBOs, image FBO+texture, and any
    // compound inner FBOs. Look the node up before it's filtered out of the graph.
    const activeGraph = graphLevel === 'master' ? get().masterGraph : get().clipGraphs[clipId]
    const removedNode = activeGraph?.nodes.find(n => n.id === nodeId) || null
    removeNodeImage(nodeId)
    emitNodeRemoved(removedNode)
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      return graphLevel === 'master'
        ? { masterGraph: { ...graph, nodes: graph.nodes.filter(n => n.id !== nodeId), edges: graph.edges.filter(e => e.fromNode !== nodeId && e.toNode !== nodeId) }, topologyVersion: state.topologyVersion + 1 }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, nodes: graph.nodes.filter(n => n.id !== nodeId), edges: graph.edges.filter(e => e.fromNode !== nodeId && e.toNode !== nodeId) } }, topologyVersion: state.topologyVersion + 1 }
    })
  },

  updateNode: (graphLevel, clipId, nodeId, updates) => {
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      const nodes = graph.nodes.map(n => n.id === nodeId ? { ...n, ...updates } : n)
      // Only force a recompile when the change affects topology/source/baked flags.
      const bump = RECOMPILE_KEYS.some(k => k in updates) ? { topologyVersion: state.topologyVersion + 1 } : {}
      return graphLevel === 'master'
        ? { masterGraph: { ...graph, nodes }, ...bump }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, nodes } }, ...bump }
    })
  },

  getNode: (graphLevel, clipId, nodeId) => {
    const graph = get().getActiveGraph(graphLevel, clipId)
    return graph ? graph.nodes.find(n => n.id === nodeId) : null
  },

  updateNodeCustomShader: (graphLevel, clipId, nodeId, code) => {
    get().updateNode(graphLevel, clipId, nodeId, { customShaderSource: code })
  },

  setNodeParam: (graphLevel, clipId, nodeId, paramName, value) => {
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      const nodes = graph.nodes.map(n => n.id === nodeId ? { ...n, params: { ...n.params, [paramName]: value } } : n)
      return graphLevel === 'master'
        ? { masterGraph: { ...graph, nodes } }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, nodes } } }
    })
  },

  addEdge: (graphLevel, clipId, fromNode, fromSocket, toNode, toSocket) => {
    const id = newEdgeId()
    const edge = { id, fromNode, fromSocket, toNode, toSocket }
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      // Most input sockets accept a single connection (new one replaces old).
      // The Audio Drivers socket is multi-accept: keep every distinct band, only
      // replacing an edge coming from the exact same source socket.
      const isMulti = toSocket === 'audio_drivers'
      const edges = graph.edges.filter(e => {
        if (e.toNode !== toNode || e.toSocket !== toSocket) return true
        return isMulti && !(e.fromNode === fromNode && e.fromSocket === fromSocket)
      })
      edges.push(edge)
      return graphLevel === 'master'
        ? { masterGraph: { ...graph, edges }, topologyVersion: state.topologyVersion + 1 }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, edges } }, topologyVersion: state.topologyVersion + 1 }
    })
    return id
  },

  removeEdge: (graphLevel, clipId, edgeId) => {
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      return graphLevel === 'master'
        ? { masterGraph: { ...graph, edges: graph.edges.filter(e => e.id !== edgeId) }, topologyVersion: state.topologyVersion + 1 }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, edges: graph.edges.filter(e => e.id !== edgeId) } }, topologyVersion: state.topologyVersion + 1 }
    })
  },

  setTapPoint: (graphLevel, clipId, nodeId) => {
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      return graphLevel === 'master'
        ? { masterGraph: { ...graph, tapPointNodeId: nodeId } }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, tapPointNodeId: nodeId } } }
    })
  },

  /**
   * Deep-copy a clip's effect graph to another clip with fresh node/edge ids —
   * used when splitting a clip, so the new right half keeps the same effects
   * (and is enterable at all: without a graph the clip editor has nothing to
   * open). Falls back to a default graph when the source has none.
   */
  duplicateClipGraph: (sourceClipId, newClipId, clipName = 'Clip', clipType = 'video') => {
    set((state) => {
      const src = state.clipGraphs[sourceClipId]
      if (!src) {
        return {
          clipGraphs: { ...state.clipGraphs, [newClipId]: createClipGraph(clipName, clipType) },
          topologyVersion: state.topologyVersion + 1,
        }
      }
      const stamp = Date.now()
      let seq = 0
      const idMap = {}
      for (const n of src.nodes) idMap[n.id] = `node_${stamp}_sp${++seq}`
      const nodes = src.nodes.map(n => {
        const copy = JSON.parse(JSON.stringify(n)) // params, subGraph, bindings
        copy.id = idMap[n.id]
        return copy
      })
      const edges = src.edges.map((e, i) => ({
        ...e,
        id: `edge_${stamp}_sp${i}`,
        fromNode: idMap[e.fromNode] || e.fromNode,
        toNode: idMap[e.toNode] || e.toNode,
      }))
      return {
        clipGraphs: {
          ...state.clipGraphs,
          [newClipId]: {
            nodes,
            edges,
            tapPointNodeId: idMap[src.tapPointNodeId] || null,
            compiledChain: [],
            compileErrors: [],
          },
        },
        topologyVersion: state.topologyVersion + 1,
      }
    })
  },

  initClipGraph: (clipId, clipName, clipType = 'video') => {
    set((state) => ({
      clipGraphs: { ...state.clipGraphs, [clipId]: createClipGraph(clipName, clipType) },
      topologyVersion: state.topologyVersion + 1,
    }))
  },

  setCompiledChain: (graphLevel, clipId, chain, errors = []) => {
    set((state) => {
      if (graphLevel === 'master') {
        return { masterGraph: { ...state.masterGraph, compiledChain: chain, compileErrors: errors } }
      }
      const graph = state.clipGraphs[clipId]
      if (!graph) return state
      return { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, compiledChain: chain, compileErrors: errors } } }
    })
  },

  moveNode: (graphLevel, clipId, nodeId, position) => {
    get().updateNode(graphLevel, clipId, nodeId, { position })
  },

  toggleBypass: (graphLevel, clipId, nodeId) => {
    const graph = get().getActiveGraph(graphLevel, clipId)
    if (!graph) return
    const node = graph.nodes.find(n => n.id === nodeId)
    if (node) get().updateNode(graphLevel, clipId, nodeId, { bypassed: !node.bypassed })
  },

  createCompoundFromSelection: (graphLevel, clipId, selectedNodeIds, compoundName, color, description) => {
    const state = get()
    const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
    if (!graph) return null

    const result = createCompound(selectedNodeIds, graph.nodes, graph.edges, compoundName, color, description)
    const { compoundNode, updatedEdges, removedNodeIds } = result

    // The selected nodes are relocated into the compound's sub-graph; free the
    // top-level GPU resources they held so they don't orphan (they re-execute
    // inside the compound under namespaced FBO keys).
    for (const id of removedNodeIds) {
      const relocated = graph.nodes.find(n => n.id === id)
      if (relocated) emitNodeRemoved(relocated)
    }

    const newNodes = graph.nodes.filter(n => !removedNodeIds.includes(n.id))
    newNodes.push(compoundNode)
    const newGraph = { ...graph, nodes: newNodes, edges: updatedEdges }

    const libraryEntry = {
      id: compoundNode.id, name: compoundName, version: 1, isUserCreated: true,
      color, description, createdAt: new Date().toISOString(),
      subGraph: JSON.parse(JSON.stringify(compoundNode.subGraph)),
      exposedParams: JSON.parse(JSON.stringify(compoundNode.exposedParams)),
      nodeCount: compoundNode.nodeCount,
    }

    if (graphLevel === 'master') {
      set({ masterGraph: newGraph, compoundLibrary: [...state.compoundLibrary, libraryEntry], topologyVersion: state.topologyVersion + 1 })
    } else {
      set({ clipGraphs: { ...state.clipGraphs, [clipId]: newGraph }, compoundLibrary: [...state.compoundLibrary, libraryEntry], topologyVersion: state.topologyVersion + 1 })
    }
    return compoundNode.id
  },

  updateExposedCompoundParam: (graphLevel, clipId, compoundNodeId, exposedParamIndex, value) => {
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      const nodes = graph.nodes.map(n => {
        if (n.id !== compoundNodeId || n.type !== 'COMPOUND') return n
        return updateExposedParam(n, exposedParamIndex, value)
      })
      // Compound params are baked into the sub-chain at compile time, so changing
      // one needs a recompile to take effect.
      return graphLevel === 'master'
        ? { masterGraph: { ...graph, nodes }, topologyVersion: state.topologyVersion + 1 }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: { ...graph, nodes } }, topologyVersion: state.topologyVersion + 1 }
    })
  },

  expandCompoundNode: (graphLevel, clipId, compoundNodeId) => {
    // Free the compound's GPU resources (recursing its sub-graph) before it's
    // replaced — its inner nodes re-execute at the top level under fresh, un
    // -namespaced FBO keys. Looked up before the set() that rewrites the graph.
    const activeGraph = graphLevel === 'master' ? get().masterGraph : get().clipGraphs[clipId]
    const compoundToFree = activeGraph?.nodes.find(n => n.id === compoundNodeId && n.type === 'COMPOUND') || null
    if (compoundToFree) emitNodeRemoved(compoundToFree)
    set((state) => {
      const graph = graphLevel === 'master' ? state.masterGraph : state.clipGraphs[clipId]
      if (!graph) return state
      const compoundNode = graph.nodes.find(n => n.id === compoundNodeId)
      if (!compoundNode || compoundNode.type !== 'COMPOUND') return state

      const parentEdges = graph.edges.filter(e => e.toNode === compoundNodeId || e.fromNode === compoundNodeId)
      const result = expandCompound(compoundNode, parentEdges)
      if (!result) return state

      const newNodes = graph.nodes.filter(n => n.id !== compoundNodeId)
      newNodes.push(...result.expandedNodes)
      const otherEdges = graph.edges.filter(e => e.toNode !== compoundNodeId && e.fromNode !== compoundNodeId)
      const newEdges = [...otherEdges, ...result.expandedEdges, ...result.updatedParentEdges]
      const newGraph = { ...graph, nodes: newNodes, edges: newEdges }

      return graphLevel === 'master'
        ? { masterGraph: newGraph, topologyVersion: state.topologyVersion + 1 }
        : { clipGraphs: { ...state.clipGraphs, [clipId]: newGraph }, topologyVersion: state.topologyVersion + 1 }
    })
  },
}))

function createClipGraph(clipName = 'Clip', clipType = 'video') {
  const sourceId = newNodeId()
  const outputId = newNodeId()
  const nodes = [
    { id: sourceId, type: 'CLIP_SOURCE', name: `SOURCE: ${clipName}`, position: { x: 50, y: 200 }, params: {}, shaderCode: null, bypassed: false, locked: true },
    { id: outputId, type: 'CLIP_OUTPUT', name: 'OUTPUT', position: { x: 800, y: 200 }, params: {}, shaderCode: null, bypassed: false, locked: true },
  ]
  const edges = []
  const splitterId = newNodeId()
  nodes.push({ id: splitterId, type: 'AUDIO_SPLITTER', name: 'Audio Splitter', position: { x: 300, y: 400 }, params: {}, shaderCode: null, bypassed: false, locked: false })
  edges.push({ id: newEdgeId(), fromNode: sourceId, fromSocket: 'audio_out', toNode: splitterId, toSocket: 'audio_in' })
  if (clipType !== 'audio') {
    edges.push({ id: newEdgeId(), fromNode: sourceId, fromSocket: 'output', toNode: outputId, toSocket: 'input' })
  }
  return { nodes, edges, tapPointNodeId: outputId, compiledChain: [], compileErrors: [] }
}

export default useGraphStore
