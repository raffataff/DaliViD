/**
 * DaliVid — ShaderProgram.js
 * Compiles vertex+fragment shaders, links programs, caches by hash,
 * and provides uniform upload helpers for all standard uniforms.
 */

import { md5 } from '../utils/md5.js'

// Standard vertex shader for full-screen quad (shared by all effect passes)
const FULLSCREEN_QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texcoord;
out vec2 v_uv;
void main() {
  v_uv = a_texcoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

// Internal cache: hash → { program, uniformLocations, vertexShader, fragmentShader }
// Insertion order is used for LRU eviction (least-recently-used is evicted first).
const programCache = new Map()

// Upper bound on cached programs. Generous so active chains are never evicted
// under normal use; primarily a safety valve against unbounded growth from
// repeated live-editing of custom shaders.
const MAX_CACHED_PROGRAMS = 512

/**
 * Compile a shader (vertex or fragment).
 * Returns the shader object or null on error.
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    return { shader: null, errors: parseShaderErrors(log) }
  }
  return { shader, errors: [] }
}

/**
 * Parse GL shader info log into structured error objects.
 * Format: "ERROR: line:column: message"
 */
function parseShaderErrors(log) {
  if (!log) return []
  const errors = []
  const lines = log.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/ERROR:\s*(\d+):(\d+):\s*(.+)/)
    if (match) {
      errors.push({
        line: parseInt(match[1], 10),
        column: parseInt(match[2], 10),
        message: match[3].trim(),
        raw: line,
      })
    } else if (trimmed.match(/^(WARNING|ERROR)/i)) {
      errors.push({
        line: 0,
        column: 0,
        message: trimmed,
        raw: line,
      })
    }
  }
  return errors
}

/**
 * Create or retrieve a cached shader program.
 * @param {WebGL2RenderingContext} gl
 * @param {string} fragmentSource — the fragment shader GLSL source
 * @param {string} [vertexSource] — vertex shader (defaults to fullscreen quad)
 * @returns {{ program, uniformLocations, errors, cached }}
 */
export function createShaderProgram(gl, fragmentSource, vertexSource = FULLSCREEN_QUAD_VS) {
  const hash = md5(vertexSource + '||' + fragmentSource)

  // Check cache. On a hit, refresh recency (delete + re-insert moves it to the
  // most-recently-used end) so frequently used programs survive eviction.
  if (programCache.has(hash)) {
    const cached = programCache.get(hash)
    programCache.delete(hash)
    programCache.set(hash, cached)
    return { ...cached, errors: [], cached: true }
  }

  // Compile vertex shader
  const vsResult = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  if (!vsResult.shader) {
    return { program: null, uniformLocations: {}, errors: vsResult.errors, cached: false }
  }

  // Compile fragment shader
  const fsResult = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!fsResult.shader) {
    gl.deleteShader(vsResult.shader)
    return { program: null, uniformLocations: {}, errors: fsResult.errors, cached: false }
  }

  // Link program
  const program = gl.createProgram()
  gl.attachShader(program, vsResult.shader)
  gl.attachShader(program, fsResult.shader)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    gl.deleteShader(vsResult.shader)
    gl.deleteShader(fsResult.shader)
    return {
      program: null,
      uniformLocations: {},
      errors: [{ line: 0, column: 0, message: `Link error: ${log}`, raw: log }],
      cached: false
    }
  }

  // Shaders can be deleted after linking
  gl.deleteShader(vsResult.shader)
  gl.deleteShader(fsResult.shader)

  // Cache discovered uniform locations and types
  const { locations: uniformLocations, types: uniformTypes } = discoverUniforms(gl, program)

  const entry = { program, uniformLocations, uniformTypes, hash }

  programCache.set(hash, entry)

  // Evict the least-recently-used program(s) if over budget.
  while (programCache.size > MAX_CACHED_PROGRAMS) {
    const oldestKey = programCache.keys().next().value
    if (oldestKey === hash) break // never evict the entry we just created
    const oldest = programCache.get(oldestKey)
    if (oldest && oldest.program) gl.deleteProgram(oldest.program)
    programCache.delete(oldestKey)
  }

  return { program, uniformLocations, uniformTypes, errors: [], cached: false }
}

/**
 * Discover all active uniforms and cache their locations and GL types.
 * Returns { locations: { name → WebGLUniformLocation }, types: { name → GLenum } }
 */
function discoverUniforms(gl, program) {
  const locations = {}
  const types = {}
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)
    if (info) {
      // Handle array uniforms — strip [0] suffix for cleaner access
      const name = info.name.replace(/\[0\]$/, '')
      locations[name] = gl.getUniformLocation(program, info.name)
      types[name] = info.type
      // For arrays, also get each element location
      if (info.size > 1) {
        for (let j = 0; j < info.size; j++) {
          const arrayName = `${name}[${j}]`
          locations[arrayName] = gl.getUniformLocation(program, arrayName)
          types[arrayName] = info.type
        }
      }
    }
  }
  return { locations, types }
}

/**
 * Upload all standard uniforms plus any custom param uniforms.
 * Uses the GL uniform type from shader introspection to pick the correct glUniform* call.
 * @param {WebGL2RenderingContext} gl
 * @param {object} uniformLocations — from createShaderProgram
 * @param {object} uniformTypes — { name → GLenum } from createShaderProgram
 * @param {object} uniforms — { name: value } map
 */
