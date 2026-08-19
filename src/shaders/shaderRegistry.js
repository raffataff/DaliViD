/**
 * DaliVid — shaderRegistry.js
 * Central registry mapping node types to their GLSL fragment shader sources.
 * Shaders are imported lazily to keep initial bundle size small.
 */

import { LIB3D } from './lib3d.glsl.js'
import { buildTransitionNodeShader } from './transitionRegistry.js'

// Inline shader sources — each one includes @param directives for the inspector
const SHADER_SOURCES = {}

/**
 * Register a shader source for a node type.
 */
export function registerShader(nodeType, source) {
  SHADER_SOURCES[nodeType] = source
}

/**
 * Get the fragment shader source for a given node type.
 * Returns null for source/sink nodes that don't have shaders.
 */
export function getShaderSource(nodeType) {
  return SHADER_SOURCES[nodeType] || null
}

/**
 * Get all registered node types.
 */
export function getRegisteredTypes() {
  return Object.keys(SHADER_SOURCES)
}

/**
 * Resolve the single source-of-truth GLSL for a node.
 * Priority: user-edited custom source → node-attached shaderCode → registry default.
 * Used by the compiler, the inspector (param parsing), and the Monaco editor so all
 * three always read the exact same shader.
 */
export function getNodeSource(node) {
  if (!node) return null
  if (node.customShaderSource) return node.customShaderSource
  // TRANSITION_FX has no fixed registry entry: its source is assembled from
  // whichever transition its Effect param names, so every built-in becomes a
  // chainable node without registering 35 near-identical shaders. Checked before
  // node.shaderCode so an older saved node carrying a baked copy still switches
  // effects. See `SOURCE_PARAMS` in useGraphStore for how a change recompiles.
  if (node.type === 'TRANSITION_FX') return buildTransitionNodeShader(node)
  return node.shaderCode || getShaderSource(node.type) || null
}

// TRANSITION_FX's real source is assembled per node (see getNodeSource above),
// but registering the DEFAULT has two jobs: a bare getShaderSource call — which
// is what the add-node paths use to compute a new node's default params —
// returns something sensible, and the wrapper gets the same smoke-test coverage
// as every other shader. The #define aliases are already understood by the
// smoke test's declared-name check, so u_from / u_to / u_progress read as
// declared rather than as three undeclared uniforms.
registerShader('TRANSITION_FX', buildTransitionNodeShader('CROSSFADE'))

// ═══════════════════════════════════════════════════════════
// Built-in Shader Sources
// ═══════════════════════════════════════════════════════════

// ── Edge Detection (Sobel) ──
registerShader('EDGE_DETECTION', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Threshold" min=0.0 max=1.0 default=0.1 step=0.01
uniform float u_threshold;
// @param name="Strength" min=0.0 max=5.0 default=1.0 step=0.1
uniform float u_strength;
// @param name="Show Original" type=bool default=false
uniform bool u_show_original;
out vec4 fragColor;

// One Sobel tap, weighted by its OWN alpha. Straight RGB inside a matte is
// undefined — for alpha video it is whatever the codec left in the colour
// plane, which is stepped at macroblock boundaries and smeared a few pixels
// into the matte by 4:2:0 chroma subsampling. A derivative operator turns those
// steps into hard edges, which is where the blocky fringe around transparent
// content came from. Premultiplying makes the matte a flat zero, so the only
// edge left along a silhouette is the silhouette itself — which is the edge you
// actually wanted. One fetch per tap, exactly as before.
float edTap(vec2 uv) {
  vec4 s = texture(u_texture, uv);
  return length(s.rgb * s.a);
}

void main() {
  vec2 px = 1.0 / u_resolution;
  float tl = edTap(v_uv + vec2(-px.x, px.y));
  float t  = edTap(v_uv + vec2(0.0, px.y));
  float tr = edTap(v_uv + vec2(px.x, px.y));
  float l  = edTap(v_uv + vec2(-px.x, 0.0));
  float r  = edTap(v_uv + vec2(px.x, 0.0));
  float bl = edTap(v_uv + vec2(-px.x, -px.y));
  float b  = edTap(v_uv + vec2(0.0, -px.y));
  float br = edTap(v_uv + vec2(px.x, -px.y));
  float gx = -tl - 2.0*l - bl + tr + 2.0*r + br;
  float gy = -tl - 2.0*t - tr + bl + 2.0*b + br;
  // Audio driver (0 until wired): treble sharpens the edges.
  float edge = sqrt(gx*gx + gy*gy) * (u_strength + u_treble * 2.0);
  edge = step(u_threshold, edge);
  vec4 original = texture(u_texture, v_uv);
  // Alpha is PASSED THROUGH, never forced to 1.0. Forcing it opaque destroyed
  // the source's matte, and that is what made anything computed in the matte
  // visible at all — with the matte intact the compositor multiplies it away.
  fragColor = u_show_original
    ? vec4(mix(original.rgb, vec3(edge), 0.5), original.a)
    : vec4(vec3(edge), original.a);
}
`)

// ── Color Inversion / HSV ──
registerShader('COLOR_INVERSION', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Hue Shift" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_hue_shift;
// @param name="Saturation" min=0.0 max=3.0 default=1.0 step=0.01
uniform float u_saturation;
// @param name="Brightness" min=0.0 max=3.0 default=1.0 step=0.01
uniform float u_brightness;
// @param name="Invert" type=bool default=false
uniform bool u_invert;
out vec4 fragColor;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 0.001)), d / (q.x + 0.001), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 col = texture(u_texture, v_uv);
  vec3 c = col.rgb;
  if (u_invert) c = 1.0 - c;
  vec3 hsv = rgb2hsv(c);
  // Audio drivers (0 until wired): treble spins the hue, bass pumps brightness.
  hsv.x = fract(hsv.x + u_hue_shift + u_treble * 0.15);
  hsv.y *= u_saturation * (1.0 + u_mid * 0.5);
  hsv.z *= u_brightness * (1.0 + u_bass * 0.6);
  fragColor = vec4(hsv2rgb(hsv), col.a);
}
`)

// ── Glitch / Datamosh ──
registerShader('GLITCH', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
// @param name="Intensity" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_intensity;
// @param name="Block Size" min=1.0 max=64.0 default=16.0 step=1.0
uniform float u_block_size;
// @param name="Speed" min=0.1 max=10.0 default=2.0 step=0.1
uniform float u_speed;
out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = v_uv;
  // Audio drivers (0 until wired): bass drives glitch density, treble the tear.
  float gIntensity = u_intensity + u_bass * 0.4;
  float blockY = floor(uv.y * u_resolution.y / u_block_size);
  float rnd = random(vec2(blockY, floor(u_time * u_speed)));
  if (rnd < gIntensity) {
    float offset = (random(vec2(blockY, floor(u_time * u_speed * 3.0))) - 0.5) * 0.1 * gIntensity;
    uv.x += offset;
  }
  float rnd2 = random(vec2(floor(u_time * u_speed * 2.0), 0.0));
  if (rnd2 < gIntensity * 0.3 + u_treble * 0.15) {
    float rgbOffset = u_intensity * 0.01;
    vec4 sr = texture(u_texture, vec2(uv.x + rgbOffset, uv.y));
    vec4 sg = texture(u_texture, uv);
    vec4 sb = texture(u_texture, vec2(uv.x - rgbOffset, uv.y));
    // Split the channels in PREMULTIPLIED space, then divide back out to the
    // pipeline's straight convention. A tap that landed in the matte has no
    // defined colour, so it must contribute nothing rather than whatever the
    // codec left there. Alpha is the union of the three taps — a channel split
    // genuinely widens the silhouette by the offset — and is never forced to
    // 1.0, which used to destroy the matte outright.
    float ga = max(sr.a, max(sg.a, sb.a));
    vec3 split = vec3(sr.r * sr.a, sg.g * sg.a, sb.b * sb.a);
    fragColor = ga > 0.0001 ? vec4(split / ga, ga) : vec4(0.0);
  } else {
    fragColor = texture(u_texture, uv);
  }
}
`)

// ── Chromatic Aberration ──
registerShader('CHROMATIC_ABERRATION', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Offset" min=0.0 max=0.05 default=0.005 step=0.001
uniform float u_offset;
// @param name="Radial" type=bool default=true
uniform bool u_radial;
out vec4 fragColor;

void main() {
  // Audio driver (0 until wired): treble widens the chromatic split.
  float off = u_offset * (1.0 + u_treble * 2.0);
  vec2 dir = u_radial ? normalize(v_uv - 0.5) * off : vec2(off, 0.0);
  float r = texture(u_texture, v_uv + dir).r;
  float g = texture(u_texture, v_uv).g;
  float b = texture(u_texture, v_uv - dir).b;
  float a = texture(u_texture, v_uv).a;
  fragColor = vec4(r, g, b, a);
}
`)

// ── Bloom / Glow ──
registerShader('BLOOM', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Threshold" min=0.0 max=1.0 default=0.7 step=0.01
uniform float u_threshold;
// @param name="Intensity" min=0.0 max=3.0 default=1.0 step=0.05
uniform float u_bloom_intensity;
// @param name="Radius" min=1.0 max=32.0 default=8.0 step=1.0
uniform float u_radius;
out vec4 fragColor;

void main() {
  vec4 original = texture(u_texture, v_uv);
  vec2 px = 1.0 / u_resolution;
  vec3 bloom = vec3(0.0);
  float total = 0.0;
  // Clamp the radius so a modulated / out-of-range value can't blow up the loop.
  float r = clamp(u_radius, 1.0, 32.0);
  int rad = int(r);
  // Constant loop bounds for portability; taps beyond the active radius are skipped.
  const int MAX_RAD = 32;
  for (int x = -MAX_RAD; x <= MAX_RAD; x++) {
    if (x < -rad || x > rad) continue;
    for (int y = -MAX_RAD; y <= MAX_RAD; y++) {
      if (y < -rad || y > rad) continue;
      vec2 off = vec2(float(x), float(y)) * px * 2.0;
      vec4 s = texture(u_texture, v_uv + off);
      // Premultiplied: a tap inside the matte has no defined colour, so it must
      // not contribute glow. Without this a transparent region's codec garbage
      // reads as "bright" and blooms into the silhouette.
      vec3 srgb = s.rgb * s.a;
      float lum = dot(srgb, vec3(0.299, 0.587, 0.114));
      float bright = max(0.0, lum - u_threshold);
      float weight = exp(-float(x*x + y*y) / (r * r * 0.5));
      bloom += srgb * bright * weight;
      total += weight;
    }
  }
  bloom /= max(total, 1.0);
  // Audio drivers (0 until wired): bass swells the glow, presence adds sparkle.
  float bloomAmt = u_bloom_intensity * (1.0 + u_bass * 1.2) + u_presence * 0.5;
  fragColor = vec4(original.rgb + bloom * bloomAmt, original.a);
}
`)

// ── CRT / Scanlines ──
registerShader('CRT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
// @param name="Curvature" min=0.0 max=0.3 default=0.05 step=0.005
uniform float u_curvature;
// @param name="Scanline Intensity" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_scanline_intensity;
// @param name="Vignette" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_vignette;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  // Audio driver (0 until wired): bass bulges the tube curvature.
  uv *= 1.0 + (u_curvature + u_bass * 0.05) * (uv.yx * uv.yx);
  uv = uv * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  vec4 col = texture(u_texture, uv);
  float scanline = sin(uv.y * u_resolution.y * 3.14159) * 0.5 + 0.5;
  // Treble deepens the scanline flicker.
  col.rgb *= 1.0 - (u_scanline_intensity + u_treble * 0.3) * (1.0 - scanline);
  float vig = 1.0 - u_vignette * length(uv - 0.5) * 1.5;
  col.rgb *= vig;
  fragColor = col;
}
`)

// ── Mirror / Symmetry ──
registerShader('MIRROR', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Axis" min=0 max=3 default=0 step=1 type=select options="Horizontal,Vertical,Both,Diagonal"
uniform int u_axis;
// @param name="Offset" min=-0.5 max=0.5 default=0.0 step=0.01
uniform float u_mirror_offset;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv;
  // Audio driver (0 until wired): mid sways the mirror axis.
  float mOff = u_mirror_offset + u_mid * 0.1;
  if (u_axis == 0 || u_axis == 2) {
    uv.x = uv.x < 0.5 + mOff ? uv.x : 1.0 - uv.x;
  }
  if (u_axis == 1 || u_axis == 2) {
    uv.y = uv.y < 0.5 + mOff ? uv.y : 1.0 - uv.y;
  }
  if (u_axis == 3) {
    if (uv.x > uv.y) { float t = uv.x; uv.x = uv.y; uv.y = t; }
  }
  fragColor = texture(u_texture, uv);
}
`)

// ── Threshold / Posterize ──
registerShader('THRESHOLD', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Levels" min=2.0 max=32.0 default=4.0 step=1.0
uniform float u_levels;
// @param name="Threshold" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_threshold_val;
// @param name="Mode" min=0 max=1 default=0 step=1 type=select options="Posterize,Threshold"
uniform int u_mode;
out vec4 fragColor;

void main() {
  vec4 col = texture(u_texture, v_uv);
  // Audio drivers (0 until wired): mid adds posterize levels, bass shifts the cut.
  float lv = u_levels * (1.0 + u_mid * 1.0);
  if (u_mode == 0) {
    col.rgb = floor(col.rgb * lv + 0.5) / lv;
  } else {
    float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
    col.rgb = vec3(step(u_threshold_val - u_bass * 0.2, lum));
  }
  fragColor = col;
}
`)

// ── Kaleidoscope ──
registerShader('KALEIDOSCOPE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_time;
// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="Radial,Mirror Box,Cell Mirrors,Fractal Fold"
uniform int u_mode;
// @param name="Segments" min=2.0 max=24.0 default=6.0 step=1.0
uniform float u_segments;
// @param name="Rotation" min=0.0 max=6.283 default=0.0 step=0.01
uniform float u_rotation;
// @param name="Zoom" min=0.1 max=4.0 default=1.0 step=0.05
uniform float u_zoom;
// @param name="Center X" min=-0.5 max=0.5 default=0.0 step=0.01
uniform float u_center_x;
// @param name="Center Y" min=-0.5 max=0.5 default=0.0 step=0.01
uniform float u_center_y;
// @param name="Fold Iterations" min=1.0 max=8.0 default=4.0 step=1.0
uniform float u_fold_iters;
out vec4 fragColor;

vec2 kRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// Mirror-repeat into [0,1]: reflected tiling, so every tile edge is a
// seam-free mirror rather than a hard wrap.
vec2 kMirror(vec2 p) { vec2 m = mod(p, 2.0); return mix(m, 2.0 - m, step(1.0, m)); }

void main() {
  // Movable mirror origin. Defaults (0,0 offset) keep the legacy centered
  // behaviour, so old projects render identically (uniforms default to 0).
  vec2 center = vec2(0.5 + u_center_x, 0.5 + u_center_y);
  vec2 uv = v_uv - center;
  vec2 suv;

  if (u_mode == 0) {
    // Radial — the classic n-fold wedge mirror around the origin.
    // Audio drivers (0 until wired): treble spins, bass zooms.
    float angle = atan(uv.y, uv.x) + u_rotation + u_treble * 1.5;
    float radius = length(uv) * u_zoom * (1.0 + u_bass * 0.5);
    float segAngle = 6.2831853 / u_segments;
    angle = mod(angle, segAngle);
    if (angle > segAngle * 0.5) angle = segAngle - angle;
    suv = vec2(cos(angle), sin(angle)) * radius + center;
  }
  else if (u_mode == 1) {
    // Mirror Box — hall-of-mirrors: the image reflects across a rectangular
    // lattice instead of around a point, so the symmetry fills the whole
    // frame with no privileged centre. Segments sets the tile density.
    vec2 p = kRot(uv, u_rotation + u_treble * 0.4) * u_zoom * (1.0 + u_bass * 0.5);
    suv = kMirror(p * max(u_segments * 0.5, 1.0) + center);
  }
  else if (u_mode == 2) {
    // Cell Mirrors — a LATTICE of little kaleidoscopes: each grid cell runs
    // its own radial wedge fold around its own centre, slowly spinning.
    vec2 p = kRot(uv, u_rotation) * (1.0 + u_bass * 0.3);
    float cells = max(u_segments * 0.5, 1.0);
    vec2 g = p * cells;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float angle = atan(f.y, f.x) + u_time * 0.2 + u_treble;
    float segAngle = 6.2831853 / max(u_segments, 3.0);
    angle = mod(angle, segAngle);
    if (angle > segAngle * 0.5) angle = segAngle - angle;
    vec2 lp = vec2(cos(angle), sin(angle)) * length(f) * u_zoom;
    suv = kMirror((id + 0.5 + lp) / cells + center);
  }
  else {
    // Fractal Fold — iterated mirror-and-rotate (abs → offset → rotate):
    // each iteration folds the plane again, giving nested mandala symmetry
    // with no single centre. Treble tilts the fold angles.
    vec2 p = kRot(uv, u_rotation) * u_zoom * (1.0 + u_bass * 0.5);
    float a = 6.2831853 / max(u_segments, 2.0);
    float iters = clamp(u_fold_iters, 1.0, 8.0);
    for (float i = 0.0; i < 8.0; i++) {
      if (i >= iters) break;
      p = abs(p) - 0.28 / (i + 1.0);
      p = kRot(p, a + i * 0.15 + u_treble * 0.3);
    }
    suv = kMirror(p + center);
  }

  fragColor = texture(u_texture, suv);
}
`)

// ── Halftone ──
registerShader('HALFTONE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Dot Size" min=2.0 max=32.0 default=8.0 step=1.0
uniform float u_dot_size;
// @param name="Angle" min=0.0 max=1.5708 default=0.7854 step=0.01
uniform float u_angle;
out vec4 fragColor;

void main() {
  float s = sin(u_angle), c = cos(u_angle);
  vec2 uv = v_uv * u_resolution;
  vec2 rotUV = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
  vec2 cell = floor(rotUV / u_dot_size);
  vec2 cellCenter = (cell + 0.5) * u_dot_size;
  vec2 origCenter = vec2(c * cellCenter.x + s * cellCenter.y, -s * cellCenter.x + c * cellCenter.y);
  vec4 col = texture(u_texture, origCenter / u_resolution);
  // Luma is read PREMULTIPLIED. A cell centre that landed in the matte has no
  // defined colour, and reading it straight sized the dot from codec garbage —
  // which is how a halftone grid appeared inside transparent regions.
  float lum = dot(col.rgb * col.a, vec3(0.299, 0.587, 0.114));
  float dist = distance(rotUV, cellCenter);
  // Audio driver (0 until wired): bass fattens the dots.
  float radius = lum * u_dot_size * 0.5 * (1.0 + u_bass * 0.8);
  float dot = smoothstep(radius, radius - 1.0, dist);
  // Alpha comes from THIS pixel, not from the cell centre, so the matte keeps
  // its own shape instead of being quantised to the dot grid — and is never
  // forced to 1.0, which destroyed it entirely.
  fragColor = vec4(vec3(dot), texture(u_texture, v_uv).a);
}
`)

// ── Custom Shader (template) ──
registerShader('CUSTOM', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_frame;

// ── Audio drivers — just USE them, they're auto-declared (no uniform line needed):
//   u_bass  u_mid  u_treble  u_rms  u_sub_bass  u_low_mid  u_high_mid  u_presence
// Each is 0.0 until you wire the matching Audio Splitter band into this node's
// "Audio Drivers" socket — then it's live. 0 is neutral for additive code
// (x + u_bass) and for multiplicative code written as x * (1.0 + u_bass).
// u_beat is the one exception — always live, no wiring needed.

// @param name="Intensity" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_intensity;

out vec4 fragColor;

void main() {
  vec4 col = texture(u_texture, v_uv);

  // Example: pump brightness with the bass, tint highs toward the treble.
  // (u_bass / u_treble are 0 until you connect the splitter to Audio Drivers.)
  col.rgb *= 1.0 + u_bass * u_intensity;
  col.rgb += vec3(0.2, 0.1, 0.4) * u_treble * u_intensity;

  fragColor = col;
}
`)

// ── Audio Warp (audio-driver EXAMPLE: bass zoom-punch + treble RGB split) ──
// Wire the Audio Splitter's Bass and Treble outputs into this node's
// "Audio Drivers" socket to activate. The drivers are 0.0 until connected.
registerShader('AUDIO_WARP', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;

// Audio drivers (0.0 until wired into the Audio Drivers socket):
uniform float u_bass;
uniform float u_treble;

// @param name="Zoom Punch" min=0.0 max=0.5 default=0.15 step=0.01
uniform float u_zoom_amt;
// @param name="RGB Split" min=0.0 max=0.05 default=0.012 step=0.001
uniform float u_rgb_amt;
out vec4 fragColor;

void main() {
  vec2 centered = v_uv - 0.5;
  // Bass punches a radial zoom (multiplicative, neutral when u_bass == 0).
  centered *= 1.0 - u_bass * u_zoom_amt;
  vec2 uv = centered + 0.5;
  // Treble drives a chromatic split along the radial direction (additive).
  vec2 dir = normalize(centered + 1e-5) * (u_treble * u_rgb_amt);
  float r = texture(u_texture, uv + dir).r;
  float g = texture(u_texture, uv).g;
  float b = texture(u_texture, uv - dir).b;
  fragColor = vec4(r, g, b, texture(u_texture, uv).a);
}
`)

// ── Spectrum Glow (audio-driver EXAMPLE: per-band color grading) ──
// Wire Bass / Mid / Treble into the "Audio Drivers" socket to activate.
registerShader('SPECTRUM_GLOW', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;

// Audio drivers (0.0 until wired into the Audio Drivers socket):
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Glow" min=0.0 max=2.0 default=0.8 step=0.05
uniform float u_glow;
// @param name="Saturation" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_sat;
out vec4 fragColor;

vec3 saturate_rgb(vec3 c, float s) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  return mix(vec3(l), c, s);
}

void main() {
  vec4 col = texture(u_texture, v_uv);
  // Bass lifts brightness (x * (1.0 + u_bass) is neutral at 0).
  col.rgb *= 1.0 + u_bass * u_glow;
  // Mid pushes saturation.
  col.rgb = saturate_rgb(col.rgb, u_sat * (1.0 + u_mid));
  // Treble adds a cool sparkle (additive, neutral at 0).
  col.rgb += vec3(0.1, 0.2, 0.4) * u_treble * u_glow;
  fragColor = col;
}
`)

// ── Feedback Loop ──
// Declaring u_prev_frame is what earns this node its own ping-pong FBO pair (the
// isFeedback branch in executeGraphDAG) — its output IS its history.
registerShader('FEEDBACK', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_prev_frame;
uniform float u_time;
// @param name="Feedback" min=0.0 max=0.99 default=0.85 step=0.01
uniform float u_feedback;
// @param name="Decay" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_fb_decay;
// @param name="Zoom" min=0.99 max=1.05 default=1.005 step=0.001
uniform float u_fb_zoom;
// @param name="Rotate" min=-0.1 max=0.1 default=0.0 step=0.001
uniform float u_fb_rotate;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv - 0.5;
  // Audio drivers (0 until wired): mid rotates the feedback, sub-bass zooms it.
  float ang = u_fb_rotate + u_mid * 0.03;
  float c = cos(ang), s = sin(ang);
  uv = mat2(c, -s, s, c) * uv;
  uv /= (u_fb_zoom + u_sub_bass * 0.01);
  uv += 0.5;
  vec4 prev = texture(u_prev_frame, uv);
  vec4 curr = texture(u_texture, v_uv);

  // ── Decay ──
  // How fast a trail gives up and rejoins the live frame. Implemented as a fixed
  // per-pass STEP of the history toward the live frame, clamped so it can never
  // overshoot past it — deliberately not a gain on the history.
  //
  // A gain is the obvious implementation and it is the wrong one, because it is
  // algebraically just Feedback again: mix(curr, prev * g, f) == mix(curr, prev,
  // f * g) with the live term dimmed. A Decay slider built that way duplicates
  // the slider above it, and the only effect you could actually tell apart is
  // the picture going dark.
  //
  // A clamped step is the thing Feedback genuinely cannot express. The loop's
  // own relaxation is geometric, so a faint trail approaches the live frame
  // without ever reaching it — that is the burnt-in residue that never quite
  // leaves at Feedback 0.95+. A constant step reaches it EXACTLY, in finite
  // time. And because the step aims at curr rather than at black, it only ever
  // eats the part of the history that DIFFERS from the live frame: a still frame
  // comes through untouched at any Decay, so this cannot crush the picture.
  //
  // Scaled by (1 - u_feedback) — the loop's own per-pass relaxation — so the two
  // sliders COMPOSE instead of fighting. A raw constant step takes roughly
  // amplitude / step passes to finish whatever Feedback is set to, so Decay 0.1
  // would cut every trail at ~10 frames whether Feedback said 0.7 or 0.95, and
  // Feedback would stop meaning anything the moment you touched Decay (measured:
  // 10 / 11 / 11 frames at Feedback 0.7 / 0.85 / 0.95). With the scale, Feedback
  // still sets the length and Decay shortens it proportionally — 13 / 18 / 30
  // frames across the same three. Read it as "cut the trail this much shorter
  // than Feedback alone would": 0 is the old never-ending trail, 1 is about five
  // frames of smear.
  //
  // Neutral at 0, which is also the default, and that is load-bearing:
  // clamp(delta, -0.0, 0.0) is exactly 0.0, so hist is prev BIT-FOR-BIT. A
  // FEEDBACK node saved before this param existed carries no u_fb_decay,
  // uploadUniforms skips it, and GLSL's implicit 0.0 then renders the old
  // picture exactly rather than a node that quietly stopped trailing. Do not
  // "improve" the default off zero.
  //
  // Audio driver (0 until wired): treble burns the trails off.
  float decay = (u_fb_decay + u_treble * 0.15) * (1.0 - u_feedback);
  vec4 delta = prev - curr;
  vec4 hist = prev - clamp(delta, -decay, decay);

  vec4 outCol = mix(curr, hist, u_feedback);
  // Trails may only ADD coverage, never eat into the live frame's own matte.
  // Decay steps the history's ALPHA too — it has to, or an alpha source leaves a
  // still-covering ghost after its colour has caught up — and where the source
  // is transparent curr.a is 0, so that trail decays to exactly nothing. This
  // floor also fixes a pre-existing wart unrelated to Decay: the history FBO is
  // cleared to alpha 0, so on the node's first frame the unfloored mix rendered
  // the whole node 85% transparent and faded it in over ~30 frames, every time
  // the graph recompiled or the canvas resized.
  outCol.a = max(outCol.a, curr.a);
  fragColor = outCol;
}
`)

// ── Blur (Gaussian) ──
registerShader('BLUR', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Radius" min=0.0 max=16.0 default=4.0 step=0.1
uniform float u_radius;
out vec4 fragColor;

void main() {
  vec2 px = 1.0 / u_resolution;
  vec4 color = vec4(0.0);
  float totalSpace = 0.0;
  // Clamp the radius so a modulated / out-of-range value can't blow up the loop.
  // Audio driver (0 until wired): loudness (rms) increases the blur.
  float r = clamp(u_radius + u_rms * 8.0, 0.0, 16.0);
  int rad = int(r);
  // Constant loop bounds for portability; taps beyond the active radius are skipped.
  const int MAX_RAD = 16;
  for (int x = -MAX_RAD; x <= MAX_RAD; x++) {
    if (x < -rad || x > rad) continue;
    for (int y = -MAX_RAD; y <= MAX_RAD; y++) {
      if (y < -rad || y > rad) continue;
      float w = exp(-(float(x*x + y*y)) / max(r * r * 0.5, 0.001));
      // Accumulate PREMULTIPLIED. Averaging straight RGBA weights a fully
      // transparent texel's colour exactly as heavily as an opaque one's, and
      // that colour is undefined (codec garbage in an alpha video's matte), so
      // a blur crossing a silhouette drags it inward as a coloured halo.
      // Premultiplied, a transparent tap contributes nothing but its coverage.
      vec4 s = texture(u_texture, v_uv + vec2(float(x), float(y)) * px);
      color += vec4(s.rgb * s.a, s.a) * w;
      totalSpace += w;
    }
  }
  color /= max(totalSpace, 1.0);
  // Back to straight — the pipeline's convention everywhere outside a gather.
  fragColor = color.a > 0.0001 ? vec4(color.rgb / color.a, color.a) : vec4(0.0);
}
`)

// ── Pixelate ──
registerShader('PIXELATE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Size" min=1.0 max=64.0 default=8.0 step=1.0
uniform float u_size;
out vec4 fragColor;

void main() {
  // Audio driver (0 until wired): treble shrinks the blocks (more detail on highs).
  vec2 grid = u_resolution / (u_size * (1.0 + u_treble * 1.5));
  vec2 uv = floor(v_uv * grid) / grid + 0.5 / grid;
  fragColor = texture(u_texture, uv);
}
`)

// ── Noise (Film Grain) ──
registerShader('NOISE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_time;
// @param name="Amount" min=0.0 max=1.0 default=0.15 step=0.01
uniform float u_amount;
// @param name="Animated" type=bool default=true
uniform bool u_animated;
out vec4 fragColor;

float rand(vec2 n) { 
  return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
}

void main() {
  vec4 col = texture(u_texture, v_uv);
  float t = u_animated ? u_time : 0.0;
  // Audio driver (0 until wired): overall loudness drives grain.
  float noise = (rand(v_uv + t) - 0.5) * (u_amount + u_rms * 0.3);
  col.rgb += noise;
  fragColor = col;
}
`)

// ── Displacement Map ──
registerShader('DISPLACEMENT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_disp_map;
// @param name="Scale" min=-0.5 max=0.5 default=0.1 step=0.01
uniform float u_scale;
out vec4 fragColor;

void main() {
  vec4 disp = texture(u_disp_map, v_uv);
  vec2 mapOffset = (disp.rg - 0.5) * 2.0;
  // Audio driver (0 until wired): bass deepens the displacement.
  vec2 uv = v_uv + mapOffset * u_scale * (1.0 + u_bass * 1.5);
  fragColor = texture(u_texture, uv);
}
`)

// ── Chroma Key (Green Screen) ──
registerShader('CHROMA_KEY', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Key Color" type=color default="#00ff00"
uniform vec3 u_key_color;
// @param name="Tolerance" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_tolerance;
// @param name="Smoothness" min=0.0 max=1.0 default=0.1 step=0.01
uniform float u_smoothness;
out vec4 fragColor;

vec3 rgb2ycbcr(vec3 c) {
  float y = 0.299*c.r + 0.587*c.g + 0.114*c.b;
  float cb = 128.0 - 0.168736*c.r - 0.331264*c.g + 0.5*c.b;
  float cr = 128.0 + 0.5*c.r - 0.418688*c.g - 0.081312*c.b;
  return vec3(y, cb, cr);
}

void main() {
  vec4 col = texture(u_texture, v_uv);
  vec3 yuvCol = rgb2ycbcr(col.rgb * 255.0);
  vec3 yuvKey = rgb2ycbcr(u_key_color * 255.0);
  
  float dist = distance(yuvCol.yz, yuvKey.yz) / 255.0;
  float alpha = smoothstep(u_tolerance, u_tolerance + u_smoothness, dist);
  fragColor = vec4(col.rgb, col.a * alpha);
}
`)

// ── Emboss ──
registerShader('EMBOSS', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Intensity" min=0.0 max=5.0 default=2.0 step=0.1
uniform float u_intensity;
out vec4 fragColor;

void main() {
  vec2 px = 1.0 / u_resolution;
  vec4 c00 = texture(u_texture, v_uv + vec2(-px.x, -px.y));
  vec4 c22 = texture(u_texture, v_uv + vec2(px.x, px.y));
  // Premultiplied difference: a tap in the matte has no defined colour, and a
  // difference operator turns the codec's macroblock steps there into relief.
  vec3 diff = c00.rgb * c00.a - c22.rgb * c22.a;
  // Audio driver (0 until wired): treble deepens the relief.
  float lum = dot(diff, vec3(0.299, 0.587, 0.114)) * (u_intensity + u_treble * 2.0);
  // Pass the source alpha through rather than forcing opaque — the flat grey
  // this shader emits would otherwise fill the whole matte.
  fragColor = vec4(vec3(0.5 + lum), texture(u_texture, v_uv).a);
}
`)

