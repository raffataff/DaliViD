/**
 * DaliViD — clipTransform.js
 * Per-clip Pan / Zoom / Rotate: the single shared definition of a clip's framing
 * transform, so the Renderer, the Inspector and the keyframe system agree.
 *
 * The controls are NOT hardcoded here — they are the TRANSFORM node's own
 * `@param` directives, parsed out of the shader. Adding a `@param` to TRANSFORM
 * therefore adds a clip control with no UI edit, exactly the way SHAPE_INPUT's
 * clip section works. It also guarantees the node and the clip control produce
 * identical pixels: the Renderer drives the same compiled program for both.
 *
 * `clip.transform` is a plain uniform-keyed object ({ u_xf_zoom: 1.4, … }), or
 * null/absent for "no transform" — which skips the GPU pass and its FBO
 * entirely, so untransformed clips (most of them) cost nothing.
 */

import { getShaderSource } from '../shaders/shaderRegistry'
import { parseParams } from './paramParser'

/**
 * Reserved node id for a clip's transform keyframe tracks. Keyframes are keyed
 * by (clipId, nodeId, paramName) and a clip transform belongs to no graph node,
 * so it claims this id. The `__` prefix can't collide with the graph store's
 * generated ids (`node_<timestamp>_<n>`).
 */
export const CLIP_TRANSFORM_NODE_ID = '__clip_transform'

let _configs = null
/** The TRANSFORM shader's @param configs (parsed once, then cached). */
export function getTransformConfigs() {
  if (!_configs) _configs = parseParams(getShaderSource('TRANSFORM')) || []
  return _configs
}

let _defaults = null
/** Default value for every transform param, keyed by uniform name. */
export function getTransformDefaults() {
  if (!_defaults) {
    _defaults = {}
    for (const cfg of getTransformConfigs()) _defaults[cfg.uniformName] = cfg.default
  }
  return _defaults
}

/**
 * Merge a clip's stored transform — and any keyframed overrides for this frame —
 * over the shader defaults, returning a complete param object.
 *
 * Only known `u_xf_*` keys are read, so a project saved before this feature
 * (clips carried a dead placeholder `{ x, y, scaleX, scaleY, rotation }`) loads
 * as identity instead of feeding junk to the shader.
 *
 * @param {object|null} transform — clip.transform
 * @param {object|null} overrides — keyframed values for this frame
 */
export function resolveClipTransform(transform, overrides = null) {
  const out = { ...getTransformDefaults() }
  for (const key in out) {
    if (transform && transform[key] != null) out[key] = transform[key]
    if (overrides && overrides[key] != null) out[key] = overrides[key]
  }
  return out
}

/**
 * Is this (already resolved) transform a no-op? Used to skip the extra
 * full-screen pass for the common untransformed clip. Note that non-zero Bass
 * Zoom / Beat Punch count as non-identity even at zoom 1.0 — they modulate the
 * zoom every frame, so the pass has to run.
 */
export function isIdentityTransform(transform) {
  if (!transform) return true
  const defaults = getTransformDefaults()
  for (const key in defaults) {
    const v = transform[key]
    if (v == null) continue
    if (Math.abs(v - defaults[key]) > 1e-6) return false
  }
  return true
}

/**
 * True when the clip kind can be reframed. Audio clips have no picture of their
 * own (their graph draws over a blank frame), so a transform there would only
 * push generative output around — confusing, and not what the control means.
 */
export function clipSupportsTransform(clip) {
  return !!clip && clip.fileType !== 'audio'
}
