import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import { parseParams } from '../../utils/paramParser'
import { prepareImageDataURL } from '../../utils/imageProcessing'
import { TEXT_FONTS } from '../../utils/textRenderer'
import { getNodeSource, getShaderSource } from '../../shaders/shaderRegistry'
import { getDataNodeParams, visibleDataParams } from '../../shaders/dataNodeParams'
import { SHAPE_PRESETS } from '../../utils/generatorClips'
import { ASPECT_PRESETS } from '../../utils/aspectPresets'
import { BLEND_MODE_NAMES } from '../../gl/BlendModes.glsl.js'
import { TRANSITION_TYPES, getTransitionLabel, getTransitionParams, getTransitionDefaults } from '../../shaders/transitionRegistry.js'
import { isTransitionCompound } from '../../utils/compoundUtils'
import { keyAtTime } from '../../utils/keyframes'
import { CLIP_TRANSFORM_NODE_ID, getTransformConfigs, clipSupportsTransform } from '../../utils/clipTransform'
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
  const masterBars = useAppStore(s => s.masterBars)
  const setMasterBars = useAppStore(s => s.setMasterBars)

  const bars = masterBars || {}
  const projectAspect = resolution.height ? resolution.width / resolution.height : 16 / 9
  const barAxis = (bars.aspect || 2.39) < projectAspect ? 'vertical (pillarbox)' : 'horizontal (letterbox)'

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

      {/* ── Widescreen bars ──
          Final pass of the master pipeline, so it shows in the preview and bakes
          into exports. Per-clip / per-graph framing is the LETTERBOX node. */}
      <div className="inspector__section-header" style={{ marginTop: 16 }}>Widescreen Bars</div>
      <FieldCheck label="Enabled" value={bars.enabled} onChange={(v) => setMasterBars({ enabled: v })} />
      <FieldSelect label="Aspect" value={String(bars.aspect ?? 2.39)}
        options={ASPECT_PRESETS.map(a => ({ label: a.label, value: String(a.value) }))}
        onChange={(v) => setMasterBars({ aspect: parseFloat(v) })} />
      <FieldColor label="Bar Color" value={bars.color} def="#000000" onChange={(v) => setMasterBars({ color: v })} />
      <FieldNum label="Bar Opacity" value={bars.opacity} def={1} min={0} max={1} step={0.01} onChange={(v) => setMasterBars({ opacity: v })} />
      <FieldNum label="Feather" value={bars.feather} def={0} min={0} max={0.2} step={0.002} onChange={(v) => setMasterBars({ feather: v })} />
      <FieldNum label="Offset" value={bars.offset} def={0} min={-1} max={1} step={0.01} onChange={(v) => setMasterBars({ offset: v })} />
      <FieldNum label="Zoom to Fill" value={bars.zoom} def={0} min={0} max={1} step={0.01} onChange={(v) => setMasterBars({ zoom: v })} />
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '0 8px 6px' }}>
        {resolution.width}×{resolution.height} is {projectAspect.toFixed(2)}:1 — bars will be {barAxis}
      </div>

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
  // Shaderless data nodes (MATH / ENVELOPE / TRANSITION_PROGRESS / RAMP / LFO)
  // have no @param directives, so their controls come from the shared table —
  // which also gives them Inspector-side keyframing, like every other param.
  const allParamConfigs = shaderSrc ? parseParams(shaderSrc) : getDataNodeParams(node.type)
  const isParamConnected = (paramName) => {
    return graph?.edges?.some(edge => edge.toNode === nodeId && edge.toSocket === paramName) || false
  }
  // Hide controls a `showIf` rules out (Beats/Cycle with Beat Sync off, …), but
  // never one that's wired — a connected param must stay inspectable.
  const connectedParams = new Set(
    (graph?.edges || []).filter(e => e.toNode === nodeId).map(e => e.toSocket)
  )
  const paramConfigs = visibleDataParams(allParamConfigs, node.params, connectedParams)

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
      {node.type === 'TEXT_INPUT' && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 16 }}>Text</div>
          <TextStyleEditor
            params={node.params || {}}
            onChange={(key, value) => setNodeParam(graphLevel, clipId, nodeId, key, value)}
            includeTransform={false}
          />
        </>
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
    // Shaderless data nodes (MATH / ENVELOPE / TRANSITION_PROGRESS / RAMP / LFO)
    // get their configs from the shared table; everything else parses its shader.
    let params = getDataNodeParams(innerNode.type)
    if (!params.length) {
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

// ── Reusable field rows for the text/image editors ──
function FieldNum({ label, value, def, min, max, step, onChange }) {
  const v = value == null ? def : value
  const decimals = step < 1 ? 2 : 0
  return (
    <div className="inspector__field">
      <label className="inspector__label">{label}</label>
      <div className="inspector__slider">
        <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => onChange(parseFloat(e.target.value))} />
        <span className="inspector__slider-value">{Number(v).toFixed(decimals)}</span>
      </div>
    </div>
  )
}
function FieldColor({ label, value, def, onChange }) {
  return (
    <div className="inspector__field">
      <label className="inspector__label">{label}</label>
      <input type="color" value={value || def || '#000000'} onChange={(e) => onChange(e.target.value)}
        style={{ width: 44, height: 22, padding: 0, border: '1px solid var(--border, #2a2a35)', background: 'transparent', borderRadius: 3, cursor: 'pointer' }} />
    </div>
  )
}
function FieldSelect({ label, value, options, onChange }) {
  return (
    <div className="inspector__field">
      <label className="inspector__label">{label}</label>
      <select className="inspector__select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}
function FieldCheck({ label, value, onChange }) {
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

// Text style editor — shared by text clips and TEXT_INPUT nodes. `includeTransform`
// adds the shader-uniform transform/reactive controls (clips only; on a node those
// already show as @param sliders in the Parameters section).
function TextStyleEditor({ params, onChange, includeTransform = true }) {
  const p = params || {}
  const WEIGHTS = [['Light', '300'], ['Regular', '400'], ['Medium', '500'], ['Semibold', '600'], ['Bold', '700'], ['Heavy', '800'], ['Black', '900']]
  return (
    <>
      <div className="inspector__field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <label className="inspector__label" style={{ marginBottom: 4 }}>Text</label>
        <textarea rows={2} value={p.text ?? ''} spellCheck={false} onChange={(e) => onChange('text', e.target.value)}
          style={{ resize: 'vertical', width: '100%', background: '#0a0a0e', color: '#e8e8ef', border: '1px solid #2a2a35', borderRadius: 3, padding: '4px 6px', fontSize: 12 }} />
      </div>
      <FieldSelect label="Font" value={p.fontFamily ?? TEXT_FONTS[0].value} options={TEXT_FONTS.map(f => ({ label: f.label, value: f.value }))} onChange={(v) => onChange('fontFamily', v)} />
      <FieldNum label="Size" value={p.fontSize} def={96} min={8} max={400} step={1} onChange={(v) => onChange('fontSize', v)} />
      <FieldSelect label="Weight" value={String(p.fontWeight ?? '700')} options={WEIGHTS.map(([label, value]) => ({ label, value }))} onChange={(v) => onChange('fontWeight', v)} />
      <FieldCheck label="Italic" value={p.italic} onChange={(v) => onChange('italic', v)} />
      <FieldColor label="Color" value={p.color} def="#ffffff" onChange={(v) => onChange('color', v)} />
      <FieldSelect label="Align" value={p.align ?? 'center'} options={[{ label: 'Left', value: 'left' }, { label: 'Center', value: 'center' }, { label: 'Right', value: 'right' }]} onChange={(v) => onChange('align', v)} />
      <FieldNum label="Position X" value={p.posX} def={0.5} min={0} max={1} step={0.01} onChange={(v) => onChange('posX', v)} />
      <FieldNum label="Position Y" value={p.posY} def={0.5} min={0} max={1} step={0.01} onChange={(v) => onChange('posY', v)} />
      <FieldNum label="Wrap Width" value={p.maxWidth} def={0.85} min={0.1} max={1} step={0.01} onChange={(v) => onChange('maxWidth', v)} />
      <FieldNum label="Line Height" value={p.lineHeight} def={1.2} min={0.8} max={2.5} step={0.05} onChange={(v) => onChange('lineHeight', v)} />
      <FieldNum label="Letter Spacing" value={p.letterSpacing} def={0} min={-10} max={40} step={0.5} onChange={(v) => onChange('letterSpacing', v)} />
      <div className="inspector__section-header" style={{ marginTop: 10 }}>Background Box</div>
      <FieldColor label="BG Color" value={p.bgColor} def="#000000" onChange={(v) => onChange('bgColor', v)} />
      <FieldNum label="BG Opacity" value={p.bgOpacity} def={0} min={0} max={1} step={0.01} onChange={(v) => onChange('bgOpacity', v)} />
      <FieldNum label="Padding" value={p.padding} def={18} min={0} max={120} step={1} onChange={(v) => onChange('padding', v)} />
      <div className="inspector__section-header" style={{ marginTop: 10 }}>Outline &amp; Shadow</div>
      <FieldColor label="Stroke" value={p.strokeColor} def="#000000" onChange={(v) => onChange('strokeColor', v)} />
      <FieldNum label="Stroke Width" value={p.strokeWidth} def={0} min={0} max={40} step={0.5} onChange={(v) => onChange('strokeWidth', v)} />
      <FieldColor label="Shadow" value={p.shadowColor} def="#000000" onChange={(v) => onChange('shadowColor', v)} />
      <FieldNum label="Shadow Blur" value={p.shadowBlur} def={0} min={0} max={60} step={0.5} onChange={(v) => onChange('shadowBlur', v)} />
      <FieldNum label="Shadow X" value={p.shadowX} def={0} min={-40} max={40} step={0.5} onChange={(v) => onChange('shadowX', v)} />
      <FieldNum label="Shadow Y" value={p.shadowY} def={0} min={-40} max={40} step={0.5} onChange={(v) => onChange('shadowY', v)} />
      {includeTransform && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 10 }}>Transform &amp; Reactive</div>
          <FieldNum label="Scale" value={p.u_txt_scale} def={1} min={0.1} max={4} step={0.01} onChange={(v) => onChange('u_txt_scale', v)} />
          <FieldNum label="Offset X" value={p.u_offset_x} def={0} min={-1} max={1} step={0.01} onChange={(v) => onChange('u_offset_x', v)} />
          <FieldNum label="Offset Y" value={p.u_offset_y} def={0} min={-1} max={1} step={0.01} onChange={(v) => onChange('u_offset_y', v)} />
          <FieldNum label="Rotation" value={p.u_txt_rot} def={0} min={-3.1416} max={3.1416} step={0.01} onChange={(v) => onChange('u_txt_rot', v)} />
          <FieldNum label="Bass Zoom" value={p.u_bass_zoom} def={0} min={0} max={1} step={0.01} onChange={(v) => onChange('u_bass_zoom', v)} />
          <FieldNum label="Beat Punch" value={p.u_beat_punch} def={0} min={0} max={1} step={0.01} onChange={(v) => onChange('u_beat_punch', v)} />
        </>
      )}
    </>
  )
}