// ── Vignette ──
registerShader('VIGNETTE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Size" min=0.0 max=2.0 default=0.5 step=0.01
uniform float u_size;
// @param name="Softness" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_softness;
// @param name="Color" type=color default="#000000"
uniform vec3 u_color;
out vec4 fragColor;

void main() {
  vec4 col = texture(u_texture, v_uv);
  float dist = distance(v_uv, vec2(0.5));
  // Audio driver (0 until wired): bass opens the vignette (pulses to the beat).
  float vig = smoothstep(u_size + u_bass * 0.3, u_size - u_softness, dist);
  fragColor = vec4(mix(u_color, col.rgb, vig), col.a);
}
`)

// ── ASCII Art ──
registerShader('ASCII', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Scale" min=4.0 max=32.0 default=8.0 step=1.0
uniform float u_scale;
out vec4 fragColor;

float character(float n, vec2 p) {
  p = floor(p * vec2(-1.0, 1.0) + 0.5);
  if (clamp(p.x, 0.0, 4.0) == p.x && clamp(p.y, 0.0, 4.0) == p.y) {
    if (int(mod(n / exp2(p.x + 5.0 * p.y), 2.0)) == 1) return 1.0;
  }
  return 0.0;
}

void main() {
  // Audio driver (0 until wired): bass enlarges the character cells.
  vec2 px = u_resolution / (u_scale * (1.0 + u_bass * 0.6));
  vec2 uv = floor(v_uv * px) / px;
  vec4 col = texture(u_texture, uv);
  float gray = dot(col.rgb, vec3(0.299, 0.587, 0.114));
  
  float n =  65536.0;             // .
  if (gray > 0.2) n = 65600.0;    // :
  if (gray > 0.3) n = 332772.0;   // *
  if (gray > 0.4) n = 15255086.0; // o
  if (gray > 0.5) n = 23385164.0; // &
  if (gray > 0.6) n = 15252014.0; // 8
  if (gray > 0.7) n = 13199452.0; // @
  if (gray > 0.8) n = 11512810.0; // #
  
  vec2 p = fract(v_uv * px);
  float c = character(n, p);
  fragColor = vec4(col.rgb * c, col.a);
}
`)

// ── Lens Distortion ──
registerShader('LENS_DISTORTION', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Distortion" min=-1.0 max=1.0 default=0.2 step=0.01
uniform float u_distortion;
// @param name="Scale" min=0.5 max=2.0 default=1.0 step=0.01
uniform float u_scale;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv - 0.5;
  float r2 = dot(uv, uv);
  // Audio driver (0 until wired): bass bulges the lens.
  float f = 1.0 + r2 * (u_distortion + u_bass * 0.4);
  uv = uv * f * u_scale + 0.5;
  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
  } else {
    fragColor = texture(u_texture, uv);
  }
}
`)

// ── Letterbox / Widescreen Bars ──────────────────────────────────────────────
// Crops the frame to a delivery aspect ratio and fills the rest with bars.
// Wider target than the project → horizontal bars (letterbox); narrower →
// vertical bars (pillarbox). "Zoom to Fill" punches the source in so it fills
// the cropped window instead of just being covered by it.
//
// This is ALSO the shader behind the project-level "Widescreen Bars" toggle:
// Renderer compiles this same source once and drives it with u_lb_custom set to
// the chosen ratio, so the node and the master toggle can never drift apart.
registerShader('LETTERBOX', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Aspect" min=0 max=8 default=0 step=1 type=select options="2.39:1,2.35:1,2:1,1.85:1,16:9,3:2,4:3,1:1,9:16"
uniform int u_lb_aspect;
// @param name="Custom Ratio" min=0.0 max=4.0 default=0.0 step=0.01
uniform float u_lb_custom;
// @param name="Bar Color" type=color default="#000000"
uniform vec3 u_lb_color;
// @param name="Bar Opacity" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_lb_opacity;
// @param name="Feather" min=0.0 max=0.2 default=0.0 step=0.002
uniform float u_lb_feather;
// @param name="Offset" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_lb_offset;
// @param name="Zoom to Fill" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_lb_zoom;
out vec4 fragColor;

// Non-premultiplied "source over destination".
vec4 lbOver(vec4 s, vec4 d) {
  float a = s.a + d.a * (1.0 - s.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / a, a);
}

// Target ratio: a Custom Ratio above 0 wins, otherwise the Aspect preset.
float lbTarget() {
  if (u_lb_custom > 0.01) return u_lb_custom;
  if (u_lb_aspect == 0) return 2.39;
  if (u_lb_aspect == 1) return 2.35;
  if (u_lb_aspect == 2) return 2.0;
  if (u_lb_aspect == 3) return 1.85;
  if (u_lb_aspect == 4) return 16.0 / 9.0;
  if (u_lb_aspect == 5) return 1.5;
  if (u_lb_aspect == 6) return 4.0 / 3.0;
  if (u_lb_aspect == 7) return 1.0;
  return 9.0 / 16.0;
}

void main() {
  float frame = u_resolution.x / max(u_resolution.y, 1.0);
  float target = lbTarget();

  // Visible window as a fraction of the frame on each axis.
  vec2 keep = vec2(1.0);
  if (target < frame) keep.x = target / frame;   // pillarbox
  else                keep.y = frame / target;   // letterbox

  // Zoom so the source fills the cropped window (1.0 = fully filled).
  float z = mix(1.0, 1.0 / max(min(keep.x, keep.y), 0.001), clamp(u_lb_zoom, 0.0, 1.0));
  vec4 src = texture(u_texture, (v_uv - 0.5) / z + 0.5);

  // Slide the window along whichever axis is barred.
  vec2 half_ = keep * 0.5;
  vec2 off = vec2(u_lb_offset) * (vec2(0.5) - half_);
  vec2 dist = half_ - abs(v_uv - 0.5 - off);     // > 0 inside the window

  float aa = max(u_lb_feather * 0.5, 0.75 / max(u_resolution.y, 1.0));
  float inside = smoothstep(-aa, aa, min(dist.x, dist.y));
  fragColor = mix(lbOver(vec4(u_lb_color, u_lb_opacity), src), src, inside);
}
`)

// ── Transform (Pan / Zoom / Rotate) ─────────────────────────────────────────
// A camera over the incoming frame: Zoom punches in, Pan slides the view, and
// Rotation tilts it. This is ALSO the shader behind the per-clip "Transform"
// section in the Inspector (Renderer._applyClipTransform drives the same
// program), so the node and the clip control can never drift apart — the same
// single-source-of-truth trick LETTERBOX uses for the project bars.
//
// Conventions (shared with SHAPE_INPUT and the clip Transform UI):
//   • Pan is CAMERA-relative in frame-edge units: ±1 pans the view a half-frame,
//     so the PICTURE moves the opposite way. That is what "pan around the shot"
//     means, and it makes a zoom-in + pan read as one moving camera.
//   • v_uv.y is UP, so Pan Y +1 moves the view toward the top of the frame.
//   • Rotation is counter-clockwise-positive on screen (same as the shape gizmo).
//   • Aspect-corrected internally, so rotation never skews and a diagonal pan
//     travels at the same speed on both axes.
//
// Zooming past 1.0 magnifies the incoming FBO, which is canvas-resolution — a
// big punch-in on video is a genuine upscale and will soften. Stills don't have
// that problem: zoom on the IMAGE_INPUT node instead, which samples the original
// image at its native size.
registerShader('TRANSFORM', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_audio_bands[8];   // always-live FFT bands
uniform float u_beat;             // always-live beat trigger
// @param name="Zoom" min=0.1 max=8.0 default=1.0 step=0.01
uniform float u_xf_zoom;
// @param name="Pan X" min=-2.0 max=2.0 default=0.0 step=0.005
uniform float u_xf_pan_x;
// @param name="Pan Y" min=-2.0 max=2.0 default=0.0 step=0.005
uniform float u_xf_pan_y;
// @param name="Rotation" min=-3.1416 max=3.1416 default=0.0 step=0.01
uniform float u_xf_rot;
// @param name="Edges" min=0 max=3 default=0 step=1 type=select options="Transparent,Clamp,Mirror,Tile"
uniform int u_xf_edge;
// @param name="Bass Zoom" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_xf_bass_zoom;
// @param name="Beat Punch" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_xf_beat_punch;
out vec4 fragColor;

// Sample outside 0..1 the way the user asked. NOT left to the texture's wrap
// mode: every FBO in the pipeline is CLAMP_TO_EDGE, so the default would smear
// the border pixel into a streak the moment you pan past the frame.
vec4 xfSample(vec2 uv) {
  if (u_xf_edge == 1) {                        // Clamp — stretch the edge pixel
    return texture(u_texture, clamp(uv, 0.0, 1.0));
  }
  if (u_xf_edge == 2) {                        // Mirror — ping-pong the frame
    vec2 m = 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0);
    return texture(u_texture, m);
  }
  if (u_xf_edge == 3) {                        // Tile — repeat the frame
    return texture(u_texture, fract(uv));
  }
  // Transparent (default): fade out over ~1px so the border stays smooth when
  // rotated, and composites over whatever is on the track below.
  vec2 fw = fwidth(uv) + 1e-5;
  vec2 lo = smoothstep(vec2(0.0), fw, uv);
  vec2 hi = smoothstep(vec2(0.0), fw, vec2(1.0) - uv);
  vec4 c = texture(u_texture, clamp(uv, 0.0, 1.0));
  return vec4(c.rgb, c.a * lo.x * lo.y * hi.x * hi.y);
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);

  // Frame units: y ∈ [-0.5, 0.5], x scaled by aspect, so 1.0 == the frame HEIGHT
  // on both axes and rotation stays circular.
  vec2 p = vec2((v_uv.x - 0.5) * aspect, v_uv.y - 0.5);

  // Inverse-map the output pixel back to the source. Pan is added AFTER the
  // zoom divide, so it is measured in SOURCE-frame units: Pan X 0.5 always means
  // "centre on the point halfway to the right edge of the original", whatever
  // the zoom. That keeps the ±2 slider range meaningful at every zoom level —
  // dividing pan by zoom instead would make it uselessly coarse when punched in.
  float ca = cos(u_xf_rot), sa = sin(u_xf_rot);
  p = mat2(ca, -sa, sa, ca) * p;   // R(-rot) on the query == content turns CCW

  float bass = u_audio_bands[1];
  float zoom = max(u_xf_zoom * (1.0 + bass * u_xf_bass_zoom * 1.5 + u_beat * u_xf_beat_punch * 0.5), 0.001);
  p /= zoom;

  p += vec2(u_xf_pan_x * 0.5 * aspect, u_xf_pan_y * 0.5);

  fragColor = xfSample(vec2(p.x / aspect + 0.5, p.y + 0.5));
}
`)

// ── Array (Repeat / Instance) ───────────────────────────────────────────────
// Repeats the incoming frame as many copies, in a grid, a cascading chain or a
// ring/spiral. Three things about how it is built are load-bearing:
//
// 1. GRID DOES NOT LOOP OVER COPIES. A grid is a lattice, so the copies that
//    can cover THIS pixel are found by inverse-mapping the pixel to its cell and
//    then visiting only the neighbours whose footprint can still reach it. Cost
//    is therefore independent of the count: a 3x3 mosaic and a 40x40 one both
//    cost ONE texture fetch per pixel at the default spacing. A naive
//    for-each-copy loop is O(count) per pixel and is exactly the mistake the
//    house rule about radius loops warns against (see DEPTH_BLUR in CLAUDE.md).
//    The neighbourhood half-width is derived from the worst-case copy extent and
//    capped at AR_NB (a 5x5 window), so even pathological overlap stays bounded.
//
// 2. CHAIN AND RADIAL ARE WALKED FRONT TO BACK, WITH AN EARLY OUT. Those two
//    are genuinely not lattices, so they need a bounded loop (AR_MAX_I). Walking
//    from the front copy backwards means the accumulator saturates as soon as an
//    opaque copy covers the pixel and the loop stops — on ordinary opaque
//    footage that is ~1 fetch per pixel however many copies are configured.
//    Chain positions compound (copy k sits at the sum of k rotated, scaled
//    steps), which would normally force build-order iteration; the sum is a
//    geometric series in the complex plane, so it closes to (1 - z^k)/(1 - z)
//    and any copy can be evaluated directly. That closed form IS what makes the
//    front-to-back early out possible.
//
// 3. COUNT AND ROWS ARE FLOATS ON PURPOSE. The slider steps by 1, but step is a
//    UI attribute only — a float socket (LFO / RAMP / audio band / keyframe)
//    writes any value, and the fractional part FADES the last copy in instead of
//    popping it. An audio-driven Count is unusable without that.
//
// 4. ANCHOR IS ORTHOGONAL TO MODE, AND "KEEP ORIGINAL" IS A PROMISE.
//    Centered lays the array out around the array centre and auto-fits it to
//    the frame — the mosaic / video-wall job. Keep Original is the Blender array
//    modifier: COPY 0 IS THE INPUT FRAME, BIT-EXACT, and copies 1..N-1 cascade
//    away from it, so you can place something where you want it and repeat FROM
//    there. That promise is why Keep Original does not rotate the query by Array
//    Angle (it rotates each copy's DISPLACEMENT instead) and adds the pivot back
//    after the inverse map: with a displacement of 0, Size 1 and Copy Angle 0,
//    copy 0's transform is the identity whatever Center and Array Angle are set
//    to. Rotating the query would drag the original along with the array.
//    Keep Original also uses SIGNED absolute offsets rather than Spacing: with
//    Size 1 a copy IS the whole frame, so "multiples of the copy size" would put
//    every copy off screen, and an array needs to be able to go left, up, or
//    nowhere on an axis — none of which a positive multiple can express.
//    It walks the bounded loop in every mode, because a zero offset on an axis
//    is both COMMON there (a plain horizontal repeat) and exactly the case a
//    lattice inverse-map cannot invert. Copies are capped at AR_MAX_I, which is
//    the right trade: this anchor is for a handful of copies, not a 40x40 wall.
//
// Conventions are TRANSFORM's and SHAPE_INPUT's: aspect-corrected frame units
// where 1.0 == the frame HEIGHT on both axes, v_uv.y UP, rotation
// counter-clockwise-positive on screen, and position params +-1 at the frame
// edges. Everything accumulates PREMULTIPLIED and converts back to straight at
// the end, for the same reason BLUR does — a transparent copy carries undefined
// colour, and blending it straight drags that colour into the picture.
registerShader('ARRAY', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_audio_bands[8];   // always-live FFT bands
uniform float u_beat;             // always-live beat trigger
// @param name="Mode" min=0 max=2 default=0 step=1 type=select options="Grid,Chain,Radial"
uniform int u_ar_mode;
// @param name="Anchor" min=0 max=1 default=0 step=1 type=select options="Centered,Keep Original"
uniform int u_ar_anchor;
// @param name="Count" min=1 max=64 default=3 step=1
uniform float u_ar_count;
// @showif u_ar_mode != Chain
// @param name="Rows / Rings" min=1 max=64 default=3 step=1
uniform float u_ar_rows;
// @param name="Size (0=Auto)" min=0.0 max=4.0 default=0.0 step=0.005
uniform float u_ar_size;
// @showif u_ar_mode != Radial
// @showif u_ar_anchor == Centered
// @param name="Spacing X" min=0.05 max=4.0 default=1.0 step=0.005
uniform float u_ar_gap_x;
// @showif u_ar_mode == Grid
// @showif u_ar_anchor == Centered
// @param name="Spacing Y" min=0.05 max=4.0 default=1.0 step=0.005
uniform float u_ar_gap_y;
// @showif u_ar_mode != Radial
// @showif u_ar_anchor == Keep Original
// @param name="Offset X" min=-2.0 max=2.0 default=0.35 step=0.005
uniform float u_ar_off_x;
// @showif u_ar_mode != Radial
// @showif u_ar_anchor == Keep Original
// @param name="Offset Y" min=-2.0 max=2.0 default=-0.35 step=0.005
uniform float u_ar_off_y;
// @showif u_ar_mode == Radial
// @param name="Radius" min=0.0 max=2.0 default=0.35 step=0.005
uniform float u_ar_radius;
// @showif u_ar_mode == Radial
// @param name="Radius / Turn" min=-1.0 max=1.0 default=0.0 step=0.005
uniform float u_ar_radius_step;
// @showif u_ar_mode == Radial
// @param name="Arc" min=0.0 max=360.0 default=360.0 step=1.0
uniform float u_ar_arc;
// @showif u_ar_mode == Radial
// @param name="Face Center" type=bool default=false
uniform bool u_ar_orient;
// @param name="Array Angle" min=-180.0 max=180.0 default=0.0 step=0.5
uniform float u_ar_angle;
// @param name="Copy Angle" min=-180.0 max=180.0 default=0.0 step=0.5
uniform float u_ar_rot;
// @param name="Spin / Copy" min=-180.0 max=180.0 default=0.0 step=0.5
uniform float u_ar_spin;
// @param name="Scale / Copy" min=0.25 max=1.75 default=1.0 step=0.005
uniform float u_ar_scale_step;
// @param name="Fade / Copy" min=0.0 max=1.0 default=1.0 step=0.005
uniform float u_ar_fade;
// @param name="Hue / Copy" min=-0.5 max=0.5 default=0.0 step=0.005
uniform float u_ar_hue;
// @param name="Center X" min=-2.0 max=2.0 default=0.0 step=0.005
uniform float u_ar_cx;
// @param name="Center Y" min=-2.0 max=2.0 default=0.0 step=0.005
uniform float u_ar_cy;
// @param name="Jitter Position" min=0.0 max=2.0 default=0.0 step=0.005
uniform float u_ar_jit_pos;
// @param name="Jitter Size" min=0.0 max=1.0 default=0.0 step=0.005
uniform float u_ar_jit_size;
// @param name="Seed" min=0.0 max=64.0 default=0.0 step=1.0
uniform float u_ar_seed;
// @param name="Mirror" min=0 max=3 default=0 step=1 type=select options="Off,Alternate X,Alternate Y,Checker"
uniform int u_ar_mirror;
// @param name="Blend" min=0 max=3 default=0 step=1 type=select options="Over,Add,Screen,Max"
uniform int u_ar_blend;
// @showif u_ar_blend == Over
// @param name="Stacking" min=0 max=1 default=0 step=1 type=select options="Last on Top,First on Top"
uniform int u_ar_order;
// @param name="Filtering" min=0 max=1 default=1 step=1 type=select options="Fast,Smooth"
uniform int u_ar_filter;
// @param name="Source Under" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_ar_orig;
// @param name="Bass Size" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_ar_bass;
// @param name="Beat Punch" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_ar_punch;
out vec4 fragColor;

const float AR_TAU = 6.28318530718;
const float AR_D2R = 0.01745329252;
const int   AR_MAX_I = 64;   // hard cap on the Chain / Radial loop
const int   AR_NB    = 2;    // lattice neighbourhood half-width (5x5 worst case)

float arHash(vec2 c) {
  return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453123);
}

// Rotate rgb about the grey axis (Rodrigues on the 1,1,1 axis). A hue shift with
// no rgb-to-hsv round trip, and because it is LINEAR it gives the same answer on
// premultiplied colour as on straight — which is why it can be applied after the
// premultiply without unwinding it first.
vec3 arHue(vec3 c, float h) {
  if (h == 0.0) return c;
  float a = h * AR_TAU;
  vec3 k = vec3(0.57735027);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

// Complex divide, used only by the chain's geometric series.
vec2 arCDiv(vec2 a, vec2 b) {
  return vec2(dot(a, b), a.y * b.x - a.x * b.y) / max(dot(b, b), 1e-8);
}

// R(-a) applied to a QUERY point, i.e. the content turns counter-clockwise by a.
// Same sign convention as TRANSFORM and the shape gizmo.
mat2 arQRot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Fetch one copy, PREMULTIPLIED. fp is the source-uv footprint of one screen
// pixel inside this copy.
//
// textureLod(..., 0.0) rather than texture(): every FBO in the pipeline is
// LINEAR with no mip chain, so the implicit derivative would be computed and
// thrown away — and these calls sit inside non-uniform control flow, where the
// spec leaves implicit derivatives undefined.
vec4 arFetch(vec2 luv, vec2 fp) {
  if (u_ar_filter == 1 && max(fp.x * u_resolution.x, fp.y * u_resolution.y) > 1.05) {
    // Minifying, and there are no mipmaps to fall back on — so prefilter with a
    // 4-tap box over the pixel footprint, which is what keeps a 12x12 grid from
    // shimmering. Accumulated premultiplied for BLUR's reason: a transparent tap
    // carries undefined colour and must contribute nothing but its coverage.
    vec2 o = fp * 0.25;
    vec4 a0 = textureLod(u_texture, luv + vec2( o.x,  o.y), 0.0);
    vec4 a1 = textureLod(u_texture, luv + vec2(-o.x,  o.y), 0.0);
    vec4 a2 = textureLod(u_texture, luv + vec2( o.x, -o.y), 0.0);
    vec4 a3 = textureLod(u_texture, luv + vec2(-o.x, -o.y), 0.0);
    return (vec4(a0.rgb * a0.a, a0.a) + vec4(a1.rgb * a1.a, a1.a)
          + vec4(a2.rgb * a2.a, a2.a) + vec4(a3.rgb * a3.a, a3.a)) * 0.25;
  }
  vec4 c = textureLod(u_texture, luv, 0.0);
  return vec4(c.rgb * c.a, c.a);
}

// Evaluate one copy at query point q (array space) and composite it into the
// premultiplied accumulator. Returns true once Over has saturated, which is the
// caller's signal to stop walking.
//
// pivot is what the copy scales and rotates ABOUT, added back after the inverse
// map. It is zero under the Centered anchor (the query was already re-centred),
// and the array centre under Keep Original — which is what makes copy 0 there a
// bit-exact pass-through no matter where the centre is put.
bool arAccum(inout vec4 acc, vec2 q, vec2 pos, float scl, float rotA,
             float op, float hue, vec2 flip, vec2 pivot, float aspect) {
  float s = max(scl, 1e-4);
  // Scale and rotate about the pivot — but write the unrotated, unit-scale case
  // out separately, because it is the one that has to be EXACT. Subtracting the
  // pivot and adding it back is not bit-exact in float, and Keep Original's
  // copy 0 takes this branch: a 1/255 drift on the pixels of an untouched
  // original is small but it is not "untouched". Identical arithmetic under the
  // Centered anchor, where the pivot is zero.
  vec2 lp = (rotA == 0.0 && s == 1.0)
          ? q - pos
          : arQRot(rotA) * ((q - pivot) - pos) / s + pivot;
  vec2 luv = vec2(lp.x / aspect, lp.y) + 0.5;
  if (flip.x < 0.0) luv.x = 1.0 - luv.x;
  if (flip.y < 0.0) luv.y = 1.0 - luv.y;

  // One frame unit is u_resolution.y pixels on BOTH axes (x is aspect-corrected),
  // so a copy is s*aspect*H by s*H pixels and luv spans 0..1 across that.
  vec2 fp = 1.0 / max(vec2(s * aspect, s) * u_resolution.y, vec2(1e-4));

  // Coverage, measured in screen pixels from the copy's edge — this is what
  // keeps a rotated or heavily minified copy from having a stair-stepped border.
  vec2 d = min(luv, vec2(1.0) - luv);
  float cov = clamp(min(d.x / fp.x, d.y / fp.y) + 0.5, 0.0, 1.0);
  if (cov <= 0.0) return false;

  vec4 c = arFetch(luv, fp);
  c.rgb = arHue(c.rgb, hue);
  c *= cov * op;

  if (u_ar_blend == 1)      acc += c;                    // Add
  else if (u_ar_blend == 2) acc = acc + c - acc * c;     // Screen
  else if (u_ar_blend == 3) acc = max(acc, c);           // Max
  else {
    acc += (1.0 - acc.a) * c;                            // Over, front to back
    return acc.a > 0.996;
  }
  return false;
}

// Where copy k of a CHAIN lands, relative to the first copy. See note 2 above:
// this is the closed form of sum(j = 0 .. k-1) of scaleStep^j * R(spin*j) * step.
// The final multiply is complex, so the step may point anywhere — which is what
// lets Keep Original drive the chain with a signed 2D offset.
vec2 arChain(float k, vec2 stepV, float st, float spin, bool degen, vec2 den) {
  if (degen) return stepV * k;
  float sk = clamp(pow(st, k), 0.0, 1e6);
  vec2 zk = sk * vec2(cos(spin * k), sin(spin * k));
  vec2 geo = arCDiv(vec2(1.0, 0.0) - zk, den);
  return vec2(stepV.x * geo.x - stepV.y * geo.y, stepV.x * geo.y + stepV.y * geo.x);
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 p = vec2((v_uv.x - 0.5) * aspect, v_uv.y - 0.5);

  // Always-live audio: bass swells every copy, a beat punches them.
  float pulse = 1.0 + u_audio_bands[1] * u_ar_bass * 1.2 + u_beat * u_ar_punch * 0.5;

  int mode = clamp(u_ar_mode, 0, 2);
  bool keep = (u_ar_anchor == 1);
  // Grid is the only mode with a lattice to invert, and Keep Original's offsets
  // are free-form (signed, and routinely zero on one axis), so everything else
  // takes the bounded loop — see note 4.
  bool lattice = (mode == 0 && !keep);

  float fcount = clamp(u_ar_count, 1.0, 64.0);
  float frows  = (mode == 1) ? 1.0 : clamp(u_ar_rows, 1.0, 64.0);
  int cols = int(ceil(fcount - 1e-4));
  int rows = int(ceil(frows - 1e-4));
  // The loop paths visit copies by a single flat index, so the grid they see has
  // to fit the budget exactly — otherwise the tail fade would be attached to a
  // row that never renders.
  if (!lattice) {
    cols = min(cols, AR_MAX_I);
    rows = min(rows, max(1, AR_MAX_I / cols));
  }
  // The fractional tail (see note 3) — 1.0 on a whole number, otherwise the
  // opacity of the copy currently fading in at the end of the run.
  float tailC = clamp(fcount - float(cols - 1), 0.0, 1.0);
  float tailR = clamp(frows - float(rows - 1), 0.0, 1.0);

  // Auto size: Centered picks the largest copy that still tiles the frame at
  // this count, so setting Count / Rows gives an exact mosaic with no
  // arithmetic. Keep Original picks 1.0 — copy 0 has to be the input frame at
  // its own size, which IS the promise. Explicit Size wins either way.
  float autoS = keep ? 1.0 : 1.0 / float(max(max(cols, rows), 1));
  float baseS = max((u_ar_size <= 0.0005 ? autoS : u_ar_size) * pulse, 1e-4);

  vec2 cell  = vec2(baseS * aspect, baseS);
  vec2 pitch = cell * vec2(max(u_ar_gap_x, 0.02), max(u_ar_gap_y, 0.02));
  // Keep Original's step: signed, absolute, in frame-edge units like Center X/Y
  // and TRANSFORM's Pan, with +Y UP. Nothing is derived from the copy size here
  // — see note 4 for why that would be useless at Size 1.
  vec2 off = vec2(u_ar_off_x * 0.5 * aspect, u_ar_off_y * 0.5);

  float rotB = u_ar_rot * AR_D2R;
  // Audio driver (0 until wired): mids twist the cascade.
  float spin = (u_ar_spin + u_mid * 45.0) * AR_D2R;
  float st   = max(u_ar_scale_step, 0.05);
  float fade = max(u_ar_fade, 1e-4);
  // Audio driver (0 until wired): loudness scatters the copies.
  float jit  = max(u_ar_jit_pos + u_rms * 0.5, 0.0);

  vec2 centre = vec2(u_ar_cx * 0.5 * aspect, u_ar_cy * 0.5);
  float angR = u_ar_angle * AR_D2R;
  // Centered folds the array's rotation and centre into the QUERY once, so every
  // copy is then a plain translate / rotate / scale of it.
  //
  // Keep Original cannot do that: rotating the query rotates the original too,
  // and so does re-centring it. It passes the query through UNTOUCHED, rotates
  // each copy's DISPLACEMENT with dRot instead, and hands arAccum the centre as
  // the pivot copies scale and rotate about — so copy 0 (displacement 0, Size 1,
  // Copy Angle 0) inverse-maps to v_uv exactly, whatever those two are set to.
  vec2 q = keep ? p : arQRot(angR) * (p - centre);
  float ca = cos(angR), sa = sin(angR);
  mat2 dRot = keep ? mat2(ca, sa, -sa, ca) : mat2(1.0, 0.0, 0.0, 1.0);
  vec2 pivot = keep ? centre : vec2(0.0);

  vec4 acc = vec4(0.0);
  // Walk front to back so Over can stop early. Only Over is order-dependent;
  // Add / Screen / Max are commutative, so the direction is free there.
  bool desc = (u_ar_order == 0);
  bool done = false;

  if (lattice) {
    // ── GRID — inverse-mapped lattice, no per-copy loop.
    // Cell coordinate of this pixel. y counts DOWN so row 0 is the top row.
    vec2 g = vec2(q.x, -q.y) / max(pitch, vec2(1e-4))
           + 0.5 * vec2(float(cols - 1), float(rows - 1));
    ivec2 c0 = ivec2(floor(g + 0.5));

    // How far the copies around this cell can reach. Scale / Copy compounds by
    // index, so bound it over the LOCAL index window rather than the whole grid
    // — a global bound would push a 40x40 array to the 5x5 cap for no reason.
    int total = cols * rows;
    float kHere = float(clamp(c0.y * cols + c0.x, 0, max(total - 1, 0)));
    float span = float(AR_NB * cols + AR_NB);
    float kLo = max(kHere - span, 0.0);
    float kHi = min(kHere + span, float(max(total - 1, 0)));
    float grow = clamp(max(pow(st, kLo), pow(st, kHi)), 0.0, 64.0);
    float maxS = baseS * grow * (1.0 + 0.5 * u_ar_jit_size);

    // A rotated copy needs its bounding CIRCLE; an unrotated one only its box,
    // which is what makes the common case a single fetch.
    bool spun = (u_ar_rot != 0.0) || (u_ar_spin != 0.0) || (u_mid != 0.0);
    vec2 ext = spun ? vec2(0.5 * maxS * length(vec2(aspect, 1.0)))
                    : 0.5 * maxS * vec2(aspect, 1.0);
    ext += 0.5 * jit * cell;
    ivec2 nb = ivec2(clamp(ceil(ext / max(pitch, vec2(1e-4)) - 0.5),
                           vec2(0.0), vec2(float(AR_NB))));

    // Index rises with iy then ix, so descending dy then dx IS descending copy
    // order — no sorting needed for the front-to-back walk.
    for (int sy = 0; sy <= 2 * AR_NB; sy++) {
      if (done) break;
      int dy = desc ? (AR_NB - sy) : (sy - AR_NB);
      if (dy < -nb.y || dy > nb.y) continue;
      int iy = c0.y + dy;
      if (iy < 0 || iy >= rows) continue;
      for (int sx = 0; sx <= 2 * AR_NB; sx++) {
        int dx = desc ? (AR_NB - sx) : (sx - AR_NB);
        if (dx < -nb.x || dx > nb.x) continue;
        int ix = c0.x + dx;
        if (ix < 0 || ix >= cols) continue;

        float k = float(iy * cols + ix);
        vec2 pos = (vec2(float(ix), float(iy)) - 0.5 * vec2(float(cols - 1), float(rows - 1)))
                 * pitch * vec2(1.0, -1.0);
        pos += (vec2(arHash(vec2(k, u_ar_seed + 1.0)),
                     arHash(vec2(k, u_ar_seed + 7.0))) - 0.5) * jit * cell;

        float scl = baseS * clamp(pow(st, k), 1e-4, 64.0)
                  * (1.0 + (arHash(vec2(k, u_ar_seed + 13.0)) - 0.5) * u_ar_jit_size);
        float op = pow(fade, k)
                 * (ix == cols - 1 ? tailC : 1.0)
                 * (iy == rows - 1 ? tailR : 1.0);

        vec2 flip = vec2(1.0);
        if (u_ar_mirror == 1 || u_ar_mirror == 3) flip.x = mod(float(ix), 2.0) < 0.5 ? 1.0 : -1.0;
        if (u_ar_mirror == 2 || u_ar_mirror == 3) flip.y = mod(float(iy), 2.0) < 0.5 ? 1.0 : -1.0;

        if (arAccum(acc, q, pos, scl, rotB + spin * k, op, u_ar_hue * k, flip, pivot, aspect)) {
          done = true;
          break;
        }
      }
    }
  } else {
    // ── CHAIN / RADIAL / Keep-Original GRID — bounded loop, front to back,
    //    early out. Positions are built relative to COPY 0, so under Keep
    //    Original index 0 has displacement exactly zero.
    int n = clamp(cols * rows, 1, AR_MAX_I);
    vec2 zc = st * vec2(cos(spin), sin(spin));
    vec2 den = vec2(1.0, 0.0) - zc;
    bool degen = dot(den, den) < 1e-6;
    vec2 chStep = keep ? off : vec2(pitch.x, 0.0);
    // Centered grows the chain from the array centre; Keep Original grows it
    // from the original, which is the whole point of the anchor.
    vec2 mid = keep ? vec2(0.0) : 0.5 * arChain(float(n - 1), chStep, st, spin, degen, den);
    bool full = u_ar_arc >= 359.5;
    float arcR = u_ar_arc * AR_D2R;
    // Ring seat of copy 0, subtracted under Keep Original so the ring hangs off
    // the original instead of sliding it onto the ring.
    vec2 ring0 = keep ? vec2(max(u_ar_radius, 0.0), 0.0) : vec2(0.0);

    for (int i = 0; i < AR_MAX_I; i++) {
      if (i >= n || done) break;
      int idx = desc ? (n - 1 - i) : i;
      float k = float(idx);

      vec2 pos;
      float faceRot = 0.0;
      float tail = 1.0;
      if (mode == 0) {
        int iy = idx / cols;
        int ix = idx - iy * cols;
        pos = vec2(float(ix) * off.x, float(iy) * off.y);
        tail = (ix == cols - 1 ? tailC : 1.0) * (iy == rows - 1 ? tailR : 1.0);
      } else if (mode == 1) {
        pos = arChain(k, chStep, st, spin, degen, den) - mid;
        tail = (idx == n - 1) ? tailC : 1.0;
      } else {
        // Radius / Turn is the radius gained per FULL turn, so a 360 arc with
        // Rings > 1 is one continuous spiral while a partial arc is a fan
        // repeated per ring.
        int ring = idx / cols;
        int j = idx - ring * cols;
        float dn = full ? float(cols) : max(float(cols - 1), 1.0);
        float turn = float(ring) + float(j) / float(cols);
        float a = full ? arcR * turn : arcR * (float(j) / dn);
        float rad = max(u_ar_radius + u_ar_radius_step * turn, 0.0);
        pos = rad * vec2(cos(a), sin(a)) - ring0;
        faceRot = u_ar_orient ? a : 0.0;
        tail = (j == cols - 1 ? tailC : 1.0) * (ring == rows - 1 ? tailR : 1.0);
      }
      // Array Angle turns the LAYOUT, not the original — dRot is the identity
      // under Centered, where the query was rotated instead.
      pos = dRot * pos;

      // Both jitters are LAYOUT, so under Keep Original they skip copy 0: a
      // scattered original is exactly the thing that anchor exists to prevent.
      // Bass Size / Beat Punch deliberately still reach it — those modulate the
      // whole array on purpose, and one static copy among pulsing ones reads as
      // a bug rather than as an anchor.
      float jg = (keep && idx == 0) ? 0.0 : 1.0;
      pos += (vec2(arHash(vec2(k, u_ar_seed + 1.0)),
                   arHash(vec2(k, u_ar_seed + 7.0))) - 0.5) * jit * jg * cell;

      float scl = baseS * clamp(pow(st, k), 1e-4, 64.0)
                * (1.0 + (arHash(vec2(k, u_ar_seed + 13.0)) - 0.5) * u_ar_jit_size * jg);
      float op = pow(fade, k) * tail;

      vec2 flip = vec2(1.0);
      float par = mod(k, 2.0) < 0.5 ? 1.0 : -1.0;
      if (u_ar_mirror == 1 || u_ar_mirror == 3) flip.x = par;
      if (u_ar_mirror == 2 || u_ar_mirror == 3) flip.y = par;

      if (arAccum(acc, q, pos, scl, rotB + spin * k + faceRot, op, u_ar_hue * k, flip, pivot, aspect)) {
        done = true;
      }
    }
  }

  // The untouched frame underneath, so the copies can fly over the shot they
  // came from. Composited UNDER in premultiplied space, like everything else.
  vec4 src = textureLod(u_texture, v_uv, 0.0);
  vec4 bg = vec4(src.rgb * src.a, src.a) * clamp(u_ar_orig, 0.0, 1.0);
  acc += (1.0 - clamp(acc.a, 0.0, 1.0)) * bg;

  // Back to STRAIGHT — the pipeline's convention everywhere outside a gather.
  float oa = clamp(acc.a, 0.0, 1.0);
  fragColor = oa > 0.0001 ? vec4(clamp(acc.rgb / oa, 0.0, 1.0), oa) : vec4(0.0);
}
`)

