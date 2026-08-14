# DaliViD — project notes for Claude

DaliViD ("GLSL Video Forge") is a desktop-first, browser-based video + real-time GLSL
shader tool: a node-based shader graph, audio-reactive processing, live camera/video/image
sources, compound reusable effects, per-clip shader chains, and a live WebGL2 render pipeline.

The full original design spec is `GLSL_VideoForge_MasterPrompt_v3.md` (long — grep it for a
section rather than reading whole).

## Stack

- React 18 (hooks only, no class components) + Vite.
- Rendering: **raw WebGL2** (no Three.js) — shaders compiled directly.
- State: Zustand (`src/store/*`).
- Audio: Web Audio API (`AnalyserNode` FFT).
- Code editor: Monaco (lazy-loaded), per-node shader editing.
- Persistence: IndexedDB (`idb-keyval`) + optional project-folder save; `localStorage` for UI prefs.

## Commands

- `npm run dev` — Vite dev server (use this to verify changes).
- `npm run build` — production build.
- `npm run lint` — ESLint (react-hooks rules on; no unused vars) **+ the shader smoke test**.
- `npm run smoke:shaders` — dependency-free static validation of every registry shader (structure,
  undeclared `u_*` uniforms after audio injection, `@param` integrity). Also runs as part of lint.

**Node `^20.19 || >=22.12`** (Vite 8 / rolldown), enforced: `engines` in `package.json` plus
`engine-strict=true` in `.npmrc`, so a stale Node fails at install rather than warning. CI pins the
same major. This is not theoretical — Node 20.11.1 installed with only an `EBADENGINE` warning and
then failed the build from inside rolldown with `'node:util' does not provide an export named
'styleText'` (added in Node 20.12.0), which looks nothing like a Node version problem.

> Note: the Cowork Linux sandbox has been failing to start, so builds/lint often can't be run
> in-session — verify with `npm run dev` locally. **As of 2026-08-07 `npm run lint` (ESLint + the
> shader smoke test) and `npm run build` both pass**, so anything below claiming "lint/build have
> NOT been run" refers to when it was written, not to now. Those entries' *static* checks are
> confirmed; only their runtime (WebGL2) checks are still open.
>
> **Both static checks CAN be run in-session even with the device sandbox down (2026-08-12).**
> Neither needs the repo's `node_modules`, only Node: `scripts/smoke-shaders.mjs` is
> dependency-free, so copying it plus `src/shaders/{shaderRegistry,transitionRegistry,lib3d.glsl}.js`
> and `src/utils/{paramParser,audioDrivers}.js` into a scratch tree and running it there is the
> whole job; ESLint needs only `eslint`, `@eslint/js`, `globals` and the three
> `eslint-plugin-react*` packages installed beside a copy of `eslint.config.js`. `npm run build`
> is the one that genuinely needs the full install. Worth the five minutes — it is the difference
> between "hand-audited" and "checked".

## File map (where things live)

- `src/shaders/shaderRegistry.js` — **single source of truth** for each node type's GLSL.
  Parsed for `@param` directives that become the node's UI sliders. `getNodeSource(node)`
  resolves custom edits → attached `shaderCode` → registry default.
- `src/shaders/nodeDefinitions.js` — socket layouts (`inputs`/`outputs`) per node type + helpers.
- `src/shaders/lib3d.glsl.js` — `LIB3D`, the shared GLSL header for the 3D/Depth family
  (depth sampling, normal reconstruction, Vogel disc sampling, aperture warp, ring probe).
  Concatenated into each shader at `registerShader` time, so `getNodeSource`, Monaco and the
  smoke test all see the assembled source. **Invariant: no helper in it references a `u_*`
  uniform** — everything is passed as an argument, which keeps the header order-independent and
  keeps the smoke test's undeclared-uniform check meaningful.
- `src/gl/clipGraphManager.js` — `compileGraph` (topo-sort → executable chain) and
  `executeGraphDAG` (the DAG executor: each node writes its own FBO, reads inputs via
  `resolveProducer`/`resolveSocket`). **Compounds recurse through `executeGraphDAG`**, their inner
  FBO keys namespaced by `scopeId` (the old `executeSubChain` is gone). `USE_DAG = true`; a legacy
  linear executor is the fallback.
- `src/gl/Renderer.js` — render loop, built-in programs, full-pipeline + isolated-clip rendering,
  GPU-resource cleanup. `_renderFullPipeline` composites video tracks **bottom-to-top** into a
  ping-pong accumulator via `_compositeTrack`; `releaseNodeResources` frees a removed node's FBOs
  /textures (recursing compounds) via the `nodeLifecycle` removal hook. `connectStores(...)` wires
  Zustand getters in.
- `scripts/smoke-shaders.mjs` — dependency-free shader smoke test (run by `npm run lint`).
- `src/gl/ShaderProgram.js` — compile/link/cache programs, `uploadStandardUniforms`, `uploadUniforms`.
- `src/gl/TextureManager.js` / `FBOManager.js` — texture + framebuffer management.
- `src/store/useGraphStore.js` — master graph + per-clip graphs; `topologyVersion` bumps drive recompiles.
- `src/store/{useAppStore,useTimelineStore,useAudioStore}.js` — app/timeline/audio state.
- `src/shaders/compoundPresets.js` — preset effect chains + `instantiatePreset` / `instantiateUserCompound`.
- `src/utils/{paramParser,topSort,projectSerializer,compoundUtils,audioDrivers}.js` — support utils.
- `src/utils/generatorClips.js` — generator-clip param builders + starter presets
  (`TEXT_PRESETS`, `SHAPE_PRESETS`, `make{Image,Text,Shape}ClipParams`).
- `src/utils/aspectPresets.js` — delivery aspect list + `aspectLabel()` for the widescreen bars UI.
- `src/components/NodeEditor/*` — node UI (`NodeCanvas`, `NodeCard`, `Socket`, `Noodle`,
  `NodeSearchMenu`, `MonacoDrawer`). `MediaPool`, `Inspector`, `Preview`, `Timeline`, `Toolbar` elsewhere.
- `src/components/Preview/ShapeHandles.jsx` — on-canvas move/scale/rotate gizmo for the selected
  shape (node or clip); geometry derived from the canvas rect, so it tracks preview pan/zoom.

## Key conventions (non-obvious — read before editing the pipeline)

- **Source nodes** (`VIDEO_INPUT`, `CAMERA_INPUT`, `IMAGE_INPUT`, `TEXT_INPUT`, `SHAPE_INPUT`) are
  flagged `isSource` in the compiled chain and produce a texture FBO that `resolveProducer` routes
  downstream — they do **not** run an effect shader pass. (`VIDEO`/`CAMERA` pass the composited
  timeline frame; `IMAGE`/`TEXT`/`SHAPE` render their own pixels in a pre-pass — see below.)
- **Two-tier audio model:**
  - Always-live (uploaded by `uploadStandardUniforms`): `u_audio_bands[8]`, `u_audio_rms`, `u_beat`.
  - **Gated** drivers: `u_bass`, `u_mid`, `u_treble`, `u_sub_bass`, `u_low_mid`, `u_high_mid`,
    `u_presence`, `u_rms` are `0.0` unless the `AUDIO_SPLITTER`'s matching band output is wired
    into a node's `audio_drivers` socket. They're auto-declared into effect shaders via
    `injectAudioDrivers`, so shaders use them with no `uniform` line.
- `NON_EFFECT_TYPES` in `Renderer.js` gates whether a graph "has effects". The self-drawing sources
  (`IMAGE_INPUT`, `TEXT_INPUT`, `SHAPE_INPUT`) are deliberately **not** in it, so an image-, text-
  or shape-only master graph still renders. (`TEXT_INPUT` used to be listed, which silently killed
  text-only master graphs — removed.)
- Two-input effects already exist: `MIX_BLEND` and `DISPLACEMENT` (image-as-displacement-map is
  the classic multi-image technique).
- Live, non-serializable sources are tracked in tiny registries keyed by id:
  `cameraRegistry.js` (clipId → MediaStream), `imageRegistry.js` (nodeId → decoded image).
- **Node-removal GPU cleanup:** `useGraphStore.removeNode` publishes the removed node via
  `nodeLifecycle.emitNodeRemoved`; the Renderer subscribes (`onNodeRemoved`) and
  `releaseNodeResources` frees that node's `__n_`/`__npp_`/`__img_` FBOs + `img_` texture,
  recursing compound sub-graphs (inner keys are `scopeId`-namespaced). Keeps the store decoupled
  from the renderer.
- **Multi-track compositing is real:** `_renderFullPipeline` composites each video track's clip
  output bottom-to-top (by `zOrder`) into a ping-pong accumulator using the effective blend mode
  (the clip's mode, falling back to the track's) and `clip.opacity * track.opacity`.
  `applyBlendMode` (`BlendModes.glsl.js`) is backdrop-aware (shows the source as-is where the
  backdrop is absent). `getBlendModeIndex` aliases the Inspector's short labels (e.g. "Add").
  Overlapping clips on one track cross-blend: `getActiveClips` yields all active clips earliest
  -first and each is rendered via `_renderClipToFBO` and composited over the previous (spec §C).
- **Compounds reuse the DAG executor:** `executeGraphDAG` recurses into a `COMPOUND` node's
  sub-graph (inner FBOs namespaced by `scopeId`), so inner image sources, multi-input effects and
  branching work. `EFFECT_INPUT` terminals are sources that map to the compound's input(s);
  terminals tagged `audioBand` drive inner `audio_drivers`.
- **The present pass masks alpha off, and this is load-bearing.** The compositor's output is
  PREMULTIPLIED but the canvas is `premultipliedAlpha: false`, so writing the accumulator's alpha
  to the drawing buffer made the browser multiply RGB by alpha a *second* time when compositing the
  canvas onto the page — a linear fade rendered as a quadratic one. `_presentToScreen` clears the
  screen to opaque black and wraps its draw in `gl.colorMask(true,true,true,false)`, which makes the
  present exactly "composite over black" at zero cost. Do not "simplify" this away.
- **Edge transitions (`src/utils/clipTransitions.js`) are the single source of truth for fades AND
  transitions** — Renderer, Timeline, Inspector and ExportModal all derive region geometry from it,
  so picture, audio and export can't drift. See the section below.
- **The 3D/Depth family is one producer + many consumers, wired through `depth_map`.** `DEPTH`
  estimates depth; `RELIGHT_3D` / `AO_3D` / `FOG_3D` / `BOKEH_3D` consume it via a second texture
  socket registered in `TEXTURE_INPUT_SOCKETS`. Three things fall out of that and all three are
  load-bearing:
  - **Depth is GREYSCALE RGB, 0 = near / 1 = far — not packed with normals.** Packing would save a
    pass and break everything else: `TEXTURE_INPUT_SOCKETS` falls an unwired secondary input back
    to the *primary* input, so with greyscale a bare consumer reads the colour image's luma and
    still does something sensible, whereas a packed buffer would read colour as normals. Greyscale
    also stays viewable while tuning, feeds `DISPLACEMENT`, and lets a painted `SHAPE_INPUT`
    gradient / a real depth-map video / a luma matte all serve as depth sources.
  - Normals are **recomputed per consumer** (`d3_normalFromDepth`, 4 taps) rather than plumbed
    through. Only three nodes want them, and it keeps each node self-contained.
  - `topSort` uses *all* edges, so a depth edge orders `DEPTH` before its consumers automatically,
    and the DAG evaluates one `DEPTH` node once no matter how many consumers read it.
- **`d3_normalFromDepth` picks the SMALLER-magnitude one-sided difference on each axis.** Across a
  silhouette one of the two differences straddles the depth discontinuity and returns a huge bogus
  gradient, which smears the normal — and therefore the lighting — across the edge. Don't
  "simplify" it to a central difference.
- **Constant-tap sampling is the house rule for anything with a radius.** `d3_vogel` (golden-angle
  disc) + `d3_ign` (per-pixel rotation) means tap count is independent of radius. `BOKEH_3D`,
  `AO_3D` and (now) `DEPTH_BLUR` all use it. Do not add another `for x { for y { } }` radius loop:
  that is O(r²) and `DEPTH_BLUR` used to hit ~1369 fetches/pixel because of one.
- **A pass's viewport comes from its bound FBO, never from the canvas.** `FBOManager.bind` sets
  `gl.viewport` from the target's own dimensions; `Renderer.executePass` only falls back to
  `this.width/height` when there is no target (drawing to the screen). Re-adding an unconditional
  `gl.viewport(0, 0, this.width, this.height)` after a `bind` would break every scaled FBO by
  making it render into a corner of itself. `FBOManager.create`'s `scale` option is how a pass opts
  into half/quarter res, `resize` re-applies that ratio on canvas resize, and changing a scale
  requires **destroy + recreate** (`ensureFBO`), because the ratio belongs to the buffer.
  `nodeFBOScale` (clipGraphManager) is the single place that decides which node types may scale —
  only `DEPTH` today, driven by its Resolution param. Feedback (`u_prev_frame`) nodes must never
  scale: their output is their own history, so resampling would compound every frame.

## Edge transitions — fades and transitions are one model

- Every clip has a HEAD region at its start and a TAIL region at its end; each region **is** the
  fade wedge on the clip corner. No effect on a region = a plain linear opacity ramp (what fades
  always were). Assign `clip.transitionIn` / `clip.transitionOut` = `{ type, params }` and a shader
  or node graph owns that window instead, driven by `u_progress` 0 → 1 across it.
- **What a region mixes against** (the thing the old UI never said, which is why transition progress
  felt arbitrary):
  - HEAD with a previous clip overlapping the start → **crossfade**; the region IS the overlap
    (NLE convention), `u_from` = everything composited so far.
  - HEAD with nothing before it → **from nothing**; the region is `fadeIn`, `u_from` = the backdrop
    behind the clip (lower tracks, else black).
  - TAIL → **to nothing**; the region is `fadeOut`, `u_to` = the backdrop. This is the direction the
    old overlap-only model could not express at all: `clip.transition` lived on the INCOMING clip,
    so the last clip in a sequence had no way to wipe out.
- Head and tail are the **same composite pass** with the sides swapped (`_compositeEdgeTransition`).
  `TRANSITION_HEADER` gained `u_backdrop`, bound separately from `u_from`, because on a tail
  `u_from` is the clip itself — falling back toward it at low opacity would make a vanishing clip
  reappear. Head passes bind both to the accumulator, so their output is unchanged.
- **A transition suppresses its edge's plain ramp for the whole clip**, not just inside the region
  (`clipEdgeState`). Suppressing per-frame was wrong: `fadeIn` and the region need not be the same
  length, so the ramp would resume the instant a shorter crossfade finished and snap the picture
  back down. This suppression is also the fix for the old double-dip where a clip carrying both a
  fade handle and a transition got both.
- A tail is **suppressed while a later clip overlaps it** — that cut already belongs to the incoming
  clip's head. The `fadeOut` ramp still applies there (fading the outgoing clip under the incoming
  one is valid); only the transition is blocked. `edgeDisplaySeconds` resolves region-vs-ramp the
  same way the compositor does, so the wedge drawn is always the window actually processed.
- Region neighbours are found with `findPrevOverlap` / `findNextOverlap` over the **full** clip
  list, never from `getActiveClips`. Overlap is a property of the timeline, not of the instant — a
  neighbour entering/leaving the active set mid-region made progress jump.
- **`type` values:** a built-in key from `transitionRegistry`, `compound:<libId>` (shared library
  entry), or `'graph'` — a graph **private to that clip edge**, stored in `useGraphStore.clipGraphs`
  under the synthetic key `` `${clipId}::tr:${edge}` ``. That key is the trick that makes the whole
  feature cheap: every graph action and the entire Node Editor are already keyed by
  `(graphLevel, clipId)`, so a transition graph is editable through existing plumbing with no new
  branches, and the serializer (which maps `clipGraphs` generically) persists it for free.
  `initTransitionGraph` seeds one from `STARTER_TRANSITION_COMPOUND` (or the compound it was forked
  from) with fresh ids; `promoteTransitionGraph` publishes a **copy** to the library.
- Editing a transition graph keeps the **full pipeline** on screen (`_renderFrame` checks
  `isTransitionGraphKey`) — a transition is meaningless in isolation. Opening one parks the playhead
  mid-region so you land on a frame that shows the effect.
- Right-clicking a clip inside a wedge opens that **edge's** menu; anywhere else opens the clip
  menu. One `ContextMenu` swaps between `clip` / `edge` / `edgeType` views rather than nesting
  fly-outs.
- **Migration:** `clip.transition` → `clip.transitionIn` on load (`deserializeProject`);
  `getEdgeTransition` still reads the legacy field so in-memory/undo-restored clips keep rendering.

## Alpha channel — import interpretation, preview, transparent export

- **`src/utils/alphaModes.js` is the model** (pure, no GL): the four modes
  (`auto`/`ignore`/`straight`/`premultiplied`), `ALPHA_MODE_INDEX` (must match
  `ALPHA_INTERPRET_FS`'s `u_alpha_mode`), `resolveAlphaMode`, `alphaSourceKey`, and
  `classifyAlphaSample` — the detector. `src/gl/alphaRegistry.js` is the tiny
  registry (peer of `cameraRegistry`/`imageRegistry`) holding *detected* modes.
- **The pipeline is STRAIGHT alpha end to end**, so a source is converted exactly once,
  in `Renderer._drawSourceWithAlpha` (the video → `clip_input_` pass, which used to be a
  bare passthrough). Nothing downstream knows or cares where the pixels came from.
- **Detection rests on one invariant:** premultiplied colour can never exceed its own
  alpha, because it was produced by multiplying by it. `_probeSourceAlpha` point-samples
  a frame into a 64×64 RGBA8 FBO and reads it back; a sample with bright colour behind
  low alpha proves *straight*. Deliberately **not** averaged — averaging destroys the
  very relationship being measured. The converse isn't provable (straight footage whose
  translucent pixels are dark looks premultiplied), hence the manual override.
  - The probe is driven off the **upload**, not the frame loop, so successive attempts
    see different pictures (a logo can fade in from an opaque first frame). Budgeted at
    `ALPHA_PROBE_MAX_ATTEMPTS`, stops the instant it finds alpha, cached by **filename**
    so splits/duplicates share it, and cleared on project load (a different project can
    have a different `logo.webm`).
  - Its FBO is created `fixedSize: true` — new `FBOManager` option. `resizeAll` would
    otherwise inflate the 64×64 sample grid to canvas size and the readback would cover
    one corner of the frame instead of all of it.
- `TextureManager.uploadVideoFrame` now sets `UNPACK_PREMULTIPLY_ALPHA_WEBGL` explicitly
  (it was whatever the context default happened to be). It only ever mattered once alpha
  video was a supported source; browsers disagree about honouring the hint for `<video>`,
  which is why interpretation is decided by the shader pass, not by the upload.
- **Every frame now presents through `_presentToScreen`.** `_renderFullPipeline` always
  renders the master chain into `__master_present`, and the isolated clip view into
  `__isolated_present`. Before this, a master graph *with effects* and bars *off* had
  `executeChain` blit straight to the drawing buffer — bypassing the present entirely,
  including the load-bearing alpha colour-mask, which is why the fade-out fix only ever
  worked on some projects. Cost is one full-screen blit, i.e. what a bars-on frame
  already paid.
- **Preview backdrop** (`useAppStore.previewBackdrop`: black/checker/white) and
  **alpha-matte view** (`previewAlphaView`) run in `_applyPreviewBackdrop`, which returns
  its *input unchanged* for plain black — the colour-masked present is already exactly
  "composite over black", so the default costs nothing. Both are gated on
  `previewTapEnabled`, the renderer's existing "this frame is for output, not for the
  eye" flag: every export reads the same canvas, so without that gate an export started
  with the checkerboard on would bake a checkerboard into the file. View state only —
  deliberately not serialized.
- **Transparent export.** `renderer._presentAlpha` makes the present keep real alpha:
  `_renderFrame` clears the screen transparent, no colour mask, and `_presentAlphaToScreen`
  **un-premultiplies** on the way to the drawing buffer (the compositor is premultiplied,
  the canvas is `premultipliedAlpha: false`, so it wants straight colour — get this
  backwards and every soft edge exports too dark).
  - PNG: Export → Frame → "Transparent".
  - Video: **WebM (VP9 + Alpha)** — `VideoEncoder` with `alpha: 'keep'`, `VideoFrame`
    with `alpha: 'keep'`, muxed by **`webm-muxer`** (new dep) with `alpha: true` on the
    video track. `alpha: 'keep'` is part of the `isConfigSupported` probe, not just the
    config: an encoder can support VP9 and still refuse alpha, and that must surface
    *before* rendering thousands of frames.
  - WebM carries **Opus, not AAC**, and Chrome's Opus encoder is 48 kHz-only — so
    `renderTimelineAudio` gained a `sampleRate` argument and the container picks it.
  - H.264 has no alpha at all; HEVC-with-alpha is Safari **decode**-only. VP9/WebM is the
    only encode path any browser offers.
- Per-clip UI: Inspector → **Alpha Channel** (video clips only — live streams are opaque,
  generators draw their own alpha). Shows the detected mode live via `useSyncExternalStore`
  on the registry (detection happens inside the render loop; a Zustand write there would
  re-render the app every frame). Matte colour appears only for premultiplied.
