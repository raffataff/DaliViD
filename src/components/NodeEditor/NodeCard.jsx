import { useState, useRef, useCallback, memo } from 'react'
import Socket from './Socket'
import { IconChevronDown, IconSettings, IconEye, IconCode, IconClose } from '../common/Icons'
import { getNodeSockets } from '../../shaders/nodeDefinitions'
import { getNodeSource } from '../../shaders/shaderRegistry'
import { prepareImageDataURL, dataUrlBytes, formatBytes } from '../../utils/imageProcessing'
import './NodeCard.css'

export const NODE_COLORS = {
  'CLIP_SOURCE': '#44cc88', 'CLIP_OUTPUT': '#ff6644', 'VIDEO_INPUT': '#44cc88',
  'IMAGE_INPUT': '#44cc88', 'TEXT_INPUT': '#ffcc44',
  'CAMERA_INPUT': '#44aaff', 'SCREEN_INPUT': '#44aaff', 'AUDIO_INPUT': '#ff00aa', 'AUDIO_SPLITTER': '#cc44ff',
  'AUDIO_VISUALIZER': '#ff00aa', 'OUTPUT': '#ff6644', 'EDGE_DETECTION': '#ff8844',
  'COLOR_INVERSION': '#ff44cc', 'GLITCH': '#ff3344', 'FEEDBACK': '#aa44ff',
  'KALEIDOSCOPE': '#44ccff', 'PIXEL_SORT': '#ff8844', 'CHROMATIC_ABERRATION': '#ff44aa',
  'BLOOM': '#ffcc44', 'CRT': '#88aa44', 'VORONOI': '#44ffaa', 'FLUID_WARP': '#4488ff',
  'HALFTONE': '#aaaacc', 'THRESHOLD': '#ccaa44', 'DEPTH_BLUR': '#44aacc',
  'MIRROR': '#cc44ff', 'PARTICLE': '#ff6644', 'LUT': '#ffaa44',
  'MATH_BLEND': '#aaccff', 'MIX_BLEND': '#aaccff', 'MATH': '#ffdd00', 'TRANSITION_PROGRESS': '#ffdd00', 'ENVELOPE': '#ffdd00',
  'CUSTOM': '#00e5ff', 'COMPOUND': '#ff00aa',
  'AUDIO_WARP': '#ff00aa', 'SPECTRUM_GLOW': '#ff00aa',
  'EFFECT_INPUT': '#44cc88', 'EFFECT_OUTPUT': '#ff6644',
  // New Generator Nodes
  'BIOMATH': '#44aaff', 'PLASMA': '#ff00aa', 'FRACTAL': '#cc44ff',
  'TUNNEL': '#ff8844', 'GEOMETRIC': '#88aa44', 'LIGHTNING': '#44ffaa',
  'CRYSTAL': '#aaccff', 'COSMIC': '#aa44ff', 'WAVES': '#4488ff',
  'SPACE_DISTORTION': '#ccaa44',
}

// Must match .node-card { width } in NodeCard.css — marquee hit-testing and the
// socket-position fallback in NodeCanvas both derive geometry from this.
export const NODE_WIDTH = 270

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
  onDuplicate, onDetachNode, connectedInputs = new Set(), connectedOutputs = new Set(),
  zoom = 1, onEnterCompound, onExposedParamChange,
}) {
  const cardRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [compoundExpanded, setCompoundExpanded] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, nodeX: 0, nodeY: 0 })

  const accentColor = NODE_COLORS[node.type] || '#00e5ff'
  const isLocked = node.locked
  const isCompound = node.type === 'COMPOUND'

  const { inputs, outputs } = getNodeSockets(node.type, paramConfigs, node)
  const fixedInputs = inputs.filter(s => !s.isParam)
  const paramInputs = inputs.filter(s => s.isParam)
  const compoundExposedParams = isCompound ? (node.exposedParams || []) : []

  const dragMoved = useRef(false)

  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('.socket') || e.target.closest('.node-card__slider') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return
    e.stopPropagation()
    if (e.altKey) e.preventDefault() // keep Alt from triggering the browser menu
    let dragNodeId = node.id
    dragMoved.current = false
    if (e.shiftKey && onDetachNode) onDetachNode(node.id)
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
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      // Pass the live event through so the canvas can do modifier-aware work
      // (Ctrl+drag = highlight a wire under the node for auto-insert).
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
  }, [node.id, node.position, zoom, onSelect, onMove, onMoveEnd, onDuplicate, onDetachNode])

  const handleDoubleClick = useCallback((e) => {
    if (isCompound && onEnterCompound) { e.stopPropagation(); onEnterCompound(node.id) }
  }, [isCompound, node.id, onEnterCompound])

  // ── Image source: load / replace the still image on this node ──
  const isImageNode = node.type === 'IMAGE_INPUT'
  const isTextNode = node.type === 'TEXT_INPUT'

  const readImageFile = useCallback(async (file) => {
    if (!file || !file.type?.startsWith('image/')) return
    try {
      // Downscale + re-encode so the persisted data URL stays small.
      const { dataUrl } = await prepareImageDataURL(file)
      const after = dataUrlBytes(dataUrl)
      const pct = file.size > 0 ? Math.round((1 - after / file.size) * 100) : 0
      console.log(`[DaliVid] Loaded "${file.name}": ${formatBytes(file.size)} → ${formatBytes(after)} (${pct}% smaller)`)
      onParamChange?.(node.id, 'imageSrc', dataUrl) // data URL → persisted in params
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
      ].filter(Boolean).join(' ')}
      style={{ left: node.position.x, top: node.position.y, borderLeftColor: isCompound ? (node.color || accentColor) : accentColor }}
      onMouseDown={handleMouseDown}
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
        <span className="node-card__type" style={{ color: isCompound ? (node.color || accentColor) : accentColor }}>
          {node.name || node.type}
        </span>
        {isCompound && <span className="node-card__compound-badge mono">{exposedParamCount} param{exposedParamCount !== 1 ? 's' : ''}</span>}
        <div className="node-card__header-actions">
          {isCompound && (
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

      {isImageNode && (
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

      {isTextNode && (
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

      {compoundExpanded && isCompound && exposedParamCount > 0 && (
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

      {!isCompound && paramConfigs.length > 0 && (
        <div className="node-card__params">
          <div className="node-card__params-divider">PARAMETERS</div>
          {paramConfigs.map(param => {
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

      {executionOrder !== null && <div className="node-card__exec-order mono">{executionOrder}</div>}
      {isOrphaned && <div className="node-card__orphan-warning" data-tooltip="Not connected to OUTPUT — will not render">⚠</div>}
    </div>
  )
})

export default NodeCard
