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

// ── Shared helpers ──
// These live in the header rather than in each entry because a dozen
// transitions want the same noise, and a per-entry copy is both duplication and
// a guarantee that two "identical" effects drift apart. Unused helpers are dead
// code the GLSL compiler drops, so a transition that needs none pays nothing.

// Aspect correction: multiply a centred uv by this to get square units, so a
// circle is round and a 45-degree wipe is really 45 degrees on a wide frame.
vec2 t_aspect() { return vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0); }

mat2 t_rot(float a) { float s = sin(a); float c = cos(a); return mat2(c, -s, s, c); }

// Value noise + fbm. Smoothstep interpolation keeps the derivative continuous,
// which matters because most of these use the noise as a THRESHOLD — a linear
// interpolant leaves visible grid creases along the dissolve front.
float t_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = t_hash(i);
  float b = t_hash(i + vec2(1.0, 0.0));
  float c = t_hash(i + vec2(0.0, 1.0));
  float d = t_hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float t_fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    v += amp * t_noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return v;
}

// A threshold front swept by progress across a 0..1 map, with a soft edge.
// Returns 1 where the map has NOT been reached yet, 0 where it has. The
// (1 + 2*soft) span is what guarantees a full hand-off: without it the softest
// pixels never finish, and a dissolve that ends at 97 percent reads as a
// broken cut rather than as a slow one.
float t_front(float map, float p, float soft) {
  float s = max(soft, 0.0005);
  float f = mix(-s, 1.0 + s, p);
  return smoothstep(f - s, f + s, map);
}

// Unit direction for the 8-way Direction selects. The index order is shared by
// every transition that has one, so switching effects keeps the same motion.
vec2 t_dir8(int i) {
  if (i == 0) return vec2(-1.0, 0.0);
  if (i == 1) return vec2(1.0, 0.0);
  if (i == 2) return vec2(0.0, 1.0);
  if (i == 3) return vec2(0.0, -1.0);
  if (i == 4) return normalize(vec2(-1.0, 1.0));
  if (i == 5) return normalize(vec2(1.0, 1.0));
  if (i == 6) return normalize(vec2(-1.0, -1.0));
  return normalize(vec2(1.0, -1.0));
}

// Sample with transparent edges: outside 0..1 there is no picture, and the
// pipeline's CLAMP_TO_EDGE wrap would smear the border pixel into a streak
// across anything that slides, rolls or zooms out of frame.
vec4 t_clip(sampler2D tex, vec2 uv) {
  vec2 g = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * g.x * g.y;
}

// 13-tap golden-angle disc blur — CONSTANT cost at any radius, which is the
// house rule for anything with a radius (a nested x/y loop is O(r^2) and was a
// real perf bug in DEPTH_BLUR). Aspect-corrected so the disc stays round.
vec4 t_disc(sampler2D tex, vec2 uv, float radius) {
  if (radius <= 0.0005) return texture(tex, uv);
  vec2 asp = vec2(max(u_resolution.y, 1.0) / max(u_resolution.x, 1.0), 1.0);
  vec4 acc = texture(tex, uv);
  for (int i = 0; i < 12; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.399963; // golden angle
    float r = sqrt(fi / 12.0) * radius;
    acc += texture(tex, uv + vec2(cos(a), sin(a)) * r * asp);
  }
  return acc / 13.0;
}

// Directional blur along dir, 9 taps, same constant-cost rule.
vec4 t_streak(sampler2D tex, vec2 uv, vec2 dir, float len) {
  if (len <= 0.0005) return t_clip(tex, uv);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 9; i++) {
    float o = (float(i) / 8.0 - 0.5) * len;
    acc += t_clip(tex, uv + dir * o);
  }
  return acc / 9.0;
}
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

// Every entry carries a `category`, which is the only thing keeping a library
// this size browsable — the Media Pool groups its cards by it and the Inspector
// groups its dropdown by it, both from this one field.
export const TRANSITION_CATEGORIES = [
  'Dissolve', 'Wipe', 'Motion', 'Geometric', 'Film', 'Digital', 'Organic', 'Light',
]

