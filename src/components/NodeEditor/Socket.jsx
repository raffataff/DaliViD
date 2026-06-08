import { memo } from 'react'
import { SOCKET_COLORS } from '../../shaders/nodeDefinitions'
import './Socket.css'

/**
 * Socket — input/output connection point on a node card.
 * Supports texture (cyan), audio (magenta), and float (yellow) types.
 */
const Socket = memo(function Socket({
  type = 'input',
  dataType = 'texture',
  name = '',
  connected = false,
  onDragStart,
  onDragEnd,
  nodeId,
  socketId,
  mini = false,
}) {
  const color = SOCKET_COLORS[dataType] || SOCKET_COLORS.texture

  const handleMouseDown = (e) => {
    if (e.button !== 0) return // Only handle left clicks
    if (type === 'output' && onDragStart) {
      e.stopPropagation()
      onDragStart({ nodeId, socketId, type, dataType, element: e.target, event: e })
    } else if (type === 'input' && connected && onDragStart) {
      e.stopPropagation()
      onDragStart({ nodeId, socketId, type, dataType, element: e.target, event: e })
    }
  }

  const handleMouseUp = (e) => {
    if (type === 'input' && onDragEnd) {
      e.stopPropagation()
      onDragEnd({ nodeId, socketId, type, dataType })
    }
  }

  return (
    <div
      className={`socket socket--${type} ${mini ? 'socket--mini' : ''}`}
      data-tooltip={`${name || socketId} (${dataType})`}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      data-node-id={nodeId}
      data-socket-id={socketId}
      data-socket-type={type}
    >
      <div
        className={`socket__circle ${connected ? 'socket__circle--connected' : ''}`}
        style={{
          borderColor: color,
          backgroundColor: connected ? color : 'transparent',
          boxShadow: connected ? `0 0 6px ${color}` : 'none',
          width: mini ? '8px' : '12px',
          height: mini ? '8px' : '12px',
        }}
      />
      {name && !mini && (
        <span className={`socket__label socket__label--${type}`}>
          {name}
        </span>
      )}
    </div>
  )
})

export default Socket
