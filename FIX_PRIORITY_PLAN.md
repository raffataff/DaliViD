# DaliViD — Fix Priority Plan

A ranked list of fixes from the code review, ordered by impact-to-effort. Each entry states the problem and the intended solution.

**Status:** P0, P1, and P2 all implemented (not yet build-verified — the build sandbox was unavailable during the work). The graph-executor rewrite (P2-8) ships behind a one-line `USE_DAG` flag in `clipGraphManager.js` for instant revert.

---

## P0 — Do first (high impact, low risk)

### 1. Unify the custom-shader "source of truth"
**Problem.** The same shader is stored in two fields (`shaderCode` and `customShaderSource`) that are read inconsistently in three places:
- Compiler (`clipGraphManager.js`) reads `customShaderSource || shaderCode || registry`
- Inspector param parsing (`Inspector.jsx`) reads `shaderCode || registry` — ignores `customShaderSource`
- Monaco editor (`MonacoDrawer.jsx`) reads `customShaderSource || BOILERPLATE` — ignores `shaderCode` and the registry

So opening the editor on a fresh CUSTOM node shows generic boilerplate instead of the shader it runs, and after editing, the Inspector keeps parsing params from the stale template — new `@param` uniforms get no control and stay at 0, making the effect look broken.

**Solution.** Add a single `getNodeSource(node)` helper (`customShaderSource ?? shaderCode ?? registry`) and use it in the compiler, the Inspector, and Monaco's initial load. On save, parse the new source and merge any newly-introduced param defaults into `node.params` so fresh uniforms aren't left unset.

### 2. Convert hex color params to vec3 before upload
**Problem.** Color params are stored as hex strings (`"#00ff00"`), but `uploadUniforms` feeds a string into `gl.uniform3f`, producing `NaN`. Every effect with a `type=color` param (Chroma Key, Vignette, custom color nodes) gets a broken color.

**Solution.** Normalize params in `executeChain`/`executeSubChain`: any string starting with `#` is converted via the existing `hexToVec3` before reaching the GPU.

### 3. Stop the preview flashing
**Problem.** Two causes:
- The canvas backing-store size is written by **both** React (`width`/`height` JSX attributes) and `Renderer.setResolution()`. Setting a canvas's `width`/`height` clears its drawing buffer, so every re-render (including every zoom/pan) blanks the canvas for a frame — a visible flash with `preserveDrawingBuffer: true`.
- `start()` never clears the pending `setTimeout` from the paused poll loop, so a poll frame and a RAF frame can briefly render in the same tick (tear/flash on play).

**Solution.** Make the Renderer the sole owner of the backing-store size (remove `width`/`height` from JSX; CSS already scales the canvas via `100%` + `object-fit: contain`). Clear any stray RAF/timeout in both `start()` and `pause()` so only one loop ever runs.

---

## P1 — Next (meaningful, slightly larger)

### 4. Preview renders at panel resolution, not project resolution
**Problem.** `setResolution` is called with the fit-to-container display size, so FBOs and `u_resolution` use e.g. 640×360 while the badge shows 1920×1080. Resolution-dependent shaders look different in preview vs. export, and resizing the panel changes the look.

**Solution.** Render at the project resolution into the FBO chain and let CSS scale the canvas down for display, or explicitly decouple "render resolution" from "display size" with a quality setting.

### 5. Recompile only on topology/source change
**Problem.** Every param tweak changes the graph object reference, which calls `markDirty()` and recompiles all chains the next frame. Params are uniforms, not compile-time — this is wasted work each slider drag.

**Solution.** Only `markDirty()` when node/edge structure or shader source changes, not on `setNodeParam`.

### 6. Clear the program cache on dispose; bound its size
**Problem.** The shader-program cache is module-global, never evicted, and not cleared on `dispose()`. Across context recreation (Strict Mode/HMR), cached programs belong to a dead GL context. Live-editing also grows it unboundedly.

**Solution.** Call `clearProgramCache()` in `dispose()` and add an LRU bound.

---

## P2 — Later (larger or lower-frequency)

### 7. Release per-clip GPU resources on clip removal
**Problem.** `clip_input_*`, `clip_output_*`, ping-pong and feedback FBOs/textures are created on demand but never destroyed when a clip is removed — long sessions leak GPU memory.

**Solution.** Track and dispose FBOs/textures tied to a clip when the clip leaves the timeline.

### 8. Make the executor a real graph, not a linear chain
**Problem.** `executeChain` pipes nodes in topological order, ignoring which output socket feeds which input. Node wiring only affects membership/order; multi-input effects (e.g. Displacement's `u_disp_map`) can't be fed, and parallel branches collapse.

**Solution.** Evaluate inputs per-edge, allocate an FBO per output socket, and bind each node's declared inputs. Larger architectural change — scope separately.

### 9. Minor correctness/portability cleanups
- Double assignment of `this.lastFrameTime = now` in `_renderFrame` (skews playhead `dt`).
- Dynamic `int rad = int(u_radius)` loop bounds in Bloom/Blur — portability/perf risk; clamp to a constant max.
- `MonacoDrawer` reads `node.label` for the title but nodes store `name`.
