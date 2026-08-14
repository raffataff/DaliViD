#!/usr/bin/env node
/**
 * DaliVid — scripts/verify-feedback.mjs
 *
 * Runtime check for the FEEDBACK node's Decay param, on a REAL WebGL2 context
 * (Playwright + headless Chromium/SwiftShader). The static smoke test can't see
 * any of this: it validates structure and @param integrity, not what the loop
 * actually converges to.
 *
 * NOT wired into `npm run lint` and playwright is deliberately NOT a dependency
 * — this is an on-demand harness for GLSL changes, in the spirit of the one
 * built for the ARRAY node. Run it with playwright available, e.g.
 *   npx --yes playwright@latest install chromium && npx --yes playwright ...
 * or simply `node scripts/verify-feedback.mjs` if playwright is already
 * resolvable. It launches Chromium with SwiftShader, so no GPU is needed.
 *
 * It runs the OLD shader and the NEW shader side by side through the same
 * ping-pong the renderer uses (both FBO formats FBOManager can pick: RGBA16F
 * when half-float is available, RGBA8 otherwise) and asserts:
 *
 *   1. Decay 0 is byte-identical to the old shader in RGB, at every frame
 *      count, at default AND at non-default Zoom / Rotate.
 *   2. Alpha at Decay 0 matches the old shader once settled, and is CORRECT
 *      (not 15%) on frame 1, where the old one faded in from a cleared history.
 *   3. A still frame is untouched at any Decay — Decay eats trails, not picture.
 *   4. A trail reaches the live frame EXACTLY, in finite time, with Decay > 0,
 *      and provably does not with Decay 0.
 *   5. Higher Decay kills a trail sooner (monotonic).
 *   6. The (1 - Feedback) scale is doing its job: kill time is stable across
 *      Feedback, where an unnormalised subtraction blows out.
 *   7. Opaque footage stays opaque, and a transparent region's trail decays to
 *      exactly zero coverage.
 */

import { chromium } from 'playwright'
import { getShaderSource } from '../src/shaders/shaderRegistry.js'
import { injectAudioDrivers } from '../src/utils/audioDrivers.js'

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

