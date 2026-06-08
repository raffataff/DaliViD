# GLSL VIDEO FORGE — COMPLETE MASTER BUILD PROMPT
### Final Unified Specification v3.0
### Sections I–XXVI | All gaps patched | Nothing omitted

---

```
You are building a professional, browser-based video editing and real-time GLSL shader
processing application called "GLSL Video Forge". This is a flagship creative tool
combining the workflow of DaVinci Resolve with a node-based shader graph, audio-reactive
processing, live camera input, compound reusable effects, per-clip independent shader
chains, and a live WebGL rendering pipeline. Every detail below is a hard requirement.
No section may be stubbed, skipped, or left as a placeholder.

═══════════════════════════════════════════════════════════════
I. TECHNOLOGY STACK
═══════════════════════════════════════════════════════════════

- Framework: React 18+ with hooks (no class components)
- Rendering: WebGL2 via raw WebGL API (no Three.js — direct shader compilation)
- Audio: Web Audio API with AnalyserNode for real-time FFT
- State: Zustand for global app state
- Node Editor: Custom-built (no libraries), canvas or SVG-based connections
- Code Editor: Monaco Editor (same engine as VS Code) embedded per shader node,
  loaded lazily on first use
- Styling: CSS Modules or Tailwind — dark professional theme, no light mode
- Video decoding: HTML5 <video> element piped into a WebGL texture via
  texImage2D / texSubImage2D each frame
- Camera input: navigator.mediaDevices.getUserMedia piped into a hidden
  <video> element and uploaded to WebGL texture identically to video files
- File handling: File API + URL.createObjectURL for video/audio upload
- Persistence: IndexedDB for autosave and project storage; localStorage for
  UI preferences (panel sizes, collapsed states)
- Build: Vite
- Minimum supported viewport: 1280×768px. Below this, show a warning overlay.
  The app does not reflow for mobile — it is a desktop-first tool.

═══════════════════════════════════════════════════════════════
II. OVERALL LAYOUT — DAVINCI RESOLVE INSPIRED
═══════════════════════════════════════════════════════════════

The UI is divided into FIVE docked panels, each resizable via drag handles:

┌─────────────────────────────────────────────────────────────┐
│  TOP TOOLBAR — global controls, file import, export, zoom   │
├──────────────┬──────────────────────────┬───────────────────┤
│  MEDIA POOL  │   PREVIEW CANVAS (WebGL) │   INSPECTOR PANEL │
│  (left ~18%) │        (center ~50%)     │   (right ~32%)    │
├──────────────┴──────────────────────────┴───────────────────┤
│         NODE EDITOR (collapsible, resizable ~38% height)    │
├─────────────────────────────────────────────────────────────┤
│              TIMELINE (bottom ~22% height)                  │
└─────────────────────────────────────────────────────────────┘

PANEL RESIZE RULES:
- All panel borders are drag-resizable via 4px invisible hit-area handles
- Minimum panel sizes:
    Media Pool:     180px wide minimum
    Preview Canvas: 320px wide, 240px tall minimum
    Inspector:      220px wide minimum
    Node Editor:    full width, 120px tall minimum
    Timeline:       full width, 80px tall minimum
- Each panel has a collapse/expand arrow button in its header
- The NODE EDITOR expands upward when its header is double-clicked,
  covering the timeline with a smooth animated transition
- All collapse/expand and resize transitions use
  cubic-bezier(0.4, 0, 0.2, 1) at 200ms
- Panel sizes and collapsed states are persisted to localStorage and
  restored on next session load

VISUAL THEME:
- Background: #0d0d0f (near-black with blue undertone)
- Panel surfaces: #141418 (primary), #1a1a20 (elevated)
- Borders: 1px solid #2a2a35
- Accent primary: Electric cyan #00e5ff
- Accent secondary: Magenta #ff00aa
- Accent tertiary: Amber #ffaa00
- Text primary: #e8e8f0 | Text muted: #888899
- Font UI: 'DM Sans' (Google Fonts) | Font code: 'JetBrains Mono' (Google Fonts)
- Buttons: subtle gradient fills, 4px border radius, hover: brightness 1.15
- All icons: custom SVG — no emoji, no icon library
- Scrollbars: 2px thumb, #333 track, #555 thumb on hover
- Node graph background: dot-grid pattern (#1e1e26 dots on #0a0a0e base),
  dots 20px apart, 1px diameter

═══════════════════════════════════════════════════════════════
III. TOP TOOLBAR
═══════════════════════════════════════════════════════════════

Left section:
- App logo "GLSL VIDEO FORGE" — monospace caps, subtle cyan text-shadow glow
- [Import Video] → OS file picker, accepts: .mp4 .mov .webm .avi .mkv .m4v
- [Import Audio] → OS file picker, accepts: .mp3 .wav .ogg .flac .aac
- [Connect Camera] → triggers getUserMedia enumeration, adds to Media Pool
- [New Project] — prompts save confirmation if unsaved changes exist
- [Save Project] — saves to IndexedDB + offers download as .glslforge JSON
- [Load Project] — opens .glslforge file, triggers Relink Media if needed

Center section:
- ⏮ Skip to start | ⏪ −1 frame | ▶/⏸ Play/Pause | ⏩ +1 frame | ⏭ Skip to end
- Timecode display: HH:MM:SS:FF (frame-accurate, based on project FPS)
- Playback speed selector: 0.25× 0.5× 1× 2× 4×
- [LOOP] toggle: loops playback between in/out points

Right section:
- Canvas resolution selector: Original | 4K (3840×2160) | 1080p | 720p |
  480p | Custom W×H input. "Original" uses the resolution of the first
  active video clip on the timeline; if multiple clips with different
  resolutions are active simultaneously, "Original" uses the highest
  resolution among them. WebGL canvas always matches the selected resolution.
- [Scopes] toggle: opens floating waveform/vectorscope/histogram overlay
- [Export Frame] — saves current rendered output FBO as PNG at canvas resolution
- [Export Video] — opens the Export Modal (fully specified in Section IV)
- [Record Camera] — starts MediaRecorder on the output canvas stream,
  saves to a new clip on a new track on stop
- [Toggle Audio Reactive] — master enable/disable for all audio band uniforms;
  glows cyan when active, dark when disabled
- FPS counter: live render loop fps, monospace, top-right corner

AUTOSAVE INDICATOR:
- Small dot in the toolbar: green (saved) | amber (unsaved changes) |
  spinning (autosaving)
- Autosave fires every 60 seconds to IndexedDB
- On crash recovery: on next load, if an autosave is newer than the last
  manual save, prompt: "Recover unsaved session?" with timestamp

═══════════════════════════════════════════════════════════════
IV. EXPORT MODAL — FULL SPECIFICATION
═══════════════════════════════════════════════════════════════

Opened via [Export Video] button. A centered modal dialog containing:

Output format section:
- Format: WebM (VP9) | WebM (VP8) — browser-native via MediaRecorder
- Container: .webm
- Note displayed: "For MP4/H.264 export, use a post-processing tool such
  as FFmpeg on the downloaded .webm file."

Quality section:
- Video bitrate: slider 1–100 Mbps, default 20 Mbps, numeric input
- Audio bitrate: 128kbps | 192kbps | 320kbps | dropdown
- Resolution: inherits canvas resolution selector, or override here

Range section:
- Export range: [Full Project] | [In/Out Points] | [Custom: start → end]
- Custom range: two timecode inputs (HH:MM:SS:FF)

Output section:
- Filename: text input, default "[project-name]_export"
- [Start Export] button

Progress UI (replaces modal content on export start):
- Large progress bar with percentage
- Timecode of frame currently being encoded: "Encoding 00:01:23:12…"
- Estimated time remaining
- Live thumbnail of current frame being exported (64×64)
- [Cancel Export] button — stops MediaRecorder, discards partial file
- On completion: "Export complete — [Download file]" button appears

═══════════════════════════════════════════════════════════════
V. MEDIA POOL (Left Panel) — UNIFIED SOURCE BROWSER
═══════════════════════════════════════════════════════════════

The Media Pool contains five tabs: [Videos] [Cameras] [Audio] [Effects] [Scopes]

[Videos] — imported video files
  - Lists all imported clips as thumbnail cards (first frame, 80×45px)
  - Each card shows: filename (truncated), duration, resolution, fps
  - Right-click card → Rename | Remove from Project | Replace File |
    Reveal in Finder
  - Drag onto Timeline → creates a clip on the topmost available track
  - Drag onto Node Editor canvas → creates a VIDEO INPUT source node

[Cameras] — live camera devices
  - Lists all detected camera devices, enumerated via enumerateDevices()
  - Each device shows: label, 64×64 live thumbnail (updated 4fps),
    resolution currently streaming
  - Status indicator: 🟢 Active | 🔴 Unavailable | 🟡 Permission pending
  - [Request Permission] button if permission not yet granted
  - Drag device card onto Node Editor → creates CAMERA INPUT node
  - Drag device card onto Timeline → creates camera track + live clip
  - [Refresh Devices] button: re-enumerates connected cameras

[Audio] — audio files + mic
  - Imported audio files shown as waveform thumbnail cards
  - Each card shows: filename, duration, sample rate, channels
  - Microphone input listed as a device card with live VU meter
  - [Enable Mic] toggle per mic device
  - Audio source priority (for global u_audio_bands):
      Priority 1: Soloed audio track
      Priority 2: First unmuted audio track with content at playhead
      Priority 3: Microphone (if enabled and no audio track active)
      Priority 4: Silence — all u_audio_bands default to 0.0,
                  u_audio_rms = 0.0, u_beat = 0.0
  - When silence is active, the [Scopes] audio meters show a flat line
    and a "NO AUDIO SOURCE" label appears on the Scopes tab
  - Audio latency compensation: a global offset slider in this tab,
    range −500ms to +500ms, default 0ms

[Effects] — unified shader and compound library
  - Lists all built-in single shader nodes, compound effects,
    and user-saved presets as draggable cards
  - Each card shows: name, 64×64 preview thumbnail, node count
    (if compound), ★ compound badge, 🎵 audio-reactive badge (if any
    param has a default audio binding)
  - Search bar: filters by name, tag, or node type in real time
  - Filter buttons: [All] [Single Shader] [Compound] [Audio-Reactive]
    [My Saved]
  - [Preview] on each card: applies effect to a still from the current
    clip at the playhead and shows a 50/50 split before/after preview
    in a popup modal
  - [Import .glslforge] — loads a preset file from disk
  - [Export Selected] — saves selected preset(s) as .glslforge JSON
  - Drag onto Node Editor canvas → creates node(s), auto-connects to
    last node before OUTPUT, positioned to the right of the last node
  - Drag onto a timeline clip → applies as that clip's full effect graph
    (confirmation dialog if clip already has an effect graph)

[Scopes] — real-time audio frequency analyzer
  - 8 frequency band bars with labels, color-coded, pulsing in real time:
      Band 0 Sub-bass  20–60Hz    — deep red
      Band 1 Bass      60–250Hz   — orange
      Band 2 Low-mid   250–500Hz  — yellow
      Band 3 Mid       500–2kHz   — green
      Band 4 Upper-mid 2–4kHz     — cyan
      Band 5 Presence  4–6kHz     — blue
      Band 6 Brilliance 6–20kHz   — violet
      Band 7 RMS overall           — white
  - Peak hold line per band, decaying at 2dB/frame
  - "NO AUDIO SOURCE" label when all sources are silent/inactive

═══════════════════════════════════════════════════════════════
VI. LIVE CAMERA / WEBCAM INPUT SOURCE
═══════════════════════════════════════════════════════════════

Camera input is a first-class source, fully peer to video file input.

A. CAMERA SOURCE NODE
- On creation: calls getUserMedia({
    video: { width:{ideal:3840}, height:{ideal:2160}, frameRate:{ideal:60} }
  })
- Enumerates devices via enumerateDevices() each time the node is opened
- Node params (all via @param directives, rendered as node UI controls):
    Device:            dropdown of all camera deviceIds by label
    Resolution:        4K | 1080p | 720p | 480p | Custom
    Frame rate:        24 | 30 | 60 | Max available
    Mirror horizontal: bool toggle
    Mirror vertical:   bool toggle
    Exposure:          slider (via ImageCapture API if supported, else hidden)
    White balance:     auto | manual (if supported, else hidden)
    Zoom:              slider 1.0–10.0 (if supported, else hidden)
- Camera MediaStream → hidden <video> element (autoplay, muted, playsInline)
- Each render frame: texSubImage2D uploads camera video element to GL texture
- Output socket: [camera texture]

B. DEVICE CHANGE HANDLING
- When the device selector dropdown changes:
    1. Stop all tracks on existing stream: stream.getTracks().forEach(t=>t.stop())
    2. Release existing stream reference
    3. Call getUserMedia with new deviceId constraint
    4. Assign new stream to the hidden video element
    5. Update node thumbnail when first frame arrives
- This prevents ghost streams from running in the background

C. STREAM FAILURE RECOVERY
- If the camera stream drops mid-session (device unplugged, permission
  revoked, hardware error):
    1. The onerror / onended events on the video element fire
    2. The node immediately enters ERROR state:
       - Node card shows red border + "Camera disconnected" label
       - Output socket emits the last valid frame (frozen) as a texture
         for up to 2 seconds, then switches to a black texture
    3. A toast notification appears: "Camera lost: [device name]"
    4. A [Reconnect] button appears on the node card
    5. [Reconnect] re-calls getUserMedia with the same deviceId
    6. If the device is no longer enumerable, the dropdown updates
       to remove it and selects the first available device

D. CAMERA AUDIO ROUTING
- getUserMedia for camera nodes is VIDEO ONLY (audio: false)
- Camera audio is intentionally not captured through the camera node
  to avoid echo/feedback loops with the audio engine
- If the user wants to capture camera audio, they must use the
  microphone input in the [Audio] tab of the Media Pool separately

E. CAMERA IN THE TIMELINE
- Camera source placed as a clip on a VIDEO track
- Duration: infinite (live) — clip region defines when the feed is active
- Multiple camera clips = multiple getUserMedia streams (one per unique deviceId)
- Camera clips display a live 4fps thumbnail in the track header
- Camera clips show a pulsing red "LIVE" badge in the timeline

F. MULTI-CAMERA SUPPORT
- Up to 4 simultaneous camera streams (hardware permitting)
- Texture units: TEXTURE_2 through TEXTURE_5
- Available as u_camera_0 through u_camera_3 when upstream in graph
- CAMERA BLEND node: two camera texture inputs + mask/mix param

G. CAMERA PERMISSIONS
- If permission denied: node shows "Camera permission denied" in red
- [Request Permission] retry button on node card
- Permission state stored in localStorage

═══════════════════════════════════════════════════════════════
VII. THREE ARCHITECTURAL PILLARS
═══════════════════════════════════════════════════════════════

Everything is built around three foundational pillars:

PILLAR 1 — SOURCES
  Anything producing a texture per frame:
  Video files, Camera streams, Audio visualizer nodes, Procedural generators.
  All sources are interchangeable — a camera and a video file are identical
  in how they connect to downstream shader nodes.

PILLAR 2 — EFFECTS
  Shader nodes and compound effect groups that transform textures.
  Two contexts:
    a) Per-clip graph  — attached to a specific clip, private to that clip
    b) Master graph    — applied to the final composite of all tracks
  A SINGLE SHADER NODE = one GLSL fragment shader = one render pass.
  A COMPOUND EFFECT = collapsed group of nodes with a user-defined
  parameter surface, behaving as a single node externally.

PILLAR 3 — COMPOSITION
  The timeline assembles sources+effects into tracks. Each clip has its own
  independent effect graph. Tracks composite onto an accumulation buffer.
  The master graph applies final effects to the accumulated composite.

═══════════════════════════════════════════════════════════════
VIII. PREVIEW CANVAS — WEBGL RENDERING ENGINE
═══════════════════════════════════════════════════════════════

A. ARCHITECTURE
- One primary WebGL2 context drives the full processing pipeline
- Source: HTML <video> element (file or camera), decoded per frame
- Each frame: texSubImage2D uploads pixel data to GL texture
- Node graph compiled into sequential multi-pass framebuffer chain:
    Each node = one full-screen quad render pass
    Output FBO of node N feeds as input texture of node N+1
- Final output blitted to the visible <canvas> element
- A secondary <canvas> reads the output FBO for scopes (waveform etc.)

B. FRAMEBUFFER SPECIFICATION
- Double-buffered ping-pong FBOs for feedback effects
- All FBOs: RGBA half-float (OES_texture_half_float_linear extension)
  with fallback to RGBA8 if extension unavailable
- All shaders use: precision highp float;
  This is a hard requirement — no mediump or lowp for color processing
- Resolution: matches the canvas resolution selector at all times

C. STANDARD UNIFORMS AVAILABLE TO ALL SHADERS
  uniform sampler2D u_texture;        // current input texture
  uniform sampler2D u_prev_frame;     // previous rendered output frame
  uniform sampler2D u_camera_0;       // live camera stream 0 (if active)
  uniform sampler2D u_camera_1;       // live camera stream 1 (if active)
  uniform sampler2D u_camera_2;       // live camera stream 2 (if active)
  uniform sampler2D u_camera_3;       // live camera stream 3 (if active)
  uniform vec2  u_resolution;         // canvas pixel dimensions
  uniform float u_time;               // elapsed seconds since playback start
  uniform int   u_frame;              // current frame number (integer)
  uniform float u_playhead;           // 0.0–1.0 position within clip
  uniform float u_audio_bands[8];     // FFT band values 0.0–1.0
  uniform float u_audio_rms;          // overall RMS 0.0–1.0
  uniform float u_audio_bass;         // alias for u_audio_bands[1]
  uniform float u_audio_mid;          // alias for u_audio_bands[3]
  uniform float u_audio_treble;       // alias for u_audio_bands[6]
  uniform float u_beat;               // beat detection 0.0–1.0, decays fast
  uniform int   u_beat_count;         // total beats since playback start
  // + all user-exposed @param uniforms for this node

D. u_prev_frame INITIALISATION
- On the very first frame of playback (frame 0), u_prev_frame is
  initialised to a copy of the first video frame (not black)
- This prevents a single-frame black flash at the start of feedback nodes
- If no video is present, u_prev_frame initialises to a fully transparent
  black texture (vec4(0.0))

E. CANVAS INTERACTIONS
- Zoom: mousewheel, smooth CSS transform, range 25%–400%
- Pan: middle-click drag
- [Fit to Window] button resets zoom and pan
- Canvas background: dark checkerboard pattern (transparency indicator)

═══════════════════════════════════════════════════════════════
IX. RENDER LOOP — PRECISE ARCHITECTURE
═══════════════════════════════════════════════════════════════

A. LOOP RATE AND PAUSE BEHAVIOUR
- requestAnimationFrame drives the loop at display refresh rate when playing
- When PAUSED:
    The loop drops to a 10fps polling rate (via setTimeout fallback)
    This keeps the preview responsive to parameter/slider changes
    without consuming full GPU resources while stopped
- When the browser tab is hidden (document.visibilityState === 'hidden'):
    Loop pauses entirely (cancelAnimationFrame) to save resources
    On tab restore: loop resumes, video/audio sync re-established

B. PER-FRAME EXECUTION ORDER

  For each active track (composited bottom-to-top, Track 1 = bottom):
    1. Check if playhead is within this clip's range. If not: skip.
    2. Decode source frame:
         Video file: advance video.currentTime, upload via texSubImage2D
         Camera:     upload current camera video element via texSubImage2D
         4K source:  use createImageBitmap (async) to decode off main thread
    3. Run clip's per-clip effect graph (Level 2):
         Topologically sort compiled node list
         For each node in sorted order:
           a. Bind node's input FBO texture(s) to texture units
           b. Upload all uniforms (time, frame, audio, user params, beat)
           c. Execute full-screen quad draw call (gl.drawArrays)
           d. Node's output FBO becomes next node's input
         Result: clip output texture
    4. Composite clip output onto accumulation buffer using:
         - This clip's blend mode (per-clip setting, default: Normal/Over)
         - This clip's opacity (0.0–1.0)
         - Track blend mode (per-track setting, default: Normal/Over)
         Compositing formula for Normal mode:
           out.rgb = src.rgb * src.a + dst.rgb * (1.0 - src.a)
           out.a   = src.a + dst.a * (1.0 - src.a)

  After all tracks composited:
    5. Run Master effect graph (Level 1) on accumulated buffer
    6. Blit final FBO to visible screen canvas (gl.blitFramebuffer)
    7. Extract per-node 64×64 thumbnails (throttled to 12fps / every 5 frames)
    8. If scopes panel open: read output FBO pixels, draw scopes on secondary canvas
    9. Update timeline playhead (React state, throttled to 30fps)
   10. Update audio meter UI in Scopes tab (React state, throttled to 30fps)

C. OVERLAPPING CLIPS ON THE SAME TRACK
- If two clips overlap in time on the same track:
    The clip that starts LATER (higher start time) is considered "on top"
    It renders second and composites over the earlier clip using its blend mode
    This matches standard NLE behaviour
- Overlapping clips are visually shown as overlapping rectangles on the timeline
  with the later clip's edge raised slightly (z-index)
- A blend mode selector appears between the overlapping portions on hover

D. GAPS BETWEEN CLIPS
- If the playhead is in a gap between clips on a track:
    That track contributes a fully transparent black texture (vec4(0.0))
    to the compositor for that frame
- No "last frame hold" behaviour — gaps are truly transparent/black

E. AUDIO / VIDEO SYNC
- video.currentTime is set each frame: video.currentTime = audioContext.currentTime
  (when an audio track is active and audio context is running)
- If no audio context is active, video advances by (1/fps × playbackSpeed)
  per frame based on wall clock delta
- Drift detection: if |video.currentTime - expected_time| > 2 frames,
  force-snap video.currentTime to the expected value
- If the render loop falls behind (heavy shader load, slow GPU):
    Skip video frame uploads (keep last texture) rather than dropping
    audio, to keep audio/video sync perceptually correct
  A "frame skip" counter is displayed next to the FPS counter when active

F. TRACK BLEND MODES
- Each TRACK has a blend mode setting in its track header (gear icon)
- Each CLIP has its own blend mode setting (in Inspector, per-clip)
- Clip blend mode is applied when compositing the clip's output onto
  the track accumulation buffer
- Track blend mode is applied when compositing the track's accumulated
  result onto the master accumulation buffer
- Available blend modes (30 total):
    Normal, Dissolve, Darken, Multiply, Color Burn, Linear Burn,
    Darker Color, Lighten, Screen, Color Dodge, Linear Dodge (Add),
    Lighter Color, Overlay, Soft Light, Hard Light, Vivid Light,
    Linear Light, Pin Light, Hard Mix, Difference, Exclusion,
    Subtract, Divide, Hue, Saturation, Color, Luminosity,
    Plus (Additive), Minus, Multiply Alpha

G. WebGL STATE MANAGEMENT
- Shared VAO with full-screen quad (2 triangles, UV coordinates 0.0–1.0)
- Shader programs cached by MD5 hash of source string
- Texture units managed with LRU cache (max units determined at runtime
  via gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS))
- GPU time budget warning: if total per-frame GPU time >16ms (60fps budget),
  amber warning appears in toolbar: "GPU: 18.4ms ⚠ [see breakdown]"
  Clicking breakdown shows per-clip cost table

═══════════════════════════════════════════════════════════════
X. NODE EDITOR — FULL SPECIFICATION
═══════════════════════════════════════════════════════════════

A. CONTEXT — TWO GRAPH LEVELS

The Node Editor always shows exactly one graph context at a time.

LEVEL 1 — MASTER GRAPH (default)
  Header: "MASTER EFFECT GRAPH"
  Applies to the final composite of all tracks.
  Cannot be disabled.

LEVEL 2 — PER-CLIP GRAPH
  Header: "EFFECT GRAPH: [clip filename] [Track N]   [↩ Back to Master]"
  SOURCE node = this clip's video/camera frame.
  OUTPUT node = this clip's contribution to the compositor.
  Press [↩ Back to Master] or Escape to return to Level 1.

How to enter Level 2:
  - Double-click a clip on the timeline
  - Right-click clip → "Open Effect Graph"
  - Click the [FX] badge on the clip

[FX] BADGE on every timeline clip:
  Grey  = no active effects (pass-through graph)
  Cyan  = active shader nodes present
  Amber = compile error in this clip's graph
  Alt+click [FX] = toggle entire clip graph bypass

B. CANVAS BEHAVIOUR
- Infinite pannable/zoomable canvas, dot-grid background
- Pan: middle-mouse drag OR space+drag
- Zoom: Ctrl+scroll, range 0.1×–4×, smooth interpolation
- Minimap: bottom-right corner, 180×100px, 30% opacity
- Right-click empty canvas → searchable "Add Node" context menu:
    - Text input filters all 23 node types + saved presets + compounds
    - Results grouped: [Sources] [Effects] [Compound] [Saved]
    - Keyboard: arrow keys to navigate, Enter to place, Escape to cancel
    - Node placed at cursor position
- Ctrl+Z / Ctrl+Y: undo/redo (full history stack, unlimited depth)
- Multi-select: drag-box OR Shift+click individual nodes
- Selected nodes: cyan border glow + subtle cyan background tint
- Delete key: removes selected nodes (confirmation if they have connections)
- Ctrl+D: duplicate selected nodes (placed 20px offset from originals)
- Ctrl+G: group selected nodes into a Compound Effect (see Section XII)
- Ctrl+A: select all nodes

C. NODE POSITIONING AND AUTO-LAYOUT
- Newly added node (via right-click menu): placed at cursor position
- Newly added node (via drag from Media Pool): placed at drop position
- Auto-connect on drop: if the graph has existing nodes, the new node's
  input socket auto-connects to the output of the last node before OUTPUT,
  and the new node's output auto-connects to OUTPUT
  (user can disconnect and rewire manually)
- Auto-layout button in node editor toolbar: applies a left-to-right
  Sugiyama-style layout to all nodes, respecting connection direction
- Nodes cannot overlap: on drop, if position conflicts with existing node,
  offset by 20px until a free position is found

D. DISCONNECTED / ORPHANED NODES
- Nodes not connected to any path leading to OUTPUT are considered orphaned
- Orphaned nodes: shown with a dashed border and 60% opacity
- Orphaned nodes are NOT compiled and NOT executed (silently skipped)
- A warning icon appears on orphaned nodes with tooltip:
  "This node is not connected to OUTPUT and will not render"
- No error is thrown for orphaned nodes — they are simply inert

E. NODES WITH NO INPUT CONNECTED
- If a non-source node has its input socket unconnected at compile time:
    The compiler substitutes a black transparent texture (vec4(0.0))
    as the input rather than refusing to compile
    A yellow warning badge appears on the node: "No input — using black"
- This allows partial graphs to render without crashing

F. NODE ANATOMY — every single node card:

┌─ [TYPE LABEL] ──────────────────── [⚙] [👁] [</>] [×] ┐
│  ●──[ input texture ]                                    │
│                                                          │
│  [64×64 live thumbnail — output of THIS node]           │
│                                                          │
│  ── PARAMETERS ──                                       │
│  param_name  [━━━●──────] 0.45  [🎵]                    │
│  param_name  [───●──────] 0.30  [🎵]                    │
│                                                          │
│  [+ Add Param]   [Edit Uniforms]                         │
│                               [ output texture ]──●     │
│                              [exec order: 3]            │
└──────────────────────────────────────────────────────────┘

  Header left border: unique hue per node type (consistent across sessions)
  ⚙  settings: name (editable), blend mode, bypass toggle
  👁  eye icon: sets this node as the preview tap point (see Section XIV)
  </> code icon: opens Monaco shader editor drawer (see Section XIII)
  ×  delete button
  Execution order number: small muted label, bottom-right of card
  Bypass toggle: greys card to 40% opacity, passes input texture unchanged

G. SOCKETS
- Input socket: filled circle, left edge. Accepts exactly one connection.
- Output socket: filled circle, right edge. Fans to multiple inputs.
- Socket colours by type:
    Texture         — cyan   (#00e5ff)
    Audio band      — magenta (#ff00aa)
    Parameter value — yellow (#ffdd00)
- Hover: socket glows + tooltip showing socket name and type
- Incompatible type drop: socket flashes red, connection rejected

H. NOODLES (CONNECTION CABLES)
- Cubic bezier curves between output and input sockets
- Colour: matches source socket type
- Thickness: 2px normal, 3px when selected
- Glow: box-shadow 0 0 6px [socket colour]
- Selected noodle: animated "marching ants" dash pattern
- Drag from output socket: live bezier cable follows cursor
- Drop on compatible input: connects. Drop elsewhere: cancels with snap-back
- Click on noodle midpoint: shows "Insert Node Here" popup picker
- Right-click noodle: "Delete Connection" | "Insert Node"
- Incompatible drop: red flash on both sockets + shake animation

I. PARAMETER SLIDERS
- Each exposed @param uniform renders one control row:
    [label]  [━━━━●━━━]  [value — click to type]  [🎵]
- Slider range, step, default from @param directive
- Right-click value input → "Reset to Default"
- [🎵] bind button: opens Audio Bind Modal:
    Audio source:  [which audio track or mic — dropdown]
    Band:          [Sub-bass|Bass|Low-mid|Mid|Upper-mid|Presence|
                    Brilliance|RMS|Beat — dropdown]
    Multiplier:    [slider 0.0–5.0]
    Offset:        [slider −1.0–1.0]
    Invert:        [checkbox]
    Preview:       live numeric output of current computed value
    Bound formula: clamp(band_value * multiplier + offset, param_min, param_max)
    [Bind] / [Clear Binding] buttons
  When bound: slider shows live audio-driven movement (read-only display)
  🎵 icon pulses magenta in time with the audio band
- Each param slider can be keyframed (right-click → "Add Keyframe")

J. NODE GRAPH COMPILATION
- Topological sort runs on every graph change (connection, add, delete)
- Cycle detection: red highlight on all nodes in the cycle + toast error:
  "Cycle detected — graph cannot compile"
- Auto-recompile: 300ms debounce after any graph structural change
- "Compile Graph" button in node editor toolbar: forces immediate recompile
- Compilation result: a flat ordered array of {nodeId, program, uniforms}
  ready for the render loop to execute sequentially

═══════════════════════════════════════════════════════════════
XI. PER-CLIP EFFECT GRAPHS
═══════════════════════════════════════════════════════════════

A. STRUCTURE
- Every clip has a private clipGraph object: { nodes[], edges[] }
- Stored inside the clip's JSON in the project save file
- SOURCE node in a clip graph:
    Type: "CLIP_SOURCE" — locked, cannot be deleted or moved
    It occupies texture unit TEXTURE_0 in the clip's render pass
    The clip's current video frame is uploaded to TEXTURE_0 before
    any of the clip's nodes execute
    The user cannot edit the SOURCE node but can see it as a visual
    anchor on the left of the clip graph canvas
- OUTPUT node in a clip graph:
    Type: "CLIP_OUTPUT" — locked, cannot be deleted
    Its input texture is the result passed to the compositor

B. ISOLATION AND COMPOSITE PREVIEW
- When editing a clip graph, the Node Editor header changes context
- Preview canvas switches to ISOLATED MODE by default:
    Shows only this clip's effect graph output
    Amber border ring around preview canvas
    "ISOLATED: [clip name]" label in preview top-left
- [COMPOSITE / ISOLATED] toggle in toolbar while in clip graph context:
    ISOLATED: only this clip (default on entry)
    COMPOSITE: full multi-track composite with this clip's effects live
- If playhead is outside the clip's timeline range while in isolated mode:
    Preview shows first frame (if before clip) or last frame (if after)
    "OUT OF RANGE" overlay shown in center of preview canvas

C. CLIP FX OPERATIONS
- Right-click clip → "Save Clip Graph as Preset" → saves to [Effects] tab
- Right-click clip → "Apply Preset" → picker from Effects library
- Right-click clip → "Copy Effect Graph" | "Paste Effect Graph"
- Right-click clip → "Bypass All Effects" (same as Alt+click [FX])
- Drag compound effect from Media Pool onto clip → installs as clip graph
  (confirmation if clip already has nodes: "Replace existing graph?")

D. MULTI-CLIP OPERATIONS
- Select multiple clips → right-click → "Apply Same Effect Graph to All":
    [Replace all existing] | [Add to existing chains]
- "Sync Parameter across selection": links a named param across all
  selected clips' matching nodes — editing one updates all in real time
- Keyframe curves are clip-local: moving a clip on the timeline moves
  its keyframe curves with it as a unit. Trimming a clip does NOT
  delete keyframes that fall outside the trimmed range — they are
  preserved and will re-activate if the clip is re-extended.

E. AUDIO BINDING SCOPE
- Inside a clip graph: u_audio_bands sourced from the soloed/active
  audio track as described in Section V [Audio] tab priority rules
- A clip can contain an AUDIO SOURCE node pointing to a specific
  audio file, making that clip self-contained with its own audio data
  that overrides the global audio bus for bindings within that clip graph

═══════════════════════════════════════════════════════════════
XII. COMPOUND EFFECTS — MULTI-SHADER CHAINS AS SINGLE REUSABLE UNITS
═══════════════════════════════════════════════════════════════

A. CREATING A COMPOUND

Method 1 — Group selection:
  Select 2+ shader nodes → right-click → "Create Compound Effect" / Ctrl+G
  Rules for selection-edge connections:
    Connections BETWEEN selected nodes: preserved internally in sub-graph
    Connection FROM a non-selected node INTO a selected node:
      The selected node's input becomes the compound's INPUT socket
      (only the topmost/leftmost such connection is promoted;
       if multiple external inputs exist, only one is promoted and a
       warning is shown: "Only one external input connection supported")
    Connection FROM a selected node OUT to a non-selected node:
      The selected node's output becomes the compound's OUTPUT socket
      If multiple external outputs exist, they all wire to the same
      compound output socket (fan-out is preserved)
    All other external connections are severed and a warning toast shows:
      "N connection(s) were disconnected during compound creation"

Method 2 — From scratch:
  Right-click canvas → "New Compound Effect"
  Opens an empty sub-graph with EFFECT INPUT and EFFECT OUTPUT terminal nodes
  User builds the chain, names it, saves

B. COMPOUND NODE CARD

┌─ [★] COMPOUND NAME ────────── [↗ Edit] [⚙] [👁] [×] ┐
│  ●──[ input texture ]                                  │
│                                                        │
│  [64×64 animated preview thumbnail]                   │
│                                                        │
│  ── EXPOSED PARAMS ──                                 │
│  Overall Intensity  [━━━●────] 0.70  [🎵]             │
│  Glitch Amount      [───●────] 0.30  [🎵]             │
│                                                        │
│  [★ 5 nodes inside]   [Edit Effect]                   │
│                            [ output texture ]──●      │
└────────────────────────────────────────────────────────┘

C. SUB-GRAPH EDITOR
- Opened via [Edit Effect] or double-clicking compound node card
- Full-screen overlay inside the Node Editor panel (breadcrumb navigation)
- Breadcrumb: "Main Graph > [COMPOUND NAME]"
  Or for clip context: "[Clip Name] > [COMPOUND NAME]"
- EFFECT INPUT and EFFECT OUTPUT terminal nodes are locked (cannot delete)
- EFFECT INPUT receives the ACTUAL upstream texture from the live pipeline
  (the real current frame), so previewing inside a compound shows
  true in-context results, not a blank or black input
- All node editor features available inside sub-graph (add, delete, noodles etc.)
- [↩ Back] button OR Escape exits sub-graph and returns to parent context

D. NESTED COMPOUNDS
- Compounds CAN contain other compound nodes (nested sub-graphs)
- Maximum nesting depth: 5 levels (enforced at creation time)
- Breadcrumb shows full nesting path: "Master > Acid Vision > Inner Warp"
- Circular compound references (A contains B, B contains A) are detected
  and blocked: "Cannot create circular compound reference"

E. PARAMETER EXPOSURE

Right-click any slider inside sub-graph → "Expose to Compound Surface":
  Dialog fields:
    Display Name:       [text input — becomes label on compound surface]
    Exposed Min:        [number — the range the compound slider shows]
    Exposed Max:        [number]
    Internal param(s):  [list of internal uniforms being driven]
    Per-param scaling:
      For each mapped internal param:
        Scale Factor:   [float — how much internal param moves per 1.0 of exposed]
        Offset:         [float — internal value when exposed = 0.0]
  Mapping formula per internal param:
    internal_value = clamp(exposed_value * scale_factor + offset,
                           internal_min, internal_max)
  Multiple internal params → one exposed param: fully supported
  One internal param → multiple exposed params: NOT supported
    (each internal param can only map to one exposed param)

Unexposed params: remain editable only inside the sub-graph editor.
Audio binding: works identically on exposed params as on raw params.

F. COMPOUND VERSIONING
- Saved compounds in the Effects library are SNAPSHOTS at save time
- Editing a compound instance does NOT update the library version
- Editing the library version does NOT affect existing project instances
- To update a library entry: [Save to Library] again (creates a new version,
  old version retained with "(v1)", "(v2)" suffix in the name)
- [Detach & Expand]: explodes compound into individual nodes in-place on canvas
  (confirmation required, cannot be undone as a single undo step)

G. BUILT-IN COMPOUND PRESETS (ship with the app, fully functional):
  "Psychedelic Pulse"  — Feedback + Kaleidoscope + Chromatic Aberration
  "Digital Decay"      — Glitch + Pixel Sort + CRT
  "Acid Vision"        — Fluid Warp + Color Inversion + Bloom + Voronoi
  "Mirror Storm"       — Kaleidoscope + Mirror + Edge Detection + Hue Shift
  "Signal Ghost"       — Feedback + Datamosh + Chromatic Aberration
  "Bass Reactor"       — Beat-driven Bloom + Glitch + Fluid Warp,
                         all params pre-bound to bass/beat audio bands

═══════════════════════════════════════════════════════════════
XIII. MONACO SHADER CODE EDITOR — PER NODE
═══════════════════════════════════════════════════════════════

A. OPENING AND LAYOUT
- Clicking </> on any node opens the Monaco drawer
- The drawer slides in from the right, covering the Inspector panel
  (Inspector is temporarily hidden; returns when Monaco closes)
- The Monaco drawer is resizable (drag its left edge)
- Monaco and Inspector cannot both be visible simultaneously —
  closing Monaco restores Inspector to its previous state
- Monaco loads lazily on first use (dynamic import)

B. EDITOR CONFIGURATION
- Language: 'glsl' (custom tokenizer registered via monaco.languages.register)
- Custom dark theme registered (colors matching the app theme):
    Keywords:      cyan    (#00e5ff) — void, if, for, return, etc.
    Types:         yellow  (#ffdd00) — vec2, vec3, mat4, sampler2D, etc.
    Built-ins:     magenta (#ff00aa) — texture, mix, clamp, normalize, etc.
    Comments:      green   (#44cc88)
    Numbers:       orange  (#ff8844)
    Directives:    blue    (#4488ff) — @param lines
- IntelliSense autocomplete includes:
    All GLSL built-in functions and types
    All standard uniforms from Section VIII-C
    All @param-declared uniforms in the current shader
- Line numbers, code folding, minimap enabled
- Word wrap: off (horizontal scroll for long lines)

C. SHADER BOILERPLATE FOR CUSTOM SHADER NODES
When a CUSTOM SHADER node is created, Monaco is pre-filled with this
exact template — complete, compilable, ready to modify:

  #version 300 es
  precision highp float;

  // ── Standard uniforms ──────────────────────────────────────────
  uniform sampler2D u_texture;
  uniform sampler2D u_prev_frame;
  uniform vec2      u_resolution;
  uniform float     u_time;
  uniform int       u_frame;
  uniform float     u_playhead;
  uniform float     u_audio_bands[8];
  uniform float     u_audio_rms;
  uniform float     u_audio_bass;
  uniform float     u_audio_mid;
  uniform float     u_audio_treble;
  uniform float     u_beat;
  uniform int       u_beat_count;

  // ── Custom parameters — add your own below ─────────────────────
  // @param name="Intensity" min=0.0 max=1.0 default=0.5 step=0.01
  uniform float u_intensity;

  // ── Output ────────────────────────────────────────────────────
  out vec4 fragColor;

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec4 color = texture(u_texture, uv);

    // Your shader code here
    fragColor = mix(color, vec4(1.0 - color.rgb, color.a), u_intensity);
  }

D. @PARAM DIRECTIVE SPECIFICATION — FULL RULES

Directives are placed as line comments immediately above uniform declarations.
The parser reads them in order. Supported directive attributes:

  name     (string, required)   — display label on the node slider
  min      (float, required for float/int)
  max      (float, required for float/int)
  default  (float/bool/string)  — value applied on node creation
  step     (float, optional)    — slider step increment, default 0.01
  type     (string, optional)   — if omitted, inferred from GLSL type:
             float   → slider
             int     → integer slider
             bool    → checkbox toggle
             vec3    → color picker (values normalised 0.0–1.0 RGB)
             int     with type=select → dropdown (requires options=)
  options  (comma-separated)    — for type=select only

  @audiobind (optional, on its own directive line):
    Specifies a DEFAULT audio binding applied when the node is first created.
    The user can override or clear it in the UI.
    Attributes: band= (band name or index), multiplier=, offset=

Examples:
  // @param name="Warp Speed" min=0.0 max=5.0 default=1.0 step=0.1
  uniform float u_warp_speed;

  // @param name="Edge Color" type=color default=#00ff88
  uniform vec3 u_edge_color;

  // @param name="Enable Glow" type=bool default=false
  uniform bool u_enable_glow;

  // @param name="Blend Mode" type=select options=add,multiply,screen default=add
  uniform int u_blend_mode;

  // @param name="Bass Intensity" min=0.0 max=3.0 default=1.0
  // @audiobind band=bass multiplier=2.0 offset=0.0
  uniform float u_bass_intensity;

PARSER ERROR BEHAVIOUR:
  Malformed directive (unrecognised attribute, missing required field):
    The directive is silently IGNORED
    The uniform is still compiled and uploaded with its GLSL default
    A yellow warning marker appears on that line in Monaco with tooltip:
      "Malformed @param directive — this parameter will not appear as a slider"
  Unknown attribute: silently ignored, no warning
  Directive with no matching uniform below it: ignored with Monaco warning

E. VEC3 COLOR UNIFORM DATA PATH
- The @param type=color produces a color picker control on the node
- Color picker output: hex string e.g. "#ff0066"
- Conversion to uniform upload:
    r = parseInt(hex[1..2], 16) / 255.0
    g = parseInt(hex[3..4], 16) / 255.0
    b = parseInt(hex[5..6], 16) / 255.0
    gl.uniform3f(location, r, g, b)
- GLSL receives normalized 0.0–1.0 vec3 — no gamma correction applied
  (the user's shader is responsible for any gamma handling)

F. COMPILE ERRORS
- On every recompile, WebGL gl.getShaderInfoLog() is parsed:
    Format: "ERROR: line:column: message"
    Each error becomes a Monaco red squiggle marker at the exact line/column
    Error text shown in Monaco's Problems panel below the editor
- Error state: preview canvas freezes on last valid frame,
  red vignette border appears on preview canvas,
  error toast shows first error message
- The render loop continues executing the LAST SUCCESSFULLY COMPILED version
  of the shader during an error state (graceful degradation)

G. SHADER VERSIONING PER NODE
- Each node maintains a local edit history stack (up to 50 snapshots)
- Ctrl+Z inside Monaco: undoes within Monaco's own text history
- Node-level history: every successful compile creates a snapshot
  accessible via a "History" dropdown in the Monaco toolbar
- "Reset to Default" button: restores the original built-in shader code
  (does NOT affect user's local history stack — they can redo back)
- "Fork from Default" label appears on any built-in node whose shader
  has been modified, to distinguish it visually from the unmodified version
- "Save as Preset" button: saves ONLY the current node's shader code and
  @param definitions to the Effects library as a single-node preset

═══════════════════════════════════════════════════════════════
XIV. PREVIEW WINDOW ↔ NODE GRAPH CONNECTION — FULL SPECIFICATION
═══════════════════════════════════════════════════════════════

A. THE PREVIEW TAP POINT
The preview canvas shows the output texture of exactly one designated node
— the PREVIEW TAP POINT. This is a named, movable, visually communicated
probe that can be placed on any node in the active graph.

Rules:
  - Default tap point: the OUTPUT node (final result)
  - User can move the tap point to any node at any time
  - Tap point is per-graph context: master, each clip, each compound
    all remember their own tap point independently
  - Exactly one tap point is active per graph at any time

Setting the tap point (three methods):
  1. Hover any node → [👁] eye icon appears → click it
  2. Right-click any node → "Preview This Node"
  3. Inspector panel with node selected → "Set as Preview" button

Visual indicators on the node graph when a non-OUTPUT node is tapped:
  - Active tap point node: solid cyan [👁 PREVIEW] badge in header +
    animated pulsing cyan outline
  - Nodes UPSTREAM of tap (inclusive): full opacity
  - Nodes DOWNSTREAM of tap: 40% opacity, greyed out
  - This makes it instantly clear which part of the chain is previewed

Releasing the tap point:
  - Click the cyan [👁 PREVIEW] badge on the active tap point node
  - Right-click active tap node → "Reset Preview to Output"
  - The OUTPUT node always shows its own [👁] when it is the tap point

B. PREVIEW CONTEXT STATES

MASTER GRAPH CONTEXT (default):
  Node Editor header: "MASTER EFFECT GRAPH"
  Preview shows: full composite of all tracks through master graph to tap
  Preview label (top-left): "MASTER" in muted cyan
  Preview border: none

PER-CLIP GRAPH CONTEXT:
  Node Editor header: "EFFECT GRAPH: [clip name] [Track N]  [↩ Master]"
  Preview switches to ISOLATED MODE:
    Shows ONLY this clip's effect graph output (no other tracks)
    Preview label: "ISOLATED: [clip name]" in amber text
    Preview border: 2px amber ring around entire canvas
  [COMPOSITE / ISOLATED] toggle in toolbar (visible only in clip context):
    ISOLATED: clip only (default on entry)
    COMPOSITE: full multi-track mix with this clip's effects live

  If playhead is outside clip range while isolated:
    Shows clamped first/last frame
    "OUT OF RANGE" overlay in preview center (fades after 2s if playhead moves in)

COMPOUND SUB-GRAPH CONTEXT:
  Breadcrumb: "Master > [compound name]" or "[clip name] > [compound name]"
  Preview shows output of compound's sub-graph in isolation
  Preview label: "COMPOUND: [name]" in magenta
  Preview border: 2px magenta ring
  EFFECT INPUT node receives the ACTUAL upstream texture (real pipeline data)
  so previewing inside a compound shows true in-context results

C. REAL-TIME PREVIEW UPDATE BEHAVIOUR

Slider drag:
  Every mousemove during drag → immediate uniform re-upload → re-render
  No debounce. Full fps maintained during drag.

Audio-bound parameter:
  Driven every requestAnimationFrame — full render loop speed

Shader code edit:
  Auto-compile ON:  preview updates 500ms after last keystroke (debounced)
  Auto-compile OFF: preview updates only on "Compile & Apply" click
  During compile: "Compiling…" spinner in preview bottom-right corner
  Compile error: preview FREEZES on last valid frame + red vignette border +
    error banner at bottom of preview canvas + red border ring

Node connection change (noodle drag):
  Graph recompiles after 300ms debounce → preview refreshes immediately

Node add / delete:
  Same as connection change — 300ms debounce recompile

Bypass toggle:
  Instantaneous — no recompile — preview updates on next render frame

D. PER-NODE THUMBNAIL PREVIEWS (64×64 on every node card)

Each node card shows a 64×64px live thumbnail of THAT NODE'S output.

Implementation:
  - After the main render loop completes all passes, a thumbnail extraction
    pass downsamples each node's output FBO to a 64×64 offscreen canvas
    using a blit shader (not readPixels — kept on GPU where possible)
  - Result written to a per-node <canvas> element via React ref
  - Update rate: throttled to 12fps (every 5 main render frames)
  - If a node is downstream of a compile error: thumbnail shows a dark
    placeholder with ⚠ icon
  - If a node is bypassed: thumbnail shows the pass-through input texture
    with a "BYPASSED" diagonal label overlay

Thumbnail interactions:
  - Click thumbnail → sets node as preview tap point
  - Hover thumbnail → shows 200×200px popup preview floating above the node card

E. BEFORE / AFTER SPLIT PREVIEW

Alt + horizontal drag on preview canvas:
  Left side: raw SOURCE texture (before any effects)
  Right side: current tap point output
  Split line: white 1px vertical line with circular drag handle
  Labels: "BEFORE" and "AFTER" in respective halves
  Escape or releasing Alt: exits split mode

A/B NODE COMPARE (any two nodes):
  Right-click node → "Set as Compare A"
  Right-click node → "Set as Compare B"
  Preview enters A/B split mode comparing those two pipeline points
  Both sides update in real time at full render speed
  "Clear A/B" button appears in toolbar
  A/B compare is independent of the tap point setting

F. PREVIEW CANVAS OVERLAY INDICATORS — COMPLETE LIST

Top-left label:
  "MASTER"                   — muted cyan, master graph
  "ISOLATED: [clip name]"    — amber, clip isolated mode
  "COMPOUND: [name]"         — magenta, compound sub-graph
  (no label when composite toggle is on in clip mode)

Border ring (2px, inset):
  No ring         — master graph
  Amber ring      — clip isolated mode
  Magenta ring    — compound sub-graph
  Red ring        — compile error / shader invalid state

Top-right badge:
  [TAP: Node Name] — active tap point node name, small cyan badge
  [COMPOSITE]      — shown in clip context with composite toggle ON

Bottom-right corner:
  "Compiling…" spinner — during shader recompile
  FPS counter          — always visible, monospace, small

Bottom edge:
  Error banner — red gradient strip with first compile error message

Center overlay (temporary, 1.5s fade-out):
  "BYPASSED"       — active tap point node is bypassed
  "OUT OF RANGE"   — playhead outside active clip range

All overlays are HTML elements positioned absolutely over the canvas.
NONE are drawn into the WebGL framebuffer — they never contaminate exports.

G. PREVIEW ROUTING SUMMARY

  [VIDEO FILE / CAMERA STREAM]
          │
          ▼
  ┌── CLIP PER-CLIP GRAPH (Level 2) ────────────────────────────┐
  │   CLIP_SOURCE → Node A → Node B → [TAP] → Node C → OUTPUT  │
  │                                      ↓                      │
  │                             amber border preview            │
  └──────────────────────────────────────┬──────────────────────┘
                                         │ (clip OUTPUT feeds compositor)
  ┌── MULTI-TRACK COMPOSITOR ───────────▼──────────────────────┐
  │   Track 1 + Track 2 + Track 3 → accumulated composite      │
  └──────────────────────────────────────┬──────────────────────┘
                                         │
  ┌── MASTER EFFECT GRAPH (Level 1) ────▼──────────────────────┐
  │   INPUT → Node X → Node Y → [TAP] → Node Z → OUTPUT        │
  │                                 ↓                           │
  │                         no-border preview (MASTER)          │
  └─────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
XV. AUDIO ENGINE — FULL SPECIFICATION
═══════════════════════════════════════════════════════════════

A. AUDIO SOURCES
  1. Embedded audio from imported video (MediaElementAudioSourceNode)
  2. Separately imported audio file (.mp3 .wav .ogg .flac .aac)
  3. Microphone live input (getUserMedia, listed in Media Pool [Audio] tab)
  4. Clip-private audio: each clip can contain an AUDIO SOURCE node

B. SIGNAL CHAIN
  MediaSource → AnalyserNode (fftSize: 2048) → gainNode → destination
  Multiple sources are mixed at the Web Audio API level before analysis

C. MULTI-SOURCE ROUTING AND PRIORITY
  The global u_audio_bands uniforms are driven by exactly ONE source
  at a time, according to this priority (evaluated every frame):
    Priority 1: Soloed audio track (if any track has solo active)
    Priority 2: First unmuted audio track with content at the playhead
    Priority 3: Microphone input (if enabled and no track audio active)
    Priority 4: Silence — all band values default to 0.0
  This priority is computed each frame, so switching tracks changes the
  audio drive source in real time without manual intervention.
  A clip's AUDIO SOURCE node overrides global priority ONLY for audio
  bindings within that clip's own effect graph.

D. FFT PROCESSING (runs every requestAnimationFrame)
  1. getByteFrequencyData → Uint8Array[1024]
  2. Map to 8 named bands using logarithmic frequency bin mapping:
       Band 0 Sub-bass   20–60Hz      bins ~0–2
       Band 1 Bass       60–250Hz     bins ~2–11
       Band 2 Low-mid    250–500Hz    bins ~11–22
       Band 3 Mid        500–2000Hz   bins ~22–90
       Band 4 Upper-mid  2000–4000Hz  bins ~90–180
       Band 5 Presence   4000–6000Hz  bins ~180–270
       Band 6 Brilliance 6000–20000Hz bins ~270–1024
       Band 7 RMS overall (computed separately from full spectrum)
  3. Each band: RMS of bins in range, normalised 0.0–1.0
  4. Smoothing via exponential moving average:
       Attack:  alpha = 0.3 (fast response to loud events)
       Release: alpha = 0.1 (slow decay — tails linger visually)
       smoothed = current * alpha + previous * (1 - alpha)
       (attack/release alpha chosen based on whether current > previous)
  5. Peak hold per band: track peak, decay 2dB/frame, shown in Scopes tab
  6. All values uploaded to WebGL every frame:
       u_audio_bands[0..7], u_audio_rms, u_audio_bass, u_audio_mid,
       u_audio_treble (aliases for bands 1, 3, 6)

E. BEAT DETECTION
  Algorithm: energy comparison
    current_bass = u_audio_bands[1] (post-smoothing)
    rolling_average = EMA of current_bass over 43 frames (alpha = 0.05)
    beat fires when current_bass > rolling_average * 1.3
  u_beat: set to 1.0 on beat, multiplied by 0.85 every frame (fast decay)
  u_beat_count: integer, increments on every detected beat
  Beat is available as a binding source in the Audio Bind Modal

F. AUDIO / VIDEO SYNC
  When an audio track is active and AudioContext is running:
    video.currentTime is kept in sync with audioContext.currentTime
    Drift tolerance: 2 frames (2 × 1/fps seconds)
    If drift exceeds tolerance: force-snap video.currentTime
  When no audio is active:
    video advances by (1/fps × playbackSpeed) per wall-clock frame delta
  On tab restore after being hidden:
    AudioContext.resume() is called
    video.currentTime is re-synced to audioContext.currentTime
    If audio context was suspended by browser, a "Click to Resume Audio"
    button appears overlaid on the preview canvas (required by browser policy)

G. SILENCE / NO AUDIO STATE
  When priority resolution results in silence (Priority 4):
    All u_audio_bands values are 0.0
    u_audio_rms = 0.0, u_beat = 0.0
    Scopes tab shows flat line bars + "NO AUDIO SOURCE" label
    Bound sliders show 0.0 (or their offset value if offset > 0)
    No warning or error is shown — this is a normal state

H. AUDIO LATENCY COMPENSATION
  Global offset control in Media Pool [Audio] tab:
    Range: −500ms to +500ms, default 0ms, step 1ms
  Positive offset: audio analysis leads the video (compensates for
    output device latency)
  Negative offset: audio analysis lags the video
  Implemented by delaying or advancing the FFT read relative to
  the video frame decode timing using a ring buffer of FFT snapshots

═══════════════════════════════════════════════════════════════
XVI. TIMELINE — FULL SPECIFICATION
═══════════════════════════════════════════════════════════════

A. LAYOUT
- Horizontal scrollable ruler: time in seconds + frame numbers
- Zoom: Ctrl+scroll on ruler, range 1px/frame to 1px/minute
- Playhead: red vertical line, draggable by clicking anywhere on ruler
- Track rows stacked vertically:
    [Track header 160px wide]  [Clip region — rest of width]
- Track header contains: track name (editable), mute (M), solo (S),
  lock (L), blend mode (gear icon), color swatch, track type badge,
  drag handle (reorder tracks)

B. TRACK TYPES AND Z-ORDER
- Track z-order for compositing: BOTTOM track composites first,
  TOP track composites last (top track = frontmost in the image)
- Track 1 is at the BOTTOM of the stack (background layer)
- Tracks listed top-to-bottom in the timeline UI correspond to
  front-to-back in the composite (top UI row = front visual layer)
  This matches the convention of Premiere Pro and DaVinci Resolve.
- Track types:
    VIDEO tracks: clips shown as thumbnail strips + filename
    AUDIO tracks: clips shown as waveform visualization
    SHADER AUTOMATION tracks: keyframe curves for shader parameters

C. WAVEFORM RENDERING
- Waveforms are pre-computed once on import using OfflineAudioContext
- Rendered to an offscreen canvas at 1px per [N samples] where N adapts
  to the current zoom level
- On zoom change: waveform resamples from the pre-computed data
  (no re-decode needed)
- Stereo: both channels averaged to mono for display
  Stereo option: show both channels as separate mirrored waveforms
  (toggle in track header right-click menu)
- Waveform color: track color tint over #1a1a20 background

D. CLIP OPERATIONS
- Drag to move (snapping: clip edges, playhead, markers — hold Alt to disable)
- Drag left/right edge to TRIM:
    Default (Ripple OFF): trim edge moves, other clips unaffected
    Ripple ON (button in toolbar): trimming ripple-pushes all clips to the right
- Ctrl+drag: duplicate clip
- Right-click clip menu:
    Split at Playhead | Delete | Rename | Color Label |
    Properties (metadata popup) | Open Effect Graph |
    Save Clip Graph as Preset | Apply Preset |
    Copy Effect Graph | Paste Effect Graph |
    Bypass All Effects | Speed / Duration… | Replace File
- Minimum clip duration: 1 frame (cannot trim shorter than 1 frame)
- Overlapping clips on same track: later-starting clip composites on top
  (see Section IX-C for rendering rule)

E. EDIT MODES
- [Overwrite] mode (default): moving a clip overwrites clips it lands on
- [Insert/Ripple] mode: moving a clip pushes subsequent clips to the right
- Toggle in toolbar via [INSERT / OVERWRITE] button

F. KEYFRAME ANIMATION
- Any slider on any shader node can be keyframed:
    Right-click slider → "Add Keyframe at Playhead"
    OR right-click on keyframe row → "Add Keyframe Here"
- A dedicated keyframe row appears beneath the clip on its track,
  labeled "[node name] > [param name]"
- Keyframes shown as diamond markers on the row
- Between keyframes: the param value interpolates using the easing function
  set on each keyframe (default: Linear)
- Available easings:
    Linear | Ease In | Ease Out | Ease In-Out |
    Custom Bezier (2-handle bezier editor popup)
- Drag diamond: reposition in time (horizontal) and value (vertical)
- Keyframe value range on the row maps to the param's min/max
- Right-click keyframe:
    Edit Value (numeric input) | Edit Time | Set Easing | Delete Keyframe |
    Copy Keyframe | Paste Keyframe
- Keyframe curves MOVE WITH THE CLIP when the clip is moved on the timeline
- Keyframes outside the clip's trimmed range are PRESERVED (not deleted) —
  they reactivate if the clip is extended back to cover them
- If a shader node is DELETED: all keyframes for that node's params are also
  deleted (after confirmation: "This will also delete N keyframes. Proceed?")
- Keyframe automation and audio binding are mutually exclusive on the same
  param: if a keyframe exists, audio binding is disabled for that param
  (and vice versa — a warning explains this when the user tries to add both)

G. MARKERS
- Press M at playhead position to add a marker
- Markers shown as colored triangles on the ruler
- Right-click marker → set color | set label | delete
- Click marker: playhead jumps to marker time

H. IN/OUT POINTS
- I key: set in-point at playhead
- O key: set out-point at playhead
- Highlighted region shown on ruler (semi-transparent tint)
- Export honors in/out range by default
- [Clear In/Out] button in toolbar

═══════════════════════════════════════════════════════════════
XVII. INSPECTOR PANEL (Right Panel)
═══════════════════════════════════════════════════════════════

Context-sensitive. Always shows one of these states:

WHEN A NODE IS SELECTED:
  - Node name (inline editable, Enter to confirm)
  - All @param sliders mirrored from the node card (fully in sync —
    changing either one updates the other instantly)
  - Blend mode for this node's output (dropdown)
  - Bypass toggle
  - Texture resolution override for this node's output FBO
    (default: match canvas resolution; can be reduced for performance)
  - [Set as Preview] button → sets this node as the tap point
  - [👁 Preview This Node] shortcut

WHEN A CLIP IS SELECTED ON TIMELINE:
  - Filename (non-editable) + [Replace File] button
  - Resolution, fps, duration (metadata)
  - In/Out trim controls (timecode numeric inputs)
  - Speed: slider 0.1–400%, numeric input
  - Opacity: slider 0–100%
  - Transform: Position X/Y, Scale X/Y, Rotation (with reset buttons)
  - Blend mode: dropdown (same 30 modes as in Section IX-F)
  - [Open Effect Graph] button → switches Node Editor to this clip's graph

WHEN A TRACK IS SELECTED (click track header):
  - Track name (editable)
  - Track type label
  - Track blend mode dropdown
  - Track opacity slider

WHEN NOTHING IS SELECTED:
  - Project settings:
      FPS (dropdown: 23.976 | 24 | 25 | 29.97 | 30 | 48 | 50 | 59.94 | 60)
      Canvas resolution (mirrors toolbar selector)
      Color space label (sRGB — informational only)
  - WebGL info: renderer string, max texture size, key extension support
  - Audio settings: sample rate, FFT size, smoothing coefficient
  - Global shader settings: confirm all shaders use precision highp float,
    dithering on/off toggle (adds a subtle noise pass after final output
    to reduce banding on gradients)

═══════════════════════════════════════════════════════════════
XVIII. BUILT-IN SHADER NODE LIBRARY — ALL 23 NODES
═══════════════════════════════════════════════════════════════

HARD REQUIREMENTS FOR ALL SHADERS:
  - Every shader begins with: #version 300 es
  - Every shader declares: precision highp float;
  - Every shader declares ALL standard uniforms from Section VIII-C
    (unused uniforms are declared but simply not referenced — no warning)
  - All @param directives are present above their uniforms
  - Output via: out vec4 fragColor; (WebGL2 style, no gl_FragColor)
  - Every shader is fully working and tested — no stubs, no placeholders

──────────────────────────────────────────────────────────────
1. VIDEO INPUT (Source — locked, cannot delete)
   Special node. Outputs current video file frame as texture.
   No user params. Output socket: [video texture]

──────────────────────────────────────────────────────────────
2. CAMERA INPUT (Source — locked, cannot delete)
   Special node for live camera feeds.
   All params via @param (see Section VI-A for full list).
   Output socket: [camera texture]

──────────────────────────────────────────────────────────────
3. AUDIO VISUALIZER (Source / Overlay Generator)
   Generates a frequency/waveform visualization rendered as a texture.
   // @param name="Visualizer Type" type=select
   //   options=bars,waveform,circle,lissajous default=bars
   uniform int   u_viz_type;
   // @param name="Position X" min=0.0 max=1.0 default=0.5
   uniform float u_pos_x;
   // @param name="Position Y" min=0.0 max=1.0 default=0.8
   uniform float u_pos_y;
   // @param name="Scale" min=0.1 max=2.0 default=1.0
   uniform float u_scale;
   // @param name="Color" type=color default=#00e5ff
   uniform vec3  u_viz_color;
   // @param name="Opacity" min=0.0 max=1.0 default=0.8
   uniform float u_opacity;
   // @param name="Bar Count" min=8.0 max=256.0 default=64.0 step=1.0
   uniform float u_bar_count;
   Output socket: [visualizer texture] (premultiplied alpha, composites over)

──────────────────────────────────────────────────────────────
4. OUTPUT (Sink — locked, cannot delete)
   Accepts final texture, passes to compositor.
   Input socket: [texture]

──────────────────────────────────────────────────────────────
5. EDGE DETECTION
   Sobel operator on luminance channel.
   // @param name="Threshold" min=0.0 max=1.0 default=0.1
   uniform float u_threshold;
   // @param name="Strength" min=0.0 max=5.0 default=1.0
   uniform float u_strength;
   // @param name="Edge Color" type=color default=#ffffff
   uniform vec3  u_edge_color;
   // @param name="Background Alpha" min=0.0 max=1.0 default=0.0
   uniform float u_bg_alpha;
   // @param name="Invert" type=bool default=false
   uniform bool  u_invert;
   // @param name="Blend Mode" type=select options=over,add,multiply default=over
   uniform int   u_blend_mode;

──────────────────────────────────────────────────────────────
6. COLOR INVERSION / HSV
   Per-channel invert + HSV adjustment.
   // @param name="Invert R" type=bool default=true
   uniform bool  u_inv_r;
   // @param name="Invert G" type=bool default=true
   uniform bool  u_inv_g;
   // @param name="Invert B" type=bool default=true
   uniform bool  u_inv_b;
   // @param name="Hue Shift" min=0.0 max=360.0 default=0.0
   uniform float u_hue_shift;
   // @param name="Saturation" min=0.0 max=2.0 default=1.0
   uniform float u_saturation;
   // @param name="Value" min=0.0 max=2.0 default=1.0
   uniform float u_value;
   // @param name="Alpha" min=0.0 max=1.0 default=1.0
   uniform float u_alpha;

──────────────────────────────────────────────────────────────
7. GLITCH / DATAMOSH
   Compression artifact simulation + block displacement.
   // @param name="Intensity" min=0.0 max=1.0 default=0.3
   // @audiobind band=beat multiplier=1.0 offset=0.0
   uniform float u_intensity;
   // @param name="Block Size" min=1.0 max=64.0 default=16.0 step=1.0
   uniform float u_block_size;
   // @param name="Scanline Count" min=0.0 max=200.0 default=80.0
   uniform float u_scanline_count;
   // @param name="RGB Shift" min=0.0 max=50.0 default=5.0
   uniform float u_rgb_shift;
   // @param name="Digital Noise" min=0.0 max=1.0 default=0.1
   uniform float u_digital_noise;
   // @param name="Time Seed" type=bool default=true
   uniform bool  u_time_seed;

──────────────────────────────────────────────────────────────
8. FEEDBACK LOOP
   Blends current frame with u_prev_frame for infinite mirror trails.
   // @param name="Feedback Amount" min=0.0 max=0.99 default=0.85
   // @audiobind band=bass multiplier=0.1 offset=0.8
   uniform float u_feedback_amount;
   // @param name="Zoom Feedback" min=0.9 max=1.1 default=1.005
   uniform float u_zoom_feedback;
   // @param name="Rotation Per Frame" min=-5.0 max=5.0 default=0.0
   uniform float u_rotation;
   // @param name="Blur Feedback" min=0.0 max=5.0 default=0.5
   uniform float u_blur_feedback;
   // @param name="Hue Rotate Per Frame" min=0.0 max=360.0 default=0.0
   uniform float u_hue_rotate;

──────────────────────────────────────────────────────────────
9. KALEIDOSCOPE
   // @param name="Segments" min=2.0 max=32.0 default=6.0 step=1.0
   uniform float u_segments;
   // @param name="Zoom" min=0.1 max=5.0 default=1.0
   uniform float u_zoom;
   // @param name="Rotation" min=0.0 max=360.0 default=0.0
   // @audiobind band=mid multiplier=180.0 offset=0.0
   uniform float u_rotation;
   // @param name="Offset X" min=-1.0 max=1.0 default=0.0
   uniform float u_offset_x;
   // @param name="Offset Y" min=-1.0 max=1.0 default=0.0
   uniform float u_offset_y;

──────────────────────────────────────────────────────────────
10. PIXEL SORT
    // @param name="Threshold" min=0.0 max=1.0 default=0.5
    uniform float u_threshold;
    // @param name="Angle" min=0.0 max=360.0 default=0.0
    uniform float u_angle;
    // @param name="Sort By" type=select options=luminance,red,hue default=luminance
    uniform int   u_sort_by;
    // @param name="Mask Alpha" min=0.0 max=1.0 default=1.0
    uniform float u_mask_alpha;
    // @param name="Direction" type=select options=horizontal,vertical default=horizontal
    uniform int   u_direction;

──────────────────────────────────────────────────────────────
11. CHROMATIC ABERRATION
    // @param name="Red Offset X" min=-50.0 max=50.0 default=3.0
    uniform float u_r_offset_x;
    // @param name="Red Offset Y" min=-50.0 max=50.0 default=0.0
    uniform float u_r_offset_y;
    // @param name="Blue Offset X" min=-50.0 max=50.0 default=-3.0
    uniform float u_b_offset_x;
    // @param name="Blue Offset Y" min=-50.0 max=50.0 default=0.0
    uniform float u_b_offset_y;
    // @param name="Barrel Distortion" min=0.0 max=1.0 default=0.0
    uniform float u_barrel;
    // @param name="Vignette" min=0.0 max=1.0 default=0.2
    // @audiobind band=beat multiplier=0.5 offset=0.0
    uniform float u_vignette;

──────────────────────────────────────────────────────────────
12. BLOOM / GLOW
    Multi-pass gaussian blur composited additively.
    // @param name="Threshold" min=0.0 max=1.0 default=0.6
    uniform float u_threshold;
    // @param name="Radius" min=1.0 max=50.0 default=10.0
    uniform float u_radius;
    // @param name="Intensity" min=0.0 max=5.0 default=1.5
    // @audiobind band=bass multiplier=2.0 offset=0.5
    uniform float u_intensity;
    // @param name="Color Tint" type=color default=#ffffff
    uniform vec3  u_tint;
    // @param name="Iterations" min=1.0 max=8.0 default=4.0 step=1.0
    uniform float u_iterations;

──────────────────────────────────────────────────────────────
13. CRT / SCANLINES
    // @param name="Scanline Count" min=100.0 max=2000.0 default=600.0
    uniform float u_scanline_count;
    // @param name="Curvature" min=0.0 max=1.0 default=0.2
    uniform float u_curvature;
    // @param name="Vignette Intensity" min=0.0 max=2.0 default=0.8
    uniform float u_vignette;
    // @param name="Phosphor Glow" min=0.0 max=2.0 default=0.5
    uniform float u_phosphor;
    // @param name="Flicker Speed" min=0.0 max=10.0 default=0.0
    uniform float u_flicker;
    // @param name="Noise" min=0.0 max=1.0 default=0.05
    uniform float u_noise;

──────────────────────────────────────────────────────────────
14. VORONOI / CELLULAR
    // @param name="Cell Count" min=2.0 max=200.0 default=30.0
    // @audiobind band=mid multiplier=50.0 offset=10.0
    uniform float u_cell_count;
    // @param name="Edge Thickness" min=0.0 max=0.2 default=0.02
    uniform float u_edge_thickness;
    // @param name="Animate Speed" min=0.0 max=5.0 default=1.0
    uniform float u_animate_speed;
    // @param name="Color Mode" type=select options=edges,cells,distance default=edges
    uniform int   u_color_mode;
    // @param name="Blend with Source" min=0.0 max=1.0 default=0.5
    uniform float u_blend;

──────────────────────────────────────────────────────────────
15. FLUID WARP
    Curl-noise based distortion.
    // @param name="Warp Strength" min=0.0 max=5.0 default=1.0
    // @audiobind band=bass multiplier=2.0 offset=0.0
    uniform float u_warp_strength;
    // @param name="Warp Scale" min=0.1 max=10.0 default=2.0
    uniform float u_warp_scale;
    // @param name="Warp Speed" min=0.0 max=5.0 default=0.5
    uniform float u_warp_speed;
    // @param name="Octaves" min=1.0 max=8.0 default=4.0 step=1.0
    uniform float u_octaves;

──────────────────────────────────────────────────────────────
16. HALFTONE
    // @param name="Dot Size" min=1.0 max=50.0 default=8.0
    uniform float u_dot_size;
    // @param name="Angle" min=0.0 max=90.0 default=45.0
    uniform float u_angle;
    // @param name="Shape" type=select options=circle,square,line default=circle
    uniform int   u_shape;
    // @param name="Background Color" type=color default=#000000
    uniform vec3  u_bg_color;
    // @param name="Foreground Color" type=color default=#ffffff
    uniform vec3  u_fg_color;
    // @param name="Channel" type=select options=luminance,r,g,b default=luminance
    uniform int   u_channel;
    // @param name="Blend" min=0.0 max=1.0 default=1.0
    uniform float u_blend;

──────────────────────────────────────────────────────────────
17. THRESHOLD / POSTERIZE
    // @param name="Levels" min=1.0 max=32.0 default=4.0 step=1.0
    uniform float u_levels;
    // @param name="Threshold" min=0.0 max=1.0 default=0.5
    uniform float u_threshold;
    // @param name="Dither" type=select
    //   options=none,bayer2,bayer4,bayer8,floyd-steinberg default=none
    uniform int   u_dither;
    // @param name="Palette" type=select
    //   options=monochrome,duotone,rgb default=monochrome
    uniform int   u_palette;

──────────────────────────────────────────────────────────────
18. DEPTH-BASED BLUR (Simulated)
    // @param name="Focal Point X" min=0.0 max=1.0 default=0.5
    uniform float u_focal_x;
    // @param name="Focal Point Y" min=0.0 max=1.0 default=0.5
    uniform float u_focal_y;
    // @param name="Focal Radius" min=0.0 max=1.0 default=0.2
    uniform float u_focal_radius;
    // @param name="Blur Radius" min=1.0 max=50.0 default=10.0
    uniform float u_blur_radius;
    // @param name="Depth From" type=select options=luminance,red default=luminance
    uniform int   u_depth_from;
    // @param name="Invert Depth" type=bool default=false
    uniform bool  u_invert_depth;

──────────────────────────────────────────────────────────────
19. MIRROR / SYMMETRY
    // @param name="Axis" type=select
    //   options=horizontal,vertical,quad,radial default=horizontal
    uniform int   u_axis;
    // @param name="Offset X" min=-1.0 max=1.0 default=0.0
    uniform float u_offset_x;
    // @param name="Offset Y" min=-1.0 max=1.0 default=0.0
    uniform float u_offset_y;
    // @param name="Flip Source" type=bool default=false
    uniform bool  u_flip_source;

──────────────────────────────────────────────────────────────
20. PARTICLE DISPLACEMENT
    // @param name="Particle Count" min=100.0 max=10000.0 default=2000.0 step=100.0
    uniform float u_particle_count;
    // @param name="Force Strength" min=0.0 max=5.0 default=1.0
    // @audiobind band=bass multiplier=3.0 offset=0.0
    uniform float u_force_strength;
    // @param name="Particle Size" min=1.0 max=20.0 default=3.0
    uniform float u_particle_size;
    // @param name="Life Decay" min=0.0 max=1.0 default=0.02
    uniform float u_life_decay;
    // @param name="Gravity X" min=-1.0 max=1.0 default=0.0
    uniform float u_gravity_x;
    // @param name="Gravity Y" min=-1.0 max=1.0 default=-0.1
    uniform float u_gravity_y;
    // @param name="Color from Source" type=bool default=true
    uniform bool  u_color_from_source;

──────────────────────────────────────────────────────────────
21. LUT (Color Lookup Table)
    Named cinematic LUT presets (all 16 must be implemented as
    hardcoded 3D lookup tables in the shader):
      0: Identity (no change)        1: Cinematic Cool
      2: Cinematic Warm              3: Desaturate
      4: High Contrast               5: Faded Film
      6: Noir (B&W)                  7: Neon Pop
      8: Sunset                      9: Cyberpunk
     10: Forest Green               11: Bleach Bypass
     12: Amber Shadow               13: Cold Steel
     14: Deep Night                 15: Vivid Dream
    // @param name="LUT Preset" type=select
    //   options=Identity,Cinematic Cool,Cinematic Warm,Desaturate,
    //   High Contrast,Faded Film,Noir,Neon Pop,Sunset,Cyberpunk,
    //   Forest Green,Bleach Bypass,Amber Shadow,Cold Steel,
    //   Deep Night,Vivid Dream default=Identity
    uniform int   u_lut_preset;
    // @param name="Intensity" min=0.0 max=1.0 default=1.0
    uniform float u_intensity;

──────────────────────────────────────────────────────────────
22. MATH / BLEND
    Logic node — composites two texture inputs. No custom GLSL required.
    Inputs: [texture A] (primary, left socket)
            [texture B] (secondary, right socket)
    If texture B input is unconnected: falls back to a black texture.
    If texture A input is unconnected: falls back to a black texture.
    Mismatched resolutions: texture B is stretched/scaled to match
    texture A's resolution using bilinear filtering before blending.
    // @param name="Blend Mode" type=select
    //   options=Normal,Multiply,Screen,Overlay,Soft Light,Hard Light,
    //   Color Dodge,Color Burn,Linear Dodge,Linear Burn,Difference,
    //   Exclusion,Hue,Saturation,Color,Luminosity,Add,Subtract,
    //   Divide,Darken,Lighten,Vivid Light,Linear Light,Pin Light,
    //   Hard Mix,Dissolve,Plus,Minus,Darker Color,Lighter Color
    //   default=Normal
    uniform int   u_blend_mode;
    // @param name="Mix" min=0.0 max=1.0 default=1.0
    uniform float u_mix;
    // @param name="Alpha" min=0.0 max=1.0 default=1.0
    uniform float u_alpha;

──────────────────────────────────────────────────────────────
23. CUSTOM SHADER
    User writes own GLSL from scratch.
    Pre-filled with the exact boilerplate from Section XIII-C.
    All params defined entirely by user via @param directives.
    No restrictions on shader complexity.
    No default audio bindings.

═══════════════════════════════════════════════════════════════
XIX. SCOPES AND MONITORING
═══════════════════════════════════════════════════════════════

[Scopes] toggle in toolbar opens a floating, repositionable overlay panel.

Contents:
  - Waveform monitor: luminance or RGB parade, selectable via dropdown
  - Vectorscope: circular IQ/UV color gamut plot
  - Histogram: RGBA channels displayed as stacked color-coded bars

Implementation:
  - All scopes drawn on a secondary <canvas> (2D context)
  - Data source: gl.readPixels from the current output FBO
    (the pixel data at the current tap point, not necessarily the final output)
  - Update rate: every rendered frame (same as main render loop)
  - The scopes panel is transparent and overlays the preview canvas
    OR can be detached and floated anywhere in the window

═══════════════════════════════════════════════════════════════
XX. PROJECT SAVE / LOAD AND AUTOSAVE
═══════════════════════════════════════════════════════════════

A. SAVE FORMAT — full JSON schema:
{
  "version": "3.0",
  "schemaVersion": 3,
  "projectSettings": {
    "fps": 30,
    "resolution": { "width": 1920, "height": 1080 },
    "colorSpace": "sRGB"
  },
  "timeline": {
    "tracks": [
      {
        "id": "...", "name": "...", "type": "video|audio|automation",
        "muted": false, "solo": false, "locked": false,
        "blendMode": "Normal", "opacity": 1.0, "color": "#hex",
        "zOrder": 0
      }
    ],
    "clips": [
      {
        "id": "...", "trackId": "...",
        "filename": "clip.mp4",
        "timelineStart": 0.0, "timelineEnd": 10.0,
        "sourceStart": 0.0, "sourceEnd": 10.0,
        "speed": 1.0, "opacity": 1.0, "blendMode": "Normal",
        "transform": { "x":0, "y":0, "scaleX":1, "scaleY":1, "rotation":0 },
        "clipGraph": {
          "nodes": [
            { "id":"...", "type":"...", "position":{"x":0,"y":0},
              "params": { "u_intensity": 0.5 },
              "shaderCode": "...(full GLSL source string)...",
              "bypassed": false,
              "previewTapPoint": false }
          ],
          "edges": [
            { "fromNode":"...", "fromSocket":"output",
              "toNode":"...", "toSocket":"input" }
          ],
          "tapPointNodeId": "...",
          "exposedParams": []
        }
      }
    ],
    "markers": [{ "id":"...", "time":0.0, "label":"...", "color":"#hex" }],
    "inPoint": 0.0,
    "outPoint": null
  },
  "masterGraph": {
    "nodes": [...], "edges": [...],
    "tapPointNodeId": "...",
    "compoundInstances": [...]
  },
  "compoundLibrary": [
    {
      "id": "...", "name": "...", "version": 1,
      "subGraph": { "nodes": [...], "edges": [...] },
      "exposedParams": [
        { "displayName":"...", "exposedMin":0, "exposedMax":1,
          "mappings": [
            { "nodeId":"...", "uniformName":"...",
              "scaleFactor":1.0, "offset":0.0 }
          ]
        }
      ]
    }
  ],
  "audioBindings": [
    {
      "graphContext": "master|clip:[clipId]",
      "nodeId": "...", "paramName": "...",
      "bandIndex": 1, "multiplier": 1.0,
      "offset": 0.0, "invert": false
    }
  ],
  "keyframes": [
    {
      "clipId": "...", "nodeId": "...", "paramName": "...",
      "keys": [
        { "time": 0.0, "value": 0.5,
          "easing": "ease-in-out",
          "bezierHandles": [[0.42,0],[0.58,1]] }
      ]
    }
  ],
  "cameraDevices": [
    { "deviceId": "...", "label": "...", "lastResolution": "1080p" }
  ],
  "audioSettings": {
    "latencyOffset": 0,
    "masterGain": 1.0
  },
  "uiState": {
    "panelSizes": { "mediaPool": 280, "inspector": 320,
                    "nodeEditor": 420, "timeline": 240 },
    "panelCollapsed": { "nodeEditor": false, "timeline": false }
  }
}

B. SCHEMA MIGRATION
- On project load, read "schemaVersion" field
- If schemaVersion < current (3): run migration functions:
    v1 → v2: add clipGraph field to all clips (initialise as pass-through)
    v2 → v3: add cameraDevices[], audioSettings{}, uiState{}
- After migration, mark project as "unsaved changes" (amber indicator)
- Old project files always open correctly — never show an error for older versions

C. AUTOSAVE
- Autosave fires every 60 seconds to IndexedDB key: "autosave_[projectId]"
- Also autosaves before any destructive operation (delete track, clear all)
- 3 autosave slots per project (rotating: oldest overwritten)
- On app load: check if autosave is newer than last manual save.
  If so: prompt "Recover unsaved session from [timestamp]? [Recover] [Discard]"
- Autosave does NOT overwrite the manual save slot

D. CAMERA DEVICE RELINK
- Camera deviceIds can change between sessions (browser/OS behaviour)
- On project load with camera clips:
    Enumerate current devices via enumerateDevices()
    Match by label string (more stable than deviceId across sessions)
    If label matches but deviceId changed: silently update deviceId
    If no label match found: show "Relink Camera" dialog:
      "Camera '[old label]' not found. Select a replacement:"
      [dropdown of current camera devices] [Skip] [Use Mic Instead]

E. MEDIA RELINK
- Video files stored by filename only (no absolute path)
- On load: search for file in the last known directory
  If not found: "Relink Media" dialog:
    Lists all missing files
    [Browse for file] button per missing file
    [Auto-search folder] — user picks a folder, app scans it recursively
    [Skip] — clip appears as offline (red ✕ badge on timeline) but
              project still loads; offline clips render as black frames

═══════════════════════════════════════════════════════════════
XXI. PERFORMANCE REQUIREMENTS
═══════════════════════════════════════════════════════════════

- Full render loop targets 60fps on modern GPU/CPU at 1080p
- Each shader node targets <2ms GPU time
- GL loop runs entirely in a requestAnimationFrame ref (not in React state)
- React state updates throttled to 30fps (sliders, meters, timecode)
- Monaco editor loads lazily on first </> click
- 4K source video: createImageBitmap for async frame decode (off main thread)
- GPU texture uploads skipped when video is paused (no redundant texSubImage2D)
- Paused state: render loop drops to 10fps (setTimeout) to save resources
- Tab hidden: render loop pauses entirely (cancelAnimationFrame)
- Thumbnail extraction throttled to 12fps (every 5 main frames)
- Shader programs cached by MD5 hash — no redundant recompilation
- GPU time budget warning >16ms total frame time, with per-clip breakdown
- Minimum viewport: 1280×768; warning overlay shown below this

═══════════════════════════════════════════════════════════════
XXII. POLISH AND UX REQUIREMENTS
═══════════════════════════════════════════════════════════════

- All panel transitions: cubic-bezier(0.4, 0, 0.2, 1) at 200ms
- Node Editor empty state: ghost text instructions on first launch
- Drag effect from Media Pool → Node Editor: auto-create + auto-connect
- Drag compound onto timeline clip → install as clip effect graph
- ? key: opens keyboard shortcuts reference panel
- Right-click anywhere on Node Editor canvas: searchable node picker
  (type to filter all 23 types + presets + compounds, keyboard navigable)
- Every destructive action requires confirmation dialog
- Toast notifications:
    Compile errors (red) | Successful saves (green) | Unsupported files (amber)
    GPU budget exceeded (amber) | Camera events (blue) | Beat detections (silent)
- Loading spinner on video decode + first-frame render
- All controls have tooltips (250ms delay, dark styled tooltip component)
- "Welcome" modal on very first launch with 3-step quick-start guide
- Camera thumbnails update at 4fps in Media Pool and timeline headers
- Frame-accurate scrubbing: clicking timeline ruler updates video.currentTime
  immediately and triggers a single render pass to show the correct frame
- When entering clip graph context: preview immediately switches to isolated mode
- When exiting clip graph context: preview immediately returns to master output
- Keyboard shortcuts (non-exhaustive, all must work):
    Space: Play/Pause
    I / O: Set in/out point
    M: Add marker
    Delete: Delete selected node or clip
    Ctrl+Z / Ctrl+Y: Undo / Redo
    Ctrl+G: Group selected nodes into compound
    Ctrl+D: Duplicate selected nodes
    Ctrl+A: Select all
    Escape: Exit sub-graph / clip graph / split-compare mode
    ?: Keyboard shortcuts help panel
    F: Fit node editor to window
    [ / ]: Step back/forward one frame
    Ctrl+S: Save project

═══════════════════════════════════════════════════════════════
XXIII. STRETCH GOALS (implement if capacity allows, in priority order)
═══════════════════════════════════════════════════════════════

1. MIDI input: map MIDI CC messages to any shader parameter slider
   (Web MIDI API — navigator.requestMIDIAccess)
   MIDI Learn mode: click "MIDI Learn" on any slider, move a CC knob,
   mapping is stored per-project

2. Expression language: type a math expression in any param field instead
   of a static value, e.g. "sin(u_time * 2.0) * 0.5 + 0.5"
   Evaluated per frame as a float, supporting all standard uniforms as variables

3. Texture input node: import a still image (PNG, JPG, EXR) as a texture
   source (logos, masks, noise maps) for use in the node graph

4. OSC input: receive OSC messages over a local WebSocket bridge to drive
   parameters from external tools (TouchDesigner, Ableton, etc.)

5. GPU-instanced particle rendering for the Particle Displacement node

6. Multiple OUTPUT nodes in the master graph: A/B split-screen comparison
   between two different processing branches

7. Collaborative editing: two users in the same project via WebRTC data
   channel — node graph and timeline changes sync in real time

8. FFmpeg WASM integration: in-browser MP4/H.264 export without requiring
   a separate post-processing step

═══════════════════════════════════════════════════════════════
XXIV. PROJECT FILE STRUCTURE
═══════════════════════════════════════════════════════════════

Build as a single-page React application using Vite.

/src
  /components
    /NodeEditor
      NodeCanvas.jsx        (infinite pan/zoom canvas, dot-grid bg)
      NodeCard.jsx          (individual node card with sockets, sliders)
      Noodle.jsx            (bezier cable SVG, marching ants animation)
      Socket.jsx            (input/output socket with hover glow)
      CompoundNode.jsx      (compound node card, star badge, sub-graph nav)
      SubGraphEditor.jsx    (breadcrumb, sub-graph overlay canvas)
      NodeSearchMenu.jsx    (right-click searchable node picker)
    /Timeline
      TimelineRuler.jsx     (time ruler, markers, in/out handles)
      TrackRow.jsx          (track header + clip region)
      ClipBlock.jsx         (clip rectangle, thumbnail, FX badge)
      KeyframeRow.jsx       (keyframe diamonds, easing curve display)
      WaveformCanvas.jsx    (audio waveform drawn to canvas)
    /Preview
      PreviewCanvas.jsx     (WebGL canvas, overlay indicators, borders)
      PreviewOverlays.jsx   (tap point label, context badges, error banner)
      SplitCompare.jsx      (before/after split scrubber UI)
    /Inspector
      Inspector.jsx         (context switcher)
      NodeInspector.jsx     (node params, set-as-preview button)
      ClipInspector.jsx     (clip metadata, transform, blend)
      TrackInspector.jsx    (track blend mode, opacity)
      ProjectInspector.jsx  (fps, resolution, webgl info)
    /MediaPool
      MediaPool.jsx         (5-tab container)
      VideoTab.jsx
      CameraTab.jsx
      AudioTab.jsx
      EffectsTab.jsx
      ScopesTab.jsx
    /Toolbar
      Toolbar.jsx           (playback, import, export, resolution)
      ExportModal.jsx       (full export dialog)
    /ShaderEditor
      MonacoDrawer.jsx      (Monaco wrapper, slide-in drawer)
      GLSLTokenizer.js      (Monaco language registration)
      BoilerplateTemplate.js (Custom Shader default code string)
    /Scopes
      ScopeOverlay.jsx      (waveform, vectorscope, histogram)
  /shaders
    /nodes
      01_videoInput.glsl.js
      02_cameraInput.glsl.js
      03_audioVisualizer.glsl.js
      04_edgeDetection.glsl.js
      05_colorInversion.glsl.js
      06_glitchDatamosh.glsl.js
      07_feedbackLoop.glsl.js
      08_kaleidoscope.glsl.js
      09_pixelSort.glsl.js
      10_chromaticAberration.glsl.js
      11_bloom.glsl.js
      12_crt.glsl.js
      13_voronoi.glsl.js
      14_fluidWarp.glsl.js
      15_halftone.glsl.js
      16_threshold.glsl.js
      17_depthBlur.glsl.js
      18_mirror.glsl.js
      19_particleDisplace.glsl.js
      20_lut.glsl.js
      21_mathBlend.glsl.js
    /compounds
      psychedelicPulse.json
      digitalDecay.json
      acidVision.json
      mirrorStorm.json
      signalGhost.json
      bassReactor.json
  /audio
    AudioEngine.js          (Web Audio API, FFT, 8 bands, beat, priority)
  /gl
    Renderer.js             (WebGL state machine, 2-level FBO chain)
    ShaderProgram.js        (compile, MD5 cache, uniform upload)
    TextureManager.js       (LRU texture unit cache, video/camera upload)
    FBOManager.js           (framebuffer allocation, ping-pong, thumbnail)
    BlendModes.glsl.js      (30 blend mode implementations as GLSL functions)
  /store
    useAppStore.js          (Zustand: project, playback, ui state)
    useGraphStore.js        (Zustand: nodes/edges for master + all clip graphs)
    useTimelineStore.js     (Zustand: tracks, clips, keyframes, markers)
    useAudioStore.js        (Zustand: band values, beat, source priority)
  /utils
    paramParser.js          (@param directive parser → slider config objects)
    topSort.js              (topological sort + cycle detection)
    compoundUtils.js        (group/ungroup, edge promotion, param exposure)
    clipGraphManager.js     (per-clip graph instantiation, isolation, compile)
    schemaMigration.js      (v1→v2→v3 project file migration)
    md5.js                  (shader source hashing for program cache)

═══════════════════════════════════════════════════════════════
FINAL MANDATE
═══════════════════════════════════════════════════════════════

Every shader in /shaders/nodes/ must be fully implemented GLSL that
compiles and runs under WebGL2 #version 300 es with precision highp float.
No shader may be a stub, a comment, or a placeholder.

Every UI panel and feature described above must be built and functional.
No feature may be deferred to a "future version" without being listed
explicitly under Section XXIII Stretch Goals.

The application must launch, load a video file, apply shader effects
via the node graph, react to audio, and export a result — end to end —
as a complete, working creative tool.

Make it real. Make it complete. Make it extraordinary.
```
