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

## Recently completed

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