- MediaPool import now says *why* a file won't decode instead of importing a silently
  black clip — the common case is a ProRes 4444 / DNxHR `.mov` transparent master, which
  no browser decodes.

## Image source node (added feature)

- `IMAGE_INPUT` is a first-class still-image texture source, peer to video/camera. Its shader
  (in `shaderRegistry.js`) does fit (Cover/Contain/Stretch/Tile) + transform + always-live
  bass-zoom / beat-punch. `Renderer.renderImageNode` decodes the image (cache in
  `src/gl/imageRegistry.js`), uploads it to a texture, and draws it into a per-node FBO
  (`__img_<nodeId>`) in a pre-pass inside `executeGraphDAG`.
- **Persistence:** the image is stored as a **data URL in `node.params.imageSrc`**, which the
  serializer already saves — projects stay self-contained (chosen over external file refs).
- UI: Media Pool "Images" tab, drag-to-canvas, and an on-node loader in `NodeCard`. **Can now be
  compounded** — the unified DAG executor runs the image pre-pass inside compounds too.
- Reactive presets (`compoundPresets.js`): "Image Reactor / Kaleido / Datamosh". Presets can
  declare an `audioWire: ['bass', ...]` per node; `instantiatePreset(..., splitterId)` auto-wires
  those bands from the graph's Audio Splitter on drop.
- `NodeSearchMenu` is an accordion (collapsible categories) and includes a Presets category.

## Shape source node + widescreen bars (added feature)

- **`SHAPE_INPUT`** is a procedural SDF shape source, peer to image/text — nothing to upload, the
  shader evaluates the shape per pixel, so it's resolution-independent and free to animate.
  8 shapes (`u_shp_type`: Rectangle, Ellipse, Triangle, Polygon, Star, Ring, Capsule, Cross) plus
  size / position / rotation / corner radius / sides / inner ratio / thickness / feather /
  fill+stroke+background colors / spin / bass-scale / beat-punch. `Renderer.renderShapeNode` draws
  it into `__shp_<nodeId>` in a pre-pass inside `executeGraphDAG` (mirror of the image pre-pass),
  freed by `releaseNodeResources`.
- **Everything is a `@param`**, which is the point: `hasParamInputs` gives every control a float
  socket, so position/size/rotation/colors can be driven by splitter bands, `MATH`/`ENVELOPE` or
  keyframes, and the transparent background means a shape doubles as a mask / displacement input.
- **Shape coordinate convention** (shader and gizmo must agree): *frame units* — `1.0` == the frame
  HEIGHT on both axes (x is aspect-corrected), `u_shp_x/u_shp_y` are ±1 at the frame edges with **y up**,
  and `u_shp_rot` is **counter-clockwise-positive on screen** (so the SVG gizmo uses `rotate(-deg)`).
- **Shape clips**: `clip.fileType === 'shape'` is a third generator kind alongside text/image —
  `_renderClipToFBO` / `_renderClipGraphIsolated` synthesize the frame straight into
  `clip_input_<id>`; params live in `clip.params` (serialized, fully self-contained).