// ── Video Input (passthrough — texture uploaded externally by Renderer) ──
registerShader('VIDEO_INPUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
out vec4 fragColor;
void main() {
  fragColor = texture(u_texture, v_uv);
}
`)

// ── Image Input (still image source) ─────────────────────────────────────────
// The image texture is bound to u_image (unit 0) by the Renderer's image pass.
// This shader fits/transforms the image to the canvas and adds optional, always-
// live audio reactivity (no wiring needed) via the standard u_audio_bands/u_beat
// uniforms. Downstream effect nodes provide the rest of the reactivity.
registerShader('IMAGE_INPUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_image;        // loaded image, bound by the renderer
uniform vec2 u_resolution;        // output canvas size
uniform vec2 u_image_res;         // natural image size (px)
uniform float u_audio_bands[8];   // always-live FFT bands
uniform float u_beat;             // always-live beat trigger
// @param name="Fit" min=0 max=3 default=0 step=1 type=select options="Cover,Contain,Stretch,Tile"
uniform int u_fit;
// @param name="Scale" min=0.1 max=4.0 default=1.0 step=0.01
uniform float u_img_scale;
// @param name="Offset X" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_offset_x;
// @param name="Offset Y" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_offset_y;
// @param name="Rotation" min=-3.1416 max=3.1416 default=0.0 step=0.01
uniform float u_img_rot;
// @param name="Bass Zoom" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bass_zoom;
// @param name="Beat Punch" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_beat_punch;
// @param name="Background" type=color default="#000000"
uniform vec3 u_bg_color;
out vec4 fragColor;

// The image is uploaded PREMULTIPLIED (Renderer.renderImageNode), because every
// fetch here is a FILTERED one — a weighted sum of texels — and a weighted sum
// of RGBA only means anything once colour carries its own coverage. Fit, Scale
// and Tile all resample, so a straight-alpha texture lost intensity along every
// soft edge: averaging opaque white with a transparent texel gave half-grey at
// half alpha instead of white at half alpha, which reads as a dark fringe and,
// on a hard-edged cutout, as stair-stepping. Undone here so the rest of the
// pipeline still sees its straight-alpha convention. An opaque image divides by
// 1.0 and is bit-identical, which covers every JPEG and most PNGs.
vec4 imgSample(vec2 uv) {
  vec4 t = texture(u_image, uv);
  return t.a > 0.0001 ? vec4(t.rgb / t.a, t.a) : vec4(0.0);
}

void main() {
  vec2 c = v_uv - 0.5;

  // Aspect-preserving fit (Cover crops, Contain letterboxes).
  float canvasAspect = u_resolution.x / max(u_resolution.y, 1.0);
  float imgAspect = u_image_res.x / max(u_image_res.y, 1.0);
  vec2 fitScale = vec2(1.0);
  if (u_fit == 0) {            // Cover
    if (canvasAspect > imgAspect) fitScale = vec2(1.0, imgAspect / canvasAspect);
    else                          fitScale = vec2(canvasAspect / imgAspect, 1.0);
  } else if (u_fit == 1) {    // Contain
    if (canvasAspect > imgAspect) fitScale = vec2(canvasAspect / imgAspect, 1.0);
    else                          fitScale = vec2(1.0, imgAspect / canvasAspect);
  } // Stretch (2) and Tile (3) leave fitScale at 1.0

  // Always-live reactive zoom: bass swells, beat punches.
  float bass = u_audio_bands[1];
  float zoom = u_img_scale * (1.0 + bass * u_bass_zoom * 1.5 + u_beat * u_beat_punch * 0.5);
  c /= max(zoom, 0.001);

  // Rotation
  float ca = cos(u_img_rot), sa = sin(u_img_rot);
  c = mat2(ca, -sa, sa, ca) * c;

  c *= fitScale;
  c += vec2(u_offset_x, u_offset_y) * 0.5;
  vec2 suv = c + 0.5;

  if (u_fit == 3) {                       // Tile: wrap
    fragColor = imgSample(fract(suv));
  } else if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
    fragColor = vec4(u_bg_color, 1.0);    // outside image → background (opaque by design)
  } else {
    fragColor = imgSample(suv);
  }
}
`)

// ── Text Input ──
// The rasterized text canvas is bound to u_image (unit 0) by the Renderer's text
// pass (see renderTextNode). This shader places/scales/rotates that raster on the
// canvas and adds always-live audio reactivity (bass swell + beat punch) with no
// wiring. Everything outside the (transformed) raster stays transparent so the
// text composites cleanly over lower layers. Peer to the IMAGE_INPUT shader.
registerShader('TEXT_INPUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_image;        // rasterized text (RGBA), bound by the renderer
uniform vec2 u_resolution;        // output canvas size
uniform float u_audio_bands[8];   // always-live FFT bands
uniform float u_beat;             // always-live beat trigger
// @param name="Scale" min=0.1 max=4.0 default=1.0 step=0.01
uniform float u_txt_scale;
// @param name="Offset X" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_offset_x;
// @param name="Offset Y" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_offset_y;
// @param name="Rotation" min=-3.1416 max=3.1416 default=0.0 step=0.01
uniform float u_txt_rot;
// @param name="Bass Zoom" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bass_zoom;
// @param name="Beat Punch" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_beat_punch;
out vec4 fragColor;

void main() {
  vec2 c = v_uv - 0.5;

  // Aspect-correct so rotation doesn't shear a non-square canvas.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  c.x *= aspect;

  // Always-live reactive zoom: bass swells, beat punches.
  float bass = u_audio_bands[1];
  float zoom = u_txt_scale * (1.0 + bass * u_bass_zoom * 1.5 + u_beat * u_beat_punch * 0.5);
  c /= max(zoom, 0.001);

  float ca = cos(u_txt_rot), sa = sin(u_txt_rot);
  c = mat2(ca, -sa, sa, ca) * c;

  c.x /= aspect;
  c += vec2(u_offset_x, -u_offset_y) * 0.5;
  vec2 suv = c + 0.5;

  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
    fragColor = vec4(0.0);        // transparent outside the raster
  } else {
    // u_image is uploaded PREMULTIPLIED (Renderer.renderTextNode), because this
    // single tap is what resolves the 2x supersampled raster and a filtered sum
    // of RGBA is only valid when colour carries its own coverage. Undo it here
    // so the rest of the pipeline sees the straight alpha it expects — the
    // epsilon and the transparent-black fallback match PRESENT_FS.
    vec4 t = texture(u_image, suv);
    fragColor = t.a > 0.0001 ? vec4(t.rgb / t.a, t.a) : vec4(0.0);
  }
}
`)

// ── Shape Input (procedural SDF shape source) ────────────────────────────────
// A first-class vector-shape source, peer to image/text: no texture upload, the
// whole shape is evaluated on the GPU from signed distance fields, so it is
// resolution-independent and free to animate. Everything outside the shape (and
// its background) stays transparent, so a shape composites cleanly over lower
// layers or feeds any downstream effect / mask input.
//
// Coordinate convention (shared with the Preview's on-canvas handles):
//   • Frame units — y ∈ [-0.5, 0.5], x scaled by aspect, so 1.0 unit == the
//     frame HEIGHT on both axes (a square with width == height is square).
//   • v_uv.y is UP, so Position Y +1 is the top edge.
//   • Rotation is counter-clockwise-positive on screen.
registerShader('SHAPE_INPUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_resolution;        // output canvas size
uniform float u_time;             // seconds (frame-locked during export)
uniform float u_audio_bands[8];   // always-live FFT bands
uniform float u_beat;             // always-live beat trigger
// @param name="Shape" min=0 max=7 default=0 step=1 type=select options="Rectangle,Ellipse,Triangle,Polygon,Star,Ring,Capsule,Cross"
uniform int u_shp_type;
// @param name="Width" min=0.0 max=4.0 default=0.6 step=0.01
uniform float u_shp_w;
// @param name="Height" min=0.0 max=4.0 default=0.6 step=0.01
uniform float u_shp_h;
// @param name="Position X" min=-1.5 max=1.5 default=0.0 step=0.005
uniform float u_shp_x;
// @param name="Position Y" min=-1.5 max=1.5 default=0.0 step=0.005
uniform float u_shp_y;
// @param name="Rotation" min=-3.1416 max=3.1416 default=0.0 step=0.01
uniform float u_shp_rot;
// @param name="Corner Radius" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_shp_corner;
// @param name="Sides / Points" min=3 max=16 default=5 step=1
uniform int u_shp_sides;
// @param name="Inner Ratio" min=0.05 max=1.0 default=0.45 step=0.01
uniform float u_shp_inner;
// @param name="Thickness" min=0.002 max=1.0 default=0.12 step=0.002
uniform float u_shp_thick;
// @param name="Feather" min=0.0 max=0.5 default=0.0 step=0.002
uniform float u_shp_feather;
// @param name="Fill Color" type=color default="#ff2266"
uniform vec3 u_shp_fill;
// @param name="Fill Opacity" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_shp_fill_a;
// @param name="Stroke Width" min=0.0 max=0.5 default=0.0 step=0.002
uniform float u_shp_stroke;
// @param name="Stroke Color" type=color default="#ffffff"
uniform vec3 u_shp_stroke_col;
// @param name="Background" type=color default="#000000"
uniform vec3 u_shp_bg;
// @param name="Background Opacity" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_shp_bg_a;
// @param name="Spin Speed" min=-2.0 max=2.0 default=0.0 step=0.01
uniform float u_shp_spin;
// @param name="Bass Scale" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bass_scale;
// @param name="Beat Punch" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_beat_punch;
out vec4 fragColor;

// Rounded box (exact).
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}
// Regular n-gon (exact for convex polygons): fold the angle into one segment,
// then project onto that edge's normal.
float sdNgon(vec2 p, float r, float n) {
  float seg = 6.2831853 / n;
  float a = atan(p.x, p.y);
  a = mod(a + seg * 0.5, seg) - seg * 0.5;
  return length(p) * cos(a) - r * cos(seg * 0.5);
}
// n-pointed star — radial blend between the outer radius and inner*outer. Not a
// euclidean SDF, but monotonic across the edge, which is all the feather needs.
float sdStar(vec2 p, float r, float n, float inner) {
  float seg = 6.2831853 / n;
  float a = atan(p.x, p.y);
  float t = abs(mod(a + seg * 0.5, seg) - seg * 0.5) / (seg * 0.5); // 0 at tip
  return length(p) - r * mix(1.0, max(inner, 0.02), t);
}
// Capsule along X: a bar with round caps (thickness = b.y).
float sdCapsule(vec2 p, vec2 b) {
  float hx = max(b.x - b.y, 0.0);
  return length(vec2(max(abs(p.x) - hx, 0.0), p.y)) - b.y;
}
// Non-premultiplied "source over destination" (the pipeline is straight alpha).
vec4 shapeOver(vec4 s, vec4 d) {
  float a = s.a + d.a * (1.0 - s.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / a, a);
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 p = vec2((v_uv.x - 0.5) * aspect, v_uv.y - 0.5);
  vec2 q = p - vec2(u_shp_x * 0.5 * aspect, u_shp_y * 0.5);

  // Rotation (+ constant spin). mat2 is column-major, so this is R(-ang) applied
  // to the query point == the shape rotating CCW by ang on screen.
  float ang = u_shp_rot + u_shp_spin * u_time;
  float ca = cos(ang), sa = sin(ang);
  q = mat2(ca, -sa, sa, ca) * q;

  // Always-live reactivity: bass swells the shape, beat punches it.
  float bass = u_audio_bands[1];
  float grow = 1.0 + bass * u_bass_scale * 1.5 + u_beat * u_beat_punch * 0.5;
  vec2 he = max(vec2(u_shp_w, u_shp_h) * 0.5 * grow, vec2(0.0));
  vec2 e = max(he, vec2(0.0001));
  float m = min(e.x, e.y);   // scale factor back to frame units
  vec2 n = q / e;            // unit space (radial shapes are authored there)
  float sides = float(u_shp_sides);

  float d;
  if (u_shp_type == 1) {                    // Ellipse
    d = (length(n) - 1.0) * m;
  } else if (u_shp_type == 2) {             // Triangle
    d = sdNgon(n, 1.0, 3.0) * m;
  } else if (u_shp_type == 3) {             // Polygon
    d = sdNgon(n, 1.0, sides) * m;
  } else if (u_shp_type == 4) {             // Star
    d = sdStar(n, 1.0, sides, u_shp_inner) * m;
  } else if (u_shp_type == 5) {             // Ring
    d = abs(length(n) - 1.0) * m - u_shp_thick * 0.5;
  } else if (u_shp_type == 6) {             // Capsule / bar
    d = sdCapsule(q, vec2(e.x, min(e.y, e.x)));
  } else if (u_shp_type == 7) {             // Cross (arm width = Inner Ratio)
    float arm = clamp(u_shp_inner, 0.02, 1.0);
    float r = min(u_shp_corner * 0.5, m * arm);
    d = min(sdBox(q, vec2(e.x, e.y * arm), r), sdBox(q, vec2(e.x * arm, e.y), r));
  } else {                                  // Rectangle (rounded)
    d = sdBox(q, he, min(u_shp_corner * 0.5, m));
  }

  // Feather, floored at ~1px so edges are always anti-aliased (1 frame unit ==
  // u_resolution.y pixels).
  float aa = max(u_shp_feather * 0.5, 0.75 / max(u_resolution.y, 1.0));
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float stroke = u_shp_stroke > 0.0
    ? 1.0 - smoothstep(-aa, aa, abs(d) - u_shp_stroke * 0.5)
    : 0.0;

  vec4 col = vec4(u_shp_bg, u_shp_bg_a);
  col = shapeOver(vec4(u_shp_fill, u_shp_fill_a * fill), col);
  col = shapeOver(vec4(u_shp_stroke_col, stroke), col);
  fragColor = col;
}
`)

// ── Camera Input (passthrough — camera texture uploaded externally) ──
registerShader('CAMERA_INPUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Mirror X" type=bool default=false
uniform bool u_mirror_x;
// @param name="Mirror Y" type=bool default=false
uniform bool u_mirror_y;
out vec4 fragColor;
void main() {
  vec2 uv = v_uv;
  if (u_mirror_x) uv.x = 1.0 - uv.x;
  if (u_mirror_y) uv.y = 1.0 - uv.y;
  fragColor = texture(u_texture, uv);
}
`)

// ── Screen Input (passthrough — composited frame, like camera) ──
registerShader('SCREEN_INPUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Mirror X" type=bool default=false
uniform bool u_mirror_x;
// @param name="Mirror Y" type=bool default=false
uniform bool u_mirror_y;
out vec4 fragColor;
void main() {
  vec2 uv = v_uv;
  if (u_mirror_x) uv.x = 1.0 - uv.x;
  if (u_mirror_y) uv.y = 1.0 - uv.y;
  fragColor = texture(u_texture, uv);
}
`)

