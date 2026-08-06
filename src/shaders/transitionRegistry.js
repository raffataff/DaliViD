/**
 * DaliVid — transitionRegistry.js
 * Edge-transition shaders. A transition owns one of a clip's two edge regions
 * (see utils/clipTransitions.js) and mixes the two sides of that region by
 * `u_progress`, 0 → 1 across it, replacing the plain blend-mode composite:
 *
 *   HEAD over an overlap → u_from = everything composited so far (the outgoing
 *     clip over the lower tracks), u_to = this clip. A crossfade.
 *   HEAD with nothing before it → u_from = the backdrop behind the clip (lower
 *     tracks, else transparent/black), u_to = this clip. A shaped fade-in.
 *   TAIL → u_from = this clip, u_to = the backdrop behind it. A shaped fade-out
 *     "to nothing", which is the direction the old overlap-only model had no
 *     way to express.
 *
 * A shader never needs to know which case it is in: it always mixes FROM → TO.
 *
 * Conventions (mirrors shaderRegistry.js):
 *   - `@param` directives become Inspector sliders (parsed by paramParser).
 *   - Each entry's `glsl` defines `vec4 transition(vec2 uv)`; the shared header
 *     provides the samplers/uniforms + helpers, the shared footer applies the
 *     clip × track opacity. buildTransitionShader() assembles the full source.
 *   - u_beat / u_audio_rms are always-live (uploadStandardUniforms), so
 *     transitions can be audio-reactive with no extra wiring.
 */

import { parseParams, getDefaultParams } from '../utils/paramParser.js'

// Shared prelude: samplers, progress, standard uniforms, helpers.
export const TRANSITION_HEADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_from;    // side the region starts on
uniform sampler2D u_to;      // side the region ends on
uniform sampler2D u_backdrop; // what's behind the whole region (see footer)
uniform float u_progress;    // 0 → 1 across the region
uniform float u_opacity;     // clip × track opacity
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_beat;        // always-live beat trigger (0..1 decay)
uniform float u_audio_rms;
out vec4 fragColor;

float t_hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float t_luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// Triangular envelope: 0 at both ends of the transition, 1 at its midpoint.
// Distortion scaled by this is guaranteed to vanish at p=0 and p=1, so the
// hand-off into/out of normal compositing is seamless.
float t_env(float p) { return 1.0 - abs(2.0 * p - 1.0); }
`

// Shared epilogue: every transition returns its mixed color; opacity falls back
// toward the BACKDROP exactly like the blend compositor's u_opacity.
//
// u_backdrop is bound separately from u_from because the two only coincide on a
// head transition. On a TAIL, u_from is the clip itself, so falling back toward
// u_from at low opacity would make a transparent clip re-appear — the fallback
// has to be what's actually behind the region. Head passes bind both to the
// accumulator, so their result is bit-identical to the pre-edge-model footer.
export const TRANSITION_FOOTER = `
void main() {
  vec4 backC = texture(u_backdrop, v_uv);
  vec4 result = transition(v_uv);
  fragColor = mix(backC, result, clamp(u_opacity, 0.0, 1.0));
}
`

export const TRANSITIONS = {
  CROSSFADE: {
    label: 'Crossfade',
    description: 'Classic dissolve with adjustable easing.',
    glsl: `
// @param name="Ease" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_ease;

vec4 transition(vec2 uv) {
  float p = mix(u_progress, smoothstep(0.0, 1.0, u_progress), u_ease);
  return mix(texture(u_from, uv), texture(u_to, uv), p);
}
`,
  },

  DIP_COLOR: {
    label: 'Dip to Color',
    description: 'Fades through a solid colour — dip to black/white. On a tail this is a true fade-out.',
    glsl: `
// @param name="Color" type=color default="#000000"
uniform vec3 u_dip_color;
// @param name="Hold" min=0.0 max=0.9 default=0.0 step=0.01
uniform float u_hold;

vec4 transition(vec2 uv) {
  // Two ramps meeting at the midpoint: FROM → colour, then colour → TO.
  // Hold widens the fully-solid plateau between them (a beat of black).
  float h = u_hold * 0.5;
  float outP = smoothstep(0.0, max(0.0001, 0.5 - h), u_progress);
  float inP  = smoothstep(min(0.9999, 0.5 + h), 1.0, u_progress);
  vec4 dip = vec4(u_dip_color, 1.0);
  vec4 a = mix(texture(u_from, uv), dip, outP);
  return mix(a, texture(u_to, uv), inP);
}
`,
  },

  LUMA_WIPE: {
    label: 'Luma Wipe',
    description: 'Reveals the incoming clip through the outgoing frame’s dark areas first.',
    glsl: `
// @param name="Softness" min=0.01 max=1.0 default=0.25 step=0.01
uniform float u_softness;
// @param name="Invert" type=bool default=false
uniform bool u_invert;

