#!/usr/bin/env node
/**
 * DaliVid — scripts/verify-feedback-machine.mjs
 *
 * Runtime check for the FEEDBACK_MACHINE node on a REAL WebGL2 context
 * (Playwright + headless Chromium/SwiftShader). The static smoke test validates
 * structure and @param integrity; it cannot see whether the loop is stable,
 * whether it actually grows anything, or whether the delay ring lines up.
 *
 * NOT wired into `npm run lint` and playwright is deliberately NOT a dependency
 * — this is an on-demand harness for GLSL changes, same as verify-feedback.mjs.
 * Run it with playwright available, e.g.
 *   npx --yes playwright@latest install chromium && node scripts/verify-feedback-machine.mjs
 * It launches Chromium with SwiftShader, so no GPU is needed.
 *
 * The history is driven through a JS ring built with the REAL `ringSlots` from
 * src/gl/historyRing.js, so the harness exercises the same slot maths the
 * executor does. Assertions:
 *
 *   1. Stability   — 120 frames of mid grey at the shipped defaults: no NaN,
 *                    every channel inside 0–1, and the picture neither whites
 *                    out nor dies (§6.1). Repeated over 900 frames (15 s).
 *   2. Growth      — one bright square, then black: the lit area at least
 *                    triples in 20 frames (§6.2 — the loop can GROW, which the
 *                    old linear FEEDBACK mix provably cannot).
 *   3. Clip        — Gain 1.5 never puts a channel above 1.0. The clamp IS the
 *                    monitor; without it an RGBA16F buffer runs away.
 *   4. Blow-out    — Auto Level 0 + Gain 1.05 DOES white out (§6.3), proving the
 *                    knobs bite and that assertion 1 is not passing by accident.
 *   5. Delay       — Gain 0 (history contributes nothing) shows a one-frame
 *                    flash exactly once; Gain 1 through a 6-slot ring repeats it
 *                    every 5 frames for 3 cycles.
 *   6. Clear       — Clear Loop outputs the input unchanged.
 *   7. Recipes     — the three documented recipes give clearly different pictures.
 *   8. Regression  — the FEEDBACK shader source is byte-for-byte unchanged.
 */

import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { getShaderSource } from '../src/shaders/shaderRegistry.js'
import { parseParams, getDefaultParams } from '../src/utils/paramParser.js'
import { injectAudioDrivers } from '../src/utils/audioDrivers.js'
import { ringSlots } from '../src/gl/historyRing.js'

