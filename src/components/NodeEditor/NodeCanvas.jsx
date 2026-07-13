import { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import { IconChevronDown, IconFitWindow, IconShaderGenerate } from '../common/Icons'
import NodeCard, { NODE_WIDTH } from './NodeCard'
import Noodle, { NoodleDrag, NoodleFilters } from './Noodle'
import NodeSearchMenu from './NodeSearchMenu'
import MonacoDrawer from './MonacoDrawer'
import ActionContextMenu from './ActionContextMenu'
import CompoundNameModal from './CompoundNameModal'
import ShaderGenerator from './ShaderGenerator'
import useGraphStore from '../../store/useGraphStore'
import useAppStore from '../../store/useAppStore'
import useTimelineStore from '../../store/useTimelineStore'
import { topologicalSort, findOrphaned } from '../../utils/topSort'
import { parseParams, getDefaultParams } from '../../utils/paramParser'
import { getShaderSource } from '../../shaders/shaderRegistry'
import { instantiatePreset, instantiateUserCompound } from '../../shaders/compoundPresets'
import { generateCombinedShader } from '../../shaders/shaderGenerator'
import { getNodeSockets, getSocketYOffset, canConnect } from '../../shaders/nodeDefinitions'
import './NodeCanvas.css'

const EXCLUDED_FROM_MARQUEE = new Set([
  'OUTPUT', 'CLIP_OUTPUT', 'EFFECT_OUTPUT',
  'CLIP_SOURCE', 'VIDEO_INPUT', 'CAMERA_INPUT',
  'AUDIO_INPUT', 'AUDIO_SPLITTER',
])

// Node types that ship pre-wired: when added, these Audio Splitter bands are
// auto-connected to the new node's Audio Drivers socket so they react out of the
// box. (The generators used to react via always-live uniforms; now they follow
// the single wire-up model and just get wired automatically on add — visibly, so
// you can unplug them.)
const AUDIO_AUTOWIRE = {
  // Example effects
  AUDIO_WARP: ['bass', 'treble'],
  SPECTRUM_GLOW: ['bass', 'mid', 'treble'],
  // Procedural generators
  BIOMATH: ['bass', 'mid', 'treble'],
  PLASMA: ['bass', 'mid', 'treble'],
  FRACTAL: ['bass', 'mid', 'treble'],
  TUNNEL: ['bass', 'mid', 'treble'],
  GEOMETRIC: ['bass', 'mid', 'treble'],
  LIGHTNING: ['bass', 'mid', 'treble'],
  CRYSTAL: ['bass', 'mid', 'treble'],
  COSMIC: ['bass', 'mid', 'treble'],
  WAVES: ['bass', 'mid', 'treble'],
  SPACE_DISTORTION: ['bass', 'mid', 'treble'],
  // Audio-reactive post effect
  PARTICLE_DISPLACE: ['rms'],
}

// Sample points along a noodle's cubic bezier (same control-point math as
// Noodle.jsx) — used to hit-test "is this wire under the dragged node?".
function sampleBezierPoints(from, to, samples = 24) {
  const dx = Math.abs(to.x - from.x)
  const cp = Math.max(50, dx * 0.4)
  const p1 = { x: from.x + cp, y: from.y }
  const p2 = { x: to.x - cp, y: to.y }
  const pts = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const mt = 1 - t
    pts.push({
      x: mt * mt * mt * from.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * to.x,
      y: mt * mt * mt * from.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * to.y,
    })
  }
  return pts
}

