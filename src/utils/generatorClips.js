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

/**
 * Params for a SHAPE clip/node: every control is a shader @param, so the defaults
 * come straight from the registry and a preset is just an override patch.
 */
export function makeShapeClipParams(overrides = {}) {
  return { ...shaderDefaults('SHAPE_INPUT'), ...overrides }
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

// Starter shapes, offered as draggable cards + the "+ Add Shape" default (the
// first entry). Each `params` patch is layered over the SHAPE_INPUT shader's
// @param defaults, so a preset only states what makes it different.
// u_shp_type indices match the shader's "Shape" select:
//   0 Rectangle · 1 Ellipse · 2 Triangle · 3 Polygon · 4 Star · 5 Ring
//   6 Capsule · 7 Cross
export const SHAPE_PRESETS = [
  { id: 'rect', name: 'Rectangle', icon: '▭', params: { u_shp_type: 0, u_shp_w: 0.9, u_shp_h: 0.55 } },
  { id: 'rounded', name: 'Rounded Box', icon: '▢', params: { u_shp_type: 0, u_shp_w: 0.9, u_shp_h: 0.55, u_shp_corner: 0.2 } },
  { id: 'circle', name: 'Circle', icon: '●', params: { u_shp_type: 1, u_shp_w: 0.6, u_shp_h: 0.6 } },
  { id: 'ellipse', name: 'Ellipse', icon: '⬭', params: { u_shp_type: 1, u_shp_w: 1.0, u_shp_h: 0.55 } },
  { id: 'triangle', name: 'Triangle', icon: '▲', params: { u_shp_type: 2, u_shp_w: 0.7, u_shp_h: 0.7 } },
  { id: 'hexagon', name: 'Hexagon', icon: '⬡', params: { u_shp_type: 3, u_shp_sides: 6, u_shp_w: 0.65, u_shp_h: 0.65 } },
  { id: 'star', name: 'Star', icon: '★', params: { u_shp_type: 4, u_shp_sides: 5, u_shp_inner: 0.45, u_shp_w: 0.7, u_shp_h: 0.7 } },
  { id: 'ring', name: 'Ring', icon: '◎', params: { u_shp_type: 5, u_shp_w: 0.65, u_shp_h: 0.65, u_shp_thick: 0.05 } },
  { id: 'cross', name: 'Cross', icon: '✚', params: { u_shp_type: 7, u_shp_inner: 0.3, u_shp_w: 0.6, u_shp_h: 0.6 } },
  {
    id: 'lower-bar', name: 'Lower Bar', icon: '▬',
    params: { u_shp_type: 6, u_shp_w: 1.5, u_shp_h: 0.16, u_shp_y: -0.62, u_shp_fill: '#000000', u_shp_fill_a: 0.7 },
  },
  {
    id: 'outline', name: 'Outline Box', icon: '□',
    params: { u_shp_type: 0, u_shp_w: 1.0, u_shp_h: 0.6, u_shp_fill_a: 0, u_shp_stroke: 0.012, u_shp_stroke_col: '#ffffff' },
  },
  {
    id: 'pulse-dot', name: 'Pulse Dot', icon: '◉',
    params: { u_shp_type: 1, u_shp_w: 0.35, u_shp_h: 0.35, u_bass_scale: 0.6, u_beat_punch: 0.4, u_shp_feather: 0.02 },
  },
]
