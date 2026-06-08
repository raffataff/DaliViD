import { useState, useMemo, useCallback } from 'react'
import { getShaderSource } from '../../shaders/shaderRegistry'
import { parseParams } from '../../utils/paramParser'
import { getDefaultParams } from '../../utils/paramParser'
import './ShaderGenerator.css'

const EFFECT_CATEGORIES = [
  {
    id: 'color',
    name: 'Color',
    effects: ['COLOR_INVERSION', 'LUT', 'THRESHOLD', 'CHROMA_KEY', 'VIGNETTE'],
  },
  {
    id: 'blur',
    name: 'Blur & Spatial',
    effects: ['BLUR', 'PIXELATE', 'HALFTONE', 'DEPTH_BLUR'],
  },
  {
    id: 'distortion',
    name: 'Distortion',
    effects: ['GLITCH', 'PIXEL_SORT', 'CHROMATIC_ABERRATION', 'LENS_DISTORTION', 'FLUID_WARP', 'VORONOI'],
  },
  {
    id: 'stylize',
    name: 'Stylize',
    effects: ['EDGE_DETECTION', 'BLOOM', 'CRT', 'KALEIDOSCOPE', 'MIRROR', 'EMBOSS', 'ASCII', 'PARTICLE_DISPLACE'],
  },
  {
    id: 'effects',
    name: 'Effects',
    effects: ['NOISE'],
  },
]

function getEffectInfo(type) {
  const source = getShaderSource(type)
  if (!source) return null

  const params = parseParams(source)
  const name = type.replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())

  return {
    type,
    name,
    params,
    paramCount: params.length,
  }
}