// SHA-256 of the FEEDBACK shader source as it stood before the Feedback Machine
// work started. Saved projects must render identically, so this file is the
// tripwire: if it fails, the old node was edited and the change must be undone.
const FEEDBACK_SHA256 = '0566be65e8460e63657aad413e783bd0f196b9a7d55252bb3c2801da5f11213c'

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texcoord;
out vec2 v_uv;
void main() {
  v_uv = a_texcoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const FM_SOURCE = getShaderSource('FEEDBACK_MACHINE')
if (!FM_SOURCE) {
  console.error('FEEDBACK_MACHINE is not registered')
  process.exit(1)
}

// The shipped defaults, read from the shader's own @param lines — so tuning a
// default in the shader re-tunes this harness with it.
const DEFAULTS = getDefaultParams(parseParams(FM_SOURCE))

const PROGRAMS = { fm: injectAudioDrivers(FM_SOURCE) }

// Uniforms the shader declares as int / bool, so the harness uploads them with
// the right call instead of silently doing nothing.
const INT_UNIFORMS = ['u_fm_fold', 'u_fm_edge', 'u_fm_mix', 'u_prev_delay', 'u_fm_res']
const BOOL_UNIFORMS = ['u_fm_clear']

// ── in-page harness ──────────────────────────────────────────────────────────

function pageHarness({ vs, programs, intUniforms, boolUniforms }) {
  const N = 64
  const canvas = document.createElement('canvas')
  canvas.width = N
  canvas.height = N
  const gl = canvas.getContext('webgl2', { antialias: false })
  if (!gl) throw new Error('no webgl2')

  const halfFloat = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'))
  const linearHalf = !!gl.getExtension('OES_texture_float_linear')
  const INTS = new Set(intUniforms)
  const BOOLS = new Set(boolUniforms)

  function compile(type, src) {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  function link(fs) {
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    return p
  }

  const progs = {}
  for (const k in programs) progs[k] = link(programs[k])

  // Fullscreen quad, matching the repo's attribute layout.
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1,
    -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1,
  ]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)

  function makeTarget(mode) {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (mode === 'f16') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, N, N, 0, gl.RGBA, gl.HALF_FLOAT, null)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
    const filter = mode === 'f16' && !linearHalf ? gl.NEAREST : gl.LINEAR
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return { tex, fbo }
  }

  const srcTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, srcTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  function uploadSource(bytes) {
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(bytes))
  }

  function readTarget(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
    const out = new Float32Array(N * N * 4)
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, out)
    if (gl.getError() === gl.NO_ERROR) return Array.from(out)
    const bytes = new Uint8Array(N * N * 4)
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
    return Array.from(bytes, b => b / 255)
  }

  const GATED = ['u_sub_bass', 'u_bass', 'u_low_mid', 'u_mid', 'u_high_mid', 'u_presence', 'u_treble', 'u_rms', 'u_beat']
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

  // One pass, mirroring Renderer.executePass: bind target, clear, bind unit 0 =
  // source, unit 1 = history, unit 2 = input B, upload uniforms, draw the quad.
  function pass(progKey, dst, prevTex, bTex, u) {
    const p = progs[progKey]
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
    gl.viewport(0, 0, N, N)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(p)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    const lt = gl.getUniformLocation(p, 'u_texture')
    if (lt) gl.uniform1i(lt, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, prevTex)
    const lp = gl.getUniformLocation(p, 'u_prev_frame')
    if (lp) gl.uniform1i(lp, 1)

    // An unwired input_b falls back to the primary input, exactly as
    // TEXTURE_INPUT_SOCKETS does in the executor.
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, bTex || srcTex)
    const lb = gl.getUniformLocation(p, 'u_texture_b')
    if (lb) gl.uniform1i(lb, 2)

    const lr = gl.getUniformLocation(p, 'u_resolution')
    if (lr) gl.uniform2f(lr, N, N)

    for (const name in u) {
      const l = gl.getUniformLocation(p, name)
      if (!l) continue
      if (BOOLS.has(name)) gl.uniform1i(l, u[name] ? 1 : 0)
      else if (INTS.has(name)) gl.uniform1i(l, u[name] | 0)
      else gl.uniform1f(l, u[name])
    }
    // Every gated audio driver explicitly 0 — the unwired case.
    for (const n of GATED) {
      if (has(u, n)) continue
      const l = gl.getUniformLocation(p, n)
      if (l) gl.uniform1f(l, 0)
    }
    const lh = gl.getUniformLocation(p, 'u_has_source')
    if (lh && !has(u, 'u_has_source')) gl.uniform1f(lh, 1)

    gl.bindVertexArray(vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /**
   * Run `frames` passes through a ring of `count` slots, driven by the REAL
   * ringSlots. `sourceAt(i)` returns the source bytes for frame i (1-based).
   * Returns { captured: {frame: pixels}, final, stats: [...] }.
   */
  function runRing({ mode, frames, count = 2, uniforms, sourceAt, bSource, capture, statsEvery }) {
    const slots = []
    for (let i = 0; i < count; i++) {
      const t = makeTarget(mode)
      if (!t) return { unsupported: true }
      slots.push(t)
    }
    let bTex = null
    if (bSource) {
      bTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, bTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(bSource))
    }

    const capSet = new Set(capture || [])
    const captured = {}
    const stats = []
    for (let i = 1; i <= frames; i++) {
      const tick = i - 1
      const s = ringSlots(tick, count)
      uploadSource(sourceAt(i))
      const u = typeof uniforms === 'function' ? uniforms(i) : uniforms
      pass('fm', slots[s.write], slots[s.read].tex, bTex, { ...u, u_time: i / 60 })
      if (capSet.has(i)) captured[i] = readTarget(slots[s.write])
      if (statsEvery && i % statsEvery === 0) {
        const px = readTarget(slots[s.write])
        stats.push({ frame: i, ...summarise(px) })
      }
    }
    const lastWrite = ringSlots(frames - 1, count).write
    return { captured, stats, final: readTarget(slots[lastWrite]) }
  }

  // ── measurements ───────────────────────────────────────────────────────────
  function summarise(px) {
    let mean = 0, min = Infinity, max = -Infinity, nan = 0, lit = 0
    const n = px.length / 4
    for (let i = 0; i < n; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]
      for (const v of [r, g, b]) {
        if (!Number.isFinite(v)) { nan++; continue }
        if (v < min) min = v
        if (v > max) max = v
      }
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      mean += l
      if (l > 0.02) lit++
    }
    return { mean: mean / n, min, max, nan, lit, count: n }
  }

  function meanAbsDiff(a, b) {
    let s = 0, n = 0
    for (let i = 0; i < a.length; i++) {
      if (i % 4 === 3) continue
      s += Math.abs(a[i] - b[i]); n++
    }
    return s / n
  }

  function maxAbsDiff(a, b) {
    let m = 0
    for (let i = 0; i < a.length; i++) {
      if (i % 4 === 3) continue
      const d = Math.abs(a[i] - b[i])
      if (d > m) m = d
    }
    return m
  }

  // ── source patterns ────────────────────────────────────────────────────────
  function solid(r, g, b, a) {
    const out = new Uint8Array(N * N * 4)
    for (let i = 0; i < N * N; i++) { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a }
    return out
  }
  /** A `size`×`size` opaque white square at the centre, on opaque black. */
  function square(size, value = 255) {
    const out = new Uint8Array(N * N * 4)
    const lo = (N - size) >> 1
    const hi = lo + size
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4
      const on = x >= lo && x < hi && y >= lo && y < hi
      out[i] = on ? value : 0
      out[i + 1] = on ? value : 0
      out[i + 2] = on ? value : 0
      out[i + 3] = 255
    }
    return out
  }
  /** Deterministic full-range opaque pattern. */
  function pattern() {
    const out = new Uint8Array(N * N * 4)
    let s = 12345
    for (let i = 0; i < N * N; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      out[i * 4] = s % 256
      out[i * 4 + 1] = (i * 4) % 256
      out[i * 4 + 2] = (i % N) * 4
      out[i * 4 + 3] = 255
    }
    return out
  }

  return {
    gl, N, halfFloat, linearHalf,
    runRing, summarise, meanAbsDiff, maxAbsDiff,
    solid, square, pattern, readTarget,
  }
}

