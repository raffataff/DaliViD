import { useCallback, useRef, useState } from 'react'

/**
 * Draggable resize handle for panel borders.
 * direction: 'horizontal' | 'vertical'
 * onResize: (delta) => void — receives px delta in drag axis
 */
export default function ResizeHandle({ direction = 'horizontal', onResize }) {
  const [active, setActive] = useState(false)
  const startPos = useRef(0)

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    setActive(true)
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY
    
    const handlePointerMove = (e) => {
      const current = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = current - startPos.current
      startPos.current = current
      if (delta !== 0) {
        onResize(delta)
      }
    }

    const handlePointerUp = () => {
      setActive(false)
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
  }, [direction, onResize])

  return (
    <div
      className={`resize-handle resize-handle--${direction} ${active ? 'resize-handle--active' : ''}`}
      onPointerDown={handlePointerDown}
    />
  )
}