vec4 transition(vec2 uv) {
  vec4 fromC = texture(u_from, uv);
  vec4 toC = texture(u_to, uv);
  float l = t_luma(fromC.rgb);
  if (u_invert) l = 1.0 - l;
  // Threshold sweeps past 1+softness so even the brightest pixels hand off.
  float t0 = u_progress * (1.0 + u_softness);
  float m = 1.0 - smoothstep(t0 - u_softness, t0, l);
  return mix(fromC, toC, m);
}
`,
  },

  WIPE: {
    label: 'Wipe',
    description: 'Directional edge wipe at any angle.',
    glsl: `
// @param name="Angle" min=0.0 max=360.0 default=0.0 step=1.0
uniform float u_angle;
// @param name="Softness" min=0.0 max=0.5 default=0.05 step=0.01
uniform float u_softness;

vec4 transition(vec2 uv) {
  float a = radians(u_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float d = dot(uv - 0.5, dir) + 0.5; // 0..1 along the wipe axis
  float t0 = mix(-u_softness, 1.0 + u_softness, u_progress);
  float m = 1.0 - smoothstep(t0 - u_softness, t0 + u_softness, d);
  return mix(texture(u_from, uv), texture(u_to, uv), m);
}
`,
  },

  CIRCLE_WIPE: {
    label: 'Circle Wipe',
    description: 'Iris circle grows from (or shrinks to) the center.',
    glsl: `
// @param name="Softness" min=0.0 max=0.5 default=0.08 step=0.01
uniform float u_softness;
// @param name="Shrink" type=bool default=false
uniform bool u_shrink;

vec4 transition(vec2 uv) {
  vec2 asp = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  float d = length((uv - 0.5) * asp);
  float maxR = length(vec2(0.5) * asp);
  float p = u_shrink ? 1.0 - u_progress : u_progress;
  float r = mix(-u_softness, maxR + u_softness, p);
  float m = 1.0 - smoothstep(r - u_softness, r + u_softness, d);
  if (u_shrink) m = 1.0 - m;
  return mix(texture(u_from, uv), texture(u_to, uv), m);
}
`,
  },

  ZOOM_PUNCH: {
    label: 'Zoom Punch',
    description: 'Outgoing zooms through the incoming with chromatic fringing.',
    glsl: `
// @param name="Intensity" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_intensity;
// @param name="Chroma" min=0.0 max=1.0 default=0.35 step=0.01
uniform float u_chroma;

vec4 t_sampleZoom(sampler2D tex, vec2 uv, float amt, float chroma) {
  vec2 c = uv - 0.5;
  float r = texture(tex, 0.5 + c / (1.0 + amt * (1.0 + chroma))).r;
  vec4 g = texture(tex, 0.5 + c / (1.0 + amt));
  float b = texture(tex, 0.5 + c / (1.0 + amt * (1.0 - chroma))).b;
  return vec4(r, g.g, b, g.a);
}

vec4 transition(vec2 uv) {
  float p = smoothstep(0.0, 1.0, u_progress);
  float ch = u_chroma * t_env(p) * 0.5;
  vec4 fromC = t_sampleZoom(u_from, uv, p * u_intensity * 2.0, ch);
  vec4 toC = t_sampleZoom(u_to, uv, (1.0 - p) * u_intensity * 2.0, ch);
  return mix(fromC, toC, p);
}
`,
  },

  GLITCH_BLOCKS: {
    label: 'Glitch Blocks',
    description: 'Blocky datamosh stutter — beat-reactive by default.',
    glsl: `
// @param name="Blocks" min=4.0 max=64.0 default=16.0 step=1.0
uniform float u_blocks;
// @param name="Intensity" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_glitch_intensity;
// @param name="Beat React" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_beat_react;

vec4 transition(vec2 uv) {
  float env = t_env(u_progress);
  float amt = env * u_glitch_intensity * (1.0 + u_beat * u_beat_react * 2.0);
  // Blocky horizontal displacement, re-seeded a few times a second.
  float seed = floor(u_time * 8.0);
  vec2 block = floor(uv * vec2(u_blocks * 0.5, u_blocks));
  float rnd = t_hash(block + seed);
  float shift = (rnd - 0.5) * 0.4 * amt * step(0.6, fract(rnd * 7.31 + seed * 0.13));
  vec2 guv = vec2(fract(uv.x + shift), uv.y);
  // Per-block hand-off biased by progress: incoming blocks stutter in early,
  // outgoing blocks linger late. At p=0/1 this is exactly from/to (amt=0 too).
  float pick = step(t_hash(block + seed * 1.7 + 3.1), u_progress + (rnd - 0.5) * amt);
  float sp = 0.01 * amt;
  vec4 c = mix(texture(u_from, guv), texture(u_to, guv), pick);
  c.r = mix(texture(u_from, guv + vec2(sp, 0.0)), texture(u_to, guv + vec2(sp, 0.0)), pick).r;
  c.b = mix(texture(u_from, guv - vec2(sp, 0.0)), texture(u_to, guv - vec2(sp, 0.0)), pick).b;
  return c;
}
`,
  },

  WARP_DISSOLVE: {
    label: 'Warp Dissolve',
    description: 'Luma-driven dissolve with a turbulent melting edge.',
    glsl: `
// @param name="Warp" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_warp;
// @param name="Softness" min=0.05 max=1.0 default=0.3 step=0.01
uniform float u_softness;

vec4 transition(vec2 uv) {
  // Outgoing frame's luma is the dissolve map: dark areas hand off first.
  float l = t_luma(texture(u_from, uv).rgb);
  float t0 = u_progress * (1.0 + u_softness);
  float m = 1.0 - smoothstep(t0 - u_softness, t0, l);
  // Smooth sinusoidal warp that peaks at the dissolve boundary (m ≈ 0.5) and
  // vanishes where either side fully owns the pixel — melts, never pops.
  float edge = m * (1.0 - m) * 4.0;
  vec2 w = vec2(sin(uv.y * 40.0 + u_time * 2.0), cos(uv.x * 36.0 - u_time * 1.7))
           * 0.03 * u_warp * edge;
  return mix(texture(u_from, uv + w), texture(u_to, uv - w), m);
}
`,
  },

  RGB_PUSH: {
    label: 'RGB Split Push',
    description: 'Incoming pushes the outgoing off-screen with channel lag.',
    glsl: `
// @param name="Direction" type=select options="Left,Right,Up,Down" default=1
uniform int u_direction;
// @param name="Split" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_split;

vec2 t_dir() {
  if (u_direction == 0) return vec2(-1.0, 0.0);
  if (u_direction == 1) return vec2(1.0, 0.0);
  if (u_direction == 2) return vec2(0.0, 1.0);
  return vec2(0.0, -1.0);
}

vec4 transition(vec2 uv) {
  vec2 d = t_dir();
  float p = smoothstep(0.0, 1.0, u_progress);
  vec2 uvF = uv - d * p;         // outgoing slides out along d
  vec2 uvT = uv - d * (p - 1.0); // incoming trails in behind it
  float env = t_env(p);
  vec2 sp = d * 0.03 * u_split * env;
  vec4 F = vec4(0.0); vec4 T = vec4(0.0);
  F.ga = texture(u_from, uvF).ga;
  F.r = texture(u_from, uvF + sp).r;
  F.b = texture(u_from, uvF - sp).b;
  T.ga = texture(u_to, uvT).ga;
  T.r = texture(u_to, uvT + sp).r;
  T.b = texture(u_to, uvT - sp).b;
  // The seam sits at p along the push axis; incoming owns the trailing side.
  float along = dot(uv - 0.5, d) + 0.5;
  float m = step(along, p);
  return mix(F, T, m);
}
`,
  },

  MOSAIC_DISSOLVE: {
    label: 'Mosaic Dissolve',
    description: 'Both sides pixelate down, swap cell-by-cell, and resolve.',
    glsl: `
// @param name="Max Blocks" min=8.0 max=200.0 default=40.0 step=1.0
uniform float u_max_blocks;

vec4 transition(vec2 uv) {
  float p = u_progress;
  float env = t_env(p);
  // Cell count sweeps from full-res down to Max Blocks at the midpoint.
  float blocks = mix(u_resolution.y, max(u_max_blocks, 4.0), env);
  vec2 grid = vec2(blocks * u_resolution.x / max(u_resolution.y, 1.0), blocks);
  vec2 puv = (floor(uv * grid) + 0.5) / grid;
  // Per-cell stochastic hand-off.
  float m = step(t_hash(floor(uv * grid)), p);
  return mix(texture(u_from, puv), texture(u_to, puv), m);
}
`,
  },
}

export const TRANSITION_TYPES = Object.keys(TRANSITIONS)

export function getTransitionLabel(type) {
  return TRANSITIONS[type]?.label || type
}

/** Assemble the full compilable fragment shader for a transition type. */
export function buildTransitionShader(type) {
  const t = TRANSITIONS[type]
  return t ? TRANSITION_HEADER + t.glsl + TRANSITION_FOOTER : null
}

// Param configs / defaults are static per type — parse once, cache.
const paramCache = {}

/** Parsed @param configs for a transition type (Inspector sliders). */
export function getTransitionParams(type) {
  if (!TRANSITIONS[type]) return []
  if (!paramCache[type]) paramCache[type] = parseParams(TRANSITIONS[type].glsl)
  return paramCache[type]
}

/** Default param values for a transition type. */
export function getTransitionDefaults(type) {
  return getDefaultParams(getTransitionParams(type))
}