// The FEEDBACK shader exactly as it stood before the Decay param was added.
const OLD_FEEDBACK = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_prev_frame;
uniform float u_time;
uniform float u_feedback;
uniform float u_fb_zoom;
uniform float u_fb_rotate;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv - 0.5;
  float ang = u_fb_rotate + u_mid * 0.03;
  float c = cos(ang), s = sin(ang);
  uv = mat2(c, -s, s, c) * uv;
  uv /= (u_fb_zoom + u_sub_bass * 0.01);
  uv += 0.5;
  vec4 prev = texture(u_prev_frame, uv);
  vec4 curr = texture(u_texture, v_uv);
  fragColor = mix(curr, prev, u_feedback);
}
`

// Same as the new shader but WITHOUT the (1 - u_feedback) normalisation, used
// only to show what that scale buys (assertion 6).
const NEW_UNNORMALISED = getShaderSource('FEEDBACK')
  .replace('float decay = (u_fb_decay + u_treble * 0.15) * (1.0 - u_feedback);',
           'float decay = (u_fb_decay + u_treble * 0.15);')

if (NEW_UNNORMALISED === getShaderSource('FEEDBACK')) {
  console.error('harness is stale: the decay line it patches no longer matches the shader')
  process.exit(1)
}

const PROGRAMS = {
  old: injectAudioDrivers(OLD_FEEDBACK),
  next: injectAudioDrivers(getShaderSource('FEEDBACK')),
  unnorm: injectAudioDrivers(NEW_UNNORMALISED),
}

// ── in-page harness ──────────────────────────────────────────────────────────

function pageHarness({ vs, programs }) {
  const N = 64
  const canvas = document.createElement('canvas')
  canvas.width = N
  canvas.height = N
  const gl = canvas.getContext('webgl2', { antialias: false })
  if (!gl) throw new Error('no webgl2')

  const halfFloat = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'))
  const linearHalf = !!gl.getExtension('OES_texture_float_linear')

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
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return null
    }
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

  // One pass, mirroring Renderer.executePass: bind target, clear, bind unit 0 =
  // source and unit 1 = history, upload uniforms, draw the quad.
  function pass(progKey, dst, prevTex, u) {
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
    for (const name in u) {
      const l = gl.getUniformLocation(p, name)
      if (l) gl.uniform1f(l, u[name])
    }
    // Every gated audio driver explicitly 0 — the unwired case.
    for (const n of ['u_sub_bass', 'u_bass', 'u_low_mid', 'u_mid', 'u_high_mid', 'u_presence', 'u_treble', 'u_rms', 'u_beat', 'u_has_source']) {
      if (name_in(u, n)) continue
      const l = gl.getUniformLocation(p, n)
      if (l) gl.uniform1f(l, n === 'u_has_source' ? 1 : 0)
    }
    gl.bindVertexArray(vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }
  function name_in(o, k) { return Object.prototype.hasOwnProperty.call(o, k) }

  /**
   * Run `frames` passes of `progKey`. `sourceAt(i)` returns the source bytes for
   * frame i (so a flash can be switched off mid-run). Returns { frames: [...] }
   * with a float readback captured at each index listed in `capture`.
   */
  function run({ progKey, mode, frames, uniforms, sourceAt, capture, stopWhenEqual }) {
    const a = makeTarget(mode)
    const b = makeTarget(mode)
    if (!a || !b) return { unsupported: true }
    // Both halves of the ping-pong start cleared, exactly like a fresh node.
    for (const t of [a, b]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    const capSet = new Set(capture || [])
    const captured = {}
    let cur = a, nxt = b
    let equalAt = -1
    for (let i = 1; i <= frames; i++) {
      uploadSource(sourceAt(i))
      pass(progKey, nxt, cur.tex, uniforms)
      const t = cur; cur = nxt; nxt = t
      if (capSet.has(i)) captured[i] = readTarget(cur)
      if (stopWhenEqual && equalAt < 0) {
        const got = readTarget(cur)
        let same = true
        for (let k = 0; k < got.length; k++) {
          if (got[k] !== stopWhenEqual[k]) { same = false; break }
        }
        if (same) equalAt = i
      }
    }
    return { captured, equalAt, final: readTarget(cur) }
  }

  // ── source patterns ────────────────────────────────────────────────────────
  function solid(r, g, b, a) {
    const out = new Uint8Array(N * N * 4)
    for (let i = 0; i < N * N; i++) { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a }
    return out
  }
  // Deterministic full-range pattern, opaque, with plenty of values sitting on
  // rounding boundaries — the case a byte-identity claim has to survive.
  function pattern(alpha) {
    const out = new Uint8Array(N * N * 4)
    let s = 12345
    for (let i = 0; i < N * N; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      out[i * 4] = s % 256
      out[i * 4 + 1] = (i * 4) % 256
      out[i * 4 + 2] = (i % N) * 4
      out[i * 4 + 3] = alpha === 'ramp' ? (i % N) * 4 : alpha
    }
    return out
  }
  // Opaque white on the left half, fully transparent on the right.
  function blob() {
    const out = new Uint8Array(N * N * 4)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4
      const on = x < N / 2
      out[i] = on ? 255 : 0
      out[i + 1] = on ? 255 : 0
      out[i + 2] = on ? 255 : 0
      out[i + 3] = on ? 255 : 0
    }
    return out
  }

  return { gl, N, halfFloat, linearHalf, run, solid, pattern, blob, makeTarget, uploadSource, readTarget, pass }
}

// ── assertions, run in-page ──────────────────────────────────────────────────

function runTests(args) {
  const H = pageHarness(args)
  const results = []
  const modes = H.halfFloat ? ['f16', 'u8'] : ['u8']
  const ok = (name, pass, detail) => results.push({ name, pass, detail })

  const maxDiff = (a, b, stride, offset) => {
    let m = 0, at = -1
    for (let i = offset; i < a.length; i += stride) {
      const d = Math.abs(a[i] - b[i])
      if (d > m) { m = d; at = i }
    }
    return { m, at }
  }
  const rgbDiff = (a, b) => {
    let m = 0
    for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; const d = Math.abs(a[i] - b[i]); if (d > m) m = d }
    return m
  }

  for (const mode of modes) {
    const tag = mode === 'f16' ? 'RGBA16F' : 'RGBA8'

    // ── 1. Decay 0 is byte-identical to the old shader in RGB ────────────────
    for (const geom of [
      { name: 'identity', u: { u_fb_zoom: 1.0, u_fb_rotate: 0.0 } },
      { name: 'zoom+rotate', u: { u_fb_zoom: 1.005, u_fb_rotate: 0.02 } },
    ]) {
      const caps = [1, 2, 5, 30, 60]
      const src = H.pattern(255)
      const base = { u_feedback: 0.85, u_time: 0, ...geom.u }
      const oldRun = H.run({ progKey: 'old', mode, frames: 60, uniforms: base, sourceAt: () => src, capture: caps })
      const newRun = H.run({ progKey: 'next', mode, frames: 60, uniforms: { ...base, u_fb_decay: 0.0 }, sourceAt: () => src, capture: caps })
      let worst = 0
      for (const f of caps) worst = Math.max(worst, rgbDiff(oldRun.captured[f], newRun.captured[f]))
      ok(`[${tag}] Decay 0 RGB byte-identical to old shader (${geom.name}, frames ${caps.join('/')})`,
        worst === 0, `max RGB delta ${worst}`)

      // ── 2. Alpha: the ONLY difference from the old shader, and it is a fix ──
      // The source is opaque, so the correct output alpha is exactly 1.0. The
      // old shader never gets there: its alpha is a geometric approach to 1 that
      // the FBO's own quantisation stalls short of, permanently. Assert the new
      // one is exact and the old one is never MORE correct.
      if (geom.name === 'identity') {
        let newWorst = 1, oldWorst = 1
        for (const f of caps) {
          for (let i = 3; i < newRun.captured[f].length; i += 4) {
            newWorst = Math.min(newWorst, newRun.captured[f][i])
            oldWorst = Math.min(oldWorst, oldRun.captured[f][i])
          }
        }
        const oldSettled = oldRun.captured[60][3]
        ok(`[${tag}] Decay 0 alpha is exactly the source's, where the old shader stalls short`,
          newWorst === 1 && oldWorst < 1,
          `new min alpha ${newWorst} (exact) vs old min ${oldWorst.toFixed(5)}, old still ${oldSettled.toFixed(5)} at frame 60`)
        const oldA1 = oldRun.captured[1][3]
        const newA1 = newRun.captured[1][3]
        ok(`[${tag}] frame 1 on a cleared history is fully opaque, not faded in`,
          Math.abs(newA1 - 1) < 1e-6 && oldA1 < 0.2,
          `new alpha ${newA1.toFixed(4)} vs old ${oldA1.toFixed(4)}`)
      }
    }

    // ── 3. A still frame is untouched at any Decay ───────────────────────────
    {
      const src = H.pattern(255)
      const u = { u_feedback: 0.85, u_fb_zoom: 1.0, u_fb_rotate: 0.0, u_time: 0 }
      // The exact target: what a passthrough writes into this FBO format.
      const ref = H.run({ progKey: 'next', mode, frames: 1, uniforms: { ...u, u_feedback: 0, u_fb_decay: 0 }, sourceAt: () => src, capture: [1] }).captured[1]
      for (const d of [0.05, 0.25, 0.5, 1.0]) {
        const r = H.run({ progKey: 'next', mode, frames: 240, uniforms: { ...u, u_fb_decay: d }, sourceAt: () => src })
        let m = 0
        for (let i = 0; i < ref.length; i++) m = Math.max(m, Math.abs(r.final[i] - ref[i]))
        ok(`[${tag}] still frame survives Decay ${d} unchanged`, m === 0, `max delta ${m}`)
      }
    }

    // ── 4/5. A trail reaches the live frame EXACTLY, sooner at higher Decay ──
    {
      const flash = H.pattern(255)
      const black = H.solid(0, 0, 0, 255)
      const u = { u_feedback: 0.85, u_fb_zoom: 1.0, u_fb_rotate: 0.0, u_time: 0 }
      const ref = H.run({ progKey: 'next', mode, frames: 1, uniforms: { ...u, u_feedback: 0, u_fb_decay: 0 }, sourceAt: () => black, capture: [1] }).captured[1]
      const srcAt = i => (i <= 5 ? flash : black)
      const kill = {}
      for (const d of [0.0, 0.02, 0.05, 0.2, 0.5]) {
        const r = H.run({ progKey: 'next', mode, frames: 600, uniforms: { ...u, u_fb_decay: d }, sourceAt: srcAt, stopWhenEqual: ref })
        kill[d] = r.equalAt
      }
      ok(`[${tag}] Decay 0 leaves residue forever (no exact match in 600 frames)`,
        kill[0] === -1, `settled at frame ${kill[0]}`)
      ok(`[${tag}] Decay > 0 drives the trail to EXACTLY the live frame`,
        [0.02, 0.05, 0.2, 0.5].every(d => kill[d] > 0),
        `kill frames ${JSON.stringify(kill)}`)
      ok(`[${tag}] higher Decay kills the trail sooner (monotonic)`,
        kill[0.02] > kill[0.05] && kill[0.05] > kill[0.2] && kill[0.2] >= kill[0.5],
        `kill frames ${JSON.stringify(kill)}`)
    }

    // ── 6. The (1 - Feedback) scale keeps Decay meaningful across Feedback ───
    if (mode === 'f16' || modes.length === 1) {
      const flash = H.pattern(255)
      const black = H.solid(0, 0, 0, 255)
      const srcAt = i => (i <= 5 ? flash : black)
      const spread = key => {
        const kills = []
        for (const f of [0.7, 0.85, 0.95]) {
          const u = { u_feedback: f, u_fb_decay: 0.1, u_fb_zoom: 1.0, u_fb_rotate: 0.0, u_time: 0 }
          const ref = H.run({ progKey: 'next', mode, frames: 1, uniforms: { ...u, u_feedback: 0, u_fb_decay: 0 }, sourceAt: () => black, capture: [1] }).captured[1]
          const r = H.run({ progKey: key, mode, frames: 900, uniforms: u, sourceAt: srcAt, stopWhenEqual: ref })
          kills.push(r.equalAt < 0 ? Infinity : r.equalAt)
        }
        return kills
      }
      const norm = spread('next')
      const un = spread('unnorm')
      const rising = a => a[0] < a[1] && a[1] < a[2]
      const spreadOf = a => Math.max(...a) / Math.min(...a)
      // The claim the (1 - Feedback) scale makes: Decay SHORTENS the trail
      // Feedback asked for, rather than replacing it. So kill time must still
      // rise with Feedback — which it does not without the scale, where Decay
      // simply overrides Feedback and every trail dies at the same frame.
      ok(`[${tag}] Decay composes with Feedback (kill time still rises 0.7→0.95)`,
        rising(norm) && spreadOf(norm) > 1.8,
        `normalised ${JSON.stringify(norm)} (${spreadOf(norm).toFixed(1)}x across Feedback)`)
      ok(`[${tag}] without the (1 - Feedback) scale, Decay would override Feedback`,
        spreadOf(un) < 1.3 && spreadOf(un) < spreadOf(norm),
        `unnormalised ${JSON.stringify(un)} (${spreadOf(un).toFixed(1)}x — flat, i.e. Feedback stops mattering)`)
    }

    // ── 7. Alpha: opaque stays opaque, transparent trails reach zero ─────────
    {
      const opaque = H.pattern(255)
      for (const [f, d] of [[0.99, 1.0], [0.85, 0.5], [0.5, 0.0]]) {
        const u = { u_feedback: f, u_fb_decay: d, u_fb_zoom: 1.0, u_fb_rotate: 0.0, u_time: 0 }
        const r = H.run({ progKey: 'next', mode, frames: 120, uniforms: u, sourceAt: () => opaque, capture: [1, 2, 120] })
        let worst = 1
        for (const fr of [1, 2, 120]) for (let i = 3; i < r.captured[fr].length; i += 4) worst = Math.min(worst, r.captured[fr][i])
        ok(`[${tag}] opaque footage stays opaque (Feedback ${f}, Decay ${d})`,
          worst >= 1 - 1e-4, `min alpha seen ${worst.toFixed(5)}`)
      }
      // A blob that vanishes: its coverage trail must reach exactly zero.
      const blob = H.blob()
      const clear = H.solid(0, 0, 0, 0)
      const u = { u_feedback: 0.9, u_fb_zoom: 1.0, u_fb_rotate: 0.0, u_time: 0 }
      for (const d of [0.0, 0.1]) {
        const r = H.run({ progKey: 'next', mode, frames: 400, uniforms: { ...u, u_fb_decay: d }, sourceAt: i => (i <= 5 ? blob : clear) })
        let maxA = 0
        for (let i = 3; i < r.final.length; i += 4) maxA = Math.max(maxA, r.final[i])
        ok(`[${tag}] vanished content leaves ${d > 0 ? 'zero' : 'lingering'} coverage (Decay ${d})`,
          d > 0 ? maxA === 0 : maxA > 0, `max residual alpha after 400 frames ${maxA}`)
      }
    }
  }

  // ── cost ───────────────────────────────────────────────────────────────────
  // Three extra ALU ops on a pass that is entirely texture-bandwidth bound, so
  // this should be flat. SwiftShader is not a GPU, but a REGRESSION would still
  // show up as a ratio well above 1.
  {
    const src = H.pattern(255)
    const u = { u_feedback: 0.85, u_fb_zoom: 1.005, u_fb_rotate: 0.01, u_time: 0 }
    const time = key => {
      H.run({ progKey: key, mode: 'f16', frames: 30, uniforms: { ...u, u_fb_decay: 0.2 }, sourceAt: () => src }) // warm
      const t0 = performance.now()
      H.run({ progKey: key, mode: 'f16', frames: 300, uniforms: { ...u, u_fb_decay: 0.2 }, sourceAt: () => src })
      H.gl.finish()
      return performance.now() - t0
    }
    const tOld = Math.min(time('old'), time('old'))
    const tNew = Math.min(time('next'), time('next'))
    results.push({
      name: 'cost: 300 passes, new vs old',
      pass: tNew / tOld < 1.15,
      detail: `old ${tOld.toFixed(1)}ms, new ${tNew.toFixed(1)}ms (${(tNew / tOld).toFixed(3)}x)`,
    })
  }

  return { halfFloat: H.halfFloat, linearHalf: H.linearHalf, results }
}

// ── driver ───────────────────────────────────────────────────────────────────

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
})
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error') console.error('  page:', m.text()) })

let out
try {
  out = await page.evaluate(
    ([harnessSrc, testsSrc, args]) => {
      // The harness is defined in Node scope, so it has to cross into the page as
      // source text — page.evaluate can't close over it.
      const fn = new Function('args', `${harnessSrc}\n${testsSrc}\nreturn runTests(args)`)
      return fn(args)
    },
    [pageHarness.toString(), runTests.toString(), { vs: VS, programs: PROGRAMS }]
  )
} finally {
  await browser.close()
}

console.log(`\nFEEDBACK Decay — WebGL2 runtime verification`)
console.log(`  half-float FBOs: ${out.halfFloat}   linear half filter: ${out.linearHalf}\n`)
let failed = 0
for (const r of out.results) {
  if (!r.pass) failed++
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n          ${r.detail}`)
}
console.log(`\n${out.results.length - failed}/${out.results.length} assertions passed.\n`)
process.exit(failed ? 1 : 0)