// ── assertions, run in-page ──────────────────────────────────────────────────

function runTests(args) {
  const H = pageHarness(args)
  const D = args.defaults
  const results = []
  const ok = (name, pass, detail) => results.push({ name, pass, detail })
  const modes = H.halfFloat ? ['f16', 'u8'] : ['u8']

  for (const mode of modes) {
    const tag = mode === 'f16' ? 'RGBA16F' : 'RGBA8'

    // ── 1. Stability at the shipped defaults ─────────────────────────────────
    {
      const grey = H.solid(128, 128, 128, 255)
      const r = H.runRing({ mode, frames: 120, count: 2, uniforms: D, sourceAt: () => grey })
      const s = H.summarise(r.final)
      ok(`${tag} stability: 120 frames of mid grey at defaults`,
        s.nan === 0 && s.min >= -1e-4 && s.max <= 1 + 1e-3,
        `nan ${s.nan}, range ${s.min.toFixed(4)}..${s.max.toFixed(4)}, mean ${s.mean.toFixed(4)}`)

      // §6.1 — 15 seconds at 60fps must neither white out nor die.
      const long = H.runRing({ mode, frames: 900, count: 2, uniforms: D, sourceAt: () => grey, statsEvery: 300 })
      const ls = H.summarise(long.final)
      const trace = long.stats.map(x => `f${x.frame} mean ${x.mean.toFixed(3)}`).join(', ')
      ok(`${tag} stability: 900 frames (15s) stays a picture, not white or black`,
        ls.nan === 0 && ls.mean > 0.02 && ls.mean < 0.95,
        `final mean ${ls.mean.toFixed(4)} (${trace})`)
    }

    // ── 2. Growth ────────────────────────────────────────────────────────────
    // A linear cross-fade can only fade or smear. Gain above 1 plus a magnifying
    // zoom must make the lit area GROW — that is the whole point of the node.
    {
      const flash = H.square(8)
      const black = H.solid(0, 0, 0, 255)
      const u = { ...D, u_fm_gain: 1.05, u_fm_zoom: 1.03, u_fm_auto_level: 0 }
      const r = H.runRing({
        mode, frames: 20, count: 2, uniforms: u,
        sourceAt: i => (i === 1 ? flash : black),
        capture: [1, 20],
      })
      const first = H.summarise(r.captured[1])
      const last = H.summarise(r.captured[20])
      ok(`${tag} growth: lit area at least triples in 20 frames`,
        last.lit >= 3 * 64 && last.nan === 0,
        `frame 1 lit ${first.lit}px → frame 20 lit ${last.lit}px (need ≥ 192)`)
    }

    // ── 3. Clip ──────────────────────────────────────────────────────────────
    // The clamp IS the monitor. Without it an RGBA16F buffer at Gain 1.5 runs
    // away to infinity in a couple of seconds.
    {
      const flash = H.square(8)
      const black = H.solid(0, 0, 0, 255)
      const u = { ...D, u_fm_gain: 1.5, u_fm_zoom: 1.03, u_fm_auto_level: 0 }
      const caps = []
      for (let i = 1; i <= 40; i++) caps.push(i)
      const r = H.runRing({
        mode, frames: 40, count: 2, uniforms: u,
        sourceAt: i => (i === 1 ? flash : black),
        capture: caps,
      })
      let worst = 0, worstFrame = 0, nan = 0
      for (const k of caps) {
        const s = H.summarise(r.captured[k])
        nan += s.nan
        if (s.max > worst) { worst = s.max; worstFrame = k }
      }
      ok(`${tag} clip: Gain 1.5 never exceeds 1.0 on any of 40 frames`,
        worst <= 1 + 1e-3 && nan === 0,
        `peak channel ${worst.toFixed(5)} at frame ${worstFrame}, nan ${nan}`)
    }

    // ── 4. Blow-out (§6.3) ───────────────────────────────────────────────────
    // Proves the knobs bite: with Auto Level off, a gain above 1 must run the
    // picture up to white. If this ever passes at Gain 1.05 by staying dim, the
    // stability assertion above is meaningless.
    {
      const grey = H.solid(128, 128, 128, 255)
      const u = { ...D, u_fm_gain: 1.05, u_fm_auto_level: 0 }
      const r = H.runRing({ mode, frames: 240, count: 2, uniforms: u, sourceAt: () => grey })
      const s = H.summarise(r.final)
      ok(`${tag} blow-out: Auto Level 0 + Gain 1.05 whites out`,
        s.mean > 0.9,
        `mean after 240 frames ${s.mean.toFixed(4)} (need > 0.9)`)
    }

    // ── 5. Delay ─────────────────────────────────────────────────────────────
    // 5a: Gain 0 kills the history's contribution entirely, so the output is the
    // live input — the flash appears on exactly its own frame and never again.
    {
      const white = H.solid(255, 255, 255, 255)
      const black = H.solid(0, 0, 0, 255)
      const u = {
        ...D, u_prev_delay: 5, u_fm_mix: 0, u_fm_amount: 1, u_fm_auto_level: 0,
        u_fm_hue: 0, u_fm_gain: 0, u_fm_contrast: 1, u_fm_brightness: 0,
        u_fm_zoom: 1, u_fm_rotate: 0, u_fm_soften: 0, u_fm_sharpen: 0, u_fm_edge: 1,
      }
      const caps = []
      for (let i = 1; i <= 18; i++) caps.push(i)
      const r = H.runRing({
        mode, frames: 18, count: 6, uniforms: u,
        sourceAt: i => (i === 1 ? white : black),
        capture: caps,
      })
      const bright = caps.filter(k => H.summarise(r.captured[k]).mean > 0.5)
      ok(`${tag} delay: with Gain 0 the flash shows once, on its own frame`,
        bright.length === 1 && bright[0] === 1,
        `bright frames [${bright.join(', ')}] (expected [1])`)

      // 5b: Gain 1 with a neutral monitor — the 6-slot ring re-emits the flash
      // every 5 frames. 1 is the live flash; 6, 11 and 16 are the three cycles.
      const u2 = { ...u, u_fm_gain: 1, u_fm_saturation: 1 }
      const r2 = H.runRing({
        mode, frames: 18, count: 6, uniforms: u2,
        sourceAt: i => (i === 1 ? white : black),
        capture: caps,
      })
      const bright2 = caps.filter(k => H.summarise(r2.captured[k]).mean > 0.5)
      ok(`${tag} delay: a 6-slot ring repeats the flash every 5 frames`,
        bright2.join(',') === '1,6,11,16',
        `bright frames [${bright2.join(', ')}] (expected [1, 6, 11, 16])`)
    }

    // ── 6. Clear ─────────────────────────────────────────────────────────────
    {
      const src = H.pattern()
      const r = H.runRing({
        mode, frames: 3, count: 2, uniforms: { ...D, u_fm_clear: true },
        sourceAt: () => src, capture: [3],
      })
      const expected = Array.from(src, b => b / 255)
      const d = H.maxAbsDiff(r.captured[3], expected)
      // RGBA8 stores the input exactly; RGBA16F rounds to half precision (2^-11).
      const tol = mode === 'u8' ? 0 : 6e-4
      ok(`${tag} clear: Clear Loop passes the input through untouched`,
        d <= tol, `max channel difference ${d.toExponential(2)} (tolerance ${tol})`)
    }

    // ── 7. The three documented recipes are clearly different pictures ───────
    if (mode === 'f16' || modes.length === 1) {
      const src = H.pattern()
      const recipes = {
        'spiral galaxy': { ...D, u_fm_zoom: 1.02, u_fm_rotate: 0.02, u_fm_hue: 0.01, u_fm_mix: 0 },
        'echo train': { ...D, u_prev_delay: 12, u_fm_zoom: 1.0, u_fm_rotate: 0.0, u_fm_pan_x: 0.02, u_fm_mix: 2 },
        fern: { ...D, u_fm_fold: 1, u_fm_zoom: 1.03, u_fm_rotate: 0.05, u_fm_contrast: 1.2, u_fm_soften: 1.0 },
      }
      const pics = {}
      for (const name in recipes) {
        const u = recipes[name]
        const count = Math.min(31, Math.max(2, (u.u_prev_delay | 0) + 1))
        const r = H.runRing({ mode, frames: 90, count, uniforms: u, sourceAt: () => src })
        pics[name] = r.final
      }
      const names = Object.keys(pics)
      let worstPair = null, worstD = Infinity
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const d = H.meanAbsDiff(pics[names[i]], pics[names[j]])
          if (d < worstD) { worstD = d; worstPair = `${names[i]} vs ${names[j]}` }
        }
      }
      ok(`${tag} recipes: spiral / echo train / fern are visibly different`,
        worstD > 0.02,
        `closest pair ${worstPair} at mean |Δ| ${worstD.toFixed(4)} (need > 0.02)`)

      let anyNaN = 0
      for (const name of names) anyNaN += H.summarise(pics[name]).nan
      ok(`${tag} recipes: none of the three produces NaN`, anyNaN === 0, `nan channels ${anyNaN}`)
    }
  }

  return { halfFloat: H.halfFloat, linearHalf: H.linearHalf, results }
}