- UI: Media Pool "Shapes" tab (click = add at playhead, drag → Timeline clip or Node-Editor node,
  the drag payload's `params` patch is applied on drop), an on-card quick shape switcher in
  `NodeCard`, and an Inspector "Shape" section for clips that is **generated from the shader's
  `@param` configs** (add a `@param` → it appears everywhere, no UI edit).
- **On-canvas handles** (`Preview/ShapeHandles.jsx`): shows for a selected `SHAPE_INPUT` node (in
  the graph being viewed, top level only — compound interiors aren't addressable by `setNodeParam`)
  or a selected shape clip. Drag body = move (snaps to center/thirds, Shift = axis lock, Alt =
  no snap), corners/edges = resize about the center in the shape's rotated frame (Shift = uniform),
  ○ handle = rotate (Shift = 15°). It measures the canvas rect on zoom/pan/resize instead of every
  frame, and only the handles take pointer events so preview panning still works.
- **`LETTERBOX` node** crops to a delivery ratio and fills the rest with bars (aspect preset or
  custom ratio, bar color/opacity, feather, offset, zoom-to-fill).
- **Project widescreen bars** reuse that exact shader: `useAppStore.masterBars`
  (`{enabled, aspect, color, opacity, feather, offset, zoom}`, serialized under `project`) drives
  `Renderer._presentToScreen`, the **last** pass of `_renderFullPipeline` — with bars on, the master
  chain renders into `__master_present` and the letterbox pass blits it to the canvas, so bars show
  in the preview and bake into exports (both export paths read the canvas). Isolated clip view is
  deliberately **not** barred. UI: Toolbar toggle + aspect select, full controls in Inspector →
  Project, a "BARS 2.39" badge on the preview.

## Code style

- **Never use a backtick inside a shader's GLSL source.** Every shader in
  `shaderRegistry.js` / `transitionRegistry.js` lives in a JS template literal, so a stray
  backtick in a GLSL comment silently *closes the string* and the rest of the shader is parsed
  as JavaScript. The failure looks nothing like the cause — ESLint reports a bare
  `Parsing error: Unexpected token <identifier>` at whatever word follows the backtick, hundreds
  of lines from anything you edited, and only the FIRST such error. Write `acc`, not
  `` `acc` ``, when quoting an identifier in a GLSL comment. (Backticks are fine in JS-level
  comments *between* `registerShader` calls, which is why some exist in these files.)
- Match existing style: ES modules, hooks, concise comments explaining *why*.
- When editing a function, provide the full function.
- No new deps without reason; keep single-file artifacts/components consistent with the repo.

## Pan / Zoom (added feature)

- **`TRANSFORM` node** (Utility category) is a camera over the incoming frame: Zoom, Pan X/Y,
  Rotation, Edges, Bass Zoom, Beat Punch. It's a plain effect node, so `DEFAULT_EFFECT_DEF` gives
  it `hasParamInputs` and **every control gets a float socket for free** — a RAMP/LFO node, ENVELOPE,
  splitter band or `MATH` can drive the zoom, and Inspector keyframes (◆) work with no extra code.
  A `RAMP` (span `Clip`) with Start 1.0 / End 1.6 into Zoom is a push-in that re-times itself when
  the clip is trimmed.
- **Pan is CAMERA-relative**, not picture-relative: +Pan X moves the *view* right, so the picture
  slides left. Units are frame-edge (±1 = half a frame) and **not divided by zoom**, so "Pan X 0.5"
  means the same place in the source at every zoom level (dividing by zoom would make the slider
  uselessly coarse when punched in). Shares SHAPE_INPUT's conventions otherwise: aspect-corrected
  frame units, `v_uv.y` UP, rotation CCW-positive.
- **Edges is explicit** (`Transparent` / `Clamp` / `Mirror` / `Tile`) because every FBO in the
  pipeline is `CLAMP_TO_EDGE` + `LINEAR` — inheriting the wrap mode would smear the border pixel
  into a streak the moment you pan past the frame. Transparent (default) feathers over ~1px via
  `fwidth` so a rotated edge doesn't alias, and composites over the track below.
- **Per-clip Transform** reuses that exact shader, the same way `masterBars` reuses `LETTERBOX`:
  `Renderer._applyClipTransform` runs `this.transformProgram` over `clip_input_<id>` into
  `clip_xf_<id>` and hands *that* FBO to `_runClipGraph`, so the clip's effects operate on the
  reframed picture. Runs in `_renderClipToFBO` (both the generator and video branches) and in
  `_renderClipGraphIsolated`; freed in `releaseClipResources`.
  - **Identity transforms skip the pass entirely** (`isIdentityTransform`), so an untransformed
    clip — most of them — costs zero extra passes and zero extra VRAM.
  - `src/utils/clipTransform.js` is the shared definition: `getTransformConfigs()` parses the
    TRANSFORM shader's `@param`s (so adding a `@param` adds a clip control with no UI edit),
    `resolveClipTransform` merges stored + keyframed values over the defaults, and
    `CLIP_TRANSFORM_NODE_ID` (`'__clip_transform'`) is the reserved keyframe `nodeId` — keyframes
    are keyed by (clipId, nodeId, paramName) and a clip transform belongs to no graph node. That
    reserved id is what makes an animated punch-in possible **without a node graph at all**.
  - `clip.transform` **replaced a dead placeholder**: clips were created with
    `{ x, y, scaleX, scaleY, rotation }` which was serialized but never read by anything. It is now
    a uniform-keyed object (`{ u_xf_zoom, … }`) or `null`. `resolveClipTransform` only reads known
    `u_xf_*` keys, so projects saved with the old shape load as identity.
  - UI: Inspector → Clip → **Transform (Pan / Zoom)**, above the type-specific sections, for every
    clip kind except audio (`clipSupportsTransform` — audio clips have no picture). Keyframe ◆ per
    slider with auto-key while animated, plus a Reset that **also clears the keyframe tracks**
    (`clearNodeKeyframes`) — leaving them would re-drive the transform and the reset would no-op.
- **Known limit — video punch-ins soften.** `clip_input_<id>` is created at canvas resolution, so
  zooming past 1.0 upscales canvas pixels; a 4K source on a 1080p canvas has already lost the
  detail at upload. Stills don't have this problem — zoom on the `IMAGE_INPUT` node instead, which
  samples `u_image` at its natural size (SHAPE is procedural, so it's sharp at any zoom). See the
  backlog for the oversampled-clip-input idea.

## Array node — repeat / instance (added feature)

- **`ARRAY`** (Utility category) repeats the incoming frame as N copies in a **Grid**, a cascading
  **Chain**, or a **Radial** ring/spiral. Plain effect node, so `DEFAULT_EFFECT_DEF` gives it
  `hasParamInputs` and every one of its 26 numeric controls gets a float socket free — a `RAMP`
  into Count, an `LFO` into Array Angle, a splitter band into Radius, keyframes on any of them.
- **`Anchor` is orthogonal to Mode, and `Keep Original` is a PROMISE.** `Centered` lays the array
  out around the array centre and auto-fits it to the frame — the mosaic / video-wall job.
  **`Keep Original` is the Blender array modifier: copy 0 is the input frame, byte for byte, and
  copies 1..N−1 cascade away from it** — place something where you want it, repeat *from* there.
  Three things follow from that promise and all three are load-bearing:
  - **Keep Original does not fold Array Angle or Center into the query.** Centered rotates and
    re-centres the query once, which is cheap and correct there — but doing it under Keep Original
    would drag the original along with the array. Instead the query passes through untouched, each
    copy's *displacement* is rotated by `dRot`, and the centre is handed to `arAccum` as the pivot
    copies scale and rotate **about**. Copy 0 (displacement 0, Size 1, Copy Angle 0) then
    inverse-maps to `v_uv` regardless of where the centre is or how far the array is turned.
  - **`arAccum` writes the unrotated / unit-scale case out separately, and that is not a
    micro-optimisation.** Subtracting the pivot and adding it back is not bit-exact in float, and
    copy 0 takes exactly that branch — the readback measured a 1/255 drift on the original's edge
    pixels before the split. Identical arithmetic under Centered, where the pivot is zero.
  - **Keep Original steps by signed absolute `Offset X/Y`, not by `Spacing`.** At Size 1 a copy IS
    the whole frame, so "multiples of the copy size" would put every copy off screen; and an array
    has to be able to go left, up, or **nowhere on an axis**, none of which a positive multiple can
    express. Units are frame-edge (±1 = half a frame) with **+Y up**, matching Center X/Y and
    TRANSFORM's Pan — hence the default Offset Y of −0.35, which builds down-right like reading
    order. `Size` 0 = Auto means **1.0** here rather than a fit ratio, for the same reason.
  - **Both jitters skip copy 0 under this anchor** (a scattered original is the thing the anchor
    exists to prevent), but **Bass Size / Beat Punch deliberately still reach it** — those modulate
    the whole array on purpose, and one static copy among pulsing ones reads as a bug.
  - **Keep Original walks the bounded loop in every mode, including Grid.** A zero offset on an
    axis is both the common case there (a plain horizontal repeat) and precisely what a lattice
    inverse-map cannot invert. Copies are capped at `AR_MAX_I`, and `cols`/`rows` are clamped to fit
    that budget exactly so the tail fade can never attach to a row that never renders. The right
    trade: this anchor is for a handful of copies, not a 40×40 wall — which is what Centered is for.
- **Centered Grid does not loop over copies, and that is the whole design.** A grid is a lattice, so the
  copies that can cover a pixel are found by inverse-mapping the pixel to its own cell and then
  visiting only the neighbours whose footprint can still reach it. Cost is therefore **independent
  of the count**: 3×3 and 40×40 both cost one fetch per pixel at the default spacing (measured:
  28.3ms vs 31.5ms per frame in SwiftShader at 320×180 — the residual is the wider neighbourhood
  test, not extra fetches). A `for each copy` loop would be O(count) per pixel, which is the same
  mistake as the radius loops the house rule above bans.
  - The neighbourhood half-width comes from the worst-case copy extent over the **local** index
    window, not the whole grid — `Scale / Copy` compounds by index, and a global bound would push
    a large array to the 5×5 cap for no reason. Capped at `AR_NB` (5×5) regardless, so pathological
    overlap stays bounded; with `Over` that cap is invisible, because past ~5 layers the front
    copies have already covered the pixel.
  - An **unrotated** copy is bounded by its box, a rotated one by its bounding circle. That branch
    is what makes the default a single fetch: at Spacing 1 with no rotation the neighbourhood
    half-width computes to 0.
- **Chain and Radial are a bounded loop (`AR_MAX_I` = 64), walked FRONT TO BACK with an early
  out.** On opaque footage the accumulator saturates at the first copy that covers the pixel and
  the loop stops, so 48 radial copies cost ~1 fetch per pixel plus 48 cheap rejects.
  - Chain positions **compound** (copy k sits at the sum of k rotated, scaled steps), which would
    normally force build-order iteration and kill the early out. The sum is a geometric series in
    the complex plane, so it closes to `(1 - z^k) / (1 - z)` with `z = scaleStep · e^(i·spin)` and
    any copy is evaluable directly. **That closed form is what buys the front-to-back walk** — it
    is not a micro-optimisation. `degen` handles z ≈ 1 (the sum is just `k · step`).
  - `Radius / Turn` is radius gained per **full turn**, so Rings > 1 with a 360° arc is one
    continuous spiral while a partial arc is a fan repeated per ring. One param, two behaviours
    that both read as obvious.
- **Count and Rows are FLOAT uniforms with `step=1`.** `step` is a UI attribute only, so the
  slider still drags in whole copies, but a float socket (LFO / RAMP / audio band / keyframe)
  writes any value and the fractional part **fades the last copy in** instead of popping it. An
  audio-driven Count is unusable without that, and it is free — `tailC`/`tailR` are one clamp each.
- **`Size` 0 means Auto** — `1 / max(count, rows)` under Centered, so dropping the node in and
  setting Count 3 / Rows 3 gives an exact mosaic with no arithmetic; **1.0** under Keep Original,
  because copy 0 has to be the input at its own size. Chosen over a separate Fit checkbox because
  the sentinel lives at the bottom of the slider's own travel, where nobody lands by accident.
- **Everything accumulates PREMULTIPLIED and converts back to straight at the end**, for BLUR's
  reason: a transparent copy carries undefined colour, and blending it straight drags that colour
  in as a halo. `Original` (the untouched frame underneath) is composited under in the same space.
- **`textureLod(..., 0.0)`, never `texture()`.** These fetches sit inside non-uniform control flow,
  where the spec leaves implicit derivatives undefined — and every FBO here is LINEAR with no mip
  chain, so the derivative would be computed and thrown away anyway.
- **`Filtering: Smooth` is a 4-tap box over the pixel footprint, and only fires when minifying.**
  There are no mipmaps to fall back on, so a 12×12 grid shimmers badly without it; the footprint is
  derived analytically from the copy's scale (`1 / (scale · aspect · H)`) rather than from
  `fwidth`, which is the same non-uniform-control-flow problem. Edge coverage is measured in screen
  pixels from the copy's border, which is what keeps a rotated copy's edge from stair-stepping.
- Conventions are TRANSFORM's and SHAPE_INPUT's throughout: aspect-corrected frame units where 1.0
  == the frame HEIGHT on both axes, `v_uv.y` UP, rotation counter-clockwise-positive, position
  params ±1 at the frame edges.
- **Known limits, all deliberate:** copies are sampled from a canvas-resolution FBO, so `Size` > 1
  upscales exactly as `TRANSFORM`'s zoom does; heavy overlap past the 5×5 Centered-grid cap drops
  far copies, which is exact for `Over` and approximate for `Add`/`Screen`; `Spacing Y` is unused
  in Centered Chain (its direction is `Array Angle`, its step is `Spacing X` — Keep Original's
  chain takes a full 2D `Offset` instead); and Keep Original tops out at `AR_MAX_I` copies.

## `@showif` — conditional visibility for GLSL `@param`s

- `paramParser` now parses a `// @showif <uniform> == A,B` / `!= A` directive line, adjacent to its
  `@param` the way `@audiobind` is, into the **existing** `{ param, equals }` / `{ param, notEquals }`
  shape. `NodeCard` and `Inspector` already run every config list through `visibleDataParams`, so
  nothing else had to change — this was the backlog item, and the plumbing was already there.
- **Repeated `@showif` lines accumulate and are ANDed.** `isParamVisible` now accepts an ARRAY of
  clauses as well as a single one; a lone directive still produces a plain object, so every
  `dataNodeParams` entry takes byte-identical code. `ARRAY`'s Spacing Y needs both clauses — it is
  meaningless outside Grid *and* outside the Centered anchor — and one rule could not say that.
- Comparison follows `isParamVisible`: **selects by label** (it normalises a stored index through
  the referenced config's option list first), checkboxes by boolean — hence `true`/`false` are
  coerced. A numeric operand is emitted in **both** string and number form, since a select label
  can legitimately be "3".
- An unparseable directive yields `null` rather than a rule: a typo must not hide the control it
  was meant to reveal.
- **Sockets stay unconditional** (`getNodeSockets` never sees `showIf`), and a **wired** param keeps
  its row via the `alwaysShow` set — so a hidden param can still be driven by a noodle and the
  noodle keeps a real DOM anchor. `ARRAY` is the first shader to use it: Radius / Arc / Face Center
  appear only in Radial, Spacing Y only in Grid, Stacking only when Blend is Over.

## Recently completed

- **`FEEDBACK` gained a `Decay` param (2026-08-14).** Shader-only change — one uniform plus its
  `@param` in `shaderRegistry.js`. Everything downstream is derived, so the Inspector slider,
  keyframing, the float modulation socket (`u_fb_decay`, via `hasParamInputs`) and serialization
  all came for free; nothing else was touched.
  - **Decay is a clamped STEP of the history toward the live frame, not a gain on it.** A gain is
    the obvious implementation and it is algebraically just Feedback again —
    `mix(curr, prev * g, f) == mix(curr, prev, f * g)` with the live term dimmed — so it would have
    been a second slider doing the first one's job, whose only distinguishable effect is the
    picture going dark. `prev - clamp(prev - curr, -d, d)` is what Feedback genuinely cannot
    express: the loop's own relaxation is geometric, so a faint trail *approaches* the live frame
    forever (that is the burn-in at Feedback 0.95+), while a constant step **reaches it exactly, in
    finite time**. Aiming the step at `curr` rather than at black is what keeps it from crushing
    the picture — only the part of the history that DIFFERS from the live frame is eaten.
  - **The `(1 - u_feedback)` scale is load-bearing and its rationale is not the obvious one.**
    It is not there to stop the picture darkening (the step formulation already can't). It is
    there so the two sliders COMPOSE: measured, a raw constant step kills every trail at
    10 / 11 / 11 frames for Feedback 0.7 / 0.85 / 0.95 — i.e. touching Decay makes Feedback stop
    meaning anything — where the scaled step gives 13 / 18 / 30, so Feedback still sets the length
    and Decay shortens it.
  - **Neutral at 0, and the default is 0, deliberately.** `clamp(delta, -0.0, 0.0)` is exactly
    `0.0`, so `hist` is `prev` *bit-for-bit*. A FEEDBACK node saved before this param existed
    carries no `u_fb_decay`, `uploadUniforms` skips it, and GLSL's implicit 0.0 then reproduces the
    old picture exactly instead of silently un-trailing every existing project. Verified byte-exact
    below, not assumed. Do not "improve" the default off zero.
  - **Fixed in passing: the node faded itself in from 85% transparent.** The ping-pong starts
    cleared, so `mix(curr.a, prev.a, f)` began at `1 - f` and crawled up — and *never arrived*,
    because the FBO's own quantisation stalls the geometric approach: opaque footage settled at
    **0.988 alpha in RGBA8 / 0.9985 in RGBA16F, permanently**. `outCol.a = max(outCol.a, curr.a)`
    makes it exact from frame 1. A trail may only ADD coverage, never eat the live frame's matte.
  - **Verified on real WebGL2, `scripts/verify-feedback.mjs`** — the harness CLAUDE.md said was
    worth rebuilding, now kept rather than thrown away (Playwright + SwiftShader; **not** wired
    into `npm run lint`, playwright is deliberately not a dep). 35 assertions, both FBO formats
    `FBOManager` can pick, all passing: Decay 0 **byte-identical to the pre-change shader in RGB**
    at frames 1/2/5/30/60 at default *and* non-default Zoom/Rotate; a still frame bit-identical to
    a passthrough at Decay 0.05 / 0.25 / 0.5 / 1.0 after 240 passes; a trail reaching the live
    frame exactly at frames 27 / 22 / 15 / 12 for Decay 0.02 / 0.05 / 0.2 / 0.5 and provably never
    within 600 at Decay 0; opaque footage exactly opaque from frame 1; a vanished blob leaving
    **exactly zero** residual coverage with Decay vs a stuck 4/255 ghost without it. Cost 0.992x
    over 300 passes, i.e. flat — three ALU ops on a bandwidth-bound pass.
  - Still open (needs a GPU and real footage): whether Decay's useful range is really the whole
    0–1 slider or crowds into the bottom third in practice, and whether the treble audio driver's
    0.15 coefficient is the right strength for burning trails off on transients.

- **`ARRAY` node, its `Keep Original` anchor, and `@showif` for shader params (2026-08-12).** See
  the two sections above.
  **Both static checks AND a real WebGL2 run were done in-session this time.** `smoke:shaders`
  passes at 65 shaders + 35 transitions; ESLint over the whole tree is 0 errors / 1 pre-existing
  warning (`NODE_COLORS` in `NodeCard.jsx`). The runtime check was a throwaway Playwright +
  headless-Chromium/SwiftShader harness that compiled the shader and asserted 24 behaviours —
  **worth rebuilding for the next GLSL change**, since none of these are visible to the static
  test. It is ~200 lines: launch `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` with
  `--use-gl=swiftshader --enable-unsafe-swiftshader`, compile `injectAudioDrivers(getShaderSource(…))`
  against the repo's own fullscreen-quad VS, upload a source texture whose R/G channels ENCODE its
  own uv so any output pixel says exactly where it came from, then `readPixels` and assert.
  - **Geometry:** identity (1×1 at Size 1 reproduces the source to ±1.5/255), the 3×3 auto-fit
    mosaic sampling each cell centre at source (0.5, 0.5), full-frame coverage, linear mapping
    inside a cell, Mirror flipping alternate cells, Radial landing 4 copies on the compass points.
  - **Alpha:** a source alpha ramp surviving inside each copy to ±0.5/255, and straight colour
    restored after the premultiplied blend (this is the halo bug, caught numerically).
  - **Blending:** Stacking changing which overlapping copy wins, Add accumulating in the overlap,
    Source Under filling behind, fractional Count fading the tail copy to exactly half alpha.
  - **The anchor's promise, against a transparent blob source:** a 1×1 Keep Original array is
    byte-identical to a Centered identity; **Center X/Y and Array Angle at extreme values leave it
    byte-identical too** (this is the one that found the pivot round-off — it read 1/255 before
    `arAccum` grew its exact branch); jitter at maximum leaves it byte-identical; and Grid / Chain
    / Radial each place copy 0 on the original with the rest cascading off it.
  - **Cost:** Grid 3×3 vs 40×40 at 28.6ms vs 29.3ms, i.e. flat.
  - Still open (needs a real GPU and real footage): how the Smooth prefilter holds up at 30+
    copies on live video, whether the 5×5 neighbourhood cap is ever visible with `Add`, and
    whether 26 float sockets makes the card unwieldy in practice.

- **The font picker wouldn't stay open, and exported text was stair-stepped (2026-08-12).**
  Reported as two bugs. They were four, and each headline one had a cause that looks nothing like
  its symptom.
  - **The picker's dismiss handler was closing the popup on the popup's OWN scroll.**
    `window.addEventListener('scroll', close, true)` is capture-phase precisely so it can see
    scrolls in nested containers (scroll events don't bubble) — and `.font-picker__list` is
    `overflow-y: auto`, so wheeling through the fonts dismissed the thing being wheeled. It now
    ignores any event whose target the panel `contains`. A document-level scroll targets
    `document`, which no element contains, so the case the listener actually exists for (the
    Inspector column moving out from under a `position: fixed` panel) still fires.
  - **"Closes immediately" was the SAME listener, fired by a scroll the panel caused itself.**
    Two things scroll that list programmatically on open: `scrollIntoView` revealing the selected
    row, and the reflow as `preloadPickerFonts` finishes fetching ~20 faces. Which of the two
    symptoms you got depended only on whether the current font happened to be visible already — a
    font added from a file lands in the `Project` group, which is FIRST in `FONT_GROUP_ORDER`,
    while a fresh text clip defaults to `inter` further down. That is why one bug presented as two,
    and why it appeared to depend on how the text was created.
  - **`scrollIntoView` now runs only when the highlight moved for a reason the pointer cannot see**
    (opening, arrow keys, a new query), armed through `revealActiveRef`. Running it on every
    `activeIndex` change fought the mouse, because hovering a row sets `activeIndex` too: the
    scroll moved a different row under the cursor, which set it again, which scrolled again. Also
    `focus({ preventScroll: true })` on the search box — focusing inside a fixed panel can
    otherwise make the browser scroll an ancestor to "reveal" it, which is a real Inspector scroll
    and would legitimately dismiss — and `overscroll-behavior: contain` on the list so reaching
    either end doesn't chain the wheel out into that column.
  - **Exported text was jagged because ANTIALIASING WAS BEING FILTERED IN STRAIGHT ALPHA.**
    `renderTextNode` rasterizes at 2× and lets one bilinear tap in `TEXT_INPUT` resolve it — but a
    filtered fetch is a weighted sum of texels, and a weighted sum of RGBA is only meaningful once
    colour carries its own coverage. Uploaded straight, averaging an opaque white texel with a
    transparent one gave half-grey at half alpha instead of white at half alpha, so every edge
    pixel came out at HALF the intensity it should have. The supersample was not merely wasted —
    it was eroding the very edges it exists to smooth.
    - `TextureManager.uploadVideoFrame` gained a `premultiply` flag (default `false`, so the three
      video/camera call sites are untouched), and `TEXT_INPUT` divides the alpha back out
      (`a > 0.0001 ? rgb / a`, matching `PRESENT_FS`) — the pipeline's convention is STRAIGHT end
      to end and only the compositor accumulator is premultiplied, so the conversion belongs at
      the sample site, not in the FBO.
    - **Why it hid for so long:** `PreviewCanvas` renders at full project resolution and CSS-scales
      the canvas down into the panel, so the browser's own downscale filter smoothed over it. An
      export is the first time those pixels are ever seen 1:1. The preview flatters every
      edge-quality bug in the app and always has — worth remembering the next time something
      "only breaks on export".
  - **`IMAGE_INPUT` had the identical bug**, so it went with it: Fit / Scale / Tile all resample,
    and a straight-alpha texture meant a PNG cutout lost intensity along every soft edge and picked
    up a dark fringe. Same fix — premultiplied upload plus an `imgSample()` helper used by both the
    in-bounds and the Tile branch. Image *clips* get it for free, because both routes go through
    `renderImageNode` and `img_*` textures are only ever sampled by `imageProgram`.
    - Its `vec4(u_bg_color, 1.0)` background branch is deliberately UNTOUCHED — that is what
      `OPAQUE_BY_DESIGN` allowlists this shader for, and those Contain letterbox bars are meant to
      be opaque. Making them transparent would silently change how every existing project's
      Contain image composites over its lower tracks.
    - Opaque sources divide by 1.0 and come out bit-identical, which covers every JPEG, most PNGs
      and all opaque text — so none of this changes content without an alpha channel.
  - **The export bitrate ignored resolution and frame rate entirely.** All three sites were
    `quality * 10 Mbps`, so a 4K60 export got the same budget as 720p30 — roughly a twelfth of the
    bits per pixel, which is exactly the regime where H.264 rings around high-contrast edges. So
    text could be rendered perfectly and still arrive chewed. `targetBitrate(w, h, fps, quality)`
    now budgets bits per pixel per frame (0.04–0.15 bpp); the default lands at ~8.6 Mb/s for
    1080p30, near the old 9, so the slider feels unchanged at the common size and only the scaling
    moves. The `isConfigSupported` probe and the real `configure()` share one value — they would
    otherwise have disagreed, i.e. a bitrate the encoder approved is not the one it is asked for —
    and the modal shows the resulting Mb/s beside the percentage, since a percentage alone never
    said whether your resolution was being paid for.

- **Timeline zoom/pan pass — the wheel was doing the wrong thing in three ways (2026-08-10).**
  Reported as "zoom scales from frame 0, and the side-tilt wheel always scrolls left".
  - **The tilt wheel was ZOOMING, not panning.** A horizontal tick has `deltaY === 0`, so it fell
    through to the zoom branch where `e.deltaY > 0` is false → `delta = 1.1` → it zoomed IN 10% on
    every tick, in *both* tilt directions. Compounded with the next bug (zoom anchored at t=0, so
    the picture grows rightward) that reads exactly as "the view slides left". Two bugs presenting
    as one. `deltaX` now pans, always, before any other branch.
  - **Zoom now anchors on the cursor** (`zoomBy(factor, anchorTime)`). Changing the scale alone
    pins t=0, so everything fans out from the far left and whatever you were looking at leaves the
    screen. `zoomBy` reads the applied zoom **back out of the store** rather than re-clamping
    locally — the store owns the 0.002–50 limits, and duplicating them would make the anchor maths
    drift at the extremes. `+`/`−` anchor on the **playhead** when it's visible, else the view
    centre.
  - **Deltas are normalised by `deltaMode`.** Firefox reports LINES (~3/notch), some setups PAGES;
    unnormalised, one notch zoomed ~30× further in Chrome than in Firefox. The step is exponential
    (`1.002^-dy`, clamped 0.5–2) so a slow scroll and a fast flick feel the same per unit of travel.
  - **`viewportWidth` is measured** (ResizeObserver on the ruler) instead of the hard-coded
    **2500px** that ruler marks and beat lines both used to cull against — so on a monitor wider
    than that the right-hand end of the ruler had no marks at all, and on a narrow one it built ~2×
    the DOM it needed. The ruler and every clip lane share a left edge (160px header/spacer left of
    both), so **one** measurement and **one** content origin serve both surfaces — the wheel handler
    needs no per-surface branch.
  - **`timelineScrollLeft` has an upper bound now** (`clampScrollLeft`): you could previously pan
    into unbounded empty space, and zooming out left you parked past the end looking at nothing.
    The playhead counts as content, so a scrub past the last clip still lets the view follow. A
    re-clamp effect runs whenever zoom / panel width / project length change by any route.
  - **Ruler marks come off a 1-2-5 ladder** (`RULER_STEPS` / `pickRulerStep`) at ≥14px per tick and
    ≥72px per label. The old fixed table bottomed out at "10s apart below 20px/sec" — at minimum
    zoom (0.16 px/sec) that put marks 1.6px apart and built ~1500 DOM nodes for a solid grey bar —
    and topped out at 0.5s, so past ~300px/sec every label read the same whole second.
    - The labelled step is **rounded up to an exact multiple of the tick step**: the ladder isn't
      uniformly divisible (15 isn't a multiple of 2), and where it isn't, labels land only on the
      LCM and half of them silently vanish.
    - Ticks are indexed (`i * minor`), not accumulated (`t += minor`), which drifts on floats and
      made mark positions disagree with the beat grid over a long timeline.
    - `formatTimecode(seconds, step)` gained sub-second precision driven by the label spacing, and
      **truncates** rather than rounds — `toFixed(0)` on 59.7 gives "60", i.e. "1:60".
  - **Alt+wheel scrolls the track list.** The lanes are a native scroll container, but plain wheel
    is taken by zoom and `preventDefault`ed, so a project with more tracks than fit could only be
    scrolled by dragging the scrollbar. Plain wheel stays zoom-at-cursor — that is this app's
    convention (the node editor does the same) even though most NLEs invert it.
  - **The view follows the playhead** when it leaves the window (playback, or a jump to In/Out).
    Subscribed imperatively via `useAppStore.subscribe(selector, …)`, because `playheadTime` changes
    every frame and a hook selector would re-render the whole panel 60×/sec; it only writes when the
    view actually has to page. **Pages rather than centres** — re-centring every frame slides the
    entire timeline under the eye continuously, which is far harder to read than one jump per
    screenful. Suppressed while `body.is-scrubbing`, which owns the scroll during a drag.

- **Tracks could not be restacked, and the panel was upside-down (2026-08-10).** `reorderTracks`
  existed in `useTimelineStore` but had **no call site**, and no header was draggable.
  - **The row order was inverted and that had to be settled first.** The Renderer composites video
    tracks in **ascending zOrder** (`_renderFullPipeline`), so the last entry is the FRONT layer —
    but the panel rendered `tracks.map` in array order, putting the *back* layer in the *top* row.
    "Move up" is meaningless until that agrees with every NLE. **Fixed by reversing the VIEW**
    (`displayTracks = [...tracks].reverse()`), not the compositing: every existing project renders
    byte-identically and only the row it sits on changes. Flipping the renderer instead would have
    silently inverted the picture of every saved multi-track project.
  - **`tracks` array order IS the stacking order**, bottom (index 0, back) to top, and `zOrder`
    mirrors the index. `normalizeTrackOrder` enforces that on every mutation and returns the *same
    object* for already-correct tracks, so an unchanged list stays referentially stable for React
    and the undo snapshots.
    - This fixed a **pre-existing duplicate-zOrder bug**: `addTrack` set `zOrder = tracks.length`
      and `removeTrack` never renumbered, so add → remove → add produced two tracks with the same
      zOrder, composited in whatever order `sort` happened to be stable about.
  - **`restoreTrackOrder` (load path only) sorts by the saved zOrder, THEN normalizes.** It is
    deliberately not folded into `normalizeTrackOrder`, which runs *after* a reorder where the array
    is the new truth and re-sorting by stale zOrders would undo the move. zOrder is what the
    Renderer composited by, so it — not array position — is the authoritative record of the picture;
    `sort` is stable, so duplicates fall back to the saved array order.
  - **Reorder actions are id-based** (`moveTrackToIndex`, `moveTrackBy`). With the panel reversed,
    passing display rows around as indices is exactly how an off-by-one gets in; the single
    conversion `arrayIndex = count - 1 - row` lives in one place, in the drag handler.
  - **Drag a track header** to restack — reorders **live** rather than dropping a ghost at the end,
    so the composite updates as you drag. 4px of slop before it becomes a drag, so a plain click
    still just selects; a press on the M/S/L buttons (`e.target.closest('button')`) never arms one.
    Row height is *measured* from a real `.timeline__track` rather than hard-coded at 48px, so a CSS
    change can't desync the drop target from the picture. `body.is-reordering` carries the
    `grabbing` cursor, with an unmount cleanup.
  - **↑ / ↓ restack the selected track one place** (`moveTrackBy(id, ±1)`; up = toward the front =
    `+1` on the array index). Both arrows were unused globally. Only `preventDefault` when a track
    is actually selected, so they still scroll otherwise.
  - Inspector → Track gained a **Layer** row (▲/▼ + "2 / 3 — front-most"). The position alone
    doesn't say which end is the front, hence the words.

- **The playhead was not draggable at all (2026-08-10).** The ruler had `onClick` → jump, and
  `TimelinePlayhead` was a zero-width div with no handlers, so the red head could only be *placed*,
  never *grabbed*. Now `beginScrub` (Timeline.jsx) is one gesture with two entry points:
  - **Ruler `onMouseDown`** — jumps to the press point and keeps dragging (replaces `onClick`;
    a plain click still behaves identically).
  - **`.timeline__playhead-grab`**, a 21px full-height strip inside the marker — drags *without*
    jumping. It preserves the cursor's offset from the line (`grabOffset`), so the playhead doesn't
    teleport a few px the instant you touch it. The arrow itself is ~12×8px, which is not a
    grabbable target, hence the separate strip; the marker is `pointer-events: none` and only the
    strip is `auto`, so the arrow can't swallow ruler presses beside it.
  - **Snapping excludes the playhead** — `collectSnapPoints(excludeClipId, includePlayhead)` gained
    the second arg. It is the thing being moved, so leaving it in the target list snaps it to itself
    and pins it at its start position. Shift bypasses snapping as everywhere else.
  - **Edge auto-scroll** (rAF, ≤1200 px/s, 32px zones) — without it a drag stops dead at the panel
    border, which on a zoomed-in timeline is most of the point of dragging. Reads rect/scroll live
    each frame rather than closing over them, because the scroll moves under the drag.
  - **`body.is-scrubbing`** carries the `ew-resize` cursor + `user-select: none` for the whole
    gesture (a class on the ruler would flicker the moment the pointer left it); an unmount cleanup
    removes it so a collapse mid-drag can't leave every cursor in the app stuck.
  - **`.timeline__marker` z-index 4 → 55** (above the playhead's grab strip, below the In/Out
    handles at 60). `M` drops a marker exactly *at* the playhead, so at z 4 the new 21px strip
    covered it and it became impossible to pick back up.
  - **The line across the tracks stays non-interactive on purpose** — a grab strip there would sit
    on top of clips wherever the playhead crosses one and steal their drag/select presses. The
    ruler is the scrub surface, as in Premiere/Resolve.
  - Scrubbing **during playback** needs no special case: `Renderer._renderFrame` re-reads
    `playheadTime` from the store each frame and adds `dt`, so a scrub jumps and playback continues
    from the new position.

- **"Convert to Node Graph" changed how the two clips blended — the graph path LAYERED its
  result instead of REPLACING the accumulator (2026-08-10).** Reported as: a built-in transition
  between two images plays correctly, and the moment you convert that edge to a node graph the
  outgoing image stays on screen at full strength for the whole region, with the transition
  playing over it — "like there's a 2nd image that stays".
  - **The two paths ended a region differently, and only one of them was right.**
    `_compositeBuiltinTransition` writes its result straight into the accumulator (the region
    OWNS its window — that is what `TRANSITION_FOOTER` means). `_compositeGraphTransition` handed
    its result to `_compositeTrack` as an ordinary blend layer over `baseFBOId` — but on a head
    the accumulator **is** `u_from`, so the mix was being composited back over one of its own
    inputs. The FROM side is counted twice.
  - **Why it hid for so long:** at `blend.a == 1` source-over occludes the base completely, so on
    opaque footage the two paths are byte-identical. It only diverges where the result is not
    fully opaque — an image with an alpha channel, a `SHAPE`/`TEXT` generator, a clip that doesn't
    fill the frame. There the outgoing clip survives at weight `1 - resultAlpha` for the entire
    region and only vanishes when the region ends, which is exactly the reported symptom.
  - **Fix: `TRANSITION_RESOLVE_FS` + `Renderer._writeTransitionResult`**, the graph path's peer of
    `TRANSITION_FOOTER`. One full-screen pass into `destFBOId`: premultiply the graph's STRAIGHT
    result (the accumulator is premultiplied) and lerp toward `u_backdrop` by the clip opacity —
    the same two operations the footer does, in the same order. Both paths now write a region's
    output identically, so converting an edge to a node graph is a no-op on the picture.
    A missing/failed program degrades to the old `_compositeTrack` rather than to a hard cut.
  - **`MIX_BLEND` / `MATH_BLEND` (they are duplicate shaders) mixed RGB but took `max(a.a, b.a)`
    for alpha** — so at Operation = Mix the outgoing side's silhouette stayed fully opaque across
    the whole crossfade and an alpha logo never left. Now `mix(a.a, b.a, u_mix)` for Mix only; the
    other five operations layer two pictures rather than replace one, so the union is right for
    them. This matters because `MIX_BLEND` is what `STARTER_TRANSITION_COMPOUND` is built from,
    i.e. what "Convert to Node Graph" seeds when the edge was a plain Fade.
  - **Known, unchanged, and shared with the built-in path:** near p = 1 a head crossfade is
    `mix(backdrop, clip, ~1)`, so where the clip is transparent the backdrop is discarded rather
    than showing through. That falls out of using the accumulator as FROM (there is no separate
    backdrop layer to composite over) and is the transition model's behaviour, not this pass's.

- **The same blocky fringe from an EFFECT NODE was a different bug with the same shape
  (2026-08-10).** Reported right after the transition fix: drop an Edge Detection or Halftone into
  a clip graph and the blocks return; bypass the node and they go. Nothing to do with alpha space —
  **those shaders wrote `fragColor = vec4(…, 1.0)`, throwing the source's matte away.**
  - **Two faults conspiring, and the order matters.** The alpha discard is the *necessary*
    condition: with `a = 1` the matte is no longer a matte, so anything computed inside it becomes
    visible — with alpha intact `_compositeTrack` multiplies it by zero and it never shows (which is
    exactly why bypassing the node "fixed" it). The garbage supplies the *pattern*: straight RGB
    inside a matte is undefined, and for alpha video it is codec plane data, stepped at macroblock
    boundaries with 4:2:0 chroma smearing real colour a few pixels in. A Sobel fires hard on those
    steps; Halftone sized dots from them. Hence blocks, hugging the silhouette.
  - **Fixed to pass the source alpha through:** `EDGE_DETECTION`, `HALFTONE`, `EMBOSS`, `GLITCH`
    (its RGB-split branch), `VORONOI` (colour mode 1), `AUDIO_VISUALIZER` (now
    `max(bg.a, alpha)` — the union of what came in and what it drew, not a blanket 1.0).
  - **Taps are now alpha-weighted too**, which is the half that keeps garbage out of the *maths*
    rather than just out of the picture: `EDGE_DETECTION` (new `edTap`, still one fetch per tap),
    `EMBOSS`, `HALFTONE`'s cell-centre luma, `BLOOM`'s gather, and — properly premultiplied,
    averaged, then divided back out — `BLUR` and `DEPTH_BLUR`. A transparent tap now contributes
    nothing but its (zero) coverage instead of being weighted as heavily as an opaque one.
  - **`scripts/smoke-shaders.mjs` gained check 4 so this can't return.** `opaqueAlphaWrites` fails
    any registry shader whose fragment-output statement contains a `vec4(…, 1.0)` with a literal
    final argument. Deliberately narrow — last argument only, literal only, inside a fragColor
    assignment only — so `vec4(0.0)`, `vec4(rgb, someAlpha)` and vec4 maths elsewhere are untouched.
    `OPAQUE_BY_DESIGN` allowlists the three that are genuinely opaque: `DEPTH` and `NORMALS_3D`
    (data maps consumers sample, not pictures) and `IMAGE_INPUT` (its Background fit mode). Not run
    on transitions — those legitimately introduce opaque solids (`DIP_COLOR`, `FILM_ROLL`'s bar).
  - **Why a build failure and not a lint warning:** this class of bug is invisible on opaque
    footage, so it ships, and when it does surface it reads as a renderer fault rather than as a
    missing line of shader code. The failure message names the fix and names the allowlist.

- **The blocky fringe around transparent content during a transition was an ALPHA-SPACE bug
  (2026-08-10).** Blocks appeared right where alpha met drawn pixels, only while a transition
  region was live. Nothing was wrong with any transition shader — the compositor was feeding them
  two textures in two different conventions.
  - **The mismatch was structural and always there.** `applyBlendMode` emits PREMULTIPLIED (that is
    what the accumulator holds), while a clip's own result is STRAIGHT (the pipeline's convention
    end to end). A transition mixes those two directly: `mix(texture(u_from, uv), texture(u_to, uv), p)`.
  - **Why it reads as *blocks*, specifically.** Interpolating RGBA is only valid premultiplied. On
    straight colour a fully transparent pixel's RGB is weighted exactly as heavily as an opaque
    one's — and in a transparent region straight RGB is *undefined*: for alpha video it is whatever
    the codec left in the colour plane (macroblock-shaped garbage), which 4:2:0 chroma subsampling
    then smears a few pixels INTO the matte. So the mix drags that garbage in wherever the two
    sides' alphas disagree (i.e. along every alpha edge), and `PRESENT_FS`'s `rgb / a` **amplifies**
    it, because the alpha it divides by there is small. Hence bright blocks, hence only on edges,
    hence only during a transition — the plain path (`_compositeTrack`) multiplies the straight
    blend by its own alpha, so garbage at a = 0 is annihilated.
  - **Fix: reconcile the two sides before the pass, in `Renderer._compositeEdgeTransition`.** Which
    side is which follows from the **edge alone** (head mixes accumulator → clip, tail mixes clip →
    accumulator), so nothing new had to be plumbed down. The two consumers want *opposite* spaces,
    so each converts only the one side that is wrong for it — one full-screen pass, and only on the
    frames a region is live:
    - built-in shader → both **premultiplied** (`PREMULTIPLY_FS`). Its result is written straight
      into the accumulator so it must *be* premultiplied, and `TRANSITION_FOOTER`'s lerp toward
      `u_backdrop` then interpolates two premultiplied values, which is valid. **Provably right at
      the ends:** at p = 1 a head now produces byte-identical output to a plain `_compositeTrack`
      cut, which it did not before.
    - node graph → both **straight** (the existing `UNPREMULTIPLY_FS`). Its interior is ordinary
      effect shaders and its result is handed to `_compositeTrack` as the *blend* (straight) side.
    - `_convertAlphaSpace(program, src, dst)` is the shared one-pass helper; `TR_PREMUL_FBO` /
      `TR_STRAIGHT_FBO` are its two canvas-sized scratch targets (so `resizeAll` keeps them right).
      Only the clip side is ever converted for the built-in path, so `u_backdrop` still points at
      the real premultiplied accumulator.
  - **Two transitions constructed colour in straight space and had to move with it.** `SLIDE`'s
    seam composite was `vec4(mix(bot.rgb, top.rgb, top.a), max(bot.a, top.a))` → now premultiplied
    source-over, `top + bot * (1.0 - top.a)`. `SLICE_SHIFT`'s translucent gap was `vec4(rgb, a)` →
    `vec4(rgb * a, a)`; left alone it would have been over-bright by 1/a once the present pass
    divided the alpha back out. Everything else was already safe: `vec4(colour, 1.0)` solids agree
    in both conventions, and the emissive glow pattern (`c.rgb += glow` then `c.a = max(c.a, glow)`)
    is already premultiplied by its own coverage.
  - **`TRANSITION_HEADER` now states the contract** ("all three samplers are premultiplied") with
    the four rules for writing a new entry. Note it sits ABOVE the `float t_hash(` marker that
    `TRANSITION_HELPERS` slices on, so the `TRANSITION_FX` node path is untouched by it.
  - **Known divergence, documented at `transitionNodeHeader`:** a `TRANSITION_FX` *node* gets
    ordinary graph FBOs, i.e. straight alpha, so the shared bodies now run in two spaces. Identical
    on opaque content (which is what a node mid-graph realistically sees); a transparent
    `TRANSITION_FX` will still show the old fringe. Premultiplying at sample time can't be done
    from the prelude — the bodies call `texture()` directly and GLSL ES forbids overloading it — so
    a real fix means a conversion pass in the DAG executor. Deferred.

- **Clip graphs can preview in the full pipeline ("In Context"), like transition graphs always have.**
  `useAppStore.previewThroughMaster` (boolean) became **`clipPreviewMode`** — `'isolated'` |
  `'master'` | `'context'` — driving a 3-segment control in the Node Editor header
  (Clip / + Master / In Context). View state, not serialized.
  - **There was never a structural blocker; the gate was one clause.** `_renderFrame` read
    `if (graphLevel === 'clip' && graphClipId && !editingTransition)` → isolated. Everything the
    composited path needs already existed: `_runClipGraph` honours `tapPointNodeId` exactly like
    the isolated path, and keyframes, `_setClipTimeContext`, `hasSource` and `_applyClipTransform`
    are applied identically in both. The condition just gained `&& !inContext`.
  - **The edited clip's track is exempt from mute and solo** (`focusClipId` → `focusTrackId` in
    `_renderFullPipeline`). A mode whose whole purpose is "show me this clip in its surroundings"
    is useless if a muted track or another track's solo hides it. `audioVisTracks` is now built
    from `tracks` rather than reusing `audioTracks`, so the exemption reaches the **picture**
    without also un-muting the **sound**. Gated on `previewTapEnabled` — the renderer's standing
    "this frame is for the eye, not for output" flag — so an export can't bake it in.
  - **Switching INTO context parks the playhead** inside the clip if it's outside it. In isolation
    the clip renders wherever the playhead is, so you never notice having drifted off it; the full
    pipeline only shows *active* clips, so the same drift reads as "I turned the mode on and the
    picture vanished". Only on the transition into the mode — scrubbing away afterwards to see a
    neighbouring clip is legitimate. Inspector's "Open Effect Graph" now parks too (the timeline's
    two entry points always did).
  - **A tap means something different per mode, and that's why isolation stays the default.**
    Isolated shows the tapped node's raw output full-screen; in context it's substituted as the
    clip's output and then blended, faded, transitioned and pushed through master. Good for
    judging a look, misleading for debugging a node. Context also runs every active clip graph
    plus master every frame, where isolated renders one clip and pauses every other media element.
  - Playback still loops within the edited clip in every mode (that clamp is keyed on graph
    context, not on the render branch, so it was already mode-agnostic).

- **Params inside a transition graph (or any compound) were frozen at compile time — fixed
  (2026-08-08).** Moving any slider on a node inside a transition graph did nothing at all.
  - `executeGraphDAG` resolved a node's params as `liveNodes[id] ?? node.params`, skipping the
    `nodeLookup` map in between. `node.params` is the snapshot **baked into the compiled chain**,
    and a param edit deliberately does NOT bump `topologyVersion` — that is what keeps a slider drag
    cheap — so the chain is never rebuilt and the baked value is used forever.
  - The top level looked fine only by accident: the renderer passes a full node map there as
    `liveNodes`. Every graph evaluated *without* one — a transition graph, a compound's interior —
    read compile-time values. `_compositeGraphTransition`'s own comment claimed the executor "reads
    current values off the graph regardless"; it did not, and that claim is what made the bug easy
    to look past.
  - Now `liveNodes[id] ?? nodeLookup[id] ?? node.params` at all four sites (the effect loop and the
    image / text / shape pre-passes). `nodeLookup` is `buildNodeMap(subGraph)`, rebuilt from the
    store every frame, so it is always current. The float-source path already resolved all three
    this way — the two had simply disagreed.

- **`TRANSITION_FX` — every built-in transition is now a chainable NODE (2026-08-08).** Two
  complaints, one mechanism: "Convert to Node Graph doesn't keep my effect" and "I want to stack
  transitions the way Resolve does".
  - **The node.** Two texture inputs (`input` = From, `input_b` = To), a `Progress` param socket,
    and an **Effect** select over all 35 built-ins. Its GLSL is assembled per node by
    `buildTransitionNodeShader` — the SAME `vec4 transition(vec2 uv)` body, with a different
    prelude — so there is one copy of each effect, not one for transitions and one for nodes.
    - Aliasing is `#define u_from u_texture` etc., **not** a textual rewrite: a substitution would
      also hit `u_from` inside comments and any identifier that merely starts with it, and a
      `#define` keeps compile-error line numbers pointing at the line you wrote. The smoke test's
      `declaredNames` already understands `#define`, so this validates cleanly.
    - Sockets reuse `input`/`input_b` because `TEXTURE_INPUT_SOCKETS` already maps those to
      `u_texture`/`u_texture_b` — the DAG executor routes both images with no new branch.
    - `u_backdrop` / `u_opacity` are deliberately absent. They belong to `TRANSITION_FOOTER` (the
      compositor's opacity fallback); a node sits mid-graph where there is no backdrop to fall back
      to, and its output is composited by whatever consumes it.
  - **Convert to Node Graph now preserves the effect.** `seedGraphFor` (transitionActions) builds
    the seed from what the edge is *currently* carrying: a library compound forks a copy, a built-in
    becomes a `TRANSITION_FX` node **with its current param values**, and plain Fade becomes the
    MIX_BLEND crossfade. Previously it always seeded the starter crossfade, so converting a Film
    Burn silently discarded it — indistinguishable from the outside from the graph being broken.
  - **Stacking is just wiring.** Chain one node's output into the next one's `From` and give each
    its own remap of Progress. Worth knowing when wiring by hand: an unwired `input_b` falls back to
    the PRIMARY input (`executeGraphDAG`'s rule for a secondary texture socket), so a Transition FX
    with only `From` connected mixes a picture with itself and does nothing visible — it reads as
    broken when it is merely unwired. Connect `To` as well.
  - **`SOURCE_PARAMS` (useGraphStore) is new and load-bearing.** A param edit deliberately does NOT
    bump `topologyVersion` — that is what keeps a slider drag cheap — but `u_tfx_type` *changes the
    shader source*, so it must recompile or the node keeps running the previous effect. The same
    branch also merges the new effect's **defaults** underneath the existing params: without it,
    switching Crossfade → Film Burn leaves every Film Burn uniform absent, `uploadUniforms` skips
    them, and the shader runs on GLSL's implicit zeros (no edge, no glow) — the worst possible first
    impression of a new effect.
  - **Two places were re-implementing `getNodeSource` inline** (`NodeCanvas.nodeParamConfigs` and
    `autoWireTransitionNode`) with the old custom → shaderCode → registry chain. Both now call it.
    That resolver is documented as the single source of truth precisely so a node-dependent source
    like this one works everywhere; the inline copies would have shown the DEFAULT transition's
    params no matter which effect was selected.
  - The default (`CROSSFADE`) wrapper is `registerShader`ed, so a bare `getShaderSource` — what the
    add-node paths use to compute a new node's default params — returns something sensible, and the
    wrapper gets smoke-test coverage like every other shader.

- **The transition library went from 10 to 35 (2026-08-08).** Five new families, all built on the
  existing `TRANSITION_HEADER` / `vec4 transition(vec2 uv)` / `TRANSITION_FOOTER` contract, so
  nothing in the renderer or the edge model changed.
  - **Film** — `FILM_BURN` (3 styles: emulsion char, paper, chemical bleach), `FILM_ROLL` (projector
    loses sync: frames roll past the gate with the frame bar sweeping through), `LIGHT_LEAK`,
    `PROJECTOR_REEL` (cue mark, flicker, gate weave, dust, scratches), `VHS_TRACKING`.
  - **Motion** — `WHIP_PAN`, `SLIDE` (Cover / Reveal / Push × 8 directions, with a seam shadow),
    `SPIN`, `SWIRL`.
  - **Geometric** — `CLOCK_WIPE`, `BARN_DOORS`, `BLINDS`, `CHECKERBOARD`, `SHAPE_IRIS` (8 shapes).
  - **Digital** — `SCANLINE_COLLAPSE` (CRT squash to a line), `PIXEL_SORT`, `STATIC_NOISE`,
    `SLICE_SHIFT`.
  - **Organic / Light** — `INK_BLEED`, `LIQUID_MORPH`, `RIPPLE`, `SMOKE`, `FLASH`,
    `BLOOM_DISSOLVE`, `DEFOCUS`.
  - **Six shared helpers moved into `TRANSITION_HEADER`** (`t_aspect`, `t_rot`, `t_noise`, `t_fbm`,
    `t_front`, `t_dir8`, `t_clip`, `t_disc`, `t_streak`). A dozen of these transitions want the same
    value noise; a per-entry copy is duplication AND a guarantee that two "identical" effects drift.
    Unused helpers are dead code the compiler drops, so an entry that needs none pays nothing.
    - **`t_front` is the load-bearing one.** It sweeps a threshold across a 0..1 map over
      `(1 + 2*soft)` rather than over `1`, which is what guarantees a FULL hand-off — without the
      widened span the softest pixels never finish and a dissolve that ends at ~97% reads as a
      broken cut rather than a slow one. Every noise/shape-driven entry uses it.
    - `t_disc` / `t_streak` are constant-tap (13 and 9), per the house rule: no radius-dependent
      loops, because that is O(r²) and was a real perf bug in `DEPTH_BLUR`.
  - **Every entry now carries a `category`** (`TRANSITION_CATEGORIES`), which is the only thing
    keeping a library this size browsable. `groupedTransitionCatalog()` (transitionActions) is the
    one grouping, read by the Media Pool browser, the Inspector dropdown (`optgroup`s) and the
    Timeline's edge menu — which became a two-level menu (categories, then entries) because a flat
    list was fine at nine and is unusable at thirty-five. The Transitions tab also gained a search
    box for the same reason.
  - **Two bugs worth remembering, both caught by hand because the sandbox was down:**
    - A GLSL comment contained **backticks** (``frames``, ``travel``, ``dir``). That closes the JS
      template literal and the rest of the shader parses as JavaScript — the exact failure the Code
      Style section warns about, and it reports as a bare `Parsing error` hundreds of lines away.
    - `FILM_BURN` used **`char`** as a local variable. It is a RESERVED word in GLSL ES and the
      shader will not compile with it, no matter what surrounds it. Renamed `charAmt`.
  - **`FILM_ROLL`'s direction is done by mirroring y, not by negating travel.** A negative travel
    pushes the strip's `cell` index below zero, where the FROM branch is taken forever — so rolling
    "Down" would have looked fine and simply never arrived at the incoming clip.

- **Transitions became discoverable (2026-08-08).** The previous pass made transitions *work*; this
  one makes them findable. The old entry points were a dropdown buried in the clip Inspector and a
  right-click on a fade wedge — and **the wedge has zero width until a fade exists**, so on a fresh
  cut there was physically nothing to click. Four routes now, matching the muscle memory people
  arrive with:
  - **⇄ hotspots on each end of a clip** (hover to reveal) apply the default transition in one
    click. They sit exactly on top of the invisible right-click edge zone, so finding one teaches
    the other. Below the trim (z 5) and fade (z 6) handles by design — those are precision drags on
    a 5–9px target and a fat click zone would swallow their edges.
  - **Right-click near a clip end** now opens that edge's menu even with no wedge there
    (`EDGE_HIT_PX`, capped at a third of the clip so a short clip keeps a middle). Previously the
    edge menus were reachable only through a submenu of the clip menu.
  - **A Transitions tab in the Media Pool.** Drag a card onto a clip — front half = In, back half =
    Out — or click to apply to the selected clip, or right-click to set the default.
  - **`T`** applies the default to the selected clip's nearer edge. Premiere's Ctrl+D was taken by
    Duplicate Node, and a bare `T` was free.
  - **`useAppStore.defaultTransition`** (serialized under `project`) is what all of those apply; it
    is also a dropdown in Inspector → Project. `''` is a real value — the plain opacity ramp — which
    is why the load path uses `??` and not `||`.
  - **`transitionCatalog()`** (transitionActions) is the single list of choosable transitions —
    built-in shaders, `compound:<libId>` library entries and `'graph'` as one uniform set whose
    `type` is directly consumable by `applyEdgeType`. The Inspector dropdown and the Media Pool
    browser read it; the Timeline's effect menu is the last hold-out.
  - **Which edge a gesture means** is always `nearestEdge(clip, t)` — the half of the clip the
    pointer/playhead is in. Splitting at the midpoint rather than "within N seconds of an end" means
    the answer is defined however short the clip and however far from an end you land.
  - **Drag detection needed a marker MIME type** (`TRANSITION_DRAG_TYPE`). `dataTransfer.getData` is
    blocked outside the `drop` event, so a `dragover` handler can only read `types` — without a
    second, empty type set alongside the payload there is no way to tell a transition drag from a
    generator-clip drag, and the edge highlight would flash on both. Also: `dragleave` bubbles from
    every clip inside the lane, so it clears the highlight only when `relatedTarget` is outside.
  - **FROM/TO now bind by `terminalRole`, not array position.** `subGraph.nodes` is append-ordered,
    so deleting a terminal and adding one back — or a graph rebuilt from a promoted library copy —
    silently swapped the two sides, and a reversed transition reads as a broken shader rather than a
    rewiring. Index order remains the fallback, so pre-existing graphs are unaffected.
  - **Two node fields were being dropped by the serializer**: `terminalRole` (new) and **`audioBand`
    (pre-existing bug)** — neither was in either node map, so a compound's audio-band terminal lost
    its tag on every save/load and stopped routing its splitter band.

- **Transition authoring made survivable (2026-08-08).** The edge-transition *model* was sound;
  every fault was at its edges. Five fixes, in the order they bite a user:
  - **Assigning an effect now always creates a window to play it in.** `Timeline.setEdgeType` gave a
    zero-length edge a 1s default; `Inspector.EdgeTransitionSection.onPickType` did not. So picking a
    transition from the Inspector on a clip whose fade handle sat at 0 stored the type, created the
    node graph, opened the editor — and rendered *nothing, ever*, with only a passive note that a
    length was missing. That is the whole of "the node graph doesn't seem to work". Both routes now
    go through **`utils/transitionActions.js`** (`applyEdgeType` / `openEdgeGraphAction`), the write
    peer to the pure `clipTransitions.js`; `ensureEdgeRegionPatch` + `DEFAULT_EDGE_SECONDS` live
    with the rest of the model. Re-opening an existing graph transition ensures a window too — the
    handle can have been dragged back to zero since.
  - **A transition graph is previewable at all now.** It only composites while the playhead is
    inside its region — a sub-second window, a few pixels of timeline. The header said "Scrub the
    transition region to preview", which was true and unactionable. **`TransitionGraphBar`** (a
    strip under the Node Editor header) gives it a 0→1 progress scrubber. It drives the
    **playhead**, deliberately, rather than introducing a second notion of progress: what you scrub
    is exactly what renders and exports.
    - Worth knowing: **`TRANSITION_PROGRESS`'s Preview / auto-preview params are unreachable inside
      a real clip transition** and always were. `resolveTransitionProgress` prefers
      `standardState.transitionProgress`, and the renderer only runs the graph when it is supplying
      one. Those params only ever apply when the compound is placed as a node in an ordinary graph.
      Hence a playhead scrubber rather than "just use the preview slider".
    - The strip also names what **FROM** and **TO** are bound to *on this edge* — they swap between
      head and tail, which the node names can't convey and which is the single most confusing thing
      about authoring a transition out to nothing.
  - **Nodes added in a transition graph are added unconnected, like anywhere else.** There was
    briefly an auto-splice (into the chain before `EFFECT_OUTPUT`, plus `TRANSITION_PROGRESS`
    guessed onto an "amount" param); it was **removed on request (2026-08-08)**. Guessing at wiring
    is worse than no wiring: you cannot tell what it decided without reading the noodles, and
    undoing its guess costs more than making the two connections yourself. Ctrl+drag-a-node-over-a-
    wire remains as the deliberate insert gesture. Do not reintroduce it without asking.
    - The thing it was papering over is still true and worth stating in the UI instead: an unwired
      node is pruned by `getExecutionOrder` (no effect, no error), and a node wired without
      `TRANSITION_PROGRESS` runs at a **constant** value for the whole region. The header strip says
      both.
  - **Failures are visible.** Every `return false` in the transition path was a `console.warn` plus
    a silent fall back to a hard cut, so "broken" and "working but subtle" looked identical.
    **`gl/transitionStatus.js`** is a tiny subscribable registry (peer of `alphaRegistry`) keyed by
    clip edge; `TransitionStatusNote` renders it in the Inspector section and the Node Editor strip.
    A registry rather than Zustand for the usual reason — the answer is only knowable inside the
    render loop, and a per-frame store write would re-render the app. `null` means "never
    evaluated", which is deliberately **not** a failure.
  - **The preview tap (👁) works inside a transition graph.** `executeTransitionCompound` now takes
    a `tapPointNodeId` and `executeGraphDAG`'s `outputResolved` branch substitutes the tapped node's
    FBO for every `EFFECT_OUTPUT`. Substitution, not a draw-to-screen: this sub-graph is one layer
    of a frame, so blitting from in here would fight the compositor — and seeing the tapped node
    composited in place is the only way to judge a transition anyway.
  - **Duration moved next to the effect it governs.** The In/Out Length sliders were in the Fades
    section, ~200px above the Transition In/Out sections, which is most of why the region model read
    as arbitrary. Each edge section now owns its own Duration (still `clip.fadeIn`/`fadeOut` — one
    number, one wedge, one handle) plus a **Go to Transition** button. Audio clips have no
    transition sections, so they keep a plain Fade In / Fade Out pair.

- **Dependency bumps + the first green `lint`/`build` in a while (2026-08-07).** Took Dependabot
  #17 (`react-dom` 18.3.1 → 19.2.8, `@types/react-dom` → 19.2.4) and #20 (`@vitejs/plugin-react`
  4.7.0 → 6.0.5). #18/#19 (ESLint 10) are blocked upstream — see the backlog.
  - **#17 was a repair, not an upgrade.** `package.json` already had `react@^19.2.8` next to
    `react-dom@^18.3.1`, so the installed tree carried an unsatisfied peer (`react-dom` 18 wants
    `react: ^18.3.1`). Source needed no changes — `createRoot` + `createPortal` only, no
    `findDOMNode` / `defaultProps` / string refs. `eslint.config.js`'s `settings.react.version`
    went 18.3 → 19.0 to match, since eslint-plugin-react gates rules on it.
  - **#20 was clean because we're already on Vite 8.** plugin-react 6 only drops Babel (Vite 8
    does React Refresh via Oxc), and `vite.config.js` calls bare `react()` with no `babel` option.
    Its two new peers are optional.
  - **Five artifacts of the unfinished edge-transitions rework were fixed to get there.** Two
    files did not parse, so `npm run build` could not have succeeded on this tree beforehand, and
    a parse error masks every other diagnostic in its file — each fix revealed the next.
    `Inspector.jsx` had a duplicated import block, a duplicated `nextOverlap` (the second copy
    filtered on the **legacy** `clip.transition` field and required the incoming clip to *have* a
    transition before suppressing this clip's tail — the renderer suppresses on overlap alone, so
    the panel would have contradicted the picture), an orphan `)}`, a duplicated function tail,
    and `{isVideoClip && …}` where `isVideoClip` was **declared nowhere** — a `ReferenceError` that
    killed the whole Clip Inspector. That last one is now `supportsTransition`
    (`clipSupportsTransform`, i.e. not audio), which is what the adjacent comment always said and
    restores edge-transition UI on text/image/shape generator clips. Also `Renderer.js` called
    `_compositeTrack(backdropFBOId, …)` — no such identifier; the parameter is `baseFBOId`, so
    **every node-graph transition threw at composite time**. Plus dead `scratchId` (Renderer) and
    `transitionBadgeLabel` (Timeline, superseded by `edgeEffectLabel`).
  - **Lesson worth keeping:** all of this sat undetected because lint had not run for several
    sessions while the sandbox was down. The cheap sweep for this artifact class is indented
    content sitting after a **top-level `}`** — valid module scope only ever has a blank line,
    another declaration, or EOF there.

- **3D / Depth node family (phases 1–4) — `3D_DEPTH_EFFECTS_PLAN.md` is the design doc.**
  12 nodes, 63 primary modes, 152 params, one shared GLSL header. The architecture is the point:
  one estimator, many consumers, wired over a `depth_map` socket (see Key conventions above).
  - **Phase 4 — geometry and time:**
    - **`DEPTH_DISPLACE`** — displacement along the surface NORMAL rather than in the plane, so
      things inflate, melt, shatter and ripple *volumetrically*. 6 modes. `Depth Glitch` quantises
      depth into slabs and tears each on its own hashed schedule — far more interesting than a flat
      glitch because foreground and background break apart separately. `Ripple by Depth` sends the
      wave through DEPTH, so it reads as a shockwave travelling toward camera.
    - **`VOXEL_3D`** — the frame rebuilt as extruded blocks. Depth is quantised in **both** axes
      (grid cells laterally, discrete levels vertically) and then marched. Quantising is what makes
      it cheap AND is the entire look. **Face shading is free:** a march step that lands on a
      *taller* cell means the ray is grazing that block's side rather than its top, so the two
      facts the march already knows are enough to shade faces — no normals, no lights, no geometry.
      Cells are square in **pixels**, not UV. Heaviest node in the family (one depth fetch per
      step, capped at 24).
    - **`TIME_SLICE_3D`** — z is **age**, not distance. The design doc wanted a 4×4 atlas of past
      frames; it isn't needed. Declaring `u_prev_frame` makes the executor hand the node its own
      ping-pong pair (the `isFeedback` branch in `executeGraphDAG`), and every mode is expressible
      as `f(live frame, my own last output, depth)` — **the output IS the accumulator**, so history
      costs one FBO the renderer already manages. `Depth Freeze` is the mode that matters: a
      per-pixel hash makes each pixel's refresh *discrete* with probability falling off by depth, so
      the far field literally lags in time behind the near field. Discrete is the point — a smooth
      blend (`Time Smear`) just looks like motion blur.
    - Presets: **Bass Voxels**, **Time Corridor**, **Liquid Depth**.
    - `HEIGHTFIELD_3D` (video as raymarched terrain) was **dropped, not deferred**: it overlaps
      `VOXEL_3D` visually for strictly more cost, and `VOXEL_3D`'s quantisation is what buys the
      cheap analytic face shading a smooth heightfield can't have.
  - **Phase 3 — parallax / true 2.5D:**
    - **`CAMERA_3D`** — a virtual camera over the depth field. `d3_camVector` handles pan, dolly
      and orbit with **one** formula (a Z translation produces parallax proportional to distance
      from the principal point — that *is* a dolly), and `d3_pom` marches the view ray through the
      depth field so near objects genuinely **occlude** far ones. 8 built-in motions
      (Sway/Dolly/Orbit/Handheld/Crane/Figure-8/Manual) so it moves with nothing wired; Manual is
      last precisely so the default index 0 is alive on drop.
      - **Cost is adaptive off one number.** `travelPx = length(P * u_resolution)` — how far the
        parallax actually travels in pixels — drives both the early-out (`< 1px` → one fetch,
        return) and the step count (`clamp(travelPx / 3, 4, 12|24)`). A subtle drift costs 4 taps.
      - **Disocclusion detection is free.** `d3_pom` returns the largest height discontinuity the
        ray crossed as an out-param; the samples were taken anyway. That single number *is*
        "did this pixel come from across a silhouette", and it drives the three Reveal Fill modes
        (Stretch / Smear / Void). Void only touches **alpha** — the pipeline is straight alpha, so
        scaling rgb there would double-darken at the present pass.
    - **`STEREO_3D`** — Anaglyph (naive + **Dubois** least-squares matrices), Side-by-Side,
      Over-Under, Interlaced, and **Wiggle** (flip eyes ~5×/s; the brain reads depth with no
      glasses, and only ONE eye is sampled per frame). Deliberately **single-tap, not POM**:
      stereo parallax is *signed* around a convergence plane, which is a different problem from
      marching down into a heightfield, and per-eye occlusion error is sub-pixel. SBS/OU pass a
      corrected `aspect` (×2 / ×0.5) so one Interaxial value means the same thing in every mode.
    - **`MULTIPLANE`** — depth quantised into ≤ 8 bands, each with its own parallax, composited
      far→near. 2 fetches per slice, no marching, and the hard band edges are the *point*
      (paper diorama / anime background). `acc` leaves the slice loop **premultiplied**, so the
      backdrop goes in as `acc.rgb + gap * (1 - acc.a)` — a second `mix()` by `acc.a` would
      multiply coverage in twice and darken every soft plane edge.
    - Presets: **3D Photo (Parallax)**, **Paper Diorama**, **Anaglyph Retro**, **Wiggle 3D**.
      All four smooth depth harder than the phase-2 rigs (`u_dp_smooth` 9–12): parallax is where a
      noisy depth estimate shows up worst, because the eye reads boiling geometry as broken in a
      way it never does in fog or lighting.
  - **`DEPTH`** — monocular estimator. Not ML: a weighted stack of classical cues (luma, local
    contrast/focus, aerial desaturation + blue shift, horizon, radial), each a slider so it's
    tunable per shot. 7 modes incl. `External Map` for a real depth video. Its `d3_ringProbe`
    takes **one 8-tap ring and returns two results** — an edge-preserving (joint bilateral)
    smoothed colour AND the local luma contrast. Sharing the ring is the trick: both are questions
    about the same neighbourhood, so asking separately would cost 16 taps for the same
    information. It smooths the colour the cues are computed FROM, because bilaterally filtering
    finished depth would mean re-running the cue stack at every tap.
  - **`NORMALS_3D`** — normal map / curvature / slope. Standalone because a normal map is useful
    outside the family (wire it into `DISPLACEMENT` to bump-map footage).
  - **`RELIGHT_3D`** — deferred lighting on flat footage. 6 modes (Studio 3-point, Single Key,
    Rim Only, Toon/Cel, Metal, Wet/Subsurface). ~10 flops per light and **zero extra texture
    fetches** beyond the 4 the normal costs — the best value-per-flop in the family.
  - **`AO_3D`** — SSAO / Curvature / Cavity / Contact Shadow. The SSAO spiral is range-checked
    (`smoothstep(range, range*2.5, diff)`): without it a much-nearer neighbour is a different
    object, not a crease, and you get dark halos instead of occlusion. Curvature/Cavity use a
    4-tap Laplacian rather than a spiral — concavity is a second derivative, so the immediate
    neighbourhood is all there is to ask.
  - **`BOKEH_3D`** — real DOF. 3 focus fields (Depth Map / Tilt-Shift / Radial — the latter two
    synthesise their focus field from screen position, so DOF works with no depth at all), plus
    aperture blades, anamorphic squeeze, Petzval swirl and highlight bokeh. Each tap's weight is
    `clamp((tapCoC - dist) * 0.5 + 1, 0, 1)`: a tap contributes only if **its own** circle of
    confusion reaches this pixel, which is what stops a sharp foreground smearing outward over a
    blurred background. 2 fetches per sample (colour + that tap's depth) — unavoidable in a
    gather DOF.
  - **`FOG_3D`** — Linear / Exponential / Exponential² / Height Fog / Aerial Perspective / Depth
    Tint. Aerial Perspective desaturates and blue-shifts *before* adding fog colour, so haze reads
    as atmosphere instead of a grey scrim.
  - **`DEPTH_BLUR` was a real perf bug and is fixed in place.** Its nested `x`/`y` loop reached a
    37×37 kernel — ~1369 texture fetches per pixel at radius 18. Now a 24-tap Vogel spiral with a
    Gaussian disc falloff: constant cost at any radius. **Params are byte-identical** so saved
    projects keep their values and just get faster, and Rec.601 luma is kept (not `lib3d`'s
    Rec.709) so the depth estimate — and the look — doesn't shift.
  - Presets: **Cinematic Depth** (one depth → fog + DOF + key light, demonstrating the fan-out),
    **Sculpted Light**, **Miniature (Tilt-Shift)** (no depth node at all — a miniature is faked by
    *ignoring* real depth), **Depth Reactor** (bass → fog + aperture). Presets deliberately leave
    each node's primary `input` unwired: `executeGraphDAG` resolves an unwired texture input to the
    chain input, so `DEPTH` and the head of the image chain both pick up the incoming video with
    no edge.
  - **Scaled (half / quarter-res) render targets** — `FBOManager.create` takes a `scale` option
    (sibling of `fixedSize`), `resize` re-applies `entry.scale` so a 0.5× target stays 0.5× across
    a canvas resize, and `getScale` lets the executor notice a changed Resolution param and
    rebuild (resize deliberately *cannot* change an existing FBO's ratio).
    - **The blocker was one line.** `Renderer.executePass` did
      `this.fbos.bind(id); gl.viewport(0, 0, this.width, this.height)` — and `FBOManager.bind`
      had *already* set the viewport from the target's own dimensions, so the second line silently
      overrode it and any scaled pass would have written a corner of its buffer. It is now
      `if (!outputFBOId) gl.viewport(...)`, which only covers drawing straight to the screen.
      Provably identical for every existing FBO (they are all canvas-sized) — and that one line is
      also the rollback if anything looks wrong.
    - **Opt-in per node type via a real UI param, not a hidden constant** (`nodeFBOScale`).
      Only `DEPTH` uses it (Resolution: Full/Half/**Half by default**/Quarter): its output is a
      low-frequency data map, every consumer samples it with normalized UVs and gets a bilinear
      upsample free, and downsampling actively *helps* because the resample is a denoiser and
      noisy depth is what makes parallax boil. An image-chain node at half res would just look soft.
    - **Feedback nodes are excluded on purpose** — their output IS their history, so a scaled
      target would compound resampling every frame into mush.

- **Transitions + blending pass: edge transitions, out-to-nothing, editable transition graphs.**
  New `src/utils/clipTransitions.js` is the shared model (see the section above); `clip.transition`
  became `clip.transitionIn` and gained a `clip.transitionOut` peer.
  - **The fade-out bug was an alpha bug, not a fade bug.** Premultiplied compositor output was being
    written to a `premultipliedAlpha: false` canvas, so every fade was applied twice (quadratic).
    Fade-in read as an intentional ease; fade-out read as the picture dropping out early and never
    landing on black. Fixed in `_presentToScreen` with an opaque-black clear + alpha colour mask.
  - **Transitions can now run at both ends and against nothing** — the old model only ever
    transitioned INTO a clip from an overlapping predecessor. `_compositeEdgeTransition` runs head
    and tail through one pass with the sides swapped; `TRANSITION_FOOTER` mixes toward a separate
    `u_backdrop` so a tail's opacity fallback is what's behind the clip, not the clip itself.
  - **Per-clip transition node graphs** (`type: 'graph'`) stored under synthetic `clipGraphs` keys,
    editable in the Node Editor with the full pipeline previewing live, promotable to the library.
  - **New `DIP_COLOR` built-in** ("Dip to Color") — the classic dip-to-black, and a true fade-out
    when used on a tail.
  - UI: wedges are the transition (tinted + named when one is assigned), right-clicking a wedge
    opens that edge's menu, the Inspector shows both edges and states in words what each mixes
    against, and the fade sliders are relabelled In/Out Length.
  - Export audio parity: `ExportModal` now samples the same `clipEnvelopeGain` the renderer uses.

- **Media Pool right-click menu (delete / add to timeline / add to master graph)** — new shared
  `src/components/common/ContextMenu.jsx` (+ `.css`): portal-rendered so a scrolling panel can't
  clip it, position clamped from the measured rect, closes on outside mousedown / Escape / wheel /
  blur / resize. `MediaPool` opens it from Videos, Images, Audio and Screen cards with per-kind
  items — **Add to Timeline** (clip at the playhead on an auto-created track, with `initClipGraph`;
  images become generator clips via `makeImageClipParams`), **Add to Master Graph** (adds
  `VIDEO_INPUT` / `AUDIO_INPUT` (with `audioSource` = the stem filename) / `IMAGE_INPUT` (imageSrc
  preloaded) / `SCREEN_INPUT` below the existing nodes, then `exitClipGraph()` + `selectNode` so the
  user actually sees it), and **Delete**.
  - Delete has to remove every *source* of a card, because the tabs are **derived**: videos/audio
    by filename, images keyed by data URL scanned out of clips + every graph. So it removes the
    matching clips (and their graphs, via the new `useGraphStore.removeClipGraph`) and, for images,
    top-level `IMAGE_INPUT` nodes. Compound interiors aren't addressable by `removeNode`, so nested
    uses are counted and reported in a toast — the card legitimately survives.
  - When anything is in use, the menu **replaces itself with a confirm step** (no modal, no native
    `confirm()`) naming the exact clip/node counts. Blob URLs are deliberately **not** revoked:
    the delete is undoable via the history snapshot and a revoked URL would restore as dead media.

Image-import downscaling + the GPU max-texture clamp (`src/utils/imageProcessing.js`,
`Renderer.renderImageNode`), plus the four original backlog items:

- **Shader smoke test** — `scripts/smoke-shaders.mjs`, wired into `npm run lint` + `npm run smoke:shaders`.
- **Free GPU resources for deleted nodes** — `nodeLifecycle` removal hook; the Renderer's
  `releaseNodeResources` frees any removed node's FBOs/textures, recursing compounds (covers
  master-graph deletes, which don't pass through `releaseClipResources`). Started as an
  image-only hook, now general.
- **Real multi-track compositing** — bottom-to-top accumulation with per-clip/track blend + opacity
  (see Key conventions).
- **Unify the compound executor** — `executeGraphDAG` evaluates compounds (image-in-compound +
  multi-input-in-compound work); `executeSubChain` deleted; `IMAGE_INPUT` no longer excluded.
- **Compound input routing** — COMPOUND nodes now get dynamic `input_<i>`/`output_<i>` sockets from
  their sub-graph terminals (`getNodeSockets`), and `executeGraphDAG` maps each outer input to its
  inner `EFFECT_INPUT` terminal (`terminalInputs`). Fixes mid-chain compounds reading the wrong
  input and routes true multi-input compounds.
- **Overlapping-clip cross-blend** — `getActiveClips` yields all clips active on a track (earliest
  first); `_renderFullPipeline` renders each via `_renderClipToFBO` and composites it over the
  previous, so a later-starting clip blends over an earlier overlapping one (spec §C).
- **Free relocated-node FBOs on compound create/expand** — `createCompoundFromSelection` and
  `expandCompoundNode` now `emitNodeRemoved` for the nodes they relocate.
- **`Dissolve` blend mode** — the compositor (`COMPOSITE_FS`) applies a per-pixel noise threshold
  (mode 1) instead of returning the blend color unchanged.
- **Multi-output compounds** — `executeGraphDAG` records the FBO feeding each `EFFECT_OUTPUT`
  terminal (via an `outputResolved` out-param, by reference — no blit) and routes each `output_<i>`
  socket by the consuming edge's `fromSocket` (`nodeOutputBySocket`), so downstream consumers of a
  compound each read the correct output.
- **Audio-reactive export** — export renders with playback paused, so the live `AnalyserNode` can't
  drive the audio uniforms and reactive visuals froze. `ExportModal.analyzeTimelineAudio`
  pre-computes per-frame bands/beat from the mixed audio (`OfflineAudioContext.suspend` +
  `AnalyserNode`, matching `AudioEngine`) and writes them to `useAudioStore` each frame;
  `Renderer._timeOverride`/`_frameOverride` frame-lock `u_time`/`u_frame`. MP4 path only (the WebM
  MediaRecorder path records in real time).
- **Full blend-mode UI + explicit Inherit** — the Inspector's clip/track dropdowns expose all 30
  `BLEND_MODE_NAMES` (grouped Photoshop-style). Clip default is now `'Inherit'` (use the track's
  mode); an explicit clip `'Normal'` is a real override. Legacy clip `'Normal'` migrates to
  `'Inherit'` on project load (`deserializeProject`).
- **Clip fade-in/out** — `clip.fadeIn`/`fadeOut` (seconds); draggable corner handles + wedge
  overlays on timeline clips, sliders in the Inspector. `_renderFullPipeline` multiplies a linear
  ramp into the composite opacity. Splitting keeps fade-in left / fade-out right.
- **Clip transitions (built-in)** — `clip.transition = { type, params }` on the incoming clip plays
  over its overlap with the previous same-track clip. `src/shaders/transitionRegistry.js` holds 9
  `u_from`/`u_to`/`u_progress` shaders with `@param` sliders; the compositor swaps the blend pass
  for the transition pass (`_compositeTransition`); u_beat/u_time are live inside. Unknown type /
  failed compile falls back to the blend composite. The smoke test validates transitions too.
- **Node-graph transitions (custom)** — `clip.transition.type = "compound:<libId>"` runs a compound
  library entry as the transition: its first two image `EFFECT_INPUT` terminals are bound FROM/TO
  and `executeTransitionCompound` (clipGraphManager) evaluates the sub-graph via `executeGraphDAG`
  with `standardState.transitionProgress` set. The new **TRANSITION_PROGRESS** node (shaderless
  float source, like MATH) drives any param socket it's wired to with the live progress — or its
  Preview params (auto triangle-wave) when idle — at any compound depth (unlike
  `resolveFloatConnections`, which is top-level only). Any library compound with ≥ 2 image inputs
  (`isTransitionCompound`) appears in the clip Inspector under "Custom (Node Graph)"; its exposed
  params surface there, per-clip overrides stored by index. `STARTER_TRANSITION_COMPOUND`
  (compoundPresets) seeds the library. Transition FBOs are scoped `tr~<clipId>~` and freed in
  `releaseClipResources`.
- **Compound nodes now survive save/load** — graph-node serialization previously dropped
  `subGraph`/`exposedParams`, so a COMPOUND placed in any graph lost its interior on reload.
  Both node maps in `projectSerializer.js` now persist them.
- **Per-clip audio** — `clip.audioMuted`/`volume` (Inspector "Audio" section, ♪× badge); audio
  follows fades and transition-crossfades (`Renderer._clipAudioGain` + `_audioGains` per frame);
  the export mixdown applies the same envelopes via per-clip GainNode value curves.
- **RAMP + LFO nodes (the keyframe replacement) — split out of the old combined TIME node.**
  Both are shaderless CPU float sources, peers of MATH/ENVELOPE, evaluated in
  `resolveFloatConnections`. **TIME wore two jobs**, which is what made it hard to use: `Rate` meant
  cycles/second, cycles-per-clip, or nothing at all depending on Source and Beat Sync, and all ten
  controls rendered at once when at most six were ever live. The split is by *intent*:
  - **`RAMP` — plays once across a span.** Outputs `value` (eased progress remapped into Start…End),
    `progress` (raw un-eased 0→1, to fan one ramp out to several params at different ranges via
    MATH) and `seconds` (elapsed in the span). Spans (`RAMP_SPANS`): **`Clip`** (default),
    **`Timeline`** (0→1 over `useTimelineStore.calculateDuration()`) and **`In / Out Range`** (the
    section a range export renders). All three are deterministic, so scrubbing shows the real
    animation and an export is pixel-identical. **Defaults alone == a keyframe pair across the clip**
    that re-times itself when the clip is moved/trimmed. `Cycles` repeats within the span,
    `Ping-Pong` returns to Start, `Ease` is Linear/Smooth/Ease In/Ease Out, and End may sit *below*
    Start (a countdown) — it's a remap, not a range.
  - **`LFO` — oscillates forever.** Outputs `value` (Min…Max), `bipolar` (the same wave as −1…1, to
    *add* to a param rather than replace it) and `seconds`. Time base is always seconds
    (`LFO_BASES`: Playhead / Clip Time / Free Run), so **`Rate` has exactly one meaning** unless
    `Beat Sync` swaps it for N beats of the project BPM (`useAppStore.bpm`/`beatOffset`). Same 9
    waves as before — Sine (cosine form, so it starts at Min and rises), Triangle, Saw Up/Down,
    Square (duty = Pulse Width), Bounce, Random Hold, Smooth Random, Linear (unbounded — continuous
    rotation) — plus the optional `Smooth` S-curve. Random waves hash the cycle index, so they're
    frame-stable.
  - **Migration is exact and edge-preserving** (`migrateTimeNodeParams`, run over every graph depth
    by `projectSerializer.migrateGraphNodes` — master, clips, compound interiors, the compound
    library). TIME's `Clip Progress` was the span-normalised source → becomes a RAMP (its wave
    becomes an ease / ping-pong, which is the job that wave was doing across a clip); the other
    three sources were seconds bases → become an LFO with the wave verbatim. **Both new types keep
    TIME's `value` and `seconds` socket ids**, which is why no saved graph needs rewiring.
  - **Two latent bugs died in the split.** (1) `buildTimeCtx` used to fall back to *the clip graph
    open in the editor* whenever `standardState.clipTime` was null — but the master pass sets it
    null deliberately, so a master-graph TIME node's output depended on UI state (and was a constant
    when no clip graph was open). `standardState` is now authoritative including its nulls; the
    store lookup is reached only by the DOM param-display pass, which really has no exec context.
    (2) `Clip Progress` silently ignored `Beat Sync` (the branch was unreachable) — structurally
    impossible now, since RAMP has no Beat Sync and LFO's always applies.
    Also: a ramp landing exactly on a cycle boundary at the end of its span wrapped to 0, snapping
    back to Start on the clip's final frame — the one frame a punch-in-and-hold must not do.
  - `hasParamInputs: true` → every control gets a float socket, so a band/ENVELOPE can modulate the
    generator itself (bass → LFO rate, envelope → RAMP End). Clip-local time reaches the evaluator
    via `standardState.clipTime`/`clipDuration`, stamped per exec site by
    `Renderer._setClipTimeContext` (like `hasSource`). Float overrides already reach the
    image/text/shape pre-passes, so a RAMP animates a shape's position/rotation with no keys.
  - `resolveFloatConnections` resolves MATH/ENVELOPE/**RAMP**/**LFO** as one dependency-ordered
    fixpoint (`DEFERRED_FLOAT_TYPES` + `producerPending`), which also fixes MATH → MATH reading a
    one-frame-stale value when the nodes sat in an unlucky order in the graph array.
  - **Perf note:** `ctx.timelineDuration` is a **lazy getter**. `calculateDuration()` walks every
    clip and the context is built once per graph execution per frame (master + every clip + every
    compound), so it must not be paid unless a RAMP actually spans the timeline.
- **Conditional param visibility (`showIf`)** — a param config may carry
  `showIf: { param, equals }` or `{ param, notEquals }` (operand may be an array; select params
  compare by **label** but tolerate index storage, like `selectIndex`). `isParamVisible` /
  `visibleDataParams` (dataNodeParams.js) are honoured by `NodeCard`, `Inspector` and
  `estimateNodeHeight`. Hides LFO's Beats/Cycle when Beat Sync is off, Pulse Width on non-Square
  waves, TRANSITION_PROGRESS's Preview vs Preview Speed.
  - **Sockets stay unconditional** — `getNodeSockets` never sees `showIf`. A hidden param can still
    legitimately be driven by a wire, and removing its socket would strand the noodle. Callers pass
    the node's connected input ids as `alwaysShow`, so a **wired param always keeps its row** and
    therefore a real DOM anchor for `NodeCanvas.getSocketPos`.
  - `visibleDataParams` fast-paths (`configs.some(c => c.showIf)`) so shader-parsed configs — every
    other node in the app — return the same array with no allocation.
  - **`src/shaders/dataNodeParams.js` is the single source of truth for the shaderless nodes' param
    configs** (MATH / ENVELOPE / TRANSITION_PROGRESS / RAMP / LFO). The same lists were previously
    hardcoded in `NodeCanvas`, `Inspector` and `compoundUtils` and had already drifted; all three
    read the table now, so these nodes also get Inspector controls (with keyframe diamonds) and
    compound param exposure for free.
- **ENVELOPE node** — CPU float follower (attack/release/threshold/gain), evaluated in
  `resolveFloatConnections` with per-node state (export-safe dt via `_timeOverride`).
- **Float wiring works in every executing graph** — `resolveFloatConnections(renderer, nodes,
  edges)`: the DAG executor passes its own chain/edges, so splitter/MATH/ENVELOPE → param
  connections run in all clip graphs and inside compounds (previously viewed-graph-only).
- **Split copies the clip graph** — `useGraphStore.duplicateClipGraph` (fresh ids); Timeline's
  split calls it so the right half keeps effects and is enterable.
- **Markers render** on the ruler (drag, Alt+click delete, dbl-click rename).
- **Global undo/redo** — `src/utils/history.js`: reference snapshots of graph+timeline stores
  (Zustand immutability makes this O(1)), 400ms coalescing, 50 cap, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y;
  cleared on project load.
- **Timeline snapping + beat grid** — snap to clip edges/playhead/markers/in-out (Shift bypasses);
  project `bpm`/`beatOffset`/`beatGridEnabled` (serialized), BPM input + TAP tempo (Alt+click sets
  offset to playhead) + GRID/SNAP toggles in the Timeline header; beat/bar lines on the ruler.
- **Keyframes are live** — `src/utils/keyframes.js` evaluates tracks (clip-relative time for clips,
  absolute for `'master'`; linear/step/ease easings); `Renderer._withKeyframes` overlays values into
  liveNodes at all three exec sites. Inspector shows a ◆ per slider param (toggle key at playhead,
  auto-key while animated); clips show keyframe diamonds. `addKeyframe` replaces keys within 1ms.
- **Real waveforms** — `src/utils/waveformCache.js` decodes each file once into 2000 peak buckets;
  `ClipWaveform` canvas replaces the fake sine bars.
- **Export range (In→Out)** — ExportModal "Range" selector (full project vs the timeline's In/Out
  window). The frame loop runs `playheadTime = rangeStart + frame/fps` (u_time stays ABSOLUTE, so a
  range export is pixel-identical to that section of a full export); `renderTimelineAudio` takes a
  `rangeStart` and clips each clip's schedule/gain-curve to the window (mid-clip starts advance
  `sourceStart` by `skip × speed`); stem analysis uses the same range. WebM path jumps the playhead
  to range start and records for the range duration.
- **Per-stem reactivity (Audio Source select is live)** — AudioEngine keeps a per-filename analyser
  tapped PRE-gain (element gain moved into a WebAudio `_playbackGain` node, so muted stems still
  drive visuals); `useAudioStore.sources` holds per-stem bands/beat; splitters resolve their
  upstream AUDIO_INPUT's `audioSource` (index or string → `resolveAudioSourceName`) for both float
  wiring and audio-driver sockets; export analyses each referenced stem offline (raw, gain-free)
  for parity.
- **Node-editor selection overhaul** — Box-select is now **plain left-drag on empty grid**
  (Alt+drag / middle-drag pans; Ctrl+drag box still works; a <4px box acts as a plain
  deselect-click); nodes highlight **live** during the drag (`node-card--multi-selected`, amber —
  the class previously didn't exist in CSS, so marquee selection was invisible); the release-click
  no longer instantly clears the selection/ActionContextMenu (`suppressCanvasClick` ref — the same
  phantom click was also deselecting after every pan). Shift+drag box is **additive**
  (`marquee.baseIds`); **Ctrl+click toggles** a node in/out of the multi-selection (handled on
  click, not mousedown, so Ctrl+drag wire-insert doesn't toggle); **Ctrl+A selects all**
  (marquee-eligible nodes); **dragging a multi-selected node moves the whole group** (cumulative
  delta vs drag-start positions — correct because NodeCard captures `onMove` at mousedown);
  Delete removes the whole multi-selection; Escape cancels an in-flight box. **Ctrl+C/Ctrl+V
  clipboard** (module-level, survives graph switches; pastes layout anchored at cursor, remaps
  internal edges, skips locked/structural nodes). ActionContextMenu: Duplicate (renamed from
  Copy) / Create Compound / Bypass-Enable All / Delete / Deselect. **Minimap is live**: node
  rects (NODE_COLORS) + viewport rect, click/drag to jump-pan. Card-height estimate extracted to
  `estimateNodeHeight` (was triplicated across marquee/fit/insert). ShortcutsOverlay updated.
  Note: locked nodes remain *movable* by design (lock guards structure — delete/marquee — not layout).
- **CI** — `.github/workflows/ci.yml` runs `npm ci` → `npm run lint` (ESLint + shader smoke test)
  → `npm run build` on push/PR.
- **Node-editor manipulation upgrades** — (1) **Ctrl+drag a node over a wire auto-inserts it**
  (Blender-style): `NodeCanvas.findInsertCandidate` hit-tests every noodle's bezier against the
  dragged card's bbox (type-aware: node needs a matching input+output; prefers a free input;
  cycle-guarded), highlights the target white (`noodle--insert-target`), and splices on release
  (`handleNodeMoveEnd`); NodeCard's `onMove` now passes the live mouse event + fires `onMoveEnd`.
  (2) **Param value scrubbing** — drag the numeric readout to adjust delta-based (~250px = full
  range, Shift = 10× fine), plain click still opens the type-in box (which now has proper
  min/max/step attrs); double-click a slider resets to its `@param` default; decimals shown follow
  step. (3) Audit fixes: `NODE_WIDTH` corrected 210 → 270 to match CSS (marquee + socket-fallback
  geometry were 60px off), wheel zoom now zooms around the cursor, and Fit-to-Window (F) actually
  frames the graph's nodes instead of resetting to origin.

- **Deployment hardening + folder access is now opt-in** — three related changes, driven by the
  fact that a static host compromise (or a CDN compromise) puts attacker JS in the same origin as
  the user's camera, media and folder handles:
  - **Monaco is bundled, not CDN-loaded.** `@monaco-editor/react` was falling back to its default
    loader and pulling ~5MB off `cdn.jsdelivr.net` at runtime — third-party code executing in our
    origin, with no breach required. `src/monacoSetup.js` calls `loader.config({ monaco })` against
    the already-installed `monaco-editor` package and registers only the base editor worker (GLSL is
    a Monarch grammar with no language service). `MonacoDrawer` imports it **dynamically** on first
    open, so the editor stays a lazy chunk and startup cost is unchanged.
  - **CSP on the production build.** `vite.config.js` gained a build-only (`apply: 'build'`) plugin
    injecting a `<meta http-equiv="Content-Security-Policy">`; dev is untouched so HMR still works.
    `connect-src 'self' blob: data:` is the load-bearing directive — the app never legitimately
    talks to another origin, so injected script has nowhere to send anything. `style-src` needs
    `'unsafe-inline'` (Monaco injects theme styles); `frame-ancestors` is omitted because it is
    ignored in meta CSP and GitHub Pages cannot set headers.
  - **Fonts are self-hosted.** `src/index.css` pulled DM Sans + JetBrains Mono from
    `fonts.googleapis.com` — a third-party origin in the critical path, a render-blocking round
    trip and a per-visit IP leak. Now `@fontsource-variable/{dm-sans,jetbrains-mono}` imported in
    `main.jsx` ahead of `index.css`. Note the family names gain a **" Variable"** suffix, so
    `--font-ui`/`--font-code` (and the two hard-coded stacks in `MonacoDrawer`/`Icons`) list
    `'DM Sans Variable'` / `'JetBrains Mono Variable'` first with the bare names as fallback.
  - **Folder linking REMOVED outright (supersedes the opt-in step below).** DaliViD now calls
    `showDirectoryPicker` nowhere. Gone: `projectFolderHandle/Name/Permission` + their actions
    (`useAppStore`), `saveProjectToFolder` / `loadProjectFromFolder` / `restoreMediaFilesFromFolder`
    / `verifyDirectoryPermission` / `copyFileToProjectFolder` / `save+loadProjectFolderHandle`
    (`projectSerializer`), the Toolbar's Link/Re-connect/Open-from-folder UI and folder badge, the
    NewProjectModal folder section, MediaPool's copy-to-folder on import/record, and
    `FolderAccessModal`. `openRecordingSink` lost its `projectFolderHandle` argument — its
    signature is now `(name, ext, handle)`.
    - **`showSaveFilePicker` in `screenRecorder.js` is deliberately kept**: it writes one
      user-named file, grants no read access, and persists nothing.
    - **Persistence model is now: IndexedDB while you work + an explicit `.dalivid.json` download.**
      Because IndexedDB is evictable, `App.jsx` calls `requestPersistentStorage()`
      (`navigator.storage.persist()`) on mount and registers a `beforeunload` warning that fires
      when `lastSaveTime > lastExportTime` and the project has content — i.e. edits exist that were
      never downloaded. `useAppStore.lastExportTime` / `markProjectExported()` back that check and
      are set by the Toolbar's "Save Project File".
    - **Migration:** `purgeStoredFolderHandles()` runs on mount and deletes any `project_folder_*`
      keys from earlier versions — a persisted handle is a standing readwrite grant the user can no
      longer see or revoke from inside the app.
    - Autosave is silent now (`handleSaveProject(silent)`), since without a folder every 2-second
      autosave would otherwise raise a toast.
  - **Folder linking demoted to opt-in** *(historical — superseded by the removal above)*. `showDirectoryPicker({ mode: 'readwrite' })` grants
    recursive read+write over the chosen tree, and the handle was persisted to IndexedDB
    (`project_folder_<id>`). It is now behind `FolderAccessModal` (shared one-time opt-in flag
    `dalivid_folder_optin` in localStorage) from both the Toolbar and NewProjectModal, and
    **NewProjectModal no longer requires a folder** — projects can be created with zero disk access.
    The low-authority path is now first-class: `exportProjectAsJSON` (which existed but had **no
    call site**) is wired to a "Save Project File" button, and `relinkMediaFromFiles` /
    `pickMediaFiles` / `getExpectedMediaFilenames` (projectSerializer) relink clips by filename from
    a one-shot multi-file input on import, with a standalone "Relink Media" toolbar button as the
    guaranteed user-gesture path. One blob URL per file, not per clip (splits share sources).

## Backlog / potential improvements

- **Verify the alpha-filtering + bitrate work in `npm run dev` (2026-08-12) — but note that
  `eslint` and `smoke:shaders` DID run and pass this time**, against the edited tree in a cloud
  container: 64 shaders + 35 transitions OK, and 0 errors / 0 warnings across all six edited files
  using the repo's own `eslint.config.js`. `npm run build` and a real WebGL2 context did NOT run,
  so what is open is runtime behaviour only. Checks, highest value first:
  1. **Text edges are the headline.** Light text over a dark clip, or anything with a Stroke, at
     100% preview zoom and then in an exported MP4. Edges should read as smooth ramps rather than
     stair-steps, and must not have gained a bright halo — too bright means the un-premultiply is
     running on data that was never premultiplied (i.e. the `true` argument didn't reach
     `uploadVideoFrame`).
  2. **Nothing moved on opaque content.** Any project whose text sits on an opaque card, and any
     JPEG image node: `a == 1` divides by 1.0, so these must be pixel-identical to before. If they
     are not, the `a > 0.0001` guard is biting somewhere it shouldn't.
  3. **`IMAGE_INPUT` at each Fit mode**, with a PNG that has soft edges: Cover, Contain, Stretch,
     Tile. The dark fringe should be gone in all four. Contain's letterbox bars must still be
     OPAQUE — that branch was left alone on purpose and a transparent bar means the wrong branch
     got edited.
  4. **Tile specifically**, since it is the one path that samples `fract(suv)` — a seam that
     darkens at the tile boundary would mean the filtering fix didn't reach it.
  5. **The bitrate readout** next to the Quality slider tracks resolution and fps as you change
     them (1080p30 ≈ 8.6 Mb/s at the default, 4K60 ≈ 69). Then export at 4K and confirm the
     encoder accepts the config rather than failing the `isConfigSupported` probe — the 200 Mb/s
     ceiling exists for exactly that, and it has never been exercised on real hardware.
  6. **File sizes went UP for large exports and DOWN for small ones.** A 720p30 export should now
     be noticeably smaller than before (3.8 Mb/s vs a flat 9), which is the change most likely to
     be mistaken for a regression.
  7. **The font picker**, opened both from a text clip and from a `TEXT_INPUT` node, with the
     current font both near the top of the list and buried in it: it must stay open, scroll with
     the wheel, arrow-key through groups, and still dismiss on an outside click, on Escape, and
     when the Inspector column itself is scrolled.

- **Verify the node-graph transition write-back in `npm run dev`** — sandbox down again, so
  `npm run lint` / `smoke:shaders` / `npm run build` have NOT been run. Checks, highest value first:
  1. **`npm run smoke:shaders`.** `MIX_BLEND` and `MATH_BLEND` both changed; the new `outA` is a
     variable, so check 4 (literal-1.0 alpha writes) must stay silent on them.
     `TRANSITION_RESOLVE_FS` is a Renderer-local shader, so it is NOT covered — a typo there shows
     up as a black frame during a graph transition, nothing else.
  2. **The headline case.** Two images with transparency (PNG with alpha, or `SHAPE`/`TEXT`
     generators), overlapping on one track, Crossfade on the incoming clip's head. Scrub the
     region, then Convert to Node Graph and scrub it again — the two must now look the same, and
     the outgoing image must not linger.
  3. **Nothing regressed on opaque footage.** A converted graph transition between two opaque
     clips must look identical to before *and* identical to the built-in — every change is a no-op
     at alpha 1.
  4. **Both ends.** First and last frame of the region: p→0 must be exactly the accumulator (no
     pop entering the region) and p→1 exactly the incoming clip. Repeat on a TAIL (the swapped-
     sides path) and on a transition out to nothing over the checker backdrop.
  5. **Opacity.** Drop the clip's opacity to 0.5 with a graph transition live — the backdrop must
     show through by half, exactly as it does with a built-in (that is the `u_opacity` lerp, which
     `_compositeTrack` was applying to the wrong side before).
  6. **Library compounds too** — a `compound:<id>` transition goes through the same write-back.
  7. **`MIX_BLEND` mid-graph.** Operation = Mix over transparent content now fades coverage; the
     other five operations must be unchanged. Open a project that uses one to confirm.

- **Verify the effect-node alpha fix in `npm run dev`** — sandbox still down, nothing run. Order:
  1. **`npm run smoke:shaders` FIRST, and expect it to pass with zero failures.** Check 4 is brand
     new and has never executed; it was hand-verified against the tree (the only literal-1.0 alpha
     writes left are the three `OPAQUE_BY_DESIGN` entries), but a parser bug in `opaqueAlphaWrites`
     would show up as false positives on unrelated shaders. If it cries wolf, the suspect is
     `splitArgs`' depth tracking, not the shaders.
  2. **The headline case.** Alpha video (or a `SHAPE`/`TEXT` generator) on track 2 over something
     on track 1, with Edge Detection in its clip graph. No blocks in the matte; the outline should
     now trace the silhouette itself, which is the edge you wanted. Repeat with Halftone, Emboss,
     Glitch, Voronoi (colour mode 1) and Audio Visualizer.
  3. **Nothing regressed on opaque footage.** All six should look identical to before on a normal
     clip — every change is a no-op at `a = 1`. Edge Detection with **Show Original** on was already
     correct, so it must be unchanged in both cases.
  4. **The blurs are the riskiest edit** because they now premultiply / divide back out. `BLUR` at
     radius 0 and 16, and `DEPTH_BLUR` at Max Blur 18, on opaque footage: identical to before. On
     transparent footage the blurred edge must stay the source's colour rather than picking up a
     dark or coloured halo. Watch for any dark ring at the silhouette — that would mean the
     un-premultiply guard (`a > 0.0001`) is biting too early.
  5. **`AUDIO_VISUALIZER` over an opaque clip must still fill the frame** — `max(bg.a, alpha)` is
     1.0 there. Over nothing (audio-only, no video under it) its graphics should now carry their own
     coverage instead of a black card.
  6. **Round trip.** These are shader-source edits, so any node whose shader was customised in
     Monaco keeps the OLD source (`getNodeSource` prefers the custom edit) and will still show the
     blocks. That is correct behaviour, not a regression — but it is the likely explanation if one
     specific node in an existing project stays broken.

- **Verify the transition alpha-space fix in `npm run dev`** — sandbox down again, so `npm run lint`
  / `smoke:shaders` / `npm run build` have NOT been run. Checks, highest value first:
  1. **`npm run smoke:shaders` first.** `TRANSITION_HEADER` was edited, so a malformed comment
     fails all 35 entries at once — the fastest signal. (The comment deliberately contains no
     backticks; the header is a JS template literal.)
  2. **The headline case.** A clip with real transparency (VP9+alpha, or a `SHAPE`/`TEXT`
     generator) over a clip on a lower track, with a Crossfade on its head. Scrub through the
     region: no blocks, no bright fringe where alpha meets picture. Then a tail transition on the
     same clip — that's the swapped-sides path.
  3. **Nothing regressed on opaque footage.** Two opaque clips crossfading should look identical to
     before. Also confirm the last frame of a head region is now *exactly* the plain cut (it should
     be byte-identical — that equality is what proves the space is right).
  4. **The two edited shaders.** `SLIDE` at all 3 modes with Shadow up, over transparent content —
     the seam shadow must darken the lower layer without eating its coverage. `SLICE_SHIFT` at Gap
     Opacity 0.5 — the gap must be half-strength, not blown out.
  5. **The graph path.** A node-graph / library-compound transition over transparent content. Its
     inputs are now correctly straight, but its *interior* `MIX_BLEND` is still a straight-space
     mix, so some fringing may remain there — that's the known limit below, not a new bug.
  6. **Frame time.** One extra full-screen pass per transitioning clip per frame, only inside a
     region. Should be unmeasurable; confirm it isn't.
  7. **Export parity + transparent export.** A short MP4 over the region should match the preview,
     and a VP9+Alpha export of a transparent clip's transition should keep clean edges over a
     coloured page.

- **Straight-space mixing inside node graphs has the same latent fault.** The transition
  compositor's inputs are fixed, but `MIX_BLEND` (and any node doing `mix(a, b, t)` on two texture
  inputs) still interpolates STRAIGHT RGBA, so crossfading transparent content *inside* a graph can
  still pull undefined colour out of the matte. The pipeline-wide fix is the one the older backlog
  entry already names — pick ONE alpha convention app-wide instead of straight-for-effects /
  premultiplied-for-the-compositor. Short of that, `MIX_BLEND` could premultiply, mix, and
  un-premultiply internally, which is 2 divides and correct; worth doing if it bites.

- **Verify "In Context" clip preview in `npm run dev`** — written with the Cowork sandbox down, so
  no lint/build run. No shader changed, so `smoke:shaders` is not the signal here; the risk is all
  in the `_renderFrame` branch and the mute/solo exemption. Checks, highest value first:
  1. **Nothing regressed in the default mode.** Open a clip graph — it must render isolated
     exactly as before, and the **Clip** segment must be lit. **+ Master** must behave identically
     to the old "Master FX: On".
  2. **In Context shows the composite.** A clip on track 2 over a clip on track 1, with a blend
     mode and an opacity < 1: In Context should show the real result, edits updating live.
  3. **The parking jump.** Scrub off the clip, then click In Context — the playhead should jump to
     the clip's start. Scrub away *again* while already in the mode and it must NOT jump back.
  4. **Mute / solo exemption.** Mute the edited clip's track: it must still show. Solo a different
     track: it must still show. Then **exit to master and confirm both hide again** — the exemption
     must not survive `exitClipGraph`.
  5. **Export can't inherit it.** Mute the edited clip's track, stay in In Context, export a short
     MP4 — the muted track must be absent from the file (that's the `previewTapEnabled` gate).
  6. **Taps.** Set a 👁 tap in each mode. Isolated = the node raw; In Context = that node's output
     standing in as the clip's output, composited. Both should be legible; neither should crash.
  7. **Perf is the real cost.** Watch the frame time switching Clip → In Context on a project with
     several tracks and heavy clip graphs. Expect a real drop — that's why the default is isolated.

- **Verify `TRANSITION_FX` in `npm run dev`** — sandbox still down, so no lint/build/smoke run.
  0. **Sliders are live.** Open a transition graph, drag any param on any node — the preview must
     change *while dragging*. Same for a param on a node inside a COMPOUND, which had the identical
     bug. Then confirm the drag is still cheap (no recompile): the only param that may stutter is
     TRANSITION_FX's Effect, which recompiles by design.
  1. **`npm run smoke:shaders`.** TRANSITION_FX is registered, so the wrapper is validated —
     specifically that the `#define` aliases keep `u_from`/`u_to`/`u_progress` from reading as
     undeclared, and that the generated Effect select's default index is in range.
  2. **Convert preserves the effect.** Put Film Burn on an edge, tweak Origin and Glow, then
     Convert to Node Graph. The graph must contain a Transition FX node reading *Film Burn* with
     *those values*, and the picture must not change at the moment of conversion.
  3. **Switching effect.** Change the node's Effect select — the picture must change immediately
     (that is the `SOURCE_PARAMS` recompile) and the new effect's params must appear at their
     defaults, not at zero. Switch back and confirm the original values survived.
  4. **Nodes arrive unconnected.** Drop any node into a transition graph — it must land exactly
     where you dropped it with no edges created and no Transition Progress node conjured up.
  5. **Stacking, wired by hand.** Add a second Transition FX, wire From = the first one's output,
     To = the TO terminal, and Progress into its Progress socket. Scrubbing must show both effects.
     Then give the second one its own MATH remap of Progress (e.g. ×2−1 clamped) so it runs in the
     back half only; that is the Resolve-style custom transition.
  6. **Round trip.** Save/load keeps `u_tfx_type` (it is a plain param) and the graph still
     compiles to the right effect. A project saved BEFORE this change must still open — its
     transition graphs contain MIX_BLEND, which is untouched.
  7. **Monaco.** Opening the shader editor on a TRANSITION_FX writes `customShaderSource`, which
     then wins over the generated source — so the Effect select stops having any effect. That is
     the intended "fork this into a custom shader" path, but it is a sharp edge; if it bites,
     either hide the Monaco button for this type or clear `customShaderSource` when Effect changes.

- **Verify the 25 new transitions in `npm run dev`** — sandbox down again, so `npm run lint` /
  `smoke:shaders` have NOT been run. 25 new shaders plus a rewritten shared header is the largest
  GLSL change since the 3D family, and only a real WebGL2 context proves it.
  1. **`npm run smoke:shaders` FIRST.** Every transition now carries the rewritten
     `TRANSITION_HEADER`, so a malformed helper fails all 35 at once — the fastest possible signal.
     It also catches the two classes of mistake that were found by hand this round (a stray backtick
     closing the template literal, an `@param` not adjacent to its uniform).
  2. **Nothing regressed.** The 10 original transitions must look identical — only their `category`
     field changed. Open a project using CROSSFADE and one using GLITCH_BLOCKS.
  3. **Both ends are clean.** For every new transition, step to the FIRST and LAST frame of the
     region: the picture must be exactly FROM and exactly TO, with no residual glow, blur, smear,
     offset or noise. Everything is gated on `t_env` or lands on identity for this reason, so any
     entry that fails here has a genuine bug, not a taste problem.
  4. **The two named ones.** `FILM_BURN` at each Style, sweeping Origin 0→360 (the burn front must
     travel, not ignite everywhere at once). `FILM_ROLL` at Direction = Up AND Down — Down is the
     case that would silently never complete if the mirroring were replaced by a negative travel.
  5. **Select params.** Each of the eight `SHAPE_IRIS` shapes; `SLIDE` at all 3 modes × a few
     directions; `CHECKERBOARD`'s 5 orders; `PIXEL_SORT`'s 4 directions. A select whose default
     index is out of range is a smoke-test failure, but a shape that renders wrong is not.
  6. **Frame time.** `t_disc` (13 taps) is used by `DEFOCUS` and `BLOOM_DISSOLVE`, `t_streak` (9) by
     `WHIP_PAN`. `PIXEL_SORT` and `SPIN` add their own 8 and 5. None should be near the cost of the
     3D family, and all are constant regardless of their radius params — sweep Blur/Length to the
     maximum and confirm the frame time does not climb.
  7. **Transparency.** `SLICE_SHIFT` Gap Opacity 0 must show lower tracks through the gaps (and
     export transparent), 1 must show the gap colour. `FILM_BURN` / `SHAPE_IRIS` glow raise alpha
     deliberately, so check a transition-out-to-nothing over the checker backdrop.
  8. **Grouping.** Media Pool → Transitions shows 8 category sections and the search box filters
     across name/category/description; the Inspector dropdown shows the same groups as `optgroup`s;
     the Timeline edge menu opens on categories and drills in. All three must agree, since all three
     read `groupedTransitionCatalog`.

- **Transition preview thumbnails.** The browser cards are text plus a ⇄ glyph. Rendering each
  shader once into a small canvas (two placeholder gradients as FROM/TO, progress ~0.5) would make
  a 35-entry library scannable at a glance — which is most of the value of a browser. Needs an
  offscreen WebGL2 context and a cache keyed by type; the shaders are already compilable standalone
  via `buildTransitionShader`, so the work is all in the harness, not the GLSL.

- **Verify the transition-discoverability pass in `npm run dev`** — the Cowork sandbox was down for
  this one, so `npm run lint` / `npm run build` have NOT been run against it. No shader changed.
  Checks, highest value first:
  1. **Hotspots.** Hover a clip: a ⇄ appears at each end that has no transition. Click it — the
     default (Crossfade) lands on that edge with a 1s window and the wedge appears. Then confirm the
     trim handle and the fade handle are still grabbable at the same corner (the hotspot deliberately
     sits under both).
  2. **Right-click zone.** On a clip with no fades at all, right-click within ~22px of either end —
     the edge menu must open, not the clip menu. Right-click the middle → clip menu. On a very short
     clip the middle must still be reachable (zone caps at a third).
  3. **`T`.** Select a clip, park the playhead in its first half, press T → Transition In. Second
     half → Transition Out. In a text field T must still type. On an audio clip it must do nothing.
  4. **Transitions tab.** Drag a card onto a clip's front half → In, back half → Out; the cyan band
     must show which edge before you let go, and must NOT appear when dragging an image/shape card
     (that's the marker MIME type). Click a card with a clip selected → applies to the nearer edge.
     Right-click → Set as Default, then confirm the ★ moves and T uses the new one.
  5. **Default round trip.** Change the default in Inspector → Project, save, reload. Also set it to
     "Fade" (empty string) and confirm it survives — `??` vs `||` is exactly this case.
  6. **FROM/TO roles.** Open a transition node graph, confirm it still dissolves the right way round.
     Then save/load and confirm it still does (that's `terminalRole` surviving the serializer). A
     project saved BEFORE this change must also still work, via the index fallback.
  7. **`audioBand` regression fix.** Build a compound with an audio-band EFFECT_INPUT terminal, save,
     reload, and confirm it still drives its band — that field was previously dropped on save.

- **Verify the transition-authoring pass in `npm run dev`** — the Cowork sandbox was down again, so
  `npm run lint` and `npm run build` have NOT been run against it. No shader changed, so
  `smoke:shaders` is not the risk here; the risk is React wiring. Checks, highest value first:
  1. **The headline fix.** New project, one clip, no fades. Inspector → Transition In → Effect →
     *This clip's own graph*. Duration must jump to 1s **by itself** and the clip must now dissolve
     in. Repeat via the Timeline (right-click the clip → Transition In → Effect) and confirm both
     routes behave identically — that parity is the point of `transitionActions.js`.
  2. **The scrubber.** Open that graph. The strip under the header should show Progress, FROM/TO and
     the duration. Dragging Progress must move the timeline playhead and change the picture; letting
     it sit at 100% must show the fully-arrived frame (that's the `0.999` clamp — at a true 1.0
     `regionProgress` returns null and nothing composites).
  3. **Drop-in behaviour.** With the graph open, drag any effect from the Media Pool onto the canvas.
     It must land unconnected, where you dropped it — no edges, no nodes created. Wire it in by hand
     and confirm it takes effect; wire Transition Progress into its amount param and confirm it ramps
     rather than sitting still.
  4. **The error surface.** Delete the Mix node so nothing feeds OUTPUT. The Inspector section and
     the editor strip must both show an amber note; the cut degrades to a hard cut as before. Re-wire
     and confirm the note clears.
  5. **Preview tap.** Click 👁 on a node inside a transition graph — the preview should show that
     node's output composited in place. Reset via the header chip.
  6. **Nothing regressed on the ordinary paths.** A crossfade between two overlapping clips must be
     unchanged (its Duration shows "(overlap)" and is a readout, not a slider). An audio clip's
     Inspector must still show Fade In / Fade Out. A clip with a built-in transition must still play
     it, and `edgeDisplaySeconds` still drives the wedge.
  7. **Round trip.** Save/load keeps both edges and their graphs; deleting the clip leaves no orphan
     status note or graph.

- **Verify the 3D / Depth family in `npm run dev`** — written with the Cowork sandbox down, so
  `npm run lint` (ESLint + shader smoke test) and `npm run build` have NOT been run. Every static
  check the smoke test performs was audited by hand (structure, `@param`↔uniform 1:1 adjacency for
  all 79 params, select-default ranges, hex colour formats, uniform declaration coverage,
  delimiter balance), but only a real WebGL2 context proves the GLSL. Checks by how much they'd
  hurt if broken:
  1. **`npm run smoke:shaders` first** — 6 new shaders and a rewritten `DEPTH_BLUR`, all now
     carrying the concatenated `LIB3D` header. If the header is malformed every one of them fails
     at once, which makes this the fastest possible signal.
  2. **Nothing regressed.** `DEPTH_BLUR` is the only *existing* node touched. Open a project that
     uses it: the picture should look near-identical (soft Gaussian disc, not a hard bokeh disc)
     and the frame time at a large Max Blur should drop enormously. Its 4 sliders must behave
     exactly as before.
  3. **Bare drop-in.** Drop `RELIGHT_3D` alone on a video with nothing wired to `Depth`. It must
     still light the shot (reading colour luma as depth via the `TEXTURE_INPUT_SOCKETS` fallback),
     not render black. Same for `FOG_3D` / `AO_3D` / `BOKEH_3D`.
  4. **The real rig.** Media Pool → Presets → **Cinematic Depth**. Confirm one `DEPTH` node feeds
     three consumers, and that `DEPTH`'s Output → *Colorized (Preview)* shows plausible depth
     (subject warm/near, background cool/far). Tune Focus Weight and Smooth Radius and watch it.
  5. **Lighting reads as 3D.** `RELIGHT_3D` → Studio, then sweep Key Angle 0→360. The shading must
     travel around the subject; if it smears across silhouettes, `d3_normalFromDepth`'s
     smaller-gradient selection is the place to look.
  6. **AO has no halos.** `AO_3D` → SSAO at a large Radius. Look at a hard foreground/background
     edge: creases should darken, but there must be no dark outline tracing the subject. Depth
     Range is the knob (it's the range check).
  7. **DOF doesn't bleed.** `BOKEH_3D` with a sharp foreground over a blurred background — the
     foreground edge must stay crisp. Then Blades = 6 and Highlight Bokeh up on footage with
     speculars: expect hexagonal bokeh balls. Output → *CoC (Preview)* shows what's being blurred.
  8. **Tilt-shift needs no depth.** Preset → **Miniature**. Should work with the depth socket
     empty, and Tilt Angle should rotate the focus band.
  9. **Audio hooks are neutral until wired.** With no Audio Splitter connected, every one of these
     nodes must look static — the gated bands are 0. Then wire bass → `FOG_3D` Audio Drivers and
     confirm the fog pumps.
  10. **Round trip + cleanup.** Save/load keeps all params (they're plain `node.params`, so this
      should be free); deleting a `DEPTH` node with three consumers attached must not leak FBOs
      (`releaseNodeResources` handles `__n_` keys generically) and the consumers should fall back
      to reading colour luma rather than going black.
  11. **Phase 3 — parallax.** Preset → **3D Photo**. The frame should push in with near objects
      *covering* far ones, not sliding over them; switch Quality to *Single Tap* to see the
      difference (that is the rubber-sheet look). Set Reveal Fill to *Void* and confirm the
      revealed strip goes transparent (checker backdrop on) rather than black — if it darkens
      instead, something is scaling rgb as well as alpha. Sweep Depth Scale up until it breaks;
      Edge Threshold is the knob for how eagerly disocclusion is detected.
  12. **Parallax is cheap when still.** With Motion = Manual and Camera X/Y/Z at 0, `CAMERA_3D`
      must cost essentially nothing (the `travelPx < 1.0` early-out) — watch the frame time as
      you drag Camera X off zero and it should rise smoothly, not jump.
  13. **Stereo.** Preset → **Anaglyph Retro** with red/cyan glasses: depth should read correctly,
      not inverted (if it does, Swap Eyes, and check `Convergence` — content at that depth should
      sit *on* the screen plane). Then **Wiggle 3D** with no glasses. Check Side-by-Side halves
      look identically separated to the anaglyph (that's the `aspect * 2.0` correction).
  14. **Multiplane.** Preset → **Paper Diorama**. Expect discrete sliding cutout layers; raise
      Feather and they should melt together, raise Separation and the stack should pull apart. At
      Gaps = *Transparent* the holes between planes must be truly transparent with no dark
      fringing (that's the premultiplied composite).
  15. **Phase 4 — `TIME_SLICE_3D` is the one to check first**, because it is the only node in the
      family that depends on renderer machinery rather than pure arithmetic. Drop it and confirm the
      executor gave it a ping-pong (it should accumulate over several frames rather than showing a
      static frame). Preset → **Time Corridor**: the background should visibly lag behind the
      foreground with a grainy dither, and the grain must be *stable* per pixel, not crawling
      everywhere at once. Then check `Slit Scan (Rows)` fills from black over a second or two —
      starting black is correct, the history buffer begins empty. Resize the preview and confirm
      history clears without artefacts, and delete the node to confirm no FBO leak (`__npp_` keys).
  16. **`TIME_SLICE_3D` export parity.** `Depth Freeze` hashes on `floor(u_time * 60.0)`, and export
      frame-locks `u_time` via `_timeOverride` — so a rendered file should match the preview. Worth
      one short MP4 to confirm, since a feedback node's history depends on frame *order*, not just
      on the current time.
  17. **`VOXEL_3D` frame time.** It is the heaviest node here. Watch the frame time as Height goes
      up (that raises travel distance, hence step count, up to the 24 cap) — it should plateau, not
      climb without limit. Then Grid to 160 and confirm block edges stay crisp rather than
      staircasing (if they staircase, the `travelPx / 2.0` step rule is the knob).
  18. **`DEPTH_DISPLACE` anchors.** Sweep Depth Bias: content at the bias depth must stay *still*
      while everything else moves. If the whole frame slides, `rel = d - bias` is being ignored
      somewhere. Then Chroma Split up and confirm the dispersion follows the displacement direction.
- **Verify scaled FBOs in `npm run dev` — this is the highest-risk change in the depth work,
  because the viewport line it removes ran for every node every frame.** Checks:
  1. **Nothing regressed at all.** Open any existing project with effects. Every pass still writes
     a canvas-sized FBO, so the picture must be byte-identical. If the whole frame is suddenly
     drawing into one corner (or is stretched), the `if (!outputFBOId)` guard in
     `Renderer.executePass` is the only suspect — restoring the unconditional
     `gl.viewport(0, 0, this.width, this.height)` there is the one-line rollback.
  2. **`DEPTH` at Half (the new default).** Drop a `DEPTH` node, Output → *Colorized*. It should
     fill the frame, not a corner. Then Full / Half / Quarter: the map should get softer and the
     frame time should drop ~4× per step, with the *framing identical* in all three.
  3. **Consumers are unaffected by the producer's resolution.** With `RELIGHT_3D` reading a
     Quarter-res `DEPTH`, lighting must still be full-res sharp — only the depth is coarse.
  4. **Resolution changes rebuild the target.** Toggle Half → Full → Quarter repeatedly while
     playing. `resize` deliberately preserves an FBO's own scale, so `ensureFBO` must notice the
     change and recreate; if it doesn't you'd see the map stuck at the old size.
  5. **Canvas resize preserves the ratio.** Change export/preview resolution with `DEPTH` on Half
     and confirm it stays half of the NEW size (that's `resize` re-applying `entry.scale`).
  6. **No leak.** Delete a scaled `DEPTH` node and confirm its `__n_` FBO is freed as before.
- **`npm i` then verify the alpha work in `npm run dev`** — written with the Cowork
  sandbox down, so `npm install` (the new `webm-muxer` dep), `npm run lint` and
  `npm run build` have NOT been run. **Install first or the Export modal will fail to
  import.** Checks, roughly by how much they'd hurt if broken:
  1. **Nothing regressed.** The present-path change touches every frame. Open an existing
     project with a master graph that has effects and bars off — picture should be
     identical, and a fade-out should still land cleanly on black (that path previously
     skipped the colour mask, so if anything it should look *better*).
  2. **Import.** Bring in a VP9-alpha WebM (Chrome/Firefox decode it). Put it on track 2
     over another clip: the transparent regions should show the lower clip, with no dark
     or bright halo at the edges. Inspector → Alpha Channel should read
     "Detected: Premultiplied" (or Straight) within a second of the clip rendering.
  3. **Detection is right.** Flip Interpret As between Straight and Premultiplied and
     watch the edges: one of the two will fringe. Auto should match the clean one. If it
     doesn't, `classifyAlphaSample`'s `STRONG_OVERSHOOT` is the knob.
  4. **Backdrop + matte view.** Toolbar checker button cycles black → checker → white;
     the α button shows the alpha as greyscale. Neither should change FPS meaningfully,
     and turning them off must restore the exact previous image.
  5. **Neither leaks into output.** With the checkerboard ON, export a PNG and an MP4 —
     both must come back with a black background, not a checkerboard. (This is the
     `previewTapEnabled` gate.)
  6. **Transparent PNG.** Export → Frame → Transparent, on a project with a keyed clip
     over nothing. Open it over a coloured background; edges should be clean, not dark.
  7. **Transparent WebM.** Export → WebM (VP9 + Alpha). Play it in Chrome over a coloured
     page. Check audio is present and in sync (it's Opus at 48 kHz now, a different path
     from MP4/AAC). Confirm it also opens back in DaliVid and re-detects as alpha.
  8. **Round trip.** Set a clip's Interpret As to Premultiplied with a white matte, save,
     reload — both should persist. An untouched clip should save no `alphaMode` at all.
  9. **The probe budget.** Scrub a long opaque clip and watch the frame time: probes must
     stop after `ALPHA_PROBE_MAX_ATTEMPTS`, so there should be no sustained readPixels
     stall. Also resize the preview / change export resolution and confirm detection
     still works (the `fixedSize` FBO guard).
- **`webm-muxer` and `mp4-muxer` are both deprecated** in favour of `mediabunny` (same
  author). Nothing is broken and neither has an open advisory, but a single migration to
  `mediabunny` would replace both and is the obvious next dependency cleanup.
- **Alpha for the MediaRecorder WebM paths.** `webm-vp9` / `webm-vp8` go through
  `canvas.captureStream()`, which discards alpha. They're kept for the real-time path;
  anyone wanting transparency should use the WebCodecs VP9+Alpha option. Worth removing
  the plain VP9 entry entirely if the WebCodecs path proves reliable.
- **Alpha for image/generator sources.** `IMAGE_INPUT` already honours PNG alpha, but it
  goes through `renderImageNode`, not `_drawSourceWithAlpha`, so a premultiplied PNG has
  no interpretation control. Same fix, different call site, if it ever bites.

- **Verify the edge-transition pass in `npm run dev`** — written with the Cowork sandbox down, so
  `npm run lint` (ESLint + shader smoke test) and `npm run build` have NOT been run. Highest-value
  checks, roughly in order of how much they'd hurt if broken:
  1. **The alpha fix.** Put one clip on the timeline with a 2s fade-out and nothing after it. The
     ramp should look linear and land on the same black the gap shows — no early drop-off, no step
     at the clip's end. Compare a fade-in on the same clip: they should mirror each other.
  2. **Out to nothing.** Right-click that clip's tail wedge → Effect → Circle Wipe. It should iris
     out to black. Then Dip to Color, then Node Graph.
  3. **In from nothing.** Same on a clip's head with no clip before it.
  4. **Crossfade unchanged.** Overlap two clips, put a Crossfade on the incoming one — should be
     identical to before, and the head handle should be hidden while it is (the overlap owns it).
  5. **No double dip.** A clip with both a fade handle and a transition on the same edge should
     ramp exactly once.
  6. **Transition graph.** Right-click a wedge → Convert to Node Graph. The editor should open on a
     mid-region frame titled "Transition In/Out: <clip>", with the full pipeline previewing; editing
     the graph should change the preview live. Then Save to Library and check it appears in the
     other clip's effect list. Delete the clip and confirm no orphan graphs remain.
  7. **Short-clip edge case.** A 1s clip with 0.8s in and 0.8s out, both with transitions — the head
     should win for the overlap and the tail should pick up after.
  8. **Round trips.** Save/load keeps both edges; split gives the left half the head and the right
     half the tail; duplicate drops the head only; undo/redo of an effect change works.
  9. **Export parity.** A short MP4 export of a clip with a tail transition should match the preview
     frame-for-frame, with the audio fading out alongside.
  10. `npm run smoke:shaders` — the new `DIP_COLOR` entry and the `u_backdrop` header addition.
- **Transition graphs can't use a preview tap.** `executeTransitionCompound` doesn't take a
  `tapPointNodeId`, so clicking a node's 👁 inside a transition graph does nothing. Threading it
  through is easy; the risk is that the tap path draws straight to screen mid-pipeline, which would
  fight the compositor. Worth doing properly if transition graphs get used much.
- **Keyframes inside a transition graph** land under the synthetic clip key, so `KeyframeLane`
  finds no base clip and treats the times as absolute. Harmless today (the lane just shows nothing
  useful), but it should either resolve the key to its owning clip or hide the lane.
- **Verify the clip context menu + reverse in `npm run dev`** — written with the sandbox down, so
  no lint/build run. Checks: right-click a clip (and its trim/fade handles) opens the menu without
  the clip jumping; Reverse plays the clip backwards and the ✓ toggles in place; splitting a
  reversed clip yields two halves that play back-to-back with no content swap; a reversed clip
  exports with reversed audio that lines up with the picture; save/load keeps `reversed`; Ripple
  Delete closes the gap on that track only.
- **Reversed audio in the live preview** — currently silent (the media element is paused and
  seek-driven). Doing it properly means decoding the clip once into a reversed `AudioBuffer` and
  scheduling it through the `AudioEngine` in sync with the playhead, including a pre-gain tap so
  stem reactivity still works. Worth it if reverse gets used a lot.
- **Verify the TIME node in `npm run dev`** — also written with the sandbox down (no lint/build run).
  Checks: drop a TIME node, wire `value` → a slider socket and confirm the param animates and the
  card readout shows ⚡; `Clip Progress` + `Saw Up` ramps exactly once across a clip and re-times
  when the clip is trimmed; scrubbing the playhead moves the value (deterministic sources) while
  `Free Run` keeps going when paused; a short export matches the preview frame-for-frame; and a
  save/load round-trip keeps the node's params (they're plain `node.params`, so this should be free).
- **Verify the transition in/out-of-nothing work in `npm run dev`** — written with the Cowork
  sandbox down, so `npm run lint` and `npm run build` have NOT been run against it. Checks, highest
  value first: (1) a lone clip on an empty timeline with Transition In = Crossfade and Fade In 1s
  opens from black over exactly 1s, and is **not** double-faded (compare against Fade In 1s with no
  transition — the transition version should be a linear fade, the old one unchanged);
  (2) Transition Out = Circle Wipe + Fade Out 1s wipes the clip away to black, and the first frame
  of the window matches the plain composite (no pop); (3) a clip on track 2 blends in over track 1
  below it rather than over black; (4) **existing overlap transitions are unchanged** — open a
  project with two overlapping clips and confirm identical timing; (5) a node-graph (compound)
  transition works in the out direction, i.e. it dissolves TO the backdrop rather than leaving the
  clip visible; (6) save/load round-trips `transitionOut`, and a project saved before this change
  still loads; (7) a range export of a clip's first second is pixel-identical to the preview.
- **Three screen exits still bypass the un-premultiply (`PRESENT_FS`).** `_blitToScreen` is fixed,
  but the frame can also reach the canvas via: (1) a master graph WITH effects and bars OFF —
  `executeChain(..., presentFBOId = null)` lets the last effect pass write straight to the default
  framebuffer; (2) the widescreen-bars pass, where `barsProgram` (the LETTERBOX shader) is the last
  write; (3) isolated clip view's no-graph passthrough. So turning on a master effect can currently
  change how a fade-from-nothing reads. Fixing (1) means always routing through `__master_present`
  (one extra full-frame pass for everyone — weigh against the perf rule) or teaching `executeChain`
  to use PRESENT_FS for its final screen-bound pass; (2) needs an un-premultiply flag on LETTERBOX
  that is OFF when it runs as a normal node (where it lives in premultiplied FBO space). Deferred
  because the deeper issue is that **effect shaders emit straight alpha while the compositor emits
  premultiplied** — picking one convention app-wide is the real fix, and it can't be done blind.
- **Timeline fade wedge is drawn as a linear opacity ramp** even when a transition owns that handle,
  where the actual curve is whatever the transition does. Cosmetic, but tinting the wedge (or
  swapping it for a transition-specific glyph) when `transition`/`transitionOut` is set would stop
  it implying a plain fade.

- **Verify the Pan/Zoom work in `npm run dev`** — written with the Cowork sandbox down, so
  `npm run lint` (ESLint + shader smoke test) and `npm run build` have NOT been run against it.
  Checks, highest value first: (1) `TRANSFORM` compiles in a real WebGL2 context and a zoom of 2
  with Pan X 0.5 centres on the point halfway to the right edge; (2) the four Edge modes behave
  (Transparent shows the track below, Clamp smears, Mirror/Tile repeat) and a rotated Transparent
  edge is smooth, not stair-stepped; (3) a clip Transform matches an equivalent `TRANSFORM` node
  pixel-for-pixel; (4) ◆ Zoom at the clip's first and last frame produces a linear punch-in that
  survives moving/trimming the clip; (5) Reset clears both values and keys; (6) save/load keeps
  `clip.transform`, and a project saved *before* this change still loads (its legacy
  `{ x, y, scaleX… }` object must resolve to identity, not junk); (7) an untransformed project
  allocates no `clip_xf_*` FBO.
- **On-canvas Pan/Zoom gizmo (the obvious next step).** The controls are sliders today.
  `Preview/ShapeHandles.jsx` already solves the hard part — canvas-rect-derived geometry that
  tracks preview pan/zoom, handles-only pointer events — so a sibling that draws the framing
  rectangle for a selected `TRANSFORM` node / transformed clip (drag = pan, corners = zoom,
  ○ = rotate) would reuse that machinery. Note the two interact: a shape clip that ALSO has a clip
  transform will have its shape gizmo mis-registered, since the handles assume the shape's shader
  coords map straight to the canvas.
- **Oversampled clip input for sharp video punch-ins.** `clip_input_<id>` is canvas-resolution, so
  zooming past ~1.5 on video visibly softens and a 4K source's detail is discarded at upload.
  Rendering a transformed clip's input at N× canvas (only when its transform is non-identity, so
  the cost is opt-in) would recover it. Costs VRAM per clip and touches `_renderClipToFBO`,
  `_runClipGraph` and `releaseClipResources` — deliberately deferred.
- **Keyframes don't survive a split.** `splitClip` copies `clip.transform` to the right half (it's
  a plain field in the `{...clip}` spread) but NOT its keyframe tracks, which are keyed by clipId.
  Pre-existing for node keyframes too; a split that also duplicated the tracks — re-basing key
  times to the new clip start and dropping keys outside each half — would fix both at once.
- **Verify the RAMP / LFO split in `npm run dev`** — written with the Cowork sandbox down, so
  `npm run lint` (ESLint + shader smoke test) and `npm run build` have NOT been run against it.
  Checks, highest value first:
  1. **Migration.** Open a project saved with TIME nodes. A `Clip Progress` node must come back as a
     **Ramp**, the other three sources as an **LFO**, *with every existing wire still attached*
     (both types keep the `value`/`seconds` socket ids) and the same on-screen animation. Check a
     TIME node nested inside a compound and one in the compound library, not just top level.
  2. **The 0→1 range.** Drop a Ramp, wire `value` → a slider socket, leave every default: the param
     must read Start on the clip's **first** frame and End on its **last** — including the final
     frame, which used to snap back to Start. Trim the clip; it should re-time.
  3. **New spans.** `Timeline` ramps 0→1 across the whole project; `In / Out Range` across the I/O
     window and lines up with a range export.
  4. **Master-graph fix.** A Ramp on the **master** graph with span `Clip` outputs a constant (there
     is no clip) *regardless of which clip graph is open in the editor* — that coupling was the bug.
     Span `Timeline` is the master-graph answer.
  5. **`showIf`.** LFO hides Beats/Cycle until Beat Sync is ticked and Pulse Width until the wave is
     Square; a **wired** hidden param keeps its row and its noodle stays anchored (that's the
     `alwaysShow` path). Marquee-select over an LFO — `estimateNodeHeight` should now match the
     shorter card.
  6. Scrubbing moves the value on every deterministic source while `Free Run` keeps going when
     paused; a short export matches the preview frame-for-frame.
- **Verify the shape/bars work in `npm run dev`** — it was written while the Cowork Linux sandbox
  was down, so `npm run lint` (ESLint + shader smoke test) and `npm run build` have not been run
  against it. Highest-value checks: both new shaders compile in a real WebGL2 context
  (`SHAPE_INPUT`, `LETTERBOX`), the gizmo's mapping matches the shader (drag a shape to the frame
  edge → `u_shp_x ≈ ±1`, rotate handle turns the shape the same way it turns), and a save/load
  round-trip keeps `masterBars` + shape-clip params.

Ideas surfaced but not yet built (roughly by value-to-effort).

- **ACCEPTED RISK: `npm audit` reports DOMPurify advisories via `monaco-editor` (do not "fix").**
  `monaco-editor` ≥ 0.54 depends on `dompurify` ≤ 3.4.11, which carries three open sanitizer-bypass
  advisories (GHSA-c2j3-45gr-mqc4, GHSA-cmwh-pvxp-8882, GHSA-vxr8-fq34-vvx9). **There is no forward
  fix**: `npm audit fix --force` "resolves" it by *downgrading* to `monaco-editor@0.53.0`. Do not run
  it. We are pinned to 0.56.0, which already cleared 14 of the original 17 advisories.
  - **Why it's safe to sit on:** DOMPurify is only reached via `sanitize()` when Monaco renders
    markdown into hover tooltips / suggestion docs. DaliViD registers no hover or completion
    provider — GLSL is a bare Monarch grammar (`GLSLTokenizer.js`) — so no attacker-controlled
    string reaches that call. The production CSP (`script-src 'self'`, no `'unsafe-inline'`) also
    blocks execution of anything a bypass might smuggle through.
  - **Expiry condition — revisit if ANY of these become true:** (1) `dompurify` > 3.4.11 ships and
    Monaco picks it up (Dependabot will raise the PR — take it); (2) we add a language service,
    hover provider, completion docs, or otherwise render markdown in the editor, which makes the
    path reachable; (3) the CSP is relaxed to allow inline script.

- **BLOCKED UPSTREAM: ESLint 10 (`eslint` + `@eslint/js`) cannot be taken yet.** Dependabot raised
  two PRs for it (#18 `@eslint/js` 10.0.1, #19 `eslint` 10.8.0) and they would have had to land
  **together** — `@eslint/js` 10 declares `eslint` in `peerDependencies`, so merging either alone
  breaks `npm ci`.
  - **Both are now CLOSED with `@dependabot ignore this major version` (2026-08-08).** They were
    left open at first, but that was the wrong call: master kept moving (react-dom 19, plugin-react
    6), so #19 went conflicted on `package.json`/`package-lock.json` — and its `eslint` line sits
    *adjacent* to the `@vitejs/plugin-react` line, which is why a lockfile-only conflict became a
    manifest conflict too. Dependabot then could not self-rebase: the repo's branch protection
    matches `dependabot/*`, so its retry posted *"because the branch … is protected it was unable
    to do so."* Result was a permanently-conflicting PR that could never be merged anyway.
    **Resolving that conflict by hand would have been wasted work** — a green merge button on a
    change that fails `npm ci` on the very next CI run. Ignoring the major stops the churn without
    losing the upgrade: Dependabot re-raises it the moment the blocker below clears.
  - **The blocker is `eslint-plugin-react`.** Latest published is still **7.37.5** (re-verified
    against the npm registry 2026-08-08; `next` is 7.8.0-rc.0, i.e. older), whose
    `peerDependencies` are `eslint: ^3 || … || ^9.7` — no v10 range, and no v10-compatible release
    exists (tracked at jsx-eslint/eslint-plugin-react#3977). CI runs `npm ci`, which is strict about
    peers, so this fails the build rather than warning. Forcing it with an override is a bad trade:
    ESLint 10 **removed the deprecated `context.getScope()`/`SourceCode` methods** that plugin still
    reaches for, so the failure would move from install time to lint time.
  - **The other three plugins are already fine**, so the blocker is genuinely singular:
    `eslint-plugin-react-hooks` 7.1.1 and `eslint-plugin-react-refresh` 0.5.2/0.5.3 both list `^10`.
    (We are on react-hooks **5.2.0**; 5.x predates v10 support, so that one still needs a bump —
    note v7 folds the React Compiler rules into `recommended`, which will surface a wave of new
    findings and is worth doing as its own commit, not bundled into the ESLint 10 jump.)
  - **Also required when it unblocks:** `@eslint/js` 10 changes the `eslint:recommended` ruleset
    (expect new errors from `...js.configs.recommended.rules` in `eslint.config.js`), and ESLint 10
    requires Node `^20.19 || ^22.13 || >=24` — `.github/workflows/ci.yml` pins `node-version: 20`,
    which resolves to a 20.x new enough to pass, but bumping it to 22 first removes the sharp edge.
  - **Expiry condition:** `eslint-plugin-react` publishes a release with `^10` in its peer range.
    Dependabot will then raise the PRs again on its own (the ignore is scoped to *this* major, not
    to the dependency). Do not un-ignore, do not override, do not force it with a `resolutions`
    entry before then.
  - **The escape hatch, if ESLint 10 ever becomes urgent:** drop `eslint-plugin-react` entirely.
    `eslint.config.js` pulls in `react.configs.recommended` + `jsx-runtime` but immediately turns
    off the two rules that actually fire on this codebase (`react/prop-types`,
    `react/jsx-no-target-blank`), and `jsx-runtime` only exists to silence `react-in-jsx-scope` —
    which is moot once the plugin is gone. `react-hooks` (the rules that catch real bugs here) and
    `react-refresh` both already support v10. That is a real behaviour change to lint coverage, so
    it belongs in its own commit with a full `npm run lint` diff, not bundled into a version bump.

- **Exported audio is quieter (unconfirmed).** The offline mixdown (`ExportModal.renderTimelineAudio`)
  is unity-gain and no attenuation was found in code. Needs an A/B (exported MP4 audio vs the source
  file, same player/volume) to localize — AAC encode vs mixdown vs environment.

- **Playwright step in CI (stretch).** CI now runs lint + build (`.github/workflows/ci.yml`); a
  headless-Chrome (Playwright) step that compiles every shader in a real WebGL2 context would turn
  the static smoke check into full GLSL validation, and an interaction test (marquee → menu →
  compound) would cover the selection UX.
- **Measure real card heights.** `estimateNodeHeight` is now the single shared estimate, but
  expanded compounds / image nodes deviate from it — a DOM-measured height map (ResizeObserver on
  cards) would make marquee/fit/insert/minimap exact.
- **Apply `@showif` to the shaders that predate it.** The directive exists now (see its section
  above) and `ARRAY` uses it, but no older shader declares one — so `SHAPE_INPUT` still shows
  `Sides / Points` on a Rectangle and `Inner Ratio` on a non-Star, `LETTERBOX` shows `Custom Ratio`
  alongside the Aspect preset that overrides it, and `TRANSFORM` shows nothing conditional at all.
  Each is a one-line comment above the uniform; the win is largest on `SHAPE_INPUT`, whose 20
  controls are mostly inert for any given shape.
- **Live output readout for float source nodes.** `data-node-param-display` only updates *input*
  params, so a RAMP/LFO/MATH/ENVELOPE card can't show what it's currently outputting. Exposing the
  resolved `floatValues` (not just the per-consumer overrides) would let each card display its own
  value — useful when tuning an LFO against the music, and it would make RAMP's new `progress`
  output visible while authoring.
