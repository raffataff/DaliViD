# PLAN — Feedback Machine node (analogue-style video feedback)

Status: **IMPLEMENTED 2026-09-03.** Everything below was built as written; section 7
passes in full. Three things differ from the text and are recorded at the end of this
file under "Implementation notes" — the §7.2 4K slot count (an arithmetic slip in this
plan), the §6 tuned defaults, and two extra files. Line numbers are approximate anchors —
search for the quoted code, not the number.

Read first: `CLAUDE.md`, and project memory notes `verifying_changes.md`,
`inspector_sliders.md`, `feedback_machine_plan.md`.

## 0. Decisions (made with Jonn)

| Question | Decision |
|---|---|
| Change the existing `FEEDBACK` node? | **No.** Leave `FEEDBACK` byte-for-byte untouched — saved projects must render identically. Add a NEW node type. |
| Node type / display name | `FEEDBACK_MACHINE` / **"Feedback Machine"**, category **Effects**, listed directly under "Feedback Loop". |
| Multi-frame delay | **Yes**, 1–30 frames, implemented as a ring of history FBOs (§4). Memory-capped at 512 MB per node; the node gets a Resolution param (Full/Half/Quarter) so users can trade resolution for delay. |
| Second input | **Yes**, an `input_b` socket, luma-keyed into the loop (the second monitor in his beam splitter). |
| Detection of "this node wants a delay ring" | By the presence of a `u_prev_delay` param value (not by uniform location — see §4.3 for why). |
| Two loops feeding each other (cross-linked nodes) | **Out of scope** for this pass. Do not build it. |
| Tests | Static smoke test must pass (`npm run lint`); a unit test for ring index maths; a Playwright runtime harness modelled on `scripts/verify-feedback.mjs` (§7). |

## 1. What we are emulating, and why the current node cannot do it

Reference: The Light Herder's optical feedback rig (a camera filming a 4K screen that shows
the camera's own feed). Every lap around that loop applies ALL of the following, and the
fractals are the fixed point of that repeated transform:

1. **Geometry** — zoom (camera distance), rotation (camera on a rotating rod), off-centre
   offset, plus an optional mirrored / rotated second screen.
2. **Monitor knobs** — hue, saturation, brightness, contrast, applied every lap, and the
   screen **hard-clips** at black and white. The clip is the non-linearity that carves
   crisp shapes instead of grey mush.
3. **Lens softness** — a tiny blur every lap, which lets shapes grow smoothly.
4. **Delay** — two frame-delay units, up to 30 frames. Long delays turn a spiral into a
   train of discrete echoes and let an object "orbit".
5. **Mixing** — 50/50 beam-splitter glass (an ADD of two pictures) and a Roland luma keyer
   (bright parts of an input paint over the loop, dark parts let the loop through).
6. No auto-exposure / auto-white-balance (they make the picture pulse).

Our `FEEDBACK` shader (`src/shaders/shaderRegistry.js` ≈ line 594) is
`out = mix(curr, transform(prev), f)` with `f ≤ 0.99`, zoom + rotate only. A linear
cross-fade can only fade or smear; it cannot grow or sharpen anything, so fractals are
impossible regardless of settings. It has none of items 2–5.

What already exists and is reused unchanged:

- Declaring `uniform sampler2D u_prev_frame;` makes the DAG executor give a node its own
  history buffer (`clipGraphManager.js`, `executeGraphDAG`, the `isFeedback` branch ≈ line 663).
- FBOs are RGBA16F (`FBOManager.create`), CLAMP_TO_EDGE, linear filtered.
- `u_texture_b` is routed from the `input_b` socket via `TEXTURE_INPUT_SOCKETS`
  (`clipGraphManager.js` ≈ line 22); an unwired `input_b` falls back to the primary input.
- Audio driver uniforms (`u_sub_bass`, `u_mid`, `u_treble`, …) are auto-declared into every
  effect shader by `injectAudioDrivers` and are 0 unless wired.