// Image style editor — for image clips (fit/transform/reactive + replace). Image
// nodes edit the same values via their @param sliders + on-card loader.
function ImageStyleEditor({ params, onChange, onReplaceImage }) {
  const p = params || {}
  return (
    <>
      {onReplaceImage && (
        <button className="inspector__btn" style={{ marginBottom: 8 }} onClick={onReplaceImage}>
          {p.imageSrc ? 'Replace Image' : 'Load Image'}
        </button>
      )}
      <FieldSelect label="Fit" value={String(p.u_fit ?? 0)}
        options={[{ label: 'Cover', value: '0' }, { label: 'Contain', value: '1' }, { label: 'Stretch', value: '2' }, { label: 'Tile', value: '3' }]}
        onChange={(v) => onChange('u_fit', parseInt(v, 10))} />
      <FieldNum label="Scale" value={p.u_img_scale} def={1} min={0.1} max={4} step={0.01} onChange={(v) => onChange('u_img_scale', v)} />
      <FieldNum label="Offset X" value={p.u_offset_x} def={0} min={-1} max={1} step={0.01} onChange={(v) => onChange('u_offset_x', v)} />
      <FieldNum label="Offset Y" value={p.u_offset_y} def={0} min={-1} max={1} step={0.01} onChange={(v) => onChange('u_offset_y', v)} />
      <FieldNum label="Rotation" value={p.u_img_rot} def={0} min={-3.1416} max={3.1416} step={0.01} onChange={(v) => onChange('u_img_rot', v)} />
      <FieldColor label="Background" value={p.u_bg_color} def="#000000" onChange={(v) => onChange('u_bg_color', v)} />
      <FieldNum label="Bass Zoom" value={p.u_bass_zoom} def={0} min={0} max={1} step={0.01} onChange={(v) => onChange('u_bass_zoom', v)} />
      <FieldNum label="Beat Punch" value={p.u_beat_punch} def={0} min={0} max={1} step={0.01} onChange={(v) => onChange('u_beat_punch', v)} />
    </>
  )
}