export default function NodeCanvas({ collapsed, onToggleCollapse }) {
  const containerRef = useRef(null)
  const graphLevel = useAppStore(s => s.graphLevel)
  const graphClipId = useAppStore(s => s.graphClipId)
  const selectedNodeId = useAppStore(s => s.selectedNodeId)
  const selectedNodeIds = useAppStore(s => s.selectedNodeIds)
  const selectNode = useAppStore(s => s.selectNode)
  const clearSelection = useAppStore(s => s.clearSelection)
  const clearNodeSelection = useAppStore(s => s.clearNodeSelection)
  const setSelectedNodeIds = useAppStore(s => s.setSelectedNodeIds)
  const exitClipGraph = useAppStore(s => s.exitClipGraph)
  const openMonaco = useAppStore(s => s.openMonaco)
  const enterCompound = useAppStore(s => s.enterCompound)
  const previewThroughMaster = useAppStore(s => s.previewThroughMaster)
  const togglePreviewThroughMaster = useAppStore(s => s.togglePreviewThroughMaster)

  const masterGraph = useGraphStore(s => s.masterGraph)
  const clipGraphs = useGraphStore(s => s.clipGraphs)
  const compoundLibrary = useGraphStore(s => s.compoundLibrary)
  const addNode = useGraphStore(s => s.addNode)
  const removeNode = useGraphStore(s => s.removeNode)
  const updateNode = useGraphStore(s => s.updateNode)
  const setNodeParam = useGraphStore(s => s.setNodeParam)
  const addEdge = useGraphStore(s => s.addEdge)
  const removeEdge = useGraphStore(s => s.removeEdge)
  const setTapPoint = useGraphStore(s => s.setTapPoint)
  const createCompoundFromSelection = useGraphStore(s => s.createCompoundFromSelection)
  const updateExposedCompoundParam = useGraphStore(s => s.updateExposedCompoundParam)

  const graph = graphLevel === 'master' ? masterGraph : (clipGraphs[graphClipId] || masterGraph)

  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [showSearchMenu, setShowSearchMenu] = useState(false)
  const [searchMenuPos, setSearchMenuPos] = useState({ x: 0, y: 0 })
  const [dragNoodle, setDragNoodle] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  // Ctrl+drag-a-node-over-a-wire auto-insert (Blender-style): the candidate edge
  // is highlighted live and spliced on release. Ref mirrors state so the mouseup
  // handler (registered once per drag) always sees the latest target.
  const [insertTarget, setInsertTarget] = useState(null)
  const insertTargetRef = useRef(null)
  const [marquee, setMarquee] = useState(null)
  const [showActionMenu, setShowActionMenu] = useState(false)
  const [actionMenuPos, setActionMenuPos] = useState({ x: 0, y: 0 })
  const [showCompoundModal, setShowCompoundModal] = useState(false)
  const [showShaderGenerator, setShowShaderGenerator] = useState(false)
  const marqueeMousePos = useRef({ x: 0, y: 0 })
  const isPanning = useRef(false)
  const lastPanPos = useRef({ x: 0, y: 0 })

  const outputNode = graph.nodes.find(n => n.type === 'OUTPUT' || n.type === 'CLIP_OUTPUT' || n.type === 'EFFECT_OUTPUT')
  // Active preview tap, but only when it points at a real upstream node. The tap
  // defaults to the OUTPUT node (= "no override"), which should never read as a
  // special preview state in the UI.
  const previewTapId = (graph.tapPointNodeId && graph.tapPointNodeId !== outputNode?.id)
    ? graph.tapPointNodeId
    : null
  const previewTapNode = previewTapId ? graph.nodes.find(n => n.id === previewTapId) : null
  const { sorted } = useMemo(() => topologicalSort(graph.nodes, graph.edges), [graph.nodes, graph.edges])
  const orphanedNodes = useMemo(
    () => outputNode ? findOrphaned(graph.nodes, graph.edges, outputNode.id) : new Set(),
    [graph.nodes, graph.edges, outputNode]
  )

  const timelineClips = useTimelineStore(s => s.clips)

  const nodeParamConfigs = useMemo(() => {
    const map = {}
    for (const node of graph.nodes) {
      const shaderSrc = node.customShaderSource || node.shaderCode || getShaderSource(node.type)
      let params = shaderSrc ? parseParams(shaderSrc) : []
      if (node.type === 'AUDIO_INPUT') {
        const audioClips = timelineClips.filter(c => c.fileType === 'audio').map(c => c.filename)
        const uniqueAudioClips = [...new Set(audioClips)]
        params.push({ name: 'Audio Source', uniformName: 'audioSource', type: 'select', options: ['Timeline', ...uniqueAudioClips], default: 'Timeline' })
      }
      map[node.id] = params
    }
    for (const node of graph.nodes) {
      if (node.type === 'MATH' && !map[node.id]?.length) {
        map[node.id] = [
          { name: 'Operation', uniformName: 'operation', type: 'select', options: ['Add', 'Subtract', 'Multiply', 'Divide', 'Sine', 'Cosine', 'Absolute', 'Min', 'Max', 'Greater Than', 'Less Than'], default: 0 },
          { name: 'Value A', uniformName: 'value_a', type: 'slider', min: -100, max: 100, step: 0.01, default: 0 },
          { name: 'Value B', uniformName: 'value_b', type: 'slider', min: -100, max: 100, step: 0.01, default: 1 },
        ]
      }
      // ENVELOPE is shaderless (CPU float processor, like MATH): attack/release
      // smoothing + gate + gain over any float signal wired into it.
      if (node.type === 'ENVELOPE' && !map[node.id]?.length) {
        map[node.id] = [
          { name: 'Attack', uniformName: 'attack', type: 'slider', min: 0.001, max: 1, step: 0.001, default: 0.05 },
          { name: 'Release', uniformName: 'release', type: 'slider', min: 0.01, max: 2, step: 0.01, default: 0.35 },
          { name: 'Threshold', uniformName: 'threshold', type: 'slider', min: 0, max: 0.95, step: 0.01, default: 0 },
          { name: 'Gain', uniformName: 'gain', type: 'slider', min: 0, max: 4, step: 0.05, default: 1 },
        ]
      }
      // TRANSITION_PROGRESS is shaderless (CPU float source). The preview
      // controls only drive its output while no clip transition is running, so
      // a transition compound can be authored and watched live in the editor.
      if (node.type === 'TRANSITION_PROGRESS' && !map[node.id]?.length) {
        map[node.id] = [
          { name: 'Auto Preview', uniformName: 'auto_preview', type: 'checkbox', default: true },
          { name: 'Preview', uniformName: 'preview', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5 },
          { name: 'Preview Speed', uniformName: 'preview_speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.25 },
        ]
      }
    }
    return map
  }, [graph.nodes, timelineClips])

  const { connectedInputsMap, connectedOutputsMap } = useMemo(() => {
    const inMap = {}
    const outMap = {}
    for (const node of graph.nodes) {
      inMap[node.id] = new Set()
      outMap[node.id] = new Set()
    }
    for (const edge of graph.edges) {
      if (inMap[edge.toNode]) inMap[edge.toNode].add(edge.toSocket)
      if (outMap[edge.fromNode]) outMap[edge.fromNode].add(edge.fromSocket)
    }
    return { connectedInputsMap: inMap, connectedOutputsMap: outMap }
  }, [graph.nodes, graph.edges])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.92 : 1.08
    const next = Math.min(4, Math.max(0.1, zoom * factor))
    if (next === zoom) return
    // Zoom around the cursor: keep the graph point under the mouse stationary.
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setPan({
        x: mx - ((mx - pan.x) / zoom) * next,
        y: my - ((my - pan.y) / zoom) * next,
      })
    }
    setZoom(next)
  }, [zoom, pan])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Pan / Marquee ──
  const handleMouseDown = useCallback((e) => {
    const isGrid = e.target === containerRef.current?.querySelector('.node-canvas__grid')

    if (e.button === 1 || (e.button === 0 && isGrid && !e.ctrlKey && !e.altKey)) {
      // Middle-click or plain left-click on grid -> pan
      isPanning.current = true
      lastPanPos.current = { x: e.clientX, y: e.clientY }
      e.preventDefault()
    } else if (e.button === 0 && isGrid && e.ctrlKey) {
      // Ctrl+left-click on grid -> start marquee selection
      const rect = containerRef.current.getBoundingClientRect()
      const graphX = (e.clientX - rect.left - pan.x) / zoom
      const graphY = (e.clientY - rect.top - pan.y) / zoom
      setMarquee({ startX: graphX, startY: graphY, endX: graphX, endY: graphY })
      marqueeMousePos.current = { x: e.clientX, y: e.clientY }
      e.preventDefault()
    }
  }, [pan, zoom])

  const handleMouseMove = useCallback((e) => {
    if (isPanning.current) {
      const dx = e.clientX - lastPanPos.current.x
      const dy = e.clientY - lastPanPos.current.y
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }))
      lastPanPos.current = { x: e.clientX, y: e.clientY }
    }
    if (marquee) {
      const rect = containerRef.current.getBoundingClientRect()
      const graphX = (e.clientX - rect.left - pan.x) / zoom
      const graphY = (e.clientY - rect.top - pan.y) / zoom
      setMarquee(prev => ({ ...prev, endX: graphX, endY: graphY }))
      marqueeMousePos.current = { x: e.clientX, y: e.clientY }
    }
    if (dragNoodle) {
      const rect = containerRef.current.getBoundingClientRect()
      setDragNoodle(prev => ({
        ...prev,
        toX: (e.clientX - rect.left - pan.x) / zoom,
        toY: (e.clientY - rect.top - pan.y) / zoom,
      }))
    }
  }, [marquee, dragNoodle, pan, zoom])

  const handleMouseUp = useCallback(() => {
    isPanning.current = false

    if (marquee) {
      // Compute which nodes intersect the marquee
      const marqueeLeft = Math.min(marquee.startX, marquee.endX)
      const marqueeRight = Math.max(marquee.startX, marquee.endX)
      const marqueeTop = Math.min(marquee.startY, marquee.endY)
      const marqueeBottom = Math.max(marquee.startY, marquee.endY)

      const selected = []
      for (const node of graph.nodes) {
        if (EXCLUDED_FROM_MARQUEE.has(node.type) || node.locked) continue
        const nodeLeft = node.position.x
        const nodeRight = node.position.x + NODE_WIDTH
        const nodeTop = node.position.y
        // Estimate card height: header(30) + sockets + params
        const paramCount = nodeParamConfigs[node.id]?.length || 0
        const socketCount = Math.max(
          getNodeSockets(node.type, nodeParamConfigs[node.id] || [], node).inputs.filter(s => !s.isParam).length,
          getNodeSockets(node.type, nodeParamConfigs[node.id] || [], node).outputs.length
        )
        const nodeBottom = node.position.y + 30 + socketCount * 22 + paramCount * 26 + 40

        // Any intersection counts
        if (nodeLeft < marqueeRight && nodeRight > marqueeLeft && nodeTop < marqueeBottom && nodeBottom > marqueeTop) {
          selected.push(node.id)
        }
      }

      if (selected.length > 0) {
        setSelectedNodeIds(selected)
        setActionMenuPos({ x: marqueeMousePos.current.x, y: marqueeMousePos.current.y })
        setShowActionMenu(true)
      } else {
        clearNodeSelection()
      }
      setMarquee(null)
      return
    }

    if (dragNoodle) {
      setDragNoodle(null)
    }
  }, [marquee, dragNoodle, graph.nodes, nodeParamConfigs, setSelectedNodeIds, clearNodeSelection])

  // Finalize pan/marquee/noodle on release ANYWHERE — not just over the canvas.
  // Node cards stopPropagation on mouseup, so a release over a node never reached
  // the container handler; the marquee menu only appeared when the cursor left
  // the canvas. Listening on window fixes that, and a keyup on Ctrl/Meta lets the
  // box-select finish (and open the action menu) the moment EITHER the mouse OR
  // the modifier key is released.
  const handleMouseUpRef = useRef(handleMouseUp)
  useEffect(() => { handleMouseUpRef.current = handleMouseUp }, [handleMouseUp])
  useEffect(() => {
    const onUp = () => handleMouseUpRef.current()
    const onKeyUp = (e) => {
      if (e.key === 'Control' || e.key === 'Meta') handleMouseUpRef.current()
    }
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ── Actions from context menu ──
  const handleCopySelectedNodes = useCallback(() => {
    const selected = new Set(selectedNodeIds)
    const nodeIdMap = {}
    for (const nodeId of selectedNodeIds) {
      const node = graph.nodes.find(n => n.id === nodeId)
      if (!node) continue
      const newId = addNode(graphLevel, graphClipId, {
        ...JSON.parse(JSON.stringify(node)),
        position: { x: node.position.x + 30, y: node.position.y + 30 },
      })
      nodeIdMap[nodeId] = newId
    }
    for (const edge of graph.edges) {
      if (selected.has(edge.fromNode) && selected.has(edge.toNode)) {
        addEdge(graphLevel, graphClipId,
          nodeIdMap[edge.fromNode], edge.fromSocket,
          nodeIdMap[edge.toNode], edge.toSocket)
      }
    }
    setSelectedNodeIds(Object.values(nodeIdMap))
    setShowActionMenu(false)
  }, [selectedNodeIds, graph, addNode, addEdge, graphLevel, graphClipId, setSelectedNodeIds])

  const handleCreateCompound = useCallback(() => {
    setShowActionMenu(false)
    setShowCompoundModal(true)
  }, [])

  const handleCompoundConfirm = useCallback((name, description, color) => {
    setShowCompoundModal(false)
    createCompoundFromSelection(graphLevel, graphClipId, selectedNodeIds, name, color, description)
    clearNodeSelection()
  }, [graphLevel, graphClipId, selectedNodeIds, createCompoundFromSelection, clearNodeSelection])

  // ── Context Menu (right-click) ──
  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    if (showActionMenu) {
      setShowActionMenu(false)
      return
    }
    setSearchMenuPos({ x: e.clientX, y: e.clientY })
    setShowSearchMenu(true)
  }, [showActionMenu])

  // Auto-wire the Audio Splitter's bands into a freshly-added example node's
  // Audio Drivers socket, so the pre-wired examples react out of the box.
  const autoWireAudioDrivers = useCallback((type, newId) => {
    const bands = AUDIO_AUTOWIRE[type]
    if (!bands || !newId) return
    const g = useGraphStore.getState().getActiveGraph(graphLevel, graphClipId)
    const splitter = g?.nodes?.find(n => n.type === 'AUDIO_SPLITTER')
    if (!splitter) return
    for (const band of bands) {
      addEdge(graphLevel, graphClipId, splitter.id, band, newId, 'audio_drivers')
    }
  }, [addEdge, graphLevel, graphClipId])

  // ── Add Node ──
  const handleAddNode = useCallback((nodeType) => {
    setShowSearchMenu(false)

    const rect = containerRef.current?.getBoundingClientRect()
    const x = rect ? (searchMenuPos.x - rect.left - pan.x) / zoom : 200
    const y = rect ? (searchMenuPos.y - rect.top - pan.y) / zoom : 200

    if (nodeType.type === 'USER_COMPOUND') {
      const entry = compoundLibrary.find(c => c.id === nodeType.compoundId)
      if (entry) {
        instantiateUserCompound(
          entry, addNode, addEdge, graphLevel, graphClipId, { x, y },
          nodeParamConfigs
        )
      }
      return
    }

    // Preset chain from the menu — instantiate at the cursor and auto-wire its
    // audio-driven nodes to the active graph's Audio Splitter.
    if (nodeType.isPreset || nodeType.type === 'PRESET') {
      const activeGraph = useGraphStore.getState().getActiveGraph(graphLevel, graphClipId)
      const splitterId = activeGraph?.nodes?.find(n => n.type === 'AUDIO_SPLITTER')?.id || null
      instantiatePreset(nodeType.presetId, addNode, addEdge, graphLevel, graphClipId, { x, y }, splitterId)
      return
    }

    const shaderCode = getShaderSource(nodeType.type)
    const paramConfigs = shaderCode ? parseParams(shaderCode) : []
    const defaultParams = getDefaultParams(paramConfigs)

    const newId = addNode(graphLevel, graphClipId, {
      type: nodeType.type, name: nodeType.name,
      position: { x, y }, params: defaultParams,
      shaderCode: nodeType.type === 'CUSTOM' ? shaderCode : null,
    })
    autoWireAudioDrivers(nodeType.type, newId)
  }, [addNode, addEdge, autoWireAudioDrivers, graphLevel, graphClipId, searchMenuPos, pan, zoom, compoundLibrary, nodeParamConfigs])

  // ── Drag and Drop ──
  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropTarget('canvas')
  }, [])

  const handleDragEnter = useCallback((e) => {
    e.preventDefault()
    setDropTarget('canvas')
  }, [])

  const handleDragLeave = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      const { clientX: x, clientY: y } = e
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        setDropTarget(null)
      }
    }
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDropTarget(null)
    const raw = e.dataTransfer.getData('application/dalivid-drag')
    if (!raw) return
    let payload
    try { payload = JSON.parse(raw) } catch { return }
    const rect = containerRef.current?.getBoundingClientRect()
    const x = rect ? (e.clientX - rect.left - pan.x) / zoom : 200
    const y = rect ? (e.clientY - rect.top - pan.y) / zoom : 200
    const basePos = { x, y }

    if (payload.kind === 'preset') {
      // Hand the active graph's Audio Splitter to the preset so its `audioWire`
      // nodes are auto-connected and reactive on drop.
      const activeGraph = useGraphStore.getState().getActiveGraph(graphLevel, graphClipId)
      const splitterId = activeGraph?.nodes?.find(n => n.type === 'AUDIO_SPLITTER')?.id || null
      instantiatePreset(payload.presetId, addNode, addEdge, graphLevel, graphClipId, basePos, splitterId)
    } else if (payload.kind === 'node') {
      const shaderCode = getShaderSource(payload.nodeType)
      const paramConfigs = shaderCode ? parseParams(shaderCode) : []
      const defaultParams = getDefaultParams(paramConfigs)
      // An image card dropped from the Media Pool carries its data URL — preload
      // it onto the new IMAGE_INPUT node so it renders immediately.
      if (payload.imageSrc) {
        defaultParams.imageSrc = payload.imageSrc
        defaultParams.imageName = payload.imageName || payload.name || ''
      }
      const newId = addNode(graphLevel, graphClipId, {
        type: payload.nodeType, name: payload.name, position: basePos,
        params: defaultParams, shaderCode: payload.nodeType === 'CUSTOM' ? shaderCode : null,
      })
      autoWireAudioDrivers(payload.nodeType, newId)
    }
  }, [addNode, addEdge, autoWireAudioDrivers, graphLevel, graphClipId, pan, zoom])

  // ── Shader Generator ──
  const handleShaderGenerate = useCallback((effectNodes, customName) => {
    if (effectNodes.length === 0) return

    const name = customName?.trim() || 'Generated Shader'
    const effectTypes = effectNodes.map(n => n.type)
    const generatedShaderCode = generateCombinedShader(effectTypes, name)
    const paramConfigs = parseParams(generatedShaderCode)
    const defaultParams = getDefaultParams(paramConfigs)

    const rect = containerRef.current?.getBoundingClientRect()
    const x = rect ? (searchMenuPos.x - rect.left - pan.x) / zoom : 200
    const y = rect ? (searchMenuPos.y - rect.top - pan.y) / zoom : 200

    addNode(graphLevel, graphClipId, {
      type: 'CUSTOM',
      name: name,
      position: { x, y },
      params: defaultParams,
      shaderCode: generatedShaderCode,
      customShaderSource: generatedShaderCode,
    })
  }, [addNode, graphLevel, graphClipId, searchMenuPos, pan, zoom])

  // ── Node interactions ──
  // (handleNodeMove / handleNodeMoveEnd are defined after getSocketPos below —
  // they hit-test wires for the Ctrl+drag auto-insert.)

  const handleNodeDelete = useCallback((nodeId) => {
    removeNode(graphLevel, graphClipId, nodeId)
  }, [removeNode, graphLevel, graphClipId])

  const handleParamChange = useCallback((nodeId, paramName, value) => {
    setNodeParam(graphLevel, graphClipId, nodeId, paramName, value)
  }, [setNodeParam, graphLevel, graphClipId])

  const handleCompoundExposedParamChange = useCallback((nodeId, exposedParamIndex, value) => {
    updateExposedCompoundParam(graphLevel, graphClipId, nodeId, exposedParamIndex, value)
  }, [updateExposedCompoundParam, graphLevel, graphClipId])

  const handleNodeDuplicate = useCallback((nodeId) => {
    const node = graph.nodes.find(n => n.id === nodeId)
    if (!node) return null
    const nodeData = {
      type: node.type,
      name: node.name.endsWith(' (Copy)') ? node.name : `${node.name} (Copy)`,
      position: { x: node.position.x, y: node.position.y },
      params: JSON.parse(JSON.stringify(node.params || {})),
      shaderCode: node.shaderCode || null,
      audioBindings: JSON.parse(JSON.stringify(node.audioBindings || {})),
      bypassed: node.bypassed || false,
    }
    const newId = addNode(graphLevel, graphClipId, nodeData)
    selectNode(newId)
    return newId
  }, [graph.nodes, addNode, graphLevel, graphClipId, selectNode])

  const handleSetPreview = useCallback((nodeId) => {
    // Toggle semantics (standard "viewer tap"): tapping a node previews its
    // output; tapping the already-active node — or any OUTPUT node — reverts the
    // view to the graph's OUTPUT node.
    const outputId = outputNode?.id ?? null
    const isOutput = nodeId === outputId
    const next = (isOutput || graph.tapPointNodeId === nodeId) ? outputId : nodeId
    setTapPoint(graphLevel, graphClipId, next)
  }, [outputNode, graph.tapPointNodeId, setTapPoint, graphLevel, graphClipId])

  const handleDetachNode = useCallback((nodeId) => {
    const currentGraph = graph
    const incomingEdges = currentGraph.edges.filter(e => e.toNode === nodeId)
    const outgoingEdges = currentGraph.edges.filter(e => e.fromNode === nodeId)
    for (const inEdge of incomingEdges) {
      const upstreamNodeId = inEdge.fromNode
      const upstreamSocketId = inEdge.fromSocket
      const upstreamNode = currentGraph.nodes.find(n => n.id === upstreamNodeId)
      if (!upstreamNode) continue
      const upParams = nodeParamConfigs[upstreamNodeId] || []
      const upSockets = getNodeSockets(upstreamNode.type, upParams, upstreamNode)
      const upstreamSocket = upSockets.outputs.find(s => s.id === upstreamSocketId)
      const upstreamType = upstreamSocket?.type || 'texture'
      const compatibleOut = outgoingEdges.find(outE => {
        const downNode = currentGraph.nodes.find(n => n.id === outE.toNode)
        if (!downNode) return false
        const downParams = nodeParamConfigs[outE.toNode] || []
        const downSockets = getNodeSockets(downNode.type, downParams, downNode)
        const downSocket = downSockets.inputs.find(s => s.id === outE.toSocket)
        const downType = downSocket?.type || 'texture'
        return downType === upstreamType
      })
      if (compatibleOut) {
        addEdge(graphLevel, graphClipId, upstreamNodeId, upstreamSocketId, compatibleOut.toNode, compatibleOut.toSocket)
      }
    }
    for (const edge of [...incomingEdges, ...outgoingEdges]) {
      removeEdge(graphLevel, graphClipId, edge.id)
    }
    removeNode(graphLevel, graphClipId, nodeId)
  }, [graph, nodeParamConfigs, addEdge, removeEdge, removeNode, graphLevel, graphClipId])

  const getSocketPos = useCallback((nodeId, socketId, socketSide) => {
    const node = graph.nodes.find(n => n.id === nodeId)
    if (!node) return { x: 0, y: 0 }
    const domCircle = containerRef.current?.querySelector(
      `.socket[data-node-id="${nodeId}"][data-socket-id="${socketId}"] .socket__circle`
    )
    if (domCircle) {
      const rect = domCircle.getBoundingClientRect()
      const containerRect = containerRef.current.getBoundingClientRect()
      const x = (rect.left + rect.width / 2 - containerRect.left - pan.x) / zoom
      const y = (rect.top + rect.height / 2 - containerRect.top - pan.y) / zoom
      return { x, y }
    }
    const params = nodeParamConfigs[nodeId] || []
    const { inputs, outputs } = getNodeSockets(node.type, params, node)
    const sockets = socketSide === 'output' ? outputs : inputs
    const fixedSockets = inputs.filter(s => !s.isParam)
    const paramSockets = inputs.filter(s => s.isParam)
    let socketIndex
    if (socketSide === 'output') {
      socketIndex = sockets.findIndex(s => s.id === socketId)
    } else {
      const fixedIdx = fixedSockets.findIndex(s => s.id === socketId)
      if (fixedIdx >= 0) {
        socketIndex = fixedIdx
      } else {
        const paramIdx = paramSockets.findIndex(s => s.id === socketId)
        if (paramIdx >= 0) {
          const fixedSocketsHeight = fixedSockets.length * 22
          const paramStartOffset = 30 + 14 + fixedSocketsHeight + 40 + 18
          const y = node.position.y + paramStartOffset + paramIdx * 26
          return { x: node.position.x, y }
        }
        socketIndex = 0
      }
    }
    if (socketIndex < 0) socketIndex = 0
    const y = node.position.y + getSocketYOffset(socketIndex, sockets.length)
    const x = socketSide === 'output' ? node.position.x + NODE_WIDTH : node.position.x
    return { x, y }
  }, [graph.nodes, nodeParamConfigs, pan, zoom])

  // ── Ctrl+drag auto-insert (Blender-style) ──
  // While Ctrl is held during a node drag, find a wire passing under the node
  // whose data type the node can splice into (a matching input AND output).
  // Prefers a free input; falls back to the first matching one (addEdge replaces
  // the old connection on single-accept sockets).
  const findInsertCandidate = useCallback((nodeId, position) => {
    const node = graph.nodes.find(n => n.id === nodeId)
    if (!node || node.locked) return null
    const params = nodeParamConfigs[nodeId] || []
    const { inputs, outputs } = getNodeSockets(node.type, params, node)
    if (inputs.length === 0 || outputs.length === 0) return null

    // Approximate the card's bounding box (same estimate as the marquee).
    const socketCount = Math.max(inputs.filter(s => !s.isParam).length, outputs.length)
    const height = 30 + socketCount * 22 + params.length * 26 + 40
    const box = { left: position.x, right: position.x + NODE_WIDTH, top: position.y, bottom: position.y + height }
    const cx = position.x + NODE_WIDTH / 2
    const cy = position.y + height / 2

    // Reject splices that would create a cycle: never target a wire whose
    // source is downstream of the dragged node (fromNode→node would close a
    // loop), nor one whose destination is upstream of it (node→toNode would).
    const downstream = new Set()
    const upstream = new Set()
    const downStack = [nodeId]
    while (downStack.length) {
      const id = downStack.pop()
      for (const e of graph.edges) {
        if (e.fromNode === id && !downstream.has(e.toNode)) { downstream.add(e.toNode); downStack.push(e.toNode) }
      }
    }
    const upStack = [nodeId]
    while (upStack.length) {
      const id = upStack.pop()
      for (const e of graph.edges) {
        if (e.toNode === id && !upstream.has(e.fromNode)) { upstream.add(e.fromNode); upStack.push(e.fromNode) }
      }
    }

    let best = null
    for (const edge of graph.edges) {
      if (edge.fromNode === nodeId || edge.toNode === nodeId) continue
      if (downstream.has(edge.fromNode) || upstream.has(edge.toNode)) continue
      const fromNode = graph.nodes.find(n => n.id === edge.fromNode)
      if (!fromNode) continue
      const fromSockets = getNodeSockets(fromNode.type, nodeParamConfigs[edge.fromNode] || [], fromNode)
      const dataType = fromSockets.outputs.find(s => s.id === edge.fromSocket)?.type || 'texture'

      const outSocket = outputs.find(s => s.type === dataType)
      if (!outSocket) continue
      const inCandidates = inputs.filter(s => s.type === dataType)
      if (inCandidates.length === 0) continue
      const inSocket = inCandidates.find(s => !connectedInputsMap[nodeId]?.has(s.id)) || inCandidates[0]

      const from = getSocketPos(edge.fromNode, edge.fromSocket, 'output')
      const to = getSocketPos(edge.toNode, edge.toSocket, 'input')
      let minDist = Infinity
      for (const pt of sampleBezierPoints(from, to)) {
        if (pt.x >= box.left && pt.x <= box.right && pt.y >= box.top && pt.y <= box.bottom) {
          minDist = Math.min(minDist, Math.hypot(pt.x - cx, pt.y - cy))
        }
      }
      if (minDist < Infinity && (!best || minDist < best.dist)) {
        best = { edgeId: edge.id, inputSocketId: inSocket.id, outputSocketId: outSocket.id, dist: minDist }
      }
    }
    return best
  }, [graph.nodes, graph.edges, nodeParamConfigs, connectedInputsMap, getSocketPos])

  // Only re-render when the highlighted edge changes; keep the ref fresh always.
  const applyInsertTarget = useCallback((target) => {
    const prevEdgeId = insertTargetRef.current?.edgeId || null
    insertTargetRef.current = target
    if ((target?.edgeId || null) !== prevEdgeId) setInsertTarget(target)
  }, [])

  const handleNodeMove = useCallback((nodeId, position, e) => {
    updateNode(graphLevel, graphClipId, nodeId, { position })
    if (e && (e.ctrlKey || e.metaKey)) {
      applyInsertTarget(findInsertCandidate(nodeId, position))
    } else if (insertTargetRef.current) {
      applyInsertTarget(null)
    }
  }, [updateNode, graphLevel, graphClipId, findInsertCandidate, applyInsertTarget])

  const handleNodeMoveEnd = useCallback((nodeId) => {
    const target = insertTargetRef.current
    if (!target) return
    applyInsertTarget(null)
    const edge = graph.edges.find(e => e.id === target.edgeId)
    if (!edge) return
    // Splice: upstream → node input, node output → downstream.
    removeEdge(graphLevel, graphClipId, edge.id)
    addEdge(graphLevel, graphClipId, edge.fromNode, edge.fromSocket, nodeId, target.inputSocketId)
    addEdge(graphLevel, graphClipId, nodeId, target.outputSocketId, edge.toNode, edge.toSocket)
  }, [graph.edges, removeEdge, addEdge, graphLevel, graphClipId, applyInsertTarget])

  const handleSocketDragStart = useCallback((socketInfo) => {
    if (socketInfo.type === 'output') {
      const node = graph.nodes.find(n => n.id === socketInfo.nodeId)
      if (!node) return
      const pos = getSocketPos(socketInfo.nodeId, socketInfo.socketId, 'output')
      setDragNoodle({
        fromNodeId: socketInfo.nodeId, fromSocketId: socketInfo.socketId,
        fromX: pos.x, fromY: pos.y, toX: pos.x + 50, toY: pos.y,
        dataType: socketInfo.dataType,
      })
    } else if (socketInfo.type === 'input') {
      const edge = graph.edges.find(e => e.toNode === socketInfo.nodeId && e.toSocket === socketInfo.socketId)
      if (!edge) return
      const fromNodeId = edge.fromNode
      const fromSocketId = edge.fromSocket
      const pos = getSocketPos(fromNodeId, fromSocketId, 'output')
      removeEdge(graphLevel, graphClipId, edge.id)
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = socketInfo.event ? socketInfo.event.clientX : pos.x + 50
      const mouseY = socketInfo.event ? socketInfo.event.clientY : pos.y
      setDragNoodle({
        fromNodeId, fromSocketId, fromX: pos.x, fromY: pos.y,
        toX: (mouseX - rect.left - pan.x) / zoom,
        toY: (mouseY - rect.top - pan.y) / zoom,
        dataType: socketInfo.dataType,
      })
    }
  }, [graph.nodes, graph.edges, getSocketPos, removeEdge, graphLevel, graphClipId, pan, zoom])

  const handleSocketDragEnd = useCallback((socketInfo) => {
    if (dragNoodle && dragNoodle.fromNodeId !== socketInfo.nodeId) {
      if (canConnect(dragNoodle.dataType, socketInfo.dataType)) {
        addEdge(graphLevel, graphClipId, dragNoodle.fromNodeId, dragNoodle.fromSocketId, socketInfo.nodeId, socketInfo.socketId)
      }
    }
    setDragNoodle(null)
  }, [dragNoodle, addEdge, graphLevel, graphClipId])

  const fitToWindow = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || graph.nodes.length === 0) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    // Frame every node (with padding) instead of just resetting the view.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const node of graph.nodes) {
      const params = nodeParamConfigs[node.id] || []
      const { inputs, outputs } = getNodeSockets(node.type, params, node)
      const socketCount = Math.max(inputs.filter(s => !s.isParam).length, outputs.length)
      const height = 30 + socketCount * 22 + params.length * 26 + 40
      minX = Math.min(minX, node.position.x)
      minY = Math.min(minY, node.position.y)
      maxX = Math.max(maxX, node.position.x + NODE_WIDTH)
      maxY = Math.max(maxY, node.position.y + height)
    }
    const PAD = 60
    const w = maxX - minX + PAD * 2
    const h = maxY - minY + PAD * 2
    const z = Math.min(1.5, Math.max(0.1, Math.min(rect.width / w, rect.height / h)))
    setZoom(z)
    setPan({
      x: rect.width / 2 - ((minX + maxX) / 2) * z,
      y: rect.height / 2 - ((minY + maxY) / 2) * z,
    })
  }, [graph.nodes, nodeParamConfigs])

  const handleCanvasClick = useCallback((e) => {
    if (e.target === containerRef.current?.querySelector('.node-canvas__grid')) {
      clearSelection()
      clearNodeSelection()
      setShowActionMenu(false)
    }
  }, [clearSelection, clearNodeSelection])

  const handleEdgeDelete = useCallback((edgeId) => {
    removeEdge(graphLevel, graphClipId, edgeId)
  }, [removeEdge, graphLevel, graphClipId])

  const handleExpandCompound = useCallback((nodeId) => {
    useGraphStore.getState().expandCompoundNode(graphLevel, graphClipId, nodeId)
  }, [graphLevel, graphClipId])

  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = e.target.tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable
      if (isInput) return

      // Alt is our duplicate modifier (Alt+drag a node). On its own, the browser
      // gives Alt to the Windows menu bar, stealing focus. Suppress that default
      // so Alt stays available as a node-editor modifier. (AltGr typing happens
      // in inputs, which already returned above.)
      if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD' && selectedNodeId) {
        e.preventDefault()
        const node = graph.nodes.find(n => n.id === selectedNodeId)
        if (node && !node.locked) {
          const nodeData = {
            type: node.type,
            name: node.name.endsWith(' (Copy)') ? node.name : `${node.name} (Copy)`,
            position: { x: node.position.x + 30, y: node.position.y + 30 },
            params: JSON.parse(JSON.stringify(node.params || {})),
            shaderCode: node.shaderCode || null,
            audioBindings: JSON.parse(JSON.stringify(node.audioBindings || {})),
            bypassed: node.bypassed || false,
          }
          const newId = addNode(graphLevel, graphClipId, nodeData)
          selectNode(newId)
        }
      }
      if ((e.code === 'Delete' || e.code === 'Backspace') && selectedNodeId) {
        const node = graph.nodes.find(n => n.id === selectedNodeId)
        if (node && !node.locked) {
          e.preventDefault()
          removeNode(graphLevel, graphClipId, selectedNodeId)
          clearSelection()
        }
      }
      if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        fitToWindow()
      }
      if (e.code === 'Escape' && selectedNodeIds.length > 0) {
        clearNodeSelection()
        setShowActionMenu(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedNodeIds, graph.nodes, addNode, removeNode, graphLevel, graphClipId, selectNode, clearSelection, clearNodeSelection, fitToWindow])

  return (
    <>
      <div className="panel__header" onDoubleClick={onToggleCollapse}>
        <button className={`panel__collapse-btn ${collapsed ? 'panel__collapse-btn--collapsed' : ''}`} onClick={onToggleCollapse}>
          <IconChevronDown />
        </button>
        <span className="panel__header-title">
          {graphLevel === 'master'
            ? 'Master Effect Graph'
            : `Effect Graph: ${graph.nodes.find(n => n.type === 'CLIP_SOURCE')?.name || 'Clip'}`
          }
        </span>
        {graphLevel === 'clip' && (
          <button className="node-canvas__back-btn" onClick={exitClipGraph}>
            ↩ Back to Master
          </button>
        )}
        <div style={{ flex: 1 }} />
        {graphLevel === 'clip' && (
          <button
            className={`node-canvas__masterfx-toggle ${previewThroughMaster ? 'node-canvas__masterfx-toggle--on' : ''}`}
            onClick={togglePreviewThroughMaster}
            data-tooltip={previewThroughMaster
              ? 'Preview is routed through the Master FX chain — click to show the raw, isolated clip'
              : 'Preview shows the clip in isolation — click to apply the Master FX chain'}
          >
            Master FX: {previewThroughMaster ? 'On' : 'Off'}
          </button>
        )}
        {previewTapId && (
          <button
            className="node-canvas__preview-reset"
            onClick={() => setTapPoint(graphLevel, graphClipId, outputNode?.id ?? null)}
            data-tooltip="Stop previewing this node — show the Output again"
          >
            <span className="node-canvas__preview-reset-eye">👁</span>
            <span className="node-canvas__preview-reset-label">
              Previewing: {previewTapNode?.name || previewTapNode?.type || 'node'}
            </span>
            <span className="node-canvas__preview-reset-x">✕</span>
          </button>
        )}
        <button
          className={`panel__header-btn ${showShaderGenerator ? 'panel__header-btn--active' : ''}`}
          onClick={() => setShowShaderGenerator(!showShaderGenerator)}
          data-tooltip="Shader Generator"
        >
          <IconShaderGenerate />
        </button>
        <button className="panel__header-btn" onClick={fitToWindow} data-tooltip="Fit to Window (F)">
          <IconFitWindow />
        </button>
      </div>

      {showShaderGenerator && (
        <ShaderGenerator
          onGenerate={handleShaderGenerate}
          onClose={() => setShowShaderGenerator(false)}
        />
      )}

      {!collapsed && (
        <div
          className={`node-canvas__container ${dropTarget === 'canvas' ? 'node-canvas__container--drop-target' : ''}`}
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onContextMenu={handleContextMenu}
          onClick={handleCanvasClick}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div
            className="node-canvas__grid"
            style={{ backgroundPosition: `${pan.x}px ${pan.y}px`, backgroundSize: `${20 * zoom}px ${20 * zoom}px` }}
          />

          <div
            className="node-canvas__surface"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            <svg className="node-canvas__noodle-svg" style={{ position: 'absolute', top: 0, left: 0, width: '10000px', height: '10000px', pointerEvents: 'none', overflow: 'visible' }}>
              <NoodleFilters />
              {graph.edges.map(edge => {
                const from = getSocketPos(edge.fromNode, edge.fromSocket, 'output')
                const to = getSocketPos(edge.toNode, edge.toSocket, 'input')
                const fromNode = graph.nodes.find(n => n.id === edge.fromNode)
                const fromParams = nodeParamConfigs[edge.fromNode] || []
                const fromSockets = fromNode ? getNodeSockets(fromNode.type, fromParams, fromNode) : { outputs: [] }
                const fromSocket = fromSockets.outputs.find(s => s.id === edge.fromSocket)
                const dataType = fromSocket?.type || 'texture'
                return <Noodle key={edge.id} id={edge.id} fromX={from.x} fromY={from.y} toX={to.x} toY={to.y} dataType={dataType} onDelete={handleEdgeDelete} insertHighlight={insertTarget?.edgeId === edge.id} />
              })}
              {dragNoodle && <NoodleDrag fromX={dragNoodle.fromX} fromY={dragNoodle.fromY} toX={dragNoodle.toX} toY={dragNoodle.toY} dataType={dragNoodle.dataType} />}
            </svg>

            {marquee && (
              <div className="node-canvas__marquee" style={{
                left: Math.min(marquee.startX, marquee.endX),
                top: Math.min(marquee.startY, marquee.endY),
                width: Math.abs(marquee.endX - marquee.startX),
                height: Math.abs(marquee.endY - marquee.startY),
              }} />
            )}

            {graph.nodes.map(node => {
              const execIdx = sorted.indexOf(node.id)
              const isMultiSelected = selectedNodeIds.includes(node.id)
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  selected={selectedNodeId === node.id}
                  isMultiSelected={isMultiSelected}
                  isPreviewTap={previewTapId === node.id}
                  isOrphaned={orphanedNodes.has(node.id)}
                  executionOrder={execIdx >= 0 ? execIdx : null}
                  paramConfigs={nodeParamConfigs[node.id] || []}
                  connectedInputs={connectedInputsMap[node.id] || new Set()}
                  connectedOutputs={connectedOutputsMap[node.id] || new Set()}
                  zoom={zoom}
                  onSelect={selectNode}
                  onDelete={handleNodeDelete}
                  onMove={handleNodeMove}
                  onMoveEnd={handleNodeMoveEnd}
                  onOpenMonaco={openMonaco}
                  onSetPreview={handleSetPreview}
                  onToggleBypass={(id) => {
                    const n = graph.nodes.find(n => n.id === id)
                    if (n) updateNode(graphLevel, graphClipId, id, { bypassed: !n.bypassed })
                  }}
                  onParamChange={handleParamChange}
                  onSocketDragStart={handleSocketDragStart}
                  onSocketDragEnd={handleSocketDragEnd}
                  onDuplicate={handleNodeDuplicate}
                  onDetachNode={handleDetachNode}
                  onEnterCompound={enterCompound}
                  onExposedParamChange={handleCompoundExposedParamChange}
                  onExpandCompound={handleExpandCompound}
                />
              )
            })}
          </div>

          {graph.nodes.length === 0 && (
            <div className="node-canvas__empty-hint">
              <p>Right-click to add nodes</p>
              <p className="text-muted">Drag effects from the Media Pool</p>
              <p className="text-muted">Ctrl-drag a node onto a wire to insert it</p>
            </div>
          )}

          <div className="node-canvas__minimap">
            <div className="node-canvas__minimap-label mono">minimap</div>
          </div>

          {showSearchMenu && (
            <NodeSearchMenu position={searchMenuPos} onSelect={handleAddNode} onClose={() => setShowSearchMenu(false)} />
          )}

          {showActionMenu && (
            <ActionContextMenu
              position={actionMenuPos}
              selectedCount={selectedNodeIds.length}
              onCopy={handleCopySelectedNodes}
              onCreateCompound={handleCreateCompound}
              onClose={() => setShowActionMenu(false)}
            />
          )}

          {showCompoundModal && (
            <CompoundNameModal
              onConfirm={handleCompoundConfirm}
              onCancel={() => setShowCompoundModal(false)}
            />
          )}

          <MonacoDrawer />
        </div>
      )}
    </>
  )
}
