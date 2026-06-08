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
  float edge = sqrt(gx*gx + gy*gy) * u_strength;
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
  hsv.x = fract(hsv.x + u_hue_shift);
  hsv.y *= u_saturation;
  hsv.z *= u_brightness;
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
  float blockY = floor(uv.y * u_resolution.y / u_block_size);
  float rnd = random(vec2(blockY, floor(u_time * u_speed)));
  if (rnd < u_intensity) {
    float offset = (random(vec2(blockY, floor(u_time * u_speed * 3.0))) - 0.5) * 0.1 * u_intensity;
    uv.x += offset;
  }
  float rnd2 = random(vec2(floor(u_time * u_speed * 2.0), 0.0));
  if (rnd2 < u_intensity * 0.3) {
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
  vec2 dir = u_radial ? normalize(v_uv - 0.5) * u_offset : vec2(u_offset, 0.0);
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
  int rad = int(u_radius);
  for (int x = -rad; x <= rad; x++) {
    for (int y = -rad; y <= rad; y++) {
      vec2 off = vec2(float(x), float(y)) * px * 2.0;
      vec4 s = texture(u_texture, v_uv + off);
      float lum = dot(s.rgb, vec3(0.299, 0.587, 0.114));
      float bright = max(0.0, lum - u_threshold);
      float weight = exp(-float(x*x + y*y) / (u_radius * u_radius * 0.5));
      bloom += s.rgb * bright * weight;
      total += weight;
    }
  }
  bloom /= max(total, 1.0);
  fragColor = vec4(original.rgb + bloom * u_bloom_intensity, original.a);
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
  uv *= 1.0 + u_curvature * (uv.yx * uv.yx);
  uv = uv * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  vec4 col = texture(u_texture, uv);
  float scanline = sin(uv.y * u_resolution.y * 3.14159) * 0.5 + 0.5;
  col.rgb *= 1.0 - u_scanline_intensity * (1.0 - scanline);
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
  if (u_axis == 0 || u_axis == 2) {
    uv.x = uv.x < 0.5 + u_mirror_offset ? uv.x : 1.0 - uv.x;
  }
  if (u_axis == 1 || u_axis == 2) {
    uv.y = uv.y < 0.5 + u_mirror_offset ? uv.y : 1.0 - uv.y;
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
  if (u_mode == 0) {
    col.rgb = floor(col.rgb * u_levels + 0.5) / u_levels;
  } else {
    float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
    col.rgb = vec3(step(u_threshold_val, lum));
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
  float angle = atan(uv.y, uv.x) + u_rotation;
  float radius = length(uv) * u_zoom;
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
  float radius = lum * u_dot_size * 0.5;
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

// @param name="Intensity" min=0.0 max=1.0 default=0.5 step=0.01
uniform float u_intensity;

out vec4 fragColor;

void main() {
  vec4 col = texture(u_texture, v_uv);
  
  // Your custom shader code here!
  col.rgb = mix(col.rgb, col.rgb * vec3(1.0, 0.8, 0.6), u_intensity);
  
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
  float c = cos(u_fb_rotate), s = sin(u_fb_rotate);
  uv = mat2(c, -s, s, c) * uv;
  uv /= u_fb_zoom;
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
  int rad = int(u_radius);
  for(int x = -rad; x <= rad; x++) {
    for(int y = -rad; y <= rad; y++) {
      float w = exp(-(float(x*x + y*y)) / (u_radius * u_radius * 0.5));
      color += texture(u_texture, v_uv + vec2(x, y) * px) * w;
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
  vec2 grid = u_resolution / u_size;
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
  float noise = (rand(v_uv + t) - 0.5) * u_amount;
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
  vec2 uv = v_uv + mapOffset * u_scale;
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
  float lum = dot(diff, vec3(0.299, 0.587, 0.114)) * u_intensity;
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
  float vig = smoothstep(u_size, u_size - u_softness, dist);
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
  vec2 px = u_resolution / u_scale;
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
  float f = 1.0 + r2 * u_distortion;
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
    float shift = sin(lum * 50.0 + u_time) * u_intensity * 0.05;
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
      if (u_animate) point = 0.5 + 0.5 * sin(u_time * 0.5 + 6.2831 * point);
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
  uv += (warp - 0.5) * u_strength;
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

  float blur = clamp(abs(depth - u_focus) / u_range, 0.0, 1.0) * u_max_blur;
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
uniform float u_audio_rms;
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
  float audioMult = u_audio_react ? (1.0 + u_audio_rms * 3.0) : 1.0;

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

  // Contrast (around mid-gray)
  col.rgb = (col.rgb - 0.5) * u_contrast + 0.5;

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

  fragColor = vec4(clamp(result, 0.0, 1.0), max(a.a, b.a));
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

  fragColor = vec4(clamp(result, 0.0, 1.0), max(a.a, b.a));
}
`)

export default SHADER_SOURCES
