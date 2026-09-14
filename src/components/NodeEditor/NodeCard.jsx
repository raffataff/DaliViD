import { useState, useRef, useCallback, useMemo, memo } from 'react'
import Socket from './Socket'
import { IconChevronDown, IconSettings, IconEye, IconCode, IconClose } from '../common/Icons'
import { getNodeSockets } from '../../shaders/nodeDefinitions'
import {
  NODE_MIN_WIDTH, NODE_MAX_WIDTH, NODE_MIN_HEIGHT, NODE_MAX_HEIGHT, NODE_MIN_PARAMS_H, nodeWidth,
} from './nodeGeometry'
import { visibleDataParams } from '../../shaders/dataNodeParams'
import { getNodeSource } from '../../shaders/shaderRegistry'
import { prepareImageDataURL, dataUrlBytes, formatBytes } from '../../utils/imageProcessing'
import useMediaStore from '../../store/useMediaStore'
import './NodeCard.css'

export const NODE_COLORS = {
  'CLIP_SOURCE': '#44cc88', 'CLIP_OUTPUT': '#ff6644', 'VIDEO_INPUT': '#44cc88',
  'IMAGE_INPUT': '#44cc88', 'TEXT_INPUT': '#ffcc44', 'SHAPE_INPUT': '#ff5588', 'LETTERBOX': '#8899aa',
  'TRANSFORM': '#8899aa', 'ARRAY': '#8899aa',
  'CAMERA_INPUT': '#44aaff', 'SCREEN_INPUT': '#44aaff', 'AUDIO_INPUT': '#ff00aa', 'AUDIO_SPLITTER': '#cc44ff',
  'AUDIO_VISUALIZER': '#ff00aa', 'OUTPUT': '#ff6644', 'EDGE_DETECTION': '#ff8844',
  'COLOR_INVERSION': '#ff44cc', 'GLITCH': '#ff3344', 'FEEDBACK': '#aa44ff',
  'FEEDBACK_MACHINE': '#c46bff',
  'KALEIDOSCOPE': '#44ccff', 'PIXEL_SORT': '#ff8844', 'CHROMATIC_ABERRATION': '#ff44aa',
  'BLOOM': '#ffcc44', 'CRT': '#88aa44', 'VORONOI': '#44ffaa', 'FLUID_WARP': '#4488ff',
  'HALFTONE': '#aaaacc', 'THRESHOLD': '#ccaa44', 'DEPTH_BLUR': '#44aacc',
  'MIRROR': '#cc44ff', 'PARTICLE': '#ff6644', 'LUT': '#ffaa44',
  'MATH_BLEND': '#aaccff', 'MIX_BLEND': '#aaccff', 'MATH': '#ffdd00', 'TRANSITION_PROGRESS': '#ffdd00', 'ENVELOPE': '#ffdd00', 'RAMP': '#ffdd00', 'LFO': '#ffdd00',
  'CUSTOM': '#00e5ff', 'COMPOUND': '#ff00aa',
  'AUDIO_WARP': '#ff00aa', 'SPECTRUM_GLOW': '#ff00aa',
  'EFFECT_INPUT': '#44cc88', 'EFFECT_OUTPUT': '#ff6644',
  // New Generator Nodes
  'BIOMATH': '#44aaff', 'PLASMA': '#ff00aa', 'FRACTAL': '#cc44ff',
  'TUNNEL': '#ff8844', 'GEOMETRIC': '#88aa44', 'LIGHTNING': '#44ffaa',
  'CRYSTAL': '#aaccff', 'COSMIC': '#aa44ff', 'WAVES': '#4488ff',
  'SPACE_DISTORTION': '#ccaa44',
  // 3D / Depth family — one hue family so a depth sub-graph reads as a unit on
  // the canvas and in the minimap. DEPTH is the brightest: it is the producer.
  'DEPTH': '#66ddff', 'NORMALS_3D': '#4fb8d8', 'RELIGHT_3D': '#ffd9a0',
  'AO_3D': '#7b8fa8', 'FOG_3D': '#a8c4d8', 'BOKEH_3D': '#c9a8ff',
  'CAMERA_3D': '#5ce6c0', 'MULTIPLANE': '#8ad9a0', 'STEREO_3D': '#ff8a8a',
  'VOXEL_3D': '#d8c86a', 'DEPTH_DISPLACE': '#e08adf', 'TIME_SLICE_3D': '#9a8cff',
}

