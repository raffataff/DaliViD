import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'

/**
 * ShapeHandles — on-canvas transform gizmo for the selected shape.
 *
 * Works for both shape targets, since they share one param set (the SHAPE_INPUT
 * shader's uniforms):
 *   • a selected SHAPE_INPUT node in the graph currently being viewed
 *   • a selected shape CLIP on the timeline
 *
 * Coordinate convention (must match the SHAPE_INPUT shader):
 *   • Frame units: 1.0 == the frame HEIGHT on both axes (x is aspect-corrected),
 *     so 1 unit == `content.height` pixels on screen for width AND height.
 *   • u_shp_x / u_shp_y are ±1 at the frame edges, y positive UP.
 *   • u_shp_rot is counter-clockwise-positive on screen, hence rotate(-deg) here
 *     (SVG angles are clockwise-positive because its y axis points down).
 *
 * The overlay is positioned from the canvas's live bounding rect, so it tracks
 * the preview's pan/zoom without duplicating that math. It re-measures on
 * zoom/pan/resolution changes and container resizes rather than every frame —
 * one layout read per interaction instead of per repaint.
 */

const SNAP_TARGETS = [-1 / 3, 0, 1 / 3]  // center + thirds, in param units
const SNAP_PX = 6                        // snap radius in screen pixels
const MIN_SIZE = 0.02                    // keep a grabbable box
const MAX_SIZE = 4.0                     // matches the shader's @param max
const TAU = Math.PI * 2

/** Wrap an angle into the shader's [-π, π] param range. */
function wrapAngle(a) {
  let x = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI
  if (x === -Math.PI) x = Math.PI
  return x
}

