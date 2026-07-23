import { useState, useRef, useEffect, useCallback } from 'react'
import useGraphStore from '../../store/useGraphStore'
import { COMPOUND_PRESETS } from '../../shaders/compoundPresets'
import './NodeSearchMenu.css'

const NODE_CATALOG = [
  {
    category: 'I/O',
    items: [
      { type: 'VIDEO_INPUT', name: 'Video Input', sourceOnly: true },
      { type: 'IMAGE_INPUT', name: 'Image Input', sourceOnly: true },
      { type: 'TEXT_INPUT', name: 'Text Input', sourceOnly: true },
      { type: 'CAMERA_INPUT', name: 'Camera Input', sourceOnly: true },
      { type: 'SCREEN_INPUT', name: 'Screen Input', sourceOnly: true },
      { type: 'OUTPUT', name: 'Output' },
    ],
  },
  {
    category: 'Audio',
    items: [
      { type: 'AUDIO_INPUT', name: 'Audio Input' },
      { type: 'AUDIO_SPLITTER', name: 'Audio Splitter' },
      { type: 'ENVELOPE', name: 'Envelope Follower' },
      { type: 'AUDIO_VISUALIZER', name: 'Audio Visualizer' },
    ],
  },
  {
    category: 'Audio-Reactive (Examples)',
    items: [
      { type: 'AUDIO_WARP', name: 'Audio Warp (bass/treble)' },
      { type: 'SPECTRUM_GLOW', name: 'Spectrum Glow (bass/mid/treble)' },
    ],
  },
  {
    category: 'Color / Correction',
    items: [
      { type: 'COLOR_INVERSION', name: 'Color / HSV' },
      { type: 'LUT', name: 'LUT (Color Grading)' },
      { type: 'THRESHOLD', name: 'Threshold / Posterize' },
      { type: 'CHROMA_KEY', name: 'Chroma Key' },
      { type: 'VIGNETTE', name: 'Vignette' },
    ],
  },
  {
    category: 'Effects',
    items: [
      { type: 'EDGE_DETECTION', name: 'Edge Detection' },
      { type: 'GLITCH', name: 'Glitch / Datamosh' },
      { type: 'FEEDBACK', name: 'Feedback Loop' },
      { type: 'KALEIDOSCOPE', name: 'Kaleidoscope' },
      { type: 'PIXEL_SORT', name: 'Pixel Sort' },
      { type: 'CHROMATIC_ABERRATION', name: 'Chromatic Aberration' },
      { type: 'BLOOM', name: 'Bloom / Glow' },
      { type: 'CRT', name: 'CRT / Scanlines' },
      { type: 'VORONOI', name: 'Voronoi / Cellular' },
      { type: 'FLUID_WARP', name: 'Fluid Warp' },
      { type: 'HALFTONE', name: 'Halftone' },
      { type: 'DEPTH_BLUR', name: 'Depth-Based Blur' },
      { type: 'MIRROR', name: 'Mirror / Symmetry' },
      { type: 'PARTICLE_DISPLACE', name: 'Particle Displace' },
      { type: 'EMBOSS', name: 'Emboss' },
      { type: 'ASCII', name: 'ASCII Art' },
      { type: 'NOISE', name: 'Film Grain / Noise' },
      { type: 'LENS_DISTORTION', name: 'Lens Distortion' },
    ],
  },
  {
    category: 'Blur / Spatial',
    items: [
      { type: 'BLUR', name: 'Gaussian Blur' },
      { type: 'PIXELATE', name: 'Pixelate' },
      { type: 'DISPLACEMENT', name: 'Displacement Map' },
    ],
  },
  {
    category: 'Utility',
    items: [
      { type: 'MIX_BLEND', name: 'Mix / Blend' },
      { type: 'MATH', name: 'Math' },
      { type: 'TRANSITION_PROGRESS', name: 'Transition Progress' },
      { type: 'CUSTOM', name: 'Custom Shader' },
    ],
  },
  {
    category: 'Generators (Procedural)',
    items: [
      { type: 'BIOMATH', name: 'Bio-Digital (Xor)' },
      { type: 'PLASMA', name: 'Plasma Waves' },
      { type: 'FRACTAL', name: 'Fractal Patterns' },
      { type: 'TUNNEL', name: 'Tunnel Effect' },
      { type: 'GEOMETRIC', name: 'Geometric Shapes' },
      { type: 'LIGHTNING', name: 'Lightning & Electric' },
      { type: 'CRYSTAL', name: 'Crystal Structures' },
      { type: 'COSMIC', name: 'Cosmic Space' },
      { type: 'WAVES', name: 'Wave Patterns' },
      { type: 'SPACE_DISTORTION', name: 'Space Distortion' },
    ],
  },
]

