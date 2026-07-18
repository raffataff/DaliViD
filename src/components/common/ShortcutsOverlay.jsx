import './ShortcutsOverlay.css'

const SHORTCUTS = [
  {
    category: 'Playback & Transport',
    items: [
      { keys: ['Space'], desc: 'Play / Pause' },
      { keys: ['L'], desc: 'Toggle Loop' },
      { keys: ['←', '→'], desc: 'Step Frame Back / Forward' },
      { keys: ['Home', 'End'], desc: 'Skip to Start / End' },
      { keys: ['1', '2'], desc: 'Jump to In / Out Point' },
    ]
  },
  {
    category: 'Timeline Editing',
    items: [
      { keys: ['S'], desc: 'Split Clip at Playhead' },
      { keys: ['Delete'], desc: 'Delete Selected Clip' },
      { keys: ['I', 'O'], desc: 'Set In / Out Point' },
      { keys: ['X'], desc: 'Clear In / Out Points' },
      { keys: ['M'], desc: 'Add Marker at Playhead' },
    ]
  },
  {
    category: 'Timeline Zoom',
    items: [
      { keys: ['\\'], desc: 'Zoom to Fit Project' },
      { keys: ['+'], desc: 'Zoom In' },
      { keys: ['−'], desc: 'Zoom Out' },
      { keys: ['Wheel'], desc: 'Zoom at Cursor' },
      { keys: ['Shift', 'Wheel'], desc: 'Pan Horizontally' },
    ]
  },
  {
    category: 'Node Editor',
    items: [
      { keys: ['Right Click'], desc: 'Open Node Search Menu' },
      { keys: ['Drag'], desc: 'Box-Select Nodes' },
      { keys: ['Shift', 'Drag'], desc: 'Add to Selection (box)' },
      { keys: ['Alt', 'Drag'], desc: 'Pan Graph (or Middle-Drag)' },
      { keys: ['Ctrl', 'Click'], desc: 'Toggle Node in Selection' },
      { keys: ['Ctrl', 'A'], desc: 'Select All Nodes' },
      { keys: ['Ctrl', 'C'], desc: 'Copy Selected Nodes' },
      { keys: ['Ctrl', 'V'], desc: 'Paste Nodes at Cursor' },
      { keys: ['Ctrl', 'D'], desc: 'Duplicate Selected Node' },
      { keys: ['Ctrl', 'Drag Node'], desc: 'Insert Node into Wire' },
      { keys: ['Alt', 'Drag Node'], desc: 'Duplicate + Drag' },
      { keys: ['Shift', 'Drag Node'], desc: 'Detach Node (heal wires)' },
      { keys: ['Wheel'], desc: 'Zoom Graph at Cursor' },
      { keys: ['F'], desc: 'Fit Graph to Screen' },
      { keys: ['Delete'], desc: 'Delete Selected Node(s)' },
      { keys: ['Escape'], desc: 'Clear Selection / Cancel Box' },
    ]
  },
  {
    category: 'Project',
    items: [
      { keys: ['Ctrl', 'S'], desc: 'Save Project' },
      { keys: ['Ctrl', 'Shift', 'E'], desc: 'Export Render' },
      { keys: ['Shift', '?'], desc: 'Toggle this Shortcuts menu' },
    ]
  }
]

export default function ShortcutsOverlay({ isOpen, onClose }) {
  if (!isOpen) return null

  return (
    <div className="shortcuts-overlay__backdrop" onClick={onClose}>
      <div className="shortcuts-overlay__content" onClick={e => e.stopPropagation()}>
        <div className="shortcuts-overlay__header">
          <h2>Keyboard Shortcuts</h2>
          <button className="shortcuts-overlay__close" onClick={onClose}>×</button>
        </div>
        
        <div className="shortcuts-overlay__grid">
          {SHORTCUTS.map(cat => (
            <div key={cat.category} className="shortcuts-overlay__category">
              <h3>{cat.category}</h3>
              {cat.items.map((item, i) => (
                <div key={i} className="shortcuts-overlay__item">
                  <span className="shortcuts-overlay__desc">{item.desc}</span>
                  <div className="shortcuts-overlay__keys">
                    {item.keys.map((k, j) => (
                      <span key={j} className="shortcuts-overlay__key">{k}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
