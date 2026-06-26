/**
 * DaliVid — audioDrivers.js
 * Single source of truth for the audio "driver" uniforms that every effect
 * shader gets for free. Band ids match the Audio Splitter's output sockets, so
 * wiring a band into a node's "Audio Drivers" socket drives the matching u_<band>.
 *
 *   u_sub_bass  u_bass  u_low_mid  u_mid  u_high_mid  u_presence  u_treble  u_rms
 *   u_beat  (always live — no wiring needed)
 *
 * Each gated band is 0.0 until its splitter output is connected, which makes
 * additive (x + u_bass) and multiplicative (x * (1.0 + u_bass)) use neutral and
 * NaN-safe by default.
 */

// The 8 gated bands (driven by the Audio Drivers socket; 0.0 when unconnected).
export const AUDIO_DRIVER_BANDS = ['sub_bass', 'bass', 'low_mid', 'mid', 'high_mid', 'presence', 'treble', 'rms']

// Everything auto-declared into a shader: the 8 bands plus the always-live beat.
export const AUDIO_DECLARE_UNIFORMS = [...AUDIO_DRIVER_BANDS, 'beat']

function isDeclared(source, name) {
  return new RegExp(`uniform\\s+(?:lowp\\s+|mediump\\s+|highp\\s+)?float\\s+u_${name}\\b`).test(source)
}

/** Names from AUDIO_DECLARE_UNIFORMS that the source does not already declare. */
export function missingAudioDrivers(source) {
  if (!source) return []
  return AUDIO_DECLARE_UNIFORMS.filter(name => !isDeclared(source, name))
}

function insertAfterPrecision(source, block) {
  const lines = source.split('\n')
  let idx = lines.findIndex(l => /\bprecision\b/.test(l))
  if (idx === -1) idx = lines.findIndex(l => /#version/.test(l))
  if (idx === -1) return `${block}\n${source}`
  lines.splice(idx + 1, 0, block)
  return lines.join('\n')
}

/**
 * Compile-time injection: silently declare any missing driver uniforms so they
 * can be referenced in code without a uniform line. The editable source is left
 * untouched — only the compiled string carries these lines.
 */
export function injectAudioDrivers(source) {
  if (!source) return source
  const missing = missingAudioDrivers(source)
  if (missing.length === 0) return source
  return insertAfterPrecision(source, missing.map(n => `uniform float u_${n};`).join('\n'))
}

/**
 * Editor view: a VISIBLE, commented declaration block listing every audio driver
 * the shader doesn't already declare, so users can discover and use the full set.
 * Idempotent — once these are declared (e.g. after saving), it adds nothing.
 */
export function audioDriverHeader(source) {
  if (!source) return source
  const missing = missingAudioDrivers(source)
  if (missing.length === 0) return source
  const block = [
    '// ─── Audio drivers (auto-provided) ────────────────────────────────',
    '// Wire the Audio Splitter bands into this node\'s "Audio Drivers" socket.',
    '// Each is 0.0 until its band is connected; u_beat is always live.',
    ...missing.map(n => `uniform float u_${n};`),
    '// ──────────────────────────────────────────────────────────────────',
  ].join('\n')
  return insertAfterPrecision(source, block)
}
