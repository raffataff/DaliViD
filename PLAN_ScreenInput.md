# PLAN — Screen Input (live capture node/clip + recorder)

Status: **specified, not implemented.** This document is a complete implementation spec —
every file, function, and line-level touch point has been verified against the current
codebase. An implementing agent should not need to discover anything.

## 0. Decisions (agreed with Jonn)

| Question | Decision |
|---|---|
| Scope | **Both**: live screen source usable in the pipeline + record-to-file |
| Format | **WebM (VP9/Opus) default**; MP4 offered only when `MediaRecorder.isTypeSupported` says the browser can mux it natively (no WebCodecs live-encode path — see §6.2) |
| Audio | **Capture tab/system audio** when the browser provides it; route into the reactive engine like camera audio |
| Save location | **`showSaveFilePicker` at record START, pre-set to the project's `media/` folder**; fallback chain → project folder silently → anchor download (see §7) |

## 1. Architecture — screen is a live-stream clip, exactly like camera

The camera feature is the template. A camera is: a timeline clip with
`fileType: 'camera'` and **no `fileUrl`**, backed by a `MediaStream` held in
`src/gl/cameraRegistry.js` (keyed by clipId). `Renderer._renderClipToFBO` builds a
`<video srcObject=stream>` element, uploads frames to `clip_<id>` texture, runs the
per-clip effect graph, and the clip composites/blends/fades/transitions like any video.
GPU + stream cleanup on clip delete already works (Renderer.js:1096–1117).

**Screen capture = the same thing with `fileType: 'screen'` and
`getDisplayMedia` instead of `getUserMedia`.** This buys, for free: per-clip shader
chains, blend modes, opacity, fades, transitions, keyframes, multi-track compositing,
and resource cleanup. Renderer changes are ~3 lines.