// Shape editor — a shape is defined entirely by the SHAPE_INPUT shader's
// uniforms, so the controls are generated from the shader itself (same @param
// configs the node card parses). One source of truth: adding a @param to the
// shader surfaces it here and on the node with no extra UI code.
function ShapeStyleEditor({ params, onChange, onApplyPreset }) {
  const configs = parseParams(getShaderSource('SHAPE_INPUT'))
  const p = params || {}
  return (
    <>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', padding: '0 8px 8px' }}>
        {SHAPE_PRESETS.map(preset => (
          <button
            key={preset.id}
            className="inspector__btn"
            title={preset.name}
            onClick={() => onApplyPreset(preset)}
            style={{ width: 28, height: 24, padding: 0, fontSize: 13, lineHeight: 1 }}
          >
            {preset.icon}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '0 8px 6px' }}>
        Drag the handles in the Preview to move, scale and rotate
      </div>
      {configs.map(cfg => (
        <InspectorParam
          key={cfg.uniformName}
          nodeId={`shape_${cfg.uniformName}`}
          param={cfg}
          value={p[cfg.uniformName] ?? cfg.default}
          onChange={(v) => onChange(cfg.uniformName, v)}
          isConnected={false}
        />
      ))}
    </>
  )
}

// Per-clip Pan / Zoom / Rotate. The controls are generated from the TRANSFORM
// shader's own @param configs (utils/clipTransform.js) and the Renderer drives
// that same compiled program, so this section and an in-graph TRANSFORM node can
// never drift apart — add a @param to the shader and it shows up in both.
//
// Keyframes are stored against a reserved node id (CLIP_TRANSFORM_NODE_ID),
// which is what lets a clip animate a punch-in with no node graph at all. For a
// hands-off Ken Burns, a TIME node in the clip graph driving a TRANSFORM node's
// Zoom is the alternative — that one re-times itself when the clip is trimmed.
function ClipTransformEditor({ clip }) {
  const updateClip = useTimelineStore(s => s.updateClip)
  const keyframes = useTimelineStore(s => s.keyframes)
  const addKeyframe = useTimelineStore(s => s.addKeyframe)
  const removeKeyframe = useTimelineStore(s => s.removeKeyframe)
  const clearNodeKeyframes = useTimelineStore(s => s.clearNodeKeyframes)
  const playheadTime = useAppStore(s => s.playheadTime)
  const fps = useAppStore(s => s.fps)

  const configs = getTransformConfigs()
  const t = clip.transform || {}
  // Clip-relative, so the animation travels with the clip when it's moved.
  const localTime = Math.max(0, playheadTime - clip.timelineStart)
  const tolerance = 0.5 / (fps || 30)

  const getTrack = (paramName) => keyframes.find(
    k => k.clipId === clip.id && k.nodeId === CLIP_TRANSFORM_NODE_ID && k.paramName === paramName
  )
  const setParam = (paramName, value) => {
    updateClip(clip.id, { transform: { ...t, [paramName]: value } })
    // Auto-key while the param is animated — otherwise the edit would be
    // silently overridden by the animation on the very next frame.
    if (getTrack(paramName)) addKeyframe(clip.id, CLIP_TRANSFORM_NODE_ID, paramName, localTime, value)
  }
  const toggleKeyframe = (paramName, value) => {
    const track = getTrack(paramName)
    const existing = track && keyAtTime(track.keys, localTime, tolerance)
    if (existing) removeKeyframe(clip.id, CLIP_TRANSFORM_NODE_ID, paramName, existing.time)
    else addKeyframe(clip.id, CLIP_TRANSFORM_NODE_ID, paramName, localTime, value)
  }

  const hasKeys = keyframes.some(k => k.clipId === clip.id && k.nodeId === CLIP_TRANSFORM_NODE_ID)
  const isDefault = (!clip.transform || Object.keys(clip.transform).length === 0) && !hasKeys

  return (
    <>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '0 8px 6px' }}>
        Pan moves the <em>view</em>, so the picture slides the other way — like a camera.
        Key ◆ Zoom and Pan at two points for a punch-in.
      </div>
      {configs.map(cfg => {
        const keyframable = cfg.type === 'slider'
        const track = keyframable ? getTrack(cfg.uniformName) : null
        const keyHere = track ? keyAtTime(track.keys, localTime, tolerance) : null
        const value = t[cfg.uniformName] ?? cfg.default
        return (
          <div key={cfg.uniformName} className="inspector__param-row">
            {keyframable && (
              <button
                className={`inspector__kf-btn ${keyHere ? 'inspector__kf-btn--on' : ''} ${track && !keyHere ? 'inspector__kf-btn--track' : ''}`}
                title={keyHere ? 'Remove keyframe at playhead' : (track ? 'Add keyframe at playhead (param is animated)' : 'Add keyframe at playhead')}
                onClick={() => toggleKeyframe(cfg.uniformName, value)}
              >
                ◆
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <InspectorParam
                nodeId={`xf_${clip.id}`}
                param={cfg}
                value={value}
                onChange={(v) => setParam(cfg.uniformName, v)}
                isConnected={false}
              />
            </div>
          </div>
        )
      })}
      {/* Reset must clear the keyframe tracks too — leaving them would re-drive
          the transform on the very next frame and the reset would do nothing. */}
      <button
        className="inspector__btn"
        disabled={isDefault}
        onClick={() => {
          updateClip(clip.id, { transform: null })
          clearNodeKeyframes(clip.id, CLIP_TRANSFORM_NODE_ID)
        }}
        style={{ margin: '4px 8px 0' }}
      >
        Reset Transform{hasKeys ? ' + Keys' : ''}
      </button>
    </>
  )
}

function ClipInspector({ clipId }) {
  const clips = useTimelineStore(s => s.clips)
  const updateClip = useTimelineStore(s => s.updateClip)
  const enterClipGraph = useAppStore(s => s.enterClipGraph)
  const compoundLibrary = useGraphStore(s => s.compoundLibrary)
  const clip = clips.find(c => c.id === clipId)
  if (!clip) return <div className="inspector__empty">No clip selected</div>

  // Transitions apply to anything with a picture — including the text / image /
  // shape generators, which is where a blend-in matters most (a title card
  // dissolving in from nothing). Audio clips have no picture, so they're out.
  const supportsTransition = clipSupportsTransform(clip)

  // Merge one generator param into the clip, keeping the rest.
  const setParam = (key, value) => updateClip(clipId, { params: { ...clip.params, [key]: value } })
  // For a text clip, keep the timeline label in sync with the first line.
  const setTextParam = (key, value) => {
    const patch = { params: { ...clip.params, [key]: value } }
    if (key === 'text') patch.filename = (value || 'Text').split('\n')[0].slice(0, 24) || 'Text'
    updateClip(clipId, patch)
  }
  const replaceImage = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        const { dataUrl } = await prepareImageDataURL(file)
        updateClip(clipId, { params: { ...clip.params, imageSrc: dataUrl, imageName: file.name }, filename: file.name })
      } catch (err) { console.error('[DaliVid] Failed to load image:', err) }
    }
    input.click()
  }

  // Node-graph transitions: any library compound with ≥ 2 image inputs.
  const transitionCompounds = compoundLibrary.filter(isTransitionCompound)

  // The previous clip on this track that overlaps this clip's start — when one
  // exists it defines the transition-in window (and takes priority over the
  // fade handle, so existing overlap transitions time out exactly as before).
  const prevOverlap = clips
    .filter(c => c.trackId === clip.trackId && c.id !== clip.id &&
      c.timelineStart < clip.timelineStart && c.timelineEnd > clip.timelineStart)
    .sort((a, b) => b.timelineStart - a.timelineStart)[0] || null
  const overlapDur = prevOverlap
    ? Math.min(prevOverlap.timelineEnd, clip.timelineEnd) - clip.timelineStart
    : 0

  // A later clip overlapping this clip's fade-out window. If it runs its own
  // transition-in, that window is already spoken for and this clip's
  // transition-out is suppressed (the renderer makes the same call per frame).
  const fadeOutStart = clip.timelineEnd - Math.min(clip.fadeOut || 0, clip.timelineEnd - clip.timelineStart)
  const nextOverlap = clips
    .filter(c => c.trackId === clip.trackId && c.id !== clip.id && c.transition?.type &&
      c.timelineStart > clip.timelineStart && c.timelineStart < clip.timelineEnd &&
      c.timelineEnd > fadeOutStart)
    .sort((a, b) => a.timelineStart - b.timelineStart)[0] || null
  const nextOwnsWindow = !!nextOverlap

  // Duration hints. In: the overlap if there is one, else the fade-in handle
  // (blending in from whatever is underneath — the lower tracks, or nothing).
  // Out: always the fade-out handle.
  const inHint = overlapDur > 0.001
    ? { ok: true, text: `Plays over the ${overlapDur.toFixed(2)}s overlap with “${prevOverlap.filename}”` }
    : (clip.fadeIn > 0
      ? { ok: true, text: `No overlap — blends in from whatever is underneath over the ${(clip.fadeIn).toFixed(2)}s fade-in handle` }
      : { ok: false, text: 'Set a Fade In above (or drag the clip’s left fade handle) to give this a duration — or overlap the previous clip' })

  const outHint = nextOwnsWindow
    ? { ok: false, text: `“${nextOverlap.filename}” overlaps this clip’s end and runs its own transition-in, which owns that window` }
    : (clip.fadeOut > 0
      ? { ok: true, text: `Blends out to whatever is underneath over the ${(clip.fadeOut).toFixed(2)}s fade-out handle` }
      : { ok: false, text: 'Set a Fade Out above (or drag the clip’s right fade handle) to give this a duration' })

  return (
    <div className="inspector__section">
      <div className="inspector__section-header">Clip: {clip.filename}</div>
      <div className="inspector__field"><label className="inspector__label">Start</label><span className="inspector__value inspector__value--mono">{clip.timelineStart.toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">End</label><span className="inspector__value inspector__value--mono">{clip.timelineEnd.toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">Duration</label><span className="inspector__value inspector__value--mono">{(clip.timelineEnd - clip.timelineStart).toFixed(2)}s</span></div>
      <div className="inspector__field"><label className="inspector__label">Speed</label><div className="inspector__slider"><input type="range" min={0.1} max={4} step={0.05} value={clip.speed || 1} onChange={(e) => updateClip(clipId, { speed: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(clip.speed || 1).toFixed(2)}×</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Opacity</label><div className="inspector__slider"><input type="range" min={0} max={1} step={0.01} value={clip.opacity || 1} onChange={(e) => updateClip(clipId, { opacity: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{((clip.opacity || 1) * 100).toFixed(0)}%</span></div></div>
      <div className="inspector__field"><label className="inspector__label">Blend Mode</label><BlendModeSelect allowInherit value={clip.blendMode || 'Inherit'} onChange={(v) => updateClip(clipId, { blendMode: v })} /></div>
      {/* The fade handles double as the transition-in/out duration: with a
          transition set, the handle stops being a plain opacity ramp and
          becomes that transition's window (the renderer drops the ramp so the
          two don't compound into a double-fade). */}
      <div className="inspector__field"><label className="inspector__label">{clip.transition?.type && overlapDur <= 0.001 ? 'Fade In → Transition' : 'Fade In'}</label><div className="inspector__slider"><input type="range" min={0} max={Math.max(0.1, clip.timelineEnd - clip.timelineStart)} step={0.05} value={clip.fadeIn || 0} onChange={(e) => updateClip(clipId, { fadeIn: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(clip.fadeIn || 0).toFixed(2)}s</span></div></div>
      <div className="inspector__field"><label className="inspector__label">{clip.transitionOut?.type && !nextOwnsWindow ? 'Fade Out → Transition' : 'Fade Out'}</label><div className="inspector__slider"><input type="range" min={0} max={Math.max(0.1, clip.timelineEnd - clip.timelineStart)} step={0.05} value={clip.fadeOut || 0} onChange={(e) => updateClip(clipId, { fadeOut: parseFloat(e.target.value) })} /><span className="inspector__slider-value">{(clip.fadeOut || 0).toFixed(2)}s</span></div></div>

      {/* Framing comes before the content sections: it applies to every clip
          kind that has a picture, and is applied before the clip's effect graph
          sees the frame. Audio clips are excluded — they have no picture. */}
      {clipSupportsTransform(clip) && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 12 }}>Transform (Pan / Zoom)</div>
          <ClipTransformEditor clip={clip} />
        </>
      )}

      {clip.fileType === 'text' && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 12 }}>Text</div>
          <TextStyleEditor params={clip.params || {}} onChange={setTextParam} includeTransform />
        </>
      )}

      {clip.fileType === 'image' && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 12 }}>Image</div>
          <ImageStyleEditor params={clip.params || {}} onChange={setParam} onReplaceImage={replaceImage} />
        </>
      )}

      {clip.fileType === 'shape' && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 12 }}>Shape</div>
          <ShapeStyleEditor
            params={clip.params || {}}
            onChange={setParam}
            onApplyPreset={(preset) => updateClip(clipId, { params: { ...clip.params, ...preset.params } })}
          />
        </>
      )}

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
            Audio follows the clip&apos;s fades; transitions crossfade it automatically
          </div>
        </>
      )}

      {supportsTransition && (
        <>
          <div className="inspector__section-header" style={{ marginTop: 12 }}>Transition In</div>
          <ClipTransitionEditor
            clipId={clipId}
            transition={clip.transition}
            field="transition"
            transitionCompounds={transitionCompounds}
            hint={inHint}
          />

          <div className="inspector__section-header" style={{ marginTop: 12 }}>Transition Out</div>
          <ClipTransitionEditor
            clipId={clipId}
            transition={clip.transitionOut}
            field="transitionOut"
            transitionCompounds={transitionCompounds}
            hint={outHint}
          />
        </>
      )}

      <button className="inspector__btn inspector__btn--primary" onClick={() => enterClipGraph(clipId)} style={{ marginTop: 12 }}>Open Effect Graph</button>
    </div>
  )
}

