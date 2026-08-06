/**
 * DaliVid — lib3d.glsl.js
 * Shared GLSL helpers for the 3D / Depth node family.
 *
 * WHY a header string and not per-shader copies: six shaders need the same depth
 * sampling, normal reconstruction and disc-sampling maths. Concatenating one
 * source of truth into each `registerShader` call is the same pattern as
 * `TRANSITION_HEADER` / `BlendModes.glsl.js` — and because the concatenation
 * happens at registration, `getNodeSource`, the Monaco editor and the shader
 * smoke test all see the fully assembled shader, so nothing needs to know these
 * helpers were injected.
 *
 * INVARIANT: nothing in here references a `u_*` uniform. Every helper takes what
 * it needs as an argument. That keeps the header order-independent (it can sit
 * before or after the uniform block) and keeps the smoke test's
 * undeclared-uniform check meaningful instead of tripping on the library.
 *
 * DEPTH CONVENTION for the whole family: **0.0 = near, 1.0 = far.** Depth maps
 * are read as luma, so an unwired depth input (which the executor falls back to
 * the colour image for) still yields a usable — if crude — depth signal, and a
 * DEPTH node, a painted SHAPE_INPUT gradient, or a real depth-map video are all
 * interchangeable on the same socket.
 */

export const LIB3D = `
// ═══════════════════════════════════════════════════════════════════════════
//  lib3d — shared depth / 3D helpers (auto-included; see lib3d.glsl.js)
//  Depth convention: 0.0 = near, 1.0 = far.
// ═══════════════════════════════════════════════════════════════════════════

const float D3_TAU = 6.28318530718;
const float D3_GOLDEN_ANGLE = 2.39996323;

float d3_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

mat2 d3_rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Interleaved gradient noise (Jimenez). Cheap, and its spectrum is close enough
// to blue noise that under-sampling reads as fine dither rather than as banding
// or as a visible rotating pattern. Used to rotate each pixel's sample spiral.
float d3_ign(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

float d3_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ── depth sampling ─────────────────────────────────────────────────────────

// Remap a raw 0..1 sample into usable depth: optional invert, then a near/far
// window, so a low-contrast depth map can be stretched over the full range.
float d3_remapDepth(float d, float doInvert, float dNear, float dFar) {
  d = mix(d, 1.0 - d, doInvert);
  return clamp((d - dNear) / max(1e-4, dFar - dNear), 0.0, 1.0);
}

float d3_depthAt(sampler2D depthTex, vec2 uv, float doInvert, float dNear, float dFar) {
  return d3_remapDepth(d3_luma(texture(depthTex, uv).rgb), doInvert, dNear, dFar);
}

// Surface normal from a depth map, in view space (+z toward the viewer).
//
// The one subtlety that matters: across a silhouette one of the two one-sided
// differences straddles the depth discontinuity and returns a huge bogus
// gradient, which smears the normal — and therefore the lighting — across the
// edge. Taking the SMALLER-magnitude difference on each axis keeps the normal
// attached to the surface it belongs to. This is the standard deferred-shading
// fix and it costs one extra compare, not extra taps.
vec3 d3_normalFromDepth(sampler2D depthTex, vec2 uv, vec2 texel, float radius,
                        float strength, float doInvert, float dNear, float dFar) {
  vec2 o = texel * max(1.0, radius);
  float c = d3_depthAt(depthTex, uv, doInvert, dNear, dFar);
  float dl = d3_depthAt(depthTex, uv - vec2(o.x, 0.0), doInvert, dNear, dFar);
  float dr = d3_depthAt(depthTex, uv + vec2(o.x, 0.0), doInvert, dNear, dFar);
  float dd = d3_depthAt(depthTex, uv - vec2(0.0, o.y), doInvert, dNear, dFar);
  float du = d3_depthAt(depthTex, uv + vec2(0.0, o.y), doInvert, dNear, dFar);

  float gxL = c - dl, gxR = dr - c;
  float gyD = c - dd, gyU = du - c;
  float gx = abs(gxL) < abs(gxR) ? gxL : gxR;
  float gy = abs(gyD) < abs(gyU) ? gyD : gyU;

  // Height = -depth (near is tall), so the heightfield normal is
  // normalize(vec3(d(depth)/dx, d(depth)/dy, 1)) once the sign is folded in.
  return normalize(vec3(gx * strength, gy * strength, 1.0));
}

// ── disc sampling ──────────────────────────────────────────────────────────

// Golden-angle (Vogel) disc sampling: \`count\` points at even density across the
// unit disc, generated in closed form with no lookup table. This is what makes
// constant-cost blur possible — tap count is independent of radius, so a 40px
// bokeh costs exactly what a 4px one does. Rotate per pixel with d3_ign and a
// 32-tap spiral resolves like a far larger kernel.
vec2 d3_vogel(int i, int count, float rotation) {
  float fi = float(i) + 0.5;
  float r = sqrt(fi / float(count));
  float theta = fi * D3_GOLDEN_ANGLE + rotation;
  return vec2(cos(theta), sin(theta)) * r;
}

// Warp a unit-disc sample onto an aperture shape. blades < 3 leaves the disc
// round; squeeze gives anamorphic ovals; swirl rotates samples with radius,
// which is what produces Petzval / "swirly" bokeh. All of it is a couple of
// trig calls on a sample offset we were computing anyway.
vec2 d3_aperture(vec2 s, float blades, float bladeRot, float squeeze, float swirl) {
  float r = length(s);
  if (r > 1e-5) {
    if (blades >= 3.0) {
      float seg = D3_TAU / blades;
      float a = atan(s.y, s.x) + bladeRot;
      // Circumradius-1 regular polygon: scale the disc by the ratio of the
      // polygon's edge distance at this angle to its circumradius.
      s *= cos(seg * 0.5) / max(1e-4, cos(mod(a, seg) - seg * 0.5));
    }
    s = d3_rot2(swirl * r) * s;
  }
  s.x *= max(0.05, squeeze);
  return s;
}

// ── parallax ───────────────────────────────────────────────────────────────

// Parallax occlusion mapping (a.k.a. relief mapping) in UV space — the thing
// that separates real 2.5D from a warped bedsheet.
//
// A single-tap parallax (uv += depth * camOffset) is what most tools ship: it
// slides pixels around but nothing ever OCCLUDES anything, so the frame reads as
// a rubber sheet. Here the view ray is actually marched through the depth field,
// so a near object hides what is behind it and you get silhouettes.
//
// Heights are 1 - depth, so near = tall, and the ray starts at the top layer and
// descends. \`steps\` linear steps locate the crossing; \`refine\` binary steps
// bisect it, which is what removes the stair-stepping for far less cost than
// simply using more linear steps.
//
// \`jump\` reports the largest height discontinuity the ray crossed. That is free
// — the samples were taken anyway — and it is how a consumer detects
// disocclusion (the region revealed by moving the camera, which was never
// filmed and therefore has to be invented).
vec2 d3_pom(sampler2D depthTex, vec2 uv0, vec2 P, int steps, int refine,
            float doInvert, float dNear, float dFar, out float jump) {
  jump = 0.0;
  int nSteps = clamp(steps, 1, 32);
  float dl = 1.0 / float(nSteps);
  vec2 duv = P * dl;

  float layer = 1.0;
  vec2 uv = uv0;
  float h = 1.0 - d3_depthAt(depthTex, uv, doInvert, dNear, dFar);

  for (int i = 0; i < 32; i++) {
    if (i >= nSteps) break;
    if (h >= layer) break;          // ray has passed behind the surface
    layer -= dl;
    uv += duv;
    float hPrev = h;
    h = 1.0 - d3_depthAt(depthTex, uv, doInvert, dNear, dFar);
    jump = max(jump, abs(h - hPrev));
  }

  // Bisect between the last sample above the surface and the first below it.
  vec2 uvLo = uv - duv; float lLo = layer + dl;   // above
  vec2 uvHi = uv;       float lHi = layer;        // below
  for (int i = 0; i < 8; i++) {
    if (i >= refine) break;
    vec2 uvM = (uvLo + uvHi) * 0.5;
    float lM = (lLo + lHi) * 0.5;
    if (1.0 - d3_depthAt(depthTex, uvM, doInvert, dNear, dFar) >= lM) {
      uvHi = uvM; lHi = lM;
    } else {
      uvLo = uvM; lLo = lM;
    }
  }
  return uvHi;
}

// Screen-space parallax vector for a virtual camera translation.
//
// One formula covers pan, dolly and orbit: a Z translation produces parallax
// proportional to the distance from the principal point (that IS what a dolly
// looks like), while X/Y produce a uniform shift. Dividing x by the aspect ratio
// keeps the motion isotropic in PIXELS rather than in UV, so a horizontal move
// travels as far as a vertical one of the same magnitude.
vec2 d3_camVector(vec2 uv, vec2 pivot, vec2 camXY, float camZ, float aspect) {
  vec2 v = camXY + (uv - pivot) * camZ;
  v.x /= max(1e-3, aspect);
  return v;
}

// ── neighbourhood probe ────────────────────────────────────────────────────

// One 8-tap ring, two results: an edge-preserving (joint bilateral) smoothed
// colour AND the local luma contrast.
//
// Sharing the ring is the whole trick. Local contrast is the strongest
// monocular depth cue there is (what is in focus is near), and the bilateral
// smoothing is what stops estimated depth from boiling inside a textured
// surface — but both are questions about the same neighbourhood, so asking them
// separately would cost 16 taps for information that 8 taps already contain.
//
// Note this smooths the colour the cues are computed FROM, rather than
// bilaterally filtering finished depth: filtering the output would mean
// re-running the whole cue stack at every tap.
void d3_ringProbe(sampler2D tex, vec2 uv, vec2 texel, float radius, float sigma,
                  out vec3 smoothColor, out float contrast) {
  vec3 c0 = texture(tex, uv).rgb;
  float l0 = d3_luma(c0);
  if (radius < 0.5) {
    smoothColor = c0;
    contrast = 0.0;
    return;
  }
  vec3 sum = c0;
  float wsum = 1.0;
  float m = l0, m2 = l0 * l0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * (D3_TAU / 8.0);
    vec3 c = texture(tex, uv + vec2(cos(a), sin(a)) * texel * radius).rgb;
    float l = d3_luma(c);
    m += l;
    m2 += l * l;
    // Colour-similarity weight: a tap across an object boundary contributes ~0,
    // so the smoothing flattens interiors without crossing silhouettes.
    vec3 dc = c - c0;
    float w = exp(-dot(dc, dc) / max(1e-4, sigma * sigma));
    sum += c * w;
    wsum += w;
  }
  m /= 9.0;
  m2 /= 9.0;
  smoothColor = sum / wsum;
  contrast = sqrt(max(0.0, m2 - m * m));
}

// ── colour ─────────────────────────────────────────────────────────────────

// Depth-tint gradients for fog and aerial perspective. t = 0 near, 1 far.
vec3 d3_depthGradient(int idx, float t) {
  if (idx == 0) return mix(vec3(0.85, 0.88, 0.92), vec3(0.55, 0.62, 0.72), t);  // Overcast
  if (idx == 1) return mix(vec3(1.0, 0.82, 0.60), vec3(0.35, 0.52, 0.78), t);   // Warm → Cool
  if (idx == 2) return mix(vec3(1.0, 0.70, 0.40), vec3(0.10, 0.42, 0.48), t);   // Teal / Orange
  if (idx == 3) return mix(vec3(0.42, 0.50, 0.72), vec3(0.10, 0.14, 0.30), t);  // Blue Hour
  if (idx == 4) return mix(vec3(1.0, 0.55, 0.35), vec3(0.60, 0.35, 0.55), t);   // Sunset Haze
  if (idx == 5) return mix(vec3(0.06, 0.08, 0.12), vec3(0.02, 0.03, 0.06), t);  // Night
  return mix(vec3(0.60, 1.0, 0.55), vec3(0.05, 0.25, 0.20), t);                 // Toxic
}

// Perceptual "turbo"-ish ramp — inspection only (Depth/AO/CoC preview modes).
vec3 d3_falseColor(float t) {
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(
    1.5 - abs(4.0 * t - 3.0),
    1.5 - abs(4.0 * t - 2.0),
    1.5 - abs(4.0 * t - 1.0)
  ), 0.0, 1.0);
}

float d3_saturation(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return (mx - mn) / max(1e-4, mx);
}

vec3 d3_desaturate(vec3 c, float amt) {
  return mix(c, vec3(d3_luma(c)), clamp(amt, 0.0, 1.0));
}
// ═══════════════════════════════════════════════════════════════════════════
`