// Edge/corner drag handles. The letters name the edges the drag MOVES: 'w'/'e'
// change width ('w' also shifts position.x so the opposite edge stays planted),
// 's' changes height. There is deliberately no north handle — the header owns
// that edge and dragging it is the move gesture; a resize there would be a coin
// toss between the two.
const RESIZE_HANDLES = [
  ['w', 'Drag to resize width · double-click to reset'],
  ['e', 'Drag to resize width · double-click to reset'],
  ['s', 'Drag to resize height · double-click to reset'],
  ['sw', 'Drag to resize · double-click to reset'],
  ['se', 'Drag to resize · double-click to reset'],
]

// How far a Shift+drag must travel (screen px, so it's zoom-independent) before
// the node is pulled out of its chain. Extraction rewrites edges, so it must not
// fire on a click that merely wobbled. Matches the marquee's click threshold.
const EXTRACT_THRESHOLD_PX = 4

// On-card quick shape switcher for SHAPE_INPUT — [glyph, u_shp_type, tooltip].
// Indices match the SHAPE_INPUT shader's "Shape" select options.
const SHAPE_QUICK_PICKS = [
  ['▭', 0, 'Rectangle'], ['●', 1, 'Ellipse'], ['▲', 2, 'Triangle'], ['⬡', 3, 'Polygon'],
  ['★', 4, 'Star'], ['◎', 5, 'Ring'], ['▬', 6, 'Capsule'], ['✚', 7, 'Cross'],
]

function ParamSlider({ nodeId, param, value, onChange, hasAudioBind, disabled = false }) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  if (param.type === 'checkbox') {
    return (
      <div className={`node-card__slider-row ${disabled ? 'node-card__slider-row--disabled' : ''}`}>
        <span className="node-card__slider-label">{param.name}</span>
        <label className="node-card__checkbox">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
          <span className="node-card__checkbox-mark" />
        </label>
      </div>
    )
  }
  if (param.type === 'select') {
    return (
      <div className={`node-card__slider-row ${disabled ? 'node-card__slider-row--disabled' : ''}`}>
        <span className="node-card__slider-label">{param.name}</span>
        <select className="node-card__select"
          value={typeof value === 'number' ? (param.options?.[value] || value) : value}
          onChange={(e) => { const idx = param.options?.indexOf(e.target.value); onChange(idx >= 0 ? idx : e.target.value) }}
          disabled={disabled}
        >
          {param.options?.map((opt, i) => <option key={i} value={opt}>{opt}</option>)}
        </select>
      </div>
    )
  }
  if (param.type === 'color') {
    return (
      <div className={`node-card__slider-row ${disabled ? 'node-card__slider-row--disabled' : ''}`}>
        <span className="node-card__slider-label">{param.name}</span>
        <input type="color" className="node-card__color-input" value={value || '#ffffff'} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </div>
    )
  }
  // ── Numeric slider param ──
  const min = param.min ?? 0
  const max = param.max ?? 1
  const step = param.step || 0.01
  // Show enough decimals for the param's step (0.001 step → 3 decimals).
  const decimals = Math.min(4, Math.max(2, Math.ceil(-Math.log10(step))))
  const displayValue = typeof value === 'number' ? value.toFixed(decimals) : value

  const clampSnap = (v) => {
    const snapped = Math.round(v / step) * step
    return parseFloat(Math.max(min, Math.min(max, snapped)).toFixed(6))
  }

  // Drag the value readout to scrub it (delta-based, so huge min/max ranges stay
  // controllable): a full ~250px drag sweeps the whole range; hold Shift for 10×
  // fine adjustment. A plain click (< 3px of movement) opens the type-in box.
  const handleValueMouseDown = (e) => {
    if (disabled) return
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startValue = typeof value === 'number' ? value : (parseFloat(value) || 0)
    let scrubbed = false
    const handleMove = (ev) => {
      const dx = ev.clientX - startX
      if (!scrubbed && Math.abs(dx) < 3) return
      scrubbed = true
      const sensitivity = (max - min) / (ev.shiftKey ? 2500 : 250)
      onChange(clampSnap(startValue + dx * sensitivity))
    }
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      if (!scrubbed) { setEditValue(String(value)); setIsEditing(true) }
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }

  return (
    <div className={`node-card__slider-row ${disabled ? 'node-card__slider-row--disabled' : ''}`}>
      <span className="node-card__slider-label">{param.name}</span>
      <input type="range" className="node-card__slider" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} disabled={disabled}
        onDoubleClick={() => { if (!disabled && param.default !== undefined) onChange(param.default) }}
        data-tooltip="Double-click to reset" />
      {isEditing ? (
        <input className="node-card__slider-value-input mono" type="number" value={editValue} autoFocus
          min={min} max={max} step={step}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => { const num = parseFloat(editValue); if (!isNaN(num)) onChange(Math.max(min, Math.min(max, num))); setIsEditing(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setIsEditing(false); e.stopPropagation() }}
        />
      ) : (
        <span className="node-card__slider-value mono" data-node-id={nodeId} data-node-param-display={param.uniformName}
          onMouseDown={handleValueMouseDown}
          data-tooltip="Drag to scrub (Shift = fine) · Click to type"
        >
          {disabled ? '⚡' : displayValue}
        </span>
      )}
      {hasAudioBind && <span className="node-card__audio-bind-icon" data-tooltip="Audio Bound">🎵</span>}
    </div>
  )
}

