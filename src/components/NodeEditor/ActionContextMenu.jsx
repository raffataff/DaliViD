import { useRef, useEffect, useCallback } from 'react'

const COMPOUND_COLORS = [
  '#ff00aa', '#ff4488', '#ff3344', '#ff8844', '#ffcc44',
  '#44cc88', '#44ccff', '#4488ff', '#aa44ff', '#ff44ff',
]

export function pickCompoundColor(existingLibrary) {
  const usedColors = new Set(existingLibrary.map(c => c.color))
  for (const c of COMPOUND_COLORS) {
    if (!usedColors.has(c)) return c
  }
  return COMPOUND_COLORS[Math.floor(Math.random() * COMPOUND_COLORS.length)]
}

export default function ActionContextMenu({ position, selectedCount, onCreateCompound, onDuplicate, onToggleBypass, onDeleteNodes, onDeselect, onClose }) {
  const menuRef = useRef(null)

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const handler = (e) => e.stopPropagation()
    el.addEventListener('wheel', handler, { passive: true })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  return (
    <div
      ref={menuRef}
      className="node-canvas__context-menu"
      style={{
        left: Math.min(position.x, window.innerWidth - 240),
        top: Math.min(position.y, window.innerHeight - 300),
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="node-canvas__menu-label">{selectedCount} node{selectedCount !== 1 ? 's' : ''} selected</div>
      <div className="node-canvas__menu-section">
        <button
          className="node-canvas__menu-item"
          onClick={() => { onDuplicate(); onClose() }}
        >
          Duplicate Nodes
        </button>
        <button
          className="node-canvas__menu-item"
          disabled={selectedCount < 2}
          onClick={() => { if (selectedCount >= 2) { onCreateCompound(); onClose() } }}
        >
          Create Compound Effect
        </button>
        <button
          className="node-canvas__menu-item"
          onClick={() => { onToggleBypass(); onClose() }}
        >
          Bypass / Enable All
        </button>
      </div>
      <div className="node-canvas__menu-section">
        <button
          className="node-canvas__menu-item node-canvas__menu-item--danger"
          onClick={() => { onDeleteNodes(); onClose() }}
        >
          Delete Nodes
        </button>
        <button
          className="node-canvas__menu-item"
          onClick={() => { onDeselect?.(); onClose() }}
          style={{ color: 'var(--text-disabled)' }}
        >
          Deselect
        </button>
      </div>
    </div>
  )
}
