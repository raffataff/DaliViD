/**
 * DaliVid — generatorClips.js
 * Helpers for creating "generator" timeline clips (text / image) and their
 * default params. Keeps the Media Pool and the Timeline drop handler in sync so
 * a text/image clip always has the shader-uniform defaults it needs to render
 * (a missing u_img_scale would upload as 0 → invisible), plus the CPU-side
 * text/style defaults.
 */

import { parseParams, getDefaultParams } from './paramParser'
import { getShaderSource } from '../shaders/shaderRegistry'
import { DEFAULT_TEXT_PARAMS } from './textRenderer'

/** Default @param values for a registry shader (fit/scale/rotation/reactive…). */
function shaderDefaults(type) {
  const src = getShaderSource(type)
  return src ? getDefaultParams(parseParams(src)) : {}
}

/** Params for an IMAGE clip/node: image transform defaults + the data URL. */
export function makeImageClipParams({ imageSrc = null, imageName = '' } = {}) {
  return { ...shaderDefaults('IMAGE_INPUT'), imageSrc, imageName }
}

/** Params for a TEXT clip/node: shader transform defaults + text/style + overrides. */
export function makeTextClipParams(overrides = {}) {
  return { ...shaderDefaults('TEXT_INPUT'), ...DEFAULT_TEXT_PARAMS, ...overrides }
}

// Default on-timeline length (seconds) for a freshly added generator clip.
export const DEFAULT_GENERATOR_DURATION = 5

// Starter title styles, offered as draggable cards + the "+ Add Text" default.
export const TEXT_PRESETS = [
  { id: 'title', name: 'Title', params: { text: 'Title', fontSize: 150, fontWeight: '800', posY: 0.5 } },
  { id: 'subtitle', name: 'Subtitle', params: { text: 'Subtitle', fontSize: 66, fontWeight: '500', posY: 0.72 } },
  {
    id: 'lower-third', name: 'Lower Third',
    params: { text: 'Name\nRole', fontSize: 56, fontWeight: '700', align: 'left', posX: 0.14, posY: 0.82, bgColor: '#000000', bgOpacity: 0.45, padding: 26 },
  },
  {
    id: 'caption', name: 'Caption',
    params: { text: 'Caption text', fontSize: 50, fontWeight: '600', posY: 0.9, strokeColor: '#000000', strokeWidth: 5 },
  },
]