export default function ShaderGenerator({ onGenerate, onClose }) {
  const [selectedEffects, setSelectedEffects] = useState([])
  const [expandedCategories, setExpandedCategories] = useState(new Set(['color', 'blur', 'distortion', 'stylize', 'effects']))
  const [searchQuery, setSearchQuery] = useState('')
  const [shaderName, setShaderName] = useState('Generated Shader')

  const handleSurpriseMe = useCallback(() => {
    const allEffects = EFFECT_CATEGORIES.flatMap(cat => cat.effects)
    const count = Math.floor(Math.random() * 3) + 2
    const randomSelection = []
    for (let i = 0; i < count; i++) {
      const randomEffect = allEffects[Math.floor(Math.random() * allEffects.length)]
      randomSelection.push(randomEffect)
    }
    setSelectedEffects(randomSelection)

    const adjectives = ['Cosmic', 'Nebula', 'Glitchy', 'Quantum', 'Vortical', 'Neon', 'Spectral', 'Cyber', 'Abyssal', 'Retro', 'Stellar', 'Digital', 'Acid', 'Hyper']
    const nouns = ['Dream', 'Warp', 'Forge', 'Vision', 'Pulse', 'Matrix', 'Spectra', 'Wave', 'Echo', 'Void', 'Gate', 'Bloom', 'Grid', 'Flow']
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
    const noun = nouns[Math.floor(Math.random() * nouns.length)]
    setShaderName(`${adj} ${noun}`)
  }, [])

  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return EFFECT_CATEGORIES

    const query = searchQuery.toLowerCase()
    return EFFECT_CATEGORIES.map(cat => ({
      ...cat,
      effects: cat.effects.filter(type => {
        const info = getEffectInfo(type)
        return info && (
          info.name.toLowerCase().includes(query) ||
          type.toLowerCase().includes(query)
        )
      }),
    })).filter(cat => cat.effects.length > 0)
  }, [searchQuery])

  const toggleCategory = useCallback((categoryId) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(categoryId)) {
        next.delete(categoryId)
      } else {
        next.add(categoryId)
      }
      return next
    })
  }, [])

  const addEffect = useCallback((effectType) => {
    if (!selectedEffects.includes(effectType)) {
      setSelectedEffects(prev => [...prev, effectType])
    }
  }, [selectedEffects])

  const removeEffect = useCallback((effectType) => {
    setSelectedEffects(prev => prev.filter(t => t !== effectType))
  }, [])

  const moveEffect = useCallback((index, direction) => {
    setSelectedEffects(prev => {
      const next = [...prev]
      const newIndex = index + direction
      if (newIndex < 0 || newIndex >= next.length) return prev
      ;[next[index], next[newIndex]] = [next[newIndex], next[index]]
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setSelectedEffects([])
  }, [])

  const handleGenerate = useCallback(() => {
    if (selectedEffects.length === 0) return

    const effectNodes = selectedEffects.map(type => {
      const info = getEffectInfo(type)
      const params = info?.params || []
      return {
        type,
        name: info?.name || type,
        params: getDefaultParams(params),
        paramConfigs: params,
      }
    })

    onGenerate(effectNodes, shaderName)
    onClose()
  }, [selectedEffects, shaderName, onGenerate, onClose])

  return (
    <div className="shader-generator">
      <div className="shader-generator__header">
        <h3 className="shader-generator__title">Shader Generator</h3>
        <button className="shader-generator__close-btn" onClick={onClose}>×</button>
      </div>

      <div className="shader-generator__search">
        <input
          type="text"
          placeholder="Search effects..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="shader-generator__search-input"
        />
      </div>

      <div className="shader-generator__content">
        <div className="shader-generator__available">
          <div className="shader-generator__subtitle">Available Effects</div>
          <div className="shader-generator__categories">
            {filteredCategories.map(category => (
              <div key={category.id} className="shader-generator__category">
                <button
                  className="shader-generator__category-header"
                  onClick={() => toggleCategory(category.id)}
                >
                  <span className={`shader-generator__category-arrow ${expandedCategories.has(category.id) ? 'expanded' : ''}`}>
                    ▸
                  </span>
                  <span className="shader-generator__category-name">{category.name}</span>
                  <span className="shader-generator__category-count">({category.effects.length})</span>
                </button>

                {expandedCategories.has(category.id) && (
                  <div className="shader-generator__category-items">
                    {category.effects.map(effectType => {
                      const info = getEffectInfo(effectType)
                      if (!info) return null
                      const isSelected = selectedEffects.includes(effectType)

                      return (
                        <button
                          key={effectType}
                          className={`shader-generator__effect-btn ${isSelected ? 'selected' : ''}`}
                          onClick={() => isSelected ? removeEffect(effectType) : addEffect(effectType)}
                          disabled={isSelected}
                        >
                          <span className="shader-generator__effect-name">{info.name}</span>
                          <span className="shader-generator__effect-params">
                            {info.paramCount} param{info.paramCount !== 1 ? 's' : ''}
                          </span>
                          <span className="shader-generator__effect-add">
                            {isSelected ? '✓' : '+'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="shader-generator__pipeline">
          <div className="shader-generator__subtitle">
            Effect Pipeline
            <div className="shader-generator__subtitle-actions">
              <button className="shader-generator__surprise-btn" onClick={handleSurpriseMe}>
                🎲 Surprise Me
              </button>
              {selectedEffects.length > 0 && (
                <button className="shader-generator__clear-btn" onClick={clearAll}>
                  Clear All
                </button>
              )}
            </div>
          </div>

          {selectedEffects.length === 0 ? (
            <div className="shader-generator__empty">
              <p>Add effects from the left panel</p>
              <p className="shader-generator__empty-hint">Effects are applied top to bottom</p>
            </div>
          ) : (
            <div className="shader-generator__pipeline-list">
              {selectedEffects.map((effectType, index) => {
                const info = getEffectInfo(effectType)
                if (!info) return null

                return (
                  <div key={`${effectType}-${index}`} className="shader-generator__pipeline-item">
                    <div className="shader-generator__pipeline-number">{index + 1}</div>
                    <div className="shader-generator__pipeline-info">
                      <span className="shader-generator__pipeline-name">{info.name}</span>
                      <span className="shader-generator__pipeline-params">
                        {info.paramCount} param{info.paramCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="shader-generator__pipeline-controls">
                      <button
                        className="shader-generator__pipeline-btn"
                        onClick={() => moveEffect(index, -1)}
                        disabled={index === 0}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        className="shader-generator__pipeline-btn"
                        onClick={() => moveEffect(index, 1)}
                        disabled={index === selectedEffects.length - 1}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        className="shader-generator__pipeline-btn shader-generator__pipeline-btn--remove"
                        onClick={() => removeEffect(effectType)}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="shader-generator__summary">
            <div className="shader-generator__summary-item">
              <span className="shader-generator__summary-label">Effects:</span>
              <span className="shader-generator__summary-value">{selectedEffects.length}</span>
            </div>
            <div className="shader-generator__summary-item">
              <span className="shader-generator__summary-label">Total Params:</span>
              <span className="shader-generator__summary-value">
                {selectedEffects.reduce((sum, type) => {
                  const info = getEffectInfo(type)
                  return sum + (info?.paramCount || 0)
                }, 0)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="shader-generator__footer">
        <div className="shader-generator__name-input-container">
          <label className="shader-generator__name-label">Shader Name:</label>
          <input
            type="text"
            className="shader-generator__name-input"
            value={shaderName}
            onChange={(e) => setShaderName(e.target.value)}
            placeholder="Generated Shader"
          />
        </div>
        <div className="shader-generator__footer-actions">
          <button className="shader-generator__btn shader-generator__btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="shader-generator__btn shader-generator__btn--primary"
            onClick={handleGenerate}
            disabled={selectedEffects.length === 0}
          >
            Generate Shader
          </button>
        </div>
      </div>
    </div>
  )
}
