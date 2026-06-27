/**
 * DaliVid — shaderRegistry.js
 * Central registry mapping node types to their GLSL fragment shader sources.
 * Shaders are imported lazily to keep initial bundle size small.
 */

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
  return node.customShaderSource || node.shaderCode || getShaderSource(node.type) || null
}

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

void main() {
  vec2 px = 1.0 / u_resolution;
  float tl = length(texture(u_texture, v_uv + vec2(-px.x, px.y)).rgb);
  float t  = length(texture(u_texture, v_uv + vec2(0.0, px.y)).rgb);
  float tr = length(texture(u_texture, v_uv + vec2(px.x, px.y)).rgb);
  float l  = length(texture(u_texture, v_uv + vec2(-px.x, 0.0)).rgb);
  float r  = length(texture(u_texture, v_uv + vec2(px.x, 0.0)).rgb);
  float bl = length(texture(u_texture, v_uv + vec2(-px.x, -px.y)).rgb);
  float b  = length(texture(u_texture, v_uv + vec2(0.0, -px.y)).rgb);
  float br = length(texture(u_texture, v_uv + vec2(px.x, -px.y)).rgb);
  float gx = -tl - 2.0*l - bl + tr + 2.0*r + br;
  float gy = -tl - 2.0*t - tr + bl + 2.0*b + br;
  // Audio driver (0 until wired): treble sharpens the edges.
  float edge = sqrt(gx*gx + gy*gy) * (u_strength + u_treble * 2.0);
  edge = step(u_threshold, edge);
  vec4 original = texture(u_texture, v_uv);
  fragColor = u_show_original
    ? vec4(mix(original.rgb, vec3(edge), 0.5), original.a)
    : vec4(vec3(edge), 1.0);
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
    float r = texture(u_texture, vec2(uv.x + rgbOffset, uv.y)).r;
    float g = texture(u_texture, uv).g;
    float b = texture(u_texture, vec2(uv.x - rgbOffset, uv.y)).b;
    fragColor = vec4(r, g, b, 1.0);
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
      float lum = dot(s.rgb, vec3(0.299, 0.587, 0.114));
      float bright = max(0.0, lum - u_threshold);
      float weight = exp(-float(x*x + y*y) / (r * r * 0.5));
      bloom += s.rgb * bright * weight;
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
// @param name="Segments" min=2.0 max=24.0 default=6.0 step=1.0
uniform float u_segments;
// @param name="Rotation" min=0.0 max=6.283 default=0.0 step=0.01
uniform float u_rotation;
// @param name="Zoom" min=0.1 max=4.0 default=1.0 step=0.05
uniform float u_zoom;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv - 0.5;
  // Audio drivers (0 until wired): treble spins, bass zooms.
  float angle = atan(uv.y, uv.x) + u_rotation + u_treble * 1.5;
  float radius = length(uv) * u_zoom * (1.0 + u_bass * 0.5);
  float segAngle = 3.14159265 * 2.0 / u_segments;
  angle = mod(angle, segAngle);
  if (angle > segAngle * 0.5) angle = segAngle - angle;
  uv = vec2(cos(angle), sin(angle)) * radius + 0.5;
  fragColor = texture(u_texture, uv);
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
  float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
  float dist = distance(rotUV, cellCenter);
  // Audio driver (0 until wired): bass fattens the dots.
  float radius = lum * u_dot_size * 0.5 * (1.0 + u_bass * 0.8);
  float dot = smoothstep(radius, radius - 1.0, dist);
  fragColor = vec4(vec3(dot), 1.0);
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
registerShader('FEEDBACK', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_prev_frame;
uniform float u_time;
// @param name="Feedback" min=0.0 max=0.99 default=0.85 step=0.01
uniform float u_feedback;
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
  fragColor = mix(curr, prev, u_feedback);
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
      color += texture(u_texture, v_uv + vec2(float(x), float(y)) * px) * w;
      totalSpace += w;
    }
  }
  fragColor = color / max(totalSpace, 1.0);
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
  vec3 diff = c00.rgb - c22.rgb;
  // Audio driver (0 until wired): treble deepens the relief.
  float lum = dot(diff, vec3(0.299, 0.587, 0.114)) * (u_intensity + u_treble * 2.0);
  fragColor = vec4(vec3(0.5 + lum), 1.0);
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
registerShader('AUDIO_VISUALIZER', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_audio_bands[8];
uniform float u_audio_rms;
uniform float u_beat;
// @param name="Mode" min=0 max=7 default=0 step=1 type=select options="Bars,Radial Bars,Wave,Spectrum Circle,Particles,Hex Mirror,Pulse Grid,Strobe Mix"
uniform int u_mode;
// @param name="Opacity" min=0.0 max=1.0 default=0.85 step=0.01
uniform float u_opacity;
// @param name="Color Hue" min=0.0 max=1.0 default=0.55 step=0.01
uniform float u_color_hue;
// @param name="Color Saturation" min=0.0 max=1.0 default=0.85 step=0.01
uniform float u_saturation;
// @param name="Scale" min=0.1 max=5.0 default=1.0 step=0.05
uniform float u_scale;
// @param name="Decay" min=0.0 max=0.99 default=0.3 step=0.01
uniform float u_decay;
// @param name="Glow Intensity" min=0.0 max=2.0 default=0.6 step=0.05
uniform float u_glow;
// @param name="Trail Length" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_trail;
// @param name="Background Dim" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_bg_dim;
// @param name="Smoothing" min=0.0 max=0.95 default=0.5 step=0.05
uniform float u_smooth;
// @param name="Line Thickness" min=0.001 max=0.1 default=0.015 step=0.001
uniform float u_thickness;
// @param name="Mirror X" min=0 max=1 default=0 step=1 type=checkbox
uniform int u_mirror_x;
// @param name="Mirror Y" min=0 max=1 default=0 step=1 type=checkbox
uniform int u_mirror_y;
// @param name="Rotation Speed" min=0.0 max=5.0 default=0.0 step=0.1
uniform float u_rot_speed;
// @param name="Bass Impact" min=0.0 max=3.0 default=1.0 step=0.05
uniform float u_bass_impact;
// @param name="Beat Flash" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_beat_flash;
// @param name="Particle Count" min=8 max=128 default=32 step=1
uniform int u_particle_count;
out vec4 fragColor;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Attempt a better pseudo-random
float hash(float n) { return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Smooth band value with manual smoothing factor
float sband(int i, float sm) {
  return mix(u_audio_bands[i], u_audio_bands[i] * (1.0 + sm * 0.5), sm);
}

// Trail/echo value
float trail(int i, float t) {
  return mix(u_audio_bands[i], u_audio_bands[i] * (1.0 - t), t);
}

void main() {
  vec4 bg = texture(u_texture, v_uv);
  vec2 uv = v_uv;
  vec2 center = vec2(0.5);
  float t = u_time;
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // Apply rotation around center
  float angle = u_rot_speed * t * 0.1;
  float ca = cos(angle), sa = sin(angle);
  vec2 ruv = uv - center;
  ruv = vec2(ca * ruv.x - sa * ruv.y, sa * ruv.x + ca * ruv.y) + center;
  vec2 duv = (u_mirror_x == 1) ? vec2(abs(ruv.x - 0.5) + 0.5, ruv.y) : ruv;
  if (u_mirror_y == 1) duv = vec2(duv.x, abs(duv.y - 0.5) + 0.5);

  float bass = u_audio_bands[0] * 0.4 + u_audio_bands[1] * 0.6;
  float smoothed_bass = mix(bass, bass * 1.8, u_smooth);
  float flash = u_beat * u_beat_flash;

  // ──── MODE 0: Frequency Bars (Enhanced) ────
  if (u_mode == 0) {
    float bands = 8.0;
    float barW = 1.0 / bands;
    float idx = clamp(floor(duv.x * bands), 0.0, 7.0);
    int band = int(idx);
    float barH = sband(band, u_smooth) * u_scale * (1.0 + u_bass_impact * 0.5);
    float relY = duv.y / max(barH, 0.001);

    if (duv.y < barH) {
      float hue = u_color_hue + idx * 0.125 + flash * 0.05;
      float sat = u_saturation * (0.8 + 0.2 * (1.0 - relY));
      float bri = 0.6 + 0.4 * (1.0 - relY) + flash;
      float trailAlpha = u_trail * (1.0 - relY);
      col = hsv2rgb(vec3(hue - idx * 0.02, sat, bri));
      alpha = u_opacity * (1.0 - relY * 0.3);

      // Glow below bar top
      float glowDist = (barH - duv.y) / barH;
      col += hsv2rgb(vec3(hue, 0.6, 1.0)) * u_glow * 0.15 * glowDist;
    }

    // Trailing echo bars
    if (u_trail > 0.01) {
      float trailH = trail(band, u_decay) * u_scale;
      if (duv.y < trailH && duv.y >= barH) {
        float th = duv.y / trailH;
        col += hsv2rgb(vec3(u_color_hue + idx * 0.125, u_saturation * 0.6, 0.5)) * u_trail * (1.0 - th);
        alpha = max(alpha, u_trail * 0.4 * (1.0 - th));
      }
    }

    // Baseline glow
    float baseGlow = exp(-duv.y * 20.0) * 0.05;
    col += hsv2rgb(vec3(u_color_hue, 0.8, 1.0)) * baseGlow * u_glow * (bass * 0.5 + 0.5);
  }

  // ──── MODE 1: Radial Bars (Enhanced) ────
  else if (u_mode == 1) {
    vec2 d = duv - center;
    float dist = length(d);
    float a = atan(d.y, d.x);
    float normA = (a + 3.14159265) / 6.2831853;
    int band = int(floor(normA * 8.0));
    band = clamp(band, 0, 7);

    float bandVal = sband(band, u_smooth) * u_scale;
    float innerR = 0.08;
    float outerR = innerR + bandVal * 0.42 * (1.0 + u_bass_impact * 0.3);
    float pulseR = outerR + flash * 0.04;

    if (dist > innerR && dist < pulseR) {
      float hue = u_color_hue + float(band) * 0.125 + flash * 0.03;
      float f = smoothstep(pulseR, outerR, dist);
      float sat = u_saturation * (0.7 + 0.3 * f);
      col = hsv2rgb(vec3(hue, sat, 0.9 + 0.1 * f));
      alpha = u_opacity * f;

      // Glow at tip
      float tipGlow = smoothstep(outerR + 0.03, outerR, dist) * u_glow;
      col += hsv2rgb(vec3(hue, 0.5, 1.0)) * tipGlow * 0.4;
    }

    // Inner ring pulse
    float ringDist = abs(dist - innerR - flash * 0.02);
    float ringGlow = exp(-ringDist * 80.0) * 0.5;
    col += hsv2rgb(vec3(u_color_hue + t * 0.02, 0.9, 1.0)) * ringGlow * u_glow;

    // Outer glow
    if (dist > innerR) {
      float outerGlow = exp(-(dist - outerR) * 15.0) * 0.08;
      col += hsv2rgb(vec3(u_color_hue + 0.1, 0.7, 1.0)) * outerGlow * u_glow;
    }

    // Trail
    if (u_trail > 0.01 && dist > pulseR) {
      float trailR = innerR + trail(band, u_decay) * u_scale * 0.42;
      if (dist < trailR) {
        float tf = smoothstep(trailR, trailR - 0.02, dist);
        col += hsv2rgb(vec3(u_color_hue + float(band) * 0.125, u_saturation * 0.5, 0.7)) * tf * u_trail  * 0.5;
        alpha = max(alpha, tf * u_trail * 0.3);
      }
    }
  }

  // ──── MODE 2: Waveform (Enhanced multi-layer) ────
  else if (u_mode == 2) {
    float wave1 = 0.5;
    float wave2 = 0.5;
    for (int i = 0; i < 8; i++) {
      float phase = float(i + 1) * 6.28318 * duv.x + t * (1.5 + float(i) * 0.3);
      float amp = sband(i, u_smooth) * u_scale * 0.06;
      wave1 += sin(phase) * amp;
      wave2 += cos(phase * 0.7 + 1.3) * amp * 0.5;
    }

    // Bass impact bulges the wave
    wave1 += smoothed_bass * u_bass_impact * 0.03 * sin(duv.x * 3.14159);

    float d1 = abs(duv.y - wave1);
    float d2 = abs(duv.y - wave2);

    // Multi-layer glow
    float lineGlow1 = exp(-d1 * 100.0) * u_thickness * 60.0;
    float lineGlow2 = exp(-d2 * 80.0) * u_thickness * 40.0;
    float wideGlow1 = exp(-d1 * 20.0) * 0.15;
    float wideGlow2 = exp(-d2 * 15.0) * 0.1;

    vec3 hue1 = hsv2rgb(vec3(u_color_hue + duv.x * 0.25, u_saturation, 1.0));
    vec3 hue2 = hsv2rgb(vec3(u_color_hue + duv.x * 0.25 + 0.33, u_saturation * 0.8, 1.0));

    col += hue1 * (lineGlow1 + wideGlow1);
    col += hue2 * (lineGlow2 + wideGlow2);

    // Trail
    if (u_trail > 0.01) {
      for (int j = 1; j < 5; j++) {
        float offset = float(j) * 0.015;
        float td = abs(duv.y - (wave1 + offset));
        float tg = exp(-td * 40.0) * 0.05 * (1.0 - float(j) * 0.2);
        col += hue1 * tg * u_trail;
      }
    }

    alpha = clamp((lineGlow1 + lineGlow2 + wideGlow1 + wideGlow2) * 2.0, 0.0, u_opacity);
  }

  // ──── MODE 3: Spectrum Circles (new) ────
  else if (u_mode == 3) {
    float minR = 0.06;
    for (int i = 0; i < 8; i++) {
      float bandVal = sband(i, u_smooth) * u_scale;
      float radius = minR + float(i) * 0.044 + bandVal * 0.025;
      float thickness = 0.004 + bandVal * 0.008;
      float dist = length(duv - center);
      float ringAlpha = smoothstep(abs(dist - radius), thickness, 0.0);

      float hue = u_color_hue + float(i) * 0.125 + flash * 0.04;
      vec3 ringCol = hsv2rgb(vec3(hue, u_saturation, 0.8 + bandVal * 0.2));
      col += ringCol * ringAlpha * u_opacity;

      // Glow
      float glow = exp(-abs(dist - radius) * 30.0) * 0.15 * u_glow;
      col += hsv2rgb(vec3(hue, 0.5, 1.0)) * glow;
    }

    // Center pulse
    float centerPulse = bass * u_bass_impact * 0.03;
    float cd = length(duv - center);
    float centerGlow = exp(-cd * 30.0) * (0.3 + centerPulse);
    col += hsv2rgb(vec3(u_color_hue + t * 0.05, 0.9, 1.0)) * centerGlow * u_glow;
    alpha = 1.0;
  }

  // ──── MODE 4: Particles (new) ────
  else if (u_mode == 4) {
    int count = u_particle_count;
    for (int i = 0; i < 128; i++) {
      if (i >= count) break;
      float fi = float(i);
      float bandIdx = mod(fi, 8.0);
      int bi = int(bandIdx);
      float bandVal = sband(bi, u_smooth) * u_scale;

      // Particle position driven by audio
      float seed = hash(fi);
      float speed = 0.2 + hash(fi + 100.0) * 0.8;
      float px = hash(fi + 200.0) + sin(t * speed + fi) * 0.15 * bandVal;
      float py = hash(fi + 300.0) + cos(t * speed * 0.7 + fi * 1.3) * 0.15 * bandVal;
      px = fract(px + t * 0.02 * (hash(fi + 400.0) - 0.5));
      py = fract(py + t * 0.02 * (hash(fi + 500.0) - 0.5));

      float size = (0.005 + bandVal * 0.02) * (0.5 + hash(fi + 600.0) * 0.5);
      float d = length(duv - vec2(px, py));
      float particleAlpha = smoothstep(size, size * 0.2, d);

      float hue = u_color_hue + bandIdx * 0.125 + flash * 0.05;
      vec3 pCol = hsv2rgb(vec3(hue, u_saturation, 0.9 + bandVal * 0.1));

      // Glow
      float glow = exp(-d * (15.0 / max(size, 0.001))) * 0.3 * u_glow;
      col += pCol * particleAlpha + hsv2rgb(vec3(hue, 0.4, 1.0)) * glow;
      alpha = max(alpha, particleAlpha);
    }

    // Connect nearby particles with faint lines
    for (int i = 0; i < 64; i++) {
      if (i >= count) break;
      for (int j = i + 1; j < min(i + 4, count); j++) {
        float fi = float(i), fj = float(j);
        float bi = mod(fi, 8.0), bj = mod(fj, 8.0);
        float bv_i = sband(int(bi), u_smooth) * u_scale;
        float bv_j = sband(int(bj), u_smooth) * u_scale;
        float px_i = fract(hash(fi + 200.0) + sin(t * 0.3 + fi) * 0.15 * bv_i + t * 0.02 * (hash(fi + 400.0) - 0.5));
        float py_i = fract(hash(fi + 300.0) + cos(t * 0.21 + fi * 1.3) * 0.15 * bv_i + t * 0.02 * (hash(fi + 500.0) - 0.5));
        float px_j = fract(hash(fj + 200.0) + sin(t * 0.3 + fj) * 0.15 * bv_j + t * 0.02 * (hash(fj + 400.0) - 0.5));
        float py_j = fract(hash(fj + 300.0) + cos(t * 0.21 + fj * 1.3) * 0.15 * bv_j + t * 0.02 * (hash(fj + 500.0) - 0.5));

        vec2 a = vec2(px_i, py_i);
        vec2 b = vec2(px_j, py_j);
        vec2 ab = b - a;
        float abLen = length(ab);
        if (abLen < 0.3) {
          vec2 duvA = duv - a;
          float proj = clamp(dot(duvA, ab) / max(abLen * abLen, 0.0001), 0.0, 1.0);
          float lineD = length(duvA - ab * proj);
          float lineAlpha = exp(-lineD * 80.0) * 0.15 * min(bv_i, bv_j) * u_scale;
          float hue = u_color_hue + (bi + bj) * 0.0625;
          col += hsv2rgb(vec3(hue, u_saturation * 0.6, 1.0)) * lineAlpha;
        }
      }
    }

    alpha = clamp(alpha, 0.0, u_opacity);
  }

  // ──── MODE 5: Hexagonal Mirror (new) ────
  else if (u_mode == 5) {
    vec2 p = (duv - center) * 2.0;
    // Hexagonal coordinates
    float hexR = length(p);
    float hexA = atan(p.y, p.x);
    float hexSize = 0.3 + bass * u_bass_impact * 0.15;
    float hexIdx = floor(hexA / 1.0472); // 60 degrees
    float hexFract = fract(hexA / 1.0472);

    // Map to triangular cell
    vec2 cellUV = vec2(hexFract, hexR / hexSize);
    cellUV = fract(cellUV * 3.0);

    // Sample audio-reactive color
    float bandVal = sband(int(mod(hexIdx, 8.0)), u_smooth) * u_scale;
    float hue = u_color_hue + hexIdx * 0.125 + bandVal * 0.1;

    // Hex edge glow
    float edgeDist = min(min(hexFract, 1.0 - hexFract), abs(hexR / hexSize - 0.5));
    float edgeGlow = exp(-edgeDist * 40.0) * 0.4;

    vec3 hexCol = hsv2rgb(vec3(hue, u_saturation, 0.5 + bandVal * 0.5));
    col = hexCol * (0.3 + bandVal * 0.7) + hsv2rgb(vec3(hue + 0.1, 0.6, 1.0)) * edgeGlow * u_glow;

    // Center burst on beat
    float burst = flash * exp(-hexR * 3.0) * 0.5;
    col += hsv2rgb(vec3(u_color_hue + t * 0.1, 0.9, 1.0)) * burst;

    alpha = u_opacity;
  }

  // ──── MODE 6: Pulse Grid (new) ────
  else if (u_mode == 6) {
    vec2 gridUV = duv * 8.0;
    vec2 cellId = floor(gridUV);
    vec2 cellUV = fract(gridUV);
    float cellHash = hash2(cellId);

    int band = int(mod(cellId.x + cellId.y * 3.0, 8.0));
    float bandVal = sband(band, u_smooth) * u_scale;

    // Cell pulse
    float pulse = bandVal * (1.0 + u_bass_impact * 0.5 * bass);
    float cellDist = length(cellUV - 0.5);
    float cellAlpha = smoothstep(0.5, 0.15, cellDist) * pulse;

    float hue = u_color_hue + float(band) * 0.125 + cellHash * 0.05 + flash * 0.03;
    vec3 cellCol = hsv2rgb(vec3(hue, u_saturation, 0.7 + pulse * 0.3));
    col += cellCol * cellAlpha;

    // Grid lines
    float gridLine = min(min(cellUV.x, 1.0 - cellUV.x), min(cellUV.y, 1.0 - cellUV.y));
    float gridGlow = exp(-gridLine * 30.0) * 0.08 * (0.3 + bandVal * 0.7);
    col += hsv2rgb(vec3(u_color_hue, 0.5, 1.0)) * gridGlow * u_glow;

    // Beat flash on all cells
    col += hsv2rgb(vec3(u_color_hue + t * 0.02, 0.9, 1.0)) * flash * 0.15;

    alpha = clamp(u_opacity * (0.3 + pulse * 0.7), 0.0, u_opacity);
  }

  // ──── MODE 7: Strobe Mix (new) ────
  else if (u_mode == 7) {
    // Strobe on beat
    float strobe = step(0.7, u_beat) * step(fract(t * 8.0 + hash(floor(t * 4.0)) * 0.5), 0.5);

    // Color cycling
    float hueShift = u_color_hue + t * 0.1 + u_audio_rms * 0.2;
    vec3 strobeCol = hsv2rgb(vec3(hueShift, u_saturation, 1.0));

    // Kaleidoscope-like segments
    vec2 d = duv - center;
    float a = atan(d.y, d.x);
    float segments = 6.0;
    float segA = mod(a * segments / 6.28318 + t * 0.2, 1.0);
    float segBand = sband(int(floor(segA * 8.0)), u_smooth) * u_scale;

    float dist = length(d);
    float radialMask = smoothstep(0.5, 0.0, dist);

    col = strobeCol * strobe * radialMask * 0.5;
    col += hsv2rgb(vec3(hueShift + segA, u_saturation, 0.8)) * segBand * radialMask * u_opacity;

    // Flash on beat
    col += strobeCol * flash * 0.3;

    alpha = clamp(strobe * 0.5 + segBand * 0.5, 0.0, u_opacity);
  }

  // ──── Post-processing ────
  // Background dimming
  vec3 bgDim = bg.rgb * u_bg_dim;

  // Composite
  vec3 finalCol = mix(bgDim, col + bgDim * (1.0 - alpha), alpha);

  // Beat flash overlay
  finalCol += vec3(flash * 0.1) * hsv2rgb(vec3(u_color_hue, 0.3, 1.0));

  fragColor = vec4(finalCol, 1.0);
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
    fragColor = vec4(vec3(minDist * edge), 1.0);
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

void main() {
  vec4 center = texture(u_texture, v_uv);
  float depth = u_use_lum
    ? dot(center.rgb, vec3(0.299, 0.587, 0.114))
    : length(v_uv - vec2(0.5)) * 1.414;

  // Audio driver (0 until wired): loudness (rms) deepens the blur (clamped).
  float blur = clamp(abs(depth - u_focus) / u_range, 0.0, 1.0) * min(u_max_blur + u_rms * 6.0, 18.0);
  int rad = int(blur);

  if (rad <= 0) {
    fragColor = center;
    return;
  }

  vec2 px = 1.0 / u_resolution;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int x = -rad; x <= rad; x++) {
    for (int y = -rad; y <= rad; y++) {
      float w = exp(-float(x*x + y*y) / (blur * blur * 0.5));
      sum += texture(u_texture, v_uv + vec2(x, y) * px) * w;
      total += w;
    }
  }
  fragColor = sum / max(total, 1.0);
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
  fragColor = vec4(clamp(result * (1.0 + u_bass * 0.5), 0.0, 1.0), max(a.a, b.a));
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
  fragColor = vec4(clamp(result * (1.0 + u_bass * 0.5), 0.0, 1.0), max(a.a, b.a));
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

// @param name="Mode" min=0 max=7 default=0 step=1 type=select options="Julia,Mandelbrot Zoom,KIFS,Fractal Grid,Newton Fractal,Sierpinski Gasket,Burning Ship,Mainframe"
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

  if (u_mode == 0) { // Julia
    vec2 p = uv * 1.5;
    vec2 c = vec2(sin(t * 0.3), cos(t * 0.4));
    float iter = 0.0;
    int maxIters = int(10.0 * u_complexity);
    for(int i=0; i<16; i++) {
      if (i >= maxIters) break;
      p = vec2(p.x*p.x - p.y*p.y, 2.0*p.x*p.y) + c;
      if (length(p) > 4.0) break;
      iter += 1.0;
    }
    genColor = palette(u_palette, iter * 0.1 + t) * u_intensity;
  }
  else if (u_mode == 1) { // Mandelbrot Zoom
    vec2 p = uv / (u_scale_val + 0.1) - vec2(0.7, 0.0);
    vec2 c = p;
    vec2 z = vec2(0.0);
    float iter = 0.0;
    int maxIters = int(12.0 * u_complexity);
    for(int i=0; i<16; i++) {
      if (i >= maxIters) break;
      z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
      if (length(z) > 2.0) break;
      iter += 1.0;
    }
    genColor = palette(u_palette, iter / 8.0 + t * 0.2) * u_bass * u_intensity;
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
  else if (u_mode == 5) { // Sierpinski Gasket
    vec2 p = uv * 2.0;
    p += vec2(sin(t * 0.3), cos(t * 0.4)) * 0.1;
    vec3 col = vec3(0.0);
    float scale = 1.0;
    int maxIters = int(8.0 * u_complexity);
    for(int i=0; i<10; i++) {
      if (i >= maxIters) break;
      p = abs(p);
      float angle = t * 0.1 + float(i) * 0.2;
      p = rotate(p, angle);
      p = p * 2.0 - vec2(1.0, 0.0);
      vec3 pal = cos(p.x + vec3(1.0, 2.0, 3.0) + t * 0.2) + 1.0;
      col += pal * scale * 0.1;
      scale *= 0.5;
    }
    genColor = col * (0.8 + u_bass * 0.5) * u_intensity;
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

// @param name="Mode" min=0 max=3 default=0 step=1 type=select options="Sacred Geometry,Hexagonal Grid,Rotating Crosses,Geode"
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

  if (u_mode == 0) { // Sacred Geometry
    vec2 p = abs(uv) - 0.5;
    float d = length(p);
    float s = sin(d * 20.0 * u_complexity - t * 4.0 + u_bass);
    s = smoothstep(0.4, 0.5, s);
    genColor = palette(u_palette, d) * s * u_intensity;
  }
  else if (u_mode == 1) { // Hexagonal Grid
    vec2 p = uv * 5.0 * u_complexity;
    vec2 q = vec2(p.x * 2.0 * 0.5773503, p.y + p.x * 0.5773503);
    vec2 pi = floor(q);
    vec2 pf = fract(q);
    float ca = step(1.0, max(abs(pf.x - 0.5) * 1.5 + abs(pf.y - 0.5), abs(pf.y - 0.5) * 2.0));
    genColor = vec3(ca) * palette(u_palette, pi.x * 0.1 + t) * u_intensity;
  }
  else if (u_mode == 2) { // Rotating Crosses
    vec2 p = fract(uv * 4.0 * u_complexity) - 0.5;
    p = rotate(p, t + u_bass);
    float crossShape = min(abs(p.x), abs(p.y));
    float mask = smoothstep(0.1, 0.09, crossShape);
    genColor = mask * palette(u_palette, uv.x + uv.y + t) * u_intensity;
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

// @param name="Mode" min=0 max=2 default=0 step=1 type=select options="Spectral Tesla,Waveform Bolt,Chaos Storm"
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

float lightning(vec2 uv, float offset, float t) {
  float col = 0.0;
  float y = 0.5;
  float segCount = 8.0 * u_complexity;
  for (float i = 0.0; i < 12.0; i++) {
    if (i > segCount) break;
    float seg = i / segCount;
    float nextY = 0.5 + (random(vec2(i, offset)) - 0.5) * 0.8;
    float x = seg + offset * 0.1 + t * 0.2;
    float dx = x - uv.x;
    float dy = mix(y, nextY, smoothstep(0.0, 1.0, (uv.x - seg + offset * 0.1 + t * 0.2) / (0.1 / u_complexity)));
    float d = abs(uv.y - dy) / (0.02 + seg * 0.01);
    col += exp(-d * d) * (1.0 - seg * 0.5);
    y = nextY;
  }
  return col;
}

void main() {
  vec2 uv = v_uv;
  vec3 genColor = vec3(0.0);
  float t = u_time * u_speed;

  if (u_mode == 0) { // Spectral Tesla
    float bolt = 0.0;
    for (float i = 0.0; i < 3.0; i++) {
      bolt += lightning(uv, i * 100.0 + floor(t * 2.0 + i * 10.0), t);
    }
    bolt *= 0.3 + u_bass * 0.5;
    vec3 glow = palette(u_palette, bolt * 2.0 + t * 0.1);
    genColor = glow * bolt * u_intensity;
    genColor += palette(u_palette, 0.5 + t * 0.05) * exp(-abs(uv.y - 0.5) * 10.0) * bolt * 0.3 * u_intensity;
  }
  else if (u_mode == 1) { // Waveform Bolt
    float wave = sin(uv.x * 20.0 + t * 5.0) * 0.1;
    wave += sin(uv.x * 40.0 - t * 3.0) * 0.05 * u_mid;
    float lightningY = 0.5 + wave * (0.5 + u_bass);
    float d = abs(uv.y - lightningY);
    float bolt = exp(-d * d * 200.0) * (0.5 + u_treble);
    bolt += exp(-d * d * 50.0) * 0.2;
    genColor = palette(u_palette, uv.x + t * 0.2) * bolt * u_intensity;
  }
  else { // Chaos Storm
    vec3 col = vec3(0.0);
    vec2 p = (uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
    float rt = t + u_bass * 3.0;
    for (float i = 0.0; i < 5.0; i++) {
      vec2 origin = vec2(sin(rt * 0.7 + i * 2.0) * 0.8, cos(rt * 0.5 + i * 3.0) * 0.8);
      vec2 dir = normalize(p - origin);
      float angle = atan(dir.y, dir.x) + rt * 0.1;
      float boltLen = 0.0;
      vec2 pos = origin;
      for (float j = 0.0; j < 10.0; j++) {
        float r = random(vec2(i * 100.0 + j, floor(rt)));
        pos += dir * 0.05;
        dir = normalize(vec2(cos(angle + r * 2.0), sin(angle + r * 2.0)));
        angle += (r - 0.5) * 2.0;
        float d = length(p - pos);
        boltLen += exp(-d * d * 100.0) * 0.3;
      }
      col += palette(u_palette, i * 0.2 + rt * 0.1) * boltLen;
    }
    genColor = col * u_intensity * (0.7 + u_treble * 0.3);
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
      p = rotate(p.xy, rt) + rotate(p.xz, rt * 0.7).xzy;
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

export default SHADER_SOURCES