export default function ShapeHandles({ containerRef, canvasRef, zoom, pan }) {
  const resolution = useAppStore(s => s.resolution)
  const inspectorContext = useAppStore(s => s.inspectorContext)
  const selectedNodeId = useAppStore(s => s.selectedNodeId)
  const selectedClipId = useAppStore(s => s.selectedClipId)
  const graphLevel = useAppStore(s => s.graphLevel)
  const graphClipId = useAppStore(s => s.graphClipId)
  const graphCompoundPath = useAppStore(s => s.graphCompoundPath)

  const masterGraph = useGraphStore(s => s.masterGraph)
  const clipGraphs = useGraphStore(s => s.clipGraphs)
  const updateNode = useGraphStore(s => s.updateNode)

  const clips = useTimelineStore(s => s.clips)
  const updateClip = useTimelineStore(s => s.updateClip)

  const [content, setContent] = useState(null)   // { left, top, width, height } in container px
  const [drag, setDrag] = useState(null)         // { mode } while dragging
  const [guides, setGuides] = useState(null)     // { x: bool, y: bool } snap feedback

  // ── Which shape are we editing? ──
  // A selected shape node wins (you're working in the graph); otherwise a
  // selected shape clip. Nodes inside a compound aren't addressable by
  // updateNode (graphLevel + clipId only reach top-level graphs), so they get no
  // gizmo — the same rule the Inspector follows.
  const target = useMemo(() => {
    if (inspectorContext === 'node' && selectedNodeId && graphCompoundPath.length === 0) {
      const graph = graphLevel === 'master' ? masterGraph : clipGraphs?.[graphClipId]
      const node = graph?.nodes?.find(n => n.id === selectedNodeId)
      if (node?.type === 'SHAPE_INPUT') {
        return { kind: 'node', id: node.id, name: node.name || 'Shape', params: node.params || {} }
      }
    }
    if (inspectorContext === 'clip' && selectedClipId) {
      const clip = clips.find(c => c.id === selectedClipId)
      if (clip?.fileType === 'shape') {
        return { kind: 'clip', id: clip.id, name: clip.filename || 'Shape', params: clip.params || {} }
      }
    }
    return null
  }, [inspectorContext, selectedNodeId, selectedClipId, graphCompoundPath.length,
      graphLevel, graphClipId, masterGraph, clipGraphs, clips])

  // Latest params, readable inside drag handlers without re-binding listeners.
  const paramsRef = useRef({})
  paramsRef.current = target?.params || {}
  // Last emitted snap state — keeps a drag from re-rendering the guides every frame.
  const guidesRef = useRef({ x: false, y: false })

  // One store write per drag frame (a move touches x AND y), and `params` isn't a
  // RECOMPILE_KEY, so dragging never triggers a shader recompile.
  const writeParams = useCallback((patch) => {
    if (!target) return
    const params = { ...paramsRef.current, ...patch }
    if (target.kind === 'node') updateNode(graphLevel, graphClipId, target.id, { params })
    else updateClip(target.id, { params })
  }, [target, graphLevel, graphClipId, updateNode, updateClip])

  // ── Measure the drawn frame inside the canvas element ──
  // The canvas is `object-fit: contain`, so the frame is centered and
  // letterboxed inside the element box; the element's rect already includes the
  // wrapper's pan/zoom transform.
  useEffect(() => {
    const measure = () => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return
      const cr = canvas.getBoundingClientRect()
      const pr = container.getBoundingClientRect()
      const aspect = resolution.width / Math.max(resolution.height, 1)
      let w = cr.width
      let h = cr.width / aspect
      if (h > cr.height) { h = cr.height; w = cr.height * aspect }
      setContent({
        left: cr.left - pr.left + (cr.width - w) / 2,
        top: cr.top - pr.top + (cr.height - h) / 2,
        width: w,
        height: h,
      })
    }

    measure()
    // The wrapper animates its transform (0.15s ease-out) after a zoom change,
    // so re-measure once it has settled.
    const settle = setTimeout(measure, 190)
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    window.addEventListener('resize', measure)
    return () => {
      clearTimeout(settle)
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [containerRef, canvasRef, zoom, pan.x, pan.y, resolution.width, resolution.height])

  if (!target || !content || content.width < 8) return null

  const p = target.params
  const px = content.height                                   // pixels per frame unit
  const shpX = p.u_shp_x ?? 0
  const shpY = p.u_shp_y ?? 0
  const shpW = p.u_shp_w ?? 0.6
  const shpH = p.u_shp_h ?? 0.6
  const ang = p.u_shp_rot ?? 0

  const cx = content.left + content.width * (0.5 + 0.5 * shpX)
  const cy = content.top + content.height * (0.5 - 0.5 * shpY)
  const hw = Math.max(shpW * 0.5 * px, 3)
  const hh = Math.max(shpH * 0.5 * px, 3)
  const deg = (ang * 180) / Math.PI

  // Screen delta → shape-local frame units (undo the shape's rotation).
  const toLocal = (dxPx, dyPx, angle) => {
    const vx = dxPx / px
    const vy = -dyPx / px                                     // screen y is down
    return {
      x: Math.cos(angle) * vx + Math.sin(angle) * vy,
      y: -Math.sin(angle) * vx + Math.cos(angle) * vy,
    }
  }

  const snap = (value, tolerance, bypass) => {
    if (bypass) return { value, snapped: false }
    for (const t of SNAP_TARGETS) {
      if (Math.abs(value - t) <= tolerance) return { value: t, snapped: true }
    }
    return { value, snapped: false }
  }

  /**
   * Start a drag. `mode` is 'move' | 'rotate' | a resize corner/edge id
   * ('nw','ne','se','sw','n','s','e','w').
   */
  const beginDrag = (e, mode) => {
    if (e.button !== 0) return                                // leave middle-drag pan alone
    e.preventDefault()
    e.stopPropagation()

    const container = containerRef.current
    const pr = container.getBoundingClientRect()
    const start = {
      mx: e.clientX - pr.left,
      my: e.clientY - pr.top,
      x: shpX, y: shpY, w: shpW, h: shpH, ang,
    }
    setDrag({ mode })

    const onMove = (me) => {
      const mx = me.clientX - pr.left
      const my = me.clientY - pr.top
      const dx = mx - start.mx
      const dy = my - start.my

      if (mode === 'move') {
        // Param units per pixel: the frame spans 2 units across its width/height.
        let nx = start.x + (dx / content.width) * 2
        let ny = start.y - (dy / content.height) * 2
        if (me.shiftKey) {
          // Axis lock to the dominant direction.
          if (Math.abs(dx) > Math.abs(dy)) ny = start.y
          else nx = start.x
        }
        const sx = snap(nx, (SNAP_PX / content.width) * 2, me.altKey)
        const sy = snap(ny, (SNAP_PX / content.height) * 2, me.altKey)
        // Only re-render the guide lines when they actually change state.
        if (guidesRef.current.x !== sx.snapped || guidesRef.current.y !== sy.snapped) {
          guidesRef.current = { x: sx.snapped, y: sy.snapped }
          setGuides(guidesRef.current)
        }
        writeParams({
          u_shp_x: Math.max(-1.5, Math.min(1.5, +sx.value.toFixed(4))),
          u_shp_y: Math.max(-1.5, Math.min(1.5, +sy.value.toFixed(4))),
        })
        return
      }

      if (mode === 'rotate') {
        // Angle of the cursor around the center; the handle sits at local +y, so
        // subtract a quarter turn.
        const vx = (mx - cx) / px
        const vy = -(my - cy) / px
        let next = Math.atan2(vy, vx) - Math.PI / 2
        if (me.shiftKey) {
          const stepRad = (15 * Math.PI) / 180
          next = Math.round(next / stepRad) * stepRad
        }
        writeParams({ u_shp_rot: +wrapAngle(next).toFixed(4) })
        return
      }

      // ── Resize ──
      // Symmetric about the center (matches the shader's center-based model), in
      // the shape's own rotated frame so a rotated shape resizes along its edges.
      const local = toLocal(mx - cx, my - cy, start.ang)
      let w = start.w
      let h = start.h
      const wantsW = mode.includes('e') || mode.includes('w')
      const wantsH = mode.includes('n') || mode.includes('s')
      if (wantsW) w = Math.abs(local.x) * 2
      if (wantsH) h = Math.abs(local.y) * 2
      if (me.shiftKey && wantsW && wantsH && start.w > 0 && start.h > 0) {
        // Uniform scale from whichever axis moved most.
        const scale = Math.max(w / start.w, h / start.h)
        w = start.w * scale
        h = start.h * scale
      }
      const clamp = (v) => Math.max(MIN_SIZE, Math.min(MAX_SIZE, +v.toFixed(4)))
      const patch = {}
      if (wantsW) patch.u_shp_w = clamp(w)
      if (wantsH) patch.u_shp_h = clamp(h)
      writeParams(patch)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setDrag(null)
      guidesRef.current = { x: false, y: false }
      setGuides(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const HANDLES = [
    { id: 'nw', x: -hw, y: -hh, cursor: 'nwse-resize' },
    { id: 'n', x: 0, y: -hh, cursor: 'ns-resize' },
    { id: 'ne', x: hw, y: -hh, cursor: 'nesw-resize' },
    { id: 'e', x: hw, y: 0, cursor: 'ew-resize' },
    { id: 'se', x: hw, y: hh, cursor: 'nwse-resize' },
    { id: 's', x: 0, y: hh, cursor: 'ns-resize' },
    { id: 'sw', x: -hw, y: hh, cursor: 'nesw-resize' },
    { id: 'w', x: -hw, y: 0, cursor: 'ew-resize' },
  ]

  const readout = drag
    ? (drag.mode === 'move' ? `x ${shpX.toFixed(2)}  y ${shpY.toFixed(2)}`
      : drag.mode === 'rotate' ? `${deg.toFixed(1)}°`
      : `w ${shpW.toFixed(2)}  h ${shpH.toFixed(2)}`)
    : null

  return (
    <>
      <svg className="preview__shape-gizmo">
        {/* Snap guides (center / thirds) */}
        {guides?.x && (
          <line className="shape-gizmo__guide" x1={cx} y1={content.top} x2={cx} y2={content.top + content.height} />
        )}
        {guides?.y && (
          <line className="shape-gizmo__guide" x1={content.left} y1={cy} x2={content.left + content.width} y2={cy} />
        )}

        <g transform={`translate(${cx} ${cy}) rotate(${-deg})`}>
          {/* Drag body: moves the shape. Transparent but hit-testable. */}
          <rect
            className="shape-gizmo__body"
            x={-hw} y={-hh} width={hw * 2} height={hh * 2}
            onMouseDown={(e) => beginDrag(e, 'move')}
          />
          <rect className="shape-gizmo__box" x={-hw} y={-hh} width={hw * 2} height={hh * 2} />

          {/* Rotate handle, above the top edge */}
          <line className="shape-gizmo__stem" x1={0} y1={-hh} x2={0} y2={-hh - 24} />
          <circle
            className="shape-gizmo__rotate"
            cx={0} cy={-hh - 24} r={6}
            onMouseDown={(e) => beginDrag(e, 'rotate')}
          />

          {HANDLES.map(h => (
            <rect
              key={h.id}
              className="shape-gizmo__handle"
              x={h.x - 4} y={h.y - 4} width={8} height={8}
              style={{ cursor: h.cursor }}
              onMouseDown={(e) => beginDrag(e, h.id)}
            />
          ))}
        </g>
      </svg>

      <div className="preview__shape-gizmo-label mono">
        {target.kind === 'clip' ? '◆ ' : '● '}{target.name}
        {readout && <span className="preview__shape-gizmo-readout">{readout}</span>}
      </div>
    </>
  )
}