function Chevron({ open }) {
  return (
    <svg
      className={`node-search-menu__chevron ${open ? 'node-search-menu__chevron--open' : ''}`}
      width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"
    >
      <path d="M4 2.5L8 6L4 9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function NodeSearchMenu({ position, onSelect, onClose }) {
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [expanded, setExpanded] = useState(() => new Set())
  const inputRef = useRef(null)
  const menuRef = useRef(null)
  const selectedRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const compoundLibrary = useGraphStore(s => s.compoundLibrary)

  // Build the catalog: static node types + the preset library + any user
  // compounds. Presets sit right under I/O so the finishing-look chains are easy
  // to find.
  const dynamicCatalog = [...NODE_CATALOG]
  if (COMPOUND_PRESETS.length > 0) {
    dynamicCatalog.splice(1, 0, {
      category: 'Presets',
      items: COMPOUND_PRESETS.map(p => ({
        type: 'PRESET', presetId: p.id, name: p.name, color: p.color, isPreset: true,
      })),
    })
  }
  if (compoundLibrary.length > 0) {
    dynamicCatalog.push({
      category: 'My Compounds',
      items: compoundLibrary.map(c => ({
        type: 'USER_COMPOUND', name: c.name, compoundId: c.id, color: c.color, isUserCompound: true,
      })),
    })
  }

  const searching = search.trim().length > 0
  const q = search.toLowerCase()

  const filteredCategories = dynamicCatalog.map(cat => ({
    ...cat,
    items: cat.items.filter(item =>
      item.name.toLowerCase().includes(q) || item.type.toLowerCase().includes(q)
    ),
  })).filter(cat => cat.items.length > 0)

  // While searching, every matching category is shown expanded; otherwise a
  // category is open only if the user has clicked it.
  const isOpen = useCallback(
    (catName) => searching || expanded.has(catName),
    [searching, expanded]
  )

  // Flat list of items the user can actually see — what arrow keys navigate.
  const visibleItems = filteredCategories.flatMap(c => (isOpen(c.category) ? c.items : []))

  const toggleCategory = useCallback((catName) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(catName)) next.delete(catName)
      else next.add(catName)
      return next
    })
    setSelectedIndex(0)
  }, [])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, visibleItems.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (visibleItems[selectedIndex]) onSelect(visibleItems[selectedIndex]) }
    else if (e.key === 'Escape') onClose()
  }, [visibleItems, selectedIndex, onSelect, onClose])

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

  // Keep the highlighted item scrolled into view as the user arrows through.
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }) }, [selectedIndex])

  let itemIndex = 0

  return (
    <div
      ref={menuRef}
      className="node-search-menu"
      style={{
        left: Math.min(position.x, window.innerWidth - 240),
        top: Math.min(position.y, window.innerHeight - 420),
      }}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={inputRef}
        className="node-search-menu__input"
        placeholder="Search nodes..."
        value={search}
        onChange={(e) => { setSearch(e.target.value); setSelectedIndex(0) }}
      />
      <div className="node-search-menu__results">
        {filteredCategories.map(cat => {
          const open = isOpen(cat.category)
          return (
            <div key={cat.category} className="node-search-menu__category">
              <button
                className="node-search-menu__category-label"
                onClick={() => toggleCategory(cat.category)}
                aria-expanded={open}
              >
                <Chevron open={open} />
                <span className="node-search-menu__category-name">{cat.category}</span>
                <span className="node-search-menu__category-count mono">{cat.items.length}</span>
              </button>
              {open && cat.items.map(item => {
                const idx = itemIndex++
                const isSel = idx === selectedIndex
                return (
                  <button
                    key={item.type + (item.compoundId || item.presetId || '')}
                    ref={isSel ? selectedRef : null}
                    className={`node-search-menu__item ${isSel ? 'node-search-menu__item--selected' : ''}`}
                    onClick={() => onSelect(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    {item.color && (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, display: 'inline-block', marginRight: 6, flexShrink: 0 }} />
                    )}
                    {item.name}
                  </button>
                )
              })}
            </div>
          )
        })}
        {filteredCategories.length === 0 && (
          <div className="node-search-menu__empty">No matches</div>
        )}
      </div>
    </div>
  )
}

export { NODE_CATALOG }