- Every `@param` directive becomes an Inspector / NodeCard control automatically
  (`src/utils/paramParser.js`). No Inspector work is needed.
- `releaseNodeResources` (`Renderer.js` ≈ line 2136) frees per-node FBOs on delete.

## 2. Files touched

| File | Change |
|---|---|
| `src/gl/historyRing.js` | **New.** Pure ring index maths (unit-tested). |
| `src/gl/FBOManager.js` | Add `ensureRing` / `getRing` / `deleteRing`; clear rings in `dispose`. |
| `src/gl/clipGraphManager.js` | Ring sub-branch inside the `isFeedback` branch; `nodeFBOScale` entry. |
| `src/gl/Renderer.js` | `releaseNodeResources`: free the ring. |
| `src/shaders/shaderRegistry.js` | `registerShader('FEEDBACK_MACHINE', …)` — full source in §5. Place it directly after the `FEEDBACK` registration (before `// ── Blur (Gaussian) ──`). |
| `src/shaders/nodeDefinitions.js` | Socket definition with `input_b`. |
| `src/components/NodeEditor/NodeSearchMenu.jsx` | Menu entry. |
| `test/historyRing.test.js` | **New.** |
| `scripts/verify-feedback-machine.mjs` | **New.** Runtime harness (§7). |

No new npm dependencies. `src/storage/nodeTypes.js` picks the new type up automatically
from the registry — do not edit it.

## 3. Small edits

### 3.1 `nodeDefinitions.js` — add after the `TIME_SLICE_3D` entry (≈ line 447, inside `NODE_DEFS`)

```js
  FEEDBACK_MACHINE: {
    inputs: [
      { id: 'input', type: 'texture', name: 'Input' },
      { id: 'input_b', type: 'texture', name: 'Input B' },
      { id: 'audio_drivers', type: 'float', name: 'Audio Drivers' },
    ],
    outputs: [
      { id: 'output', type: 'texture', name: 'Output' },
    ],
    hasParamInputs: true,
  },
```

### 3.2 `NodeSearchMenu.jsx` — Effects category (≈ line 49)

```js
      { type: 'FEEDBACK', name: 'Feedback Loop' },
      { type: 'FEEDBACK_MACHINE', name: 'Feedback Machine' },
```

### 3.3 `clipGraphManager.js` — `nodeFBOScale` (≈ line 53)

Add one branch so the node's Resolution param scales its history buffers:

```js
  if (node.type === 'DEPTH') idx = Math.round(Number(liveParams?.u_dp_res ?? 1))
  else if (node.type === 'AUDIO_VISUALIZER') idx = Math.round(Number(liveParams?.u_render_scale ?? 0))
  else if (node.type === 'FEEDBACK_MACHINE') idx = Math.round(Number(liveParams?.u_fm_res ?? 0))
  else return 1
```

### 3.4 `Renderer.js` — `releaseNodeResources` (≈ line 2140)

Add directly after the `deletePingPong(\`__npp_…\`)` line:

```js
      this.fbos.deleteRing(`__nring_${scope}${n.id}`)   // FEEDBACK_MACHINE delay ring
```

## 4. Delay ring

### 4.1 How it works (plain terms)

The existing feedback path keeps two buffers and swaps them each frame, so a node always
sees the frame it drew last time. A delay of N frames needs N+1 buffers arranged in a ring:
each frame the node reads the slot written N frames ago and writes into the oldest slot.
With N = 1 the ring is exactly the existing ping-pong.

### 4.2 `src/gl/historyRing.js` (new, pure, no GL)