// ── Output (final passthrough to screen / export) ──
registerShader('OUTPUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Gain" min=0.0 max=2.0 default=1.0 step=0.01
uniform float u_gain;
// @param name="Dither" type=bool default=false
uniform bool u_dither;
out vec4 fragColor;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 col = texture(u_texture, v_uv) * u_gain;
  if (u_dither) {
    col.rgb += (rand(v_uv + col.rg) - 0.5) / 255.0;
  }
  fragColor = clamp(col, 0.0, 1.0);
}
`)

// ── Audio Visualizer ──
// Rewritten to draw from the HIGH-RESOLUTION audio textures (gl/audioTexture.js)
// instead of the 8-value u_audio_bands array. That single change is what the
// modes below are built on: 512 log-spaced spectrum samples, the real waveform,
// a peak-hold row, and 128 frames of spectrum HISTORY — so time-axis modes
// (Waterfall, Tunnel, Terrain) exist at all, and bars stop looking like a
// 90s equaliser. u_prev_frame is declared, which is what makes the executor
// give this node a ping-pong pair, i.e. the trails.
//
// Legacy uniform names are kept wherever the meaning survived (u_mode,
// u_opacity, u_color_hue, u_saturation, u_scale, u_glow, u_trail, u_decay,
// u_bg_dim, u_smooth, u_thickness, u_mirror_x/y, u_rot_speed, u_bass_impact,
// u_beat_flash), so a saved project keeps its settings across the upgrade.
registerShader('AUDIO_VISUALIZER', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;

// ── High-resolution audio (gl/audioTexture.js) ──────────────────────────────
// u_audio_tex is 512 x 4: row 0 = LOG spectrum (20 Hz -> 20 kHz), row 1 = linear
// spectrum, row 2 = waveform (0.5 = silence, zero-crossing triggered), row 3 =
// peak hold. u_audio_hist is a 512 x 128 ring buffer of row 0 — one row per
// rendered frame — which is what makes waterfalls, tunnels and terrain possible
// at all: they are pictures of the last ~2 seconds, not of this instant.
uniform sampler2D u_audio_tex;
uniform sampler2D u_audio_hist;
uniform float u_audio_head;   // newest row in the ring
uniform float u_audio_rows;   // ring size (128)
uniform float u_audio_rms;
uniform float u_beat;
// Feedback buffer — declaring it is what makes the executor hand this node a
// ping-pong FBO pair, which is where the trails come from.
uniform sampler2D u_prev_frame;

// ── Core ────────────────────────────────────────────────────────────────────
// @param name="Mode" min=0 max=9 default=0 step=1 type=select options="Bars,Radial,Scope,Waterfall,Tunnel,Nebula,Rings,Terrain,Particles,Prism"
uniform int u_mode;
// @param name="Composite" min=0 max=3 default=1 step=1 type=select options="Over,Add,Screen,Solo"
uniform int u_style;
// @param name="Opacity" min=0.0 max=1.0 default=0.95 step=0.01
uniform float u_opacity;
// @param name="Intensity" min=0.0 max=3.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Background Dim" min=0.0 max=1.0 default=0.25 step=0.01
uniform float u_bg_dim;
// The perf dial. A visualiser is fill-rate bound — every mode costs the same
// per PIXEL — so rendering at half resolution is close to a 4x saving, and on
// glow-heavy generative content it is very hard to see. The executor allocates
// this node's buffers at the matching size (nodeFBOScale in clipGraphManager).
// @param name="Render Scale" min=0 max=2 default=0 step=1 type=select options="Full,Half,Quarter"
uniform int u_render_scale;

// ── Colour ──────────────────────────────────────────────────────────────────
// @param name="Palette" min=0 max=9 default=1 step=1 type=select options="Custom,Spectrum,Inferno,Viridis,Magma,Ice,Neon,Sunset,Mono,Fire"
uniform int u_palette;
// @showif u_palette == Custom
// @param name="Colour A" type=color default=#00e5ff
uniform vec3 u_color_a;
// @showif u_palette == Custom
// @param name="Colour B" type=color default=#ff00aa
uniform vec3 u_color_b;
// @showif u_palette == Custom
// @param name="Colour C" type=color default=#ffe66d
uniform vec3 u_color_c;
// @param name="Hue Shift" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_color_hue;
// @param name="Saturation" min=0.0 max=2.0 default=1.0 step=0.01
uniform float u_saturation;
// @param name="Glow" min=0.0 max=3.0 default=0.8 step=0.05
uniform float u_glow;

// ── Reactivity ──────────────────────────────────────────────────────────────
// @param name="Audio Gain" min=0.1 max=4.0 default=1.3 step=0.05
uniform float u_react_gain;
// @param name="Bass Impact" min=0.0 max=3.0 default=1.0 step=0.05
uniform float u_bass_impact;
// @param name="Beat Punch" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_beat_flash;

// ── Layout ──────────────────────────────────────────────────────────────────
// @param name="Scale" min=0.1 max=4.0 default=1.0 step=0.01
uniform float u_scale;
// @param name="Trails" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_trail;

// ── Per-mode controls (hidden unless their mode is selected) ────────────────
// @showif u_mode == Bars,Radial,Rings,Terrain,Particles
// @param name="Count" min=3 max=256 default=64 step=1
uniform int u_count;
// @showif u_mode == Bars,Radial
// @param name="Gap" min=0.0 max=0.95 default=0.3 step=0.01
uniform float u_gap;
// @showif u_mode == Bars
// @param name="Align" min=0 max=2 default=0 step=1 type=select options="Bottom,Centre,Top"
uniform int u_align;
// @showif u_mode == Bars,Radial
// @param name="Peak Caps" min=0 max=1 default=1 step=1 type=checkbox
uniform int u_peak_hold;
// @showif u_mode == Bars
// @param name="Reflection" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_reflect;
// @showif u_mode == Radial,Tunnel,Terrain,Prism,Scope
// @param name="Inner Radius / Horizon" min=0.0 max=0.9 default=0.25 step=0.01
uniform float u_inner;
// @showif u_mode == Scope
// @param name="Scope Style" min=0 max=3 default=0 step=1 type=select options="Line,Dual,Ring,Filled"
uniform int u_wave_mode;
// @showif u_mode == Scope
// @param name="Wave Amount" min=0.0 max=2.0 default=0.8 step=0.01
uniform float u_wave_amp;
// @showif u_mode == Scope,Rings,Particles,Prism
// @param name="Thickness" min=0.001 max=0.2 default=0.02 step=0.001
uniform float u_thickness;
// @showif u_mode == Waterfall,Tunnel,Terrain
// @param name="Time Span" min=0.05 max=2.0 default=1.0 step=0.01
uniform float u_depth;
// @showif u_mode == Waterfall
// @param name="Direction" min=0 max=3 default=0 step=1 type=select options="Up,Down,Left,Right"
uniform int u_dir;
// @showif u_mode == Tunnel,Nebula,Particles,Prism
// @param name="Warp" min=-2.0 max=2.0 default=0.5 step=0.01
uniform float u_warp;
// @showif u_mode == Tunnel,Nebula,Rings,Terrain,Particles
// @param name="Flow Speed" min=-3.0 max=3.0 default=0.5 step=0.01
uniform float u_flow;
// @showif u_mode == Nebula
// @param name="Detail" min=1 max=6 default=4 step=1
uniform int u_detail;

// ── Advanced ────────────────────────────────────────────────────────────────
// @param name="Advanced Controls" min=0 max=1 default=0 step=1 type=checkbox
uniform int u_advanced;
// @showif u_advanced == true
// @param name="Noise Gate" min=0.0 max=0.5 default=0.02 step=0.005
uniform float u_floor;
// @showif u_advanced == true
// @param name="Response Curve" min=0.3 max=3.0 default=1.0 step=0.05
uniform float u_curve;
// @showif u_advanced == true
// @param name="Spectral Smoothing" min=0.0 max=1.0 default=0.25 step=0.01
uniform float u_smooth;
// @showif u_advanced == true
// @param name="Freq Range Low" min=0.0 max=0.9 default=0.0 step=0.01
uniform float u_freq_lo;
// @showif u_advanced == true
// @param name="Freq Range High" min=0.1 max=1.0 default=0.95 step=0.01
uniform float u_freq_hi;
// @showif u_advanced == true
// @param name="Colour Spread" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_grad;
// @showif u_advanced == true
// @param name="Position X" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_pos_x;
// @showif u_advanced == true
// @param name="Position Y" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_pos_y;
// @showif u_advanced == true
// @param name="Rotation" min=-180.0 max=180.0 default=0.0 step=1.0
uniform float u_rotation;
// @showif u_advanced == true
// @param name="Rotation Speed" min=-5.0 max=5.0 default=0.0 step=0.05
uniform float u_rot_speed;
// @showif u_advanced == true
// @param name="Mirror X" min=0 max=1 default=0 step=1 type=checkbox
uniform int u_mirror_x;
// @showif u_advanced == true
// @param name="Mirror Y" min=0 max=1 default=0 step=1 type=checkbox
uniform int u_mirror_y;
// @showif u_advanced == true
// @param name="Kaleidoscope" min=1 max=16 default=1 step=1
uniform int u_symmetry;
// @showif u_advanced == true
// @param name="Trail Decay" min=0.0 max=0.999 default=0.94 step=0.001
uniform float u_decay;
// @showif u_advanced == true
// @param name="Trail Zoom" min=-0.06 max=0.06 default=0.0 step=0.001
uniform float u_trail_zoom;
// @showif u_advanced == true
// @param name="Trail Spin" min=-0.1 max=0.1 default=0.0 step=0.001
uniform float u_trail_spin;
// @showif u_advanced == true
// @param name="Vignette" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_vignette;

out vec4 fragColor;

#define TAU 6.28318530718

// ─── small utilities ────────────────────────────────────────────────────────
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
// Sin-free hashes (Dave Hoskins). The classic fract(sin(...)) form costs a
// transcendental per call, and the noise/particle modes call it dozens of times
// per pixel — this is ~6 ALU ops instead, with better distribution.
float hash11(float n) {
  float p = fract(n * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Fixed inter-octave rotation, precomputed: rot2(0.5) inside the loop made the
// compiler emit a cos/sin per octave on some drivers.
const mat2 FBM_ROT = mat2(0.87758256, -0.47942554, 0.47942554, 0.87758256);
float fbm(vec2 p, int oct) {
  float v = 0.0, amp = 0.55;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    v += amp * vnoise(p);
    p = FBM_ROT * p * 2.03;
    amp *= 0.5;
  }
  return v;
}

// ─── palettes ───────────────────────────────────────────────────────────────
// Four-stop ramps rather than cosine approximations: the named palettes are
// recognisable precisely because of where their stops sit, and a ramp costs
// three mixes — nothing next to a texture fetch.
vec3 ramp4(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  vec3 r = mix(a, b, clamp(t, 0.0, 1.0));
  r = mix(r, c, clamp(t - 1.0, 0.0, 1.0));
  return mix(r, d, clamp(t - 2.0, 0.0, 1.0));
}
vec3 paletteRaw(float t) {
  if (u_palette == 0) return ramp4(t, u_color_a * 0.15, u_color_a, u_color_b, u_color_c);
  if (u_palette == 1) return 0.55 + 0.45 * cos(TAU * (fract(t) + vec3(0.0, 0.33, 0.67)));
  if (u_palette == 2) return ramp4(t, vec3(0.00, 0.00, 0.02), vec3(0.47, 0.11, 0.43), vec3(0.93, 0.41, 0.15), vec3(0.99, 1.00, 0.64));
  if (u_palette == 3) return ramp4(t, vec3(0.27, 0.00, 0.33), vec3(0.19, 0.41, 0.56), vec3(0.21, 0.72, 0.47), vec3(0.99, 0.91, 0.14));
  if (u_palette == 4) return ramp4(t, vec3(0.00, 0.00, 0.02), vec3(0.44, 0.13, 0.43), vec3(0.95, 0.38, 0.36), vec3(0.99, 0.99, 0.75));
  if (u_palette == 5) return ramp4(t, vec3(0.00, 0.03, 0.10), vec3(0.07, 0.31, 0.55), vec3(0.31, 0.76, 0.97), vec3(0.91, 0.98, 1.00));
  if (u_palette == 6) return ramp4(t, vec3(0.07, 0.00, 0.18), vec3(0.48, 0.18, 0.97), vec3(0.95, 0.03, 0.64), vec3(0.00, 0.96, 0.83));
  if (u_palette == 7) return ramp4(t, vec3(0.10, 0.04, 0.18), vec3(0.85, 0.31, 0.44), vec3(1.00, 0.62, 0.27), vec3(1.00, 0.91, 0.63));
  if (u_palette == 8) return ramp4(t, vec3(0.02), vec3(0.28), vec3(0.72), vec3(1.00));
  return ramp4(t, vec3(0.02, 0.00, 0.04), vec3(0.70, 0.13, 0.04), vec3(1.00, 0.54, 0.00), vec3(1.00, 0.95, 0.69));
}
vec3 pal(float t) {
  vec3 c = paletteRaw(t);
  if (u_color_hue > 0.001) {
    vec3 h = rgb2hsv(c);
    h.x = fract(h.x + u_color_hue);
    c = hsv2rgb(h);
  }
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return max(vec3(0.0), mix(vec3(l), c, u_saturation));
}

// ─── audio access ───────────────────────────────────────────────────────────
// Everything reads through these four so one set of dynamics controls (gate,
// gain, curve, frequency window, smoothing) applies identically to every mode.
// The wired Audio-Driver sockets are 0.0 until connected, so they ADD on top
// without changing the default look.
// Row centres in the 512x8 audio texture (see gl/audioTexture.js).
const float AR_LOG   = 0.0625;  // log spectrum
const float AR_WAVE  = 0.3125;  // waveform
const float AR_PEAK  = 0.4375;  // peak hold
const float AR_LOGS  = 0.5625;  // log spectrum, pre-blurred on the CPU
const float AR_PEAKS = 0.6875;  // peak hold, pre-blurred

// Set once in main() so the per-fetch dynamics stay branch-light: these depend
// only on uniforms, but a driver will not always hoist them out of a loop body.
float gInvFloor = 1.0;
bool gLinearCurve = true;

float dyn(float v) {
  v = max(0.0, v - u_floor) * gInvFloor;
  if (!gLinearCurve) v = pow(v, u_curve);
  return min(v * u_react_gain, 4.0);
}
float band(float t) {
  float fx = mix(u_freq_lo, u_freq_hi, clamp(t, 0.0, 1.0));
  float v = texture(u_audio_tex, vec2(fx, AR_LOG)).r;
  // Smoothing is a blend toward the pre-blurred row: ONE extra fetch, versus
  // the four-tap kernel this used to run on every single lookup.
  if (u_smooth > 0.001) v = mix(v, texture(u_audio_tex, vec2(fx, AR_LOGS)).r, u_smooth);
  return dyn(v);
}
float bandPeak(float t) {
  float fx = mix(u_freq_lo, u_freq_hi, clamp(t, 0.0, 1.0));
  float v = texture(u_audio_tex, vec2(fx, u_smooth > 0.001 ? AR_PEAKS : AR_PEAK)).r;
  return dyn(v);
}
float waveAt(float x) { return texture(u_audio_tex, vec2(fract(x), AR_WAVE)).r * 2.0 - 1.0; }
// age: 0 = this frame, 1 = the oldest frame still in the ring (~2 s at 60 fps).
float histAt(float t, float age) {
  float fx = mix(u_freq_lo, u_freq_hi, clamp(t, 0.0, 1.0));
  float rows = max(2.0, u_audio_rows);
  float row = mod(u_audio_head - clamp(age, 0.0, 1.0) * (rows - 1.0) + rows * 2.0, rows);
  return dyn(texture(u_audio_hist, vec2(fx, (row + 0.5) / rows)).r);
}

void main() {
  gInvFloor = 1.0 / max(1e-3, 1.0 - u_floor);
  gLinearCurve = abs(u_curve - 1.0) < 0.005;

  vec4 bg = texture(u_texture, v_uv);
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  // u_resolution is the canvas, but a scaled pass renders into a smaller buffer.
  // Deriving the real texel size here keeps edge antialiasing honest at Half /
  // Quarter instead of leaving every line a quarter of a pixel wide.
  float rscale = u_render_scale == 0 ? 1.0 : (u_render_scale == 1 ? 0.5 : 0.25);
  float px = 1.0 / max(1.0, u_resolution.y * rscale);

  // Wired Audio-Driver sockets (0.0 until connected) fold into the same energies
  // the spectrum drives, so a splitter can push a specific stem's bass into the
  // picture on top of whatever the master mix is doing.
  float drvLow = u_sub_bass + u_bass;
  float drvHi = u_high_mid + u_presence + u_treble;
  float punch = u_beat * u_beat_flash;
  float bassE = (band(0.06) + drvLow) * u_bass_impact;
  float energy = max(u_audio_rms, u_rms);

  // ── shared coordinate space ──
  // p: centred, square (y in -0.5..0.5), transformed. f: the same space back as
  // 0..1 frame coordinates, so bar/waterfall modes inherit every transform.
  vec2 p = v_uv - 0.5;
  p.x *= aspect;
  p -= vec2(u_pos_x * aspect, u_pos_y) * 0.5;
  p = rot2(radians(u_rotation) + u_time * u_rot_speed * 0.35) * p;
  p /= max(0.05, u_scale);
  if (u_symmetry > 1) {
    float seg = TAU / float(u_symmetry);
    float a = mod(atan(p.y, p.x) + TAU * 4.0, seg);
    a = abs(a - seg * 0.5);
    p = vec2(cos(a), sin(a)) * length(p);
  }
  if (u_mirror_x == 1) p.x = abs(p.x);
  if (u_mirror_y == 1) p.y = abs(p.y);
  vec2 f = vec2(p.x / aspect, p.y) + 0.5;

  vec3 col = vec3(0.0);
  float cov = 0.0;
  float glow = u_glow;

  // ──────────────────────────────────────────────── 0: BARS
  if (u_mode == 0) {
    float n = float(u_count);
    float cellF = f.x * n;
    float t = (floor(cellF) + 0.5) / n;
    float h = band(t) * (1.0 + punch * 0.5) * 0.8;
    float hw = (1.0 - u_gap) * 0.5;
    float aaX = px * n * 0.6;
    float bar = smoothstep(hw + aaX, hw - aaX, abs(fract(cellF) - 0.5));
    bar *= step(0.0, f.x) * step(f.x, 1.0);

    float base = u_align == 0 ? 0.06 : (u_align == 1 ? 0.5 : 0.94);
    float dir = u_align == 2 ? -1.0 : 1.0;
    float y = (f.y - base) * dir;
    float ay = u_align == 1 ? abs(y) : y;
    float hh = u_align == 1 ? h * 0.5 : h;

    float body = bar * step(0.0, ay) * smoothstep(hh + px, hh - px, ay);
    float norm = clamp(ay / max(hh, 1e-3), 0.0, 1.0);
    // ONE palette evaluation per pixel. The tip, the cap and the floor bloom are
    // all near-white variants of this colour, so deriving them with a mix is
    // both cheaper and more coherent than four independent pal() calls — and
    // pal() is the single most-executed function in the shader.
    vec3 c = pal(mix(t, norm, u_grad));
    vec3 hot = mix(c, vec3(1.0), 0.45);
    col += c * body * (0.75 + 0.55 * (1.0 - norm));
    cov = max(cov, body);

    // Tip glow: a bar's top edge is the part the eye tracks, so it gets its own
    // falloff rather than relying on a whole-frame bloom.
    if (glow > 0.001) {
      float tip = exp(-abs(ay - hh) * 90.0) * bar * glow;
      col += hot * tip * 0.9;
      cov = max(cov, tip * 0.5);
    }

    // Falling peak caps, straight off the peak-hold row of the audio texture.
    if (u_peak_hold == 1) {
      float pkv = bandPeak(t) * 0.8 * (u_align == 1 ? 0.5 : 1.0);
      float cap = smoothstep(px * 3.0, 0.0, abs(ay - pkv)) * bar * step(0.0, ay);
      col += mix(c, vec3(1.0), 0.55) * cap * 1.4;
      cov = max(cov, cap);
    }

    // Reflection below the baseline — the cheap trick that reads as "polished".
    if (u_reflect > 0.001 && u_align != 1) {
      float ry = -y;
      float rbody = bar * step(0.0, ry) * smoothstep(hh + px, hh - px, ry);
      float fade = u_reflect * (1.0 - clamp(ry / max(hh, 1e-3), 0.0, 1.0)) * 0.6;
      col += c * rbody * fade;
      cov = max(cov, rbody * fade);
    }

    // Floor bloom, pumped by bass.
    if (glow > 0.001) {
      float floorGlow = exp(-abs(f.y - base) * 26.0) * (0.15 + bassE * 0.35) * glow;
      col += hot * floorGlow;
      cov = max(cov, floorGlow * 0.6);
    }
  }

  // ──────────────────────────────────────────────── 1: RADIAL
  else if (u_mode == 1) {
    float r = length(p);
    float a = atan(p.y, p.x);
    float na = fract(a / TAU + 0.5);
    float n = float(u_count);
    float cellF = na * n;
    float t = (floor(cellF) + 0.5) / n;
    float h = band(t) * 0.55 * (1.0 + punch * 0.5);
    float r0 = max(0.04, u_inner);
    float rr = r - r0;

    float hw = (1.0 - u_gap) * 0.5;
    float aaA = px * n / max(0.05, TAU * r) * 0.6;
    float ang = smoothstep(hw + aaA, hw - aaA, abs(fract(cellF) - 0.5));
    float body = ang * step(0.0, rr) * smoothstep(h + px, h - px, rr);
    float norm = clamp(rr / max(h, 1e-3), 0.0, 1.0);
    // One palette evaluation, reused for the tip, cap, hub and waveform ring —
    // this mode ran pal() five times per pixel over the whole frame, with no
    // early-out anywhere, which made it the most expensive of the ten.
    vec3 c = pal(mix(t, norm, u_grad));
    vec3 hot = mix(c, vec3(1.0), 0.45);
    col += c * body * (0.8 + 0.5 * (1.0 - norm));
    cov = max(cov, body);

    if (glow > 0.001) {
      float tip = exp(-abs(rr - h) * 90.0) * ang * step(0.0, rr) * glow;
      col += hot * tip * 0.9;
      cov = max(cov, tip * 0.5);
    }

    if (u_peak_hold == 1) {
      float pkv = bandPeak(t) * 0.55;
      float cap = smoothstep(px * 3.0, 0.0, abs(rr - pkv)) * ang * step(0.0, rr);
      col += mix(c, vec3(1.0), 0.55) * cap * 1.4;
      cov = max(cov, cap);
    }

    // Inner ring + hub only exist near the centre, so gate the whole block on
    // radius: for most of the frame this skips a texture fetch and two exps.
    if (r < r0 * 1.35) {
      // The raw waveform wrapped around the hub — something continuous for the
      // eye to read against the discrete bars.
      float wr = r0 * (0.78 + 0.06 * waveAt(na) * (1.0 + energy * 2.0));
      float ring = smoothstep(u_thickness * 0.5 + px, 0.0, abs(r - wr));
      col += hot * ring * (0.8 + punch);
      cov = max(cov, ring);

      float hub = exp(-r * (9.0 / max(0.05, r0))) * (0.25 + punch * 1.2) * glow;
      col += c * hub;
      cov = max(cov, hub * 0.7);
    }
  }

  // ──────────────────────────────────────────────── 2: SCOPE
  else if (u_mode == 2) {
    float th = max(0.0015, u_thickness * 0.5);
    if (u_wave_mode == 2) {
      float na = fract(atan(p.y, p.x) / TAU + 0.5);
      float rr = max(0.04, u_inner) + waveAt(na) * u_wave_amp * 0.22;
      float d = abs(length(p) - rr);
      float core = smoothstep(th, th * 0.15, d);
      col += pal(mix(na, 0.8, u_grad)) * (core + th / (d + th) * glow * 0.5);
      cov = max(cov, core + th / (d + th) * 0.35);
    } else if (u_wave_mode == 3) {
      float w = waveAt(f.x) * u_wave_amp * 0.45;
      float y0 = 0.5 + w;
      float fill = step(min(0.5, y0), f.y) * step(f.y, max(0.5, y0));
      float d = abs(f.y - y0);
      col += pal(mix(f.x, 1.0 - abs(f.y - 0.5) * 2.0, u_grad)) * (fill * 0.55 + smoothstep(th, 0.0, d) * 1.2);
      cov = max(cov, fill * 0.8 + smoothstep(th, 0.0, d));
    } else {
      float w = waveAt(f.x);
      float d = abs(f.y - (0.5 + w * u_wave_amp * 0.45));
      float core = smoothstep(th, th * 0.15, d);
      float halo = th / (d + th);
      col += pal(mix(f.x, 0.85, u_grad)) * (core + halo * halo * glow * 0.8);
      cov = max(cov, core + halo * 0.4);
      if (u_wave_mode == 1) {
        // Dual: the spectrum envelope drawn as a second, slower trace. Two
        // curves reading the same sound at different time scales is what makes
        // a scope look alive instead of noisy.
        float e = band(f.x) * u_wave_amp * 0.4;
        float d2 = abs(f.y - (0.5 - e));
        float c2 = smoothstep(th, th * 0.2, d2);
        float h2 = th / (d2 + th);
        col += pal(mix(f.x + 0.4, 0.3, u_grad)) * (c2 + h2 * h2 * glow * 0.6);
        cov = max(cov, c2 + h2 * 0.3);
      }
    }
  }

  // ──────────────────────────────────────────────── 3: WATERFALL
  else if (u_mode == 3) {
    float fx, ft;
    if (u_dir == 0) { fx = f.x; ft = f.y; }
    else if (u_dir == 1) { fx = f.x; ft = 1.0 - f.y; }
    else if (u_dir == 2) { fx = f.y; ft = f.x; }
    else { fx = f.y; ft = 1.0 - f.x; }

    float inside = step(0.0, fx) * step(fx, 1.0) * step(0.0, ft) * step(ft, 1.0);
    float age = clamp(ft / max(0.05, u_depth), 0.0, 1.0);
    float v = histAt(fx, age);
    // Fade the oldest rows out: it hides the ring-buffer seam and it is what a
    // spectrogram should do anyway.
    float fade = (1.0 - smoothstep(0.75, 1.0, age)) * inside;
    vec3 c = pal(mix(v * 1.1, fx, u_grad));
    col += c * v * (0.9 + glow * v) * fade;
    cov = max(cov, clamp(v * 1.3, 0.0, 1.0) * fade);
  }

  // ──────────────────────────────────────────────── 4: TUNNEL
  else if (u_mode == 4) {
    float r = max(length(p), 1e-4);
    float r0 = max(0.03, u_inner * 0.5);
    float a = atan(p.y, p.x);
    // Twist grows toward the centre, so the corridor appears to spiral away.
    float na = fract(a / TAU + 0.5 + u_warp * 0.15 / max(r, 0.05) + u_time * u_flow * 0.02);
    float z = clamp((r - r0) / max(0.05, u_depth * 0.9), 0.0, 1.0);
    float age = pow(z, 0.65);
    float v = histAt(na, age);
    float fade = (1.0 - smoothstep(0.72, 1.0, age)) * smoothstep(r0 * 0.55, r0, r);
    vec3 c = pal(mix(v * 1.15, na, u_grad));
    col += c * v * (1.1 + glow * v * 1.4) * fade;
    cov = max(cov, clamp(v * 1.4, 0.0, 1.0) * fade);

    // Mouth of the tunnel — a bass-pumped ring that anchors the perspective.
    float mouth = exp(-abs(r - r0) * 40.0) * (0.35 + bassE * 0.8) * glow;
    col += pal(0.05) * mouth;
    cov = max(cov, mouth * 0.8);
  }

  // ──────────────────────────────────────────────── 5: NEBULA
  else if (u_mode == 5) {
    float mid = band(0.4);
    float hi = band(0.8) + drvHi;
    float tt = u_time * u_flow * 0.25;
    vec2 q = p * (2.2 - bassE * 0.5) + vec2(0.0, tt * 0.15);
    // Two rounds of domain warping. The audio drives the warp AMOUNT rather
    // than the colour, so the structure itself moves with the music instead of
    // a static cloud changing hue.
    vec2 w1 = vec2(fbm(q + tt, u_detail), fbm(q + vec2(5.2, 1.3) - tt, u_detail));
    // Second warp round only above Detail 3: it is four extra fbm evaluations
    // (the most expensive thing in the shader) and below that octave count the
    // structure it adds is not resolvable anyway. Detail is now a real
    // quality/speed dial rather than just an octave count.
    vec2 w2 = w1;
    if (u_detail > 3) {
      float k = u_warp + bassE * 0.35;
      w2 = vec2(fbm(q + k * w1 + vec2(1.7, 9.2), u_detail),
                fbm(q + k * w1 + vec2(8.3, 2.8) + tt * 0.5, u_detail));
    }
    float v = fbm(q + (u_warp + mid * 0.6) * w2, u_detail);
    float shape = pow(clamp(v, 0.0, 1.0), 1.6 - hi * 0.4);
    float fil = length(w2) * 0.5; // filament term — the bright veins
    vec3 c = pal(mix(shape * 1.4, fil, u_grad));
    col += c * (shape * 1.6 + pow(fil, 3.0) * glow * 2.0) * (0.6 + energy * 1.6 + punch);
    cov = max(cov, clamp(shape * 1.7 + pow(fil, 3.0), 0.0, 1.0));
  }

  // ──────────────────────────────────────────────── 6: RINGS
  else if (u_mode == 6) {
    float r = length(p);
    float na = fract(atan(p.y, p.x) / TAU + 0.5);
    int n = u_count;
    for (int i = 0; i < 24; i++) {
      if (i >= n) break;
      float fi = float(i);
      float phase = fract(u_time * u_flow * 0.18 + fi / float(max(n, 1)));
      float rr = phase * 0.95;
      // Cheap conservative reject FIRST. A ring is thin, so for most pixels most
      // rings contribute nothing — and this skips their two texture fetches
      // entirely. The bound is exact: dyn() clamps a band to 4, so the waveform
      // offset is at most 0.08 and the widest ring is u_thickness * 3.3.
      float d0 = abs(r - rr);
      if (d0 > 0.08 + u_thickness * 3.3) continue;
      float b = band(fract(fi * 0.137 + 0.05));
      // Ring thickness tracks its band, so loud bands read as fat bright rings.
      float w = max(0.002, u_thickness * (0.35 + b * 1.6)) * 0.5;
      float d = abs(r - rr - waveAt(na + fi * 0.1) * b * 0.02);
      float ring = smoothstep(w, w * 0.1, d) * (1.0 - phase);
      col += pal(mix(fi / float(max(n, 1)), b, u_grad)) * ring * (0.9 + b * 1.4);
      cov = max(cov, ring);
    }
    float core = exp(-r * 14.0) * (0.3 + punch * 1.5 + bassE * 0.5) * glow;
    col += pal(0.12) * core;
    cov = max(cov, core * 0.8);
  }

  // ──────────────────────────────────────────────── 7: TERRAIN
  else if (u_mode == 7) {
    // A perspective ground plane rather than a per-row loop: one history fetch
    // per pixel instead of dozens, so it runs at full res on a laptop GPU.
    float horizon = mix(0.35, 0.9, u_inner);
    float d = horizon - f.y;
    if (d > 0.0) {
      float z = 0.075 / max(1e-4, d);            // depth into the scene
      float xw = (f.x - 0.5) * z * 0.9;          // world x at that depth
      float age = clamp(z / max(0.1, u_depth * 8.0), 0.0, 1.0);
      float v = histAt(clamp(abs(xw), 0.0, 1.0), age);
      float onPlane = 1.0 - smoothstep(0.85, 1.05, abs(xw));
      float fog = (1.0 - smoothstep(0.55, 1.0, age)) * onPlane;

      float gz = fract(z * 1.6 - u_time * u_flow * 0.6);
      float gx = fract(xw * float(u_count) * 0.25 + 0.5);
      float lz = smoothstep(0.075, 0.0, min(gz, 1.0 - gz)) * clamp(d * 6.0, 0.0, 1.0);
      float lx = smoothstep(0.06, 0.0, min(gx, 1.0 - gx));
      float grid = max(lz, lx);
      vec3 c = pal(mix(v * 1.3, age, u_grad));
      col += c * (grid * (0.25 + v * 3.0) + v * v * 1.6 * glow) * fog;
      cov = max(cov, clamp(grid * 0.7 + v * v * 1.4, 0.0, 1.0) * fog);
    } else {
      // Sky: a soft bass-driven wash so the horizon has something to sit against.
      float sky = smoothstep(0.0, 0.45, -d) * (0.05 + bassE * 0.14);
      col += pal(0.02) * sky;
      cov = max(cov, sky);
      float sun = exp(-abs(-d) * 16.0) * (0.25 + punch) * glow;
      col += pal(0.75) * sun;
      cov = max(cov, sun * 0.7);
    }
  }

  // ──────────────────────────────────────────────── 8: PARTICLES
  else if (u_mode == 8) {
    // Cell-hashed particles: 9 neighbours per pixel, constant cost, and the
    // count slider changes DENSITY rather than a loop bound — which is why this
    // stays smooth where the old per-particle loop did not.
    float n = max(2.0, float(u_count) * 0.06);
    vec2 g = p * n;
    vec2 gi = floor(g), gf = fract(g);
    for (int yy = -1; yy <= 1; yy++) {
      for (int xx = -1; xx <= 1; xx++) {
        vec2 o = vec2(float(xx), float(yy));
        vec2 id = gi + o;
        vec2 h2 = hash22(id);
        float sp = u_time * u_flow * (0.35 + h2.y * 0.8);
        vec2 pos = 0.5 + 0.42 * vec2(sin(sp + h2.x * 40.0), cos(sp * 0.83 + h2.y * 31.0));
        // Swirl rides overall loudness rather than this particle's own band, so
        // the POSITION costs no texture fetch — which is what lets the distance
        // reject below run before we sample the spectrum. Eight of the nine
        // neighbouring cells are usually out of range.
        pos += u_warp * 0.25 * vec2(cos(sp * 1.7), sin(sp * 1.3)) * (0.3 + energy);
        float d = length(gf - o - pos);
        float maxSz = max(0.02, u_thickness * 12.6 * n * 0.8);
        if (d > maxSz * 3.0) continue;
        float b = band(fract(h2.x * 1.7 + h2.y * 0.3));
        float sz = max(0.02, u_thickness * (0.6 + b * 3.0) * n * 0.8);
        float dot_ = sz / (d + sz);
        float core = smoothstep(sz * 0.55, sz * 0.1, d);
        col += pal(mix(h2.x, b * 1.4, u_grad)) * (core * (0.8 + b * 2.0) + pow(dot_, 4.0) * glow);
        cov = max(cov, clamp(core + pow(dot_, 4.0) * 0.5, 0.0, 1.0));
      }
    }
  }

  // ──────────────────────────────────────────────── 9: PRISM
  else {
    // One radial spectrum sampled three times at slightly different angles —
    // the RGB channels physically separate, so the edges fringe like a real
    // prism instead of a hue gradient pretending to.
    float r = length(p);
    float na = fract(atan(p.y, p.x) / TAU + 0.5);
    float r0 = max(0.04, u_inner);
    float th = max(0.002, u_thickness);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float k = (float(i) - 1.0) * u_warp * 0.03;
      float t = fract(na + k + r * 0.35);
      float b = band(t);
      float rr = r0 + b * 0.42;
      float d = abs(r - rr);
      float line = th / (d + th);
      acc[i] = smoothstep(th, th * 0.2, d) + line * line * glow * 0.7;
    }
    vec3 tint = pal(mix(na, 0.7, u_grad));
    col += acc * mix(vec3(1.0), tint * 1.6, 0.75);
    cov = max(cov, clamp(dot(acc, vec3(0.4)), 0.0, 1.0));

    float hub = exp(-r * (7.0 / max(0.05, r0))) * (0.2 + punch * 1.4) * glow;
    col += tint * hub;
    cov = max(cov, hub * 0.7);
  }

  // ── vignette (on the visualiser layer only) ──
  if (u_vignette > 0.001) {
    float vg = 1.0 - u_vignette * smoothstep(0.25, 0.85, length(v_uv - 0.5) * 1.35);
    col *= vg;
    cov *= vg;
  }

  col *= u_intensity;
  cov = clamp(cov, 0.0, 1.0) * u_opacity;

  // ── trails ──
  // The feedback buffer holds this node's previous OUTPUT, which includes the
  // background. Subtracting the (warped) background back out recovers the
  // visualiser layer on its own, so a static backdrop leaves no smear and only
  // the graphics trail — the thing that always went wrong with naive feedback.
  if (u_trail > 0.001) {
    vec2 tuv = v_uv - 0.5;
    tuv = rot2(u_trail_spin) * tuv * (1.0 - u_trail_zoom) + 0.5;
    vec4 pv = texture(u_prev_frame, tuv);
    vec3 ghost = max(vec3(0.0), pv.rgb - texture(u_texture, tuv).rgb * u_bg_dim);
    ghost *= u_decay * u_trail;
    col = max(col, ghost);
    cov = max(cov, clamp(dot(ghost, vec3(0.5)), 0.0, 1.0));
  }

  // ── composite ──
  vec3 base = bg.rgb * u_bg_dim;
  vec3 outRgb;
  if (u_style == 0) outRgb = mix(base, col, cov);
  else if (u_style == 1) outRgb = base + col * cov;
  else if (u_style == 2) outRgb = 1.0 - (1.0 - clamp(base, 0.0, 1.0)) * (1.0 - clamp(col * cov, 0.0, 1.0));
  else outRgb = col * cov;

  // Coverage is the union of what arrived and what was drawn: forcing 1.0 here
  // would fill a transparent source's matte with the dimmed backdrop.
  float outA = (u_style == 3) ? cov : max(bg.a, cov);
  fragColor = vec4(clamp(outRgb, 0.0, 8.0), clamp(outA, 0.0, 1.0));
}
`)

// ── Pixel Sort ──
registerShader('PIXEL_SORT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
// @param name="Threshold Low" min=0.0 max=1.0 default=0.2 step=0.01
uniform float u_threshold_lo;
// @param name="Threshold High" min=0.0 max=1.0 default=0.8 step=0.01
uniform float u_threshold_hi;
// @param name="Direction" min=0 max=1 default=0 step=1 type=select options="Horizontal,Vertical"
uniform int u_direction;
// @param name="Intensity" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_intensity;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv;
  vec4 col = texture(u_texture, uv);
  float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));

  if (lum > u_threshold_lo && lum < u_threshold_hi) {
    vec2 offset = u_direction == 0 ? vec2(1.0/u_resolution.x, 0.0) : vec2(0.0, 1.0/u_resolution.y);
    // Audio driver (0 until wired): high-mid drives the sort displacement.
    float shift = sin(lum * 50.0 + u_time) * (u_intensity + u_high_mid * 0.5) * 0.05;
    vec2 sortedUV = uv + offset * shift * u_resolution;
    col = texture(u_texture, sortedUV);
  }
  fragColor = col;
}
`)

// ── Voronoi ──
registerShader('VORONOI', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
// @param name="Cell Count" min=2.0 max=32.0 default=8.0 step=1.0
uniform float u_cells;
// @param name="Edge Width" min=0.0 max=0.1 default=0.02 step=0.005
uniform float u_edge_width;
// @param name="Animate" type=bool default=true
uniform bool u_animate;
// @param name="Color Mode" min=0 max=1 default=0 step=1 type=select options="Sample,Distance"
uniform int u_color_mode;
out vec4 fragColor;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

void main() {
  vec2 uv = v_uv * u_cells;
  vec2 iuv = floor(uv);
  vec2 fuv = fract(uv);

  float minDist = 10.0;
  vec2 closestCell = vec2(0.0);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = hash2(iuv + neighbor);
      // Audio driver (0 until wired): presence jitters the cells.
      if (u_animate) point = 0.5 + 0.5 * sin(u_time * 0.5 + u_presence * 3.0 + 6.2831 * point);
      float d = length(neighbor + point - fuv);
      if (d < minDist) {
        minDist = d;
        closestCell = (iuv + neighbor + point) / u_cells;
      }
    }
  }

  float edge = smoothstep(u_edge_width, u_edge_width + 0.005, minDist);

  if (u_color_mode == 0) {
    fragColor = texture(u_texture, closestCell) * edge;
  } else {
    // Alpha follows the source, scaled by edge exactly like mode 0 above,
    // instead of being forced opaque — otherwise the cell pattern fills the
    // matte of a transparent source.
    fragColor = vec4(vec3(minDist * edge), texture(u_texture, v_uv).a * edge);
  }
}
`)

