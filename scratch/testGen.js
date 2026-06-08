import fs from 'fs'
import path from 'path'

const registryPath = path.resolve('src/shaders/shaderRegistry.js')
const generatorPath = path.resolve('src/shaders/shaderGenerator.js')

const registryCode = fs.readFileSync(registryPath, 'utf8')

const SHADER_SOURCES = {}
const registerRegex = /registerShader\(\s*'([^']+)'\s*,\s*`([\s\S]*?)`\s*\)/g
let match
while ((match = registerRegex.exec(registryCode)) !== null) {
  SHADER_SOURCES[match[1]] = match[2]
}

console.log('Parsed shaders:', Object.keys(SHADER_SOURCES))

function generateCombinedShader(effectTypes, shaderName = 'Generated Effect') {
  const EXCLUDE_UNIFORMS = new Set([
    'u_texture', 'u_resolution', 'u_time', 'u_frame', 'v_uv', 'fragColor', 'gl_FragColor'
  ])

  const effects = effectTypes.map(type => ({
    type,
    source: SHADER_SOURCES[type],
    params: [],
  })).filter(e => e.source)

  const usedUniforms = new Set(EXCLUDE_UNIFORMS)
  const uniformDeclarations = new Map()
  const paramDirectives = []
  const helperFunctions = new Map()
  const effectFunctions = []

  for (const effect of effects) {
    const { source, type } = effect
    const lines = source.split('\n')

    let inMain = false
    let braceCount = 0
    const mainLines = []
    const effectUniforms = []
    let pendingParam = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      const paramMatch = trimmed.match(/\/\/\s*@param\s+(.+)/)
      if (paramMatch) {
        pendingParam = paramMatch[1]
        continue
      }

      if (trimmed.includes('void main()')) {
        inMain = true
        braceCount = trimmed.includes('{') ? 1 : 0
        continue
      }

      if (inMain) {
        const openBraces = (line.match(/{/g) || []).length
        const closeBraces = (line.match(/}/g) || []).length
        braceCount += openBraces - closeBraces

        if (braceCount <= 0 && closeBraces > 0) {
          inMain = false
          continue
        }

        // PUSH ALL lines (do not discard braces)
        mainLines.push(line)
        continue
      }

      const uniformMatch = trimmed.match(/uniform\s+(float|int|bool|vec2|vec3|vec4|sampler2D)\s+(u_\w+)\s*;/)
      if (uniformMatch) {
        const [, uniformType, uniformName] = uniformMatch
        if (!EXCLUDE_UNIFORMS.has(uniformName)) {
          if (!usedUniforms.has(uniformName)) {
            usedUniforms.add(uniformName)
            uniformDeclarations.set(uniformName, { type: uniformType, name: uniformName })
          }
          effectUniforms.push({ type: uniformType, name: uniformName })
        }
        if (pendingParam) {
          paramDirectives.push({ directive: `// @param ${pendingParam}`, uniformName })
        }
        pendingParam = null
        continue
      }

      if (trimmed.match(/^(float|vec[234]|int|bool|vec2|vec3|vec4)\s+\w+\s*\([^)]*\)\s*\{/)) {
        const funcLines = [line]
        let funcBraceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
        let j = i + 1
        while (funcBraceCount > 0 && j < lines.length) {
          funcLines.push(lines[j])
          funcBraceCount += (lines[j].match(/{/g) || []).length
          funcBraceCount -= (lines[j].match(/}/g) || []).length
          j++
        }
        const funcName = trimmed.match(/(\w+)\s*\(/)[1]
        if (!helperFunctions.has(funcName)) {
          helperFunctions.set(funcName, funcLines)
        }
        i = j - 1
        continue
      }

      pendingParam = null
    }

    const effectFuncName = `effect_${type.toLowerCase()}`

    const processedMain = mainLines.map(l => {
      let processed = l
      // Strip type declaration of col and uv to prevent redefinition
      processed = processed.replace(/\bvec4\s+col\b/g, 'col')
      processed = processed.replace(/\bvec2\s+uv\b/g, 'uv')
      processed = processed.replace(/\bfragColor\b/g, 'col')
      // Replace v_uv with uv to use parameter coordinate
      processed = processed.replace(/\bv_uv\b/g, 'uv')
      return processed
    })

    const indent = '  '
    const funcLines = [`vec4 ${effectFuncName}(vec2 uv, vec4 col) {`]
    for (const line of processedMain) {
      if (line.trim()) {
        funcLines.push(`${indent}${line.trimEnd()}`)
      }
    }
    funcLines.push(`${indent}return col;`)
    funcLines.push(`}`)

    effectFunctions.push({ name: effectFuncName, type, body: funcLines.join('\n') })
  }

  return assembleShader({
    shaderName,
    paramDirectives,
    uniformDeclarations: Array.from(uniformDeclarations.values()),
    helperFunctions: Array.from(helperFunctions.values()),
    effectFunctions,
  })
}

function assembleShader({ paramDirectives, uniformDeclarations, helperFunctions, effectFunctions }) {
  const lines = []

  lines.push(`#version 300 es`)
  lines.push(`precision highp float;`)
  lines.push(`in vec2 v_uv;`)
  lines.push(`uniform sampler2D u_texture;`)
  lines.push(`uniform vec2 u_resolution;`)
  lines.push(`uniform float u_time;`)
  lines.push(`uniform int u_frame;`)
  lines.push(``)

  const directiveMap = new Map()
  for (const pd of paramDirectives) {
    directiveMap.set(pd.uniformName, pd.directive)
  }

  if (uniformDeclarations.length > 0) {
    lines.push(`// Parameters`)
    for (const decl of uniformDeclarations) {
      const directive = directiveMap.get(decl.name)
      if (directive) {
        lines.push(directive)
      }
      lines.push(`uniform ${decl.type} ${decl.name};`)
    }
    lines.push(``)
  }

  if (helperFunctions.length > 0) {
    lines.push(`// Helper Functions`)
    for (const func of helperFunctions) {
      for (const line of func) {
        lines.push(line)
      }
      lines.push(``)
    }
  }

  lines.push(`// Effect Passes`)
  for (const ef of effectFunctions) {
    lines.push(ef.body)
    lines.push(``)
  }

  lines.push(`void main() {`)
  lines.push(`  vec4 col = texture(u_texture, v_uv);`)
  lines.push(``)

  for (const ef of effectFunctions) {
    lines.push(`  col = ${ef.name}(v_uv, col);`)
  }

  lines.push(``)
  lines.push(`  fragColor = col;`)
  lines.push(`}`)

  return lines.join('\n')
}

// Generate code for a few combinations
console.log('=== VORONOI + GLITCH + NOISE ===')
console.log(generateCombinedShader(['VORONOI', 'GLITCH', 'NOISE']))