const NodeCard = memo(function NodeCard({
  node, selected = false, isMultiSelected = false, isPreviewTap = false, isOrphaned = false,
  executionOrder = null, paramConfigs = [], onSelect, onDelete, onMove, onMoveEnd, onOpenMonaco,
  onSetPreview, onToggleBypass, onParamChange, onSocketDragStart, onSocketDragEnd,
  onDuplicate, onExtractNode, onDissolveNode, connectedInputs = new Set(), connectedOutputs = new Set(),
  zoom = 1, onEnterCompound, onExposedParamChange, onToggleCollapse, onResize,
}) {
  const cardRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [compoundExpanded, setCompoundExpanded] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, nodeX: 0, nodeY: 0 })

  const accentColor = NODE_COLORS[node.type] || '#00e5ff'
  const isLocked = node.locked
  const isCompound = node.type === 'COMPOUND'
  const isCollapsed = !!node.collapsed
  const cardWidth = nodeWidth(node)
  // A collapsed card is laid out by its content, so an explicit height is only
  // honoured while expanded — otherwise expanding a node you had sized small
  // would hand back a card too short for its own params.
  const sizedHeight = (!isCollapsed && typeof node.height === 'number' && isFinite(node.height))
    ? Math.max(NODE_MIN_HEIGHT, Math.min(NODE_MAX_HEIGHT, node.height))
    : null

  // Sockets are built from the FULL config list, never the visible subset: a
  // hidden param can still be driven by a wire, and dropping its socket would
  // strand the noodle. Conditional visibility is a UI concern only.
  const { inputs, outputs } = getNodeSockets(node.type, paramConfigs, node)
  const fixedInputs = inputs.filter(s => !s.isParam)
  const paramInputs = inputs.filter(s => s.isParam)
  const compoundExposedParams = isCompound ? (node.exposedParams || []) : []

  // What a COLLAPSED card still shows: every fixed socket (there are only ever a
  // handful, and a collapsed node must stay wireable), plus any PARAM socket that
  // currently has a noodle on it. That second half is not cosmetic — getSocketPos
  // anchors each noodle to the socket's live DOM circle, so dropping a connected
  // socket would strand its wire on the position-estimate fallback and the noodle
  // would visibly jump. Unconnected param sockets (there can be a dozen) are the
  // only thing hidden; expand the node to wire one.
  const railInputs = isCollapsed
    ? [...fixedInputs, ...paramInputs.filter(s => connectedInputs.has(s.id))]
    : fixedInputs

  // Controls whose value can't do anything are noise (Beats/Cycle with Beat Sync
  // off, Pulse Width on a Sine wave). `connectedInputs` is passed as the
  // always-show set so a wired param keeps its row — and so its socket keeps a
  // real DOM anchor for `getSocketPos`.
  const visibleParams = useMemo(
    () => visibleDataParams(paramConfigs, node.params, connectedInputs),
    [paramConfigs, node.params, connectedInputs]
  )

  const dragMoved = useRef(false)
  const extracted = useRef(false)

  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('.socket') || e.target.closest('.node-card__slider') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return

    // Right-click never drags. It used to: there was no button check here, so a
    // right-drag silently moved the node out from under its own context menu.
    // Shift+right-click is Dissolve (handled in handleContextMenu) — leave the
    // selection alone there so the menu and the action agree on the target.
    if (e.button === 2) {
      if (!e.shiftKey) onSelect?.(node.id, e)
      return
    }
    if (e.button !== 0) return

    e.stopPropagation()
    if (e.altKey) e.preventDefault() // keep Alt from triggering the browser menu
    let dragNodeId = node.id
    dragMoved.current = false
    extracted.current = false
    // Alt (duplicate) wins over Shift (extract): duplicating and then extracting
    // in one gesture has no coherent meaning, and guessing wrong is destructive.
    const wantsExtract = e.shiftKey && !e.altKey && !isLocked && !!onExtractNode

    if (e.altKey && onDuplicate) {
      const newId = onDuplicate(node.id)
      if (newId) dragNodeId = newId
    } else if (!e.ctrlKey && !e.metaKey) {
      // Ctrl+click toggles the node in/out of the multi-selection — that's
      // handled on click (after we know it wasn't a Ctrl+drag wire-insert).
      onSelect?.(node.id, e)
    }
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, nodeX: node.position.x, nodeY: node.position.y }
    const handleMouseMove = (e) => {
      dragMoved.current = true
      // Extract on the drag THRESHOLD, never on mousedown. The old code detached
      // the instant Shift+mousedown landed, so a stationary Shift+click rewired
      // the graph — and it ran *before* the drag, leaving the drag to push a node
      // that had already been deleted.
      if (wantsExtract && !extracted.current) {
        const dist = Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y)
        if (dist >= EXTRACT_THRESHOLD_PX) {
          extracted.current = true
          onExtractNode(dragNodeId)
        }
      }
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      // Pass the live event through so the canvas can do modifier-aware work
      // (Ctrl/Shift+drag = highlight a wire under the node for auto-insert).
      onMove?.(dragNodeId, { x: dragStart.current.nodeX + dx, y: dragStart.current.nodeY + dy }, e)
    }
    const handleMouseUp = (e) => {
      setIsDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      onMoveEnd?.(dragNodeId, e)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [node.id, node.position, zoom, isLocked, onSelect, onMove, onMoveEnd, onDuplicate, onExtractNode])

  // Shift+right-click = dissolve: heal the wires around this node, then delete
  // it. Anything else falls through to the canvas's node-search menu unchanged.
  const handleContextMenu = useCallback((e) => {
    if (!e.shiftKey || isLocked || !onDissolveNode) return
    // Same dead-zone as the drag: a right-click on a control belongs to that
    // control, and losing the whole node to a mis-aimed click on a slider would
    // be a nasty surprise.
    if (e.target.closest('.socket') || e.target.closest('.node-card__slider') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return
    e.preventDefault()
    e.stopPropagation()
    onDissolveNode(node.id)
  }, [node.id, isLocked, onDissolveNode])

  const handleDoubleClick = useCallback((e) => {
    if (isCompound && onEnterCompound) { e.stopPropagation(); onEnterCompound(node.id) }
  }, [isCompound, node.id, onEnterCompound])

  // ── Edge / corner resize ──
  // Deltas are divided by `zoom` for the same reason the move drag is: the card
  // lives inside a CSS-scaled surface, so screen px and graph px differ.
  const handleResizeDown = useCallback((e, dir) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const card = cardRef.current
    if (!card) return
    const startW = cardWidth
    const startH = card.offsetHeight
    const startX = node.position.x
    const startY = node.position.y
    // Floor for a height drag. The params list is the ONLY part that shrinks
    // (`.node-card--sized > *` pins everything else at flex-shrink 0), so the
    // floor is the measured height of that fixed chrome plus a usable sliver of
    // list. Measured rather than assumed because it is not just the header and
    // sockets: IMAGE / TEXT / SHAPE cards each carry an extra fixed block, and
    // the card has `overflow: visible` (sockets hang past its edges), so
    // under-counting doesn't clip — it spills the image out the bottom.
    // Absolutely-positioned children (the resize handles, the exec-order and
    // orphan badges) are out of flow and must not be counted.
    let fixedH = 0
    let hasParams = false
    for (const el of card.children) {
      if (el.classList.contains('node-card__params')) { hasParams = true; continue }
      if (getComputedStyle(el).position === 'absolute') continue
      fixedH += el.offsetHeight
    }
    const minH = Math.max(NODE_MIN_HEIGHT, fixedH + (hasParams ? NODE_MIN_PARAMS_H : 0) + 6)
    const west = dir.includes('w')
    const wantsW = west || dir.includes('e')
    const wantsH = dir.includes('s') && !isCollapsed

    const handleMove = (ev) => {
      // Both axes are measured from the gesture's START, never accumulated per
      // move event — a cumulative delta drifts as soon as a value hits a clamp.
      const dx = (ev.clientX - e.clientX) / zoom
      const dy = (ev.clientY - e.clientY) / zoom
      const patch = {}
      if (wantsW) {
        const w = Math.round(Math.max(NODE_MIN_WIDTH, Math.min(NODE_MAX_WIDTH, west ? startW - dx : startW + dx)))
        patch.width = w
        // Dragging the west edge keeps the EAST edge planted, so the card grows
        // into the drag rather than sliding away from it.
        if (west) patch.position = { x: Math.round(startX + (startW - w)), y: startY }
      }
      if (wantsH) patch.height = Math.round(Math.max(minH, Math.min(NODE_MAX_HEIGHT, startH + dy)))
      onResize?.(node.id, patch)
    }
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [node.id, node.position.x, node.position.y, cardWidth, zoom, isCollapsed, onResize])

  // Double-click any handle clears BOTH overrides — back to the 270px default and
  // content height. `undefined` is the "no override" value everywhere (nodeWidth
  // falls through to the default, JSON.stringify drops the key on save).
  const handleResizeReset = useCallback((e) => {
    e.stopPropagation()
    onResize?.(node.id, { width: undefined, height: undefined })
  }, [node.id, onResize])

  // ── Image source: load / replace the still image on this node ──
  const isImageNode = node.type === 'IMAGE_INPUT'
  const isTextNode = node.type === 'TEXT_INPUT'
  const isShapeNode = node.type === 'SHAPE_INPUT'

  const readImageFile = useCallback(async (file) => {
    if (!file || !file.type?.startsWith('image/')) return
    try {
      // Downscale + re-encode: still bounds the texture to the WebGL2-guaranteed
      // 2048 and keeps the stored blob small.
      const { dataUrl, width, height } = await prepareImageDataURL(file)
      const after = dataUrlBytes(dataUrl)
      const pct = file.size > 0 ? Math.round((1 - after / file.size) * 100) : 0
      console.log(`[DaliVid] Loaded "${file.name}": ${formatBytes(file.size)} → ${formatBytes(after)} (${pct}% smaller)`)

      // Into the blob store rather than inlined into params. imageRefId is what
      // persists; imageSrc is this session's URL for it and the serializer drops
      // it. If the store write fails we still set imageSrc, so the node works
      // now and simply does not survive a reload — never a black frame.
      let src = dataUrl
      try {
        const blob = await fetch(dataUrl).then(r => r.blob())
        const ref = await useMediaStore.getState().ingestBytes(blob, {
          filename: file.name, kind: 'image',
          mime: blob.type || 'image/webp', meta: { width, height },
        })
        src = useMediaStore.getState().urlFor(ref.id) || dataUrl
        onParamChange?.(node.id, 'imageRefId', ref.id)
      } catch (err) {
        console.warn('[DaliVid] Image kept in-document (could not store it):', err)
      }
      onParamChange?.(node.id, 'imageSrc', src)
      onParamChange?.(node.id, 'imageName', file.name)
    } catch (err) {
      console.error('[DaliVid] Failed to load image:', err)
    }
  }, [node.id, onParamChange])

  const handleLoadImage = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = (e) => readImageFile(e.target.files?.[0])
    input.click()
  }, [readImageFile])

  const handleImageDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const file = e.dataTransfer?.files?.[0]
    if (file) { readImageFile(file); return }
    // Also accept an image card dragged from the Media Pool.
    const raw = e.dataTransfer?.getData('application/dalivid-drag')
    if (raw) {
      try {
        const payload = JSON.parse(raw)
        if (payload.imageSrc) {
          onParamChange?.(node.id, 'imageSrc', payload.imageSrc)
          onParamChange?.(node.id, 'imageName', payload.imageName || payload.name || '')
        }
      } catch { /* ignore malformed payloads */ }
    }
  }, [readImageFile, node.id, onParamChange])

  const exposedParamCount = compoundExposedParams.length

  return (
    <div
      ref={cardRef}
      className={[
        'node-card',
        selected && 'node-card--selected',
        isMultiSelected && 'node-card--multi-selected',
        isPreviewTap && 'node-card--preview-tap',
        isOrphaned && 'node-card--orphaned',
        node.bypassed && 'node-card--bypassed',
        isDragging && 'node-card--dragging',
        isCompound && 'node-card--compound',
        compoundExpanded && 'node-card--compound-expanded',
        isCollapsed && 'node-card--collapsed',
        sizedHeight != null && 'node-card--sized',
      ].filter(Boolean).join(' ')}
      style={{
        left: node.position.x, top: node.position.y, width: cardWidth,
        // Height is only ever set once the bottom edge has been dragged —
        // otherwise the card stays content-sized, exactly as every node was
        // before this. `node-card--sized` is what turns the params list into the
        // scrolling region that absorbs the difference.
        ...(sizedHeight != null ? { height: sizedHeight } : null),
        borderLeftColor: isCompound ? (node.color || accentColor) : accentColor,
      }}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onClick={(e) => {
        e.stopPropagation()
        // A drag's release also fires a click — don't re-select (or Ctrl-toggle)
        // after the node was actually moved.
        if (dragMoved.current) { dragMoved.current = false; return }
        onSelect?.(node.id, e)
      }}
      onDoubleClick={handleDoubleClick}
    >
      <div className="node-card__header">
        {/* Disclosure sits LEFT of the title, not in the right-hand action
            cluster: a COMPOUND card already has a chevron there (exposed params),
            and two chevrons side by side is a guess. Left of the title is the
            conventional place for "open/close this thing" and reads as such.
            Deliberately outside the !isLocked guard — collapsing is a view-only
            change, so OUTPUT and CLIP_SOURCE can be tidied away too. */}
        <button
          className={`node-card__disclosure ${isCollapsed ? 'node-card__disclosure--collapsed' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(node.id) }}
          data-tooltip={isCollapsed ? 'Expand node (H)' : 'Collapse node (H)'}
        >
          <IconChevronDown size={11} />
        </button>
        <span className="node-card__type" style={{ color: isCompound ? (node.color || accentColor) : accentColor }}>
          {node.name || node.type}
        </span>
        {isCompound && !isCollapsed && <span className="node-card__compound-badge mono">{exposedParamCount} param{exposedParamCount !== 1 ? 's' : ''}</span>}
        <div className="node-card__header-actions">
          {isCompound && !isCollapsed && (
            <button className={`node-card__action-btn ${compoundExpanded ? 'node-card__action-btn--active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setCompoundExpanded(!compoundExpanded) }}
              data-tooltip={compoundExpanded ? 'Collapse Parameters' : 'Expand Parameters'}>
              <IconChevronDown size={11} />
            </button>
          )}
          {!isLocked && (
            <>
              <button className="node-card__action-btn" onClick={(e) => { e.stopPropagation(); onToggleBypass?.(node.id) }} data-tooltip="Toggle Bypass"><IconSettings size={11} /></button>
              <button className={`node-card__action-btn ${isPreviewTap ? 'node-card__action-btn--active' : ''}`} onClick={(e) => { e.stopPropagation(); onSetPreview?.(node.id) }} data-tooltip="Preview This Node"><IconEye size={11} /></button>
              {getNodeSource(node) != null && (
                <button className="node-card__action-btn" onClick={(e) => { e.stopPropagation(); onOpenMonaco?.(node.id) }} data-tooltip="Edit Shader Code"><IconCode size={11} /></button>
              )}
              <button className="node-card__action-btn node-card__action-btn--delete" onClick={(e) => { e.stopPropagation(); onDelete?.(node.id) }} data-tooltip="Delete Node"><IconClose size={10} /></button>
            </>
          )}
        </div>
      </div>

      {isCollapsed ? (
        // One rail row, inputs hugging the left edge and outputs the right. The
        // dots are `mini` (no labels — there is no room and the tooltip carries
        // the name), but the .socket hit box is padded out in CSS so they stay
        // grabbable; getSocketPos reads the CIRCLE, so noodles still land dead on.
        <div className="node-card__rail">
          <div className="node-card__rail-side node-card__rail-side--in">
            {railInputs.map((socket) => (
              <Socket key={socket.id} type="input" dataType={socket.type} name={socket.name} connected={connectedInputs.has(socket.id)} nodeId={node.id} socketId={socket.id} onDragStart={onSocketDragStart} onDragEnd={onSocketDragEnd} mini />
            ))}
          </div>
          <div className="node-card__rail-side node-card__rail-side--out">
            {outputs.map((socket) => (
              <Socket key={socket.id} type="output" dataType={socket.type} name={socket.name} connected={connectedOutputs.has(socket.id)} nodeId={node.id} socketId={socket.id} onDragStart={onSocketDragStart} mini />
            ))}
          </div>
        </div>
      ) : (
      <div className="node-card__socket-area">
        <div className="node-card__sockets-left">
          {fixedInputs.map((socket) => (
            <div key={socket.id} className="node-card__socket-row node-card__socket-row--input">
              <Socket type="input" dataType={socket.type} name={socket.name} connected={connectedInputs.has(socket.id)} nodeId={node.id} socketId={socket.id} onDragStart={onSocketDragStart} onDragEnd={onSocketDragEnd} />
            </div>
          ))}
        </div>
        <div className="node-card__center">
          {node.bypassed && <div className="node-card__bypass-overlay">BYPASSED</div>}
          {isPreviewTap && <div className="node-card__preview-badge">👁 PREVIEW</div>}
        </div>
        <div className="node-card__sockets-right">
          {outputs.map((socket) => (
            <div key={socket.id} className="node-card__socket-row node-card__socket-row--output">
              <Socket type="output" dataType={socket.type} name={socket.name} connected={connectedOutputs.has(socket.id)} nodeId={node.id} socketId={socket.id} onDragStart={onSocketDragStart} />
            </div>
          ))}
        </div>
      </div>
      )}

      {!isCollapsed && isImageNode && (
        <div
          className="node-card__image-loader"
          onMouseDown={(e) => e.stopPropagation()}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
          onDrop={handleImageDrop}
          style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <div
            style={{
              width: '100%', aspectRatio: '16 / 9', borderRadius: 3, overflow: 'hidden',
              background: '#0a0a0e', border: '1px dashed #2a2a35',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {node.params?.imageSrc ? (
              <img src={node.params.imageSrc} alt="" draggable={false}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : (
              <span style={{ fontSize: 10, color: '#888899' }}>Drop or load an image</span>
            )}
          </div>
          <button
            className="node-card__action-btn"
            onClick={(e) => { e.stopPropagation(); handleLoadImage() }}
            style={{ width: '100%', height: 22, fontSize: 11, color: accentColor, borderColor: accentColor }}
          >
            {node.params?.imageSrc ? 'Replace Image' : 'Load Image'}
          </button>
          {node.params?.imageName && (
            <div className="mono" style={{ fontSize: 9, color: '#888899', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.params.imageName}
            </div>
          )}
        </div>
      )}

      {!isCollapsed && isTextNode && (
        <div
          className="node-card__text-editor"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <textarea
            className="node-card__text-input mono"
            value={node.params?.text ?? ''}
            placeholder="Type text…"
            rows={2}
            spellCheck={false}
            onChange={(e) => onParamChange?.(node.id, 'text', e.target.value)}
            style={{
              width: '100%', resize: 'vertical', minHeight: 34, fontSize: 12,
              background: '#0a0a0e', color: '#e8e8ef', border: '1px solid #2a2a35',
              borderRadius: 3, padding: '4px 6px', lineHeight: 1.3,
            }}
          />
          <div className="mono" style={{ fontSize: 9, color: '#888899' }}>
            Style in the Inspector →
          </div>
        </div>
      )}

      {!isCollapsed && isShapeNode && (
        // Quick shape switcher — the same u_shp_type the "Shape" dropdown sets,
        // one click away (the dropdown still lives in the params list below).
        <div
          className="node-card__shape-picker"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ padding: '6px 8px 0', display: 'flex', gap: 3, flexWrap: 'wrap' }}
        >
          {SHAPE_QUICK_PICKS.map(([glyph, type, label]) => {
            const active = (node.params?.u_shp_type ?? 0) === type
            return (
              <button
                key={type}
                className="node-card__action-btn"
                data-tooltip={label}
                onClick={(e) => { e.stopPropagation(); onParamChange?.(node.id, 'u_shp_type', type) }}
                style={{
                  width: 26, height: 22, fontSize: 12, lineHeight: 1,
                  color: active ? '#0a0a0e' : accentColor,
                  background: active ? accentColor : 'transparent',
                  borderColor: accentColor,
                }}
              >
                {glyph}
              </button>
            )
          })}
        </div>
      )}

      {!isCollapsed && compoundExpanded && isCompound && exposedParamCount > 0 && (
        <div className="node-card__params">
          <div className="node-card__params-divider">EXPOSED PARAMETERS</div>
          {compoundExposedParams.map((ep, i) => (
            <div key={i} className="node-card__exposed-param-row">
              <span className="node-card__exposed-param-label">{ep.displayName}</span>
              <ParamSlider nodeId={node.id} param={{ ...ep.paramConfig }} value={ep.value}
                onChange={(val) => onExposedParamChange?.(node.id, i, val)} hasAudioBind={false} disabled={false} />
            </div>
          ))}
        </div>
      )}

      {!isCollapsed && !isCompound && visibleParams.length > 0 && (
        <div className="node-card__params">
          <div className="node-card__params-divider">PARAMETERS</div>
          {visibleParams.map(param => {
            const paramSocket = paramInputs.find(s => s.id === param.uniformName)
            const isConnected = paramSocket && connectedInputs.has(param.uniformName)
            return (
              <div key={param.uniformName} className="node-card__param-row-with-socket">
                {paramSocket && (
                  <div className="node-card__param-socket">
                    <Socket type="input" dataType="float" name="" connected={isConnected} nodeId={node.id} socketId={param.uniformName} onDragStart={onSocketDragStart} onDragEnd={onSocketDragEnd} mini />
                  </div>
                )}
                <ParamSlider nodeId={node.id} param={param} value={node.params[param.uniformName] ?? param.default}
                  onChange={(val) => onParamChange?.(node.id, param.uniformName, val)}
                  hasAudioBind={!!node.audioBindings?.[param.uniformName]} disabled={isConnected} />
              </div>
            )
          })}
        </div>
      )}

      {/* Handles straddle the card edge (half in, half out) so they are
          grabbable at low zoom. Sockets are given a higher z-index in Socket.css,
          so a socket sitting on the same edge still wins the click. The south
          handles are dropped while collapsed — that height is laid out, not set. */}
      {RESIZE_HANDLES.map(([dir, tip]) => (
        (isCollapsed && dir.includes('s')) ? null : (
          <div
            key={dir}
            className={`node-card__resize node-card__resize--${dir}`}
            data-tooltip={tip}
            onMouseDown={(e) => handleResizeDown(e, dir)}
            onDoubleClick={handleResizeReset}
          />
        )
      ))}

      {executionOrder !== null && <div className="node-card__exec-order mono">{executionOrder}</div>}
      {isOrphaned && <div className="node-card__orphan-warning" data-tooltip="Not connected to OUTPUT — will not render">⚠</div>}
    </div>
  )
})

export default NodeCard
