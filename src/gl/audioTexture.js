/**
 * DaliVid — audioTexture.js
 * High-resolution audio analysis, published to the GPU as textures.
 *
 * WHY THIS EXISTS
 * ---------------
 * `u_audio_bands[8]` is eight numbers. That is enough to *drive* an effect
 * (pump a glow, punch a zoom) but nowhere near enough to *draw* audio: eight
 * buckets is why every bar visualiser in the app looked like a chunky EQ from
 * 1998. Real visualisers want the whole spectrum, the raw waveform, and — the
 * thing you cannot fake from a scalar — the recent HISTORY of the spectrum,
 * which is what turns a still picture into a waterfall, a tunnel or a terrain.
 *
 * So every frame we publish two small textures, shared by every shader:
 *
 *   u_audio_tex   512 × 8, R8. Rows of "right now" (sample at v = (row+0.5)/8):
 *     row 0 (v = 0.0625) — LOG spectrum, 20 Hz → 20 kHz across x. Log because
 *                          music is log: linear FFT bins spend half the width on
 *                          6 kHz–22 kHz where there is almost nothing to see.
 *     row 1 (v = 0.1875) — LINEAR spectrum (raw FFT bins), for anything that
 *                          wants the physical bin layout.
 *     row 2 (v = 0.3125) — WAVEFORM, 0.5 = silence. Zero-crossing triggered, so
 *                          an oscilloscope locks instead of skating sideways.
 *     row 3 (v = 0.4375) — PEAK HOLD of row 0 (fast attack, slow fall) — the
 *                          classic falling caps on top of bars.
 *     row 4 (v = 0.5625) — row 0, BLURRED across frequency.
 *     row 5 (v = 0.6875) — row 3, blurred. Rows 4/5 exist so a shader's
 *                          "spectral smoothing" control is one fetch and a mix
 *                          instead of a five-tap loop repeated per iteration.
 *
 *   u_audio_hist  512 × 128, R8. A ring buffer of row 0, one row per rendered
 *                 frame. `u_audio_head` is the newest row index and
 *                 `u_audio_rows` the ring size, so a shader can address any
 *                 moment in the last ~2 seconds:
 *                     row = mod(u_audio_head - age * (rows - 1), rows)
 *
 * COST: one 2 KB and one 512 B texSubImage2D per frame, plus ~1500 float ops
 * on the CPU. Nothing here scales with resolution.
 *
 * The textures live per-GL-context in a WeakMap, are created lazily on first
 * use, and are bound to RESERVED high texture units (7 and 8) so they can never
 * collide with the pass units (0 = input, 1 = prev frame, 2+ = extra inputs).
 */

/** Frequency samples across the spectrum / waveform rows. */
export const SPEC_W = 512
/**
 * Rows in u_audio_tex. Rows 4 and 5 are PRE-SMOOTHED copies of rows 0 and 3:
 * spectral smoothing used to cost five texture fetches per lookup in the
 * shader, multiplied by every loop iteration in Rings / Particles / Prism.
 * Blurring 512 samples once on the CPU costs ~6k multiplies for the whole frame
 * and turns that into one fetch and a mix.
 */
const SPEC_ROWS = 8
/** Frames of spectrum history kept in the ring buffer (~2.1 s at 60 fps). */
export const HIST_ROWS = 128

/** Reserved texture units — deliberately above anything the executor uses. */
export const AUDIO_TEX_UNIT = 7
export const AUDIO_HIST_UNIT = 8

const LO_HZ = 20
const HI_HZ = 20000

// gl → per-context state. WeakMap so a disposed context is collected with it.
const contexts = new WeakMap()

/**
 * Column → FFT-bin mapping for the log row. Rebuilt only when the sample rate
 * or FFT size changes (i.e. essentially never), because the pow() per column is
 * the one genuinely expensive part of this file.
 */
function buildLogMap(binCount, hzPerBin) {
  const map = new Float32Array(SPEC_W * 3) // [startBin, endBin, fractionalBin]
  const ratio = HI_HZ / LO_HZ
  for (let x = 0; x < SPEC_W; x++) {
    const f0 = LO_HZ * Math.pow(ratio, x / SPEC_W)
    const f1 = LO_HZ * Math.pow(ratio, (x + 1) / SPEC_W)
    const b0 = Math.max(0, Math.min(binCount - 1, Math.floor(f0 / hzPerBin)))
    const b1 = Math.max(b0 + 1, Math.min(binCount, Math.ceil(f1 / hzPerBin)))
    map[x * 3] = b0
    map[x * 3 + 1] = b1
    // Fractional bin position of the band centre — used to INTERPOLATE in the
    // bass, where several columns share one bin and a nearest-bin read would
    // draw visible stair steps under 200 Hz.
    map[x * 3 + 2] = Math.min(binCount - 1.001, (Math.sqrt(f0 * f1)) / hzPerBin)
  }
  return map
}