Recording is **independent of the render pipeline**: we run a `MediaRecorder` on the
*source* stream (native resolution/fps, hardware-encoded by the browser's media stack),
so recording costs the WebGL loop nothing. Recording the *processed* output already
exists — that's Export.

Two deliverable tiers, both in scope:

- **Tier A — Screen clip** (§3–§5): MediaPool "Screen" tab → capture → live clip on the
  timeline. This is the core feature.
- **Tier B — `SCREEN_INPUT` graph node** (§8): a source node peer to `CAMERA_INPUT`
  (passes the composited timeline frame, mirror X/Y params). Trivial, keeps the node
  graph vocabulary complete.

## 2. New files

- `src/utils/screenRecorder.js` — capture + MediaRecorder + save-stream logic (§6, §7).
  No new npm deps. Everything else is edits to existing files.

## 3. Capture flow (MediaPool)

File: `src/components/MediaPool/MediaPool.jsx`

### 3.1 New tab

`TABS` (line 13): insert after `cameras`:

```js
{ id: 'screens', label: 'Screen' },
```

### 3.2 `handleCaptureScreen` (mirror `handleSelectCamera`, lines 292–338)

```js
import { addToast } from '../common/Toast'
import { startScreenCapture } from '../../utils/screenRecorder'

const handleCaptureScreen = useCallback(async () => {
  try {
    // quality: state from the tab's controls (see §5) — 720 | 1080 | 1440 | 0 (native)
    const stream = await startScreenCapture({ maxHeight: screenQuality, optimizeForText })

    const vt = stream.getVideoTracks()[0]
    const settings = vt?.getSettings?.() || {}
    const width = settings.width || 1920
    const height = settings.height || 1080
    const fps = settings.frameRate ? Math.round(settings.frameRate) : 30
    const label = vt?.label || 'Screen Capture'   // e.g. "Chrome Tab: Foo" / "Screen 1"

    let videoTrack = tracks.find(t => t.type === 'video')
    if (!videoTrack) videoTrack = { id: addTrack('video') }

    const duration = 60 // live source: default trimmable length, same as camera
    const clipId = addClip(videoTrack.id, {
      filename: label,
      fileType: 'screen',
      timelineStart: 0, timelineEnd: duration,
      sourceStart: 0, sourceEnd: duration,
      width, height, fps, duration,
    })

    setCameraStream(clipId, stream) // shared live-stream registry (see §3.4)
    initClipGraph(clipId, label)

    // Tab/system audio → reactive engine (same path the webcam mic uses).
    // Caveat: useExternalAudioStream takes over the mic input slot (activeSource='mic').
    if (stream.getAudioTracks().length > 0) {
      await getAudioEngine().useExternalAudioStream(stream)
    }

    // Browser "Stop sharing" chrome → clean up + finalize any active recording.
    vt.addEventListener('ended', () => {
      stopRecordingIfActive(clipId)      // §6.4 — flush & close, never lose footage
      removeCameraStream(clipId)         // import from '../../gl/cameraRegistry'
      addToast({ message: `Screen share "${label}" ended`, type: 'info' })
    })
  } catch (err) {
    if (err?.name !== 'NotAllowedError') console.error('Screen capture failed:', err)
    // NotAllowedError = user dismissed the picker — silent no-op.
  }
}, [tracks, addTrack, addClip, initClipGraph, screenQuality, optimizeForText])
```

### 3.3 `startScreenCapture` (in `src/utils/screenRecorder.js`)

```js
export async function startScreenCapture({ maxHeight = 1080, optimizeForText = false } = {}) {
  const video = { frameRate: { ideal: 60, max: 60 } }
  if (maxHeight > 0) { video.height = { ideal: maxHeight, max: maxHeight } }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chromium-only hints — silently ignored elsewhere:
    selfBrowserSurface: 'exclude',   // don't offer DaliViD's own tab (feedback loop)
    surfaceSwitching: 'include',     // allow switching the shared tab mid-session
    systemAudio: 'include',
  })
  const vt = stream.getVideoTracks()[0]
  // 'motion' = favor framerate (VJ default); 'detail' = favor sharpness (text/UI).
  if (vt) vt.contentHint = optimizeForText ? 'detail' : 'motion'
  return stream
}
```

Why the 1080p default cap: the per-frame cost of a live source is dominated by
`texImage2D` of the video element (`TextureManager.uploadVideoFrame`). A native 4K
display is ~33 MB/frame uploaded; capping at 1080p (browser downsamples in the capture
pipeline, before it ever reaches us) cuts that ~4×. "Native" stays available in the UI.

### 3.4 Stream registry — reuse `cameraRegistry.js`

`src/gl/cameraRegistry.js` is already a generic `clipId → MediaStream` map; screen
streams use it unchanged (`setCameraStream`/`getCameraStream`/`removeCameraStream`).
Only edit: update the module header comment to say "live stream (camera **or screen
capture**)". Do **not** rename the exports — 5 call sites, zero benefit.

## 4. Renderer + UI touch points for `fileType: 'screen'`

All verified against current code. Per repo convention, provide full functions when
editing them.

1. **`src/gl/Renderer.js` line 963–969** (inside `_renderFullPipeline`):

   ```js
   const isLive = clip.fileType === 'camera' || clip.fileType === 'screen'
   // Non-live clips must be a renderable video file (have a fileUrl).
   if (!isLive && (clip.fileType !== 'video' || !clip.fileUrl)) continue
   ...
   const clipResultFBOId = this._renderClipToFBO(track, clip, isLive, graphState, standardState, playheadTime)
   ```

2. **`src/gl/Renderer.js` `_renderClipToFBO` (line 778)**: rename the `isCamera`
   parameter to `isLiveStream` and update the doc comment. **Body unchanged** — the
   `getCameraStream(clip.id)` branch, the `videoEl._cameraStream` rebuild check, and
   the `muted = true` line all work identically for screen streams. Cleanup
   (lines 1096–1117) also needs no change: it keys off `videoEl._cameraStream`.

