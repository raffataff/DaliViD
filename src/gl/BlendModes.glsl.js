/**
 * DaliVid — BlendModes.glsl.js
 * All 30 blend mode implementations as GLSL functions.
 * These are injected into composite shader programs.
 */

export const BLEND_MODE_NAMES = [
  'Normal', 'Dissolve', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn',
  'Darker Color', 'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)',
  'Lighter Color', 'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light',
  'Linear Light', 'Pin Light', 'Hard Mix', 'Difference', 'Exclusion',
  'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity',
  'Plus (Additive)', 'Minus', 'Multiply Alpha',
]

/**
 * GLSL blend mode helper functions + main blend dispatcher.
 * Include this at the top of any compositing fragment shader.
 */
export const BLEND_MODES_GLSL = `
// ── HSL Helpers ──────────────────────────────────────
vec3 blendRGBtoHSL(vec3 c) {
  float mn = min(min(c.r, c.g), c.b);
  float mx = max(max(c.r, c.g), c.b);
  float d = mx - mn;
  float l = (mx + mn) * 0.5;
  if (d < 0.00001) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

float blendHue2RGB(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0/2.0) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

vec3 blendHSLtoRGB(vec3 hsl) {
  if (hsl.y < 0.00001) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    blendHue2RGB(p, q, hsl.x + 1.0/3.0),
    blendHue2RGB(p, q, hsl.x),
    blendHue2RGB(p, q, hsl.x - 1.0/3.0)
  );
}

float blendLuminance(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// ── Individual Blend Modes ──────────────────────────
vec3 blendNormal(vec3 base, vec3 blend) { return blend; }
vec3 blendMultiply(vec3 base, vec3 blend) { return base * blend; }
vec3 blendScreen(vec3 base, vec3 blend) { return 1.0 - (1.0 - base) * (1.0 - blend); }
vec3 blendDarken(vec3 base, vec3 blend) { return min(base, blend); }
vec3 blendLighten(vec3 base, vec3 blend) { return max(base, blend); }

vec3 blendOverlay(vec3 base, vec3 blend) {
  return vec3(
    base.r < 0.5 ? 2.0 * base.r * blend.r : 1.0 - 2.0 * (1.0 - base.r) * (1.0 - blend.r),
    base.g < 0.5 ? 2.0 * base.g * blend.g : 1.0 - 2.0 * (1.0 - base.g) * (1.0 - blend.g),
    base.b < 0.5 ? 2.0 * base.b * blend.b : 1.0 - 2.0 * (1.0 - base.b) * (1.0 - blend.b)
  );
}

vec3 blendSoftLight(vec3 base, vec3 blend) {
  return vec3(
    blend.r < 0.5 ? 2.0*base.r*blend.r + base.r*base.r*(1.0-2.0*blend.r) : sqrt(base.r)*(2.0*blend.r-1.0) + 2.0*base.r*(1.0-blend.r),
    blend.g < 0.5 ? 2.0*base.g*blend.g + base.g*base.g*(1.0-2.0*blend.g) : sqrt(base.g)*(2.0*blend.g-1.0) + 2.0*base.g*(1.0-blend.g),
    blend.b < 0.5 ? 2.0*base.b*blend.b + base.b*base.b*(1.0-2.0*blend.b) : sqrt(base.b)*(2.0*blend.b-1.0) + 2.0*base.b*(1.0-blend.b)
  );
}

vec3 blendHardLight(vec3 base, vec3 blend) { return blendOverlay(blend, base); }

vec3 blendColorDodge(vec3 base, vec3 blend) {
  return vec3(
    blend.r >= 1.0 ? 1.0 : min(1.0, base.r / (1.0 - blend.r)),
    blend.g >= 1.0 ? 1.0 : min(1.0, base.g / (1.0 - blend.g)),
    blend.b >= 1.0 ? 1.0 : min(1.0, base.b / (1.0 - blend.b))
  );
}

vec3 blendColorBurn(vec3 base, vec3 blend) {
  return vec3(
    blend.r <= 0.0 ? 0.0 : max(0.0, 1.0 - (1.0 - base.r) / blend.r),
    blend.g <= 0.0 ? 0.0 : max(0.0, 1.0 - (1.0 - base.g) / blend.g),
    blend.b <= 0.0 ? 0.0 : max(0.0, 1.0 - (1.0 - base.b) / blend.b)
  );
}

vec3 blendLinearDodge(vec3 base, vec3 blend) { return min(vec3(1.0), base + blend); }
vec3 blendLinearBurn(vec3 base, vec3 blend) { return max(vec3(0.0), base + blend - 1.0); }

vec3 blendVividLight(vec3 base, vec3 blend) {
  return vec3(
    blend.r < 0.5 ? max(0.0, 1.0 - (1.0 - base.r) / (2.0 * blend.r)) : min(1.0, base.r / (2.0 * (1.0 - blend.r))),
    blend.g < 0.5 ? max(0.0, 1.0 - (1.0 - base.g) / (2.0 * blend.g)) : min(1.0, base.g / (2.0 * (1.0 - blend.g))),
    blend.b < 0.5 ? max(0.0, 1.0 - (1.0 - base.b) / (2.0 * blend.b)) : min(1.0, base.b / (2.0 * (1.0 - blend.b)))
  );
}

vec3 blendLinearLight(vec3 base, vec3 blend) {
  return clamp(base + 2.0 * blend - 1.0, 0.0, 1.0);
}

vec3 blendPinLight(vec3 base, vec3 blend) {
  return vec3(
    blend.r < 0.5 ? min(base.r, 2.0 * blend.r) : max(base.r, 2.0 * blend.r - 1.0),
    blend.g < 0.5 ? min(base.g, 2.0 * blend.g) : max(base.g, 2.0 * blend.g - 1.0),
    blend.b < 0.5 ? min(base.b, 2.0 * blend.b) : max(base.b, 2.0 * blend.b - 1.0)
  );
}

vec3 blendHardMix(vec3 base, vec3 blend) {
  return step(1.0, base + blend);
}

vec3 blendDifference(vec3 base, vec3 blend) { return abs(base - blend); }
vec3 blendExclusion(vec3 base, vec3 blend) { return base + blend - 2.0 * base * blend; }
vec3 blendSubtract(vec3 base, vec3 blend) { return max(vec3(0.0), base - blend); }

vec3 blendDivide(vec3 base, vec3 blend) {
  return vec3(
    blend.r < 0.001 ? 1.0 : min(1.0, base.r / blend.r),
    blend.g < 0.001 ? 1.0 : min(1.0, base.g / blend.g),
    blend.b < 0.001 ? 1.0 : min(1.0, base.b / blend.b)
  );
}

vec3 blendDarkerColor(vec3 base, vec3 blend) {
  return blendLuminance(base) < blendLuminance(blend) ? base : blend;
}
vec3 blendLighterColor(vec3 base, vec3 blend) {
  return blendLuminance(base) > blendLuminance(blend) ? base : blend;
}

vec3 blendHue(vec3 base, vec3 blend) {
  vec3 bHSL = blendRGBtoHSL(base);
  vec3 lHSL = blendRGBtoHSL(blend);
  return blendHSLtoRGB(vec3(lHSL.x, bHSL.y, bHSL.z));
}

vec3 blendSaturation(vec3 base, vec3 blend) {
  vec3 bHSL = blendRGBtoHSL(base);
  vec3 lHSL = blendRGBtoHSL(blend);
  return blendHSLtoRGB(vec3(bHSL.x, lHSL.y, bHSL.z));
}

vec3 blendColor(vec3 base, vec3 blend) {
  vec3 bHSL = blendRGBtoHSL(base);
  vec3 lHSL = blendRGBtoHSL(blend);
  return blendHSLtoRGB(vec3(lHSL.x, lHSL.y, bHSL.z));
}

vec3 blendLuminosity(vec3 base, vec3 blend) {
  vec3 bHSL = blendRGBtoHSL(base);
  vec3 lHSL = blendRGBtoHSL(blend);
  return blendHSLtoRGB(vec3(bHSL.x, bHSL.y, lHSL.z));
}

vec3 blendPlus(vec3 base, vec3 blend) { return min(vec3(1.0), base + blend); }
vec3 blendMinus(vec3 base, vec3 blend) { return max(vec3(0.0), base - blend); }

// ── Blend Mode Dispatcher ──────────────────────────
// mode: 0=Normal, 1=Dissolve, 2=Darken, 3=Multiply, 4=ColorBurn, 5=LinearBurn,
//       6=DarkerColor, 7=Lighten, 8=Screen, 9=ColorDodge, 10=LinearDodge,
//       11=LighterColor, 12=Overlay, 13=SoftLight, 14=HardLight, 15=VividLight,
//       16=LinearLight, 17=PinLight, 18=HardMix, 19=Difference, 20=Exclusion,
//       21=Subtract, 22=Divide, 23=Hue, 24=Saturation, 25=Color, 26=Luminosity,
//       27=Plus, 28=Minus, 29=MultiplyAlpha

vec4 applyBlendMode(vec4 base, vec4 blend, int mode, float opacity) {
  vec3 result;
  if (mode == 0) result = blendNormal(base.rgb, blend.rgb);
  else if (mode == 1) result = blend.rgb; // Dissolve handled separately with noise
  else if (mode == 2) result = blendDarken(base.rgb, blend.rgb);
  else if (mode == 3) result = blendMultiply(base.rgb, blend.rgb);
  else if (mode == 4) result = blendColorBurn(base.rgb, blend.rgb);
  else if (mode == 5) result = blendLinearBurn(base.rgb, blend.rgb);
  else if (mode == 6) result = blendDarkerColor(base.rgb, blend.rgb);
  else if (mode == 7) result = blendLighten(base.rgb, blend.rgb);
  else if (mode == 8) result = blendScreen(base.rgb, blend.rgb);
  else if (mode == 9) result = blendColorDodge(base.rgb, blend.rgb);
  else if (mode == 10) result = blendLinearDodge(base.rgb, blend.rgb);
  else if (mode == 11) result = blendLighterColor(base.rgb, blend.rgb);
  else if (mode == 12) result = blendOverlay(base.rgb, blend.rgb);
  else if (mode == 13) result = blendSoftLight(base.rgb, blend.rgb);
  else if (mode == 14) result = blendHardLight(base.rgb, blend.rgb);
  else if (mode == 15) result = blendVividLight(base.rgb, blend.rgb);
  else if (mode == 16) result = blendLinearLight(base.rgb, blend.rgb);
  else if (mode == 17) result = blendPinLight(base.rgb, blend.rgb);
  else if (mode == 18) result = blendHardMix(base.rgb, blend.rgb);
  else if (mode == 19) result = blendDifference(base.rgb, blend.rgb);
  else if (mode == 20) result = blendExclusion(base.rgb, blend.rgb);
  else if (mode == 21) result = blendSubtract(base.rgb, blend.rgb);
  else if (mode == 22) result = blendDivide(base.rgb, blend.rgb);
  else if (mode == 23) result = blendHue(base.rgb, blend.rgb);
  else if (mode == 24) result = blendSaturation(base.rgb, blend.rgb);
  else if (mode == 25) result = blendColor(base.rgb, blend.rgb);
  else if (mode == 26) result = blendLuminosity(base.rgb, blend.rgb);
  else if (mode == 27) result = blendPlus(base.rgb, blend.rgb);
  else if (mode == 28) result = blendMinus(base.rgb, blend.rgb);
  else if (mode == 29) result = base.rgb * blend.a; // Multiply Alpha
  else result = blend.rgb;

  // Apply opacity and alpha compositing (Normal/Over formula)
  float a = blend.a * opacity;
  vec3 composited = result * a + base.rgb * (1.0 - a);
  float outA = a + base.a * (1.0 - a);
  return vec4(composited, outA);
}
`

/**
 * Get the integer index for a blend mode name.
 */
export function getBlendModeIndex(name) {
  const idx = BLEND_MODE_NAMES.indexOf(name)
  return idx === -1 ? 0 : idx
}