/**
 * Type selector + parameter sliders for ONE end of a clip's transition.
 * Rendered twice (in / out) against different clip fields, which is why the
 * field name is a prop rather than two near-identical blocks — the built-in vs
 * compound branching, the missing-entry fallback and the param plumbing are
 * fiddly enough that a second copy would drift.
 *
 * @param {string} field — 'transition' (in) or 'transitionOut' (out)
 * @param {object} hint  — { ok, text }: what times this transition, or why it
 *   currently won't play. Computed by the caller, which knows the neighbours.
 */
function ClipTransitionEditor({ clipId, transition, field, transitionCompounds, hint }) {
  const updateClip = useTimelineStore(s => s.updateClip)

  const isCompound = !!transition?.type?.startsWith('compound:')
  const compoundEntry = isCompound
    ? transitionCompounds.find(c => `compound:${c.id}` === transition.type) || null
    : null

  const setParams = (params) => updateClip(clipId, { [field]: { ...transition, params } })

  return (
    <>
      <div className="inspector__field">
        <label className="inspector__label">Type</label>
        <select
          className="inspector__select"
          value={transition?.type || ''}
          onChange={(e) => {
            const type = e.target.value
            // Built-ins start from registry defaults; compound transitions start
            // empty — the entry's exposedParams carry their own defaults.
            const params = type && !type.startsWith('compound:') ? getTransitionDefaults(type) : {}
            updateClip(clipId, { [field]: type ? { type, params } : null })
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
          {isCompound && !compoundEntry && (
            <option value={transition.type} disabled>(missing compound)</option>
          )}
        </select>
      </div>

      {transition?.type && (
        <>
          <div style={{
            fontSize: 10,
            color: hint.ok ? 'var(--text-secondary)' : 'var(--accent-amber)',
            padding: '2px 8px 6px',
          }}>
            {hint.text}
          </div>
          {isCompound && !compoundEntry && (
            <div style={{ fontSize: 10, color: 'var(--accent-amber)', padding: '2px 8px 6px' }}>
              This node transition is no longer in the compound library — the clip falls back to its blend mode
            </div>
          )}
          {/* Built-in transitions: params parsed from the registry shader */}
          {!isCompound && getTransitionParams(transition.type).map(param => (
            <InspectorParam
              key={param.uniformName}
              nodeId={clipId}
              param={param}
              value={transition.params?.[param.uniformName] ?? param.default}
              onChange={(v) => setParams({ ...transition.params, [param.uniformName]: v })}
              isConnected={false}
            />
          ))}
          {/* Node transitions: the compound's exposed params, keyed by index */}
          {compoundEntry && (compoundEntry.exposedParams || []).map((ep, i) => (
            <InspectorParam
              key={`${compoundEntry.id}_${i}`}
              nodeId={clipId}
              param={{ ...ep.paramConfig, name: ep.displayName || ep.paramConfig?.name }}
              value={transition.params?.[i] ?? ep.value ?? ep.paramConfig?.default}
              onChange={(v) => setParams({ ...transition.params, [i]: v })}
              isConnected={false}
            />
          ))}
        </>
      )}
    </>
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