3. **`src/components/Timeline/Timeline.jsx` lines 279 and 717**: both
   `clip.fileType === 'video' || clip.fileType === 'camera'` checks →
   add `|| clip.fileType === 'screen'`. (279 gates track-drop compatibility,
   717 gates video-clip rendering/waveform branch.)

4. **`src/components/Inspector/Inspector.jsx` line 433**: same 3-way check for
   `isVideoClip` so screen clips get blend/opacity/fade/audio sections.

5. **`src/store/useTimelineStore.js` line 137**: update the comment to
   `'video' | 'audio' | 'camera' | 'screen'`.

6. **`src/utils/projectSerializer.js`**:
   - The persist loop (line 406–427) already skips screen clips (`!clip.fileUrl`
     → `continue`). No change.
   - `restoreMediaFilesFromFolder` (line 457): add at the top of the loop
     `if (clip.fileType === 'camera' || clip.fileType === 'screen') continue`
     — live-source clips are not files; today camera clips wrongly land in the
     "missing media" warning list. Fixes both.

7. **Reload behavior**: a saved screen clip deserializes with no stream →
   `_renderClipToFBO` returns null → clip is skipped in compositing (renders as
   nothing). The Screen tab lists these orphaned clips (clips with
   `fileType === 'screen'` and no `getCameraStream(clip.id)`) with a **Reconnect**
   button that re-runs `startScreenCapture` and `setCameraStream(clip.id, stream)`,
   preserving the clip's graph/keyframes/position. (Optionally do the same for
   cameras later — out of scope here.)

## 5. Screen tab UI

Layout mirrors the Cameras tab (MediaPool.jsx lines 457–480, `MediaPool.css` classes).

- **Capture button** — "🖥 Capture Screen / Window / Tab" → `handleCaptureScreen`.
- **Capture options row** (apply to the *next* capture):
  - Quality select: `720p / 1080p (default) / 1440p / Native` → `screenQuality`
    state (`0` = native).
  - Checkbox "Optimize for text" → `optimizeForText` (contentHint 'detail').
- **Active captures list** — derived from
  `clips.filter(c => c.fileType === 'screen' && getCameraStream(c.id))`. Each row:
  - label, `${width}×${height} @ ${fps}fps`, green **LIVE** dot.
  - **Record ● / Stop ■** toggle (§6). While recording: elapsed `mm:ss` +
    running size (`MB`), red pulsing dot. Timer via a 500 ms interval reading
    recorder state — do not re-render per chunk.
  - Format select `WebM / MP4` — MP4 option rendered disabled with title
    "Not supported by this browser" unless `mp4Supported()` (§6.2).
  - **End share** button → stops recording if active, `removeCameraStream(clip.id)`.
- **Orphaned clips list** (§4.7) with **Reconnect** buttons.
- Recording state must survive tab switches within MediaPool: keep the recorder
  instance map at **module level** in `screenRecorder.js` (`Map<clipId, RecorderHandle>`),
  not in component state — same pattern as the node-editor clipboard.

## 6. Recording — `src/utils/screenRecorder.js`

### 6.1 Principles

