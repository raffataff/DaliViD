import { useState, useRef, useEffect, useCallback } from 'react'
import useGraphStore from '../../store/useGraphStore'
import './NodeSearchMenu.css'

const NODE_CATALOG = [
  {
    category: 'I/O',
    items: [
      { type: 'VIDEO_INPUT', name: 'Video Input', sourceOnly: true },
      { type: 'CAMERA_INPUT', name: 'Camera Input', sourceOnly: true },
      { type: 'OUTPUT', name: 'Output' },
    ],
  },
  {
    category: 'Audio',
    items: [
      { type: 'AUDIO_INPUT', name: 'Audio Input' },
      { type: 'AUDIO_SPLITTER', name: 'Audio Splitter' },
      { type: 'AUDIO_VISUALIZER', name: 'Audio Visualizer' },
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
      { type: 'CUSTOM', name: 'Custom Shader' },
    ],
  },
]

export default function NodeSearchMenu({ position, onSelect, onClose }) {
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  const menuRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const compoundLibrary = useGraphStore(s => s.compoundLibrary)

  // Build dynamic catalog with user compounds appended after Utility
  const dynamicCatalog = [...NODE_CATALOG]
  if (compoundLibrary.length > 0) {
    const compoundCategory = {
      category: 'My Compounds',
      items: compoundLibrary.map(c => ({
        type: 'USER_COMPOUND', name: c.name, compoundId: c.id, color: c.color, isUserCompound: true,
      })),
    }
    const compoundCategoryIdx = dynamicCatalog.findIndex(c => c.category === 'Compound')
    if (compoundCategoryIdx >= 0) {
      dynamicCatalog.splice(compoundCategoryIdx, 0, compoundCategory)
    } else {
      dynamicCatalog.push(compoundCategory)
    }
  }

  const filteredCategories = dynamicCatalog.map(cat => ({
    ...cat,
    items: cat.items.filter(item =>
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.type.toLowerCase().includes(search.toLowerCase())
    ),
  })).filter(cat => cat.items.length > 0)

  const allFiltered = filteredCategories.flatMap(c => c.items)

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, allFiltered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (allFiltered[selectedIndex]) onSelect(allFiltered[selectedIndex]) }
    else if (e.key === 'Escape') onClose()
  }, [allFiltered, selectedIndex, onSelect, onClose])

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
        {filteredCategories.map(cat => (
          <div key={cat.category} className="node-search-menu__category">
            <div className="node-search-menu__category-label">{cat.category}</div>
            {cat.items.map(item => {
              const idx = itemIndex++
              return (
                <button
                  key={item.type + (item.compoundId || '')}
                  className={`node-search-menu__item ${idx === selectedIndex ? 'node-search-menu__item--selected' : ''}`}
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
        ))}
        {allFiltered.length === 0 && (
          <div className="node-search-menu__empty">No matches</div>
        )}
      </div>
    </div>
  )
}

export { NODE_CATALOG }
