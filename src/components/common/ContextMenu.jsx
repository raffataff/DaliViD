/**
 * DaliVid — ContextMenu.jsx
 * Small, reusable right-click menu. Rendered in a portal so it can never be
 * clipped by a scrolling panel (the Media Pool's list is overflow:auto), and
 * position-clamped after mount from its real measured size rather than a
 * hard-coded width guess.
 *
 * items: [{ label, hint, icon, danger, disabled, onSelect } | { separator: true }]
 */

import { useRef, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import './ContextMenu.css'

const MARGIN = 6

export default function ContextMenu({ x, y, header, items = [], onClose }) {
  const menuRef = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y, ready: false })

  // Clamp against the real rect so a menu opened near the bottom/right edge
  // flips instead of hanging off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN))
    const top = Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN))
    setPos({ left, top, ready: true })
  }, [x, y, items.length])

  // Dismiss on outside press, Escape, wheel outside, or window blur. mousedown
  // (not click) so the menu can't survive into a drag started elsewhere.
  useEffect(() => {
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose?.()
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    const onWheel = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose?.()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {header && <div className="ctx-menu__header" title={header}>{header}</div>}
      {items.map((item, i) => (
        item.separator ? (
          <div key={`sep_${i}`} className="ctx-menu__sep" />
        ) : (
          <button
            key={item.label + i}
            type="button"
            className={`ctx-menu__item ${item.danger ? 'ctx-menu__item--danger' : ''}`}
            disabled={item.disabled}
            title={item.hint || ''}
            onClick={() => {
              if (item.disabled) return
              item.onSelect?.()
              if (!item.keepOpen) onClose?.()
            }}
          >
            {item.icon && <span className="ctx-menu__icon">{item.icon}</span>}
            <span className="ctx-menu__label">{item.label}</span>
          </button>
        )
      ))}
    </div>,
    document.body
  )
}
