import { memo } from 'react'
import './Noodle.css'

/**
 * Noodle — cubic bezier connection cable between two sockets.
 * Renders as an SVG path within the node canvas.
 */
const Noodle = memo(function Noodle({
  fromX, fromY,
  toX, toY,
  color = 'var(--accent-cyan)',
  selected = false,
  dataType = 'texture',
  id,
  onClick,
  onDelete,
}) {
  const colorMap = {
    texture: '#00e5ff',
    audio: '#ff00aa',
    float: '#ffdd00',
    param: '#ffdd00',
  }
  const strokeColor = colorMap[dataType] || color

  // Calculate control points for smooth bezier
  const dx = Math.abs(toX - fromX)
  const cpOffset = Math.max(50, dx * 0.4)

  const path = `M ${fromX} ${fromY} C ${fromX + cpOffset} ${fromY}, ${toX - cpOffset} ${toY}, ${toX} ${toY}`

  return (
    <g className={`noodle ${selected ? 'noodle--selected' : ''}`}>
      {/* Invisible wider hit area for clicking */}
      <path
        className="noodle__hitarea"
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth="12"
        onClick={() => onClick?.(id)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (onDelete) onDelete(id)
        }}
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
      />

      {/* Glow layer */}
      <path
        className="noodle__glow"
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={selected ? 5 : 4}
        strokeLinecap="round"
        opacity={0.15}
        filter="url(#noodleBlur)"
      />

      {/* Main cable */}
      <path
        className="noodle__cable"
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={selected ? 3 : 2}
        strokeLinecap="round"
        strokeDasharray={selected ? '8 4' : 'none'}
      />
    </g>
  )
})

/**
 * NoodleDrag — live cable that follows the cursor during drag-to-connect.
 */
export function NoodleDrag({ fromX, fromY, toX, toY, dataType = 'texture' }) {
  const colorMap = {
    texture: '#00e5ff',
    audio: '#ff00aa',
    float: '#ffdd00',
    param: '#ffdd00',
  }
  const strokeColor = colorMap[dataType] || '#00e5ff'

  const dx = Math.abs(toX - fromX)
  const cpOffset = Math.max(50, dx * 0.4)
  const path = `M ${fromX} ${fromY} C ${fromX + cpOffset} ${fromY}, ${toX - cpOffset} ${toY}, ${toX} ${toY}`

  return (
    <g className="noodle noodle--dragging">
      <path
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray="6 3"
        opacity={0.7}
      />
    </g>
  )
}

/**
 * SVG filter definitions for noodle effects.
 * Include this once in the SVG container.
 */
export function NoodleFilters() {
  return (
    <defs>
      <filter id="noodleBlur" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" />
      </filter>
    </defs>
  )
}

export default Noodle
