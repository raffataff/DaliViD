import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import { parseParams } from '../../utils/paramParser'
import { getNodeSource } from '../../shaders/shaderRegistry'
import { BLEND_MODE_NAMES } from '../../gl/BlendModes.glsl.js'
import { TRANSITION_TYPES, getTransitionLabel, getTransitionParams, getTransitionDefaults } from '../../shaders/transitionRegistry.js'
import { isTransitionCompound } from '../../utils/compoundUtils'
import { keyAtTime } from '../../utils/keyframes'
import './Inspector.css'

// Photoshop-style grouping of BLEND_MODE_NAMES (which is already in canonical
// group order) so the 30-entry dropdown stays scannable.
const BLEND_MODE_GROUPS = [
  { label: 'Basic', modes: BLEND_MODE_NAMES.slice(0, 2) },       // Normal, Dissolve
  { label: 'Darken', modes: BLEND_MODE_NAMES.slice(2, 7) },      // Darken … Darker Color
  { label: 'Lighten', modes: BLEND_MODE_NAMES.slice(7, 12) },    // Lighten … Lighter Color
  { label: 'Contrast', modes: BLEND_MODE_NAMES.slice(12, 19) },  // Overlay … Hard Mix
  { label: 'Comparative', modes: BLEND_MODE_NAMES.slice(19, 23) }, // Difference … Divide
  { label: 'Component', modes: BLEND_MODE_NAMES.slice(23, 27) }, // Hue … Luminosity
  { label: 'Compositing', modes: BLEND_MODE_NAMES.slice(27) },   // Plus, Minus, Multiply Alpha
]

/**
 * Grouped blend-mode dropdown. `allowInherit` adds the clip-only "Inherit"
 * option (use the track's mode) so an explicit "Normal" is a real choice.
 */
