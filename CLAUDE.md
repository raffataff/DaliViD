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

> Note: the Cowork Linux sandbox has been failing to start, so builds/lint often can't be run
> in-session — verify with `npm run dev` locally.

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

## Recently completed

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

- **Timeline clip right-click menu + clip reverse** — right-clicking a timeline clip opens the
  shared `common/ContextMenu` (the same portal menu the Media Pool uses) with the full clip action
  set: Reverse Clip, Reset Speed to 1×, Split at Playhead, Duplicate, Open Effects Graph, Mute Clip
  Audio, Clear Fades, Remove Transition, Set In/Out to Clip, Playhead to Clip Start, Delete and
  Ripple Delete. Items are built from *live* clip state each render, so `keepOpen` toggles (Reverse,
  Mute) update their own ✓ in place.
  - **`clip.reversed` is a pure source-time remap**, not a re-encode: `getClipSourceTime` walks
    `sourceEnd → sourceStart` across the same timeline span, so trim / speed / fades / keyframes /
    transitions all keep working untouched. Serialized in `projectSerializer`.
  - **`splitClip` is reverse-aware** — a reversed clip cuts the other way round (left half keeps
    `sourceEnd` and takes the split as its new `sourceStart`). Getting this wrong silently swaps
    the two halves' content, which is why it's explicit in the store rather than at the call site.
  - **Playback is seek-driven.** No browser supports a negative `playbackRate`, so
    `Renderer._syncVideoPlayback` short-circuits for reversed clips: the element stays **paused**
    and `currentTime` walks backwards, and a new seek is **never queued while one is in flight**
    (the previous frame repeats instead, so the preview degrades to the decoder's seek rate rather
    than falling progressively behind the playhead).
  - **Audio: silent in preview, correct in export.** A paused element makes no sound, so reversed
    clips are silent live; `ExportModal.renderTimelineAudio` reverses the decoded `AudioBuffer`
    (cached per URL) and offsets from the tail (`offset = bufDuration - forwardSourceTime`), so the
    rendered file has properly reversed audio. Stem analysis reuses `renderTimelineAudio`, so
    export reactivity follows the reversal too. The Inspector toggle and the clip's `◀` badge both
    spell this out.
  - **Mid-seek frames are never sampled (this is what made reverse render BLACK).** Three coupled
    rules in `_renderClipToFBO` / `_syncVideoPlayback`, all load-bearing:
    1. The texture upload runs only when `!videoEl.seeking` — mid-seek, `currentTime` already
       reports the target while the decoder still holds the old frame, so an upload gets a stale
       or (on a paused element) blank picture. Holding the previous texture is correct AND is what
       the eye expects. Only the bootstrap upload (no texture yet) is allowed mid-seek, and it
       doesn't stamp `_lastUploadedTime`, so it is redone once the decoder catches up.
    2. A reversed clip issues its next seek **only once the previous frame has been uploaded**
       (`_lastUploadedTime === currentTime`). `_syncVideoPlayback` runs BEFORE the upload, so
       seeking unconditionally left `seeking` true at upload time forever and the clip never
       received a decoded frame at all. The handshake makes reverse alternate seek-frame /
       upload-frame — self-throttling, with the decoder setting the pace.
    3. A reversed clip never seeks to exactly `duration` (clamped to `duration - 0.04`): that
       lands the element in `ended` with no frame to present. A reversed clip's first frame is
       `sourceEnd` — usually the duration exactly — so every reversed clip started on black.
    Rule 1 also fixes a **pre-existing** staleness bug in ordinary paused scrubbing.
  - Supporting bits: `useTimelineStore.duplicateClip` / `rippleDeleteClip` (per-track ripple —
    a global one would desync other tracks); `ContextMenu` gained `shortcut` (right-aligned key
    hint) and `checked` (✓ + tinted row); right/middle mousedown on a clip, trim handle or fade
    handle now **selects without arming a drag**, so the menu can't open over a sliding clip;
    `ClipWaveform` mirrors its peaks for reversed clips; the menu **snapshots the playhead** on
    open instead of subscribing to it (subscribing would re-render the Timeline 60×/s).

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
- **TIME node (LFO / ramp — the keyframe replacement)** — shaderless CPU float source, peer to
  MATH/ENVELOPE, evaluated in `resolveFloatConnections`. Two outputs: `value` (wave shaped and
  remapped into Min…Max) and `seconds` (raw source time, for MATH). 4 sources × 9 waves:
  - **Sources** — `Playhead` (default), `Clip Time`, `Clip Progress`, `Free Run`. The first three are
    **deterministic** (functions of timeline position), so scrubbing shows the real animation and an
    export is identical to the preview; `Free Run` is the render clock (keeps moving while paused).
    **`Clip Progress` + `Saw Up` + rate 1 == a keyframe pair across the clip** (Min at the first
    frame → Max at the last) that follows the clip when it's moved, trimmed or retimed.
  - **Waves** — Sine (cosine form, so it starts at Min and rises), Triangle, Saw Up/Down, Square
    (duty = Pulse Width), Bounce, Random Hold, Smooth Random, Linear (unbounded — continuous
    rotation). Optional `Smooth` S-curve; `Beat Sync` makes a cycle N beats of the project BPM
    (`useAppStore.bpm`/`beatOffset`). Random waves hash the cycle index, so they're frame-stable.
  - `hasParamInputs: true` → every control gets a float socket, so a band/ENVELOPE can modulate the
    LFO itself (bass → rate). Clip-local time reaches the evaluator via `standardState.clipTime`/
    `clipDuration`, stamped per exec site by `Renderer._setClipTimeContext` (like `hasSource`) and
    cleared (`null`) for the master pass. Float overrides already reach the image/text/shape
    pre-passes, so a TIME node animates a shape's position/rotation with no keys.
  - `resolveFloatConnections` now resolves MATH/ENVELOPE/**TIME** as one dependency-ordered fixpoint
    (`DEFERRED_FLOAT_TYPES` + `producerPending`), which also fixes MATH → MATH reading a
    one-frame-stale value when the nodes sat in an unlucky order in the graph array.
  - **`src/shaders/dataNodeParams.js` is new and is now the single source of truth for the
    shaderless nodes' param configs** (MATH / ENVELOPE / TRANSITION_PROGRESS / TIME). The same three
    lists were previously hardcoded in `NodeCanvas`, `Inspector` and `compoundUtils` and had already
    drifted; all three read the table now, so these nodes also gained Inspector controls (with
    keyframe diamonds) and compound param exposure for free.
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
- **Conditional param visibility.** The @param/dataNodeParams UI has no "show this control only
  when …", so TIME shows Beats/Cycle with Beat Sync off and Pulse Width on non-square waves (SHAPE
  has the same issue with sides / inner ratio). A `showIf: { param, equals }` field honoured by the
  three renderers would clean up the tall cards.
- **Live output readout for float source nodes.** `data-node-param-display` only updates *input*
  params, so a TIME/MATH/ENVELOPE card can't show what it's currently outputting. Exposing the
  resolved `floatValues` (not just the per-consumer overrides) would let each card display its own
  value — useful when tuning an LFO against the music.
