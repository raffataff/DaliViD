import { useState, useRef, useEffect, useCallback } from 'react'

const COMPOUND_COLORS = [
  '#ff00aa', '#ff4488', '#ff3344', '#ff8844', '#ffcc44',
  '#44cc88', '#44ccff', '#4488ff', '#aa44ff', '#ff44ff',
]

export default function CompoundNameModal({ onConfirm, onCancel }) {
  const [name, setName] = useState('New Compound')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(COMPOUND_COLORS[0])
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onCancel()
    if (e.key === 'Enter' && name.trim()) onConfirm(name.trim(), description.trim(), color)
  }, [name, description, color, onConfirm, onCancel])

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal" onKeyDown={handleKeyDown} style={{ width: 400 }}>
        <div className="modal__header">
          <span className="modal__title">Create Compound Effect</span>
          <button className="modal__close-btn" onClick={onCancel}>×</button>
        </div>
        <div className="modal__body">
          <div className="inspector__field">
            <label className="inspector__label">Name</label>
            <input
              ref={inputRef}
              className="inspector__input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Effect"
            />
          </div>
          <div className="inspector__field">
            <label className="inspector__label">Description</label>
            <input
              className="inspector__input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div className="inspector__field">
            <label className="inspector__label">Color</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {COMPOUND_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 24, height: 24, borderRadius: 4, background: c,
                    border: c === color ? '2px solid white' : '2px solid transparent',
                    cursor: 'pointer', padding: 0,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="modal__footer">
          <button className="inspector__btn" onClick={onCancel}>Cancel</button>
          <button
            className="inspector__btn inspector__btn--primary"
            disabled={!name.trim()}
            onClick={() => { if (name.trim()) onConfirm(name.trim(), description.trim(), color) }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