function BlendModeSelect({ value, onChange, allowInherit = false }) {
  return (
    <select className="inspector__select" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowInherit && <option value="Inherit">Inherit (track)</option>}
      {BLEND_MODE_GROUPS.map(group => (
        <optgroup key={group.label} label={group.label}>
          {group.modes.map(name => <option key={name} value={name}>{name}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

export default function Inspector() {
  const inspectorContext = useAppStore(s => s.inspectorContext)
  const selectedNodeId = useAppStore(s => s.selectedNodeId)
  const selectedClipId = useAppStore(s => s.selectedClipId)
  const selectedTrackId = useAppStore(s => s.selectedTrackId)
  const graphLevel = useAppStore(s => s.graphLevel)
  const graphClipId = useAppStore(s => s.graphClipId)
  const graphCompoundPath = useAppStore(s => s.graphCompoundPath)
  const exitCompound = useAppStore(s => s.exitCompound)

  return (
    <>
      <div className="panel__header">
        <span className="panel__header-title">
          Inspector
          <span className="inspector__context-badge">
            {inspectorContext === 'node' ? ' — Node' : inspectorContext === 'clip' ? ' — Clip' : inspectorContext === 'track' ? ' — Track' : ''}
          </span>
        </span>
      </div>
      <div className="panel__content inspector__content">
        {graphCompoundPath.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', marginBottom: 8, background: 'rgba(255,0,170,0.08)', borderRadius: 4 }}>
            <button className="inspector__btn" style={{ fontSize: 10, padding: '2px 6px' }} onClick={exitCompound}>← Back</button>
            <span className="mono" style={{ fontSize: 10, color: '#ff00aa' }}>{graphCompoundPath.length} level{graphCompoundPath.length !== 1 ? 's' : ''} deep</span>
          </div>
        )}
        {inspectorContext === 'project' && <ProjectInspector />}
        {inspectorContext === 'node' && <NodeInspector nodeId={selectedNodeId} graphLevel={graphLevel} clipId={graphClipId} />}
        {inspectorContext === 'clip' && <ClipInspector clipId={selectedClipId} />}
        {inspectorContext === 'track' && <TrackInspector trackId={selectedTrackId} />}
      </div>
    </>
  )
}

function ProjectInspector() {
  const fps = useAppStore(s => s.fps)
  const resolution = useAppStore(s => s.resolution)
  const setFps = useAppStore(s => s.setFps)
  const setResolution = useAppStore(s => s.setResolution)

  return (
    <div className="inspector__section">
      <div className="inspector__section-header">Project Settings</div>
      <div className="inspector__field">
        <label className="inspector__label">Frame Rate</label>
        <select className="inspector__select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
          <option value={23.976}>23.976</option><option value={24}>24</option><option value={25}>25</option>
          <option value={29.97}>29.97</option><option value={30}>30</option><option value={48}>48</option><option value={60}>60</option>
        </select>
      </div>
      <div className="inspector__field">
        <label className="inspector__label">Resolution</label>
        <div className="inspector__field-row">
          <input className="inspector__input inspector__input--small" type="number" value={resolution.width} onChange={(e) => setResolution(Number(e.target.value), resolution.height)} />
          <span className="inspector__separator">×</span>
          <input className="inspector__input inspector__input--small" type="number" value={resolution.height} onChange={(e) => setResolution(resolution.width, Number(e.target.value))} />
        </div>
      </div>
      <div className="inspector__field"><label className="inspector__label">Color Space</label><span className="inspector__value">sRGB</span></div>
      <div className="inspector__section-header" style={{ marginTop: 16 }}>Shader Settings</div>
      <div className="inspector__field"><label className="inspector__label">Precision</label><span className="inspector__value inspector__value--mono">highp float</span></div>
      <div className="inspector__field"><label className="inspector__label">Dithering</label><label className="inspector__toggle"><input type="checkbox" /><span className="inspector__toggle-slider" /></label></div>
    </div>
  )
}

function NodeInspector({ nodeId, graphLevel, clipId }) {
  const graph = useGraphStore(s => graphLevel === 'master' ? s.masterGraph : s.clipGraphs[clipId])
  const setNodeParam = useGraphStore(s => s.setNodeParam)
  const updateNode = useGraphStore(s => s.updateNode)
  const openMonaco = useAppStore(s => s.openMonaco)
  const updateExposedCompoundParam = useGraphStore(s => s.updateExposedCompoundParam)
  const expandCompoundNode = useGraphStore(s => s.expandCompoundNode)
  const enterCompound = useAppStore(s => s.enterCompound)

  // ── Keyframes ──
  const keyframes = useTimelineStore(s => s.keyframes)
  const addKeyframe = useTimelineStore(s => s.addKeyframe)
  const removeKeyframe = useTimelineStore(s => s.removeKeyframe)
  const clips = useTimelineStore(s => s.clips)
  const playheadTime = useAppStore(s => s.playheadTime)
  const fps = useAppStore(s => s.fps)

  const node = graph?.nodes.find(n => n.id === nodeId)
  if (!node) return <div className="inspector__empty">No node selected</div>

  // Keyframe context: clip-graph params key against the clip (clip-relative
  // time), master-graph params key against 'master' (absolute time).
  const kfClipKey = graphLevel === 'master' ? 'master' : clipId
  const kfClip = graphLevel === 'master' ? null : clips.find(c => c.id === clipId)
  const kfLocalTime = kfClip ? Math.max(0, playheadTime - kfClip.timelineStart) : playheadTime
  const kfTolerance = 0.5 / (fps || 30)

  const getTrack = (paramName) => keyframes.find(
    k => k.clipId === kfClipKey && k.nodeId === nodeId && k.paramName === paramName
  )
  const toggleKeyframe = (paramName, currentValue) => {
    const track = getTrack(paramName)
    const existing = track && keyAtTime(track.keys, kfLocalTime, kfTolerance)
    if (existing) removeKeyframe(kfClipKey, nodeId, paramName, existing.time)
    else addKeyframe(kfClipKey, nodeId, paramName, kfLocalTime, currentValue)
  }

  if (node.type === 'COMPOUND') {
    return (
      <CompoundInspector
        node={node} graphLevel={graphLevel} clipId={clipId}
        onUpdateExposedParam={(epIdx, val) => updateExposedCompoundParam(graphLevel, clipId, nodeId, epIdx, val)}
        onExpand={() => expandCompoundNode(graphLevel, clipId, nodeId)}
        onEnter={() => enterCompound(nodeId)}
      />
    )
  }

  const shaderSrc = getNodeSource(node)
  const paramConfigs = parseParams(shaderSrc)
  const isParamConnected = (paramName) => {
    return graph?.edges?.some(edge => edge.toNode === nodeId && edge.toSocket === paramName) || false
  }

  return (
    <div className="inspector__section">
      <div className="inspector__section-header">Node: {node.name}</div>
      <div className="inspector__field">
        <label className="inspector__label">Type</label>
        <span className="inspector__value inspector__value--mono">{node.type}</span>
      </div>
      <div className="inspector__field">
        <label className="inspector__label">Bypassed</label>
        <label className="inspector__toggle">
          <input type="checkbox" checked={node.bypassed} onChange={() => updateNode(graphLevel, clipId, nodeId, { bypassed: !node.bypassed })} />
          <span className="inspector__toggle-slider" />
        </label>
      </div>
      <div className="inspector__field">
        <label className="inspector__label">Position</label>
        <span className="inspector__value inspector__value--mono">{Math.round(node.position.x)}, {Math.round(node.position.y)}</span>
      </div>
      {getNodeSource(node) != null && !node.locked && (
        <button className="inspector__btn inspector__btn--primary" onClick={() => openMonaco(nodeId)} style={{ marginTop: 8 }}>Edit Shader Code</button>
      )}
      {paramConfigs.length > 0 && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 16 }}>Parameters</div>
          {paramConfigs.map(param => {
            const keyframable = param.type === 'slider'
            const track = keyframable ? getTrack(param.uniformName) : null
            const keyHere = track ? keyAtTime(track.keys, kfLocalTime, kfTolerance) : null
            const value = node.params[param.uniformName] ?? param.default
            return (
              <div key={param.uniformName} className="inspector__param-row">
                {keyframable && (
                  <button
                    className={`inspector__kf-btn ${keyHere ? 'inspector__kf-btn--on' : ''} ${track && !keyHere ? 'inspector__kf-btn--track' : ''}`}
                    title={keyHere ? 'Remove keyframe at playhead' : (track ? 'Add keyframe at playhead (param is animated)' : 'Add keyframe at playhead')}
                    onClick={() => toggleKeyframe(param.uniformName, value)}
                  >
                    ◆
                  </button>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <InspectorParam nodeId={nodeId} param={param}
                    value={value}
                    onChange={(val) => {
                      setNodeParam(graphLevel, clipId, nodeId, param.uniformName, val)
                      // Auto-key: while a param is animated, slider edits write a
                      // key at the playhead (standard NLE behaviour) — otherwise
                      // the change would be silently overridden by the animation.
                      if (track) addKeyframe(kfClipKey, nodeId, param.uniformName, kfLocalTime, val)
                    }}
                    isConnected={isParamConnected(param.uniformName)} />
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function CompoundInspector({ node, graphLevel, clipId, onUpdateExposedParam, onExpand, onEnter }) {
  const [showAllParams, setShowAllParams] = useState(false)
  const exposedParams = node.exposedParams || []
  const subGraph = node.subGraph
  const innerNodes = subGraph?.nodes?.filter(n => n.type !== 'EFFECT_INPUT' && n.type !== 'EFFECT_OUTPUT') || []

  // Gather all inner params grouped by node
  const innerParamsByNode = []
  for (const innerNode of innerNodes) {
    let params
    if (innerNode.type === 'MATH') {
      params = [
        { name: 'Value A', uniformName: 'value_a', type: 'slider', min: -100, max: 100, step: 0.01, default: 0 },
        { name: 'Value B', uniformName: 'value_b', type: 'slider', min: -100, max: 100, step: 0.01, default: 1 },
      ]
    } else {
      const shaderSrc = getNodeSource(innerNode)
      params = shaderSrc ? parseParams(shaderSrc) : []
    }
    if (params.length > 0) {
      innerParamsByNode.push({ node: innerNode, params })
    }
  }

  const innerParamCount = innerParamsByNode.reduce((sum, g) => sum + g.params.length, 0)

  return (
    <div className="inspector__section">
      <div className="inspector__section-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="node-card__compound-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: node.color || '#ff00aa', display: 'inline-block' }} />
        <span>Compound: {node.name}</span>
      </div>
      {node.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>{node.description}</div>}
      <div className="inspector__field">
        <label className="inspector__label">Nodes</label>
        <span className="inspector__value inspector__value--mono">{node.nodeCount}</span>
      </div>
      <div className="inspector__field">
        <label className="inspector__label">Exposed Params</label>
        <span className="inspector__value inspector__value--mono">{exposedParams.length}</span>
      </div>

      {exposedParams.length > 0 && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 16 }}>Exposed Parameters</div>
          {exposedParams.map((ep, i) => (
            <CompoundParamRow key={i} ep={ep} onChange={(val) => onUpdateExposedParam(i, val)} />
          ))}
        </>
      )}

      {innerParamCount > 0 && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 16, cursor: 'pointer' }} onClick={() => setShowAllParams(!showAllParams)}>
            {showAllParams ? '▾' : '▸'} All Parameters ({innerParamCount})
          </div>
          {showAllParams && innerParamsByNode.map(({ node: innerNode, params }) => (
            <div key={innerNode.id} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--text-disabled)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, paddingLeft: 4 }}>
                {innerNode.name}
              </div>
              {params.map(param => {
                const currentValue = innerNode.params?.[param.uniformName] ?? param.default
                return (
                  <CompoundInnerParamRow key={param.uniformName} innerNodeId={innerNode.id} param={param}
                    value={currentValue} compoundNode={node} graphLevel={graphLevel} clipId={clipId} />
                )
              })}
            </div>
          ))}
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="inspector__btn inspector__btn--primary" onClick={onEnter} style={{ flex: 1 }}>Edit Inside</button>
        <button className="inspector__btn" onClick={onExpand}>Expand</button>
      </div>
    </div>
  )
}

function CompoundParamRow({ ep, onChange }) {
  const param = ep.paramConfig
  const value = ep.value
  const label = ep.displayName

  if (param.type === 'checkbox') {
    return (
      <div className="inspector__field">
        <label className="inspector__label">{label}</label>
        <label className="inspector__toggle">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span className="inspector__toggle-slider" />
        </label>
      </div>
    )
  }
  if (param.type === 'select') {
    return (
      <div className="inspector__field">
        <label className="inspector__label">{label}</label>
        <select className="inspector__select"
          value={typeof value === 'number' ? (param.options?.[value] || value) : value}
          onChange={(e) => { const idx = param.options?.indexOf(e.target.value); onChange(idx >= 0 ? idx : e.target.value) }}
        >
          {param.options?.map((opt, i) => <option key={i} value={opt}>{opt}</option>)}
        </select>
      </div>
    )
  }
  if (param.type === 'color') {
    return (
      <div className="inspector__field">
        <label className="inspector__label">{label}</label>
        <input type="color" value={value || '#ffffff'} onChange={(e) => onChange(e.target.value)}
          style={{ width: 32, height: 20, border: '1px solid var(--border-default)', borderRadius: '3px', padding: 0 }} />
      </div>
    )
  }
  return (
    <div className="inspector__field">
      <label className="inspector__label">{label}</label>
      <div className="inspector__slider">
        <input type="range" min={param.min} max={param.max} step={param.step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))} />
        <span className="inspector__slider-value mono">{Number(value).toFixed(2)}</span>
      </div>
    </div>
  )
}

function CompoundInnerParamRow({ innerNodeId, param, value, compoundNode, graphLevel, clipId }) {
  const updateNode = useGraphStore(s => s.updateNode)
  const currentValue = value

  const handleChange = (newVal) => {
    // Find the compound node in the graph and update the inner node param
    const graph = graphLevel === 'master'
      ? useGraphStore.getState().masterGraph
      : useGraphStore.getState().clipGraphs[clipId]
    const compound = graph?.nodes?.find(n => n.id === compoundNode.id)
    if (!compound?.subGraph) return

    // Deep-update the inner node param inside the compound's subGraph
    const newSubGraph = {
      ...compound.subGraph,
      nodes: compound.subGraph.nodes.map(n =>
        n.id === innerNodeId
          ? { ...n, params: { ...n.params, [param.uniformName]: newVal } }
          : n
      ),
    }
    updateNode(graphLevel, clipId, compoundNode.id, { subGraph: newSubGraph })
  }

  if (param.type === 'checkbox') {
    return (
      <div className="inspector__field">
        <label className="inspector__label" style={{ fontSize: 11, paddingLeft: 8 }}>{param.name}</label>
        <label className="inspector__toggle">
          <input type="checkbox" checked={!!currentValue} onChange={(e) => handleChange(e.target.checked)} />
          <span className="inspector__toggle-slider" />
        </label>
      </div>
    )
  }
  if (param.type === 'select') {
    return (
      <div className="inspector__field">
        <label className="inspector__label" style={{ fontSize: 11, paddingLeft: 8 }}>{param.name}</label>
        <select className="inspector__select"
          value={typeof currentValue === 'number' ? (param.options?.[currentValue] || currentValue) : currentValue}
          onChange={(e) => { const idx = param.options?.indexOf(e.target.value); handleChange(idx >= 0 ? idx : e.target.value) }}
        >
          {param.options?.map((opt, i) => <option key={i} value={opt}>{opt}</option>)}
        </select>
      </div>
    )
  }
  if (param.type === 'color') {
    return (
      <div className="inspector__field">
        <label className="inspector__label" style={{ fontSize: 11, paddingLeft: 8 }}>{param.name}</label>
        <input type="color" value={currentValue || '#ffffff'} onChange={(e) => handleChange(e.target.value)}
          style={{ width: 32, height: 20, border: '1px solid var(--border-default)', borderRadius: '3px', padding: 0 }} />
      </div>
    )
  }
  return (
    <div className="inspector__field">
      <label className="inspector__label" style={{ fontSize: 11, paddingLeft: 8 }}>{param.name}</label>
      <div className="inspector__slider">
        <input type="range" min={param.min} max={param.max} step={param.step} value={currentValue}
          onChange={(e) => handleChange(parseFloat(e.target.value))} />
        <span className="inspector__slider-value mono">{Number(currentValue).toFixed(2)}</span>
      </div>
    </div>
  )
}

function ClipInspector({ clipId }) {
  const clips = useTimelineStore(s => s.clips)
  const updateClip = useTimelineStore(s => s.updateClip)
  const enterClipGraph = useAppStore(s => s.enterClipGraph)
  const compoundLibrary = useGraphStore(s => s.compoundLibrary)
  const clip = clips.find(c => c.id === clipId)
  if (!clip) return <div className="inspector__empty">No clip selected</div>

  const isVideoClip = clip.fileType === 'video' || clip.fileType === 'camera'

  // Node-graph transitions: any library compound with ≥ 2 image inputs.
  const transitionCompounds = compoundLibrary.filter(isTransitionCompound)
  const isCompoundTransition = clip.transition?.type?.startsWith('compound:')
  const compoundEntry = isCompoundTransition
    ? transitionCompounds.find(c => `compound:${c.id}` === clip.transition.type) || null
    : null

  // The previous clip on this track that overlaps this clip's start — the
  // transition-in plays across that overlap window.
  const prevOverlap = clips
    .filter(c => c.trackId === clip.trackId && c.id !== clip.id &&
      c.timelineStart < clip.timelineStart && c.timelineEnd > clip.timelineStart)
    .sort((a, b) => b.timelineStart - a.timelineStart)[0] || null
  const overlapDur = prevOverlap
    ? Math.min(prevOverlap.timelineEnd, clip.timelineEnd) - clip.timelineStart
    : 0

  return (
    <div className="inspector__section">
      <div className="inspector__section-header">Clip: {clip.filename}</div>
      <div className="inspector__field"><label className="inspector__label">Start</label><span className="inspector__value inspector__value--mono">{clip.timelineStart.toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">End</label><span className="inspector__value inspector__value--mono">{clip.timelineEnd.toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">Duration</label><span className="inspector__value inspector__value--mono">{(clip.timelineEnd - clip.timelineStart).toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">Speed</label><div className="inspector__slider"><input type="range" min={0.1} max={4} step={0.05} value={clip.speed || 1} onChange={(e) => updateClip(clipId, { speed: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(clip.speed || 1).toFixed(2)}×</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Opacity</label><div className="inspector__slider"><input type="range" min={0} max={1} step={0.01} value={clip.opacity || 1} onChange={(e) => updateClip(clipId, { opacity: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{((clip.opacity || 1) * 100).toFixed(0)}%</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Blend Mode</label><BlendModeSelect allowInherit value={clip.blendMode || 'Inherit'} onChange={(v) => updateClip(clipId, { blendMode: v })} /></div>
      <div className="inspector__field"><label className="inspector__label">Fade In</label><div className="inspector__slider"><input type="range" min={0} max={Math.max(0.1, clip.timelineEnd - clip.timelineStart)} step={0.05} value={clip.fadeIn || 0} onChange={(e) => updateClip(clipId, { fadeIn: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(clip.fadeIn || 0).toFixed(2)}s</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Fade Out</label><div className="inspector__slider"><input type="range" min={0} max={Math.max(0.1, clip.timelineEnd - clip.timelineStart)} step={0.05} value={clip.fadeOut || 0} onChange={(e) => updateClip(clipId, { fadeOut: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(clip.fadeOut || 0).toFixed(2)}s</span></div></div>

      {(clip.fileType === 'video' || clip.fileType === 'audio') && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 12 }}>Audio</div>
          <div className="inspector__field">
            <label className="inspector__label">Mute Audio</label>
            <label className="inspector__toggle">
              <input type="checkbox" checked={!!clip.audioMuted} onChange={(e) => updateClip(clipId, { audioMuted: e.target.checked })} />
              <span className="inspector__toggle-slider" />
            </label>
          </div>
          <div className="inspector__field"><label className="inspector__label">Volume</label><div className="inspector__slider"><input type="range" min={0} max={1} step={0.01} value={clip.volume == null ? 1 : clip.volume} onChange={(e) => updateClip(clipId, { volume: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{((clip.volume == null ? 1 : clip.volume) * 100).toFixed(0)}%</span></div></div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '0 8px 6px' }}>
            Audio follows the clip's fades; transitions crossfade it automatically
          </div>
        </>
      )}

      {isVideoClip && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 12 }}>Transition In</div>
          <div className="inspector__field">
            <label className="inspector__label">Type</label>
            <select
              className="inspector__select"
              value={clip.transition?.type || ''}
              onChange={(e) => {
                const type = e.target.value
                // Built-ins start from registry defaults; compound transitions
                // start empty — the entry's exposedParams carry their defaults.
                const params = type && !type.startsWith('compound:') ? getTransitionDefaults(type) : {}
                updateClip(clipId, { transition: type ? { type, params } : null })
              }}
            >
              <option value="">None</option>
              <optgroup label="Built-in">
                {TRANSITION_TYPES.map(t => <option key={t} value={t}>{getTransitionLabel(t)}</option>)}
              </optgroup>
              {transitionCompounds.length > 0 && (
                <optgroup label="Custom (Node Graph)">
                  {transitionCompounds.map(c => (
                    <option key={c.id} value={`compound:${c.id}`}>{c.name}</option>
                  ))}
                </optgroup>
              )}
              {isCompoundTransition && !compoundEntry && (
                <option value={clip.transition.type} disabled>(missing compound)</option>
              )}
            </select>
          </div>
          {clip.transition?.type && (
            <>
              {overlapDur > 0 ? (
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '2px 8px 6px' }}>
                  Plays over the {overlapDur.toFixed(2)}s overlap with “{prevOverlap.filename}”
                </div>
              ) : (
                <div style={{ fontSize: 10, color: 'var(--accent-amber)', padding: '2px 8px 6px' }}>
                  No overlap — drag this clip so it overlaps the previous clip on this track to activate
                </div>
              )}
              {isCompoundTransition && !compoundEntry && (
                <div style={{ fontSize: 10, color: 'var(--accent-amber)', padding: '2px 8px 6px' }}>
                  This node transition is no longer in the compound library — the clip falls back to its blend mode
                </div>
              )}
              {/* Built-in transitions: params parsed from the registry shader */}
              {!isCompoundTransition && getTransitionParams(clip.transition.type).map(param => (
                <InspectorParam
                  key={param.uniformName}
                  nodeId={clipId}
                  param={param}
                  value={clip.transition.params?.[param.uniformName] ?? param.default}
                  onChange={(v) => updateClip(clipId, {
                    transition: { ...clip.transition, params: { ...clip.transition.params, [param.uniformName]: v } },
                  })}
                  isConnected={false}
                />
              ))}
              {/* Node transitions: the compound's exposed params, keyed by index */}
              {compoundEntry && (compoundEntry.exposedParams || []).map((ep, i) => (
                <InspectorParam
                  key={`${compoundEntry.id}_${i}`}
                  nodeId={clipId}
                  param={{ ...ep.paramConfig, name: ep.displayName || ep.paramConfig?.name }}
                  value={clip.transition.params?.[i] ?? ep.value ?? ep.paramConfig?.default}
                  onChange={(v) => updateClip(clipId, {
                    transition: { ...clip.transition, params: { ...clip.transition.params, [i]: v } },
                  })}
                  isConnected={false}
                />
              ))}
            </>
          )}
        </>
      )}

      <button className="inspector__btn inspector__btn--primary" onClick={() => enterClipGraph(clipId)} style={{ marginTop: 12 }}>Open Effect Graph</button>
    </div>
  )
}

