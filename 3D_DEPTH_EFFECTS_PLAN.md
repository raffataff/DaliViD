# DaliViD — 3D / Z-Depth effects family (brainstorm + implementation plan)

> **STATUS: Phases 1–4 are built.** Shipped: `src/shaders/lib3d.glsl.js`, and the `DEPTH`,
> `NORMALS_3D`, `RELIGHT_3D`, `AO_3D`, `FOG_3D`, `BOKEH_3D`, `CAMERA_3D`, `STEREO_3D`,
> `MULTIPLANE`, `DEPTH_DISPLACE`, `VOXEL_3D`, `TIME_SLICE_3D` nodes — **12 nodes, 63 primary
> modes, 152 params** — plus eleven compound presets and an in-place fix to the existing
> `DEPTH_BLUR` perf cliff.
> Several decisions changed during implementation — see **§10 What actually shipped** at the
> bottom, which is the accurate record. Phases 5–6 below are still design.

Goal: a **"3D / Depth"** node category whose effects read as real volume and real camera
movement, not as warped wallpaper. Everything below is fragment-shader-only unless flagged,
fits the existing `@param` / audio-driver / DAG conventions, and states the trick that makes
it cheap.

---

## 0. The one architectural decision that makes all of this work

Video is flat RGB. There is no depth buffer. So the category needs **a depth source, produced
once, consumed by many** — not 15 nodes each guessing at depth internally.

```
VIDEO ──┬──────────────────────────────────────────────► [consumers]
        └──► DEPTH ──► (depth+normal RGBA) ──► CAMERA_3D / RELIGHT / FOG_3D / BOKEH / AO / …
```

Three consequences, all of them wins:

1. **The DAG already caches this for free.** `DEPTH` writes its own FBO; ten downstream nodes
   read one texture. No new machinery — `resolveProducer` handles it today.
2. **Depth becomes wirable.** A hand-painted `SHAPE_INPUT` gradient, a real depth-map video on
   track 2, a luma matte, or `DEPTH`'s estimate all plug into the same socket. That is a
   composability multiplier the "one fat node does everything" approach can't reach.
3. **Depth can be computed at ¼ res** and shared, so the expensive part is paid once at 1/16 the
   pixel count.

**Socket convention:** every node in this family gets a second texture input `depth`
(`nodeDefinitions.js`), optional. Unwired → the node falls back to its own cheap internal
estimate (so a node dropped bare still does something). Wired → it uses the real thing.

**Packing:** one RGBA16F target carries everything downstream needs —
`R = depth (0 near … 1 far)`, `GB = normal.xy` (reconstruct `z = sqrt(1-x²-y²)`),
`A = confidence / matte`. One bind, one fetch, no second pass.

**Shared GLSL:** add `src/shaders/lib3d.glsl.js` exporting `DEPTH3D_HEADER` — the same
string-concat pattern as the existing `TRANSITION_HEADER` / `BlendModes.glsl.js` /
`injectAudioDrivers`. Holds `sampleDepth`, `depthNormal`, `vogelSpiral`, `blueNoise`,
`marchHeightfield`, `triplanar`, `sdBox/sdSphere`, `rotate3`. Twelve shaders, one copy of each
helper, and the smoke test stays happy because the header is injected before parsing.

---

## 1. `DEPTH` — monocular depth estimator (the keystone node)

Not ML — a weighted cue stack. Individually each cue is a guess; combined and edge-smoothed
they're convincing enough for parallax, fog and relighting, which is all we need.