const BLUR_R = 5

/**
 * Two box passes = a triangular blur, O(n) with a running sum. `tmp` and `dst`
 * are reused per frame so this allocates nothing.
 */
function boxBlur(src, dst, tmp) {
  const w = 2 * BLUR_R + 1
  let sum = 0
  for (let i = 0; i <= BLUR_R; i++) sum += src[i]
  for (let i = BLUR_R + 1; i <= 2 * BLUR_R; i++) sum += src[Math.min(SPEC_W - 1, i)]
  for (let x = 0; x < SPEC_W; x++) {
    tmp[x] = sum / w
    const out = src[Math.max(0, x - BLUR_R)]
    const inc = src[Math.min(SPEC_W - 1, x + BLUR_R + 1)]
    sum += inc - out
  }
  sum = 0
  for (let i = 0; i <= BLUR_R; i++) sum += tmp[i]
  for (let i = BLUR_R + 1; i <= 2 * BLUR_R; i++) sum += tmp[Math.min(SPEC_W - 1, i)]
  for (let x = 0; x < SPEC_W; x++) {
    dst[x] = sum / w
    const out = tmp[Math.max(0, x - BLUR_R)]
    const inc = tmp[Math.min(SPEC_W - 1, x + BLUR_R + 1)]
    sum += inc - out
  }
}

function createState(gl) {
  const specTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, specTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SPEC_W, SPEC_ROWS, 0, gl.RED, gl.UNSIGNED_BYTE, null)
  // LINEAR across x so bars/curves interpolate smoothly between bins.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const histTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, histTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SPEC_W, HIST_ROWS, 0, gl.RED, gl.UNSIGNED_BYTE, null)
  // LINEAR here too: the time axis of a waterfall reads far better interpolated.
  // The ring's wrap seam blends two frames a full buffer apart, which is why
  // every consumer fades the oldest few percent of `age` to nothing.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.bindTexture(gl.TEXTURE_2D, null)

  const state = {
    specTex,
    histTex,
    specData: new Uint8Array(SPEC_W * SPEC_ROWS),
    rowData: new Uint8Array(SPEC_W),
    // Analysis working state (floats 0..1, converted to bytes on upload).
    smoothed: new Float32Array(SPEC_W),
    peaks: new Float32Array(SPEC_W),
    blurA: new Float32Array(SPEC_W),
    blurB: new Float32Array(SPEC_W),
    blurC: new Float32Array(SPEC_W),
    blurD: new Float32Array(SPEC_W),
    logMap: null,
    mapKey: '',
    head: 0,
    lastFrame: -1,
    seeded: false,
  }
  contexts.set(gl, state)
  return state
}

/**
 * Fill `state.specData` from the engine's live analyser arrays.
 * Returns false when there is no analysis yet (so we can upload silence once
 * and then leave the textures alone until audio actually starts).
 */
function analyse(state, engine) {
  const freq = engine?.freqData
  const time = engine?.timeData
  const analyser = engine?.analyser
  if (!freq || !time || !analyser) return false

  const binCount = analyser.frequencyBinCount
  const sampleRate = engine.ctx?.sampleRate || 44100
  const fftSize = engine.fftSize || (binCount * 2)
  const hzPerBin = sampleRate / fftSize

  const key = `${binCount}:${hzPerBin.toFixed(4)}`
  if (state.mapKey !== key) {
    state.logMap = buildLogMap(binCount, hzPerBin)
    state.mapKey = key
  }
  const map = state.logMap
  const out = state.specData
  const sm = state.smoothed
  const pk = state.peaks

  for (let x = 0; x < SPEC_W; x++) {
    const b0 = map[x * 3]
    const b1 = map[x * 3 + 1]
    let v
    if (b1 - b0 <= 1) {
      // Bass end: one bin (or less) per column — interpolate so it reads as a
      // curve rather than a staircase.
      const fb = map[x * 3 + 2]
      const i0 = fb | 0
      const t = fb - i0
      v = (freq[i0] * (1 - t) + freq[i0 + 1] * t) / 255
    } else {
      // Treble end: many bins per column — take the PEAK, not the mean. A mean
      // averages transients away and is why smeared bars look dead; the peak is
      // what the ear picks out anyway.
      let m = 0
      for (let i = b0; i < b1; i++) { const s = freq[i]; if (s > m) m = s }
      v = m / 255
    }

    // Attack/release. Fast up (transients must survive), slow down (so bars
    // fall rather than flicker). Deliberately gentler than the store's band
    // smoothing — this feeds pictures, not parameters.
    const prev = sm[x]
    sm[x] = v > prev ? prev + (v - prev) * 0.55 : prev + (v - prev) * 0.16
    // Peak hold: instant up, ~0.6 s fall.
    const p = pk[x] * 0.972
    pk[x] = v > p ? v : p

    out[x] = (sm[x] * 255) | 0                       // row 0 — log spectrum
    out[SPEC_W + x] = freq[Math.min(binCount - 1, (x * binCount / SPEC_W) | 0)]  // row 1 — linear
    out[SPEC_W * 3 + x] = (pk[x] * 255) | 0          // row 3 — peak hold
  }

  // Rows 4 / 5 — the same two curves, blurred across frequency. A triangular
  // kernel (two box passes) over ~1/4 octave: wide enough to read as "smooth",
  // narrow enough that a bass note still moves its own bars.
  boxBlur(sm, state.blurA, state.blurB)
  boxBlur(pk, state.blurC, state.blurD)
  for (let x = 0; x < SPEC_W; x++) {
    out[SPEC_W * 4 + x] = (Math.min(1, state.blurA[x]) * 255) | 0
    out[SPEC_W * 5 + x] = (Math.min(1, state.blurC[x]) * 255) | 0
  }

  // Row 2 — waveform, triggered on the first RISING zero crossing so the trace
  // is phase-locked. Without this an oscilloscope slides sideways at whatever
  // rate the buffer and the frame clock happen to beat against each other,
  // which is the single most obvious "cheap visualiser" tell.
  const half = time.length >> 1
  let start = 0
  for (let i = 0; i < half - 1; i++) {
    if (time[i] < 128 && time[i + 1] >= 128) { start = i; break }
  }
  const step = Math.max(1, Math.floor(half / SPEC_W))
  for (let x = 0; x < SPEC_W; x++) {
    out[SPEC_W * 2 + x] = time[Math.min(time.length - 1, start + x * step)]
  }
  return true
}