```js
/**
 * Slot arithmetic for a delay ring of `count` buffers.
 * read  — written `count - 1` ticks ago (the delayed frame)
 * write — the oldest slot, safe to overwrite this tick
 * last  — the most recently written slot
 */
export function ringSlots(tick, count) {
  const c = Math.max(2, count | 0)
  const t = ((tick % c) + c) % c
  return {
    read: (t + 1) % c,
    write: t,
    last: (t + c - 1) % c,
  }
}

/** Number of ring slots for a delay of `delayFrames`, capped by a byte budget. */
export function ringCount(delayFrames, width, height, bytesPerPixel = 8, budgetBytes = 512 * 1024 * 1024) {
  const delay = Math.max(1, Math.min(30, Math.round(Number(delayFrames) || 1)))
  const perFrame = Math.max(1, width * height * bytesPerPixel)
  const maxSlots = Math.max(2, Math.floor(budgetBytes / perFrame))
  return Math.min(delay + 1, maxSlots)
}
```

### 4.3 `FBOManager.js` additions

Add `this.rings = new Map()` in the constructor next to `this.pingPongPairs`, and import
`ringSlots` from `./historyRing.js`.

```js
  /**
   * Ensure a delay ring of `count` same-size FBOs exists for `id`.
   * Rebuilds when the count changes, seeding every new slot with the most recent
   * frame so the picture freezes for one frame instead of going black.
   */
  ensureRing(id, count, width, height) {
    let ring = this.rings.get(id)
    if (ring && ring.count === count) {
      for (let i = 0; i < count; i++) this.resize(`${id}_${i}`, width, height)
      return ring
    }
    const seedId = ring ? ring.lastId : null
    const ids = []
    for (let i = 0; i < count; i++) {
      const slotId = `${id}_${i}`
      if (ring && i < ring.count) {
        this.resize(slotId, width, height)
      } else {
        this.create(slotId, width, height)
      }
      ids.push(slotId)
    }
    if (ring) {
      // Seed first, THEN drop surplus slots — the seed may live in one of them.
      if (seedId && this.fbos.has(seedId)) {
        for (const slotId of ids) if (slotId !== seedId) this.blit(seedId, slotId, width, height)
      }
      for (let i = count; i < ring.count; i++) this.delete(`${id}_${i}`)
    }
    const next = {
      id, count, tick: 0, ids,
      get readId() { return `${id}_${ringSlots(this.tick, this.count).read}` },
      get writeId() { return `${id}_${ringSlots(this.tick, this.count).write}` },
      get lastId() { return `${id}_${ringSlots(this.tick, this.count).last}` },
      advance() { this.tick = (this.tick + 1) % this.count },
    }
    this.rings.set(id, next)
    return next
  }

  getRing(id) {
    return this.rings.get(id) || null
  }

  deleteRing(id) {
    const ring = this.rings.get(id)
    if (!ring) return
    for (const slotId of ring.ids) this.delete(slotId)
    this.rings.delete(id)
  }
```

In `dispose()`, add `this.rings.clear()` after `this.fbos.clear()`.

Notes for the implementer:
- `create(id, w, h)` with no options creates at scale 1 using the passed dimensions, and
  `resize` then keeps that scale — identical to how the ping-pong branch already sizes its
  pair, so scaled (Half/Quarter) rings work the same way.
- `blit` reads the destination's own size; passing `width, height` is only for the
  screen case and is harmless here.
- `resizeAll` (canvas resize) walks every FBO including ring slots — nothing extra needed.

### 4.4 `clipGraphManager.js` — the executor branch (≈ lines 663–681)

Import `ringCount` from `./historyRing.js`. Replace the body of `if (isFeedback) { … }`
with the following. The `else` (non-ring) half is the existing code, unchanged.

