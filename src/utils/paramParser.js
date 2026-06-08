/**
 * DaliVid — paramParser.js
 * Parses @param directives from GLSL comments into slider config objects.
 * Also parses @audiobind directives for default audio bindings.
 */

/**
 * Parse all @param and @audiobind directives from a GLSL source string.
 * @param {string} source — full GLSL shader source
 * @returns {Array<ParamConfig>}
 * 
 * ParamConfig: {
 *   name: string,           // display label
 *   uniformName: string,    // GLSL uniform name
 *   uniformType: string,    // 'float' | 'int' | 'bool' | 'vec3'
 *   type: string,           // 'slider' | 'checkbox' | 'color' | 'select'
 *   min: number,
 *   max: number,
 *   default: any,
 *   step: number,
 *   options: string[],      // for type=select
 *   audioBind: object|null, // { band, multiplier, offset }
 * }
 */
export function parseParams(source) {
  if (!source) return []

  const lines = source.split('\n')
  const params = []
  let pendingParam = null
  let pendingAudioBind = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Check for @param directive
    const paramMatch = line.match(/\/\/\s*@param\s+(.+)/)
    if (paramMatch) {
      // If there was a previous pending param without a uniform, discard it
      pendingParam = parseParamDirective(paramMatch[1])
      continue
    }

    // Check for @audiobind directive
    const audioMatch = line.match(/\/\/\s*@audiobind\s+(.+)/)
    if (audioMatch) {
      pendingAudioBind = parseAudioBindDirective(audioMatch[1])
      continue
    }

    // Check for uniform declaration
    const uniformMatch = line.match(/uniform\s+(float|int|bool|vec2|vec3|vec4)\s+(u_\w+)\s*;/)
    if (uniformMatch && pendingParam) {
      const uniformType = uniformMatch[1]
      const uniformName = uniformMatch[2]

      const config = buildParamConfig(pendingParam, uniformType, uniformName)
      if (config) {
        config.audioBind = pendingAudioBind || null
        config.lineNumber = i + 1
        params.push(config)
      }

      pendingParam = null
      pendingAudioBind = null
    } else if (!line.startsWith('//') && line.length > 0) {
      // Non-comment, non-empty line clears pending directives
      if (!uniformMatch) {
        pendingParam = null
        pendingAudioBind = null
      }
    }
  }

  return params
}

/**
 * Parse a single @param directive string into raw attributes.
 * e.g. 'name="Intensity" min=0.0 max=1.0 default=0.5 step=0.01'
 */
function parseParamDirective(directiveStr) {
  const attrs = {}

  // Match key=value pairs (value can be quoted string or unquoted)
  const regex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w.,#-]+))/g
  let match
  while ((match = regex.exec(directiveStr)) !== null) {
    const key = match[1]
    const value = match[2] || match[3] || match[4]
    attrs[key] = value
  }

  return attrs
}

/**
 * Parse @audiobind directive.
 * e.g. 'band=bass multiplier=2.0 offset=0.0'
 */
function parseAudioBindDirective(directiveStr) {
  const attrs = {}
  const regex = /(\w+)\s*=\s*([\w.-]+)/g
  let match
  while ((match = regex.exec(directiveStr)) !== null) {
    attrs[match[1]] = match[2]
  }

  const bandNames = ['sub-bass', 'bass', 'low-mid', 'mid', 'upper-mid', 'presence', 'brilliance', 'rms', 'beat']
  let bandIndex = bandNames.indexOf(attrs.band)
  if (bandIndex === -1) bandIndex = parseInt(attrs.band, 10) || 0

  return {
    band: attrs.band || 'bass',
    bandIndex,
    multiplier: parseFloat(attrs.multiplier) || 1.0,
    offset: parseFloat(attrs.offset) || 0.0,
  }
}

/**
 * Build a complete param config from parsed directive and uniform info.
 */
function buildParamConfig(attrs, uniformType, uniformName) {
  if (!attrs.name) return null

  const config = {
    name: attrs.name,
    uniformName,
    uniformType,
    type: null,
    min: 0,
    max: 1,
    default: 0,
    step: 0.01,
    options: null,
    audioBind: null,
  }

  // Determine control type
  if (attrs.type) {
    config.type = attrs.type
  } else {
    // Infer from GLSL type
    switch (uniformType) {
      case 'float': config.type = 'slider'; break
      case 'int': config.type = 'slider'; config.step = 1; break
      case 'bool': config.type = 'checkbox'; break
      case 'vec3': config.type = 'color'; break
      default: config.type = 'slider'
    }
  }

  // Override for explicit type
  if (attrs.type === 'select') {
    config.type = 'select'
    config.options = attrs.options ? attrs.options.split(',').map(s => s.trim()) : []
  }
  if (attrs.type === 'color') {
    config.type = 'color'
  }
  if (attrs.type === 'bool') {
    config.type = 'checkbox'
  }

  // Parse numeric attributes
  if (attrs.min !== undefined) config.min = parseFloat(attrs.min)
  if (attrs.max !== undefined) config.max = parseFloat(attrs.max)
  if (attrs.step !== undefined) config.step = parseFloat(attrs.step)

  // Parse default
  if (attrs.default !== undefined) {
    if (config.type === 'checkbox') {
      config.default = attrs.default === 'true' || attrs.default === '1'
    } else if (config.type === 'color') {
      config.default = attrs.default.startsWith('#') ? attrs.default : `#${attrs.default}`
    } else if (config.type === 'select') {
      config.default = parseInt(attrs.default, 10) || 0
    } else {
      config.default = parseFloat(attrs.default)
    }
  } else {
    // Defaults by type
    if (config.type === 'checkbox') config.default = false
    else if (config.type === 'color') config.default = '#ffffff'
    else if (config.type === 'select') config.default = 0
    else config.default = config.min
  }

  return config
}

/**
 * Convert hex color to vec3 (normalized 0-1 RGB).
 */
export function hexToVec3(hex) {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ]
}

/**
 * Convert vec3 (normalized 0-1) to hex string.
 */
export function vec3ToHex(v) {
  const r = Math.round(v[0] * 255).toString(16).padStart(2, '0')
  const g = Math.round(v[1] * 255).toString(16).padStart(2, '0')
  const b = Math.round(v[2] * 255).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
}

/**
 * Get default param values from a list of param configs.
 */
export function getDefaultParams(paramConfigs) {
  const params = {}
  for (const config of paramConfigs) {
    params[config.uniformName] = config.default
  }
  return params
}
