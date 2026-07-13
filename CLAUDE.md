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
- `src/components/NodeEditor/*` — node UI (`NodeCanvas`, `NodeCard`, `Socket`, `Noodle`,
  `NodeSearchMenu`, `MonacoDrawer`). `MediaPool`, `Inspector`, `Preview`, `Timeline`, `Toolbar` elsewhere.

## Key conventions (non-obvious — read before editing the pipeline)

- **Source nodes** (`VIDEO_INPUT`, `CAMERA_INPUT`, `IMAGE_INPUT`) are flagged `isSource` in the
  compiled chain and produce a texture FBO that `resolveProducer` routes downstream — they do
  **not** run an effect shader pass. (`VIDEO`/`CAMERA` pass the composited timeline frame;
  `IMAGE` renders its own image — see below.)
- **Two-tier audio model:**
  - Always-live (uploaded by `uploadStandardUniforms`): `u_audio_bands[8]`, `u_audio_rms`, `u_beat`.
  - **Gated** drivers: `u_bass`, `u_mid`, `u_treble`, `u_sub_bass`, `u_low_mid`, `u_high_mid`,
    `u_presence`, `u_rms` are `0.0` unless the `AUDIO_SPLITTER`'s matching band output is wired
    into a node's `audio_drivers` socket. They're auto-declared into effect shaders via
    `injectAudioDrivers`, so shaders use them with no `uniform` line.
- `NON_EFFECT_TYPES` in `Renderer.js` gates whether a graph "has effects". `IMAGE_INPUT` is
  deliberately **not** in it, so an image-only master graph still renders.
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

## Code style

- Match existing style: ES modules, hooks, concise comments explaining *why*.
- When editing a function, provide the full function.
- No new deps without reason; keep single-file artifacts/components consistent with the repo.

## Recently completed

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

## Backlog / potential improvements

Ideas surfaced but not yet built (roughly by value-to-effort).

- **Exported audio is quieter (unconfirmed).** The offline mixdown (`ExportModal.renderTimelineAudio`)
  is unity-gain and no attenuation was found in code. Needs an A/B (exported MP4 audio vs the source
  file, same player/volume) to localize — AAC encode vs mixdown vs environment.

- **Run the smoke test in CI.** A GitHub Actions job running `npm run lint` + `npm run build` on
  push would make the smoke test actually catch regressions (in-session builds are unreliable).
  Stretch: a headless-Chrome (Playwright) step that truly compiles every shader in a real WebGL2
  context, turning the static check into full GLSL validation.
- **Keyframe animation is not wired to the renderer.** `useTimelineStore` holds `keyframes` and the
  serializer saves them, but nothing evaluates them at the playhead — the executor reads live params
  + audio bindings only, so animated params never take effect. Needs a per-frame pass that
  interpolates each keyframed param (with easing) and overrides the node's value before execution.