```js
    if (isFeedback) {
      const fbScale = nodeFBOScale(node, liveParams)
      const ppW = Math.max(1, Math.round(renderer.width * fbScale))
      const ppH = Math.max(1, Math.round(renderer.height * fbScale))
      // A node whose params carry u_prev_delay wants an N-frame history ring
      // instead of the single-frame ping-pong. Detected from the PARAM, not the
      // uniform location: the shader never has to read u_prev_delay, so the GL
      // compiler may drop it from the active-uniform list.
      const delayParam = customParams.u_prev_delay
      if (delayParam !== undefined) {
        const ringId = `__nring_${scopeId}${node.nodeId}`
        const count = ringCount(delayParam, ppW, ppH)
        const ring = fbos.ensureRing(ringId, count, ppW, ppH)
        const prevFrameFBOId = ring.readId
        outId = ring.writeId
        renderer.executePass(node, primaryInput, outId, standardState, customParams, prevFrameFBOId, extraTextures)
        ring.advance()
      } else {
        const ppId = `__npp_${scopeId}${node.nodeId}`
        let pp = fbos.getPingPong(ppId)
        if (!pp) pp = fbos.createPingPong(ppId, ppW, ppH)
        else fbos.resizePingPong(ppId, ppW, ppH)
        const prevFrameFBOId = `${ppId}_${pp.current}`
        outId = `${ppId}_${1 - pp.current}`
        renderer.executePass(node, primaryInput, outId, standardState, customParams, prevFrameFBOId, extraTextures)
        pp.swap()
      }
    }
```

Keep the existing explanatory comment about scaling both buffers together. Do NOT touch
the legacy linear executor (`executeChainLinear`, `__fb_` keys) — `USE_DAG` is true.

`customParams` is built from `liveParams` a few lines above (`normalizeParams(liveParams)`),
and every `@param` gets a default in `node.params` when the node is created, so
`u_prev_delay` is always present for this node type. `ringCount` clamps to 1–30 and applies
the 512 MB budget (slots = delay + 1). Resulting maximum delay: 1080p Full → 30;
4K Full → 6; 4K Half → 30.

## 5. The shader — `registerShader('FEEDBACK_MACHINE', …)`

Insert directly after the `FEEDBACK` registration in `shaderRegistry.js`. Copy verbatim.
`rgb2hsv` / `hsv2rgb` are the same helpers used by the HUE shader at ≈ line 133; they are
re-declared here because each registered shader is compiled standalone.

```js
// ── Feedback Machine ──
// Analogue-style optical feedback: every lap applies camera geometry, monitor
// knobs (with hard clipping), lens softness and a keyed input, over an N-frame
// history ring (u_prev_delay — see the ring branch in executeGraphDAG).
registerShader('FEEDBACK_MACHINE', `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform sampler2D u_texture_b;
uniform sampler2D u_prev_frame;
uniform vec2 u_resolution;
uniform float u_time;