// ── Fluid Warp ──
registerShader('FLUID_WARP', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
// @param name="Strength" min=0.0 max=0.2 default=0.05 step=0.005
uniform float u_strength;
// @param name="Speed" min=0.1 max=5.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Scale" min=0.5 max=10.0 default=3.0 step=0.1
uniform float u_warp_scale;
// @param name="Octaves" min=1 max=4 default=2 step=1
uniform int u_octaves;
out vec4 fragColor;

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    if (i >= u_octaves) break;
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = v_uv;
  float t = u_time * u_speed;
  vec2 warp = vec2(
    fbm(uv * u_warp_scale + t * 0.3),
    fbm(uv * u_warp_scale + t * 0.4 + 100.0)
  );
  // Audio driver (0 until wired): low-mid intensifies the warp.
  uv += (warp - 0.5) * (u_strength + u_low_mid * 0.08);
  fragColor = texture(u_texture, uv);
}
`)

// ── Depth Blur (pseudo depth-of-field using luminance as depth) ──
registerShader('DEPTH_BLUR', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
// @param name="Focus Point" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_focus;
// @param name="Range" min=0.01 max=1.0 default=0.3 step=0.01
uniform float u_range;
// @param name="Max Blur" min=0.0 max=16.0 default=6.0 step=0.5
uniform float u_max_blur;
// @param name="Use Luminance" type=bool default=true
uniform bool u_use_lum;
out vec4 fragColor;
${LIB3D}

void main() {
  vec2 px = 1.0 / u_resolution;
  vec4 center = texture(u_texture, v_uv);
  // Rec.601 luma, kept deliberately instead of lib3d's Rec.709 d3_luma: this
  // node predates the 3D family and changing its depth estimate would shift the
  // look of every project that already uses it.
  float depth = u_use_lum
    ? dot(center.rgb, vec3(0.299, 0.587, 0.114))
    : length(v_uv - vec2(0.5)) * 1.414;

  // Audio driver (0 until wired): loudness (rms) deepens the blur (clamped).
  float blur = clamp(abs(depth - u_focus) / max(1e-4, u_range), 0.0, 1.0)
             * min(u_max_blur + u_rms * 6.0, 18.0);

  if (blur < 0.5) {
    fragColor = center;
    return;
  }

  // Constant-cost gather. This used to be a nested x/y loop over the blur
  // radius — O(r²), which at radius 18 is a 37×37 kernel, i.e. ~1369 texture
  // fetches PER PIXEL, and at 1080p that is a slideshow. A 24-tap golden-angle
  // spiral rotated per pixel resolves comparably at any radius and costs the
  // same 24 fetches whether the blur is 1px or 18px.
  //
  // The params are untouched on purpose, so existing projects keep their values
  // and simply get faster.
  // Gathered PREMULTIPLIED and divided back out at the end — see BLUR. A
  // gather that crosses a silhouette otherwise pulls the matte's undefined
  // colour into the blurred edge, since straight RGB weights a transparent tap
  // as heavily as an opaque one.
  const int N = 24;
  float rot = d3_ign(gl_FragCoord.xy) * D3_TAU;
  vec4 sum = vec4(center.rgb * center.a, center.a);
  float wsum = 1.0;
  for (int i = 0; i < N; i++) {
    vec2 s = d3_vogel(i, N, rot);
    // Gaussian falloff across the disc, so this stays the soft blur it always
    // was rather than becoming a hard-edged bokeh disc (that is BOKEH_3D's job).
    float w = exp(-dot(s, s) * 2.0);
    vec4 t = texture(u_texture, v_uv + s * blur * px);
    sum += vec4(t.rgb * t.a, t.a) * w;
    wsum += w;
  }
  sum /= wsum;
  fragColor = sum.a > 0.0001 ? vec4(sum.rgb / sum.a, sum.a) : vec4(0.0);
}
`)

// ── Particle Displace ──
registerShader('PARTICLE_DISPLACE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
// @param name="Density" min=0.001 max=0.1 default=0.02 step=0.001
uniform float u_density;
// @param name="Displace Amount" min=0.0 max=0.1 default=0.02 step=0.002
uniform float u_displace;
// @param name="Particle Size" min=1.0 max=8.0 default=2.0 step=0.5
uniform float u_particle_size;
// @param name="Audio React" type=bool default=true
uniform bool u_audio_react;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = v_uv;
  vec4 col = texture(u_texture, uv);
  float audioMult = u_audio_react ? (1.0 + u_rms * 3.0) : 1.0;

  vec2 grid = floor(uv * u_resolution / u_particle_size);
  float r = hash(grid);
  if (r < u_density) {
    float angle = hash(grid + 0.1) * 6.2831 + u_time;
    vec2 offset = vec2(cos(angle), sin(angle)) * u_displace * audioMult;
    col = texture(u_texture, uv + offset);
    col.rgb *= 1.0 + r * 0.3;
  }
  fragColor = col;
}
`)

// ── LUT (Color Lookup — simulates 3D LUT with a gradient ramp) ──
registerShader('LUT', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
// @param name="Temperature" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_temperature;
// @param name="Tint" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_tint;
// @param name="Contrast" min=0.0 max=3.0 default=1.0 step=0.01
uniform float u_contrast;
// @param name="Gamma" min=0.2 max=3.0 default=1.0 step=0.01
uniform float u_gamma;
// @param name="Lift" min=-0.5 max=0.5 default=0.0 step=0.01
uniform float u_lift;
out vec4 fragColor;

void main() {
  vec4 col = texture(u_texture, v_uv);

  // Temperature (warm/cool)
  col.r += u_temperature * 0.1;
  col.b -= u_temperature * 0.1;

  // Tint (green/magenta)
  col.g += u_tint * 0.1;

  // Lift
  col.rgb += u_lift;

  // Contrast (around mid-gray). Audio driver (0 until wired): presence adds punch.
  col.rgb = (col.rgb - 0.5) * (u_contrast + u_presence * 0.6) + 0.5;

  // Gamma
  col.rgb = pow(max(col.rgb, 0.0), vec3(1.0 / u_gamma));

  fragColor = clamp(col, 0.0, 1.0);
}
`)

// ── Math / Blend (mixes two inputs with selectable blend mode) ──
registerShader('MATH_BLEND', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_texture_b;
// @param name="Mix" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_mix;
// @param name="Operation" min=0 max=5 default=0 step=1 type=select options="Mix,Add,Multiply,Screen,Difference,Overlay"
uniform int u_operation;
out vec4 fragColor;

void main() {
  vec4 a = texture(u_texture, v_uv);
  vec4 b = texture(u_texture_b, v_uv);
  vec3 result;

  if (u_operation == 0) result = mix(a.rgb, b.rgb, u_mix);
  else if (u_operation == 1) result = a.rgb + b.rgb * u_mix;
  else if (u_operation == 2) result = a.rgb * mix(vec3(1.0), b.rgb, u_mix);
  else if (u_operation == 3) result = 1.0 - (1.0 - a.rgb) * (1.0 - b.rgb * u_mix);
  else if (u_operation == 4) result = abs(a.rgb - b.rgb) * u_mix + a.rgb * (1.0 - u_mix);
  else {
    vec3 overlay = vec3(
      a.r < 0.5 ? 2.0*a.r*b.r : 1.0 - 2.0*(1.0-a.r)*(1.0-b.r),
      a.g < 0.5 ? 2.0*a.g*b.g : 1.0 - 2.0*(1.0-a.g)*(1.0-b.g),
      a.b < 0.5 ? 2.0*a.b*b.b : 1.0 - 2.0*(1.0-a.b)*(1.0-b.b)
    );
    result = mix(a.rgb, overlay, u_mix);
  }

  // Audio driver (0 until wired): bass pulses the blended result.
  // Mix (0) is a CROSSFADE, so its COVERAGE has to crossfade too. max() keeps
  // the outgoing side's silhouette fully opaque for the whole mix, so an image
  // or shape carrying an alpha channel never actually leaves — which reads as
  // a second copy of it hanging around. The other operations layer two pictures
  // rather than replace one, so the union is right for them. This is the node
  // the starter transition graph is built from.
  float outA = u_operation == 0 ? mix(a.a, b.a, u_mix) : max(a.a, b.a);
  fragColor = vec4(clamp(result * (1.0 + u_bass * 0.5), 0.0, 1.0), outA);
}
`)

// ── Mix / Blend (same shader as MATH_BLEND, registered separately) ──
registerShader('MIX_BLEND', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_texture_b;
// @param name="Mix" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_mix;
// @param name="Operation" min=0 max=5 default=0 step=1 type=select options="Mix,Add,Multiply,Screen,Difference,Overlay"
uniform int u_operation;
out vec4 fragColor;

void main() {
  vec4 a = texture(u_texture, v_uv);
  vec4 b = texture(u_texture_b, v_uv);
  vec3 result;

  if (u_operation == 0) result = mix(a.rgb, b.rgb, u_mix);
  else if (u_operation == 1) result = a.rgb + b.rgb * u_mix;
  else if (u_operation == 2) result = a.rgb * mix(vec3(1.0), b.rgb, u_mix);
  else if (u_operation == 3) result = 1.0 - (1.0 - a.rgb) * (1.0 - b.rgb * u_mix);
  else if (u_operation == 4) result = abs(a.rgb - b.rgb) * u_mix + a.rgb * (1.0 - u_mix);
  else {
    vec3 overlay = vec3(
      a.r < 0.5 ? 2.0*a.r*b.r : 1.0 - 2.0*(1.0-a.r)*(1.0-b.r),
      a.g < 0.5 ? 2.0*a.g*b.g : 1.0 - 2.0*(1.0-a.g)*(1.0-b.g),
      a.b < 0.5 ? 2.0*a.b*b.b : 1.0 - 2.0*(1.0-a.b)*(1.0-b.b)
    );
    result = mix(a.rgb, overlay, u_mix);
  }

  // Audio driver (0 until wired): bass pulses the blended result.
  // Mix (0) is a CROSSFADE, so its COVERAGE has to crossfade too. max() keeps
  // the outgoing side's silhouette fully opaque for the whole mix, so an image
  // or shape carrying an alpha channel never actually leaves — which reads as
  // a second copy of it hanging around. The other operations layer two pictures
  // rather than replace one, so the union is right for them. This is the node
  // the starter transition graph is built from.
  float outA = u_operation == 0 ? mix(a.a, b.a, u_mix) : max(a.a, b.a);
  fragColor = vec4(clamp(result * (1.0 + u_bass * 0.5), 0.0, 1.0), outA);
}
`)

