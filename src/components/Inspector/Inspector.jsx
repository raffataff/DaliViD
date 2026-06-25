import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import { parseParams } from '../../utils/paramParser'
import { getNodeSource } from '../../shaders/shaderRegistry'
import { parseParams as parseShaderParams } from '../../utils/paramParser'
import './Inspector.css'

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

  const node = graph?.nodes.find(n => n.id === nodeId)
  if (!node) return <div className="inspector__empty">No node selected</div>

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
          {paramConfigs.map(param => (
            <InspectorParam key={param.uniformName} nodeId={nodeId} param={param}
              value={node.params[param.uniformName] ?? param.default}
              onChange={(val) => setNodeParam(graphLevel, clipId, nodeId, param.uniformName, val)}
              isConnected={isParamConnected(param.uniformName)} />
          ))}
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
  const clip = clips.find(c => c.id === clipId)
  if (!clip) return <div className="inspector__empty">No clip selected</div>

  return (
    <div className="inspector__section">
      <div className="inspector__section-header">Clip: {clip.filename}</div>
      <div className="inspector__field"><label className="inspector__label">Start</label><span className="inspector__value inspector__value--mono">{clip.timelineStart.toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">End</label><span className="inspector__value inspector__value--mono">{clip.timelineEnd.toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">Duration</label><span className="inspector__value inspector__value--mono">{(clip.timelineEnd - clip.timelineStart).toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">Speed</label><div className="inspector__slider"><input type="range" min={0.1} max={4} step={0.05} value={clip.speed || 1} onChange={(e) => updateClip(clipId, { speed: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(clip.speed || 1).toFixed(2)}×</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Opacity</label><div className="inspector__slider"><input type="range" min={0} max={1} step={0.01} value={clip.opacity || 1} onChange={(e) => updateClip(clipId, { opacity: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{((clip.opacity || 1) * 100).toFixed(0)}%</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Blend Mode</label><select className="inspector__select" value={clip.blendMode || 'Normal'} onChange={(e) => updateClip(clipId, { blendMode: e.target.value })}><option>Normal</option><option>Multiply</option><option>Screen</option><option>Overlay</option><option>Add</option><option>Difference</option></select></div>
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
      <div className="inspector__field"><label className="inspector__label">Blend Mode</label><select className="inspector__select" value={track.blendMode} onChange={(e) => updateTrack(trackId, { blendMode: e.target.value })}><option>Normal</option><option>Multiply</option><option>Screen</option><option>Overlay</option><option>Add</option><option>Difference</option></select></div>
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