// @param name="Clear Loop" type=bool default=false
uniform bool u_fm_clear;
// @param name="Zoom" min=0.9 max=1.1 default=1.01 step=0.001
uniform float u_fm_zoom;
// @param name="Rotate" min=-0.2 max=0.2 default=0.01 step=0.0005
uniform float u_fm_rotate;
// @param name="Offset X" min=-0.5 max=0.5 default=0.0 step=0.001
uniform float u_fm_pan_x;
// @param name="Offset Y" min=-0.5 max=0.5 default=0.0 step=0.001
uniform float u_fm_pan_y;
// @param name="Fold" min=0 max=4 default=0 step=1 type=select options="None,Mirror X,Mirror Y,Rotate 90,Rotate 180"
uniform int u_fm_fold;
// @param name="Edges" min=0 max=3 default=0 step=1 type=select options="Black,Clamp,Mirror,Tile"
uniform int u_fm_edge;
// @param name="Drift" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_fm_drift;
// @param name="Gain" min=0.5 max=1.5 default=1.0 step=0.005
uniform float u_fm_gain;
// @param name="Contrast" min=0.5 max=2.0 default=1.05 step=0.005
uniform float u_fm_contrast;
// @param name="Brightness" min=-0.2 max=0.2 default=0.0 step=0.001
uniform float u_fm_brightness;
// @param name="Hue Shift" min=-0.1 max=0.1 default=0.01 step=0.0005
uniform float u_fm_hue;
// @param name="Saturation" min=0.0 max=2.0 default=1.0 step=0.01
uniform float u_fm_saturation;
// @param name="Auto Level" min=0.0 max=1.0 default=0.25 step=0.01
uniform float u_fm_auto_level;
// @param name="Soften" min=0.0 max=3.0 default=0.6 step=0.01
uniform float u_fm_soften;
// @param name="Sharpen" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_fm_sharpen;
// @param name="Delay (frames)" min=1 max=30 default=1 step=1
uniform int u_prev_delay;
// @param name="Mix" min=0 max=4 default=0 step=1 type=select options="Add,Crossfade,Luma Key,Screen,Difference"
uniform int u_fm_mix;
// @param name="Input Amount" min=0.0 max=1.0 default=0.35 step=0.01
uniform float u_fm_amount;
// @param name="Key Threshold" min=0.0 max=1.0 default=0.3 step=0.01
uniform float u_fm_key_thr;
// @param name="Key Softness" min=0.0 max=0.5 default=0.1 step=0.01
uniform float u_fm_key_soft;
// @param name="Input B Amount" min=0.0 max=1.0 default=0.0 step=0.01
uniform float u_fm_b_amount;
// @param name="Resolution" min=0 max=2 default=0 step=1 type=select options="Full,Half,Quarter"
uniform int u_fm_res;
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

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// History sample with the chosen edge rule. Black = outside the screen is black
// AND transparent, like the bezel around his monitor.
vec4 histSample(vec2 uv) {
  if (u_fm_edge == 1) return texture(u_prev_frame, clamp(uv, 0.0, 1.0));
  if (u_fm_edge == 2) {
    vec2 m = 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0);
    return texture(u_prev_frame, m);
  }
  if (u_fm_edge == 3) return texture(u_prev_frame, fract(uv));
  vec2 fw = fwidth(uv) + 1e-5;
  vec2 lo = smoothstep(vec2(0.0), fw, uv);
  vec2 hi = smoothstep(vec2(0.0), fw, vec2(1.0) - uv);
  return texture(u_prev_frame, clamp(uv, 0.0, 1.0)) * (lo.x * lo.y * hi.x * hi.y);
}

// Lens: a 5-tap soften and an unsharp-mask sharpen, both inside the loop.
vec4 lensSample(vec2 uv) {
  vec4 c = histSample(uv);
  if (u_fm_soften <= 0.0 && u_fm_sharpen <= 0.0) return c;
  vec2 px = max(u_fm_soften, 0.5) / u_resolution;
  vec4 b = (histSample(uv + vec2(px.x, 0.0)) + histSample(uv - vec2(px.x, 0.0))
          + histSample(uv + vec2(0.0, px.y)) + histSample(uv - vec2(0.0, px.y))) * 0.25;
  vec4 soft = mix(c, b, 0.5 * min(u_fm_soften, 1.0));
  return soft + (c - b) * u_fm_sharpen;
}

float keyOf(vec4 c) {
  return smoothstep(u_fm_key_thr - u_fm_key_soft, u_fm_key_thr + u_fm_key_soft, luma(c.rgb)) * c.a;
}