// ── BIOMATH (Procedural Raymarching) ──
registerShader('BIOMATH', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=6 default=0 step=1 type=select options="Xor Neural,Gyroid Lattice,Crystalline Lattice,Hypnotic Spiral,Alien Terrain,Digital Sphere,Orchard"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(random(i + vec2(0.0, 0.0)), random(i + vec2(1.0, 0.0)), u.x),
             mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec2 rotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Xor Neural
    vec3 rd = normalize(vec3(uv, -1.0));
    vec3 p = vec3(0.0);
    float z = 0.0;
    for(int i=0; i<25; i++) {
      p = z * rd;
      p.z -= t * (2.0 + u_bass * 4.0);
      float shape = cos(dot(cos(p), sin(p.yzx / 0.6 + 0.1 * sin(p.zxy * 10.0)) * 10.0));
      float d = 0.01 + 0.3 * abs(shape);
      vec3 glow = vec3(0.2, 0.2, 0.3) * u_intensity + palette(u_palette, z * 0.05 + t) * 0.1;
      genColor += glow / max(0.001, d);
      z += d;
    }
    genColor = tanh(genColor * 0.002);
  }
  else if (u_mode == 1) { // Gyroid Lattice
    vec3 rd = normalize(vec3(uv, 1.0));
    vec3 p = vec3(0.0);
    float z = 0.0;
    vec3 acc = vec3(0.0);
    for(int i=0; i<25; i++) {
      p = rd * z;
      p.z += t + u_bass;
      p.xy = rotate(p.xy, t * 0.2);
      float d = dot(sin(p), cos(p.yzx)) / 1.5;
      d = abs(d) - 0.1;
      if (d < 0.01) acc += palette(u_palette, z * 0.1 + u_mid) * 0.1;
      z += max(0.05, d * 0.5);
    }
    genColor = acc * u_intensity;
  }
  else if (u_mode == 2) { // Crystalline Lattice
    vec2 p = uv * 3.3333;
    vec3 col = vec3(0.0);
    float rt = t * 1.2 + u_bass * 1.5;
    float iters = 8.0 * u_complexity;
    for(float i=1.0; i<=10.0; i++) {
      if (i > iters) break;
      vec2 v = p;
      for(float f=1.0; f<=7.0; f++) {
        v += sin(v.yx * f + i + rt) / f;
      }
      vec3 pal = cos(i + vec3(0.0, 1.0, 2.0)) + 1.0;
      col += pal / (6.0 * max(0.001, length(v)));
    }
    genColor = tanh((col * col) * u_intensity * (1.0 + u_mid * 0.3));
  }
  else if (u_mode == 3) { // Hypnotic Spiral
    vec2 p = uv * 2.0;
    vec2 v = vec2(atan(p.y, p.x), log(length(p) + 1e-6)) / 0.2 + 4.0;
    vec4 col = vec4(0.0);
    float rt = t + u_bass;
    float iters = 8.0 * u_complexity;
    for(float i=1.0; i<9.0; i++) {
      if (i > iters) break;
      v += sin(v.yx * i - vec2(rt, i)) / i;
      col += (sin(vec4(v.x, v.x, v.y, v.x) + i) + 1.0) * (v.y * v.y);
    }
    genColor = tanh(vec3(4.0, 2.0, 1.0) / (col.rgb + 0.001)) * u_intensity;
  }
  else if (u_mode == 4) { // Alien Terrain
    vec3 rd = normalize(vec3(uv, -1.0));
    vec3 p = vec3(0.0);
    vec3 v = vec3(0.0);
    vec3 col = vec3(0.0);
    float z = 0.0;
    float rt = t * 2.0 + u_bass * 4.0;
    for(int i=0; i<35; i++) {
      p = z * rd;
      p.xz -= rt;
      v = p - vec3(sin(p.x), sin(p.x), sin(p.z));
      float d = 0.4 * max(dot(cos(v.xz), sin(v.zx / 0.6)) + 0.6, v.y + 3.0);
      vec3 fog = -rd * d * d / (z * z + 1.0);
      vec3 pal = cos(p.y + vec3(6.0, 1.0, 2.0)) + 1.1;
      vec2 trig = tan(p.y / 0.3) / (cos(p.xz / 0.1) + 0.1 + (2.0 * u_mid));
      float lightStruct = length(trig) + d * d / 0.01;
      vec3 light = pal / (lightStruct + 0.01) / (z + 0.1 / (u_bass + 0.01));
      col += (fog * u_treble) + (light * u_mid);
      z += max(0.02, d);
    }
    genColor = tanh(col * 0.1) * u_intensity;
  }
  else if (u_mode == 5) { // Digital Sphere
    vec3 o = vec3(0.0);
    vec3 p = vec3(0.0);
    vec3 v = vec3(0.0);
    float z = 0.0;
    float l = 0.0;
    vec3 FC = vec3(v_uv * u_resolution, 0.0);
    vec3 r = vec3(u_resolution, u_resolution.x);
    for(int i=0; i<40; i++) {
      p = z * normalize(FC * 2.0 - r.xyy);
      p.z += 9.0;
      l = length(p);
      p = vec3(atan(p.z, p.x) - t * 0.2, log(l) - t * 0.2, asin(clamp(p.y / l, -1.0, 1.0))) / 0.1;
      v = cos(p + sin(p / 0.24 + t));
      float d = l / 60.0 * length(max(v, v.yzx * 0.1 + u_treble * 0.01));
      z += d;
      o += (sin(vec4(p.y) + vec4(6.0, 1.0, 3.0, 3.0)) + 0.1 + u_bass).xyz / d;
    }
    genColor = tanh(o / 20000.0) * u_intensity * (1.0 + u_bass * 0.5 + u_mid * 0.3);
  }
  else { // Orchard
    vec3 o = vec3(0.0);
    vec3 p = vec3(0.0);
    vec3 FC = vec3(v_uv * u_resolution, 0.0);
    vec3 r = vec3(u_resolution, u_resolution.x);
    vec3 v = normalize(FC * 2.0 - r.xyx);
    vec3 c = v / v.y;
    c.z += 0.5 * t;
    float z = 0.0;
    float b = 0.0;
    float g = 0.0;
    float m = 0.0;
    for(int i=0; i<30; i++) {
      b = length((p.y - m) / 100.0 / (abs(sin(c.xz / 0.1)) - 0.05 / v.y));
      g = length(sin(p.xz) + vec2(1.0) - 0.1 * (vec2(1.0) + sin(p.y - p.zx * 0.5)) * m);
      z += 0.8 * max(b, min(4.0 - m, g) - b);
      o.rgb += (vec3(0.7) - v) / (g + b);
      p = z * v + 1.0;
      p.z -= t;
      p.y += 1.0;
      m = abs(p.y);
    }
    genColor = tanh(o / 500.0) * u_intensity * (1.0 + u_bass * 0.5 + u_mid * 0.3);
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── PLASMA (Flowing Waves) ──
registerShader('PLASMA', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=4 default=0 step=1 type=select options="Classic,Liquid Noise,Cellular,Plasma Ball,Nebula"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Scale" min=0.5 max=10.0 default=3.0 step=0.1
uniform float u_scale_val;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(random(i + vec2(0.0, 0.0)), random(i + vec2(1.0, 0.0)), u.x),
             mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for(int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;
  vec2 p = uv * u_scale_val;

  if (u_mode == 0) { // Classic
    float rt = t + u_bass;
    float val = sin(p.x + rt) + sin(p.y + rt) + sin(p.x + p.y + rt);
    val = (val + 3.0) / 6.0;
    genColor = palette(u_palette, val + u_mid) * u_intensity;
  }
  else if (u_mode == 1) { // Liquid Noise
    float n = noise(p + t * 0.5) + noise(p * 2.0 - t) * 0.5;
    float ring = sin(n * 10.0 + t);
    genColor = palette(u_palette, n + u_bass * 0.5) * (0.5 + 0.5 * ring) * u_intensity;
  }
  else if (u_mode == 2) { // Cellular
    vec2 i_st = floor(p);
    vec2 f_st = fract(p);
    float m_dist = 1.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 pt = vec2(random(i_st + neighbor), random(i_st + neighbor + 1.0));
        pt = 0.5 + 0.5 * sin(t + 6.2831 * pt);
        vec2 diff = neighbor + pt - f_st;
        m_dist = min(m_dist, length(diff));
      }
    }
    genColor = palette(u_palette, m_dist + u_treble) * u_intensity;
    genColor += (1.0 - step(0.02, m_dist)) * u_intensity;
  }
  else if (u_mode == 3) { // Plasma Ball
    vec2 v = p;
    float l = abs(0.7 - dot(p, p));
    v = p * (1.0 - l) / 0.2;
    vec3 c = vec3(0.0);
    for(float i=0.0; i<8.0; i++) {
      c += (sin(vec3(v.x, v.y, v.y) * 2.0) + 1.0) * abs(v.x - v.y) * 0.2 + (u_treble * 1.5);
      v += cos(v.yx * i + vec2(0.0, i) + t) / (i + 1.0) + 0.7;
    }
    vec3 glow = exp(p.y * vec3(1.0, -1.0, -2.0)) * exp(-4.0 * l);
    genColor = tanh(glow / max(c, 0.1)) * (1.0 + u_bass) * u_intensity;
  }
  else { // Nebula
    float n = fbm(p + t * 0.1);
    float dist = length(uv) + 0.1;
    float core = 1.0 / dist;
    genColor = palette(u_palette, n * 2.0) * n * core * 0.5 * (0.8 + u_mid * 0.5) * u_intensity;
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── FRACTAL (Mathematical Fractals) ──
registerShader('FRACTAL', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=7 default=0 step=1 type=select options="Julia Deep,Apollonian,KIFS,Fractal Grid,Newton Fractal,Kali Trap,Burning Ship,Mainframe"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Scale" min=0.1 max=5.0 default=1.0 step=0.1
uniform float u_scale_val;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec2 rotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Julia Deep
    // High-iteration Julia with smooth (banding-free) colouring and a line
    // orbit trap that draws luminous filaments through the set. c orbits just
    // off the main cardioid — the boundary zone where Julia sets stay
    // connected, filamented and interesting for every moment of the loop.
    vec2 p = uv * 1.5 / max(u_scale_val, 0.1);
    float ct = t * 0.12;
    vec2 c = vec2(-0.745 + 0.113 * cos(ct), 0.186 + 0.09 * sin(ct * 1.31));
    vec2 z = p;
    float trap = 1e9;
    float iter = 0.0;
    float maxI = min(24.0 + 40.0 * u_complexity, 64.0);
    for (float i = 0.0; i < 64.0; i++) {
      if (i >= maxI) break;
      z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
      trap = min(trap, abs(dot(z, vec2(0.7071))));
      if (dot(z, z) > 64.0) break;
      iter += 1.0;
    }
    float sm = iter - log2(max(log2(max(dot(z, z), 2.0)), 1.0));
    vec3 col = palette(u_palette, sm * 0.035 + t * 0.04) * smoothstep(maxI, maxI * 0.2, iter);
    col += palette(u_palette, 0.55 + sm * 0.02) * exp(-trap * 8.0) * 0.75;
    genColor = col * (0.85 + u_bass * 0.6) * u_intensity;
  }
  else if (u_mode == 1) { // Apollonian
    // Circle-inversion (Apollonian gasket) fractal — repeated sphere
    // inversions of a 3D slice, IQ-style. The slice plane drifts through the
    // gasket over time so the circle packing continuously reorganises.
    vec2 p = uv * 1.3 / max(u_scale_val, 0.1);
    float ss = 1.8 + 0.15 * sin(t * 0.2) + u_bass * 0.1;
    vec3 q = vec3(p, 0.3 + 0.1 * sin(t * 0.13));
    float scale = 1.0;
    float maxI = min(5.0 + 5.0 * u_complexity, 12.0);
    for (float i = 0.0; i < 12.0; i++) {
      if (i >= maxI) break;
      q = -1.0 + 2.0 * fract(0.5 * q + 0.5);
      float k = ss / dot(q, q);
      q *= k;
      scale *= k;
    }
    float d = 0.25 * abs(q.y) / scale;
    float v = smoothstep(3.0 / u_resolution.y, 0.0, d);
    vec3 col = palette(u_palette, log2(scale) * 0.12 + t * 0.04) * v;
    col += palette(u_palette, 0.5 + log2(scale) * 0.08) * exp(-d * 900.0) * 0.6;
    genColor = col * (0.8 + u_bass * 0.7) * u_intensity;
  }
  else if (u_mode == 2) { // KIFS
    vec2 p = uv * 2.0;
    float a = 0.0;
    int maxIters = int(5.0 * u_complexity);
    for(int i=0; i<8; i++) {
      if (i >= maxIters) break;
      p = abs(p) / dot(p, p) - 0.5;
      p = rotate(p, t * 0.2);
      a += length(p);
    }
    genColor = palette(u_palette, a * 0.2 + u_mid) * ((1.5 * u_bass) + 0.5 * sin(a)) * u_intensity;
  }
  else if (u_mode == 3) { // Fractal Grid
    vec2 p = uv * 20.0;
    vec3 col = vec3(0.0);
    float rt = t + u_bass * 2.0;
    int maxIters = int(10.0 * u_complexity);
    for(int i=0; i<12; i++) {
      if (i >= maxIters) break;
      vec3 pal = cos(p.x + vec3(2.0, 1.0, 0.0)) + 1.0;
      vec2 distortion = sin(p + rt).yx;
      float d = length(sin(p + distortion + u_mid * 0.3));
      col += pal / max(0.001, d - u_bass * 0.15) / 0.2;
      p *= mat2(0.8, -0.6, 0.6, 0.8);
    }
    genColor = tanh(col * col / 20000.0) * u_intensity;
  }
  else if (u_mode == 4) { // Newton Fractal
    vec2 z = uv * 3.0;
    float rt = t * 0.2;
    int maxIters = int(12.0 * u_complexity);
    for(int i=0; i<16; i++) {
      if (i >= maxIters) break;
      vec2 z2 = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y);
      vec2 z3 = vec2(z2.x*z.x - z2.y*z.y, z2.x*z.y + z2.y*z.x);
      vec2 deriv = 3.0 * z2;
      vec2 f = z3 - vec2(cos(rt), sin(rt)) * 0.5;
      float denom = dot(deriv, deriv) + 0.001;
      vec2 div = vec2(dot(f, deriv), f.y * deriv.x - f.x * deriv.y) / denom;
      z = z - div;
    }
    float r_d = length(z - vec2(1.0, 0.0));
    float g_d = length(z - vec2(-0.5, 0.866));
    float b_d = length(z - vec2(-0.5, -0.866));
    vec3 col = vec3(1.0 / (r_d + 0.1), 1.0 / (g_d + 0.1), 1.0 / (b_d + 0.1));
    col = tanh(col * 0.3);
    genColor = col * (0.8 + u_bass * 0.5) * u_intensity;
  }
  else if (u_mode == 5) { // Kali Trap
    // Kaliset (abs(p)/dot(p,p) - c) with two orbit traps: min distance to the
    // x-axis draws razor filaments, min distance to a circle draws a woven
    // web. Distinct from KIFS (which sums lengths) — this is all filigree.
    vec2 p = uv * 1.4;
    p += vec2(sin(t * 0.21), cos(t * 0.17)) * 0.15;
    vec2 kc = vec2(0.85 + 0.08 * sin(t * 0.11), 0.64 + 0.08 * cos(t * 0.09));
    vec3 col = vec3(0.0);
    float trapA = 1e9;
    float trapC = 1e9;
    float maxI = min(6.0 + 7.0 * u_complexity, 13.0);
    for (float i = 0.0; i < 13.0; i++) {
      if (i >= maxI) break;
      p = abs(p) / dot(p, p) - kc;
      trapA = min(trapA, abs(p.x));
      trapC = min(trapC, abs(length(p) - 0.45));
      col += palette(u_palette, i * 0.11 + t * 0.04) * exp(-abs(p.y) * 16.0) * 0.10;
    }
    col += palette(u_palette, t * 0.05) * exp(-trapA * 22.0) * 0.7;
    col += palette(u_palette, 0.4 + t * 0.03) * exp(-trapC * 15.0) * 0.5;
    genColor = col * (0.75 + u_bass * 0.8) * u_intensity;
  }
  else if (u_mode == 6) { // Burning Ship
    vec2 c = vec2(-0.4 + sin(t * 0.2) * 0.1, -0.5 + cos(t * 0.15) * 0.1);
    vec2 z = vec2(0.0);
    float iter = 0.0;
    int maxIters = int(16.0 * u_complexity);
    for(int i=0; i<20; i++) {
      if (i >= maxIters) break;
      float x = (z.x * z.x - z.y * z.y) + c.x;
      float y = (2.0 * abs(z.x) * abs(z.y)) + c.y;
      z = vec2(x, y);
      if (length(z) > 4.0) break;
      iter += 1.0;
    }
    float smoothIter = iter - log2(log2(dot(z, z) + 1e-6)) + 4.0;
    vec3 col = palette(u_palette, smoothIter * 0.1 + t * 0.1);
    col *= smoothstep(0.0, 1.0, iter / 16.0);
    genColor = col * (0.7 + u_bass * 0.8) * u_intensity;
  }
  else { // Mainframe
    vec2 p = abs(uv) * 2.5;
    vec3 col = vec3(0.0);
    float rt = t * 1.5 + u_bass * 2.0;
    int maxIters = int(9.0 * u_complexity);
    for(float i = 1.0; i <= 9.0; i++) {
      if (i > float(maxIters)) break;
      vec2 v = p - i * 0.2;
      for(float f = 1.0; f <= 7.0; f++) {
        vec2 cell = ceil(v.yx + i * 0.1) * 9.0 + rt;
        vec2 offset = sin(cell) / f;
        v = (v + offset).yx;
      }
      float l = length(sin(v));
      vec3 pal = cos(i * 0.3 + l - vec3(4.0, 5.0, 6.0)) + 1.0;
      col += 0.02 * pal / max(0.0001, l * l);
    }
    genColor = max(tanh(col * u_intensity * (1.2 + u_mid * 0.8)), 0.0);
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── TUNNEL (Tunnel Effects) ──
registerShader('TUNNEL', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=4 default=0 step=1 type=select options="Cylindrical,Box,Warp Speed,Hyper Tunnel,Bio-Tunnel"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec2 rotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Cylindrical
    float r = 1.0 / length(uv) + t;
    float a = atan(uv.y, uv.x);
    float v = sin(r * 10.0 + u_bass) * cos(a * 8.0);
    genColor = palette(u_palette, v * 0.5 + 0.5) * u_intensity;
  }
  else if (u_mode == 1) { // Box
    vec2 p = abs(uv);
    float maxAx = max(p.x, p.y);
    float r = 0.1 / maxAx + t * 0.5;
    float squares = step(0.5, sin(r * 20.0));
    genColor = vec3(squares) * palette(u_palette, r) * u_intensity;
    genColor *= maxAx * 2.0;
  }
  else if (u_mode == 2) { // Warp Speed
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float stars = 0.0;
    int maxIters = int(4.0 * u_complexity);
    for(float i=1.0; i<5.0; i++) {
      if (i > float(maxIters)) break;
      float rt = t * i + 100.0;
      float depth = fract(1.0/r + rt);
      float size = 0.05 * i * r;
      float angle_seed = floor(a * 10.0 * i);
      if (random(vec2(angle_seed, floor(depth * 10.0))) > 0.95) {
        stars += 1.0 / (abs(fract(depth * 10.0) - 0.5) * 20.0);
      }
    }
    genColor = vec3(stars) * (0.5 + 0.5 * u_bass) * u_intensity;
  }
  else if (u_mode == 3) { // Hyper Tunnel
    vec3 rd = normalize(vec3(uv, -1.0));
    vec3 p = vec3(0.0);
    vec3 col = vec3(0.0);
    float z = 0.0;
    float rt = t * 2.0;
    for(int i=0; i<15; i++) {
      p = z * rd;
      vec3 a = p;
      for(float j=2.0; j<7.0; j++) {
        a -= sin(a * j + rt + float(i)).yzx / j;
      }
      vec3 ap = abs(p);
      float d_box = abs(2.0 - max(ap.x, ap.y));
      float s = a.z + a.y - rt;
      float d_detail = abs(cos(s)) / 7.0;
      float d = d_box + d_detail;
      vec3 pal = cos(vec3(s - z) + vec3(0.0, 1.0, 8.0)) + 1.0;
      col += pal / max(0.001, d);
      z += max(0.05, d);
    }
    genColor = tanh(col * 0.005) * u_intensity;
  }
  else { // Bio-Tunnel
    vec3 rd = normalize(vec3(uv, -1.0));
    vec3 p = vec3(0.0);
    vec4 col = vec4(0.0);
    float z = 0.0;
    float rt = t + u_bass * 4.0;
    for(int i=0; i<15; i++) {
      p = z * rd;
      float angle = atan(p.y / 0.2, p.x) * 2.0;
      float depth = p.z / 3.0;
      float radius = length(p.xy) - 5.0 - z * 0.2;
      p = vec3(angle, depth, radius);
      for(float j=1.0; j<7.0; j++) {
        p += sin(p.yzx * j + rt + 0.3 * float(i)) / j;
      }
      float d = length(vec4(0.4 * cos(p) - 0.4, p.z));
      z += d;
      vec4 pal = cos(p.x + float(i) * 0.4 + z + vec4(6.0, 1.0, 2.0, 0.0)) + (1.0 + u_treble);
      col += pal / max(0.001, (d + u_bass * 0.5));
    }
    genColor = tanh(col.rgb * col.rgb / 400.0) * u_intensity;
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── GEOMETRIC (Symmetric Geometry) ──
registerShader('GEOMETRIC', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="Phyllotaxis Bloom,Flower of Life,Truchet Flow,Geode"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

vec2 rotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

float geoHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Phyllotaxis Bloom
    // The REAL golden-ratio pattern: Vogel's spiral. Seed n sits at angle
    // n·137.5077° (the golden angle) and radius ∝ √n — the sunflower-head
    // arrangement. Each seed is a gaussian glow; waves of size ripple outward
    // through the spiral, and the beat kicks the ripple amplitude.
    const float GA = 2.39996323; // golden angle, radians
    float N = min(60.0 + 70.0 * u_complexity, 180.0);
    vec3 col = vec3(0.0);
    float spin = t * 0.25;
    for (float i = 1.0; i < 180.0; i++) {
      if (i >= N) break;
      float a = i * GA + spin;
      float r = 0.052 * sqrt(i) * (1.0 + u_bass * 0.2);
      vec2 seed = vec2(cos(a), sin(a)) * r;
      float size = 0.012 + 0.014 * (0.5 + 0.5 * sin(sqrt(i) * 2.2 - t * 2.5)) * (1.0 + u_beat);
      float d = length(uv - seed) / size;
      col += palette(u_palette, i / N + t * 0.08) * exp(-d * d);
    }
    genColor = col * u_intensity;
  }
  else if (u_mode == 1) { // Flower of Life
    // Proper sacred geometry: equal circles on a hexagonal lattice, each
    // passing through its six neighbours' centres — the classic overlapping
    // rosette. Rendered as glowing rings with a breathing radial pulse.
    vec2 p = uv * 3.2 * u_complexity;
    const vec2 rep = vec2(1.0, 1.7320508);
    vec2 q1 = mod(p, rep) - rep * 0.5;
    vec2 q2 = mod(p + rep * 0.5, rep) - rep * 0.5;
    float d = min(abs(length(q1) - 1.0), abs(length(q2) - 1.0));
    float ring = smoothstep(0.06, 0.015, d);
    float pulse = 0.6 + 0.5 * sin(length(uv) * 5.0 - t * 2.0 + u_bass * 3.0);
    genColor = (palette(u_palette, length(uv) * 0.5 + t * 0.1) * ring * pulse
             + palette(u_palette, 0.5 + t * 0.05) * exp(-d * 6.0) * 0.35) * u_intensity;
  }
  else if (u_mode == 2) { // Truchet Flow
    // Quarter-circle truchet tiling: two arcs per cell, cells mirrored by
    // hash, so the arcs join into endless weaving paths. Luminous dashes
    // flow along the paths; mids speed the flow, bass brightens it.
    vec2 p = uv * 4.0 * u_complexity + vec2(t * 0.15, 0.0);
    vec2 id = floor(p);
    vec2 f = fract(p);
    float h = geoHash(id);
    if (h < 0.5) f.x = 1.0 - f.x;
    float d1 = abs(length(f) - 0.5);
    float d2 = abs(length(f - 1.0) - 0.5);
    float d = min(d1, d2);
    float ang = (d1 < d2) ? atan(f.y, f.x) : atan(f.y - 1.0, f.x - 1.0);
    float line = smoothstep(0.10, 0.045, d);
    float flow = 0.55 + 0.45 * sin(ang * 6.0 + (h - 0.5) * 12.0 - t * (2.0 + u_mid * 2.0));
    genColor = palette(u_palette, h * 0.6 + ang * 0.15 + t * 0.07) * line * flow
             * (1.0 + u_bass * 0.5) * u_intensity;
  }
  else { // Geode
    vec3 p = vec3(0.0);
    vec3 v = vec3(0.0);
    vec3 rd = normalize(vec3(uv, -1.0));
    vec4 o = vec4(0.0);
    float z = 0.0;
    v = normalize(cos(t * 0.25 + vec3(0.0, 1.0, 4.0)));
    for(float i=0.0; i<30.0; i++) {
      p = z * rd;
      float dotP = dot(v, p);
      p = dotP * v + cross(v, p);
      p.z -= t;
      vec3 folded = abs(fract(p) - 0.5);
      p += folded.yzx - sin(z * 0.7);
      float d = 0.3 * length(min(p, p.yzx));
      vec4 colShift = cos(i * 0.2 + t + vec4(0.0, 1.0, 3.0, 0.0)) + 1.0;
      o += colShift / max(0.001, d);
      z += d;
    }
    genColor = tanh(o.rgb / 2000.0) * (1.0 + u_treble) * u_intensity;
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── LIGHTNING (Electric Discharges) ──
registerShader('LIGHTNING', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=2 default=0 step=1 type=select options="Fractal Bolt,Plasma Globe,Storm Flash"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

// Value noise + fbm — the displacement fields that make bolts look organic.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(random(i), random(i + vec2(1.0, 0.0)), w.x),
             mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), w.x), w.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.7; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = v_uv;
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;
  float aspect = u_resolution.x / u_resolution.y;

  if (u_mode == 0) { // Fractal Bolt
    // One main strike: a vertical channel displaced by fbm, re-seeded per
    // strike so every bolt has new geometry, with hot core + wide glow and
    // forked branches that decay along their run. Bass/beat drive the punch.
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    float strike = floor(t * 1.7);
    float age = fract(t * 1.7);
    float flick = 0.65 + 0.7 * random(vec2(strike, 7.0));
    float decay = exp(-age * (3.0 + 2.0 * random(vec2(strike, 4.0))));
    float wob = (fbm(vec2(p.y * (2.5 + u_complexity * 2.5) + strike * 13.7, strike * 3.1)) - 0.5) * 0.9;
    float x = p.x - wob;
    float core = exp(-abs(x) * 160.0);
    float glow = exp(-abs(x) * 9.0) * 0.55;
    float br = 0.0;
    for (float i = 1.0; i <= 4.0; i++) {
      float h0 = random(vec2(i, strike)) * 1.6 - 0.8;          // fork height
      float side = sign(random(vec2(i, strike + 0.5)) - 0.5);  // fork direction
      float run = (p.y - h0) * side;
      float live = step(0.0, run) * exp(-run * 3.0);
      float bwob = (fbm(vec2(p.y * 7.0 + i * 47.0 + strike * 7.7, i)) - 0.5) * 0.5;
      float bx = p.x - wob - side * run * 0.7 - bwob * run;
      br += exp(-abs(bx) * 220.0) * live * 0.8;
    }
    float bolt = (core + glow + br) * flick * decay * (1.0 + u_bass * 1.2 + u_beat * 0.8);
    genColor = (palette(u_palette, p.y * 0.25 + t * 0.05) * bolt + vec3(1.0) * core * decay * 0.6) * u_intensity;
  }
  else if (u_mode == 1) { // Plasma Globe
    // Tendrils radiating from a central electrode along fbm-wobbled angular
    // paths, contained by a faint glass shell — a plasma ball. Bass surges
    // the electrode, treble crackles the tendrils.
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.4;
    float r = length(p);
    float ang = atan(p.y, p.x);
    vec3 col = vec3(0.0);
    float n = clamp(3.0 + floor(u_complexity * 3.0), 3.0, 9.0);
    for (float i = 0.0; i < 9.0; i++) {
      if (i >= n) break;
      float a0 = i * 6.2831853 / n + t * (0.3 + 0.07 * i);
      float wig = (fbm(vec2(r * 3.5 - t * 2.5, i * 19.3)) - 0.5) * 1.6 * smoothstep(0.0, 0.6, r);
      float da = atan(sin(ang - a0 - wig), cos(ang - a0 - wig)); // wrap-safe angular distance
      float tendril = exp(-da * da * (50.0 + 90.0 * r * r)) * smoothstep(1.25, 0.1, r);
      col += palette(u_palette, i / n + t * 0.1) * tendril * (0.8 + u_treble * 0.8);
    }
    col += palette(u_palette, t * 0.08) * exp(-r * r * 16.0) * (1.4 + u_bass * 2.5); // electrode
    col += palette(u_palette, 0.6 + t * 0.04) * exp(-abs(r - 1.1) * 26.0) * 0.35;    // glass shell
    genColor = col * u_intensity;
  }
  else { // Storm Flash
    // A rolling fbm cloud layer; strikes fire at random moments/positions,
    // light up the cloudscape with a full-frame flash, then decay — the
    // cinematic "storm on the horizon" look.
    vec2 p = vec2(uv.x * aspect, uv.y);
    float cl = fbm(p * (2.5 * u_complexity) + vec2(t * 0.25, -t * 0.06));
    vec3 col = palette(u_palette, cl * 0.4 + 0.15) * cl * cl * 0.4;
    float cell = floor(t * 2.2);
    float age = fract(t * 2.2);
    float gate = step(0.45, random(vec2(cell, 9.0)));
    float decay = exp(-age * 7.0) * gate;
    float sx = (0.15 + 0.7 * random(vec2(cell, 3.0))) * aspect;
    float wob = (fbm(vec2(uv.y * 7.0 + cell * 31.0, cell * 1.7)) - 0.5) * 0.35;
    float d = abs(p.x - sx - wob * (1.0 - uv.y));
    float bolt = exp(-d * 260.0) * decay * (1.0 + u_bass);
    col += (palette(u_palette, 0.75 + cell * 0.03) + vec3(0.8)) * bolt;
    col += exp(-d * 18.0) * decay * palette(u_palette, 0.7) * 0.35;   // corridor glow
    col += vec3(0.85, 0.9, 1.0) * decay * decay * (0.15 + cl * 0.35); // sky flash lights the clouds
    genColor = col * u_intensity * (0.8 + u_mid * 0.5);
  }

  vec4 bg = texture(u_texture, uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── CRYSTAL (Shattered Patterns) ──
registerShader('CRYSTAL', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="Radial Facets,Glass Shatter,Isometric Cubes,Ethereal Gem"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec2 rotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Radial Facets
    float angle = atan(uv.y, uv.x);
    float radius = length(uv);
    float facets = 6.0 * u_complexity;
    float sector = floor(angle / (6.28318 / facets));
    float sectorAngle = sector * (6.28318 / facets);
    vec2 facetUV = rotate(uv, -sectorAngle);
    float sparkle = sin(facetUV.x * 30.0 + t * 2.0) * sin(facetUV.y * 30.0 - t);
    sparkle = smoothstep(0.0, 0.1, sparkle);
    float edge = smoothstep(abs(angle - sectorAngle), 0.02, 0.0);
    genColor = palette(u_palette, sector / facets + radius + t * 0.1) * (sparkle + edge * 0.5) * u_intensity;
    genColor *= 1.0 + u_bass * 0.5;
  }
  else if (u_mode == 1) { // Glass Shatter
    vec2 p = uv * 3.0;
    vec3 col = vec3(0.0);
    float rt = t + u_bass * 2.0;
    for (float i = 0.0; i < 8.0; i++) {
      vec2 cell = floor(p + i * 0.1);
      vec2 shard = fract(p + i * 0.1) - 0.5;
      float r = random(cell);
      shard = rotate(shard, r * 6.28318 + rt * 0.5);
      float d = length(shard);
      float edge = smoothstep(0.3, 0.28, d);
      vec3 shardCol = palette(u_palette, r + i * 0.1);
      col += shardCol * edge * 0.5;
      // Crack lines
      float crack = exp(-d * d * 100.0) * 0.3;
      col += vec3(1.0) * crack * u_intensity;
    }
    genColor = col * u_intensity;
  }
  else if (u_mode == 2) { // Isometric Cubes
    vec2 p = uv * 4.0;
    float isoAngle = 0.5236;
    vec2 iso = vec2(p.x * cos(isoAngle) + p.y * cos(isoAngle), -p.x * sin(isoAngle) + p.y * sin(isoAngle));
    vec2 cell = floor(iso);
    vec2 f = fract(iso);
    float cubeHeight = random(cell) * 0.5;
    float top = smoothstep(0.9, 0.95, f.x) + smoothstep(0.9, 0.95, f.y);
    float front = smoothstep(0.05, 0.0, abs(f.x + f.y - 1.0));
    float side = smoothstep(0.05, 0.0, abs(f.x - f.y));
    float cube = max(max(top, front), side) * step(f.y, 1.0 - cubeHeight);
    genColor = palette(u_palette, cell.x * 0.1 + cell.y * 0.1 + t * 0.05) * cube * u_intensity * (0.8 + u_mid * 0.5);
  }
  else { // Ethereal Gem
    vec3 rd = normalize(vec3(uv, -1.5));
    vec3 p = vec3(0.0);
    vec3 col = vec3(0.0);
    float z = 0.0;
    float rt = t * 0.5;
    for (int i = 0; i < 12; i++) {
      p = z * rd;
      // Rotate the 3D sample point: yaw about Z, then about Y. Swizzling the
      // vec2 that rotate() returns to 3 components is illegal GLSL, which is
      // why this mode used to fail to compile.
      p.xy = rotate(p.xy, rt);
      p.xz = rotate(p.xz, rt * 0.7);
      float d = 0.0;
      for (float j = 1.0; j < 5.0; j++) {
        vec3 ap = abs(p) - j * 0.15;
        d = max(d, max(ap.x, max(ap.y, ap.z)));
      }
      if (d < 0.05) {
        vec3 gemCol = palette(u_palette, float(i) * 0.1 + length(p));
        col += gemCol * (0.05 - d) * 20.0;
      }
      z += max(0.1, d);
    }
    // Inner glow
    float glow = exp(-length(uv) * 3.0) * (0.5 + u_treble * 0.5);
    col += palette(u_palette, rt * 0.2) * glow * 0.5;
    genColor = col * u_intensity;
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── COSMIC (Galactic Visuals) ──
registerShader('COSMIC', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="Spiral Arms,Nebula,Black Hole,Quasar"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(random(i + vec2(0.0, 0.0)), random(i + vec2(1.0, 0.0)), u.x),
             mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for(int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

vec2 rotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Spiral Arms
    float r = length(uv);
    float angle = atan(uv.y, uv.x);
    float arms = 2.0 * u_complexity;
    float spiral = arms * log(r + 0.001) + angle - t;
    float wave = sin(spiral * 10.0) * 0.5 + 0.5;
    float armMask = smoothstep(0.1, 0.0, abs(sin(spiral * 5.0)));
    // Stars
    float stars = 0.0;
    for (float i = 0.0; i < 5.0; i++) {
      vec2 starPos = rotate(vec2(0.1 + i * 0.15, 0.0), t + i * 1.5) * 2.0;
      float d = length(uv - starPos);
      float starR = 0.002 + random(vec2(i, 0.0)) * 0.005;
      stars += exp(-d * d / (starR * starR)) * (0.5 + u_treble * 0.5);
    }
    vec3 armColor = palette(u_palette, r + t * 0.05);
    genColor = armColor * armMask * wave * 0.5 * u_intensity;
    genColor += stars * u_intensity;
    // Center glow
    genColor += palette(u_palette, t * 0.1) * exp(-r * 5.0) * 0.5 * u_intensity;
  }
  else if (u_mode == 1) { // Nebula
    float scale = 3.0 * u_complexity;
    float n = fbm(uv * scale + t * 0.1);
    n += fbm(uv * scale * 2.0 - t * 0.15) * 0.5;
    n += fbm(uv * scale * 4.0 + t * 0.2) * 0.25;
    float dist = length(uv);
    float falloff = exp(-dist * 2.0);
    // Dust lanes
    float dust = smoothstep(0.3, 0.0, abs(n - 0.5));
    vec3 nebulaCol = palette(u_palette, n + t * 0.02) * n * falloff;
    vec3 dustCol = palette(u_palette + 1, n + t * 0.02) * dust * falloff * 0.5;
    genColor = (nebulaCol + dustCol) * u_intensity * (0.7 + u_mid * 0.3);
  }
  else if (u_mode == 2) { // Black Hole
    float r = length(uv);
    float angle = atan(uv.y, uv.x);
    // Gravitational lensing distortion
    float distortion = 0.3 / (r + 0.1);
    vec2 distortedUV = uv + normalize(uv) * distortion * 0.5;
    // Accretion disk
    float diskAngle = angle + t * 0.5 + r * 3.0;
    float diskWave = sin(diskAngle * 8.0) * 0.5 + 0.5;
    float diskWidth = 0.1 + u_bass * 0.05;
    float diskDisk = smoothstep(diskWidth, 0.0, abs(r - 0.5));
    vec3 diskCol = palette(u_palette, r + t * 0.2) * diskWave * diskDisk;
    // Event horizon
    float horizon = smoothstep(0.15, 0.1, r);
    // Photon ring
    float ring = exp(-abs(r - 0.2) * 50.0) * (1.0 + u_treble);
    genColor = diskCol * u_intensity * horizon + ring * palette(u_palette, t * 0.3) * 0.5 * u_intensity;
  }
  else { // Quasar
    float r = length(uv);
    float angle = atan(uv.y, uv.x);
    // Jets
    float jetUpper = smoothstep(0.1, 0.0, abs(angle - 1.5708));
    float jetLower = smoothstep(0.1, 0.0, abs(angle + 1.5708));
    float jetDecay = exp(-r * 3.0);
    float jetPulse = sin(r * 50.0 - t * 5.0) * 0.5 + 0.5;
    jetPulse *= (0.5 + u_bass * 0.5);
    vec3 jetCol = palette(u_palette, r + t * 0.5) * (jetUpper + jetLower) * jetDecay * jetPulse;
    // Core flash
    float core = exp(-r * 10.0) * (1.0 + u_treble * 2.0);
    float flash = step(0.9, sin(t * 10.0 + r * 20.0)) * core;
    // Radial rays
    float rays = sin(angle * 12.0 + t * 2.0) * 0.5 + 0.5;
    rays *= smoothstep(0.8, 0.2, r);
    vec3 rayCol = palette(u_palette + 1, angle / 6.28318 + t * 0.1) * rays * 0.3;
    genColor = (jetCol + rayCol + flash * vec3(1.0, 0.9, 0.7)) * u_intensity;
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── WAVES (Wave Interference) ──
registerShader('WAVES', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="Interference,Ripples,Beam Scanlines,Sliding Interference"
uniform int u_mode;
// @param name="Palette" min=0 max=16 default=0 step=1 type=select options="Rainbow,Neon,Cosmic,Fire,Ocean,Pastel,Monochrome,Sunset,Forest,Cyberpunk,Arctic,Lava,Galaxy,Toxic,Vaporwave,Ember,Aqua"
uniform int u_palette;
// @param name="Complexity" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_complexity;
// @param name="Intensity" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;
// @param name="Blend Mode" min=0 max=4 default=0 step=1 type=select options="Replace,Add,Screen,Multiply,Overlay"
uniform int u_blend_mode;
// @param name="Background Mix" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_bg_mix;

out vec4 fragColor;

vec2 rotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

vec3 palette(int palette_idx, float t) {
  if (palette_idx == 0) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  if (palette_idx == 1) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(2.0, 1.0, 0.0) * t + vec3(0.5, 0.2, 0.25)));
  if (palette_idx == 2) return mix(vec3(0.2, 0.0, 0.8), vec3(0.8, 0.2, 1.0), sin(t * 3.14159) * 0.5 + 0.5);
  if (palette_idx == 3) return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), clamp(t, 0.0, 1.0));
  if (palette_idx == 4) return mix(vec3(0.0, 0.3, 0.8), vec3(0.0, 0.8, 0.6), clamp(t, 0.0, 1.0));
  if (palette_idx == 5) return vec3(0.9, 0.8, 0.8) * (0.5 + 0.5 * cos(6.28318 * t + vec3(0.0, 0.1, 0.2)));
  if (palette_idx == 6) return vec3(t);
  if (palette_idx == 7) return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0, 0.7, 0.4) * t + vec3(0.0, 0.15, 0.20)));
  if (palette_idx == 8) return vec3(0.3, 0.5, 0.2) + vec3(0.4, 0.5, 0.3) * cos(6.28318 * (vec3(0.5, 0.8, 0.4) * t + vec3(0.1, 0.3, 0.6)));
  if (palette_idx == 9) return vec3(0.2, 0.2, 0.5) + vec3(0.8, 0.6, 0.8) * cos(6.28318 * (vec3(1.5, 0.5, 0.8) * t + vec3(0.0, 0.3, 0.5)));
  if (palette_idx == 10) return vec3(0.6, 0.6, 0.8) + vec3(0.3, 0.3, 0.4) * cos(6.28318 * (vec3(0.5, 0.4, 1.0) * t + vec3(0.0, 0.1, 0.3)));
  if (palette_idx == 11) return vec3(0.6, 0.2, 0.0) + vec3(0.7, 0.4, 0.1) * cos(6.28318 * (vec3(0.8, 0.6, 0.2) * t + vec3(0.1, 0.0, 0.5)));
  if (palette_idx == 12) return vec3(0.1, 0.1, 0.3) + vec3(0.5, 0.3, 0.6) * cos(6.28318 * (vec3(1.2, 0.6, 0.9) * t + vec3(0.5, 0.8, 0.3)));
  if (palette_idx == 13) return vec3(0.2, 0.5, 0.1) + vec3(0.7, 0.8, 0.2) * cos(6.28318 * (vec3(1.3, 0.4, 0.3) * t + vec3(0.2, 0.0, 0.6)));
  if (palette_idx == 14) return vec3(0.4, 0.3, 0.6) + vec3(0.6, 0.5, 0.6) * cos(6.28318 * (vec3(0.8, 0.3, 0.5) * t + vec3(0.3, 0.4, 0.7)));
  if (palette_idx == 15) return vec3(0.5, 0.4, 0.1) + vec3(0.7, 0.5, 0.2) * cos(6.28318 * (vec3(0.6, 0.9, 0.3) * t + vec3(0.0, 0.2, 0.5)));
  return vec3(0.2, 0.5, 0.6) + vec3(0.3, 0.6, 0.5) * cos(6.28318 * (vec3(0.4, 0.7, 1.0) * t + vec3(0.1, 0.5, 0.3)));
}

vec3 blend(int blend_mode, vec3 bg, vec3 fg) {
  if (blend_mode == 0) return fg;
  if (blend_mode == 1) return bg + fg;
  if (blend_mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg);
  if (blend_mode == 3) return bg * fg;
  return vec3(
    bg.r < 0.5 ? 2.0*bg.r*fg.r : 1.0 - 2.0*(1.0-bg.r)*(1.0-fg.r),
    bg.g < 0.5 ? 2.0*bg.g*fg.g : 1.0 - 2.0*(1.0-bg.g)*(1.0-fg.g),
    bg.b < 0.5 ? 2.0*bg.b*fg.b : 1.0 - 2.0*(1.0-bg.b)*(1.0-fg.b)
  );
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Interference
    float scale = 5.0 * u_complexity;
    vec2 p = uv * scale;
    float wave = 0.0;
    for (float i = 0.0; i < 4.0; i++) {
      vec2 center = vec2(sin(t * 0.5 + i * 1.5), cos(t * 0.7 + i * 2.0)) * 0.5;
      float d = length(uv - center);
      float freq = 20.0 + i * 5.0;
      wave += sin(d * freq - t * 3.0 + u_bass * 2.0) * (1.0 - i * 0.2);
    }
    wave = wave * 0.25 + 0.5;
    float rings = sin(length(uv) * 10.0 * scale - t * 2.0) * 0.5 + 0.5;
    genColor = palette(u_palette, wave + rings * 0.3) * u_intensity * (0.8 + u_mid * 0.4);
  }
  else if (u_mode == 1) { // Ripples
    vec2 p = uv * 4.0;
    float wave = 0.0;
    float rt = t + u_bass * 3.0;
    for (float i = 0.0; i < 3.0; i++) {
      vec2 center = vec2(sin(rt * 0.3 + i * 3.0) * 0.6, cos(rt * 0.4 + i * 2.0) * 0.6);
      float d = abs(length(uv - center) - fract(rt * 0.5 + i * 0.3));
      wave += exp(-d * d * 50.0) * (1.0 - i * 0.2);
    }
    float colorWave = sin(wave * 10.0 + length(uv) * 5.0) * 0.5 + 0.5;
    genColor = palette(u_palette, colorWave + t * 0.05) * wave * u_intensity;
  }
  else if (u_mode == 2) { // Beam Scanlines
    float scanline = sin(uv.x * 50.0 * u_complexity + t * 3.0) * 0.5 + 0.5;
    scanline *= smoothstep(0.0, 1.0, sin(v_uv.y * 2.0 - t));
    float beam = exp(-abs(uv.y) * 10.0) * (0.5 + u_bass * 0.5);
    float hue = uv.x + t * 0.1;
    genColor = palette(u_palette, hue) * scanline * beam * u_intensity;
    // Horizontal beam lines
    for (float i = 0.0; i < 5.0; i++) {
      float y = sin(t * 2.0 + i * 1.5) * 0.5;
      float line = exp(-abs(uv.y - y) * 20.0);
      genColor += palette(u_palette + 1, i * 0.2 + t * 0.1) * line * 0.3 * u_intensity;
    }
  }
  else { // Sliding Interference
    vec2 p = uv * 3.0;
    float rt = t * 0.5;
    // Transform to sliding coordinate system
    vec2 q = rotate(p, sin(rt) * 0.5);
    float wave = 0.0;
    wave += sin(q.x * 20.0 + rt * 3.0) * sin(q.y * 20.0 - rt * 2.0);
    wave += sin((q.x + q.y) * 15.0 + rt * 2.5) * 0.5;
    wave += sin((q.x - q.y) * 15.0 - rt * 2.5) * 0.5;
    wave = wave * 0.33 + 0.5;
    float pattern = smoothstep(0.4, 0.6, wave);
    genColor = palette(u_palette, pattern + length(uv) * 0.5 + t * 0.05) * pattern * u_intensity;
    genColor *= 0.7 + u_treble * 0.5;
  }

  vec4 bg = texture(u_texture, v_uv);
  float _mixAmt = max(u_bg_mix, 1.0 - u_has_source);
  fragColor = vec4(mix(bg.rgb, blend(u_blend_mode, bg.rgb, genColor), _mixAmt), bg.a);
}
`);

// ── SPACE_DISTORTION (Space Distortions) ──
registerShader('SPACE_DISTORTION', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

// @param name="Mode" min=0 max=1 default=0 step=1 type=select options="Twist,Fold"
uniform int u_mode;
// @param name="Intensity" min=0.0 max=3.0 default=1.0 step=0.05
uniform float u_intensity;
// @param name="Speed" min=0.1 max=3.0 default=1.0 step=0.1
uniform float u_speed;

out vec4 fragColor;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(random(i + vec2(0.0, 0.0)), random(i + vec2(1.0, 0.0)), u.x),
             mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float t = u_time * u_speed;
  vec2 distortedUV = uv;

  if (u_mode == 0) { // Twist
    float r = length(uv);
    float angle = atan(uv.y, uv.x);
    float twistAmount = u_intensity * 3.0 * (1.0 + u_bass * 0.5);
    angle += twistAmount * (0.5 - r) * sin(t);
    distortedUV = vec2(cos(angle), sin(angle)) * r;
    // Add noise-based perturbation for organic feel
    float n = noise(uv * 3.0 + t * 0.2) * 0.05 * u_intensity;
    distortedUV += n * (1.0 + u_mid);
  }
  else { // Fold
    // Kaleidoscope-like folding
    float segments = 6.0 + u_intensity * 4.0;
    float angle = atan(uv.y, uv.x);
    float r = length(uv);
    float segAngle = 6.28318 / segments;
    // Fold the angle
    angle = mod(angle + t * 0.5, segAngle);
    angle = abs(angle - segAngle * 0.5);
    distortedUV = vec2(cos(angle), sin(angle)) * r;
    // Mirror based on radius for more complex folds
    float foldR = 0.3 + sin(t) * 0.1;
    if (r > foldR) {
      distortedUV += normalize(uv) * 0.1 * u_intensity * (1.0 + u_treble);
    }
    // Additional noise distortion
    float n1 = noise(uv * 5.0 + t * 0.3);
    float n2 = noise(uv * 5.0 - t * 0.2 + 100.0);
    distortedUV += vec2(n1, n2) * 0.03 * u_intensity;
  }

  distortedUV = distortedUV * 0.5 + 0.5;
  fragColor = texture(u_texture, distortedUV);
}
`);

// ═══════════════════════════════════════════════════════════
//  3D / DEPTH FAMILY
//
//  One estimator produces depth; everything else consumes it. See
//  3D_DEPTH_EFFECTS_PLAN.md for the full design.
//
//  Two conventions hold across the whole family:
//   • Depth is 0 = near, 1 = far, carried as GREYSCALE RGB — not packed with
//     normals. Greyscale is what makes the family composable: the depth socket
//     accepts a DEPTH node, a painted SHAPE_INPUT gradient, a real depth-map
//     video or a luma matte interchangeably, the map is viewable while you tune
//     it, and it doubles as a DISPLACEMENT input. Normals are cheaper to
//     recompute per consumer (4 taps) than they are to plumb through.
//   • Every consumer has an optional `depth_map` input. The DAG executor falls
//     back to the primary input when nothing is wired (see TEXTURE_INPUT_SOCKETS
//     in clipGraphManager), so a bare node reads the colour image's luma as a
//     crude depth signal and does something sensible with no wiring at all.
// ═══════════════════════════════════════════════════════════