**Cues (each a `@param` weight, so it's tunable per shot):**

| Cue | Rationale | Cost |
|---|---|---|
| Luma | lit subjects are usually nearer than shadowed background | 1 tap |
| Saturation | atmospheric perspective desaturates distance | free |
| Blue/warm ratio | distant = bluer (Rayleigh); classic matte-painting cue | free |
| Local contrast (variance in 3×3) | in-focus = sharp = near; the strongest single cue | 9 taps |
| Vertical gradient | ground planes recede upward; "sky is far" | free |
| Radial bias | subject-centre bias, cheap vignette-as-depth | free |
| Edge/occlusion boundaries | Sobel → depth discontinuity, keeps silhouettes crisp | 8 taps |

**Modes:** `Auto Blend` · `Contrast (focus)` · `Luma` · `Aerial (color)` · `Radial` ·
`External (use depth input)` · `Chroma Key Depth` (keyed subject = near, rest = far — the most
*accurate* option when there's a green screen).

**The quality move — edge-aware (cross-bilateral) smoothing.** Raw per-pixel depth is noisy and
gives boiling parallax. Blur the depth guided by the *colour* image: samples whose colour differs
get weight ~0. Result: depth that's flat inside objects and snaps exactly at their edges. Costs
a 9-tap pass at ¼ res.

**Perf:** run the whole node at 0.25× into a `fixedSize`-style scaled FBO, then edge-aware
upsample on read (`lib3d.sampleDepth` does the joint-bilateral upsample inline, 4 taps). ~1/16
the work of a full-res estimate and it looks better, because the downsample *is* a denoiser.

**Temporal stabilisation:** blend this frame's depth with last frame's via the existing
`FEEDBACK`-style ping-pong, rejecting where colour changed a lot. Kills flicker on grain.
One extra tap.

**Future upgrade, same socket:** MiDaS-small / Depth-Anything via ONNX Runtime Web (WebGPU or
WASM), run every Nth frame at 256×256 and uploaded as a texture. The node's `External` mode
means this can arrive later as a **new depth producer** with zero changes to the twelve
consumers. Worth designing for now, building later.

---

## 2. `NORMALS_3D` — surface normals from depth

Standalone (also folded into `DEPTH`'s output packing). Modes: `Depth Gradient` ·
`Luma Emboss` · `Sobel 3-tap` · `Screen Space (dFdx)`.

- Quality mode: 4 depth taps → cross-product of tangents. Handles depth discontinuities by
  picking the *smaller* gradient of each pair (avoids normals smeared across silhouettes — the
  standard SSAO-era fix).
- Draft mode: `dFdx/dFdy(depth)` — **zero extra taps**, hardware derivatives. Blocky at 2×2 quad
  granularity, invisible once it's driving a light.
- Output as a viewable RGB normal map so it can be inspected, and reused as a `DISPLACEMENT`
  input (the repo already has that node — normals as a displacement map is instantly useful).

---

## 3. Parallax / 2.5D camera — the "it's actually 3D now" family

### 3a. `CAMERA_3D` — virtual camera over a depth field

The headline node. Depth + a virtual camera transform → real parallax.

**Modes:** `Dolly` (push in; near objects grow faster — this alone reads as 3D where a plain
zoom never does) · `Orbit` · `Sway / Slide` · `Handheld` (procedural fBm jitter, 3 octaves) ·
`Crane` · `Dutch Roll` · `Ken Burns 3D` (auto path across the clip, driven by `Clip Progress`
from the existing `TIME` node).

**Cheap tier — single-tap parallax:** `uv += (depth - pivot) * camOffset`. One texture fetch.
Fine for subtle moves. This is what most tools ship and why 2.5D usually looks like a bedsheet.

**Good tier — parallax occlusion mapping (relief mapping).** March the view ray through the
depth field in UV space: 12 linear steps to find the crossing, then 4 binary-refine steps.
Now near objects genuinely **occlude** far ones — you get silhouettes, not smear. 16 taps of a
¼-res depth texture ≈ 4 full-res taps of cost. This is the single biggest quality-per-flop jump
in the whole document.

**Optimisations:**
- **Step count scaled by view angle** — a straight-on ray needs ~4 steps, a grazing ray needs 16.
  `steps = mix(4, 16, sin(angle))`. Typically halves the average cost.
- **Depth mip pyramid (Hi-Z / conservative stepping)** — build a min-mip of depth and take giant
  steps through empty space, refining only near the surface. 3–4× fewer iterations. *Needs
  `generateMipmap` on FBO textures — not currently done in `TextureManager`; small addition.*
- **Early-out on flat gradient** — where `|∇depth| < ε` there's nothing to occlude, so skip the
  march entirely and take the single-tap path. Big win, because most of a frame is flat.

**Disocclusion (the real problem — everyone gets this wrong).** Moving the camera reveals pixels
that were never filmed. Three fill modes, all cheap:
1. `Stretch` — walk along the parallax direction until depth stops jumping; smear that edge
   pixel. Reads as motion blur, nearly free.
2. `Backdrop` — a heavily blurred, dilated copy of the frame behind everything (one extra ¼-res
   pass, reused across the whole family). Cheapest convincing fill.
3. `Void` — leave it transparent. Combined with the alpha pipeline this is *deliberately*
   beautiful — the frame tears open as you move.

### 3b. `MULTIPLANE` — depth-sliced parallax (Disney's multiplane camera)

Quantise depth into N ≤ 8 bands; offset and scale each band independently; composite
back-to-front. **N taps, no marching, and it's a look in itself** — crisp cardboard-cutout
parallax, anime / Wes Anderson / paper-diorama. Params: slices, spread, per-slice
scale/rotate/blur ramp, edge feather, "slice separation" (explode the layers apart for a
visible-diorama effect).

Trick: the loop is fully unrolled over a `const int MAX_SLICES = 8` with a `break` — the same
dynamic-bound pattern already used in `TUNNEL`.

### 3c. `STEREO_3D` — stereoscopic output

Two parallax offsets. Modes: `Anaglyph` (R/cyan — 2 taps, and it *instantly* reads as 3D) ·
`Side-by-Side` · `Over-Under` · `Interlaced` · **`Wiggle`** (auto-oscillate between the two eyes
at 4–8 Hz; the brain resolves depth with no glasses — cheap, uncommon, and mesmerising) ·
`Dubois Anaglyph` (a proper 3×3 matrix per eye, kills ghosting and retains some colour).

Params: interaxial, convergence plane, ghost reduction, eye swap. Cost: 2 fetches. Best
wow-per-flop in the document.

### 3d. `POINT_FIELD` — depth-scattered particle/point cloud

Every pixel becomes a point at `(x, y, depth)`, viewed by a moving virtual camera. Gaps between
points where the surface stretches — the classic Kinect / LiDAR scan look.

Fragment-only version = POM with a hard hit threshold and a per-cell size, so it's the same march
as `CAMERA_3D` with different shading. Modes: `Points` · `Splats` · `Voxel Dust` ·
`Wireframe Grid` · `Scan Lines`. Audio: `bass` blows the cloud apart along its normals.

*(A true scattered version wants an instanced-point draw path, which the pure fragment-quad
pipeline doesn't have. Flagged as the one item in this document that needs a new draw call —
worth it later, not first.)*

---

## 4. Raymarched geometry — true 3D, video as the skin

The existing `TUNNEL` / `COSMIC` / `CRYSTAL` nodes already raymarch. This family aims that
machinery at **the footage** instead of at pure noise, which is the missing half.

### 4a. `HEIGHTFIELD_3D` — the video as terrain / relief

Raymarch depth-as-height, shade with the video as albedo, light it. Modes: `Terrain` (looking
across the frame as a landscape) · `Relief` (shallow, emboss-that-is-actually-3D) ·
`Liquid` (height + animated normals + specular) · `Extrude` (vertical walls at depth edges —
video as a city skyline) · `Ribbon`.

**Perf:** the Hi-Z conservative march again — 8–24 steps typical, capped. Run at 0.5× and
upsample; a heightfield is low-frequency so half-res is invisible.

### 4b. `VOXEL_3D` — video as a receding block field

Pixelate to an M×M grid, extrude each cell to a box of height = luma or depth, then **2D DDA
across the grid** (Amanatides–Woo) with an **analytic box intersection** per cell. No marching
at all — closed-form, and the DDA visits only the cells the ray actually crosses (~O(grid width),
capped at 32). Reads as Lego / Minecraft / tetris-block relief, receding in real perspective.
Modes: `Cubes` · `Columns` · `Pins` (rounded) · `Stacked Slabs` · `Isometric`.
Bass → extrusion height is irresistible here.

### 4c. `SDF_LATTICE` — infinite object field, video-textured

An endless grid of SDF primitives using **domain repetition** (`p = mod(p, c) - 0.5*c`) —
infinite geometry for the cost of *one* primitive. Video mapped on via **triplanar projection**
(3 taps, blended by |normal| — no UVs needed). Modes: `Cube Lattice` · `Sphere Grid` ·
`Twisted Columns` · `Menger Sponge` · `Gyroid` · `Truchet Tubes`. Camera flies through it;
`TIME` node drives the flight.

Perf: domain repetition + 32-step cap + `tanh` tonemap (the pattern the existing generators
already use). Cost is flat regardless of how much "geometry" is on screen.

### 4d. `REFRACT_3D` — glass, water, crystal, using the frame as the environment

Raymarch a simple SDF, refract the ray (2 bounces max), sample the **video** as what's behind
the glass. Because the environment *is* the footage, the result always looks integrated instead
of pasted on. Modes: `Sphere` · `Prism` · `Water Surface` · `Ice / Shatter` · `Lens Array` ·
`Liquid Blob` (2–3 smooth-min'd spheres). Add per-channel IOR for free chromatic dispersion —
`treble` → dispersion is a great audio hook.

Perf: 2 bounces, no recursion, ~24 steps. Fresnel via Schlick (one `pow`).

### 4e. `VOLUME_3D` — volumetric fog, god rays, light shafts with real occlusion

March from the camera through a noise volume, occlusion-tested against depth so beams break
around the subject. Modes: `God Rays` · `Fog Bank` · `Dust Motes` · `Smoke` · `Nebula` ·
`Caustics`.

**This is where the best trick lives:** 8 samples that look like 64.
- **Blue-noise dithered step offsets** — jitter each pixel's start along the ray by a
  blue-noise value, so under-sampling becomes high-frequency dither instead of visible banding.
- **Temporal accumulation** through the existing feedback ping-pong — 8 samples/frame converge
  over ~8 frames to 64-sample quality, with a colour-difference reject to prevent smearing on
  motion. `FEEDBACK` proves this pattern already works in this codebase.
- **Half-res + depth-aware upsample.** Volumetrics are the most half-res-tolerant effect there is.

---

## 5. Per-pixel depth shading — near-free, and the biggest "it looks expensive" payoff

### 5a. `RELIGHT_3D` — deferred lighting on flat footage

Normals from depth → up to 3 lights (point / directional / area-ish) with diffuse, Blinn-Phong
specular, rim/fresnel, and per-light colour + falloff. Modes: `Studio` (3-point preset) ·
`Single Key` · `Rim Only` · `Toon / Cel` (quantised NdotL bands) · `Metal` · `Wet / Subsurface`.

Cost: ~10 flops per light, zero extra texture taps. **Flat footage becomes sculpted.** Almost no
web video tool does this and it is the least "meh" thing on the list per unit of GPU. Light
position on float sockets → drive it with a `TIME` node or `bass`.

### 5b. `AO_3D` — screen-space ambient occlusion

Spiral of 8 depth taps, cosine-weighted, multiplied into the shadows. Adds contact shadows and
"solidity" — the thing that makes composites stop looking pasted.

**Trick — interleaved sampling:** rotate each pixel's spiral by a per-pixel hash, then a small
edge-aware blur. 8 taps look like 32. Same idea as blue-noise volumetrics, applied spatially.
Half-res. Modes: `SSAO` · `Curvature` (cheap, luma-based, no depth needed) ·
`Cavity` · `Contact Shadow` (directional, one march).

### 5c. `BOKEH_3D` — proper depth-of-field (and a fix for a real perf bug)

The existing `DEPTH_BLUR` runs a nested `for` loop up to radius 18 — that's **up to 1369 texture
fetches per pixel**, and at 1080p that's a slideshow. Replace it:

- **32-tap golden-angle (Vogel) spiral, scaled by circle-of-confusion.** Constant cost at *any*
  blur radius. This is how every shipping game does DOF.
- **Depth-weighted rejection** so sharp foreground doesn't bleed onto blurred background (the
  artifact that gives away fake DOF).
- **Aperture shapes** — hexagonal / pentagonal / anamorphic-oval / cat's-eye by warping the
  spiral. Free, and it's the difference between "blur" and "lens".
- **Highlight bloom in the bokeh** — weight bright samples superlinearly so specular points
  become real bokeh balls. One `pow`.
- Modes: `Photographic` · `Anamorphic` · `Swirly / Petzval` · `Tilt-Shift` (linear focus plane)
  · `Rack Focus` (focus on a float socket → keyframe or `TIME` node → automatic rack focus).

### 5d. `FOG_3D` — atmospheric depth

Exponential/height fog by depth, gradient-coloured, plus aerial-perspective desaturation and a
blue shift. ~20 flops, no extra taps, and it is *the* cue that sells scale. Modes: `Linear` ·
`Exponential` · `Height Fog` · `Aerial Perspective` · `Depth Tint` (colour-grade by distance —
teal shadows in the back, warm in front, automatically).

### 5e. `DEPTH_DISPLACE` — displacement along the depth gradient

Push UVs along the surface normal → objects inflate, melt, shatter or explode *volumetrically*
instead of sliding flat. Modes: `Inflate` · `Melt` (gravity-biased) · `Explode` (along normals,
`beat`-triggered) · `Shear by Depth` · `Depth Glitch` (per-depth-band datamosh — near and far
tear at different times, which is far more interesting than a flat glitch).

---

## 6. Time as the third axis (the sleeper idea)

### `TIME_SLICE_3D`

**Z is time.** March "into" the video's past: each depth step samples an older frame. Gives
slit-scan, time-tunnels, temporal echo volumes, and "the frame smeared into a 3D corridor of its
own history".

**The trick that makes it cheap:** keep the frame history in **one atlas texture** — a 4×4 grid
of ¼-res frames = 16 frames of history in a single 2× -sized texture, written one tile per frame
via a scissored blit. One texture bind, one fetch per step, no array textures, no 16 FBOs.

Modes: `Time Tunnel` (depth = age) · `Slit Scan` (x or y = age) · `Radial Time` (radius = age) ·
`Depth-Gated Echo` (only near/far objects trail) · `Luma Time` (bright pixels are from the
future). Audio: `bass` → how deep into the past the camera reaches. Nothing else in the app does
this and it costs almost nothing.

---

## 7. Optimisation playbook (reusable across the whole app, not just this family)

Ordered by payoff.

1. **Scaled FBOs.** Add a `scale: 0.5 | 0.25` option to `FBOManager.create` (natural sibling of
   the `fixedSize` flag added for the alpha probe) plus a depth-aware upsample helper. Depth, AO,
   fog and volumetrics are all half- or quarter-res-tolerant. **4–16× on the expensive passes.**
2. **Constant-tap sampling: golden-angle/Vogel spiral + per-pixel rotation.** Retire every
   `O(r²)` nested loop in the registry (`DEPTH_BLUR`, `BLOOM`, `AO`). Blur radius stops
   affecting frame time.
3. **Blue noise + temporal accumulation via the existing feedback ping-pong.** 4–8 samples/frame
   → 64-sample look. Applies to volumetrics, AO, DOF, soft shadows.
4. **Mip chain as an acceleration structure.** `generateMipmap` on FBO colour textures (not
   currently done) → conservative Hi-Z stepping for POM and heightfield marching. **3–4× fewer
   iterations**, and mips also give free cheap blur for the backdrop/disocclusion fill.
5. **Analytic intersections instead of marching** wherever the shape has a closed form — boxes,
   spheres, planes, cylinders. `VOXEL_3D` should never march.
6. **Domain repetition** (`mod`) for infinite geometry at the cost of one primitive.
7. **Dynamic loop bounds + early-out.** The `if (i > maxIters) break;` pattern already in
   `TUNNEL`, applied everywhere, plus gradient-based skips (flat depth → no march).
8. **A global Quality convention.** A shared `@param name="Quality" options="Draft,Good,Best"`
   that scales step counts, and a renderer-level `_qualityScale` that drops to Draft while
   scrubbing/dragging and forces Best on export. Precedent exists: `previewTapEnabled` already
   distinguishes "this frame is for the eye" from "this frame is output".
9. **Channel packing.** Depth + normal + confidence in one RGBA16F. One bind instead of three.
10. **Hardware derivatives** (`dFdx/dFdy`) for normals and for filter-width — free gradients.
11. **Move everything invariant to uniforms.** Camera matrices, light positions, noise offsets
    computed once per frame on the CPU. The float-node system (`TIME`/`MATH`/`ENVELOPE`) already
    delivers per-frame scalars, so this is mostly free.
12. **`tanh` tonemapping** on all accumulation shaders — already the house pattern, keeps
    marched output from clipping.
13. **`EXT_disjoint_timer_query_webgl2` is already fetched in `Renderer.js`** — wire it to a
    per-node GPU-ms readout in the node card. Being able to *see* which node costs 8ms is worth
    more than any single optimisation.

---

## 8. Suggested build order

| Phase | Ship | Why first |
|---|---|---|
| 1 ✅ | `lib3d.glsl.js`, `DEPTH`, `NORMALS_3D` (scaled FBOs deferred) | Nothing else exists without these |
| 2 ✅ | `RELIGHT_3D`, `FOG_3D`, `BOKEH_3D`, `AO_3D` | Per-pixel, near-free, immediate "whoa" |
| 3 ✅ | `CAMERA_3D` (POM + disocclusion), `STEREO_3D`, `MULTIPLANE` | The headline features |
| 4 ✅ | `VOXEL_3D`, `TIME_SLICE_3D`, `DEPTH_DISPLACE` (pulled fwd); `HEIGHTFIELD_3D` dropped | High-impact, self-contained |
| 4.5 ✅ | Scaled render targets (`scale` on FBOManager + the `executePass` viewport fix) | Unblocks the heavy marchers |
| 5 | `SDF_LATTICE`, `REFRACT_3D`, `VOLUME_3D` | Heavier marchers — now unblocked |
| 6 | `POINT_FIELD` (needs an instanced draw path), ML depth via ONNX | Pipeline changes |

Phase 5 was gated on the scaled-FBO work rather than on shader effort — `VOLUME_3D` is the most
half-res-tolerant effect in the document and building it at full resolution would have meant writing
it twice. That gate is now open: `nodeFBOScale` is the one place to add a node type, and each of the
three phase-5 nodes should ship with its own Resolution param from day one.

Phase 2 is the highest value-to-effort ratio in the whole document: four nodes, no marching, no
new draw paths, and flat footage starts looking lit and volumetric.

**Compound presets to ship alongside** (`compoundPresets.js`), because a preset is what makes
this discoverable: *Cinematic Depth* (DEPTH → FOG → BOKEH → RELIGHT), *3D Photo* (DEPTH →
CAMERA_3D dolly with Ken Burns), *Diorama* (MULTIPLANE + tilt-shift BOKEH), *LiDAR Scan*
(DEPTH → POINT_FIELD → bloom), *Anaglyph Retro* (STEREO + CRT), *Bass Terrain*
(HEIGHTFIELD with bass → height), *Time Corridor* (TIME_SLICE + VOLUME_3D).

---

## 9. Node count (as designed)

11 new nodes × 5–6 modes each ≈ **60 distinct looks**, sharing one depth estimator, one helper
header, and roughly four genuinely new techniques (bilateral depth, POM, Vogel sampling,
temporal accumulation). That ratio — few primitives, many combinations — is the same reason the
existing generator nodes carry their weight, and it's what keeps the bundle and the maintenance
surface small.

---

## 10. What actually shipped (Phases 1–4)

12 nodes, 63 primary modes, 152 params, one shared header. Several design decisions changed on
contact with the code, and each change was an improvement:

### Depth is greyscale, not packed with normals

§0 proposed packing `depth | normal.xy | confidence` into one RGBA16F to save a pass. **Dropped.**
Packing breaks the thing that makes the family composable:

- `TEXTURE_INPUT_SOCKETS` in `clipGraphManager` falls an unwired secondary texture input back to
  the **primary input**. With greyscale depth that fallback is *meaningful* — a consumer dropped
  in bare reads the colour image's own luma as a crude depth signal and does something sensible
  with zero wiring. With a packed format, an unwired socket would be reading colour as if it were
  a normal buffer, i.e. garbage.
- A greyscale map is **viewable** while you tune it (that's what `DEPTH`'s Output → Colorized is
  for), and it drops straight into the existing `DISPLACEMENT` node.
- A painted `SHAPE_INPUT` gradient, a real depth-map video and a luma matte all become valid
  depth sources for free. A packed format admits exactly one producer.

Normals are recomputed per consumer instead — 4 taps, and only `RELIGHT_3D` / `AO_3D` / `NORMALS_3D`
want them at all. Cheaper than plumbing them through, and it keeps every node self-contained.

### Scaled (half/quarter-res) FBOs — now shipped, and the blocker was one line

§7's biggest single win. Deferred through phases 1–4 (it is the one change that touches
every-node-every-frame code), then done once the shader work was stable.

The blocker turned out to be a single line. `Renderer.executePass` did:

```js
this.fbos.bind(outputFBOId)
gl.viewport(0, 0, this.width, this.height)   // ← overrode the correct viewport
```

…and `FBOManager.bind` had *already* set the viewport from the bound target's own dimensions. So
the hardcoded line silently clobbered it, and any scaled pass would have rendered into a corner of
its own buffer. It is now guarded (`if (!outputFBOId)`, i.e. only when drawing straight to the
screen, where there is no entry to read dimensions from). Provably identical for every existing
FBO because they are all canvas-sized — and that one line is also the rollback.

The rest:

- `FBOManager.create` takes `scale` (sibling of `fixedSize`); `resize` re-applies `entry.scale`, so
  a 0.5× target stays 0.5× across a canvas resize; `getScale` lets a caller detect a changed ratio.
- Changing a scale means **rebuilding** the FBO, not resizing it — `resize` deliberately preserves
  the buffer's own ratio, so the executor's `ensureFBO` destroys and recreates on a mismatch.
- **Opt-in per node type through a real UI param** (`nodeFBOScale`), not a hidden table. Only
  `DEPTH` uses it — Resolution: Full / **Half (default)** / Quarter. Its output is a low-frequency
  data map, consumers sample it with normalized UVs and get a bilinear upsample for free, and the
  downsample actively *helps*: it is a denoiser, and noisy depth is precisely what makes parallax
  boil. An image-chain node at half res would simply look soft, which is why this isn't global.
- **Feedback nodes are excluded.** Their output IS their history, so a scaled target would compound
  resampling every frame into mush.

Every other optimisation shipped earlier, needing no pipeline change at all:

| Trick | Where |
|---|---|
| Golden-angle (Vogel) spiral — constant taps at any radius | `BOKEH_3D`, `AO_3D`, `DEPTH_BLUR` |
| Interleaved gradient noise rotation — 8 taps resolve like 32 | `AO_3D`, `BOKEH_3D`, contact shadow |
| One 8-tap ring shared between two cues | `DEPTH` (`d3_ringProbe`) |
| Dynamic loop bounds + `break` | `AO_3D`, `BOKEH_3D` |
| Analytic aperture warp instead of a sample LUT | `d3_aperture` |
| Discontinuity-safe gradient selection (no extra taps) | `d3_normalFromDepth` |
| Laplacian instead of a spiral where 2nd-derivative suffices | `AO_3D` curvature/cavity |
| Zero extra texture fetches for all lighting | `RELIGHT_3D`, `FOG_3D` |

### `DEPTH_BLUR` fixed in place, not replaced

Its nested `x`/`y` loop reached a 37×37 kernel — ~1369 fetches per pixel at radius 18. Rather
than deprecate it and leave the landmine in every existing project, it now uses a 24-tap Vogel
spiral with a Gaussian disc falloff. **Params are byte-identical**, so saved projects keep their
values and just get faster; Rec.601 luma is kept (not `lib3d`'s Rec.709) so the depth estimate —
and therefore the look — doesn't shift.

### Phase 3: `POINT_FIELD` folded into `CAMERA_3D`, and disocclusion turned out to be free

§3a proposed POM and §3d proposed a separate `POINT_FIELD` node. Building POM revealed they are
the same march with different shading, so `POINT_FIELD` is **not** a separate node — the useful
half of it (hard-threshold hits, visible tearing) is `CAMERA_3D` with Reveal Fill = *Void*. A
genuinely scattered point cloud still wants an instanced draw path and stays in phase 6.

Three things came out better than designed:

- **Adaptive cost off one number.** `travelPx = length(P * u_resolution)` — how far the parallax
  travels in *pixels* — drives the early-out AND the step count. §3a proposed scaling steps by
  view angle; travel distance is strictly better, because it also gives a free early-out for the
  overwhelmingly common case of a camera that has barely moved.
- **Disocclusion detection costs nothing.** §3a treated the revealed region as the hard problem
  needing its own detection pass. It doesn't: `d3_pom` already samples every step, so tracking the
  largest height discontinuity crossed is one `max()` on data already in registers. That number
  *is* "did this pixel come from across a silhouette".
- **Hi-Z / mip-based conservative stepping was NOT needed.** §7's item 4 wanted a depth mip chain
  to skip empty space. With travel-adaptive step counts the linear march is already 4–24 steps,
  and the binary refine removes the stair-stepping far more cheaply than extra linear steps would.
  Mips would also need `generateMipmap` on FBO textures, which `TextureManager` doesn't do. Dropped
  as unnecessary rather than deferred.

And one thing that had to be *less* clever than designed: **`STEREO_3D` is single-tap, not POM.**
Stereo parallax is signed around a convergence plane — near content shifts one way, far content the
other — which is not the "march down into a heightfield" problem POM solves. Per-eye occlusion
error is also sub-pixel, so POM would buy nothing for 20× the cost. It samples 2 colours + 2 depths
and that is genuinely all it needs.

### Phase 4: the frame-history atlas was unnecessary, and `HEIGHTFIELD_3D` was dropped

§6 designed `TIME_SLICE_3D` around a 4×4 atlas of quarter-res past frames written one tile per
frame with a scissored blit — new renderer plumbing. **Not needed.** Declaring `u_prev_frame` makes
`executeGraphDAG` hand the node its own ping-pong pair (the `isFeedback` branch, already there for
`FEEDBACK`), and every mode worth having is expressible as
`f(live frame, my own last output, depth)`. **The output IS the accumulator.** History therefore
costs one FBO the renderer already knows how to create, resize and free — zero new plumbing, and
the atlas idea moves from "phase 4 blocker" to "not a good idea".

That reframing changed the modes for the better, too. An atlas gives you random access to N discrete
past frames, which sounds more powerful but mostly produces echo effects. A single recursive buffer
gives you a *continuous* age axis, and that is what makes **`Depth Freeze`** work: each pixel's
probability of refreshing this frame falls off with depth, so the far field lags in time behind the
near field by an amount that varies smoothly per pixel. The update is deliberately **discrete** (a
per-pixel hash against that probability) rather than a blend — discrete gives the grainy datamosh
texture that reads as *time*, whereas a smooth blend just looks like motion blur. Both are shipped
so you can compare: `Depth Freeze` vs `Time Smear`.

**`HEIGHTFIELD_3D` (§4a) was dropped rather than deferred.** It overlaps `VOXEL_3D` visually while
costing strictly more, and — the deciding argument — `VOXEL_3D`'s quantisation is what buys its
face shading. Because heights snap to discrete levels, a march step that lands on a *taller* cell
proves the ray is grazing that block's vertical face rather than its top, so faces shade correctly
from two facts the march already computed: no normals, no lights, no extra taps. A smooth
heightfield has no such structure and would need real normals and lighting to look like anything.
Quantising is cheaper *and* better here, which is rare enough to be worth writing down.

### Files touched

- **new** `src/shaders/lib3d.glsl.js` — the shared header (depth sampling, normals, Vogel disc,
  aperture warp, ring probe, `d3_pom`, `d3_camVector`). Invariant: no helper references a
  `u_*` uniform, so the header is order-independent and the smoke test's undeclared-uniform
  check stays meaningful.
- `src/shaders/shaderRegistry.js` — 12 new shaders + the `DEPTH_BLUR` rewrite.
- `src/shaders/nodeDefinitions.js` — socket layouts, incl. the `depth_map` input.
- `src/gl/clipGraphManager.js` — one entry: `depth_map: 'u_depth_map'` in `TEXTURE_INPUT_SOCKETS`.
  That single line is what gives the whole family its optional depth input, its
  fall-back-to-colour behaviour, and correct topological ordering (`topSort` uses all edges, and
  `texEdges` filters on this map). Plus `nodeFBOScale` + a scale-aware `ensureFBO`.
- `src/gl/FBOManager.js` — the `scale` option on `create`, scale-preserving `resize`, `getScale`.
- `src/gl/Renderer.js` — the `executePass` viewport guard (the one line that blocked scaled targets).
- `src/shaders/compoundPresets.js` — Cinematic Depth, Sculpted Light, Miniature (Tilt-Shift),
  Depth Reactor, 3D Photo (Parallax), Paper Diorama, Anaglyph Retro, Wiggle 3D, Bass Voxels,
  Time Corridor, Liquid Depth.
- `src/components/NodeEditor/NodeSearchMenu.jsx` — "3D / Depth" category.
- `src/components/NodeEditor/NodeCard.jsx`, `src/components/MediaPool/MediaPool.jsx` — colours,
  icons, Effects-tab entries.

### Not yet verified

`npm run lint` (ESLint + shader smoke test) and `npm run build` have **not** been run — the
Cowork Linux sandbox failed to start this session. Every check the smoke test performs was
audited by hand (structure, `@param`↔uniform 1:1 adjacency for all 79 params, select-default
ranges, hex colour formats, uniform declaration coverage, delimiter balance), but a real
WebGL2 compile is the only thing that proves the GLSL. See CLAUDE.md's backlog for the
verification checklist.