export const TRANSITIONS = {
  CROSSFADE: {
    label: 'Crossfade',
    category: 'Dissolve',
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
    category: 'Dissolve',
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
    category: 'Dissolve',
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
    category: 'Wipe',
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
    category: 'Wipe',
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
    category: 'Motion',
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
    category: 'Digital',
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
    category: 'Organic',
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
    category: 'Motion',
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

  // ───────────────────────────── Film & Analog ─────────────────────────────

  FILM_BURN: {
    label: 'Film Burn',
    category: 'Film',
    description: 'The frame burns through from an edge — a hot rim eats the picture and the incoming clip is behind it.',
    glsl: `
// @param name="Style" type=select options="Emulsion,Paper,Bleach" default=0
uniform int u_burn_style;
// @param name="Burn Color" type=color default="#ff6a1a"
uniform vec3 u_burn_color;
// @param name="Edge Width" min=0.01 max=0.4 default=0.1 step=0.005
uniform float u_burn_edge;
// @param name="Turbulence" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_burn_turb;
// @param name="Scale" min=1.0 max=20.0 default=6.0 step=0.5
uniform float u_burn_scale;
// @param name="Glow" min=0.0 max=3.0 default=1.4 step=0.05
uniform float u_burn_glow;
// @param name="Char" min=0.0 max=1.0 default=0.55 step=0.01
uniform float u_burn_char;
// @param name="Origin" min=0.0 max=360.0 default=215.0 step=1.0
uniform float u_burn_origin;

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  // The burn map is fbm biased along a direction. The bias is what makes it
  // read as burning FROM somewhere: pure noise ignites everywhere at once,
  // which looks like a dissolve with a fancy edge rather than like fire.
  float a = radians(u_burn_origin);
  float bias = dot(uv - 0.5, vec2(cos(a), sin(a))) + 0.5;
  float n = t_fbm(uv * asp * u_burn_scale + vec2(0.0, u_time * 0.06));
  float map = mix(bias, n, clamp(u_burn_turb, 0.0, 1.0));

  float e = u_burn_edge;
  float intact = t_front(map, u_progress, e); // 1 = untouched, 0 = burnt away
  // Rim strength peaks exactly on the front and vanishes on both sides, so the
  // glow can never survive to p=0 or p=1 and leave a stain on a finished frame.
  float rim = 1.0 - abs(intact * 2.0 - 1.0);
  rim = pow(clamp(rim, 0.0, 1.0), 1.6);

  vec4 fromC = texture(u_from, uv);
  vec4 toC = texture(u_to, uv);
  vec4 c = mix(toC, fromC, intact);

  if (u_burn_style == 2) {
    // Bleach: chemical blows out to white instead of charring.
    c.rgb = mix(c.rgb, vec3(1.0), rim * u_burn_glow * 0.8);
  } else {
    // Charring sits just INSIDE the intact side — the picture darkens and curls
    // before it goes, which is the whole tell of real burning film.
    // (Named charAmt, not char: char is a RESERVED word in GLSL ES and the
    // shader will not compile with it, whatever the surrounding code does.)
    float charAmt = smoothstep(0.0, 0.45, rim) * intact * u_burn_char;
    c.rgb *= 1.0 - charAmt * (u_burn_style == 1 ? 0.95 : 0.8);
    vec3 hot = mix(u_burn_color, vec3(1.0), pow(rim, 3.0));
    c.rgb += hot * rim * u_burn_glow;
  }
  // Alpha follows the glow so the burn line is visible even where both sides
  // are transparent (a title burning out over nothing).
  c.a = max(c.a, rim * min(u_burn_glow, 1.0));
  return c;
}
`,
  },

  FILM_ROLL: {
    label: 'Film Roll',
    category: 'Film',
    description: 'The projector loses sync — frames roll past the gate with the frame bar sweeping through, and the incoming clip lands on the last one.',
    glsl: `
// @param name="Direction" type=select options="Up,Down" default=0
uniform int u_roll_dir;
// @param name="Frames" min=1.0 max=8.0 default=3.0 step=1.0
uniform float u_roll_frames;
// @param name="Frame Bar" min=0.0 max=0.25 default=0.07 step=0.005
uniform float u_roll_bar;
// @param name="Bar Color" type=color default="#08070a"
uniform vec3 u_roll_barcolor;
// @param name="Gate Weave" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_roll_weave;
// @param name="Motion Blur" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_roll_blur;
// @param name="Flicker" min=0.0 max=1.0 default=0.35 step=0.01
uniform float u_roll_flicker;

// One tap into the rolling strip: the frame content at strip position yy, or
// the frame bar between sprockets. N cells of FROM, then TO forever after, so
// the strip always ARRIVES at the incoming clip.
//
// The strip only ever travels one way in this space. Direction is handled by
// mirroring y on the way in and again on the way out — running travel negative
// instead would push cell below zero, where the FROM branch is taken forever
// and the transition simply never completes.
vec4 fr_tap(float x, float yy, float unit, float frames) {
  float cell = floor(yy / unit);
  float local = yy - cell * unit;
  if (local > 1.0) return vec4(u_roll_barcolor, 1.0);
  vec2 suv = vec2(x, u_roll_dir == 0 ? local : 1.0 - local);
  return cell >= frames - 0.5 ? texture(u_to, suv) : texture(u_from, suv);
}

vec4 transition(vec2 uv) {
  float unit = 1.0 + u_roll_bar;
  float frames = max(1.0, floor(u_roll_frames + 0.5));

  // Ease out so the strip decelerates into the gate — a linear stop looks like
  // the film was switched off rather than caught.
  float p = 1.0 - pow(1.0 - u_progress, 2.2);
  float travel = p * frames * unit;

  // Gate weave: the whole strip wanders a little, as an unsteady gate does.
  // Both axes, but mostly horizontal, and gated by t_env so it dies at the ends.
  float wob = t_env(u_progress) * u_roll_weave;
  vec2 wv = vec2(t_noise(vec2(u_time * 3.1, 0.0)) - 0.5,
                 t_noise(vec2(0.0, u_time * 2.3)) - 0.5) * vec2(0.02, 0.008) * wob;

  float yIn = u_roll_dir == 0 ? uv.y : 1.0 - uv.y;
  float yy = yIn + travel + wv.y;
  float sx = uv.x + wv.x;

  // Vertical motion blur along the direction of travel. Speed is the derivative
  // of the ease, so the smear is heaviest at the start and gone at the end —
  // constant 5 taps either way (house rule: no radius-dependent loops).
  float speed = 2.2 * pow(max(1.0 - u_progress, 0.0), 1.2) * frames * unit;
  float spread = clamp(speed * 0.06 * u_roll_blur, 0.0, 0.25);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    float o = (float(i) - 2.0) * 0.25 * spread;
    acc += fr_tap(sx, yy + o, unit, frames);
  }
  vec4 c = acc * 0.2;

  // Lamp flicker while the strip is moving.
  float fl = 1.0 + (t_noise(vec2(u_time * 26.0, 3.7)) - 0.5) * 0.5 * u_roll_flicker * t_env(u_progress);
  c.rgb *= fl;
  return c;
}
`,
  },

  LIGHT_LEAK: {
    label: 'Light Leak',
    category: 'Film',
    description: 'A warm leak sweeps across the gate, blows the frame out, and the incoming clip is there when it passes.',
    glsl: `
// @param name="Leak Color" type=color default="#ffb347"
uniform vec3 u_leak_color;
// @param name="Second Color" type=color default="#ff2d55"
uniform vec3 u_leak_color2;
// @param name="Angle" min=0.0 max=360.0 default=25.0 step=1.0
uniform float u_leak_angle;
// @param name="Width" min=0.05 max=1.0 default=0.45 step=0.01
uniform float u_leak_width;
// @param name="Intensity" min=0.0 max=3.0 default=1.6 step=0.05
uniform float u_leak_intensity;
// @param name="Bloom" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_leak_bloom;
// @param name="Streaks" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_leak_streaks;

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  float a = radians(u_leak_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float along = dot((uv - 0.5) * asp, dir);
  float span = length(asp) * 0.5;

  // The leak's centre travels past both edges so it fully clears the frame.
  float centre = mix(-span - u_leak_width, span + u_leak_width, u_progress);
  float d = abs(along - centre) / max(u_leak_width, 0.01);
  float band = exp(-d * d * 2.2);

  // Uneven streaks along the band, so it reads as a light leak and not a
  // gradient — real leaks are banded by the felt they crept past.
  float across = dot((uv - 0.5) * asp, vec2(-dir.y, dir.x));
  float streak = mix(1.0, 0.55 + 0.9 * t_fbm(vec2(across * 6.0, u_time * 0.4)), u_leak_streaks);
  float leak = band * streak * u_leak_intensity;

  // Hand off under the brightest part of the leak, so the cut is hidden by it.
  float m = smoothstep(0.35, 0.65, u_progress);
  vec4 c = mix(texture(u_from, uv), texture(u_to, uv), m);

  // Bloom: the leak lifts nearby highlights as well as adding its own colour.
  vec3 tint = mix(u_leak_color, u_leak_color2, smoothstep(0.2, 0.8, along / span * 0.5 + 0.5));
  c.rgb += tint * leak;
  c.rgb = mix(c.rgb, c.rgb + c.rgb * leak, u_leak_bloom);
  c.a = max(c.a, clamp(leak, 0.0, 1.0));
  return c;
}
`,
  },

  PROJECTOR_REEL: {
    label: 'Reel Change',
    category: 'Film',
    description: 'Cigarette-burn cue mark, flicker, dust and scratches — the cut hides inside a projection fault.',
    glsl: `
// @param name="Cue Mark" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_reel_cue;
// @param name="Flicker" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_reel_flicker;
// @param name="Gate Weave" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_reel_weave;
// @param name="Dust" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_reel_dust;
// @param name="Scratches" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_reel_scratch;
// @param name="Warmth" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_reel_warm;

vec4 transition(vec2 uv) {
  float env = t_env(u_progress);
  // Weave: the gate loses the frame slightly. Sub-pixel is not enough to read,
  // half a percent is.
  vec2 wv = vec2(t_noise(vec2(u_time * 5.0, 1.0)) - 0.5,
                 t_noise(vec2(2.0, u_time * 4.0)) - 0.5) * 0.012 * u_reel_weave * env;
  vec2 suv = uv + wv;

  // The cut itself is a hard-ish switch at the midpoint — a reel change is a
  // splice, not a dissolve — softened just enough not to alias.
  float m = smoothstep(0.47, 0.53, u_progress);
  vec4 c = mix(texture(u_from, suv), texture(u_to, suv), m);

  // Cue mark: the circle burnt into the top-right corner a few frames before a
  // changeover. Two flashes, the classic pattern.
  float cueT = smoothstep(0.18, 0.22, u_progress) * (1.0 - smoothstep(0.28, 0.32, u_progress))
             + smoothstep(0.40, 0.44, u_progress) * (1.0 - smoothstep(0.50, 0.54, u_progress));
  vec2 cueP = (uv - vec2(0.86, 0.84)) * t_aspect();
  float cue = (1.0 - smoothstep(0.02, 0.045, length(cueP))) * cueT * u_reel_cue;
  c.rgb += vec3(1.0, 0.93, 0.78) * cue * 1.4;

  // Lamp flicker + a warm gate glow toward the centre.
  float fl = 1.0 + (t_noise(vec2(u_time * 31.0, 7.0)) - 0.5) * 0.7 * u_reel_flicker * env;
  c.rgb *= fl;
  c.rgb = mix(c.rgb, c.rgb * vec3(1.08, 1.0, 0.9), u_reel_warm * env);

  // Dust: sparse bright specks, re-seeded per frame so they never sit still.
  float seed = floor(u_time * 24.0);
  float dn = t_hash(floor(uv * 220.0) + seed * 13.0);
  float dust = step(0.9975 - 0.004 * u_reel_dust, dn) * u_reel_dust * env;
  c.rgb += vec3(dust);

  // Scratches: a couple of vertical hairlines that wander slowly.
  float sx = t_hash(vec2(seed * 0.37, 4.0));
  float line = 1.0 - smoothstep(0.0, 0.0016, abs(uv.x - sx));
  c.rgb += vec3(0.85, 0.85, 0.8) * line * u_reel_scratch * 0.6 * env;

  c.a = max(c.a, (cue + dust) * 0.9);
  return c;
}
`,
  },

  VHS_TRACKING: {
    label: 'VHS Tracking',
    category: 'Film',
    description: 'Tape tracking collapses — noise bands, chroma bleed and head-switch tearing carry the cut.',
    glsl: `
// @param name="Bands" min=1.0 max=12.0 default=4.0 step=1.0
uniform float u_vhs_bands;
// @param name="Tear" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_vhs_tear;
// @param name="Chroma Bleed" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_vhs_chroma;
// @param name="Noise" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_vhs_noise;
// @param name="Roll Speed" min=0.0 max=4.0 default=1.2 step=0.05
uniform float u_vhs_roll;
// @param name="Desaturate" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_vhs_desat;

vec4 transition(vec2 uv) {
  float env = t_env(u_progress);
  float amt = env * (0.35 + 0.65 * u_vhs_tear);

  // Tracking bands drift upward; inside one, the line is torn sideways.
  float bandPos = fract(uv.y * u_vhs_bands - u_time * u_vhs_roll);
  float inBand = smoothstep(0.0, 0.12, bandPos) * (1.0 - smoothstep(0.28, 0.55, bandPos));
  float lineNoise = t_hash(vec2(floor(uv.y * u_resolution.y), floor(u_time * 30.0))) - 0.5;
  float tear = lineNoise * 0.22 * inBand * amt;

  vec2 suv = vec2(fract(uv.x + tear), uv.y);

  // Per-pixel hand-off is biased by the band, so the switch happens inside the
  // damage rather than beside it — that is what makes the cut feel caused.
  float bias = (inBand - 0.5) * 0.35 * amt;
  float m = smoothstep(0.42, 0.58, u_progress + bias);

  // Chroma bleeds to the right the way composite video does — luma stays put,
  // colour lags. Sampling both sides at each offset keeps the mix consistent.
  float cb = 0.012 * u_vhs_chroma * (0.4 + amt);
  vec4 c = mix(texture(u_from, suv), texture(u_to, suv), m);
  vec4 cr = mix(texture(u_from, suv + vec2(cb, 0.0)), texture(u_to, suv + vec2(cb, 0.0)), m);
  vec4 cbv = mix(texture(u_from, suv - vec2(cb * 0.6, 0.0)), texture(u_to, suv - vec2(cb * 0.6, 0.0)), m);
  c = vec4(cr.r, c.g, cbv.b, max(c.a, max(cr.a, cbv.a)));

  // Head-switch noise: the torn strip along the very bottom of a VHS frame.
  float hs = 1.0 - smoothstep(0.0, 0.045, uv.y);
  float snow = t_hash(uv * u_resolution.xy * 0.5 + floor(u_time * 30.0));
  c.rgb = mix(c.rgb, vec3(snow), hs * amt * 0.85);

  // General tape noise, strongest inside the bands.
  c.rgb += (snow - 0.5) * 0.35 * u_vhs_noise * amt * (0.35 + inBand);
  c.rgb = mix(c.rgb, vec3(t_luma(c.rgb)), u_vhs_desat * env);
  return c;
}
`,
  },

  MOSAIC_DISSOLVE: {
    label: 'Mosaic Dissolve',
    category: 'Digital',
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

  // ─────────────────────────────── Motion ──────────────────────────────────

  WHIP_PAN: {
    label: 'Whip Pan',
    category: 'Motion',
    description: 'A hard camera whip — both sides smear along the swing and the cut hides inside the blur.',
    glsl: `
// @param name="Direction" type=select options="Left,Right,Up,Down,Up-Left,Up-Right,Down-Left,Down-Right" default=1
uniform int u_whip_dir;
// @param name="Blur" min=0.0 max=1.5 default=0.7 step=0.01
uniform float u_whip_blur;
// @param name="Travel" min=0.1 max=2.0 default=0.8 step=0.05
uniform float u_whip_travel;
// @param name="Flash" min=0.0 max=1.0 default=0.15 step=0.01
uniform float u_whip_flash;

vec4 transition(vec2 uv) {
  vec2 d = t_dir8(u_whip_dir);
  float p = smoothstep(0.0, 1.0, u_progress);
  float env = t_env(u_progress);
  // Blur tracks SPEED, not position, so it peaks mid-swing and is exactly zero
  // on the first and last frame — the hand-off into normal compositing is
  // seamless rather than arriving with a smear still on it.
  float len = u_whip_blur * env * 0.5;

  // To move a picture by s, sample at uv - s. FROM leaves along d; TO is behind
  // it and catches up, so its displacement runs from -d*travel to zero.
  vec4 F = t_streak(u_from, uv - d * p * u_whip_travel, d, len);
  vec4 T = t_streak(u_to, uv + d * (1.0 - p) * u_whip_travel, d, len);

  // Crossfade under peak blur. A real whip pan IS a blur plus a dissolve — the
  // eye cannot resolve the cut, so there is nothing to hide with geometry.
  vec4 c = mix(F, T, smoothstep(0.3, 0.7, p));
  c.rgb += vec3(env * u_whip_flash);
  return c;
}
`,
  },

  SLIDE: {
    label: 'Slide',
    category: 'Motion',
    description: 'Clean directional slide — cover, reveal or push, with a soft drop shadow at the seam.',
    glsl: `
// @param name="Direction" type=select options="Left,Right,Up,Down,Up-Left,Up-Right,Down-Left,Down-Right" default=1
uniform int u_slide_dir;
// @param name="Mode" type=select options="Cover,Reveal,Push" default=0
uniform int u_slide_mode;
// @param name="Ease" min=0.0 max=1.0 default=0.8 step=0.01
uniform float u_slide_ease;
// @param name="Shadow" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_slide_shadow;
// @param name="Shadow Size" min=0.005 max=0.2 default=0.04 step=0.005
uniform float u_slide_shadow_size;

vec4 transition(vec2 uv) {
  vec2 d = t_dir8(u_slide_dir);
  float p = mix(u_progress, smoothstep(0.0, 1.0, u_progress), u_slide_ease);

  // Cover: only TO moves. Reveal: only FROM moves. Push: both, locked together.
  float fromMove = u_slide_mode == 0 ? 0.0 : 1.0;
  float toMove = u_slide_mode == 1 ? 0.0 : 1.0;
  vec2 fOff = d * p * fromMove;
  vec2 tOff = d * (p - 1.0) * toMove;

  vec4 F = t_clip(u_from, uv - fOff);
  vec4 T = t_clip(u_to, uv - tOff);

  // Reveal puts FROM on top (it slides away to expose TO); Cover and Push put
  // TO on top. Everything below is written in terms of top/bottom so the three
  // modes share one composite.
  bool fromOnTop = u_slide_mode == 1;
  vec4 top = fromOnTop ? F : T;
  vec4 bot = fromOnTop ? T : F;
  vec2 topOff = fromOnTop ? fOff : tOff;

  // Drop shadow: how far OUTSIDE the top layer this pixel is, in its own uv
  // space. Derived from the layer's own coverage rather than from an assumed
  // seam position, so it stays correct for all eight directions and all three
  // modes without a special case per combination.
  vec2 q = uv - topOff;
  float outside = max(max(-q.x, q.x - 1.0), max(-q.y, q.y - 1.0));
  float shade = step(0.0, outside) * (1.0 - smoothstep(0.0, u_slide_shadow_size, outside));
  bot.rgb *= 1.0 - shade * u_slide_shadow;

  return vec4(mix(bot.rgb, top.rgb, top.a), max(bot.a, top.a));
}
`,
  },

  SPIN: {
    label: 'Spin',
    category: 'Motion',
    description: 'The frame spins and scales through the cut, with optional motion blur on the swing.',
    glsl: `
// @param name="Turns" min=0.1 max=4.0 default=1.0 step=0.05
uniform float u_spin_turns;
// @param name="Direction" type=select options="Clockwise,Counter-Clockwise" default=0
uniform int u_spin_ccw;
// @param name="Zoom" min=0.0 max=2.0 default=0.8 step=0.05
uniform float u_spin_zoom;
// @param name="Blur" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_spin_blur;

vec2 sp_warp(vec2 uv, float ang, float scale) {
  vec2 asp = t_aspect();
  vec2 c = (uv - 0.5) * asp;
  c = t_rot(ang) * c / max(scale, 0.001);
  return c / asp + 0.5;
}

vec4 transition(vec2 uv) {
  float p = smoothstep(0.0, 1.0, u_progress);
  float env = t_env(u_progress);
  float sgn = u_spin_ccw == 0 ? -1.0 : 1.0;
  float turns = u_spin_turns * 6.2831853 * sgn;

  // FROM spins away and shrinks; TO arrives from the opposite spin. Both land on
  // identity at their own end, so the first and last frames are untouched.
  float scaleF = 1.0 - p * u_spin_zoom * 0.5;
  float scaleT = 1.0 - (1.0 - p) * u_spin_zoom * 0.5;

  // Rotational blur: a few taps spread along the arc, weighted by swing speed.
  float arc = env * u_spin_blur * 0.25 * u_spin_turns;
  vec4 F = vec4(0.0);
  vec4 T = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    float o = (float(i) / 4.0 - 0.5) * arc;
    F += t_clip(u_from, sp_warp(uv, turns * p + o, scaleF));
    T += t_clip(u_to, sp_warp(uv, turns * (p - 1.0) + o, scaleT));
  }
  return mix(F, T, smoothstep(0.25, 0.75, p)) * 0.2;
}
`,
  },

  SWIRL: {
    label: 'Swirl',
    category: 'Motion',
    description: 'A vortex twists the outgoing frame apart and untwists the incoming one into place.',
    glsl: `
// @param name="Strength" min=0.0 max=12.0 default=5.0 step=0.1
uniform float u_swirl_strength;
// @param name="Radius" min=0.1 max=1.5 default=0.75 step=0.01
uniform float u_swirl_radius;
// @param name="Center X" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_swirl_cx;
// @param name="Center Y" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_swirl_cy;

vec2 sw_twist(vec2 uv, float amt) {
  vec2 asp = t_aspect();
  vec2 c = (uv - vec2(u_swirl_cx, u_swirl_cy)) * asp;
  float r = length(c);
  // Falloff to zero at the radius, so the twist never touches the frame corners
  // and cannot tear the picture off its own edges.
  float f = 1.0 - smoothstep(0.0, max(u_swirl_radius, 0.01), r);
  c = t_rot(amt * f * f) * c;
  return c / asp + vec2(u_swirl_cx, u_swirl_cy);
}

vec4 transition(vec2 uv) {
  float p = smoothstep(0.0, 1.0, u_progress);
  float s = u_swirl_strength;
  vec4 F = texture(u_from, sw_twist(uv, p * s));
  vec4 T = texture(u_to, sw_twist(uv, (p - 1.0) * s));
  return mix(F, T, smoothstep(0.3, 0.7, p));
}
`,
  },

  // ────────────────────────────── Geometric ────────────────────────────────

  CLOCK_WIPE: {
    label: 'Clock Wipe',
    category: 'Geometric',
    description: 'A radial hand sweeps around the frame, revealing the incoming clip behind it.',
    glsl: `
// @param name="Start Angle" min=0.0 max=360.0 default=90.0 step=1.0
uniform float u_clock_start;
// @param name="Direction" type=select options="Clockwise,Counter-Clockwise" default=0
uniform int u_clock_ccw;
// @param name="Blades" min=1.0 max=8.0 default=1.0 step=1.0
uniform float u_clock_blades;
// @param name="Softness" min=0.0 max=0.3 default=0.01 step=0.005
uniform float u_clock_soft;

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  vec2 c = (uv - 0.5) * asp;
  float a = atan(c.y, c.x) - radians(u_clock_start);
  if (u_clock_ccw == 1) a = -a;
  // Fold the circle into N identical blades, then sweep one blade's worth.
  float blades = max(1.0, floor(u_clock_blades + 0.5));
  float t = fract(a / 6.2831853) * blades;
  float sweep = fract(t);
  float m = 1.0 - smoothstep(u_progress - u_clock_soft, u_progress + u_clock_soft, sweep);
  return mix(texture(u_from, uv), texture(u_to, uv), m);
}
`,
  },

  BARN_DOORS: {
    label: 'Barn Doors',
    category: 'Geometric',
    description: 'Doors open from the centre out, or close from the edges in.',
    glsl: `
// @param name="Axis" type=select options="Horizontal,Vertical" default=0
uniform int u_barn_axis;
// @param name="Mode" type=select options="Open,Close" default=0
uniform int u_barn_close;
// @param name="Softness" min=0.0 max=0.3 default=0.02 step=0.005
uniform float u_barn_soft;

vec4 transition(vec2 uv) {
  float axis = u_barn_axis == 0 ? uv.x : uv.y;
  float d = abs(axis - 0.5) * 2.0; // 0 at centre, 1 at the edges
  // Open: the gap grows from the centre. Close: it grows from both edges.
  float map = u_barn_close == 1 ? 1.0 - d : d;
  float m = 1.0 - t_front(map, u_progress, u_barn_soft);
  return mix(texture(u_from, uv), texture(u_to, uv), m);
}
`,
  },

  BLINDS: {
    label: 'Blinds',
    category: 'Geometric',
    description: 'Venetian slats tilt open across the frame at any angle.',
    glsl: `
// @param name="Slats" min=2.0 max=64.0 default=12.0 step=1.0
uniform float u_blind_count;
// @param name="Angle" min=0.0 max=360.0 default=0.0 step=1.0
uniform float u_blind_angle;
// @param name="Softness" min=0.0 max=0.5 default=0.06 step=0.01
uniform float u_blind_soft;
// @param name="Stagger" min=0.0 max=1.0 default=0.25 step=0.01
uniform float u_blind_stagger;

vec4 transition(vec2 uv) {
  float a = radians(u_blind_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float along = dot(uv - 0.5, dir) + 0.5;
  float slats = max(2.0, floor(u_blind_count + 0.5));
  float idx = floor(along * slats);
  float local = fract(along * slats);
  // Stagger delays each slat by a hashed amount, so they do not all snap open
  // on the same frame — the difference between blinds and a grid of stripes.
  float delay = t_hash(vec2(idx, 1.0)) * u_blind_stagger;
  float p = clamp((u_progress - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);
  float m = 1.0 - t_front(local, p, u_blind_soft);
  return mix(texture(u_from, uv), texture(u_to, uv), m);
}
`,
  },

  CHECKERBOARD: {
    label: 'Checkerboard',
    category: 'Geometric',
    description: 'Cells flip to the incoming clip in a diagonal wave.',
    glsl: `
// @param name="Columns" min=2.0 max=48.0 default=12.0 step=1.0
uniform float u_check_cols;
// @param name="Rows" min=2.0 max=48.0 default=7.0 step=1.0
uniform float u_check_rows;
// @param name="Order" type=select options="Diagonal,Random,Rows,Columns,Center Out" default=0
uniform int u_check_order;
// @param name="Overlap" min=0.05 max=1.0 default=0.4 step=0.01
uniform float u_check_overlap;
// Capped below 1.0 on purpose: at 1.0 a cell's scale hits zero at its midpoint
// and the sample coords blow up, so the tile vanishes for a frame.
// @param name="Flip Scale" min=0.0 max=0.8 default=0.35 step=0.01
uniform float u_check_flip;

vec4 transition(vec2 uv) {
  vec2 grid = vec2(max(2.0, floor(u_check_cols + 0.5)), max(2.0, floor(u_check_rows + 0.5)));
  vec2 cell = floor(uv * grid);
  vec2 local = fract(uv * grid);
  vec2 n = (cell + 0.5) / grid;

  float order;
  if (u_check_order == 0) order = (n.x + (1.0 - n.y)) * 0.5;
  else if (u_check_order == 1) order = t_hash(cell);
  else if (u_check_order == 2) order = 1.0 - n.y;
  else if (u_check_order == 3) order = n.x;
  else order = length((n - 0.5) * t_aspect()) / (0.5 * length(t_aspect()));

  // Each cell gets its own window inside the transition; Overlap is how much of
  // the total time a single cell takes. At 1.0 every cell moves together, which
  // degenerates to a straight cut — hence the 0.05 floor.
  float w = clamp(u_check_overlap, 0.05, 1.0);
  float p = clamp((u_progress - order * (1.0 - w)) / w, 0.0, 1.0);
  float m = smoothstep(0.0, 1.0, p);

  // Cells shrink toward their own centre as they flip, so the swap reads as a
  // tile turning over rather than a dissolve confined to a square.
  float s = 1.0 - t_env(m) * u_check_flip;
  vec2 suv = (cell + 0.5 + (local - 0.5) / max(s, 0.001)) / grid;
  vec2 g = step(vec2(0.0), suv) * step(suv, vec2(1.0));
  suv = clamp(suv, vec2(0.0), vec2(1.0));
  vec4 c = mix(texture(u_from, suv), texture(u_to, suv), m);
  return c * g.x * g.y;
}
`,
  },

  SHAPE_IRIS: {
    label: 'Shape Iris',
    category: 'Geometric',
    description: 'An iris in any of eight shapes opens or closes over the cut.',
    glsl: `
// @param name="Shape" type=select options="Circle,Diamond,Square,Hexagon,Star,Heart,Cross,Triangle" default=0
uniform int u_iris_shape;
// @param name="Close" type=bool default=false
uniform bool u_iris_close;
// @param name="Rotation" min=0.0 max=360.0 default=0.0 step=1.0
uniform float u_iris_rot;
// @param name="Points" min=3.0 max=12.0 default=5.0 step=1.0
uniform float u_iris_points;
// @param name="Softness" min=0.0 max=0.4 default=0.03 step=0.005
uniform float u_iris_soft;
// @param name="Center X" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_iris_cx;
// @param name="Center Y" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_iris_cy;
// @param name="Edge Glow" min=0.0 max=2.0 default=0.0 step=0.05
uniform float u_iris_glow;
// @param name="Glow Color" type=color default="#00e5ff"
uniform vec3 u_iris_glow_color;

// Normalised shape distance: 0 at the centre, 1 on the unit outline. Every
// shape is expressed this way so one threshold sweep drives all eight.
float ir_dist(vec2 p) {
  float a = atan(p.y, p.x);
  float r = length(p);
  float pts = max(3.0, floor(u_iris_points + 0.5));
  if (u_iris_shape == 0) return r;
  if (u_iris_shape == 1) return abs(p.x) + abs(p.y);
  if (u_iris_shape == 2) return max(abs(p.x), abs(p.y));
  if (u_iris_shape == 3) {
    vec2 q = abs(p);
    return max(q.x * 0.866025 + q.y * 0.5, q.y);
  }
  if (u_iris_shape == 4) {
    // Star: an r-modulating cosine with Points lobes, remapped so the tips sit
    // at 1.0 and the valleys at ~0.45.
    float k = cos(a * pts) * 0.5 + 0.5;
    return r / mix(0.45, 1.0, k);
  }
  if (u_iris_shape == 5) {
    // Heart: the classic implicit form, scaled into the same 0..1 convention.
    vec2 q = vec2(p.x, -p.y * 1.15 + 0.32 * length(p));
    return length(q) * 0.92;
  }
  if (u_iris_shape == 6) {
    vec2 q = abs(p);
    return min(max(q.x, q.y * 3.0), max(q.x * 3.0, q.y));
  }
  // Triangle (pointing up), via three half-plane distances.
  float d = -1e9;
  for (int i = 0; i < 3; i++) {
    float ang = 1.5707963 + float(i) * 2.0943951;
    d = max(d, dot(p, vec2(cos(ang), sin(ang))));
  }
  return d * 1.6;
}

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  vec2 c = (uv - vec2(u_iris_cx, u_iris_cy)) * asp;
  c = t_rot(radians(u_iris_rot)) * c;
  // Normalise by the furthest corner so the iris always clears the whole frame.
  float maxR = length(vec2(max(u_iris_cx, 1.0 - u_iris_cx), max(u_iris_cy, 1.0 - u_iris_cy)) * asp);
  float d = ir_dist(c / max(maxR, 0.001));

  float p = u_iris_close ? 1.0 - u_progress : u_progress;
  float m = 1.0 - t_front(d, p, u_iris_soft);
  if (u_iris_close) m = 1.0 - m;

  vec4 col = mix(texture(u_from, uv), texture(u_to, uv), m);
  if (u_iris_glow > 0.0) {
    float rim = 1.0 - abs(m * 2.0 - 1.0);
    rim = pow(clamp(rim, 0.0, 1.0), 2.0);
    col.rgb += u_iris_glow_color * rim * u_iris_glow;
    col.a = max(col.a, rim * min(u_iris_glow, 1.0));
  }
  return col;
}
`,
  },

  // ─────────────────────────────── Digital ─────────────────────────────────

  SCANLINE_COLLAPSE: {
    label: 'CRT Collapse',
    category: 'Digital',
    description: 'The picture squashes to a bright scanline as the tube dies, then the incoming clip blooms back out of it.',
    glsl: `
// @param name="Line Color" type=color default="#dff6ff"
uniform vec3 u_crt_color;
// @param name="Line Glow" min=0.0 max=4.0 default=2.0 step=0.05
uniform float u_crt_glow;
// @param name="Scanlines" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_crt_lines;
// @param name="Bulge" min=0.0 max=1.0 default=0.35 step=0.01
uniform float u_crt_bulge;
// @param name="Hold" min=0.0 max=0.6 default=0.12 step=0.01
uniform float u_crt_hold;

vec4 transition(vec2 uv) {
  // Two halves with a plateau between: FROM collapses, the line holds, TO opens.
  float h = u_crt_hold * 0.5;
  float outP = smoothstep(0.0, max(0.0001, 0.5 - h), u_progress);
  float inP = smoothstep(min(0.9999, 0.5 + h), 1.0, u_progress);
  bool second = u_progress > 0.5;
  float squash = second ? inP : 1.0 - outP; // 1 = full frame, 0 = a line

  // Barrel bulge as the frame narrows, which is what a real tube does.
  vec2 c = uv - 0.5;
  float bulge = (1.0 - squash) * u_crt_bulge;
  c *= 1.0 + bulge * dot(c, c) * 2.0;
  // Squash vertically about the centre line.
  vec2 suv = vec2(c.x, c.y / max(squash, 0.0008)) + 0.5;

  vec4 col = vec4(0.0);
  vec2 g = step(vec2(0.0), suv) * step(suv, vec2(1.0));
  if (g.x * g.y > 0.0) {
    col = second ? texture(u_to, suv) : texture(u_from, suv);
    // Brightness is conserved as the picture is compressed — that overexposed
    // punch is the whole character of the effect.
    col.rgb *= 1.0 + (1.0 - squash) * 1.5;
    float sl = 1.0 - u_crt_lines * 0.5 * (0.5 + 0.5 * sin(uv.y * u_resolution.y * 3.14159));
    col.rgb *= sl;
  }

  // The residual line itself, brightest while the picture is gone.
  float line = exp(-pow(abs(uv.y - 0.5) * 260.0 * max(squash, 0.02), 2.0));
  float lineAmt = (1.0 - squash) * u_crt_glow;
  col.rgb += u_crt_color * line * lineAmt;
  col.a = max(col.a, clamp(line * lineAmt, 0.0, 1.0));
  return col;
}
`,
  },

  PIXEL_SORT: {
    label: 'Pixel Sort',
    category: 'Digital',
    description: 'Bright pixels smear into vertical streaks, drag across the cut, and snap back.',
    glsl: `
// @param name="Threshold" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_sort_threshold;
// @param name="Length" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_sort_length;
// @param name="Direction" type=select options="Down,Up,Right,Left" default=0
uniform int u_sort_dir;
// @param name="Chroma" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_sort_chroma;

vec4 transition(vec2 uv) {
  float env = t_env(u_progress);
  vec2 d = u_sort_dir == 0 ? vec2(0.0, 1.0)
         : u_sort_dir == 1 ? vec2(0.0, -1.0)
         : u_sort_dir == 2 ? vec2(-1.0, 0.0) : vec2(1.0, 0.0);

  // The seed row/column for this pixel's streak: walk back along d until the
  // luma drops under the threshold. Sampling a fixed 8 steps keeps it constant
  // cost; a real sort would be a compute pass, and this reads the same.
  float m = smoothstep(0.35, 0.65, u_progress);
  vec4 base = mix(texture(u_from, uv), texture(u_to, uv), m);

  float len = u_sort_length * env * 0.35;
  vec4 best = base;
  float bestL = t_luma(base.rgb);
  for (int i = 1; i < 8; i++) {
    vec2 suv = uv + d * (float(i) / 7.0) * len;
    vec4 s = mix(texture(u_from, suv), texture(u_to, suv), m);
    float l = t_luma(s.rgb);
    // Only pixels above the threshold smear — that selectivity is what makes it
    // look sorted rather than motion-blurred.
    if (l > u_sort_threshold && l > bestL) { best = s; bestL = l; }
  }

  vec4 c = mix(base, best, clamp(env * 1.4, 0.0, 1.0));
  if (u_sort_chroma > 0.0) {
    vec2 o = d * 0.006 * u_sort_chroma * env;
    c.r = mix(texture(u_from, uv + o), texture(u_to, uv + o), m).r;
    c.b = mix(texture(u_from, uv - o), texture(u_to, uv - o), m).b;
  }
  return c;
}
`,
  },

  STATIC_NOISE: {
    label: 'Static',
    category: 'Digital',
    description: 'Analog snow washes over the picture and the incoming clip tunes back in.',
    glsl: `
// @param name="Amount" min=0.0 max=1.0 default=0.9 step=0.01
uniform float u_static_amount;
// @param name="Grain" min=0.5 max=4.0 default=1.0 step=0.05
uniform float u_static_grain;
// @param name="Color Noise" min=0.0 max=1.0 default=0.25 step=0.01
uniform float u_static_color;
// @param name="Squeeze" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_static_squeeze;
// @param name="Hum Bars" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_static_hum;

vec4 transition(vec2 uv) {
  float env = t_env(u_progress);
  float amt = env * u_static_amount;

  // Vertical squeeze as signal is lost, like a set losing vertical hold.
  float sq = 1.0 - env * u_static_squeeze * 0.35;
  vec2 suv = vec2(uv.x, (uv.y - 0.5) / max(sq, 0.05) + 0.5);
  vec2 g = step(vec2(0.0), suv) * step(suv, vec2(1.0));

  float m = smoothstep(0.4, 0.6, u_progress);
  vec4 c = mix(texture(u_from, suv), texture(u_to, suv), m) * g.x * g.y;

  // Snow, re-seeded every frame at 30fps so it crawls rather than shimmers.
  float seed = floor(u_time * 30.0);
  vec2 np = floor(uv * u_resolution.xy / max(u_static_grain, 0.5));
  float n = t_hash(np + seed * 7.3);
  vec3 snow = vec3(n);
  snow = mix(snow, vec3(n, t_hash(np + seed * 3.1), t_hash(np + seed * 11.7)), u_static_color);

  // Rolling hum bar — the slow bright band on a mistuned set.
  float hum = 0.5 + 0.5 * sin((uv.y + u_time * 0.35) * 6.2831853 * 2.0);
  c.rgb = mix(c.rgb, snow, clamp(amt * (0.55 + 0.45 * hum * u_static_hum), 0.0, 1.0));
  c.a = max(c.a, amt);
  return c;
}
`,
  },

  SLICE_SHIFT: {
    label: 'Slice Shift',
    category: 'Digital',
    description: 'The frame breaks into slices that slide apart and slam back carrying the new picture.',
    glsl: `
// @param name="Slices" min=2.0 max=48.0 default=14.0 step=1.0
uniform float u_slice_count;
// @param name="Offset" min=0.0 max=1.5 default=0.6 step=0.01
uniform float u_slice_offset;
// @param name="Axis" type=select options="Horizontal,Vertical" default=0
uniform int u_slice_axis;
// @param name="Stagger" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_slice_stagger;
// @param name="Gap Color" type=color default="#000000"
uniform vec3 u_slice_gap;
// Opacity, not just a colour: a slice that has left the frame exposes whatever
// is behind the clip, and forcing that to opaque black would hide lower tracks
// (and bake black into a transparent export). 1.0 is the classic look, 0.0 is
// the honest one.
// @param name="Gap Opacity" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_slice_gap_alpha;

vec4 transition(vec2 uv) {
  float n = max(2.0, floor(u_slice_count + 0.5));
  float across = u_slice_axis == 0 ? uv.y : uv.x;
  float idx = floor(across * n);
  float rnd = t_hash(vec2(idx, 5.0));

  // Each slice runs its own sub-window, staggered by a hash. Slices alternate
  // direction so the frame shears apart instead of drifting one way.
  float delay = rnd * u_slice_stagger;
  float p = clamp((u_progress - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);
  float dirSign = mod(idx, 2.0) < 0.5 ? 1.0 : -1.0;

  // Push out to the peak, then home. Both ends land exactly on zero offset, so
  // the first and last frames of the region are untouched.
  float push = t_env(p) * u_slice_offset * mix(0.5, 1.0, rnd) * dirSign;
  vec2 off = u_slice_axis == 0 ? vec2(push, 0.0) : vec2(0.0, push);

  vec2 suv = uv + off;
  float m = smoothstep(0.45, 0.55, p);
  vec4 a = t_clip(u_from, suv);
  vec4 b = t_clip(u_to, suv);
  vec4 c = mix(a, b, m);
  // Where a slice has left the frame, show the gap colour rather than the
  // clamped border pixel (which would read as a smear).
  vec2 g = step(vec2(0.0), suv) * step(suv, vec2(1.0));
  float inside = g.x * g.y;
  return mix(vec4(u_slice_gap, u_slice_gap_alpha), c, inside);
}
`,
  },

  // ─────────────────────────────── Organic ─────────────────────────────────

  INK_BLEED: {
    label: 'Ink Bleed',
    category: 'Organic',
    description: 'Ink soaks through the frame with a wet, darker rim ahead of the front.',
    glsl: `
// @param name="Ink Color" type=color default="#0a0a12"
uniform vec3 u_ink_color;
// @param name="Scale" min=1.0 max=16.0 default=5.0 step=0.5
uniform float u_ink_scale;
// @param name="Edge" min=0.01 max=0.4 default=0.09 step=0.005
uniform float u_ink_edge;
// @param name="Wetness" min=0.0 max=1.0 default=0.55 step=0.01
uniform float u_ink_wet;
// @param name="Bleed" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_ink_bleed;
// @param name="Drops" min=1.0 max=6.0 default=3.0 step=1.0
uniform float u_ink_drops;

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  vec2 c = (uv - 0.5) * asp;

  // Several blots that grow together, rather than one front sweeping across —
  // ink spreads from where it landed, and a single gradient reads as a wipe.
  float drops = max(1.0, floor(u_ink_drops + 0.5));
  // Normalised by the frame's half-diagonal so a blot reaches the far corner at
  // map = 1. Without that normalisation every distance past the clamp lands on
  // 1.0 together and the whole background flips on the last frame.
  float maxR = length(vec2(0.5) * asp);
  float map = 1.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= drops) break;
    float fi = float(i);
    vec2 o = (vec2(t_hash(vec2(fi, 1.7)), t_hash(vec2(fi, 9.1))) - 0.5) * asp * 0.9;
    map = min(map, length(c - o) / maxR / (0.55 + 0.5 * t_hash(vec2(fi, 4.4))));
  }
  // Fibrous distortion so the blot edge frays the way ink does in paper.
  map += (t_fbm(uv * asp * u_ink_scale) - 0.5) * 0.55 * u_ink_bleed;
  map = clamp(map, 0.0, 1.0);

  float intact = t_front(map, u_progress, u_ink_edge);
  float rim = 1.0 - abs(intact * 2.0 - 1.0);

  vec4 c0 = mix(texture(u_to, uv), texture(u_from, uv), intact);
  // Wet rim: the picture darkens and saturates just ahead of the ink, which is
  // what sells it as soaking in rather than being painted over.
  vec3 wet = mix(c0.rgb, u_ink_color, 0.65);
  c0.rgb = mix(c0.rgb, wet, pow(clamp(rim, 0.0, 1.0), 1.4) * u_ink_wet);
  return c0;
}
`,
  },

  LIQUID_MORPH: {
    label: 'Liquid Morph',
    category: 'Organic',
    description: 'The two frames flow into each other through a turbulent fluid warp.',
    glsl: `
// @param name="Flow" min=0.0 max=0.4 default=0.12 step=0.005
uniform float u_liq_flow;
// @param name="Scale" min=0.5 max=12.0 default=3.5 step=0.1
uniform float u_liq_scale;
// @param name="Detail" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_liq_detail;
// @param name="Speed" min=0.0 max=3.0 default=0.6 step=0.05
uniform float u_liq_speed;
// @param name="Swap" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_liq_swap;

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  float t = u_time * u_liq_speed;
  vec2 p = uv * asp * u_liq_scale;

  // Domain warp: noise sampled through noise. One octave is a wobble; feeding
  // the offset back is what makes it read as a fluid.
  vec2 q = vec2(t_fbm(p + vec2(0.0, t)), t_fbm(p + vec2(5.2, 1.3 - t)));
  vec2 r = vec2(t_fbm(p + 3.0 * q + vec2(1.7, 9.2)), t_fbm(p + 3.0 * q + vec2(8.3, 2.8)));
  vec2 flow = mix(q, r, u_liq_detail) - 0.5;

  // Warp peaks mid-transition and vanishes at both ends, so neither clip is
  // distorted on the frame where it should already be clean.
  float env = t_env(u_progress);
  vec2 w = flow * u_liq_flow * env;

  vec4 F = texture(u_from, uv + w);
  vec4 T = texture(u_to, uv - w);
  // The hand-off is itself driven by the flow field, so the two pictures
  // interleave in fingers instead of crossfading uniformly.
  float bias = (flow.x + flow.y) * 0.5 * u_liq_swap;
  return mix(F, T, smoothstep(0.0, 1.0, clamp(u_progress * 1.4 - 0.2 + bias, 0.0, 1.0)));
}
`,
  },

  RIPPLE: {
    label: 'Ripple',
    category: 'Organic',
    description: 'A wave radiates from a point, refracting the picture and leaving the incoming clip behind it.',
    glsl: `
// @param name="Waves" min=1.0 max=24.0 default=8.0 step=1.0
uniform float u_ripple_waves;
// @param name="Amplitude" min=0.0 max=0.2 default=0.05 step=0.002
uniform float u_ripple_amp;
// @param name="Width" min=0.05 max=1.0 default=0.35 step=0.01
uniform float u_ripple_width;
// @param name="Center X" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_ripple_cx;
// @param name="Center Y" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_ripple_cy;
// @param name="Highlight" min=0.0 max=2.0 default=0.5 step=0.05
uniform float u_ripple_hl;

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  vec2 ctr = vec2(u_ripple_cx, u_ripple_cy);
  vec2 c = (uv - ctr) * asp;
  float r = length(c);
  float maxR = length(vec2(max(ctr.x, 1.0 - ctr.x), max(ctr.y, 1.0 - ctr.y)) * asp);

  // The wave front travels past the far corner so it fully clears the frame.
  float front = u_progress * (maxR + u_ripple_width);
  float d = (r - front) / max(u_ripple_width, 0.01);
  // Ring envelope: the wave train only exists near the front.
  float ring = exp(-d * d * 3.0);
  float wave = sin(d * u_ripple_waves * 3.14159) * ring;

  vec2 dir = r > 0.0001 ? c / r : vec2(0.0);
  vec2 off = dir / asp * wave * u_ripple_amp;

  // Behind the front the incoming clip has arrived; ahead of it, the outgoing
  // one is still there. The refraction straddles the boundary.
  float m = 1.0 - smoothstep(-0.15, 0.15, d);
  vec4 col = mix(texture(u_from, uv + off), texture(u_to, uv + off), m);
  // Specular glint on the crest.
  col.rgb += vec3(max(wave, 0.0) * u_ripple_hl);
  return col;
}
`,
  },

  SMOKE: {
    label: 'Smoke',
    category: 'Organic',
    description: 'Billowing cloud dissolve that drifts as it eats the frame.',
    glsl: `
// @param name="Scale" min=0.5 max=10.0 default=3.0 step=0.1
uniform float u_smoke_scale;
// @param name="Softness" min=0.02 max=0.6 default=0.22 step=0.01
uniform float u_smoke_soft;
// @param name="Drift" min=0.0 max=2.0 default=0.5 step=0.05
uniform float u_smoke_drift;
// @param name="Billow" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_smoke_billow;
// @param name="Tint" type=color default="#c8ccd8"
uniform vec3 u_smoke_tint;
// @param name="Density" min=0.0 max=1.5 default=0.5 step=0.05
uniform float u_smoke_density;

vec4 transition(vec2 uv) {
  vec2 asp = t_aspect();
  vec2 p = uv * asp * u_smoke_scale;
  // Rising drift plus a warp of the field by itself — smoke curls, it does not
  // slide, and a plain scroll of fbm reads as a moving texture rather than gas.
  p += vec2(0.0, -u_time * u_smoke_drift * 0.15);
  vec2 curl = vec2(t_fbm(p + 2.1), t_fbm(p + 7.7)) - 0.5;
  float map = t_fbm(p + curl * 2.0 * u_smoke_billow);
  map = clamp(map * 1.35 - 0.1, 0.0, 1.0);

  float intact = t_front(map, u_progress, u_smoke_soft);
  float rim = 1.0 - abs(intact * 2.0 - 1.0);

  vec4 c = mix(texture(u_to, uv), texture(u_from, uv), intact);
  // A puff of tinted smoke sits on the boundary and fades out with it.
  c.rgb = mix(c.rgb, u_smoke_tint, pow(clamp(rim, 0.0, 1.0), 1.5) * u_smoke_density);
  c.a = max(c.a, rim * min(u_smoke_density, 1.0));
  return c;
}
`,
  },

  // ──────────────────────────────── Light ──────────────────────────────────

  FLASH: {
    label: 'Flash',
    category: 'Light',
    description: 'A hard exposure spike blows the frame out and the incoming clip is there when your eyes recover.',
    glsl: `
// @param name="Flash Color" type=color default="#ffffff"
uniform vec3 u_flash_color;
// @param name="Intensity" min=0.0 max=4.0 default=2.0 step=0.05
uniform float u_flash_intensity;
// @param name="Sharpness" min=1.0 max=8.0 default=3.0 step=0.1
uniform float u_flash_sharp;
// @param name="Peak" min=0.1 max=0.9 default=0.45 step=0.01
uniform float u_flash_peak;
// @param name="Bloom" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_flash_bloom;

vec4 transition(vec2 uv) {
  // An asymmetric spike: fast attack into the peak, slower decay out of it.
  // A symmetric triangle reads as a dip to white, not as a flash.
  float p = u_progress;
  float pk = clamp(u_flash_peak, 0.05, 0.95);
  float x = p < pk ? p / pk : (1.0 - p) / max(1.0 - pk, 0.05);
  float spike = pow(clamp(x, 0.0, 1.0), u_flash_sharp);

  // Cut under the peak, where the eye has the least information.
  float m = smoothstep(pk - 0.06, pk + 0.06, p);
  vec4 c = mix(texture(u_from, uv), texture(u_to, uv), m);

  // Bloom lifts what is already bright before the flat flash is added, so
  // highlights bloom out first rather than the whole frame going grey.
  float l = t_luma(c.rgb);
  c.rgb += c.rgb * l * spike * u_flash_bloom * 2.0;
  c.rgb += u_flash_color * spike * u_flash_intensity;
  c.a = max(c.a, clamp(spike * u_flash_intensity, 0.0, 1.0));
  return c;
}
`,
  },

  BLOOM_DISSOLVE: {
    label: 'Bloom Dissolve',
    category: 'Light',
    description: 'Highlights swell and swallow the frame, then contract into the incoming clip.',
    glsl: `
// @param name="Bloom" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_bloom_radius;
// @param name="Threshold" min=0.0 max=1.0 default=0.45 step=0.01
uniform float u_bloom_threshold;
// @param name="Intensity" min=0.0 max=4.0 default=2.0 step=0.05
uniform float u_bloom_intensity;
// @param name="Tint" type=color default="#ffffff"
uniform vec3 u_bloom_tint;

vec4 transition(vec2 uv) {
  float env = t_env(u_progress);
  float m = smoothstep(0.35, 0.65, u_progress);

  vec4 sharpF = texture(u_from, uv);
  vec4 sharpT = texture(u_to, uv);
  float r = env * u_bloom_radius * 0.06;
  vec4 softF = t_disc(u_from, uv, r);
  vec4 softT = t_disc(u_to, uv, r);

  vec4 sharp = mix(sharpF, sharpT, m);
  vec4 soft = mix(softF, softT, m);

  // Only what is above the threshold blooms; the knee is soft so the effect
  // grows out of the highlights instead of switching on across a contour.
  float l = t_luma(soft.rgb);
  float key = smoothstep(u_bloom_threshold, min(u_bloom_threshold + 0.35, 1.0), l);
  vec4 c = sharp;
  c.rgb += soft.rgb * u_bloom_tint * key * env * u_bloom_intensity;
  c.a = max(c.a, key * env);
  return c;
}
`,
  },

  DEFOCUS: {
    label: 'Defocus',
    category: 'Light',
    description: 'A rack focus through the cut — the outgoing clip goes soft, the incoming one pulls into focus.',
    glsl: `
// @param name="Blur" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_defocus_blur;
// @param name="Bokeh" min=0.0 max=2.0 default=0.6 step=0.05
uniform float u_defocus_bokeh;
// @param name="Highlight" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_defocus_hl;
// @param name="Hold" min=0.0 max=0.6 default=0.15 step=0.01
uniform float u_defocus_hold;

vec4 transition(vec2 uv) {
  // Each side's blur ramps to maximum at its own end of the window, so the
  // hand-off happens while both are softest and no detail betrays the cut.
  float h = u_defocus_hold * 0.5;
  float outP = smoothstep(0.0, max(0.0001, 0.5 - h), u_progress);
  float inP = 1.0 - smoothstep(min(0.9999, 0.5 + h), 1.0, u_progress);
  float rMax = u_defocus_blur * 0.09;

  vec4 F = t_disc(u_from, uv, outP * rMax);
  vec4 T = t_disc(u_to, uv, inP * rMax);
  vec4 c = mix(F, T, smoothstep(0.4, 0.6, u_progress));

  // Out-of-focus highlights gain energy rather than just averaging away —
  // without this a defocus reads as a fog, because a plain box blur conserves
  // the mean and real bokeh does not.
  float env = t_env(u_progress);
  float l = t_luma(c.rgb);
  float key = smoothstep(0.55, 1.0, l);
  c.rgb += c.rgb * key * env * u_defocus_bokeh * u_defocus_hl;
  return c;
}
`,
  },
}

export const TRANSITION_TYPES = Object.keys(TRANSITIONS)

export function getTransitionLabel(type) {
  return TRANSITIONS[type]?.label || type
}

export function getTransitionDescription(type) {
  return TRANSITIONS[type]?.description || ''
}

export function getTransitionCategory(type) {
  return TRANSITIONS[type]?.category || 'Dissolve'
}

/** Assemble the full compilable fragment shader for a transition type. */
export function buildTransitionShader(type) {
  const t = TRANSITIONS[type]
  return t ? TRANSITION_HEADER + t.glsl + TRANSITION_FOOTER : null
}

// ── Transitions as graph nodes ───────────────────────────────────────────────
//
// The same `vec4 transition(vec2 uv)` body, wrapped so it compiles as an
// ordinary two-input effect node (TRANSITION_FX). This is what makes a
// transition something you can BUILD with rather than only pick: chain two of
// them, put a blur between them, drive each one's progress from its own remap.
//
// The bodies are used verbatim — the only difference is the prelude. Aliasing
// is done with #define rather than by rewriting the source, because a textual
// substitution would also hit `u_from` inside comments and identifiers like
// `u_fromage`, and because a #define keeps the line numbers of a compile error
// pointing at the line you actually wrote.
//
// `u_backdrop` and `u_opacity` are deliberately absent: they belong to the
// compositor's fallback (TRANSITION_FOOTER), not to the mix itself. A node sits
// mid-graph where there is no backdrop and no clip opacity to fall back to, and
// the node's own output is composited by whatever consumes it.
function transitionNodeHeader(type) {
  // The Effect selector is emitted as a real @param on a real uniform, so it is
  // parsed, displayed, serialized and socket-generated by the existing
  // machinery with no special case anywhere in the UI. The uniform is unused by
  // the body, so the compiler strips it and uploadUniforms skips it — it exists
  // purely to be a control.
  const options = TRANSITION_TYPES.map(getTransitionLabel).join(',')
  const idx = Math.max(0, TRANSITION_TYPES.indexOf(type))
  return `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_texture_b;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_beat;
uniform float u_audio_rms;
// @param name="Effect" type=select options="${options}" default=${idx}
uniform int u_tfx_type;
// @param name="Progress" min=0.0 max=1.0 default=0.5 step=0.001
uniform float u_tfx_progress;
out vec4 fragColor;

#define u_from u_texture
#define u_to u_texture_b
#define u_progress u_tfx_progress
`
}

const TRANSITION_NODE_FOOTER = `
void main() {
  fragColor = transition(v_uv);
}
`

// The shared helper block, minus the uniform declarations and the fragment
// output (the node header provides its own). Sliced out of TRANSITION_HEADER so
// there is exactly one copy of t_fbm, t_front and friends in the codebase.
const HELPERS_MARKER = 'float t_hash('
const TRANSITION_HELPERS = TRANSITION_HEADER.slice(TRANSITION_HEADER.indexOf(HELPERS_MARKER))

/** The Effect param's uniform name — the one param that changes the source. */
export const TRANSITION_FX_TYPE_UNIFORM = 'u_tfx_type'

/** Resolve a TRANSITION_FX node's stored Effect param to a transition key. */
export function transitionFxType(params) {
  const raw = params?.[TRANSITION_FX_TYPE_UNIFORM]
  if (typeof raw === 'string') {
    if (TRANSITIONS[raw]) return raw
    // Select params persist either the index or the LABEL, so tolerate both.
    const byLabel = TRANSITION_TYPES.find(t => getTransitionLabel(t) === raw)
    if (byLabel) return byLabel
  }
  const idx = Math.round(Number(raw))
  return TRANSITION_TYPES[idx] || 'CROSSFADE'
}

/**
 * Full compilable source for a TRANSITION_FX node.
 * @param {object|string} nodeOrType — a node (its params pick the effect) or a
 *   transition key directly.
 */
export function buildTransitionNodeShader(nodeOrType) {
  const type = typeof nodeOrType === 'string'
    ? nodeOrType
    : transitionFxType(nodeOrType?.params)
  const t = TRANSITIONS[type]
  if (!t) return null
  return transitionNodeHeader(type) + TRANSITION_HELPERS + t.glsl + TRANSITION_NODE_FOOTER
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