void main() {
  vec4 curr = texture(u_texture, v_uv);
  if (u_fm_clear) { fragColor = curr; return; }

  // ── Camera ── frame units: y in [-0.5, 0.5], x scaled by aspect so rotation stays circular.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 p = vec2((v_uv.x - 0.5) * aspect, v_uv.y - 0.5);

  if (u_fm_fold == 1) p.x = abs(p.x);
  else if (u_fm_fold == 2) p.y = abs(p.y);
  else if (u_fm_fold == 3) p = vec2(-p.y, p.x);
  else if (u_fm_fold == 4) p = -p;

  float t = u_time;
  // Audio drivers (0 until wired): mid rotates, sub-bass zooms, treble shifts hue.
  float ang = u_fm_rotate + u_fm_drift * 0.04 * sin(t * 0.37) + u_mid * 0.03;
  float cs = cos(ang), sn = sin(ang);
  p = mat2(cs, -sn, sn, cs) * p;
  float zoom = u_fm_zoom + u_sub_bass * 0.01 + u_fm_drift * 0.01 * sin(t * 0.21);
  p /= max(zoom, 0.01);
  p += vec2(u_fm_pan_x, u_fm_pan_y) + u_fm_drift * 0.03 * vec2(sin(t * 0.23), cos(t * 0.19));
  vec2 huv = vec2(p.x / aspect + 0.5, p.y + 0.5);

  vec4 hist = lensSample(huv);

  // ── Monitor ── knobs applied every lap; the clamp is the screen's white and black.
  vec3 rgb = hist.rgb * u_fm_gain;

  // Auto Level: coarse mean brightness of the last frame pulls the gain back
  // toward a mid grey, so the loop neither whites out nor dies. 0 = fully manual.
  if (u_fm_auto_level > 0.0) {
    float m = 0.0;
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < 4; j++) {
        m += luma(texture(u_prev_frame, vec2(0.125 + 0.25 * float(i), 0.125 + 0.25 * float(j))).rgb);
      }
    }
    m /= 16.0;
    float corr = clamp(0.3 / max(m, 0.02), 0.5, 1.5);
    rgb *= mix(1.0, corr, u_fm_auto_level * 0.5);
  }

  rgb = (rgb - 0.5) * u_fm_contrast + 0.5 + u_fm_brightness;
  vec3 hsv = rgb2hsv(clamp(rgb, 0.0, 1.0));
  hsv.x = fract(hsv.x + u_fm_hue + u_treble * 0.02);
  hsv.y = clamp(hsv.y * u_fm_saturation, 0.0, 1.0);
  rgb = clamp(hsv2rgb(hsv), 0.0, 1.0);

  // ── Mix ── how the live input joins the loop.
  vec3 inp = curr.rgb * u_fm_amount;
  vec3 outRgb;
  if (u_fm_mix == 1) outRgb = mix(rgb, curr.rgb, u_fm_amount);
  else if (u_fm_mix == 2) outRgb = mix(rgb, curr.rgb, keyOf(curr) * u_fm_amount);
  else if (u_fm_mix == 3) outRgb = 1.0 - (1.0 - rgb) * (1.0 - inp);
  else if (u_fm_mix == 4) outRgb = abs(rgb - inp);
  else outRgb = rgb + inp;

  // Input B: the second screen in the beam splitter, always luma-keyed in.
  if (u_fm_b_amount > 0.0) {
    vec4 b = texture(u_texture_b, v_uv);
    outRgb = mix(outRgb, b.rgb, keyOf(b) * u_fm_b_amount);
  }

  outRgb = clamp(outRgb, 0.0, 1.0);
  // Trails may add coverage but never eat the live frame's own matte.
  float a = max(clamp(hist.a, 0.0, 1.0), curr.a);
  fragColor = vec4(outRgb, a);
}
`)
```

Facts the implementer should know about this shader:

- `u_prev_delay` and `u_fm_res` are deliberately never read in GLSL. They exist so the
  param parser creates their controls; the executor reads their values from the node's
  params (§3.3, §4.4). This is the same pattern as `DEPTH`'s `u_dp_res`.
- `u_mid`, `u_sub_bass`, `u_treble` are injected by `injectAudioDrivers` — do not declare them.
- Every write to `fragColor` carries the source alpha through (`a`), so the smoke test's
  opaque-alpha check passes.
- Values are clamped to 0–1 before writing. The FBO is RGBA16F and CAN store values above
  1; without the clamp a gain above 1 would run away to infinity within seconds. The
  clamp IS the monitor.

## 6. Default tuning step (do this in the browser, it is part of the work)

The defaults above are a starting guess. After everything compiles: open the app, put a
video clip on the timeline, add a Feedback Machine after it, press play, and watch for
15 seconds. Adjust ONLY the `default=` values of Gain, Contrast, Input Amount, Auto Level
and Soften until all three hold:

1. The picture does not go fully white or fully black within 15 seconds.
2. A visible spiral / trail structure builds up (Zoom 1.01 + Rotate 0.01 should show it).
3. Turning Auto Level to 0 and Gain to 1.05 makes the picture blow out — proving the
   knobs bite.

Then confirm these three recipes produce clearly different pictures (they are the smoke
test for the feature, and the user documentation):

| Recipe | Settings (others default) | Expected look |
|---|---|---|
| Spiral galaxy | Zoom 1.02, Rotate 0.02, Hue Shift 0.01, Mix Add | Rainbow spiral arms growing from bright regions |
| Echo train | Delay 12, Zoom 1.0, Rotate 0.0, Offset X 0.02, Mix Luma Key | Bright objects repeat as a string of discrete copies stepping sideways |
| Fern | Fold Mirror X, Zoom 1.03, Rotate 0.05, Contrast 1.2, Soften 1.0 | Symmetric fern / jellyfish structures |

Write the final defaults back into the shader's `@param` lines.

## 7. Verification (all must pass before the work is done)

1. `npm run lint` — ESLint plus `scripts/smoke-shaders.mjs` (structure, undeclared uniforms,
   `@param` integrity, alpha writes) over every registered shader, including the new one.
2. `npm test` — includes the new `test/historyRing.test.js`:
   - `ringSlots(t, 2)` alternates read/write like a ping-pong for t = 0..3.
   - For count 4 and any t, `read === (write + 1) % 4` and `last === (write + 3) % 4`, and
     the read slot is the one written 3 ticks earlier (simulate 12 ticks with an array).
   - `ringCount(1, 1920, 1080) === 2`, `ringCount(30, 1920, 1080) === 31`,
     `ringCount(30, 3840, 2160) === 7`, `ringCount(99, …)` clamps to 31, `ringCount(0, …)` is 2.
3. `npm run build` — the cross-module import check (see memory `verifying_changes.md`).
4. `scripts/verify-feedback-machine.mjs` — copy the Playwright/WebGL2 boilerplate from
   `scripts/verify-feedback.mjs` (vertex shader, quad, FBO creation in both RGBA16F and
   RGBA8, `injectAudioDrivers`). Drive the FEEDBACK_MACHINE shader through a JS ring built
   with `ringSlots` (so the harness exercises the same slot maths as the executor), and
   assert:
   - **Stability**: 120 frames with a mid-grey input, defaults → no pixel is NaN and all
     channels are within 0–1.
   - **Growth**: a single bright 8×8 square input for one frame, then black input, Gain
     1.05, Zoom 1.03, Auto Level 0 → after 20 frames the number of non-black pixels is at
     least 3× the original 64.
   - **Clip**: same setup, Gain 1.5 → no channel exceeds 1.0 at any frame.
   - **Delay**: Delay 5, Mix Add, Input Amount 1, Auto Level 0, Hue Shift 0, Gain 0,
     Contrast 1 (so history contributes nothing) → a one-frame flash of white input appears
     in the output on exactly the frame it is drawn and, because Gain is 0, is gone next
     frame; then with Gain 1, Contrast 1, Zoom 1, Rotate 0, Soften 0, Edges Clamp the flash
     re-appears exactly every 5 frames for 3 cycles (ring of 6 slots).
   - **Clear**: `u_fm_clear = true` outputs the input byte-for-byte.
   - **Regression**: the OLD `FEEDBACK` shader source is unchanged (hash it against the
     string in `verify-feedback.mjs` if that file already embeds it; otherwise compare
     against a copy taken before this work).
5. Manual: delete a Feedback Machine node while playing (no WebGL errors in the console —
   `releaseNodeResources` freed the ring), duplicate one, put one inside a compound, save
   and reload the project, and drag the Delay slider from 1 to 30 and back while playing
   (picture must freeze-and-continue, never flash black).

## 8. Out of scope (do not build in this pass)