// ── DEPTH (monocular depth estimator — the keystone of the family) ──
// Not ML: a stack of classical depth cues, each individually a guess, combined
// and edge-smoothed into something convincing enough to drive parallax, fog and
// relighting. Every cue is a weight, so it is tunable per shot rather than being
// a black box that is either right or useless.
registerShader('DEPTH', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;

// @param name="Mode" min=0 max=6 default=0 step=1 type=select options="Auto Blend,Contrast (Focus),Luma,Aerial (Color),Radial,Horizon,External Map"
uniform int u_dp_mode;
// @param name="Luma Weight" min=0.0 max=1.0 default=0.35 step=0.01
uniform float u_dp_w_luma;
// @param name="Focus Weight" min=0.0 max=1.0 default=0.45 step=0.01
uniform float u_dp_w_focus;
// @param name="Aerial Weight" min=0.0 max=1.0 default=0.25 step=0.01
uniform float u_dp_w_aerial;
// @param name="Horizon Weight" min=0.0 max=1.0 default=0.2 step=0.01
uniform float u_dp_w_horizon;
// @param name="Radial Weight" min=0.0 max=1.0 default=0.1 step=0.01
uniform float u_dp_w_radial;
// @param name="Horizon Line" min=0.0 max=1.0 default=0.62 step=0.01
uniform float u_dp_horizon;
// @param name="Focus Sensitivity" min=0.5 max=24.0 default=6.0 step=0.1
uniform float u_dp_focus_gain;
// @param name="Smooth Radius" min=0.0 max=24.0 default=6.0 step=0.5
uniform float u_dp_smooth;
// @param name="Edge Threshold" min=0.02 max=0.6 default=0.12 step=0.01
uniform float u_dp_edge;
// @param name="Depth Curve" min=0.25 max=4.0 default=1.0 step=0.05
uniform float u_dp_curve;
// @param name="Near" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_dp_near;
// @param name="Far" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_dp_far;
// @param name="Invert" type=bool default=false
uniform bool u_dp_invert;
// @param name="Output" min=0 max=1 default=0 step=1 type=select options="Depth (Grey),Colorized (Preview)"
uniform int u_dp_output;
// Read by the EXECUTOR, not by this shader: it sizes this node's render target
// (see nodeFBOScale in clipGraphManager). Depth is a low-frequency map and every
// consumer samples it with normalized UVs, so a half-res pass costs a quarter of
// the pixels and looks the same — better, even, since the resample is a denoiser
// and noisy depth is exactly what makes parallax boil. Declared so the @param is
// parsed; the compiler strips it as unused, which is fine.
// @param name="Resolution" min=0 max=2 default=1 step=1 type=select options="Full,Half,Quarter"
uniform int u_dp_res;

out vec4 fragColor;
${LIB3D}

void main() {
  vec2 texel = 1.0 / u_resolution;
  float inv = u_dp_invert ? 1.0 : 0.0;
  float aspect = u_resolution.x / max(1.0, u_resolution.y);

  // One 8-tap ring buys BOTH the edge-preserving colour and the local contrast.
  vec3 flat_;
  float contrast;
  d3_ringProbe(u_texture, v_uv, texel, u_dp_smooth, u_dp_edge, flat_, contrast);

  // ── the cue stack (each normalised to 0 = near, 1 = far) ──

  // Lit subjects sit in front of shadowed background more often than not.
  float cueLuma = 1.0 - d3_luma(flat_);

  // Local contrast: what is in focus is near. The strongest cue a flat image
  // has, which is why it carries the largest default weight.
  float cueFocus = 1.0 - clamp(contrast * u_dp_focus_gain, 0.0, 1.0);

  // Atmospheric perspective: distance desaturates and shifts blue (Rayleigh).
  float sat = d3_saturation(flat_);
  float blueShift = clamp((flat_.b - (flat_.r + flat_.g) * 0.5) * 2.0 + 0.5, 0.0, 1.0);
  float cueAerial = clamp((1.0 - sat) * 0.65 + blueShift * 0.35, 0.0, 1.0);

  // Ground planes recede upward toward the horizon; above it is sky, i.e. far.
  float cueHorizon = v_uv.y < u_dp_horizon
    ? smoothstep(0.0, 1.0, v_uv.y / max(1e-3, u_dp_horizon))
    : 1.0;

  // Subject-centre bias — cheap, and often the only cue a close-up gives you.
  float cueRadial = clamp(length((v_uv - 0.5) * vec2(aspect, 1.0)) * 1.6, 0.0, 1.0);

  float depth;
  if (u_dp_mode == 1) depth = cueFocus;
  else if (u_dp_mode == 2) depth = cueLuma;
  else if (u_dp_mode == 3) depth = cueAerial;
  else if (u_dp_mode == 4) depth = cueRadial;
  else if (u_dp_mode == 5) depth = cueHorizon;
  else if (u_dp_mode == 6) depth = d3_luma(texture(u_texture, v_uv).rgb); // real depth map in
  else {
    float wsum = u_dp_w_luma + u_dp_w_focus + u_dp_w_aerial + u_dp_w_horizon + u_dp_w_radial;
    depth = wsum < 1e-4 ? cueFocus : (
      cueLuma    * u_dp_w_luma +
      cueFocus   * u_dp_w_focus +
      cueAerial  * u_dp_w_aerial +
      cueHorizon * u_dp_w_horizon +
      cueRadial  * u_dp_w_radial
    ) / wsum;
  }

  depth = pow(clamp(depth, 0.0, 1.0), max(0.05, u_dp_curve));
  depth = d3_remapDepth(depth, inv, u_dp_near, u_dp_far);

  // Alpha is forced opaque: this output is DATA, not picture. A depth map that
  // inherited the source's alpha would multiply itself away in any downstream
  // composite and read as "everything is near".
  fragColor = u_dp_output == 1
    ? vec4(d3_falseColor(depth), 1.0)
    : vec4(vec3(depth), 1.0);
}
`)

// ── NORMALS_3D (surface normals / curvature from a depth or luma map) ──
// Standalone because a normal map is useful well beyond this family: wire it
// into DISPLACEMENT to bump-map footage, or into MIX_BLEND as a shading layer.
registerShader('NORMALS_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;

// @param name="Source" min=0 max=1 default=0 step=1 type=select options="Depth / Luma,Inverted"
uniform int u_nm_source;
// @param name="Radius" min=1.0 max=16.0 default=2.0 step=0.5
uniform float u_nm_radius;
// @param name="Relief" min=1.0 max=200.0 default=40.0 step=1.0
uniform float u_nm_relief;
// @param name="Output" min=0 max=2 default=0 step=1 type=select options="Normal Map,Curvature,Slope"
uniform int u_nm_output;
// @param name="Flip X" type=bool default=false
uniform bool u_nm_flip_x;
// @param name="Flip Y" type=bool default=false
uniform bool u_nm_flip_y;
// @param name="Near" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_nm_near;
// @param name="Far" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_nm_far;

out vec4 fragColor;
${LIB3D}

void main() {
  vec2 texel = 1.0 / u_resolution;
  float inv = u_nm_source == 1 ? 1.0 : 0.0;

  vec3 n = d3_normalFromDepth(u_texture, v_uv, texel, u_nm_radius,
                              u_nm_relief, inv, u_nm_near, u_nm_far);
  if (u_nm_flip_x) n.x = -n.x;
  if (u_nm_flip_y) n.y = -n.y;

  if (u_nm_output == 1) {
    // Curvature = the depth Laplacian: positive on ridges, negative in cavities.
    // Remapped to 0.5-centred grey so it reads as a usable cavity/edge map.
    vec2 o = texel * max(1.0, u_nm_radius);
    float c = d3_depthAt(u_texture, v_uv, inv, u_nm_near, u_nm_far);
    float s = d3_depthAt(u_texture, v_uv + vec2(o.x, 0.0), inv, u_nm_near, u_nm_far)
            + d3_depthAt(u_texture, v_uv - vec2(o.x, 0.0), inv, u_nm_near, u_nm_far)
            + d3_depthAt(u_texture, v_uv + vec2(0.0, o.y), inv, u_nm_near, u_nm_far)
            + d3_depthAt(u_texture, v_uv - vec2(0.0, o.y), inv, u_nm_near, u_nm_far);
    float curv = (s * 0.25 - c) * u_nm_relief;
    fragColor = vec4(vec3(clamp(curv * 0.5 + 0.5, 0.0, 1.0)), 1.0);
  } else if (u_nm_output == 2) {
    // Slope magnitude — a silhouette/edge mask that ignores which way it faces.
    fragColor = vec4(vec3(clamp(1.0 - n.z, 0.0, 1.0)), 1.0);
  } else {
    fragColor = vec4(n * 0.5 + 0.5, 1.0);
  }
}
`)

// ── RELIGHT_3D (deferred lighting on flat footage) ──
// The best value-per-flop in the family: normals from depth cost 4 taps, and
// each light after that is ~10 flops with NO extra texture fetches. Flat footage
// stops looking flat.
registerShader('RELIGHT_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;

// @param name="Mode" min=0 max=5 default=0 step=1 type=select options="Studio (3-Point),Single Key,Rim Only,Toon / Cel,Metal,Wet / Subsurface"
uniform int u_rl_mode;
// @param name="Relief" min=1.0 max=200.0 default=40.0 step=1.0
uniform float u_rl_relief;
// @param name="Normal Radius" min=1.0 max=12.0 default=2.0 step=0.5
uniform float u_rl_radius;
// @param name="Key Angle" min=0.0 max=360.0 default=135.0 step=1.0
uniform float u_rl_key_angle;
// @param name="Key Elevation" min=0.0 max=1.0 default=0.35 step=0.01
uniform float u_rl_key_elev;
// @param name="Key Intensity" min=0.0 max=3.0 default=1.1 step=0.05
uniform float u_rl_key_int;
// @param name="Key Color" type=color default=#fff2dd
uniform vec3 u_rl_key_color;
// @param name="Fill Amount" min=0.0 max=2.0 default=0.35 step=0.01
uniform float u_rl_fill;
// @param name="Fill Color" type=color default=#8fb4ff
uniform vec3 u_rl_fill_color;
// @param name="Rim Amount" min=0.0 max=3.0 default=0.6 step=0.05
uniform float u_rl_rim;
// @param name="Rim Color" type=color default=#ffffff
uniform vec3 u_rl_rim_color;
// @param name="Ambient" min=0.0 max=2.0 default=0.75 step=0.01
uniform float u_rl_ambient;
// @param name="Specular" min=0.0 max=3.0 default=0.5 step=0.05
uniform float u_rl_spec;
// @param name="Shininess" min=2.0 max=128.0 default=32.0 step=1.0
uniform float u_rl_shine;
// @param name="Toon Steps" min=2.0 max=8.0 default=4.0 step=1.0
uniform float u_rl_steps;
// @param name="Invert Depth" type=bool default=false
uniform bool u_rl_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_rl_mix;

out vec4 fragColor;
${LIB3D}

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec4 src = texture(u_texture, v_uv);
  vec3 albedo = src.rgb;
  float inv = u_rl_invert ? 1.0 : 0.0;

  vec3 n = d3_normalFromDepth(u_depth_map, v_uv, texel, u_rl_radius,
                              u_rl_relief, inv, 0.0, 1.0);
  vec3 V = vec3(0.0, 0.0, 1.0);

  // Angle = where on screen the light comes from; elevation = how far round to
  // the front it is (0 = raking across the surface, 1 = straight on).
  float a = radians(u_rl_key_angle);
  vec3 L = normalize(vec3(cos(a), sin(a), mix(0.05, 1.4, u_rl_key_elev)));
  // Fill sits opposite and lower — the standard three-point relationship, so
  // one angle control moves the whole rig coherently.
  vec3 Lf = normalize(vec3(-cos(a), -sin(a) * 0.4, 0.9));

  // Audio drivers (0 until wired): bass pumps the key, beat pops the rim.
  float keyInt = u_rl_key_int * (1.0 + u_bass * 0.8);
  float rimAmt = u_rl_rim * (1.0 + u_beat * 0.5);

  float ndl = max(0.0, dot(n, L));
  float ndf = max(0.0, dot(n, Lf));
  float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);

  vec3 diffuse = vec3(0.0);
  vec3 spec = vec3(0.0);
  float ambient = u_rl_ambient;

  if (u_rl_mode == 1) {                       // Single Key
    diffuse = u_rl_key_color * ndl * keyInt;
  } else if (u_rl_mode == 2) {                // Rim Only — edges, no re-shading
    diffuse = vec3(0.0);
    ambient = max(ambient, 1.0);
  } else if (u_rl_mode == 3) {                // Toon / Cel
    float steps = max(2.0, floor(u_rl_steps));
    float q = floor(ndl * steps) / (steps - 1.0);
    diffuse = u_rl_key_color * clamp(q, 0.0, 1.0) * keyInt
            + u_rl_fill_color * ndf * u_rl_fill * 0.5;
  } else if (u_rl_mode == 4) {                // Metal — spec-dominant, low diffuse
    diffuse = u_rl_key_color * ndl * keyInt * 0.35;
    vec3 H = normalize(L + V);
    spec = u_rl_key_color * pow(max(0.0, dot(n, H)), u_rl_shine) * u_rl_spec * 3.0;
    ambient *= 0.6;
  } else if (u_rl_mode == 5) {                // Wet / Subsurface
    // Wrapped diffuse: light bleeds past the terminator, which is what reads as
    // translucency (skin, wax, liquid) rather than as a hard-shaded solid.
    float w = 0.5;
    float wrap = clamp((dot(n, L) + w) / (1.0 + w), 0.0, 1.0);
    diffuse = u_rl_key_color * wrap * keyInt
            + vec3(0.9, 0.35, 0.3) * pow(wrap, 3.0) * keyInt * 0.4;
    vec3 H = normalize(L + V);
    spec = vec3(1.0) * pow(max(0.0, dot(n, H)), u_rl_shine * 2.0) * u_rl_spec * 1.5;
  } else {                                    // Studio (3-point)
    diffuse = u_rl_key_color * ndl * keyInt
            + u_rl_fill_color * ndf * u_rl_fill;
    vec3 H = normalize(L + V);
    spec = u_rl_key_color * pow(max(0.0, dot(n, H)), u_rl_shine) * u_rl_spec;
  }

  vec3 rim = u_rl_rim_color * fres * rimAmt;
  vec3 lit = albedo * (ambient + diffuse) + spec + rim * (0.35 + 0.65 * albedo);

  fragColor = vec4(mix(albedo, lit, u_rl_mix), src.a);
}
`)

// ── AO_3D (screen-space ambient occlusion / curvature / contact shadow) ──
// Adds the contact shadows and creases that make a picture read as solid rather
// than pasted. 8–32 depth taps on a per-pixel-rotated Vogel spiral: interleaving
// the rotation makes the under-sampling read as dither, so 8 taps look like 32.
registerShader('AO_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;

// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="SSAO,Curvature,Cavity,Contact Shadow"
uniform int u_ao_mode;
// @param name="Radius" min=2.0 max=128.0 default=28.0 step=1.0
uniform float u_ao_radius;
// @param name="Samples" min=0 max=4 default=2 step=1 type=select options="8,12,16,24,32"
uniform int u_ao_samples;
// @param name="Strength" min=0.0 max=4.0 default=1.0 step=0.05
uniform float u_ao_strength;
// @param name="Bias" min=0.0 max=0.1 default=0.008 step=0.001
uniform float u_ao_bias;
// @param name="Depth Range" min=0.02 max=2.0 default=0.35 step=0.01
uniform float u_ao_range;
// @param name="Light Angle" min=0.0 max=360.0 default=135.0 step=1.0
uniform float u_ao_light;
// @param name="Shadow Length" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_ao_shadow_len;
// @param name="Occlusion Color" type=color default=#000000
uniform vec3 u_ao_color;
// @param name="Invert Depth" type=bool default=false
uniform bool u_ao_invert;
// @param name="Output" min=0 max=3 default=0 step=1 type=select options="Multiply,Subtract,AO Only,Colorized (Preview)"
uniform int u_ao_output;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_ao_mix;

out vec4 fragColor;
${LIB3D}

// Sample counts as a select rather than a slider: the loop bound must be a small
// known set so the compiler can keep it tight, and these are the useful steps.
int ao_sampleCount(int idx) {
  if (idx == 0) return 8;
  if (idx == 1) return 12;
  if (idx == 2) return 16;
  if (idx == 3) return 24;
  return 32;
}

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec4 src = texture(u_texture, v_uv);
  float inv = u_ao_invert ? 1.0 : 0.0;
  float centerD = d3_depthAt(u_depth_map, v_uv, inv, 0.0, 1.0);
  // Audio driver (0 until wired): loudness deepens the occlusion.
  float strength = u_ao_strength * (1.0 + u_rms * 0.8);
  float occ = 0.0;

  if (u_ao_mode == 1 || u_ao_mode == 2) {
    // Curvature / Cavity — a 4-tap Laplacian. No spiral needed: concavity is a
    // second derivative, so the immediate neighbourhood is all that matters.
    float r = u_ao_mode == 2 ? max(1.0, u_ao_radius * 0.15) : max(1.0, u_ao_radius * 0.5);
    vec2 o = texel * r;
    float s = d3_depthAt(u_depth_map, v_uv + vec2(o.x, 0.0), inv, 0.0, 1.0)
            + d3_depthAt(u_depth_map, v_uv - vec2(o.x, 0.0), inv, 0.0, 1.0)
            + d3_depthAt(u_depth_map, v_uv + vec2(0.0, o.y), inv, 0.0, 1.0)
            + d3_depthAt(u_depth_map, v_uv - vec2(0.0, o.y), inv, 0.0, 1.0);
    float curv = (centerD - s * 0.25) / max(1e-4, u_ao_range);
    // Only the concave side occludes; convex ridges would brighten, which AO
    // has no business doing.
    occ = clamp(curv * strength, 0.0, 1.0);
  } else if (u_ao_mode == 3) {
    // Contact Shadow — one directional march. The ray's depth rises linearly;
    // anything nearer than the ray at that point is between us and the light.
    float a = radians(u_ao_light);
    vec2 dir = vec2(cos(a), sin(a));
    float jitter = d3_ign(gl_FragCoord.xy);
    float hit = 0.0;
    for (int i = 1; i <= 12; i++) {
      float t = (float(i) - 1.0 + jitter) / 12.0;
      vec2 p = v_uv + dir * t * u_ao_radius * 2.0 * texel;
      float sd = d3_depthAt(u_depth_map, p, inv, 0.0, 1.0);
      float rayD = centerD - t * u_ao_shadow_len;
      float diff = rayD - sd;
      if (diff > u_ao_bias) {
        // Range-check so a distant object doesn't cast onto the foreground.
        hit = max(hit, (1.0 - smoothstep(u_ao_range, u_ao_range * 2.5, diff)) * (1.0 - t));
      }
    }
    occ = clamp(hit * strength, 0.0, 1.0);
  } else {
    // SSAO — per-pixel-rotated Vogel spiral over the depth map.
    int n = ao_sampleCount(u_ao_samples);
    float rot = d3_ign(gl_FragCoord.xy) * D3_TAU;
    float sum = 0.0;
    for (int i = 0; i < 32; i++) {
      if (i >= n) break;
      vec2 off = d3_vogel(i, n, rot) * u_ao_radius * texel;
      float sd = d3_depthAt(u_depth_map, v_uv + off, inv, 0.0, 1.0);
      float diff = centerD - sd;              // > 0 → neighbour is nearer
      float o = clamp((diff - u_ao_bias) / max(1e-4, u_ao_range), 0.0, 1.0);
      // The range check is what separates AO from a dark halo: once a neighbour
      // is much nearer than us it is a different object, not a crease, and it
      // must stop occluding.
      o *= 1.0 - smoothstep(u_ao_range, u_ao_range * 2.5, diff);
      sum += o;
    }
    occ = clamp(sum / float(n) * strength, 0.0, 1.0);
  }

  occ *= u_ao_mix;
  vec3 outCol;
  if (u_ao_output == 1)      outCol = max(vec3(0.0), src.rgb - occ * (1.0 - u_ao_color));
  else if (u_ao_output == 2) outCol = vec3(1.0 - occ);
  else if (u_ao_output == 3) outCol = d3_falseColor(occ);
  else                       outCol = mix(src.rgb, u_ao_color, occ);

  fragColor = vec4(outCol, src.a);
}
`)

// ── FOG_3D (atmospheric depth: fog, haze, aerial perspective, depth grading) ──
// ~20 flops and zero extra texture taps, and it is the single strongest cue for
// scale there is. The cheapest thing in the family by a wide margin.
registerShader('FOG_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;

// @param name="Mode" min=0 max=5 default=0 step=1 type=select options="Linear,Exponential,Exponential²,Height Fog,Aerial Perspective,Depth Tint"
uniform int u_fg_mode;
// @param name="Density" min=0.0 max=4.0 default=1.0 step=0.02
uniform float u_fg_density;
// @param name="Start" min=0.0 max=1.0 default=0.1 step=0.01
uniform float u_fg_start;
// @param name="End" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_fg_end;
// @param name="Gradient" min=0 max=6 default=0 step=1 type=select options="Overcast,Warm → Cool,Teal / Orange,Blue Hour,Sunset Haze,Night,Toxic"
uniform int u_fg_gradient;
// @param name="Use Gradient" type=bool default=false
uniform bool u_fg_use_gradient;
// @param name="Fog Color" type=color default=#b9c6d4
uniform vec3 u_fg_color;
// @param name="Height" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_fg_height;
// @param name="Height Falloff" min=0.1 max=8.0 default=2.0 step=0.1
uniform float u_fg_falloff;
// @param name="Desaturate Far" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_fg_desat;
// @param name="Blue Shift" min=0.0 max=1.0 default=0.2 step=0.01
uniform float u_fg_blue;
// @param name="Invert Depth" type=bool default=false
uniform bool u_fg_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_fg_mix;

out vec4 fragColor;
${LIB3D}

void main() {
  vec4 src = texture(u_texture, v_uv);
  float inv = u_fg_invert ? 1.0 : 0.0;
  float d = d3_depthAt(u_depth_map, v_uv, inv, u_fg_start, u_fg_end);
  // Audio driver (0 until wired): bass rolls the fog in.
  float density = u_fg_density * (1.0 + u_bass * 1.2);

  // Fog factor. Modes 0 / 4 / 5 (Linear, Aerial, Depth Tint) all want a plain
  // linear ramp — the exponential falloffs are what make 1–3 look like *volume*
  // rather than like a gradient, so they get their own curves.
  float f;
  if (u_fg_mode == 1)      f = 1.0 - exp(-d * density * 2.5);
  else if (u_fg_mode == 2) f = 1.0 - exp(-pow(d * density * 1.8, 2.0));
  else if (u_fg_mode == 3) {
    // Height fog: thick low in frame, thinning upward, still gated by depth so
    // it sits BEHIND near objects instead of washing over them.
    float h = exp(-max(0.0, v_uv.y - u_fg_height) * u_fg_falloff * 4.0);
    f = (1.0 - exp(-d * density * 2.5)) * h;
  }
  else                     f = d * density;

  f = clamp(f, 0.0, 1.0);
  vec3 fogCol = u_fg_use_gradient ? d3_depthGradient(u_fg_gradient, d) : u_fg_color;
  vec3 c = src.rgb;

  if (u_fg_mode == 5) {
    // Depth Tint — a grade, not a wash: the gradient multiplies through so far
    // pixels take the cool end and near ones the warm end while keeping detail.
    vec3 tint = d3_depthGradient(u_fg_gradient, d);
    c = mix(c, c * tint * 2.0, clamp(density, 0.0, 1.0));
    c = d3_desaturate(c, u_fg_desat * d);
  } else if (u_fg_mode == 4) {
    // Aerial perspective — the physically motivated one: distance desaturates
    // and shifts blue BEFORE any fog colour is added, so haze reads as
    // atmosphere rather than as a grey scrim laid over the shot.
    c = d3_desaturate(c, u_fg_desat * d);
    c.b += u_fg_blue * d * 0.35;
    c.r -= u_fg_blue * d * 0.12;
    c = mix(c, fogCol, f * 0.85);
  } else {
    c = d3_desaturate(c, u_fg_desat * d);
    c.b += u_fg_blue * d * 0.25;
    c = mix(c, fogCol, f);
  }

  fragColor = vec4(mix(src.rgb, clamp(c, 0.0, 4.0), u_fg_mix), src.a);
}
`)

// ── BOKEH_3D (depth of field with a real lens) ──
// Replaces DEPTH_BLUR's nested radius loop, which reached ~1369 texture fetches
// per pixel at max radius (37×37 at radius 18). A golden-angle spiral scaled by
// circle-of-confusion costs the SAME 16–48 samples at EVERY aperture — and adds
// aperture shape, anamorphic squeeze, swirl and highlight bokeh for a handful of
// flops on top.
//
// Each sample is 2 fetches, not 1: a gather DOF has to know every tap's own
// circle of confusion to decide whether that tap may bleed into this pixel, so
// the depth map is read alongside the colour. Unavoidable, and still an order of
// magnitude below the loop it replaces. (The Tilt-Shift and Radial focus fields
// are computed from screen position, so they cost 1 fetch per sample.)
registerShader('BOKEH_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;

// @param name="Focus Field" min=0 max=2 default=0 step=1 type=select options="Depth Map,Tilt-Shift (Linear),Radial"
uniform int u_bk_field;
// @param name="Focus Distance" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_bk_focus;
// @param name="Focus Range" min=0.005 max=1.0 default=0.12 step=0.005
uniform float u_bk_range;
// @param name="Aperture" min=0.0 max=64.0 default=18.0 step=0.5
uniform float u_bk_aperture;
// @param name="Samples" min=0 max=3 default=2 step=1 type=select options="16,24,32,48"
uniform int u_bk_samples;
// @param name="Blades" min=0.0 max=9.0 default=0.0 step=1.0
uniform float u_bk_blades;
// @param name="Blade Rotation" min=0.0 max=360.0 default=0.0 step=1.0
uniform float u_bk_blade_rot;
// @param name="Anamorphic" min=0.3 max=3.0 default=1.0 step=0.05
uniform float u_bk_squeeze;
// @param name="Swirl" min=-3.0 max=3.0 default=0.0 step=0.05
uniform float u_bk_swirl;
// @param name="Highlight Bokeh" min=0.0 max=8.0 default=1.5 step=0.1
uniform float u_bk_highlight;
// @param name="Tilt Angle" min=0.0 max=360.0 default=90.0 step=1.0
uniform float u_bk_tilt;
// @param name="Invert Depth" type=bool default=false
uniform bool u_bk_invert;
// @param name="Output" min=0 max=1 default=0 step=1 type=select options="Image,CoC (Preview)"
uniform int u_bk_output;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_bk_mix;

out vec4 fragColor;
${LIB3D}

// The value the focus distance is compared against. Depth Map is the real thing;
// the other two synthesise a focus field so DOF works with no depth at all
// (tilt-shift is how you fake a miniature, and it needs no depth by definition).
float bk_field(vec2 uv) {
  if (u_bk_field == 1) {
    float a = radians(u_bk_tilt);
    return clamp(dot(uv - 0.5, vec2(cos(a), sin(a))) + 0.5, 0.0, 1.0);
  }
  if (u_bk_field == 2) {
    float aspect = u_resolution.x / max(1.0, u_resolution.y);
    return clamp(length((uv - 0.5) * vec2(aspect, 1.0)) * 1.414, 0.0, 1.0);
  }
  float inv = u_bk_invert ? 1.0 : 0.0;
  return d3_depthAt(u_depth_map, uv, inv, 0.0, 1.0);
}

// Circle-of-confusion radius in pixels. Signed distance from the focus plane,
// normalised by the in-focus half-width, scaled by aperture.
float bk_coc(vec2 uv, float aperture) {
  return abs(clamp((bk_field(uv) - u_bk_focus) / max(1e-4, u_bk_range), -1.0, 1.0)) * aperture;
}

int bk_sampleCount(int idx) {
  if (idx == 0) return 16;
  if (idx == 1) return 24;
  if (idx == 2) return 32;
  return 48;
}

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec4 src = texture(u_texture, v_uv);
  // Audio driver (0 until wired): treble opens the aperture.
  float aperture = u_bk_aperture * (1.0 + u_treble * 0.6);
  float centerCoC = bk_coc(v_uv, aperture);

  if (u_bk_output == 1) {
    fragColor = vec4(d3_falseColor(centerCoC / max(1.0, aperture)), src.a);
    return;
  }
  // Nothing to gather — and this is the ONLY early-out that is safe. Bailing on
  // "this pixel is in focus" would be wrong: an out-of-focus foreground has to
  // be able to bleed over a sharp background, which is exactly what a gather
  // pass is for.
  if (aperture < 0.5) {
    fragColor = src;
    return;
  }

  int n = bk_sampleCount(u_bk_samples);
  float rot = d3_ign(gl_FragCoord.xy) * D3_TAU;

  // Centre tap first, so a fully in-focus pixel survives unchanged. luma is
  // clamped non-negative before pow: the pipeline is RGBA16F and a negative
  // channel (possible after a grade upstream) would make pow return NaN, which
  // then poisons the whole weighted sum for that pixel.
  float w0 = 1.0 + u_bk_highlight * pow(max(0.0, d3_luma(src.rgb)), 4.0);
  vec4 sum = src * w0;
  float wsum = w0;

  for (int i = 0; i < 48; i++) {
    if (i >= n) break;
    vec2 s = d3_aperture(d3_vogel(i, n, rot), u_bk_blades,
                         radians(u_bk_blade_rot), u_bk_squeeze, u_bk_swirl);
    float dist = length(s) * aperture;            // distance from centre, px
    vec2 uv2 = v_uv + s * aperture * texel;
    vec4 c = texture(u_texture, uv2);

    // A tap contributes only if its OWN circle of confusion reaches this pixel.
    // Skip this and a sharp foreground smears outward over a blurred
    // background — the artifact that gives away every fake depth of field.
    float w = clamp((bk_coc(uv2, aperture) - dist) * 0.5 + 1.0, 0.0, 1.0);
    // Weight bright samples superlinearly so speculars become real bokeh balls
    // instead of averaging away into grey mush.
    w *= 1.0 + u_bk_highlight * pow(max(0.0, d3_luma(c.rgb)), 4.0);

    sum += c * w;
    wsum += w;
  }

  vec4 blurred = sum / max(1e-4, wsum);
  fragColor = vec4(mix(src.rgb, blurred.rgb, u_bk_mix), mix(src.a, blurred.a, u_bk_mix));
}
`)

