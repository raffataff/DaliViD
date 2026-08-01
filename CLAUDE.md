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

## Recently completed

- **Transition in from / out to NOTHING (fade handles as the transition window)** — a transition
  used to require an overlap with another clip, so there was no way to open on a blend-in or end on
  a blend-out. Now the **fade handles double as the transition window**:
  - **`clip.transitionOut`** is a new field, same `{ type, params }` shape as `clip.transition`, so
    a clip can blend in one way and out another. Both are serialized; a project saved before this
    loads with `transitionOut: null` (explicit default ahead of the spread in `deserializeProject`).
    `splitClip` sends `transition` with the left half and `transitionOut` with the right — each
    follows the fade handle that times it.
  - **Precedence (deliberate, keeps old projects pixel-identical):** an overlap with the previous
    clip still wins and defines the transition-in window; only with **no overlap** does it fall back
    to `fadeIn`, with `u_from` = the accumulator (lower tracks, or transparent = nothing).
    Transition-out always uses `fadeOut`, with `u_to` = the bare accumulator.
  - **Transition-out costs one extra pass** and a lazily-created `__compositor_scratch` FBO: the
    clip is first composited over the accumulator into scratch (the "before" frame), then the
    transition dissolves FROM scratch TO the bare accumulator. At `progress 0` that is
    pixel-identical to the plain composite, so the hand-off is seamless. Doing it in one pass isn't
    possible — the shader needs both "with clip" and "without clip" as textures.
  - **`_compositeNodeTransition` gained `transition` / `direction` / `backdropFBOId` params.**
    `backdropFBOId` is separate from `fromFBOId` precisely because of the out case: FROM is scratch
    but the result must composite over the *bare* accumulator, otherwise the outgoing clip stays
    visible wherever the sub-graph's output is transparent. `direction` namespaces inner FBOs
    (`tr~<clipId>~in~` / `~out~`) so one clip can use the same library compound at both ends;
    `releaseClipResources` still frees both via the `tr~<clipId>~` prefix match.
  - **The opacity ramp is dropped when a transition owns a handle** (`inOwnsFadeIn` /
    `outOwnsFadeOut`) — otherwise the reveal and the ramp compound into a visible double-fade.
    Dropping the whole term is exact, not an approximation: outside the window the ramp is 1.0, and
    inside it a transition always runs. When both windows collide (fadeIn + fadeOut > clip length)
    the nearer end owns the frame (`elapsed <= remaining`), so neither end is ever left uncovered.
  - A transition-out is **suppressed when a later overlapping clip runs its own transition-in** —
    that window is already spoken for and two transitions over the same frames read as a bug.
  - **Audio needs no new code**: handle-timed transitions ride the existing `fadeIn`/`fadeOut` audio
    ramps in `_clipAudioGain` (and the export's matching value curves). Only overlap-timed
    transitions still apply the extra crossfade.
  - **Fixed a pre-existing alpha bug this feature exposed.** `applyBlendMode` accumulates in
    **premultiplied** alpha (`composited = src * a + base.rgb * (1 - a)`, `outA = a` — which is why
    the recursive base term isn't scaled by `base.a`), but the canvas is created
    `premultipliedAlpha: false`, so the browser multiplied by alpha a *second* time on the way to
    the page. Opaque frames (a == 1) agree under both conventions, which is why it never showed —
    it only bites on partial alpha, i.e. exactly a clip fading to/from nothing, where a linear 50%
    dissolve landed at 25% brightness. New **`PRESENT_FS`** (`this.presentProgram`) undoes the
    premultiply once in `_blitToScreen`. Kept separate from `PASSTHROUGH_FS` because that shader
    also does FBO→FBO copies, where the premultiplied chain must be preserved; opaque pixels divide
    by 1.0 and are bit-identical. See the backlog for the three screen exits this does NOT cover.
  - UI: Inspector gains a **Transition Out** section; both are now one shared `ClipTransitionEditor`
    (the built-in-vs-compound branching was too fiddly to copy). Each carries a live hint naming
    what times it, or why it won't play; the Fade sliders relabel to "Fade In → Transition" when a
    transition owns them. Transitions now show for **generator clips too** (text/image/shape — a
    title dissolving in from nothing is the main use), gated by `clipSupportsTransform`. The
    timeline ⇄ badge is per-end (left/right) and its tooltip names the transition.

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
- **Extend `showIf` to shader `@param`s.** The mechanism exists and is honoured by NodeCard /
  Inspector / `estimateNodeHeight`, but only `dataNodeParams` entries declare it — `paramParser`
  has no `@param` syntax for a condition, so SHAPE still shows `sides` on a Rectangle and
  `inner ratio` on a non-Star. A `@showIf u_shp_type == Polygon,Star` directive parsed into the
  same `{ param, equals }` shape would reuse `isParamVisible` verbatim.
- **Live output readout for float source nodes.** `data-node-param-display` only updates *input*
  params, so a RAMP/LFO/MATH/ENVELOPE card can't show what it's currently outputting. Exposing the
  resolved `floatValues` (not just the per-consumer overrides) would let each card display its own
  value — useful when tuning an LFO against the music, and it would make RAMP's new `progress`
  output visible while authoring.