function TrackInspector({ trackId }) {
  const tracks = useTimelineStore(s => s.tracks)
  const updateTrack = useTimelineStore(s => s.updateTrack)
  const removeTrack = useTimelineStore(s => s.removeTrack)
  const track = tracks.find(t => t.id === trackId)
  if (!track) return <div className="inspector__empty">No track selected</div>

  return (
    <div className="inspector__section">
      <div className="inspector__section-header">Track: {track.name}</div>
      <div className="inspector__field"><label className="inspector__label">Name</label><input className="inspector__input" type="text" value={track.name} onChange={(e) => updateTrack(trackId, { name: e.target.value })} /></div>
      <div className="inspector__field"><label className="inspector__label">Type</label><span className="inspector__value">{track.type}</span></div>
      <div className="inspector__field"><label className="inspector__label">Opacity</label><div className="inspector__slider"><input type="range" min={0} max={1} step={0.01} value={track.opacity} onChange={(e) => updateTrack(trackId, { opacity: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(track.opacity * 100).toFixed(0)}%</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Blend Mode</label><BlendModeSelect value={track.blendMode || 'Normal'} onChange={(v) => updateTrack(trackId, { blendMode: v })} /></div>
      <button className="inspector__btn" onClick={() => removeTrack(trackId)} style={{ marginTop: 12, color: 'var(--status-error)' }}>Delete Track</button>
    </div>
  )
}

function InspectorParam({ nodeId, param, value, onChange, isConnected }) {
  if (param.type === 'checkbox') {
    return (
      <div className={`inspector__field ${isConnected ? 'inspector__field--disabled' : ''}`}>
        <label className="inspector__label">{param.name}</label>
        <label className="inspector__toggle">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={isConnected} />
          <span className="inspector__toggle-slider" />
        </label>
      </div>
    )
  }
  if (param.type === 'color') {
    return (
      <div className={`inspector__field ${isConnected ? 'inspector__field--disabled' : ''}`}>
        <label className="inspector__label">{param.name}</label>
        <input type="color" value={value || '#ffffff'} onChange={(e) => onChange(e.target.value)} disabled={isConnected}
          style={{ width: 32, height: 20, border: '1px solid var(--border-default)', borderRadius: '3px', padding: 0 }} />
      </div>
    )
  }
  if (param.type === 'select') {
    return (
      <div className={`inspector__field ${isConnected ? 'inspector__field--disabled' : ''}`}>
        <label className="inspector__label">{param.name}</label>
        <select className="inspector__select"
          value={typeof value === 'number' ? (param.options?.[value] || value) : value}
          onChange={(e) => { const idx = param.options?.indexOf(e.target.value); onChange(idx >= 0 ? idx : e.target.value) }}
          disabled={isConnected}
        >
          {param.options?.map((opt, i) => <option key={i} value={opt}>{opt}</option>)}
        </select>
      </div>
    )
  }
  return (
    <div className={`inspector__field ${isConnected ? 'inspector__field--disabled' : ''}`}>
      <label className="inspector__label">{param.name}</label>
      <div className="inspector__slider">
        <input type="range" min={param.min} max={param.max} step={param.step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))} disabled={isConnected} />
        <span className="inspector__slider-value mono" data-node-id={nodeId} data-node-param-display={param.uniformName}>
          {isConnected ? '⚡ ' + Number(value).toFixed(2) : Number(value).toFixed(2)}
        </span>
      </div>
    </div>
  )
}