- Cross-linked loops (node A reading node B's previous frame). Needs a graph rule for a
  one-frame-delayed edge; separate plan.
- Presets in `compoundPresets.js`. The recipes in §6 are documentation only.
- Any change to the existing `FEEDBACK` node or its Decay behaviour.


---

## Implementation notes (written after the work, 2026-09-03)

### Corrections to this plan

**§7.2 — `ringCount(30, 3840, 2160)` is 8, not 7.** 4K RGBA16F is
3840 × 2160 × 8 = 66,355,200 bytes a frame, and 512 MiB (536,870,912) buys
`floor(536870912 / 66355200) = 8` slots, not 7. So the maximum delay at 4K Full is
**7 frames**, not 6. The code in §4.2 is correct as written; only the expected value in
the test was wrong. `test/historyRing.test.js` asserts 8.

**§6 — final tuned defaults.** Measured with `scripts/verify-feedback-machine.mjs`
(64×64, SwiftShader, 900 frames of flat mid grey — the worst case for an additive mix,
since the input never stops adding):

| Param | Plan | Shipped | Why |
|---|---|---|---|
| Gain | 1.0 | **0.95** | With Mix = Add the loop's fixed point is `(offset + amount × input) / (1 − gain × contrast)`. Above ~0.97 a full-frame input walks the picture to white. |
| Contrast | 1.05 | **1.03** | Contrast above 1 crushes the dark edge of a growing shape, which is what caps growth. At 1.05 the growth test measured 188 lit pixels (needs 192); at 1.03 it measures 264. |
| Auto Level | 0.25 | **1.0** | At 0.25 its authority is ~6%, far too little to hold an additive loop. At 1.0 the loop settles at mean 0.59 and stays there for 15 s. Turn it down for manual control — §6.3 (Auto Level 0 + Gain 1.05 blows out) still holds. |
| Soften | 0.6 | **0.8** | Slightly more spread per lap; measured the best structure (luma σ 0.45) without diluting growth. |
| Input Amount | 0.35 | 0.35 | Unchanged. |

Measured at the shipped defaults: 900 frames → mean 0.59, no NaN, all channels in 0–1;
growth 64 → 264 lit pixels in 20 frames; Gain 1.5 never exceeds 1.0; Auto Level 0 +
Gain 1.05 → mean 0.993 (blows out, as it must).

### Extra files (not in §2)

- `scripts/verify-ring-fbos.mjs` — the shader harness cannot see the FBOs. This one
  drives the REAL `FBOManager` on a real WebGL2 context (via the project's own Vite dev
  server) and covers the two §7.5 cases a person otherwise has to watch for: dragging
  Delay 1 → 30 → 1 (every new slot is seeded with the last frame, so the picture freezes
  rather than flashing black; surplus slots are freed) and node deletion (`deleteRing`
  frees every slot and is a safe no-op for an id that owns nothing). 14 assertions.
- `src/components/NodeEditor/NodeCard.jsx` — one line: `'FEEDBACK_MACHINE': '#c46bff'`.
  Without it the node falls back to `#00e5ff`, the colour of a custom-shader node.

### Incidental fixes

- `src/components/common/ProjectBrowserModal.jsx` — `npm run lint` was already failing
  before this work: `useBrowserStorage` is a storage function, not a React hook, and
  `react-hooks/rules-of-hooks` bans calling a `use*` name inside a callback. Imported as
  `switchToBrowserStorage` at the import site. No behaviour change.
- `scripts/verify-feedback.mjs`, and both new harnesses — honour
  `PLAYWRIGHT_CHROMIUM_PATH` so they run on an image that ships its own Chromium.

### Still open

- §7.5's UI checks (duplicate a node, put one in a compound, save and reload) were not
  driven through the app.
- `EFFECT_PRESETS` in `src/components/MediaPool/MediaPool.jsx` — the Effects tab's
  drag-and-drop palette is a curated subset and was left alone, as §2 specified. Add
  `{ type: 'FEEDBACK_MACHINE', name: 'Feedback Machine', color: '#c46bff', icon: '∞' }`
  there if it should be draggable from that tab too.