// ── driver ───────────────────────────────────────────────────────────────────

const feedbackHash = createHash('sha256').update(getShaderSource('FEEDBACK')).digest('hex')
const regressionOK = feedbackHash === FEEDBACK_SHA256

// A CI image or sandbox may ship its own Chromium rather than playwright's
// download; point PLAYWRIGHT_CHROMIUM_PATH at that binary to use it.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error') console.error('  page:', m.text()) })

let out
try {
  out = await page.evaluate(
    ([ringSrc, harnessSrc, testsSrc, args]) => {
      // The harness is defined in Node scope, so it has to cross into the page as
      // source text — page.evaluate can't close over it. ringSlots crosses the
      // same way, so the ring the harness drives IS the executor's ring.
      const fn = new Function('args', `${ringSrc}\n${harnessSrc}\n${testsSrc}\nreturn runTests(args)`)
      return fn(args)
    },
    [
      ringSlots.toString(),
      pageHarness.toString(),
      runTests.toString(),
      { vs: VS, programs: PROGRAMS, intUniforms: INT_UNIFORMS, boolUniforms: BOOL_UNIFORMS, defaults: DEFAULTS },
    ]
  )
} finally {
  await browser.close()
}

console.log(`\nFEEDBACK_MACHINE — WebGL2 runtime verification`)
console.log(`  half-float FBOs: ${out.halfFloat}   linear half filter: ${out.linearHalf}\n`)
let failed = 0
for (const r of out.results) {
  if (!r.pass) failed++
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n          ${r.detail}`)
}
if (!regressionOK) failed++
console.log(`  ${regressionOK ? 'PASS' : 'FAIL'}  regression: FEEDBACK shader source unchanged\n          ${feedbackHash}`)

const total = out.results.length + 1
console.log(`\n${total - failed}/${total} assertions passed.\n`)
process.exit(failed ? 1 : 0)