- Record the **source stream's tracks directly** (`new MediaStream([videoTrack,
  ...audioTracks])` using the *original* tracks — do not `.clone()`; stopping a
  MediaRecorder does not stop its tracks, so the live feed is unaffected).
  Native resolution/fps, hardware-accelerated encode, zero WebGL-loop cost.
- **Stream chunks to disk as they arrive** (§7) — memory stays flat no matter how
  long the recording runs; a 30-minute capture never materializes as one giant Blob.

### 6.2 Format/codec selection

```js
const MIME_LADDERS = {
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  mp4:  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'],
}
export function pickMimeType(format) {
  return (MIME_LADDERS[format] || MIME_LADDERS.webm)
    .find(m => MediaRecorder.isTypeSupported(m)) || ''
}
export function mp4Supported() { return !!pickMimeType('mp4') }
```

MP4 rides MediaRecorder's native muxing (Chromium ≥ 126). We deliberately do **not**
build a live WebCodecs→mp4-muxer path: it would duplicate ExportModal's offline
pipeline for marginal gain and add real-time encode pressure. If MP4 matters on a
browser without native support, the user records WebM and the existing MP4 export
covers conversion. Note this in the UI tooltip.

### 6.3 Recorder handle

```js
export function startRecording(clipId, stream, { format = 'webm', onError } = {}) {
  const vt = stream.getVideoTracks()[0]
  const s = vt?.getSettings?.() || {}
  const w = s.width || 1920, h = s.height || 1080, fps = s.frameRate || 30
  const mimeType = pickMimeType(format)
  const recorder = new MediaRecorder(
    new MediaStream([vt, ...stream.getAudioTracks()].filter(Boolean)),
    {
      mimeType,
      // ~0.08 bits/px/frame, clamped 6–30 Mbps — good VP9/H.264 screen quality.
      videoBitsPerSecond: Math.min(30e6, Math.max(6e6, Math.round(w * h * fps * 0.08))),
      audioBitsPerSecond: 192_000,
    }
  )
  const handle = {
    clipId, recorder, mimeType,
    ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm',
    startedAt: performance.now(), bytes: 0,
    sink: null,            // set by §7 before recorder.start
    memChunks: [],         // only used by the in-memory fallback sink
  }
  recorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) return
    handle.bytes += e.data.size
    try { await handle.sink.write(e.data) }
    catch (err) { onError?.(err) }      // e.g. disk full → §9
  }
  _active.set(clipId, handle)           // module-level Map<clipId, handle>
  return handle
}
// start AFTER the sink exists: handle.recorder.start(1000)  // 1s timeslices
```

`stopRecording(clipId)` → `recorder.stop()`, await `onstop`, `sink.close()`, compute
`durationSec = (performance.now() - startedAt) / 1000`, delete from `_active`, return
`{ file, url, durationSec, ext }` for import (§8). `stopRecordingIfActive(clipId)` is
the guard used by the track-`ended` handler and by End share.

### 6.4 Known WebM pitfall — duration is `Infinity`

Chrome's MediaRecorder writes WebM with no duration header. A recorded WebM imported
via a `<video>` element reports `duration = Infinity`, which would corrupt clip math.
**Never trust metadata duration for recordings** — the importer (§8) must use the
`durationSec` we measured. Additionally, when the generic `handleImportVideo` path
encounters `duration === Infinity` on any file, apply the standard seek trick before
reading duration:

```js
if (video.duration === Infinity) {
  video.currentTime = Number.MAX_SAFE_INTEGER
  await new Promise(r => { video.ontimeupdate = () => { video.ontimeupdate = null; r() } })
  video.currentTime = 0
}
```

## 7. Save-location flow (picker at record start, streaming write)

`showSaveFilePicker` requires **transient user activation**, which is consumed/expired
by the time `MediaRecorder.onstop` fires. Therefore the picker opens in the **Record
button's click handler, before `recorder.start()`** — this is also what enables
streaming chunks straight to disk. Sequence in the Record click handler:

```js
const name = `screen_${tsStamp()}.${ext}`   // tsStamp → YYYYMMDD_HHMMSS
const sink = await openRecordingSink(name, ext, projectFolderHandle, handle)
handle.sink = sink
handle.recorder.start(1000)
```

`openRecordingSink` fallback chain (all paths return `{ write(blob), close() → File }`):

1. **Picker (primary)** — if `window.showSaveFilePicker` exists:
   ```js
   const startIn = projectFolderHandle
     ? await projectFolderHandle.getDirectoryHandle('media', { create: true })
     : 'videos'
   const fh = await showSaveFilePicker({
     suggestedName: name, startIn,
     types: [{ description: 'Video', accept: ext === 'mp4'
       ? { 'video/mp4': ['.mp4'] } : { 'video/webm': ['.webm'] } }],
   })
   const writable = await fh.createWritable()
   // write(blob) → writable.write(blob)  (sequential writes append)
   // close() → await writable.close(); return await fh.getFile()
   ```
   The dialog opens pre-set inside the project's `media/` folder — saving there means
   `restoreMediaFilesFromFolder` finds the file by name on future project loads, so
   the recording is a first-class, reload-safe project asset. Saving elsewhere still
   works (the session import in §8 uses the returned File either way).
2. **User cancels picker (`AbortError`) or no picker API** — if `projectFolderHandle`
   is set: create `media/<name>` via `getDirectoryHandle('media', { create: true })`
   → `getFileHandle(name, { create: true })` → `createWritable()`; toast
   "Recording will be saved to the project's media folder". (Directory-handle writes
   need no user activation — permission was granted when the folder was linked.)
3. **Neither** (e.g. Firefox, no project folder) — in-memory sink: push chunks to
   `handle.memChunks`; `close()` assembles `new File([new Blob(memChunks, {type: mimeType})], name)`
   and triggers an anchor download (pattern identical to ExportModal.jsx lines 824–831).
   Toast a size warning when a recording passes ~2 GB in this mode.

If the user cancels the picker in step 1 **and** there is no project folder, fall to
step 3 — recording still proceeds; footage is never blocked on a dialog.

## 8. Auto-import into the Media Pool

On `stopRecording` resolve, from the Screen tab (which owns `setImportedVideos`):

```js
const { file, durationSec } = await stopRecording(clipId)
const url = URL.createObjectURL(file)
setImportedVideos(prev => [...prev.filter(v => v.filename !== file.name), {
  id: `media_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
  filename: file.name, fileUrl: url, fileType: 'video',
  width, height, fps,                    // from the capture track settings
  duration: durationSec,                 // measured — never video metadata (§6.4)
  size: file.size, file,
}])
addToast({ message: `Recording saved: ${file.name}`, type: 'success' })
```

The entry appears in the Videos tab and drags to the timeline like any import. If the
file was saved outside the project folder AND `projectFolderHandle` exists, also
`copyFileToProjectFolder(projectFolderHandle, file, 'media')` (same as
`handleImportVideo`, line 89) so the project stays self-contained.

## 9. `SCREEN_INPUT` graph node (Tier B)

Semantics identical to `CAMERA_INPUT`: a source node that passes the composited
timeline frame (CLAUDE.md "Key conventions"), with mirror params. Touch points:

1. **`src/shaders/shaderRegistry.js`** — after the CAMERA_INPUT block (line 898),
   register `'SCREEN_INPUT'` with the **exact same GLSL** as CAMERA_INPUT
   (passthrough + `u_mirror_x`/`u_mirror_y` @params). Comment:
   `// ── Screen Input (passthrough — composited frame, like camera) ──`
2. **`src/shaders/nodeDefinitions.js`** — copy the `CAMERA_INPUT` def (lines 47–54)
   as `SCREEN_INPUT` (texture `output` + `audio_out`, `hasParamInputs: true`).
3. **`src/gl/Renderer.js` line 22** — add `'SCREEN_INPUT'` to `NON_EFFECT_TYPES`.
4. **`src/gl/clipGraphManager.js` line 167** — add `'SCREEN_INPUT'` to the source-type
   array so `compileGraph` marks it `isSource`.
5. **`src/components/NodeEditor/NodeSearchMenu.jsx`** — I/O category (line 8–12):
   `{ type: 'SCREEN_INPUT', name: 'Screen Input', sourceOnly: true }`.
6. **`src/components/NodeEditor/NodeCard.jsx`** — `NODE_COLORS` (line 9):
   `'SCREEN_INPUT': '#44aaff'` (same blue as camera).
7. **`src/components/NodeEditor/NodeCanvas.jsx`** — add `'SCREEN_INPUT'` to
   `EXCLUDED_FROM_MARQUEE` (line 21).

The smoke test (`npm run smoke:shaders`) validates the new registry entry
automatically — no test changes needed.

*Not in scope*: a per-node live screen pre-pass (IMAGE_INPUT-style `__img_` FBO fed by
a nodeId-keyed stream). Only worth building if someone needs a screen feed inside a
compound independent of the timeline; the clip path covers every stated use case.

## 10. Performance summary (why this design is the fast one)

- **Capture → texture** reuses the existing camera hot path; the only new per-frame
  cost is the video-frame upload, capped by the 1080p default (§3.3).
- **Recording bypasses the pipeline entirely** — browser-native (usually hardware)
  encoder on the raw stream; no canvas capture, no readbacks, no extra render pass.
- **Streaming disk writes** keep memory flat for arbitrarily long recordings.
- `contentHint` tunes the encoder + capture pipeline per use case.
- No new dependencies, no new render-loop branches when no screen clip is live
  (`getCameraStream` miss → early null, already the camera behavior).

## 11. Edge cases (all must be handled)

- **Picker dismissed at capture** → `NotAllowedError`, silent no-op (§3.2).
- **"Stop sharing" browser chrome** → track `ended` → finalize recording, unregister
  stream, toast (§3.2). Last uploaded frame stays in `clip_<id>` texture, so the clip
  freezes rather than flashing black — acceptable, matches camera unplug behavior.
- **Recording when share ends** → `stopRecordingIfActive` runs BEFORE
  `removeCameraStream`; MediaRecorder flushes a final chunk on stop, sink closes,
  import proceeds. Footage is never lost.
- **Project reload** → orphaned screen clip renders nothing; Reconnect flow (§4.7).
- **Sink write error (disk full)** → `onError`: stop recorder, close what's written,
  toast the error; if the sink was a picker/project file, the partial file remains
  (WebM is playable up to the last cluster).
- **Sharing DaliViD's own tab** → `selfBrowserSurface: 'exclude'` prevents offering it
  (feedback loop). A user can still pick the whole screen containing DaliViD — allowed,
  classic video-feedback as a feature.
- **Minimized shared window** → some platforms throttle or freeze capture frames;
  nothing to do, but worth a line in README/tooltip.
- **Multiple simultaneous captures** → fully supported: registry, recorder map, and
  video elements are all per-clip.
- **`getDisplayMedia` requires secure context** → localhost dev + any HTTPS deploy are
  fine; no action.
- **Export parity** → screen clips behave like camera clips during export: live streams
  can't be replayed offline, so an export containing a live screen clip records
  whatever was last uploaded (WebM real-time path captures it live; MP4 offline path
  gets frozen frames). Not a regression — identical to cameras today. The recommended
  workflow (record → import the file → replace the live clip) sidesteps it; put that
  one line in the Screen tab's hint text.

## 12. Implementation order + verification

1. §9 node type (isolated, 7 small edits) → `npm run lint` (includes shader smoke test).
2. §3–§4 live screen clip → manual: capture a tab, verify it composites, takes per-clip
   effects, blends over/under other tracks, fades, and that End share / clip delete
   free the stream (check `chrome://webrtc-internals` for released tracks).
3. §6–§8 recorder + save + import → manual matrix:
   - WebM + picker save into project `media/` → reload project → clip restores.
   - Picker cancelled with project folder linked → file appears in `media/`.
   - No project folder + no picker (Firefox) → anchor download; duration correct
     (finite, matches wall clock) after import.
   - MP4 option state matches `mp4Supported()` per browser.
   - Record 5+ min; confirm flat memory in DevTools performance monitor.
4. Full `npm run lint` + `npm run build` locally (Cowork sandbox can't run them).

## 13. Explicit non-goals

- Recording the processed/composited output (ExportModal owns that).
- WebCodecs live MP4 encode; Firefox MP4 recording.
- Camera-clip Reconnect UI (same pattern, separate task).
- Per-node live screen pre-pass inside compounds (§9 note).
