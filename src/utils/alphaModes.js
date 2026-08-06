/**
 * DaliVid — alphaModes.js
 *
 * How an imported video's alpha channel is INTERPRETED. This is the piece every
 * NLE has and the piece that causes almost every real-world alpha bug: the same
 * RGBA pixels mean different colours depending on whether the encoder wrote
 * STRAIGHT (unassociated) or PREMULTIPLIED (associated) alpha, and nothing in
 * the file reliably says which. Premiere calls it "Interpret Footage → Alpha
 * Channel", After Effects asks "Interpret Unlabeled Alpha As", Resolve puts it
 * in clip attributes. Guess wrong and every keyed edge gets a dark halo (reading
 * premultiplied as straight) or a bright one (reading straight as premultiplied).
 *
 * DaliVid's pipeline is STRAIGHT alpha end to end — `shaderRegistry`'s blend
 * helpers and the source-over in `BlendModes.glsl.js` both assume it — so an
 * imported source is converted to straight once, in the video → `clip_input_`
 * pass, and everything downstream is uniform.
 *
 * This module is deliberately pure (no GL, no DOM): the classifier is the only
 * genuinely subtle bit and keeping it a plain function over a pixel array is
 * what makes it checkable by eye and testable without a GPU.
 */

// ── Modes ────────────────────────────────────────────────────────────────────
// `auto` is a clip-level setting only; it never reaches the shader — the
// renderer's per-source probe resolves it to one of the three real modes.
export const ALPHA_AUTO = 'auto'
export const ALPHA_IGNORE = 'ignore'
export const ALPHA_STRAIGHT = 'straight'
export const ALPHA_PREMULTIPLIED = 'premultiplied'

/** Dropdown model for the Inspector. `hint` explains the symptom, not the theory. */
export const ALPHA_MODES = [
  {
    value: ALPHA_AUTO,
    label: 'Auto-detect',
    hint: 'Inspect the first frames and pick the interpretation that matches.',
  },
  {
    value: ALPHA_IGNORE,
    label: 'Ignore',
    hint: 'Treat the clip as fully opaque, whatever the file claims.',
  },
  {
    value: ALPHA_STRAIGHT,
    label: 'Straight (unmatted)',
    hint: 'Colour is stored at full strength. Wrong choice looks bright/haloed at the edges.',
  },
  {
    value: ALPHA_PREMULTIPLIED,
    label: 'Premultiplied (matted)',
    hint: 'Colour is already multiplied by alpha. Wrong choice looks dark/fringed at the edges.',
  },
]

/** Short labels for the detected-mode readout. */
export const ALPHA_DETECTION_LABELS = {
  [ALPHA_IGNORE]: 'No alpha channel',
  [ALPHA_STRAIGHT]: 'Straight',
  [ALPHA_PREMULTIPLIED]: 'Premultiplied',
}

/**
 * Mode → the `u_alpha_mode` int the interpret shader switches on.
 * MUST stay in sync with ALPHA_INTERPRET_FS in Renderer.js.
 */
export const ALPHA_MODE_INDEX = {
  [ALPHA_IGNORE]: 0,
  [ALPHA_STRAIGHT]: 1,
  [ALPHA_PREMULTIPLIED]: 2,
}

/**
 * Resolve a clip's setting to a concrete mode.
 *
 * The fallback while `auto` is still un-probed is STRAIGHT rather than the
 * detected-default IGNORE, because straight is a mathematical no-op: it copies
 * the texture through untouched, so the first frame or two of a clip can never
 * look *worse* than today's behaviour while detection settles.
 */
export function resolveAlphaMode(clipMode, detected) {
  const mode = clipMode || ALPHA_AUTO
  if (mode !== ALPHA_AUTO) return ALPHA_MODE_INDEX[mode] != null ? mode : ALPHA_STRAIGHT
  return detected || ALPHA_STRAIGHT
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Probe grid edge, in samples. 64×64 = 4096 point samples spread over the frame
 * — enough coverage that a lower-third or a keyed subject lands in the sample
 * set, small enough that the (synchronous) readPixels costs ~16KB and happens
 * only a handful of times per source, ever.
 */
export const ALPHA_PROBE_SIZE = 64

/**
 * How many distinct frames to probe before giving up on finding alpha. A clip
 * can legitimately open on a fully opaque frame (a logo that fades in), so one
 * look is not enough; but detection must terminate, or a long opaque clip pays
 * a readPixels stall forever.
 */
export const ALPHA_PROBE_MAX_ATTEMPTS = 6

// A sample at or above this alpha is "opaque" for classification. Not 255:
// VP9 carries alpha as a second YUV plane, so full opacity routinely arrives as
// 252-254 after conversion.
const OPAQUE_ALPHA = 250

// How far RGB may exceed alpha before it counts as evidence of straight alpha.
// Premultiplied data satisfies rgb <= a by construction, but 4:2:0 chroma
// subsampling smears colour across the alpha edge and can push a premultiplied
// edge pixel a little over the line. This threshold is set well beyond that
// noise floor so ordinary keyed footage is not misread.
const STRONG_OVERSHOOT = 28

// Below this many translucent samples the source is treated as opaque. Isolated
// hits are far more likely to be codec noise than a real alpha channel.
const MIN_TRANSLUCENT = 12

// Fraction of translucent samples that must overshoot strongly before the
// source is called straight. A couple of stray pixels are not a verdict.
const STRAIGHT_RATIO = 0.02

/**
 * Classify a block of RGBA8 samples as opaque / premultiplied / straight.
 *
 * The whole test rests on one invariant: **premultiplied colour can never
 * exceed its own alpha**, because it was produced by multiplying by it. So a
 * sample with, say, rgb = (255, 240, 200) at a = 30 cannot be premultiplied —
 * it must be straight colour sitting behind a low alpha. The converse is not
 * provable (straight footage whose translucent pixels happen to be dark looks
 * exactly like premultiplied footage), which is why this returns a best guess
 * and the Inspector always offers a manual override.
 *
 * @param {Uint8Array} pixels — RGBA8, length = 4 × sample count
 * @returns {{ mode: string, translucent: number, overshoot: number, samples: number }}
 */
export function classifyAlphaSample(pixels) {
  let translucent = 0
  let overshoot = 0

  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]
    if (a >= OPAQUE_ALPHA) continue
    translucent++
    const maxRGB = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
    if (maxRGB > a + STRONG_OVERSHOOT) overshoot++
  }

  const samples = pixels.length >> 2
  if (translucent < MIN_TRANSLUCENT) {
    return { mode: ALPHA_IGNORE, translucent, overshoot, samples }
  }
  const straight = overshoot >= Math.max(2, translucent * STRAIGHT_RATIO)
  return {
    mode: straight ? ALPHA_STRAIGHT : ALPHA_PREMULTIPLIED,
    translucent,
    overshoot,
    samples,
  }
}

/**
 * The key a clip's alpha detection is cached under. Filename, so that splitting
 * or duplicating a clip reuses the probe instead of re-running it, and so the
 * Inspector can report a detection made on a different instance of the same
 * media. Falls back to the blob URL, then the clip id.
 */
export function alphaSourceKey(clip) {
  if (!clip) return null
  return clip.filename || clip.fileUrl || clip.id || null
}