// ── CAMERA_3D (virtual camera over a depth field — real parallax) ──
// The headline node of the family. One formula (`d3_camVector`) covers pan, dolly
// and orbit, and `d3_pom` marches the view ray through the depth field so near
// objects genuinely OCCLUDE far ones instead of sliding over them.
//
// Cost is adaptive by design: step count is derived from how far the parallax
// actually travels in PIXELS, so a subtle move costs 4 taps and a big one costs
// 24. A camera that hasn't moved costs a single fetch and returns early.
registerShader('CAMERA_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;
uniform float u_time;

// Motion defaults to Sway (index 0) rather than Manual on purpose: a camera node
// that shows nothing when you drop it reads as broken. Manual is last, for when
// a TIME node or keyframes are driving Camera X/Y/Z through the float sockets.
// @param name="Motion" min=0 max=7 default=0 step=1 type=select options="Sway,Dolly In,Dolly Out,Orbit,Handheld,Crane,Figure-8,Manual"
uniform int u_c3_motion;
// @param name="Amplitude" min=0.0 max=1.0 default=0.25 step=0.01
uniform float u_c3_amp;
// @param name="Speed" min=0.05 max=4.0 default=0.4 step=0.05
uniform float u_c3_speed;
// @param name="Camera X" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_c3_x;
// @param name="Camera Y" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_c3_y;
// @param name="Camera Z (Dolly)" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_c3_z;
// @param name="Depth Scale" min=0.0 max=0.5 default=0.08 step=0.005
uniform float u_c3_scale;
// @param name="Pivot X" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_c3_px;
// @param name="Pivot Y" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_c3_py;
// @param name="Quality" min=0 max=2 default=1 step=1 type=select options="Single Tap (flat),Occlusion (Fast),Occlusion (Fine)"
uniform int u_c3_quality;
// @param name="Reveal Fill" min=0 max=2 default=0 step=1 type=select options="Stretch,Smear,Void (Transparent)"
uniform int u_c3_fill;
// @param name="Edge Threshold" min=0.02 max=0.8 default=0.15 step=0.01
uniform float u_c3_edge;
// @param name="Invert Depth" type=bool default=false
uniform bool u_c3_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_c3_mix;

out vec4 fragColor;
${LIB3D}

void main() {
  vec4 src = texture(u_texture, v_uv);
  float inv = u_c3_invert ? 1.0 : 0.0;
  float aspect = u_resolution.x / max(1.0, u_resolution.y);

  // Built-in motion, so the node moves the camera with nothing wired. Anything
  // more specific than these is what the TIME node and keyframes are for — they
  // drive Camera X/Y/Z directly through the float sockets.
  float t = u_time * u_c3_speed;
  // Audio driver (0 until wired): bass drives the camera harder.
  float amp = u_c3_amp * (1.0 + u_bass * 0.8);
  vec2 mxy = vec2(0.0);
  float mz = 0.0;
  if (u_c3_motion == 0)      mxy = vec2(amp * sin(t), 0.0);                      // Sway
  else if (u_c3_motion == 1) mz =  amp * (0.5 - 0.5 * cos(t));                   // Dolly In
  else if (u_c3_motion == 2) mz = -amp * (0.5 - 0.5 * cos(t));                   // Dolly Out
  else if (u_c3_motion == 3) mxy = vec2(amp * cos(t), amp * sin(t) * 0.5);       // Orbit
  else if (u_c3_motion == 4) {                                                   // Handheld
    // Two incommensurate frequencies per axis — enough that the eye never finds
    // the loop, which is the whole difference between "handheld" and "wobble".
    mxy = vec2(sin(t * 1.7) + 0.5 * sin(t * 3.1),
               cos(t * 1.3) + 0.5 * cos(t * 2.7)) * amp * 0.4;
  }
  else if (u_c3_motion == 5) mxy = vec2(0.0, amp * sin(t));                       // Crane
  else if (u_c3_motion == 6) mxy = vec2(amp * sin(t), amp * sin(t * 2.0) * 0.5);  // Figure-8
  // 7 = Manual — mxy / mz stay zero and only the Camera X/Y/Z params move it.

  vec2 pivot = vec2(u_c3_px, u_c3_py);
  vec2 camVec = d3_camVector(v_uv, pivot, vec2(u_c3_x, u_c3_y) + mxy, u_c3_z + mz, aspect);
  vec2 P = camVec * u_c3_scale;

  // How far the parallax actually travels, in pixels. This one number drives the
  // early-out AND the step count — the cheapest possible adaptive quality.
  float travelPx = length(P * u_resolution);
  if (travelPx < 1.0) {
    fragColor = src;
    return;
  }

  float jump = 0.0;
  vec2 uv2;
  if (u_c3_quality == 0) {
    // Flat parallax: one fetch, no occlusion. Fine for a subtle drift, and it is
    // what every "3D photo" filter does — the reason those look like a rubber
    // sheet rather than like a camera move.
    float d = d3_depthAt(u_depth_map, v_uv, inv, 0.0, 1.0);
    uv2 = v_uv + P * (1.0 - d);
  } else {
    int maxSteps = u_c3_quality == 1 ? 12 : 24;
    int steps = clamp(int(travelPx / 3.0), 4, maxSteps);
    int refine = u_c3_quality == 1 ? 3 : 5;
    uv2 = d3_pom(u_depth_map, v_uv, P, steps, refine, inv, 0.0, 1.0, jump);
  }

  vec4 c = texture(u_texture, uv2);

  // Disocclusion: the region the camera move revealed, which was never filmed.
  // \`jump\` is the largest height discontinuity the ray crossed, so it is exactly
  // "did this pixel come from across a silhouette" — and it cost nothing.
  float diso = smoothstep(u_c3_edge, u_c3_edge * 2.0, jump);

  if (u_c3_fill == 1 && diso > 0.002) {
    // Smear the revealed strip along the parallax direction. The eye forgives
    // directional blur in a moving shot; it does not forgive a hard seam.
    vec3 sm = c.rgb;
    for (int i = 1; i <= 4; i++) {
      sm += texture(u_texture, uv2 + P * (float(i) / 4.0) * 0.35).rgb;
    }
    c.rgb = mix(c.rgb, sm / 5.0, diso);
  } else if (u_c3_fill == 2) {
    // Void — tear the frame open. Only alpha is touched: the pipeline is STRAIGHT
    // alpha, so scaling rgb here would double-darken at the present pass.
    c.a *= 1.0 - diso;
  }

  fragColor = vec4(mix(src.rgb, c.rgb, u_c3_mix), mix(src.a, c.a, u_c3_mix));
}
`)

// ── STEREO_3D (stereoscopic output — anaglyph / SBS / interlaced / wiggle) ──
// Two fetches of colour plus two of depth and the frame reads as 3D. Best
// wow-per-flop in the family by a wide margin.
//
// Deliberately single-tap, not POM: stereo parallax is SIGNED around a
// convergence plane (near content shifts one way, far content the other), which
// is a different problem from marching a ray down into a heightfield. Occlusion
// errors at silhouettes are also far less visible in stereo than in a camera
// move, because each eye only ever sees a half-pixel-scale discrepancy.
registerShader('STEREO_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;
uniform float u_time;

// @param name="Mode" min=0 max=5 default=0 step=1 type=select options="Anaglyph (Red/Cyan),Anaglyph (Dubois),Side-by-Side,Over-Under,Interlaced,Wiggle"
uniform int u_st_mode;
// @param name="Interaxial" min=0.0 max=0.12 default=0.025 step=0.001
uniform float u_st_sep;
// @param name="Convergence" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_st_conv;
// @param name="Ghost Reduction" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_st_ghost;
// @param name="Wiggle Rate" min=0.5 max=12.0 default=5.0 step=0.1
uniform float u_st_wiggle;
// @param name="Swap Eyes" type=bool default=false
uniform bool u_st_swap;
// @param name="Invert Depth" type=bool default=false
uniform bool u_st_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_st_mix;

out vec4 fragColor;
${LIB3D}

// Sample one eye. eyeSign is -1 for left, +1 for right.
//
// Convergence is the zero-parallax plane: content at that depth lands in the
// same place in both eyes and therefore sits ON the screen surface. Nearer
// content gets negative parallax and pops out toward the viewer; farther content
// recedes behind the screen. Getting this wrong is what makes cheap 3D hurt to
// look at — everything sits in front of you and the eyes never relax.
vec3 st_eye(float eyeSign, vec2 uv, float doInvert, float aspect) {
  float d = d3_depthAt(u_depth_map, uv, doInvert, 0.0, 1.0);
  float par = (u_st_conv - d) * u_st_sep;
  return texture(u_texture, uv + vec2(eyeSign * par / max(1e-3, aspect), 0.0)).rgb;
}

void main() {
  vec4 src = texture(u_texture, v_uv);
  float inv = u_st_invert ? 1.0 : 0.0;
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  float sgn = u_st_swap ? -1.0 : 1.0;
  vec3 col;

  if (u_st_mode == 2) {                     // Side-by-Side
    // Each half is horizontally squeezed to fit, so the eye's aspect is doubled —
    // otherwise the interaxial would mean something different in SBS than in
    // anaglyph and you'd have to re-tune it per delivery format.
    bool isLeft = v_uv.x < 0.5;
    vec2 uvs = vec2(isLeft ? v_uv.x * 2.0 : (v_uv.x - 0.5) * 2.0, v_uv.y);
    col = st_eye(isLeft ? -sgn : sgn, uvs, inv, aspect * 2.0);
  } else if (u_st_mode == 3) {              // Over-Under
    bool isTop = v_uv.y >= 0.5;
    vec2 uvs = vec2(v_uv.x, isTop ? (v_uv.y - 0.5) * 2.0 : v_uv.y * 2.0);
    col = st_eye(isTop ? -sgn : sgn, uvs, inv, aspect * 0.5);
  } else if (u_st_mode == 4) {              // Interlaced (row-alternating)
    bool isLeft = fract(gl_FragCoord.y * 0.5) < 0.5;
    col = st_eye(isLeft ? -sgn : sgn, v_uv, inv, aspect);
  } else if (u_st_mode == 5) {
    // Wiggle stereoscopy — flip between the two eyes a few times a second and
    // the brain reconstructs depth with no glasses and no colour loss. Cheapest
    // convincing 3D there is: ONE eye is sampled per frame.
    bool isLeft = fract(u_time * u_st_wiggle) < 0.5;
    col = st_eye(isLeft ? -sgn : sgn, v_uv, inv, aspect);
  } else {
    vec3 L = st_eye(-sgn, v_uv, inv, aspect);
    vec3 R = st_eye( sgn, v_uv, inv, aspect);
    // Desaturating before the channel split reduces retinal rivalry — the
    // fighting-colours headache that makes red/cyan unwatchable on saturated
    // footage.
    L = d3_desaturate(L, u_st_ghost);
    R = d3_desaturate(R, u_st_ghost);
    if (u_st_mode == 1) {
      // Dubois optimised red/cyan: a least-squares fit that minimises both
      // ghosting and colour error, instead of naively throwing away channels.
      col = clamp(
        mat3( 0.4561,    -0.0400822, -0.0152161,
              0.500484,  -0.0378246, -0.0205971,
              0.176381,  -0.0157589, -0.00546856) * L
      + mat3(-0.0434706,  0.378476,  -0.0721527,
             -0.0879388,  0.73364,   -0.112961,
             -0.00155529,-0.0184503,  1.2264) * R, 0.0, 1.0);
    } else {
      col = vec3(L.r, R.g, R.b);
    }
  }

  fragColor = vec4(mix(src.rgb, col, u_st_mix), src.a);
}
`)

// ── MULTIPLANE (depth-sliced parallax — Disney's multiplane camera) ──
// Quantise depth into N ≤ 8 bands and give each its own parallax, then composite
// far-to-near. No marching at all: 2 fetches per slice, and the hard band edges
// are the POINT — this is crisp cardboard-cutout parallax (paper diorama, anime
// background, Wes Anderson) rather than an attempt at smooth realism.
registerShader('MULTIPLANE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;
uniform float u_time;

// @param name="Slices" min=2.0 max=8.0 default=5.0 step=1.0
uniform float u_mp_slices;
// @param name="Spread" min=0.0 max=0.3 default=0.06 step=0.005
uniform float u_mp_spread;
// Sway first so the node is alive on drop (see CAMERA_3D's Motion note).
// @param name="Motion" min=0 max=3 default=0 step=1 type=select options="Sway,Orbit,Handheld,Manual"
uniform int u_mp_motion;
// @param name="Amplitude" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_mp_amp;
// @param name="Speed" min=0.05 max=4.0 default=0.4 step=0.05
uniform float u_mp_speed;
// @param name="Camera X" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_mp_x;
// @param name="Camera Y" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_mp_y;
// @param name="Separation" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_mp_sep;
// @param name="Feather" min=0.0 max=1.0 default=0.4 step=0.01
uniform float u_mp_feather;
// @param name="Gaps" min=0 max=2 default=0 step=1 type=select options="Source,Color,Transparent"
uniform int u_mp_gaps;
// @param name="Gap Color" type=color default=#000000
uniform vec3 u_mp_gap_color;
// @param name="Invert Depth" type=bool default=false
uniform bool u_mp_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_mp_mix;

out vec4 fragColor;
${LIB3D}

void main() {
  vec4 src = texture(u_texture, v_uv);
  float inv = u_mp_invert ? 1.0 : 0.0;
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  float t = u_time * u_mp_speed;
  // Audio driver (0 until wired): bass drives the camera.
  float amp = u_mp_amp * (1.0 + u_bass * 0.8);

  vec2 mxy = vec2(0.0);
  if (u_mp_motion == 0)      mxy = vec2(amp * sin(t), 0.0);                  // Sway
  else if (u_mp_motion == 1) mxy = vec2(amp * cos(t), amp * sin(t) * 0.5);   // Orbit
  else if (u_mp_motion == 2) mxy = vec2(sin(t * 1.7) + 0.5 * sin(t * 3.1),   // Handheld
                                        cos(t * 1.3) + 0.5 * cos(t * 2.7)) * amp * 0.4;
  // 3 = Manual — only the Camera X/Y params move it.

  vec2 cam = vec2(u_mp_x, u_mp_y) + mxy;
  cam.x /= max(1e-3, aspect);

  int n = int(clamp(u_mp_slices, 2.0, 8.0));
  float half_ = 0.5 / float(n);

  // FAR → NEAR, so each slice composites over the ones behind it. Painter's
  // algorithm, which is all that is needed once depth is quantised: within a
  // slice there is nothing left to sort.
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    // Band centre in depth: i = 0 is the farthest slice.
    float band = 1.0 - (float(i) + 0.5) / float(n);
    float near_ = 1.0 - band;               // nearer slices travel further

    vec2 uvS = v_uv + cam * near_ * u_mp_spread;
    // Separation scales each plane about the centre, which pulls the stack apart
    // into a visible diorama instead of a single flat image.
    uvS = 0.5 + (uvS - 0.5) / (1.0 + u_mp_sep * near_);

    float dS = d3_depthAt(u_depth_map, uvS, inv, 0.0, 1.0);
    // Does the sampled pixel belong to THIS band? Feather softens the cut; at 0
    // the planes are hard-edged cutouts.
    float edge = half_ * max(0.02, u_mp_feather);
    float m = 1.0 - smoothstep(half_ - edge, half_ + edge, abs(dS - band));

    vec4 c = texture(u_texture, uvS);
    acc = mix(acc, vec4(c.rgb, c.a), clamp(m, 0.0, 1.0));
  }

  // acc came out of the slice loop PREMULTIPLIED — each mix() scaled the colour
  // by that slice's coverage — so the backdrop goes in as + gap * (1 - a), not
  // as a second mix() by acc.a. Mixing again would multiply coverage in twice and
  // darken every soft plane edge.
  vec3 gap = u_mp_gaps == 1 ? u_mp_gap_color : src.rgb;
  vec3 outRgb = acc.rgb + gap * (1.0 - clamp(acc.a, 0.0, 1.0));
  float outA = u_mp_gaps == 2 ? acc.a : src.a;

  fragColor = vec4(mix(src.rgb, outRgb, u_mp_mix), mix(src.a, outA, u_mp_mix));
}
`)

// ── DEPTH_DISPLACE (displacement along the depth gradient) ──
// Ordinary displacement pushes pixels around in the plane. This pushes them
// along the SURFACE NORMAL, so things inflate, melt and shatter volumetrically
// instead of sliding flat. Same 4 normal taps every consumer in the family pays;
// everything after that is arithmetic.
registerShader('DEPTH_DISPLACE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;
uniform float u_time;

// @param name="Mode" min=0 max=5 default=0 step=1 type=select options="Inflate,Melt,Explode,Shear by Depth,Depth Glitch,Ripple by Depth"
uniform int u_dd_mode;
// @param name="Amount" min=0.0 max=0.3 default=0.06 step=0.002
uniform float u_dd_amount;
// @param name="Depth Bias" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_dd_bias;
// @param name="Relief" min=1.0 max=200.0 default=40.0 step=1.0
uniform float u_dd_relief;
// @param name="Normal Radius" min=1.0 max=12.0 default=2.0 step=0.5
uniform float u_dd_radius;
// @param name="Direction" min=0.0 max=360.0 default=270.0 step=1.0
uniform float u_dd_dir;
// @param name="Bands" min=1.0 max=24.0 default=8.0 step=1.0
uniform float u_dd_bands;
// @param name="Speed" min=0.0 max=4.0 default=1.0 step=0.05
uniform float u_dd_speed;
// @param name="Frequency" min=1.0 max=40.0 default=8.0 step=0.5
uniform float u_dd_freq;
// @param name="Chroma Split" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_dd_chroma;
// @param name="Invert Depth" type=bool default=false
uniform bool u_dd_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_dd_mix;

out vec4 fragColor;
${LIB3D}

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec4 src = texture(u_texture, v_uv);
  float inv = u_dd_invert ? 1.0 : 0.0;
  float t = u_time * u_dd_speed;

  float d = d3_depthAt(u_depth_map, v_uv, inv, 0.0, 1.0);
  vec3 n = d3_normalFromDepth(u_depth_map, v_uv, texel, u_dd_radius,
                              u_dd_relief, inv, 0.0, 1.0);

  // Signed distance from the bias plane: content AT the bias depth never moves,
  // so the effect has an anchor instead of sliding the whole frame.
  float rel = d - u_dd_bias;
  // Audio drivers (0 until wired): bass swells it, the beat throws it.
  float amt = u_dd_amount * (1.0 + u_bass * 1.5);
  float dirA = radians(u_dd_dir);
  vec2 dirV = vec2(cos(dirA), sin(dirA));

  vec2 disp = vec2(0.0);
  if (u_dd_mode == 0) {
    // Inflate — push along the normal, strongest where the surface is nearest.
    disp = -n.xy * amt * (1.0 - d);
  } else if (u_dd_mode == 1) {
    // Melt — gravity-biased: the further back a pixel is, the further it runs,
    // and the normal tilts the flow so it follows the surface.
    disp = dirV * amt * max(0.0, rel) * (1.0 + 0.5 * sin(t + d * 6.28318))
         - n.xy * amt * 0.3;
  } else if (u_dd_mode == 2) {
    // Explode — along the normal, kicked by the beat. u_beat is always live, so
    // this pops with the music even before anything is wired.
    disp = n.xy * amt * (0.35 + u_beat) * (1.0 - d) * 2.0;
  } else if (u_dd_mode == 3) {
    disp = dirV * rel * amt * 3.0;
  } else if (u_dd_mode == 4) {
    // Depth Glitch — quantise depth into slabs and tear each one sideways on its
    // own schedule. Far more interesting than a flat glitch because the tears
    // follow the geometry: foreground and background break apart separately.
    float bands = max(1.0, floor(u_dd_bands));
    float slab = floor(d * bands);
    float h = d3_hash12(vec2(slab, floor(t * 3.0)));
    float on = step(0.55, h);
    disp = vec2((h - 0.5) * 2.0, 0.0) * amt * 4.0 * on;
  } else {
    // Ripple — a wave travelling through DEPTH rather than across the screen, so
    // it reads as a shockwave moving toward or away from camera.
    disp = n.xy * sin(d * u_dd_freq - t * 3.0) * amt;
  }

  vec3 col;
  if (u_dd_chroma > 0.001) {
    // Per-channel displacement magnitude — the dispersion you get from a real
    // lens or a torn tape, for 2 extra fetches.
    float s = u_dd_chroma * 0.35;
    col = vec3(
      texture(u_texture, v_uv + disp * (1.0 + s)).r,
      texture(u_texture, v_uv + disp).g,
      texture(u_texture, v_uv + disp * (1.0 - s)).b
    );
  } else {
    col = texture(u_texture, v_uv + disp).rgb;
  }

  fragColor = vec4(mix(src.rgb, col, u_dd_mix), src.a);
}
`)

// ── VOXEL_3D (the frame rebuilt as extruded blocks) ──
// Depth quantised in BOTH axes — a grid of cells laterally, discrete levels
// vertically — then ray-marched. Quantising is what makes it cheap AND is the
// whole look: hard block faces, real occlusion between columns, Lego / voxel /
// equaliser-bar geometry receding into the frame.
//
// The march samples a quantised height, so a step that lands on a TALLER cell
// means the ray is looking at that block's SIDE rather than its top — which is
// how the faces get shaded differently for free, with no geometry and no normals.
registerShader('VOXEL_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;
uniform float u_time;

// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="Cubes,Columns,Terraces,Pins"
uniform int u_vx_mode;
// @param name="Grid" min=8.0 max=160.0 default=48.0 step=1.0
uniform float u_vx_grid;
// @param name="Height" min=0.0 max=0.6 default=0.18 step=0.005
uniform float u_vx_height;
// @param name="Levels" min=2.0 max=24.0 default=8.0 step=1.0
uniform float u_vx_levels;
// @param name="Motion" min=0 max=2 default=0 step=1 type=select options="Sway,Orbit,Manual"
uniform int u_vx_motion;
// @param name="Amplitude" min=0.0 max=1.0 default=0.35 step=0.01
uniform float u_vx_amp;
// @param name="Speed" min=0.05 max=4.0 default=0.35 step=0.05
uniform float u_vx_speed;
// @param name="View X" min=-1.0 max=1.0 default=0.0 step=0.01
uniform float u_vx_x;
// @param name="View Y" min=-1.0 max=1.0 default=-0.35 step=0.01
uniform float u_vx_y;
// @param name="Face Shading" min=0.0 max=2.0 default=1.0 step=0.05
uniform float u_vx_shade;
// @param name="Mortar" min=0.0 max=0.5 default=0.08 step=0.01
uniform float u_vx_mortar;
// @param name="Flat Cells" type=bool default=true
uniform bool u_vx_flat;
// @param name="Invert Depth" type=bool default=false
uniform bool u_vx_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_vx_mix;

out vec4 fragColor;
${LIB3D}

// Cells are kept square in PIXELS, not in UV — square-in-UV cells would be
// stretched rectangles on any non-square frame.
vec2 vx_gridDims(float aspect) {
  return vec2(u_vx_grid, max(2.0, floor(u_vx_grid / max(0.05, aspect))));
}

vec2 vx_cellCenter(vec2 uv, vec2 g) {
  return (floor(uv * g) + 0.5) / g;
}

// Quantised height for the cell containing uv. Columns mode skips the vertical
// quantisation, which turns the blocks into smooth extruded bars.
float vx_height(vec2 uv, vec2 g, float inv) {
  float d = d3_depthAt(u_depth_map, vx_cellCenter(uv, g), inv, 0.0, 1.0);
  float h = 1.0 - d;
  if (u_vx_mode == 1) return h;
  float levels = max(2.0, floor(u_vx_levels));
  return floor(h * levels) / levels;
}

void main() {
  vec4 src = texture(u_texture, v_uv);
  float inv = u_vx_invert ? 1.0 : 0.0;
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 g = vx_gridDims(aspect);

  float t = u_time * u_vx_speed;
  // Audio driver (0 until wired): bass drives the view around.
  float amp = u_vx_amp * (1.0 + u_bass * 0.8);
  vec2 mxy = vec2(0.0);
  if (u_vx_motion == 0)      mxy = vec2(amp * sin(t), 0.0);
  else if (u_vx_motion == 1) mxy = vec2(amp * cos(t), amp * sin(t) * 0.4);
  // 2 = Manual — View X/Y alone.

  vec2 view = vec2(u_vx_x, u_vx_y) + mxy;
  view.x /= max(1e-3, aspect);
  vec2 P = view * u_vx_height;

  // Adaptive step count off the travel distance, same rule as CAMERA_3D — but a
  // tighter step (~2.8px vs ~3px) and a lower ceiling. A block edge is a hard
  // discontinuity, so under-stepping shows up as a staircase rather than as
  // softness; 24 is where extra steps stop being visible and start being spend.
  // This is the heaviest node in the family: one depth fetch per step.
  float travelPx = length(P * u_resolution);
  int steps = clamp(int(travelPx / 2.0), 6, 24);
  float dl = 1.0 / float(steps);
  vec2 duv = P * dl;

  float layer = 1.0;
  vec2 uv = v_uv;
  float h = vx_height(uv, g, inv);
  float side = 0.0;
  float topLevel = h;

  for (int i = 0; i < 24; i++) {
    if (i >= steps) break;
    if (h >= layer) break;
    layer -= dl;
    uv += duv;
    float hPrev = h;
    h = vx_height(uv, g, inv);
    // The ray stepped onto something TALLER than what it was over: from here on
    // it is grazing that block's vertical face, not its top.
    if (h > hPrev + 1e-4) side = 1.0;
    topLevel = h;
  }

  // Flat Cells samples the cell centre, so each block is one solid colour — the
  // toy-brick read. Off, each block keeps the image detail inside it.
  vec2 sampleUV = u_vx_flat ? vx_cellCenter(uv, g) : uv;
  vec3 col = texture(u_texture, sampleUV).rgb;

  // Face shading. Sides go darker, and taller blocks catch more light on top —
  // there is no normal and no light here, just the two facts the march already
  // knows, which is enough for the eye to build the solid.
  float shade = 1.0 - side * 0.35 * u_vx_shade;
  shade *= 1.0 + (topLevel - 0.5) * 0.25 * u_vx_shade;

  // Mortar: the gap between blocks. Terraces widens it per level so the steps
  // read as separate plates.
  vec2 f = fract(uv * g);
  float edge = min(min(f.x, f.y), min(1.0 - f.x, 1.0 - f.y));
  float gapW = u_vx_mortar * 0.5 * (u_vx_mode == 2 ? 1.6 : 1.0);
  float mortar = smoothstep(0.0, max(1e-4, gapW), edge);
  if (u_vx_mode == 3) {
    // Pins — round the top face off by darkening toward the cell edge instead of
    // cutting a hard gap. Cheaper than an SDF and reads as a domed stud.
    float r = length(f - 0.5) * 2.0;
    shade *= 1.0 - smoothstep(0.55, 1.0, r) * 0.55 * u_vx_shade;
    mortar = 1.0;
  }

  col *= shade * mix(1.0, mortar, min(1.0, u_vx_mortar * 4.0));

  fragColor = vec4(mix(src.rgb, clamp(col, 0.0, 4.0), u_vx_mix), src.a);
}
`)

// ── TIME_SLICE_3D (the third axis is TIME) ──
// Every other node in this family treats z as distance. This one treats it as
// AGE: how old a pixel is depends on how far away it is, so the background lags
// behind the foreground and the frame becomes a corridor of its own history.
//
// The design doc wanted a 4×4 atlas of past frames for this. It isn't needed —
// declaring `u_prev_frame` makes the executor hand this node its own ping-pong
// pair (see the isFeedback branch in executeGraphDAG), and every mode here is
// expressible as "output = f(live frame, my own last output, depth)". The output
// IS the accumulator, so history costs one FBO that the renderer already knows
// how to manage, instead of new plumbing.
registerShader('TIME_SLICE_3D', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_prev_frame;
uniform sampler2D u_depth_map;
uniform vec2 u_resolution;
uniform float u_time;

// @param name="Mode" min=0 max=5 default=3 step=1 type=select options="Slit Scan (Rows),Slit Scan (Columns),Time Tunnel,Depth Freeze,Time Smear,Echo Trails"
uniform int u_ts_mode;
// @param name="Persistence" min=0.0 max=0.99 default=0.9 step=0.01
uniform float u_ts_persist;
// @param name="Scan Speed" min=0.1 max=16.0 default=2.0 step=0.1
uniform float u_ts_scan;
// @param name="Depth Rate" min=0.0 max=1.0 default=0.7 step=0.01
uniform float u_ts_depth_rate;
// @param name="Warp" min=0.0 max=0.08 default=0.01 step=0.001
uniform float u_ts_warp;
// @param name="Echo Band" min=0.0 max=1.0 default=0.6 step=0.01
uniform float u_ts_band;
// @param name="Band Width" min=0.02 max=1.0 default=0.4 step=0.01
uniform float u_ts_band_w;
// @param name="Decay Tint" type=color default=#6688cc
uniform vec3 u_ts_tint;
// @param name="Tint Amount" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_ts_tint_amt;
// @param name="Invert Depth" type=bool default=false
uniform bool u_ts_invert;
// @param name="Mix" min=0.0 max=1.0 default=1.0 step=0.01
uniform float u_ts_mix;

out vec4 fragColor;
${LIB3D}

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec4 src = texture(u_texture, v_uv);
  float inv = u_ts_invert ? 1.0 : 0.0;
  float d = d3_depthAt(u_depth_map, v_uv, inv, 0.0, 1.0);
  vec3 cur = src.rgb;
  vec3 col;

  if (u_ts_mode == 0) {
    // Slit Scan (Rows) — the history scrolls down and the live frame only ever
    // writes the top strip, so the vertical axis of the output IS elapsed time.
    float shift = u_ts_scan * texel.y;
    col = v_uv.y > 1.0 - shift
      ? cur
      : texture(u_prev_frame, v_uv + vec2(0.0, shift)).rgb;
  } else if (u_ts_mode == 1) {
    float shift = u_ts_scan * texel.x;
    col = v_uv.x > 1.0 - shift
      ? cur
      : texture(u_prev_frame, v_uv + vec2(shift, 0.0)).rgb;
  } else if (u_ts_mode == 2) {
    // Time Tunnel — history expands outward from the centre every frame, so
    // radius reads as age and the frame becomes a corridor of past frames.
    vec2 zoomed = (v_uv - 0.5) / (1.0 + max(1e-4, u_ts_warp) * 4.0) + 0.5;
    vec3 prev = texture(u_prev_frame, zoomed).rgb;
    float r = length((v_uv - 0.5) * vec2(u_resolution.x / max(1.0, u_resolution.y), 1.0));
    // New content enters in the middle; everything already there keeps flying out.
    float gate = 1.0 - smoothstep(0.05, 0.28, r);
    col = mix(prev * u_ts_persist, cur, gate);
  } else if (u_ts_mode == 3) {
    // Depth Freeze — the star. Each pixel's chance of refreshing this frame falls
    // off with distance, so the far field literally lags in time behind the near
    // field. A per-pixel hash makes the update DISCRETE, which is what gives the
    // grainy datamosh texture; a smooth blend (Time Smear, below) just looks like
    // motion blur.
    float updateP = mix(1.0, 1.0 - u_ts_persist, clamp(d * u_ts_depth_rate, 0.0, 1.0));
    float rnd = d3_hash12(gl_FragCoord.xy + vec2(floor(u_time * 60.0)));
    vec3 prev = texture(u_prev_frame, v_uv).rgb;
    col = rnd < updateP ? cur : prev;
  } else if (u_ts_mode == 4) {
    // Time Smear — the smooth sibling: near pixels track the live frame, far ones
    // trail it. Optional warp drifts the history so the trail also moves.
    float k = mix(1.0, 1.0 - u_ts_persist, clamp(d * u_ts_depth_rate, 0.0, 1.0));
    vec2 warped = (v_uv - 0.5) * (1.0 + u_ts_warp) + 0.5;
    vec3 prev = texture(u_prev_frame, warped).rgb;
    col = mix(prev, cur, clamp(k, 0.0, 1.0));
  } else {
    // Echo Trails — feedback restricted to a DEPTH BAND, so only objects at a
    // chosen distance leave trails. That selectivity is the thing plain feedback
    // can never do.
    vec2 warped = (v_uv - 0.5) * (1.0 + u_ts_warp) + 0.5;
    vec3 prev = texture(u_prev_frame, warped).rgb;
    float inBand = 1.0 - smoothstep(u_ts_band_w * 0.5, u_ts_band_w * 0.5 + 0.08,
                                    abs(d - u_ts_band));
    col = mix(cur, max(cur, prev * u_ts_persist), inBand);
  }

  // Age tint: history is pulled toward a colour as it decays, which makes the
  // time axis legible instead of just soft.
  if (u_ts_tint_amt > 0.001) {
    float ageLike = clamp(length(col - cur), 0.0, 1.0);
    col = mix(col, mix(col, u_ts_tint, 0.6), ageLike * u_ts_tint_amt);
  }

  fragColor = vec4(mix(src.rgb, clamp(col, 0.0, 4.0), u_ts_mix), src.a);
}
`)

export default SHADER_SOURCES