export function uploadUniforms(gl, uniformLocations, uniformTypes, uniforms) {
  for (const [name, value] of Object.entries(uniforms)) {
    const loc = uniformLocations[name]
    if (loc === undefined || loc === null) continue

    const glType = uniformTypes[name]

    if (glType === gl.INT || glType === gl.SAMPLER_2D || glType === gl.SAMPLER_CUBE) {
      gl.uniform1i(loc, typeof value === 'boolean' ? (value ? 1 : 0) : (value | 0))
    } else if (glType === gl.FLOAT_VEC2) {
      if (Array.isArray(value) && value.length >= 2) gl.uniform2f(loc, value[0], value[1])
      else if (Array.isArray(value)) gl.uniform2f(loc, value[0], 0)
      else gl.uniform2f(loc, value, 0)
    } else if (glType === gl.FLOAT_VEC3) {
      if (Array.isArray(value) && value.length >= 3) gl.uniform3f(loc, value[0], value[1], value[2])
      else if (Array.isArray(value)) gl.uniform3f(loc, value[0], value[1] || 0, value[2] || 0)
      else gl.uniform3f(loc, value, value, value)
    } else if (glType === gl.FLOAT_VEC4) {
      if (Array.isArray(value) && value.length >= 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3])
      else if (Array.isArray(value)) gl.uniform4f(loc, value[0], value[1] || 0, value[2] || 0, value[3] || 0)
      else gl.uniform4f(loc, value, value, value, value)
    } else if (glType === gl.FLOAT) {
      gl.uniform1f(loc, value)
    } else {
      // Unknown type — fall back to JS-level guessing
      if (typeof value === 'boolean') {
        gl.uniform1i(loc, value ? 1 : 0)
      } else if (typeof value === 'number') {
        gl.uniform1f(loc, value)
      } else if (Array.isArray(value)) {
        switch (value.length) {
          case 2: gl.uniform2f(loc, value[0], value[1]); break
          case 3: gl.uniform3f(loc, value[0], value[1], value[2]); break
          case 4: gl.uniform4f(loc, value[0], value[1], value[2], value[3]); break
          default:
            gl.uniform1fv(loc, new Float32Array(value))
        }
      }
    }
  }
}

/**
 * Upload standard uniforms that are common to all DaliVid shaders.
 */
export function uploadStandardUniforms(gl, locations, state) {
  const {
    resolution = [1920, 1080],
    time = 0,
    frame = 0,
    playhead = 0,
    audioBands = [0,0,0,0,0,0,0,0],
    audioRms = 0,
    beat = 0,
    beatCount = 0,
  } = state

  // vec2 u_resolution
  if (locations.u_resolution) gl.uniform2f(locations.u_resolution, resolution[0], resolution[1])
  // float u_time
  if (locations.u_time) gl.uniform1f(locations.u_time, time)
  // int u_frame
  if (locations.u_frame) gl.uniform1i(locations.u_frame, frame)
  // float u_playhead
  if (locations.u_playhead) gl.uniform1f(locations.u_playhead, playhead)
  // Always-live audio uniforms. There is ONE audio model now — the wire-up
  // drivers (u_bass … u_rms), gated per-node by the Audio Drivers socket. The
  // only always-live audio inputs are:
  //   • u_audio_bands[8] / u_audio_rms — reserved for the Audio Visualizer node,
  //     whose whole purpose is to react to sound (the one deliberate exception),
  //   • u_beat — a convenient always-on beat trigger available to any shader.
  // float u_audio_bands[8]
  if (locations['u_audio_bands']) {
    gl.uniform1fv(locations['u_audio_bands'], new Float32Array(audioBands))
  }
  // float u_audio_rms
  if (locations.u_audio_rms) gl.uniform1f(locations.u_audio_rms, audioRms)
  // float u_beat
  if (locations.u_beat) gl.uniform1f(locations.u_beat, beat)
  // int u_beat_count
  if (locations.u_beat_count) gl.uniform1i(locations.u_beat_count, beatCount)

  // NOTE: the short-name band drivers (u_bass, u_mid, u_treble, u_rms,
  // u_sub_bass, u_low_mid, u_high_mid, u_presence) are NOT uploaded here — they
  // are gated per-node by the executor based on the node's Audio Drivers socket
  // (0 when unconnected). u_beat above is intentionally always-live.
}

/**
 * Delete a program by its hash (cleanup).
 */
export function deleteShaderProgram(gl, hash) {
  if (programCache.has(hash)) {
    const entry = programCache.get(hash)
    gl.deleteProgram(entry.program)
    programCache.delete(hash)
  }
}

/**
 * Clear the entire program cache (e.g. on context loss or renderer disposal).
 * Pass the GL context to also delete the underlying programs; without it the
 * map is simply emptied (e.g. when the context is already gone).
 */
export function clearProgramCache(gl) {
  if (gl) {
    for (const entry of programCache.values()) {
      if (entry && entry.program) gl.deleteProgram(entry.program)
    }
  }
  programCache.clear()
}

export { FULLSCREEN_QUAD_VS, parseShaderErrors }