/**
 * Update (and lazily create) the shared audio textures for this context.
 * Call ONCE per rendered frame, before any pass runs.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} engine — the AudioEngine singleton
 * @param {number} [frameId] — renderer frame counter; guards against a double
 *        update inside one frame (which would spend two ring rows on it).
 * @returns {{ head: number, rows: number }} uniform values for the shaders
 */
export function updateAudioTextures(gl, engine, frameId = -1) {
  if (!gl) return { head: 0, rows: HIST_ROWS }
  let state = contexts.get(gl)
  if (!state) state = createState(gl)

  if (frameId >= 0 && frameId === state.lastFrame) {
    return { head: state.head, rows: HIST_ROWS }
  }
  state.lastFrame = frameId

  const live = analyse(state, engine)
  if (!live) {
    // No audio engine yet. Upload silence exactly once so the textures are
    // defined (sampling an uninitialised texture is undefined), then idle.
    if (state.seeded) return { head: state.head, rows: HIST_ROWS }
    state.specData.fill(0)
    for (let x = 0; x < SPEC_W; x++) state.specData[SPEC_W * 2 + x] = 128 // flat line
  }
  state.seeded = true

  const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  gl.activeTexture(gl.TEXTURE0 + AUDIO_TEX_UNIT)
  gl.bindTexture(gl.TEXTURE_2D, state.specTex)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPEC_W, SPEC_ROWS, gl.RED, gl.UNSIGNED_BYTE, state.specData)

  // Advance the ring and write ONE row: the current log spectrum.
  state.head = (state.head + 1) % HIST_ROWS
  state.rowData.set(state.specData.subarray(0, SPEC_W))
  gl.activeTexture(gl.TEXTURE0 + AUDIO_HIST_UNIT)
  gl.bindTexture(gl.TEXTURE_2D, state.histTex)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, state.head, SPEC_W, 1, gl.RED, gl.UNSIGNED_BYTE, state.rowData)

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign)
  gl.activeTexture(gl.TEXTURE0)

  return { head: state.head, rows: HIST_ROWS }
}

/**
 * Bind both audio textures to their reserved units and leave the active unit
 * back on TEXTURE0 (every other binding site in the renderer assumes that).
 * Safe to call before the textures exist — it creates them.
 */
export function bindAudioTextures(gl) {
  if (!gl) return
  let state = contexts.get(gl)
  if (!state) {
    state = createState(gl)
    // Nothing uploaded yet: seed with silence so the sampler reads defined data.
    updateAudioTextures(gl, null, -1)
  }
  gl.activeTexture(gl.TEXTURE0 + AUDIO_TEX_UNIT)
  gl.bindTexture(gl.TEXTURE_2D, state.specTex)
  gl.activeTexture(gl.TEXTURE0 + AUDIO_HIST_UNIT)
  gl.bindTexture(gl.TEXTURE_2D, state.histTex)
  gl.activeTexture(gl.TEXTURE0)
}

/** Free both textures for a context (renderer disposal / context loss). */
export function disposeAudioTextures(gl) {
  const state = contexts.get(gl)
  if (!state) return
  if (state.specTex) gl.deleteTexture(state.specTex)
  if (state.histTex) gl.deleteTexture(state.histTex)
  contexts.delete(gl)
}

export default updateAudioTextures
