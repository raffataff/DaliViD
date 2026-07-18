/**
 * DaliVid — Renderer.js
 * Main WebGL2 rendering engine that drives the multi-pass FBO pipeline.
 * Handles the render loop, per-frame execution, and compositing.
 */

import { createShaderProgram, uploadStandardUniforms, uploadUniforms, clearProgramCache } from './ShaderProgram.js'
import { TextureManager } from './TextureManager.js'
import { FBOManager } from './FBOManager.js'
import { BLEND_MODES_GLSL, getBlendModeIndex } from './BlendModes.glsl.js'
import { compileGraph, executeChain, executeTransitionCompound, getActiveClip, getActiveClips, getClipSourceTime, resolveFloatConnections, buildNodeMap } from './clipGraphManager.js'
import { getAudioEngine } from '../audio/AudioEngine.js'
import { getCameraStream, removeCameraStream } from './cameraRegistry.js'
import { ensureNodeImage } from './imageRegistry.js'
import { onNodeRemoved } from './nodeLifecycle.js'
import { getShaderSource } from '../shaders/shaderRegistry.js'
import { buildTransitionShader, getTransitionDefaults } from '../shaders/transitionRegistry.js'
import { evaluateKeyframes } from '../utils/keyframes.js'

// Node types that are not effect passes (sources, outputs, audio routing). Used
// to decide whether a graph actually has any effects worth running.
const NON_EFFECT_TYPES = ['OUTPUT', 'CLIP_OUTPUT', 'EFFECT_OUTPUT', 'AUDIO_INPUT', 'AUDIO_SPLITTER', 'VIDEO_INPUT', 'CAMERA_INPUT', 'SCREEN_INPUT', 'CLIP_SOURCE', 'EFFECT_INPUT', 'TRANSITION_PROGRESS', 'ENVELOPE']

// Passthrough fragment shader — just copies input texture
const PASSTHROUGH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
out vec4 fragColor;
void main() {
  fragColor = texture(u_texture, v_uv);
}
`

// Composite shader — blends source over destination with blend mode
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_blend;
uniform int u_blend_mode;
uniform float u_opacity;
out vec4 fragColor;

${BLEND_MODES_GLSL}

// Per-pixel hash for the Dissolve blend mode. The scaled sin-hash decorrelates
// adjacent pixels, so no resolution uniform is needed.
float compositeHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 base = texture(u_base, v_uv);
  vec4 blend = texture(u_blend, v_uv);
  // Dissolve (mode 1): a stochastic per-pixel threshold — each pixel shows the
  // blend layer fully or the backdrop, with probability = the blend's effective
  // alpha. The classic grainy dissolve rather than a smooth blend.
  if (u_blend_mode == 1) {
    float a = blend.a * u_opacity;
    fragColor = compositeHash(v_uv) < a ? vec4(blend.rgb, 1.0) : base;
    return;
  }
  fragColor = applyBlendMode(base, blend, u_blend_mode, u_opacity);
}
`

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas — the preview canvas element
   */
  constructor(canvas) {
    this.canvas = canvas
    this.gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    })

    if (!this.gl) {
      throw new Error('WebGL2 not supported in this browser')
    }

    const gl = this.gl

    // Extension support info
    this.extensions = {
      halfFloat: !!gl.getExtension('EXT_color_buffer_half_float'),
      halfFloatLinear: !!gl.getExtension('OES_texture_half_float_linear'),
      debugRenderer: gl.getExtension('WEBGL_debug_renderer_info'),
      loseContext: gl.getExtension('WEBGL_lose_context'),
      timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    }

    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)
    this.rendererString = this.extensions.debugRenderer
      ? gl.getParameter(this.extensions.debugRenderer.UNMASKED_RENDERER_WEBGL)
      : 'Unknown'

    // Sub-systems
    this.textures = new TextureManager(gl)
    this.fbos = new FBOManager(gl)

    // Free a removed node's GPU resources (output/feedback FBOs, image FBO+texture,
    // and any compound inner FBOs). Covers deletions from any graph — including
    // master-graph nodes, which never pass through releaseClipResources and would
    // otherwise leak until dispose. Unsubscribed in dispose().
    this._unsubNodeRemoval = onNodeRemoved((node) => this.releaseNodeResources(node))

    // Full-screen quad VAO
    this.quadVAO = this._createQuadVAO()

    // Built-in programs
    this.passthroughProgram = null
    this.compositeProgram = null
    this.imageProgram = null
    this._initBuiltinPrograms()

    // Transition shaders: cache the assembled SOURCE per type (null = unknown
    // type), not the program object — createShaderProgram is re-called each
    // pass so its LRU refreshes recency and transparently recompiles if the
    // program was ever evicted. Failed compiles warn once via the Set.
    this._transitionSources = {}
    this._transitionWarned = new Set()

    // Node-graph transitions ("compound:<libId>" types): compiled sub-chain per
    // library entry, invalidated when the entry object changes (library entries
    // are replaced, never mutated, so identity comparison is sufficient).
    this._nodeTransitionChains = {}

    // State
    this.width = canvas.width
    this.height = canvas.height
    this.isPlaying = false
    this.isPaused = true
    this.isTabHidden = false
    this.startTime = 0
    this.frameCount = 0
    this.lastFrameTime = 0
    // Export overrides: when non-null, _renderFrame uses these instead of
    // wall-clock time / the live frame counter, so an offline export is
    // frame-locked and deterministic (see ExportModal).
    this._timeOverride = null
    this._frameOverride = null
    this.fps = 0
    this.fpsFrames = 0
    this.fpsLastTime = performance.now()
    this.gpuTime = 0

    // Render loop
    this.rafId = null
    this.timeoutId = null

    // Compiled node chains — set externally
    this.compiledChains = new Map() // clipId → { chain, errors }
    this.masterChain = null // { chain, errors }
    this._needsRecompile = true

    // When true, a node's Preview button can override the displayed image with
    // that node's output (a "viewer tap"). Disabled during export so renders
    // always come from the OUTPUT node, never a transient preview.
    this.previewTapEnabled = true

    // Store accessors (set externally)
    this._getAppStore = null
    this._getGraphStore = null
    this._getTimelineStore = null
    this._getAudioStore = null

    // Video elements for texture upload
    this._videoElements = new Map() // clipId → HTMLVideoElement

    // Callbacks
    this.onFPSUpdate = null
    this.onFrameComplete = null

    // Visibility handling
    this._handleVisibility = this._handleVisibility.bind(this)
    document.addEventListener('visibilitychange', this._handleVisibility)
  }

  /**
   * Connect store accessors for reading state during rendering.
   */
  connectStores(appStore, graphStore, timelineStore, audioStore) {
    this._getAppStore = appStore
    this._getGraphStore = graphStore
    this._getTimelineStore = timelineStore
    this._getAudioStore = audioStore
  }

  /**
   * Register a video element for a clip.
   */
  registerVideoElement(clipId, videoElement) {
    this._videoElements.set(clipId, videoElement)
  }

  /**
   * Unregister a video element.
   */
  unregisterVideoElement(clipId) {
    this._videoElements.delete(clipId)
  }

  /**
   * Mark that graphs need recompilation (called when graph topology changes).
   */
  markDirty() {
    this._needsRecompile = true
  }

  /**
   * Create the shared full-screen quad VAO.
   * Two triangles covering clip space (-1 to 1), UVs 0 to 1.
   */
  _createQuadVAO() {
    const gl = this.gl
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)

    // Positions + UVs interleaved
    const vertices = new Float32Array([
      // position   // texcoord
      -1, -1,       0, 0,
       1, -1,       1, 0,
      -1,  1,       0, 1,
       1,  1,       1, 1,
    ])

    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)

    // a_position (location 0)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)

    // a_texcoord (location 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)

    // Index buffer for triangle strip
    const indices = new Uint16Array([0, 1, 2, 3])
    const ebo = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

    gl.bindVertexArray(null)
    return vao
  }

  /**
   * Initialize built-in shader programs.
   */
  _initBuiltinPrograms() {
    const passResult = createShaderProgram(this.gl, PASSTHROUGH_FS)
    this.passthroughProgram = passResult

    const compResult = createShaderProgram(this.gl, COMPOSITE_FS)
    this.compositeProgram = compResult

    // Image source program — the IMAGE_INPUT shader (fit/transform/reactive).
    // Single source of truth: the same registry shader the node card parses for
    // its @param sliders, so the controls always match what's rendered.
    const imgSrc = getShaderSource('IMAGE_INPUT')
    if (imgSrc) this.imageProgram = createShaderProgram(this.gl, imgSrc)
  }

  /**
   * Render an IMAGE_INPUT source node's image into its own FBO.
   * Decodes the node's data-URL image (cached), uploads it to a texture, then
   * draws it through the image program (fit/transform/audio-reactive) so it can
   * feed downstream effect nodes exactly like a video source.
   * @param {string} nodeId
   * @param {string} fboId — destination FBO (already created/resized by caller)
   * @param {object} standardState — standard uniform state for this frame
   * @param {object} params — normalized node params (u_fit, u_img_scale, … + imageSrc)
   */
  renderImageNode(nodeId, fboId, standardState, params) {
    const gl = this.gl
    if (!this.imageProgram || !this.imageProgram.program) return

    // Start from a clean transparent FBO so an unloaded image reads as nothing.
    this.fbos.bind(fboId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const src = params.imageSrc
    const entry = ensureNodeImage(nodeId, src)
    if (!entry || !entry.ready) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return
    }

    // Upload (or re-upload) the image to its texture when the source changes.
    // Clamp to the GPU's max texture size so an oversized image (e.g. loaded from
    // an old project that bypassed import-time downscaling) can't fail to upload.
    const texId = `img_${nodeId}`
    let tex = this.textures.getTexture(texId)
    if (!tex || entry.uploadedSrc !== src) {
      if (tex) this.textures.delete(texId)

      const maxTex = this.maxTextureSize || 2048
      let uploadSource = entry.img
      let uw = entry.width
      let uh = entry.height
      if (uw > maxTex || uh > maxTex) {
        const s = maxTex / Math.max(uw, uh)
        uw = Math.max(1, Math.round(uw * s))
        uh = Math.max(1, Math.round(uh * s))
        const cv = this._imageScratch || (this._imageScratch = document.createElement('canvas'))
        cv.width = uw
        cv.height = uh
        const ctx = cv.getContext('2d')
        ctx.clearRect(0, 0, uw, uh)
        ctx.drawImage(entry.img, 0, 0, uw, uh)
        uploadSource = cv
      }

      this.textures.create(texId, uw, uh)
      this.textures.uploadVideoFrame(texId, uploadSource) // handles HTMLImageElement/Canvas
      entry.uploadedSrc = src
      entry.texWidth = uw
      entry.texHeight = uh
      tex = this.textures.getTexture(texId)
    }

    gl.useProgram(this.imageProgram.program)
    const locs = this.imageProgram.uniformLocations
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (locs.u_image != null) gl.uniform1i(locs.u_image, 0)
    // Aspect is preserved by the clamp, so the fit math is unaffected.
    if (locs.u_image_res != null) gl.uniform2f(locs.u_image_res, entry.texWidth || entry.width, entry.texHeight || entry.height)

    uploadStandardUniforms(gl, locs, standardState)
    uploadUniforms(gl, locs, this.imageProgram.uniformTypes, params)

    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Draw a full-screen quad using the currently bound program.
   */
  drawQuad() {
    const gl = this.gl
    gl.bindVertexArray(this.quadVAO)
    gl.drawElements(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_SHORT, 0)
    gl.bindVertexArray(null)
  }

  /**
   * Set the canvas resolution.
   */
  setResolution(width, height) {
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    this.gl.viewport(0, 0, width, height)
    this.fbos.resizeAll(width, height)
  }

  /**
   * Execute a single effect node pass.
   * Reads from inputFBO, writes to outputFBO.
   */
  executePass(nodeProgram, inputFBOId, outputFBOId, standardState, customParams = {}, prevFrameFBOId = null, extraTextures = []) {
    const gl = this.gl

    // Bind output FBO
    this.fbos.bind(outputFBOId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Use program
    gl.useProgram(nodeProgram.program)

    // Bind input texture to unit 0
    if (inputFBOId) {
      this.fbos.bindTexture(inputFBOId, 0)
      if (nodeProgram.uniformLocations.u_texture != null) {
        gl.uniform1i(nodeProgram.uniformLocations.u_texture, 0)
      }
    }

    // Bind u_prev_frame to unit 1
    if (prevFrameFBOId) {
      this.fbos.bindTexture(prevFrameFBOId, 1)
      if (nodeProgram.uniformLocations.u_prev_frame != null) {
        gl.uniform1i(nodeProgram.uniformLocations.u_prev_frame, 1)
      }
    }

    // Bind secondary texture inputs (e.g. u_disp_map, u_texture_b) to units 2+
    for (const tex of extraTextures) {
      const loc = nodeProgram.uniformLocations[tex.uniform]
      if (loc == null) continue
      this.fbos.bindTexture(tex.fboId, tex.unit)
      gl.uniform1i(loc, tex.unit)
    }

    // Upload standard uniforms
    uploadStandardUniforms(gl, nodeProgram.uniformLocations, standardState)

    // Upload custom params
    uploadUniforms(gl, nodeProgram.uniformLocations, nodeProgram.uniformTypes, customParams)

    // Draw
    this.drawQuad()
  }

  /**
   * Start the render loop.
   */
  start() {
    this.isPlaying = true
    this.isPaused = false
    this.startTime = performance.now() / 1000
    this.lastFrameTime = performance.now()
    // Cancel any pending paused-poll timeout so the RAF loop is the only loop
    // running — otherwise a stale poll frame can race a RAF frame and flash.
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    if (!this.rafId) {
      this._loop()
    }
  }

  /**
   * Pause — drops to 10fps polling.
   */
  pause() {
    this.isPaused = true
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    // Clear any existing poll timeout before starting a fresh one so we never
    // stack multiple poll loops.
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    this._pollLoop()
  }

  /**
   * Stop completely.
   */
  stop() {
    this.isPlaying = false
    this.isPaused = true
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
  }

  /**
   * Full-speed render loop via requestAnimationFrame.
   */
  _loop() {
    if (!this.isPlaying || this.isPaused || this.isTabHidden) return

    this.rafId = requestAnimationFrame(() => {
      this._renderFrame()
      this._loop()
    })
  }

  /**
   * 10fps polling loop when paused (keeps preview responsive to slider changes).
   */
  _pollLoop() {
    if (!this.isPaused || this.isTabHidden) return

    this.timeoutId = setTimeout(() => {
      this._renderFrame()
      this._pollLoop()
    }, 100) // 10fps
  }

  /**
   * Handle tab visibility changes.
   */
  _handleVisibility() {
    if (document.visibilityState === 'hidden') {
      this.isTabHidden = true
      if (this.rafId) {
        cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
      if (this.timeoutId) {
        clearTimeout(this.timeoutId)
        this.timeoutId = null
      }
    } else {
      this.isTabHidden = false
      if (this.isPlaying && !this.isPaused) {
        this._loop()
      } else if (this.isPaused) {
        this._pollLoop()
      }
    }
  }

  /**
   * Render a single frame — the core per-frame execution.
   * Implements Section IX-B: multi-track compositing, clip graph traversal, master graph.
   */
  _renderFrame() {
    const now = performance.now()
    const gl = this.gl

    // Always sync to the canvas's actual pixel dimensions to prevent
    // flicker from stale width/height when the container resizes
    const cw = this.canvas.width
    const ch = this.canvas.height
    if (cw !== this.width || ch !== this.height) {
      this.width = cw
      this.height = ch
    }

    // FPS counter
    this.fpsFrames++
    if (now - this.fpsLastTime >= 1000) {
      this.fps = this.fpsFrames
      this.fpsFrames = 0
      this.fpsLastTime = now
      if (this.onFPSUpdate) this.onFPSUpdate(this.fps)
    }

    // Read state from stores
    const appState = this._getAppStore ? this._getAppStore() : {}
    const graphState = this._getGraphStore ? this._getGraphStore() : {}
    const timelineState = this._getTimelineStore ? this._getTimelineStore() : {}
    const audioState = this._getAudioStore ? this._getAudioStore() : {}

    let playheadTime = appState.playheadTime || 0
    // Export uses a frame-locked time; live playback uses wall-clock elapsed.
    const time = this._timeOverride != null ? this._timeOverride : (now / 1000) - this.startTime
    const tracks = timelineState.tracks || []
    const clips = timelineState.clips || []

    const graphLevel = appState.graphLevel || 'master'
    const graphClipId = appState.graphClipId || null

    // Advance playhead if playing
    if (this.isPlaying && !this.isPaused) {
      const dt = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 0
      const speed = appState.playbackSpeed || 1
      playheadTime += dt * speed

      // Loop or stop at end
      const projectDuration = (timelineState.calculateDuration ? timelineState.calculateDuration() : 0) || appState.duration || 30
      let loopStart = timelineState.inPoint ?? 0
      let loopEnd = timelineState.outPoint ?? projectDuration

      if (graphLevel === 'clip' && graphClipId) {
        const activeClip = clips.find(c => c.id === graphClipId)
        if (activeClip) {
          loopStart = activeClip.timelineStart
          loopEnd = activeClip.timelineEnd
          if (playheadTime < loopStart || playheadTime > loopEnd) {
            playheadTime = loopStart
          }
        }
      }

      if (playheadTime > loopEnd) {
        if (appState.loop || (graphLevel === 'clip' && graphClipId)) {
          playheadTime = loopStart
        } else {
          playheadTime = loopEnd
          if (appState.pause) appState.pause()
        }
      }

      // Update store so UI (Timeline, Toolbar) syncs
      if (appState.setPlayheadTime) {
        appState.setPlayheadTime(playheadTime)
      }
    }
    this.lastFrameTime = now

    // Standard uniform state
    const standardState = {
      resolution: [this.width, this.height],
      time,
      frame: this._frameOverride != null ? this._frameOverride : this.frameCount,
      playhead: playheadTime,
      audioBands: audioState.smoothedBands ? Array.from(audioState.smoothedBands) : [0,0,0,0,0,0,0,0],
      audioRms: audioState.rms || 0,
      audioBass: audioState.bass || 0,
      audioMid: audioState.mid || 0,
      audioTreble: audioState.treble || 0,
      beat: audioState.beat || 0,
      beatCount: audioState.beatCount || 0,
    }

    // Clear the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0.05, 0.05, 0.06, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Tick texture manager (evicts stale textures)
    this.textures.tick()

    // ── Per-frame execution order ──
    // 1. For each video track (bottom to top):
    //    a. Find the active clip at playheadTime
    //    b. Upload video frame as texture
    //    c. Execute clip's per-clip effect graph
    //    d. Composite onto the accumulator
    // 2. Execute the master graph on the composited result
    // 3. Display the tap-point or output

    // Determine graph context
    // Already declared earlier in the function

    // If in isolated clip graph mode, just render that clip's graph
    if (graphLevel === 'clip' && graphClipId) {
      this._renderClipGraphIsolated(graphClipId, clips, graphState, standardState)
    } else {
      // Full compositing pipeline
      this._renderFullPipeline(tracks, clips, graphState, standardState, playheadTime)
    }

    // High-performance direct DOM updates for modulated parameters to bypass React re-renders
    const displayElements = document.querySelectorAll('[data-node-param-display]')
    if (displayElements.length > 0) {
      const floatOverrides = resolveFloatConnections(this)
      displayElements.forEach(el => {
        const nid = el.getAttribute('data-node-id')
        const paramName = el.getAttribute('data-node-param-display')
        if (nid && paramName) {
          const val = floatOverrides[nid]?.[paramName]
          if (val !== undefined) {
            const isInspector = el.classList.contains('inspector__slider-value')
            el.textContent = (isInspector ? '⚡ ' : '') + val.toFixed(2)
          }
        }
      })
    }

    this.frameCount++
    // lastFrameTime is already set above (right after the playhead advance);
    // assigning it again here is redundant.

    if (this.onFrameComplete) this.onFrameComplete(this.frameCount, time)
  }

  /**
   * Overlay keyframed param values onto a liveNodes map (without mutating it).
   * `clipKey` is a clip id or 'master'; `localTime` is clip-relative seconds
   * for clips, absolute timeline seconds for master. Keyframes set the node's
   * BASE param value — float connections and audio drivers still apply on top,
   * exactly as they do over slider-set values.
   */
  _withKeyframes(liveNodes, clipKey, localTime) {
    const keyframes = this._getTimelineStore?.()?.keyframes
    if (!keyframes || keyframes.length === 0) return liveNodes
    const vals = evaluateKeyframes(keyframes, clipKey, localTime)
    if (!vals) return liveNodes
    const out = { ...liveNodes }
    for (const nodeId in vals) {
      const base = out[nodeId]?.params ?? {}
      out[nodeId] = { ...out[nodeId], params: { ...base, ...vals[nodeId] } }
    }
    return out
  }

  /**
   * The clip's audio gain at the playhead: clip volume × mute × fade-in/out
   * ramps. Transition crossfades multiply on top (see _renderFullPipeline), so
   * the sound always follows the picture.
   */
  _clipAudioGain(clip, playheadTime) {
    if (clip.audioMuted) return 0
    let g = clip.volume == null ? 1 : Math.max(0, Math.min(1, clip.volume))
    if (clip.fadeIn > 0) g *= Math.max(0, Math.min(1, (playheadTime - clip.timelineStart) / clip.fadeIn))
    if (clip.fadeOut > 0) g *= Math.max(0, Math.min(1, (clip.timelineEnd - playheadTime) / clip.fadeOut))
    return g
  }

  _syncVideoPlayback(clip, videoEl, sourceTime, isMuted = false, gain = 1) {
    // Clip-level audio: track mute wins; otherwise the audible level follows
    // the computed gain (clip volume × fades × transition crossfade).
    //
    // Once the element is wired into WebAudio (has a _playbackGain node), the
    // GAIN NODE carries the audible level and the element itself stays unmuted
    // at full volume — so the pre-gain per-source analyser still hears the raw
    // stem (a muted drums.wav keeps driving visuals). Before the AudioContext
    // exists, the element's own muted/volume are the only controls.
    const muted = isMuted || gain <= 0.001
    const vol = muted ? 0 : Math.max(0, Math.min(1, gain))
    if (videoEl._playbackGain) {
      if (videoEl.muted) videoEl.muted = false
      if (videoEl.volume !== 1) videoEl.volume = 1
      if (Math.abs(videoEl._playbackGain.gain.value - vol) > 0.005) {
        videoEl._playbackGain.gain.value = vol
      }
    } else {
      if (videoEl.muted !== muted) {
        videoEl.muted = muted
      }
      if (Math.abs((videoEl.volume ?? 1) - vol) > 0.005) {
        videoEl.volume = vol
      }
    }

    const appState = this._getAppStore ? this._getAppStore() : {}
    const speed = appState.playbackSpeed || 1

    if (this.isPlaying && !this.isPaused) {
      const isSeeking = videoEl.seeking || videoEl._seekPending

      if (videoEl.paused && !videoEl._playPending) {
        videoEl.currentTime = sourceTime
        videoEl.playbackRate = speed
        videoEl._playPending = true
        videoEl.play()
          .then(() => {
            videoEl._playPending = false
          })
          .catch(e => {
            videoEl._playPending = false
            console.warn('[Renderer] Autoplay prevented:', e)
          })
      }

      // Sync playback rate if changed
      if (videoEl.playbackRate !== speed) {
        videoEl.playbackRate = speed
      }

      // Hard sync fallback (if drift is > 1.0 second and we are not seeking)
      if (!isSeeking && !videoEl._playPending && Math.abs(videoEl.currentTime - sourceTime) > 1.0) {
        videoEl.currentTime = sourceTime
        videoEl._seekPending = true

        const onSeeked = () => {
          videoEl._seekPending = false
          videoEl.removeEventListener('seeked', onSeeked)
        }
        videoEl.addEventListener('seeked', onSeeked)
      }
    } else {
      if (!videoEl.paused) {
        videoEl.pause()
      }
      if (!videoEl.seeking && videoEl._lastSetSourceTime !== sourceTime) {
        videoEl.currentTime = sourceTime
        videoEl._lastSetSourceTime = sourceTime
      }
    }
  }

  /**
   * Render one clip's contribution for this frame: (re)build its video/camera/
   * screen element, upload the current frame to a texture, draw it into the clip's
   * input FBO, and run its per-clip effect graph. Returns the FBO holding the clip's
   * output, or null when the clip has no frame ready yet (nothing to composite).
   * `isLiveStream` is true for camera AND screen-capture clips — both are backed by
   * a MediaStream in cameraRegistry (no fileUrl, no seeking/playback sync).
   */
  _renderClipToFBO(track, clip, isLiveStream, graphState, standardState, playheadTime) {
    const gl = this.gl
    let videoEl = this._videoElements.get(clip.id)

    if (isLiveStream) {
      // Live camera/screen: backed by a MediaStream (no fileUrl, no seeking/playback sync).
      const stream = getCameraStream(clip.id)
      if (!stream) return null
      if (videoEl && videoEl._cameraStream !== stream) {
        // Stream was replaced (camera re-detected) — rebuild the element.
        this._videoElements.delete(clip.id)
        videoEl = null
      }
      if (!videoEl) {
        videoEl = document.createElement('video')
        videoEl.srcObject = stream
        videoEl._cameraStream = stream
        videoEl.muted = true // camera audio is routed through the AudioEngine separately
        videoEl.playsInline = true
        videoEl.autoplay = true
        videoEl.play().catch(() => { /* autoplay may defer until a user gesture */ })
        this._videoElements.set(clip.id, videoEl)
      }
    } else {
      if (videoEl && videoEl._fileUrl !== clip.fileUrl) {
        // fileUrl changed — old video element has a stale blob URL, recreate it
        this._videoElements.delete(clip.id)
        videoEl = null
      }
      if (!videoEl) {
        videoEl = document.createElement('video')
        videoEl.src = clip.fileUrl
        videoEl._fileUrl = clip.fileUrl
        videoEl.muted = track.muted
        videoEl.loop = false
        videoEl.crossOrigin = 'anonymous'
        videoEl.playsInline = true
        videoEl.autoplay = false
        videoEl.preload = 'auto'
        this._videoElements.set(clip.id, videoEl)
      }

      // Connect to audio engine dynamically when context becomes active.
      // The filename names this element's per-source analyser (stem analysis).
      const audioEngine = getAudioEngine()
      if (audioEngine.ctx && videoEl._connectedToAudioEngine !== audioEngine.ctx) {
        audioEngine.connectMediaElement(videoEl, clip.filename)
        videoEl._connectedToAudioEngine = audioEngine.ctx
      }

      const sourceTime = getClipSourceTime(clip, playheadTime)
      this._syncVideoPlayback(clip, videoEl, sourceTime, track.muted, this._audioGains?.[clip.id] ?? 1)
    }

    // Upload video frame to texture, or reuse the cached texture while seeking.
    const texId = `clip_${clip.id}`
    const hasTexture = !!this.textures.getTexture(texId)
    if (!(videoEl.readyState >= 2 || hasTexture)) return null // no frame yet

    if (!hasTexture) {
      this.textures.create(texId, videoEl.videoWidth || 1920, videoEl.videoHeight || 1080)
    }
    if (videoEl.readyState >= 2 && (!hasTexture || videoEl.currentTime !== videoEl._lastUploadedTime)) {
      this.textures.uploadVideoFrame(texId, videoEl)
      videoEl._lastUploadedTime = videoEl.currentTime
    }

    const inputFBOId = `clip_input_${clip.id}`
    if (!this.fbos.getTexture(inputFBOId)) {
      this.fbos.create(inputFBOId, this.width, this.height)
    }

    // Render the video texture into the clip's input FBO.
    this.fbos.bind(inputFBOId)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.passthroughProgram.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.textures.getTexture(texId))
    const loc = this.passthroughProgram.uniformLocations.u_texture
    if (loc != null) gl.uniform1i(loc, 0)
    this.drawQuad()

    // Execute the clip's per-clip effect graph, if any.
    const clipGraph = graphState.clipGraphs?.[clip.id]
    let clipResultFBOId = inputFBOId

    if (clipGraph && clipGraph.nodes.length > 0) {
      if (!this.compiledChains.has(clip.id) || this._needsRecompile) {
        const result = compileGraph(gl, clipGraph)
        this.compiledChains.set(clip.id, result)
        if (result.errors.length > 0) {
          console.error(`[DaliVid] Clip graph compile errors for "${clip.name}":`, result.errors)
        }
      }

      const { chain, edges } = this.compiledChains.get(clip.id)
      if (chain.length > 0) {
        const outputFBOId = `clip_output_${clip.id}`
        if (!this.fbos.getTexture(outputFBOId)) {
          this.fbos.create(outputFBOId, this.width, this.height)
        }
        standardState.hasSource = 1 // real video frame feeds this clip graph
        // Keyframed params are clip-relative in time, so keys survive clip moves.
        const kfNodes = this._withKeyframes(buildNodeMap(clipGraph), clip.id, playheadTime - clip.timelineStart)
        executeChain(this, chain, inputFBOId, outputFBOId, standardState, {}, kfNodes, edges, this.previewTapEnabled ? clipGraph.tapPointNodeId : null)
        clipResultFBOId = outputFBOId
      }
    }

    return clipResultFBOId
  }

  /**
   * Render an AUDIO clip's per-clip effect graph into an FBO so it can be
   * composited into the master output, exactly like the isolated clip view does.
   *
   * Audio clips carry no video frame, so the graph runs over a BLANK input with
   * `hasSource = 0` — generative / audio-reactive effects draw from scratch (the
   * live audio uniforms are already in the store, driven by the AudioEngine).
   *
   * Returns the output FBO id, or null when the clip has no real effect nodes
   * (a bare CLIP_SOURCE → OUTPUT graph produces nothing to show, so plain audio
   * clips stay invisible and don't paint black over the video tracks).
   */
  _renderAudioClipVisualToFBO(clip, graphState, standardState, playheadTime) {
    const gl = this.gl
    const clipGraph = graphState.clipGraphs?.[clip.id]
    if (!clipGraph || !clipGraph.nodes.some(n => !NON_EFFECT_TYPES.includes(n.type))) return null

    // Blank input FBO (no video texture) — mirror the isolated audio path.
    const inputFBOId = `clip_input_${clip.id}`
    if (!this.fbos.getTexture(inputFBOId)) this.fbos.create(inputFBOId, this.width, this.height)
    this._ensureDefaultFBO()
    this.fbos.blit('__default_input', inputFBOId, this.width, this.height)

    if (!this.compiledChains.has(clip.id) || this._needsRecompile) {
      const result = compileGraph(gl, clipGraph)
      this.compiledChains.set(clip.id, result)
      if (result.errors.length > 0) {
        console.error(`[DaliVid] Audio-clip graph compile errors for "${clip.name}":`, result.errors)
      }
    }

    const { chain, edges } = this.compiledChains.get(clip.id)
    if (chain.length === 0) return null

    const outputFBOId = `clip_output_${clip.id}`
    if (!this.fbos.getTexture(outputFBOId)) this.fbos.create(outputFBOId, this.width, this.height)

    standardState.hasSource = 0 // no real source texture → generative effects self-display
    const kfNodes = this._withKeyframes(buildNodeMap(clipGraph), clip.id, playheadTime - clip.timelineStart)
    executeChain(this, chain, inputFBOId, outputFBOId, standardState, {}, kfNodes, edges, this.previewTapEnabled ? clipGraph.tapPointNodeId : null)
    return outputFBOId
  }

  /**
   * Render the full multi-track compositing pipeline.
   */
  _renderFullPipeline(tracks, clips, graphState, standardState, playheadTime) {
    const gl = this.gl

    // Get sorted video tracks (by zOrder, bottom to top)
    const videoTracks = tracks
      .filter(t => t.type === 'video' && !t.muted)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0))

    const audioTracks = tracks
      .filter(t => t.type === 'audio' && !t.muted)

    // Check solo
    const soloTrack = tracks.find(t => t.solo && t.type === 'video')

    // Track which clips are active this frame
    const activeClipIds = new Set()

    // Fresh per-frame audio-gain map (clipId → 0..1); filled per track below,
    // read by _renderClipToFBO when syncing each clip's media element.
    this._audioGains = {}

    // Compositing accumulator (ping-pong): each active track's clip output is
    // composited onto this buffer bottom-to-top using the clip/track blend mode
    // + opacity. Two FBOs are needed because a single pass can't read and write
    // the same attachment. accumReadId always holds the latest composite.
    const accumAId = '__compositor_accum'
    const accumBId = '__compositor_accum_b'
    if (!this.fbos.getTexture(accumAId)) this.fbos.create(accumAId, this.width, this.height)
    if (!this.fbos.getTexture(accumBId)) this.fbos.create(accumBId, this.width, this.height)
    let accumReadId = accumAId
    let accumWriteId = accumBId

    // Start from a fully transparent backdrop so uncovered regions / gaps read
    // as nothing (spec: a track with no active clip contributes vec4(0.0)).
    this.fbos.bind(accumReadId)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    let hasContent = false

    for (const track of videoTracks) {
      if (soloTrack && track.id !== soloTrack.id) continue

      // Every clip active on this track at the playhead, earliest first. When clips
      // overlap in time on one track, each later-starting clip composites over the
      // earlier ones (and the tracks below) using its own blend mode — a cross-blend
      // (spec §C). A single clip is just the common case of one active clip.
      const activeClips = getActiveClips(clips, track.id, playheadTime)

      // Per-clip audio gains at the playhead (volume × mute × fades). During a
      // transition the incoming clip's audio ramps up with the picture and the
      // outgoing clip's ramps down — an automatic audio crossfade. Plain
      // overlaps without a transition keep both audible (layering is a valid
      // use); mute or fade a clip to silence it.
      for (const c of activeClips) this._audioGains[c.id] = this._clipAudioGain(c, playheadTime)
      for (let ci = 1; ci < activeClips.length; ci++) {
        const c = activeClips[ci]
        if (!c.transition || !c.transition.type) continue
        const prev = activeClips[ci - 1]
        const overlapEnd = Math.min(prev.timelineEnd, c.timelineEnd)
        const overlapDur = overlapEnd - c.timelineStart
        if (overlapDur <= 0.001) continue
        const p = Math.max(0, Math.min(1, (playheadTime - c.timelineStart) / overlapDur))
        this._audioGains[c.id] *= p
        this._audioGains[prev.id] *= (1 - p)
      }

      for (let ci = 0; ci < activeClips.length; ci++) {
        const clip = activeClips[ci]
        const isLive = clip.fileType === 'camera' || clip.fileType === 'screen'
        // Non-live clips must be a renderable video file (have a fileUrl).
        if (!isLive && (clip.fileType !== 'video' || !clip.fileUrl)) continue

        activeClipIds.add(clip.id)

        const clipResultFBOId = this._renderClipToFBO(track, clip, isLive, graphState, standardState, playheadTime)
        if (!clipResultFBOId) continue // no frame ready — nothing to composite

        // Composite this clip onto the accumulator. Effective blend mode: the
        // clip's own mode takes precedence; 'Inherit' (or unset — the default)
        // falls back to the track's mode, so an explicit clip 'Normal' is a
        // real choice that overrides e.g. a Multiply track.
        // Opacity is clip × track opacity × the clip's fade-in/out ramp.
        const blendName = (clip.blendMode && clip.blendMode !== 'Inherit') ? clip.blendMode : (track.blendMode || 'Normal')
        const blendIdx = getBlendModeIndex(blendName)
        const clipOpacity = clip.opacity == null ? 1 : clip.opacity
        const trackOpacity = track.opacity == null ? 1 : track.opacity

        // Fade-in/out: linear opacity ramps over the first fadeIn / last fadeOut
        // seconds of the clip (timeline time, like NLE fade handles). Both fades
        // multiply, so on a short clip with overlapping ramps the dip composes
        // instead of popping. Zero-length fades are the no-op default.
        let fade = 1
        if (clip.fadeIn > 0) fade *= Math.max(0, Math.min(1, (playheadTime - clip.timelineStart) / clip.fadeIn))
        if (clip.fadeOut > 0) fade *= Math.max(0, Math.min(1, (clip.timelineEnd - playheadTime) / clip.fadeOut))

        const opacity = Math.max(0, Math.min(1, clipOpacity)) * Math.max(0, Math.min(1, trackOpacity)) * fade

        // Transition-in: when this clip declares one AND overlaps the previous
        // active clip on this track, the transition shader owns the mix for the
        // overlap window (u_progress 0 → 1), replacing the plain blend
        // composite. Both clips are active at the playhead, so the overlap is
        // guaranteed non-empty; u_from is the accumulator (previous clip over
        // the lower tracks), which is the correct compositing backdrop.
        let composited = false
        if (clip.transition && clip.transition.type && ci > 0) {
          const prev = activeClips[ci - 1]
          const overlapEnd = Math.min(prev.timelineEnd, clip.timelineEnd)
          const overlapDur = overlapEnd - clip.timelineStart
          if (overlapDur > 0.001) {
            const progress = Math.max(0, Math.min(1, (playheadTime - clip.timelineStart) / overlapDur))
            // "compound:<libId>" runs a node-graph transition from the compound
            // library; anything else is a built-in registry transition shader.
            composited = clip.transition.type.startsWith('compound:')
              ? this._compositeNodeTransition(
                  accumReadId, accumWriteId, clipResultFBOId,
                  clip, progress, opacity, standardState
                )
              : this._compositeTransition(
                  accumReadId, accumWriteId, clipResultFBOId,
                  clip.transition, progress, opacity, standardState
                )
          }
        }
        if (!composited) {
          this._compositeTrack(accumReadId, accumWriteId, clipResultFBOId, blendIdx, opacity)
        }
        const swapId = accumReadId; accumReadId = accumWriteId; accumWriteId = swapId
        hasContent = true
      }
    }

    // Process audio tracks for playback and syncing
    for (const track of audioTracks) {
      if (soloTrack && track.id !== soloTrack.id) continue

      const clip = getActiveClip(clips, track.id, playheadTime)
      if (!clip || clip.fileType !== 'audio' || !clip.fileUrl) continue

      activeClipIds.add(clip.id)

      let audioEl = this._videoElements.get(clip.id)
      if (!audioEl) {
        audioEl = document.createElement('audio')
        audioEl.src = clip.fileUrl
        audioEl.muted = track.muted
        audioEl.loop = false
        audioEl.crossOrigin = 'anonymous'
        audioEl.autoplay = false
        audioEl.preload = 'auto'
        this._videoElements.set(clip.id, audioEl)
      }

      const audioEngine = getAudioEngine()
      if (audioEngine.ctx && audioEl._connectedToAudioEngine !== audioEngine.ctx) {
        audioEngine.connectMediaElement(audioEl, clip.filename)
        audioEl._connectedToAudioEngine = audioEngine.ctx
      }

      const sourceTime = getClipSourceTime(clip, playheadTime)
      this._syncVideoPlayback(clip, audioEl, sourceTime, track.muted, this._clipAudioGain(clip, playheadTime))
    }

    // ── Audio-clip generative visuals ──
    // An audio clip can carry an effect graph (generative / audio-reactive). It
    // has no video frame, so it isn't part of the video-track compositing above,
    // but its graph still renders — composite it here so it shows in master, not
    // just in the isolated clip view. Audio visuals layer ON TOP of the video
    // tracks, bottom-to-top by audio-track zOrder, using each clip's blend mode +
    // opacity (+ fades). Only clips with real effect nodes contribute, so plain
    // audio clips stay invisible.
    const audioVisTracks = [...audioTracks].sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0))
    for (const track of audioVisTracks) {
      if (soloTrack && track.id !== soloTrack.id) continue
      for (const clip of getActiveClips(clips, track.id, playheadTime)) {
        if (clip.fileType !== 'audio' || !clip.fileUrl) continue
        const visFBOId = this._renderAudioClipVisualToFBO(clip, graphState, standardState, playheadTime)
        if (!visFBOId) continue
        activeClipIds.add(clip.id)

        const blendName = (clip.blendMode && clip.blendMode !== 'Inherit') ? clip.blendMode : (track.blendMode || 'Normal')
        const blendIdx = getBlendModeIndex(blendName)
        const clipOpacity = clip.opacity == null ? 1 : clip.opacity
        const trackOpacity = track.opacity == null ? 1 : track.opacity
        let fade = 1
        if (clip.fadeIn > 0) fade *= Math.max(0, Math.min(1, (playheadTime - clip.timelineStart) / clip.fadeIn))
        if (clip.fadeOut > 0) fade *= Math.max(0, Math.min(1, (clip.timelineEnd - playheadTime) / clip.fadeOut))
        const opacity = Math.max(0, Math.min(1, clipOpacity)) * Math.max(0, Math.min(1, trackOpacity)) * fade

        this._compositeTrack(accumReadId, accumWriteId, visFBOId, blendIdx, opacity)
        const swapId = accumReadId; accumReadId = accumWriteId; accumWriteId = swapId
        hasContent = true
      }
    }

    // ── Master Graph Execution ──
    // Feed the composited result (or a blank texture if no video) through the master effect chain
    this._ensureDefaultFBO()
    const masterInputFBOId = hasContent ? accumReadId : '__default_input'

    if (masterInputFBOId) {
      const masterGraph = graphState.masterGraph
      const hasEffects = masterGraph && masterGraph.nodes.some(n => !NON_EFFECT_TYPES.includes(n.type))

      if (hasEffects) {
        if (!this.masterChain || this._needsRecompile) {
            this.masterChain = compileGraph(gl, masterGraph)
            if (this.masterChain.errors.length > 0) {
              console.error('[DaliVid] Master graph compile errors:', this.masterChain.errors)
            }
          }

        const effectNodes = this.masterChain.chain.filter(n =>
          n.program && !n.bypassed && !n.isSource && !n.isOutput
        )
        // An IMAGE_INPUT source produces pixels with no effect program, so the
        // chain must run even with zero effect nodes (image → OUTPUT).
        const hasImageSource = this.masterChain.chain.some(n => n.isImage)

        if (effectNodes.length > 0 || hasImageSource) {
          // No video composited this frame → generative effects should self-display.
          standardState.hasSource = hasContent ? 1 : 0
          const kfMaster = this._withKeyframes(buildNodeMap(masterGraph), 'master', playheadTime)
          executeChain(this, this.masterChain.chain, masterInputFBOId, null, standardState, {}, kfMaster, this.masterChain.edges, this.previewTapEnabled ? masterGraph.tapPointNodeId : null)
        } else {
          if (hasContent) this._blitToScreen(masterInputFBOId)
        }
      } else {
        if (hasContent) this._blitToScreen(masterInputFBOId)
      }
    }

    this._needsRecompile = false

    // Cleanup inactive video elements + GPU resources for removed clips
    for (const [clipId, videoEl] of this._videoElements) {
      if (!activeClipIds.has(clipId)) {
        if (!videoEl.paused) videoEl.pause()
        if (!clips.some(c => c.id === clipId)) {
          if (videoEl._cameraStream) {
            // Live camera removed — stop its tracks (releases the device) and
            // drop the stream from the registry.
            videoEl.srcObject = null
            videoEl._cameraStream = null
            removeCameraStream(clipId)
          } else {
            videoEl.removeAttribute('src')
            videoEl.load()
          }
          this._videoElements.delete(clipId)
          // The clip is gone from the timeline — free its GPU resources so they
          // don't accumulate over a long editing session.
          this.releaseClipResources(clipId, graphState)
        }
      }
    }
  }

  /**
   * Release all GPU resources owned by a clip that has been removed from the
   * timeline: its source texture, input/output FBOs, per-node feedback and
   * compound ping-pong buffers, and its compiled chain.
   */
  releaseClipResources(clipId, graphState = null) {
    this.textures.delete(`clip_${clipId}`)
    this.fbos.delete(`clip_input_${clipId}`)
    this.fbos.delete(`clip_output_${clipId}`)

    // Node-transition FBOs are namespaced `…tr~<clipId>~…` (see
    // _compositeNodeTransition); enumerate-and-match frees them without needing
    // to know which library transition (or which of its inner nodes) ran.
    const trScope = `tr~${clipId}~`
    for (const key of [...this.fbos.fbos.keys()]) {
      if (key.includes(trScope)) this.fbos.delete(key)
    }

    // Free each node's GPU resources; releaseNodeResources descends into
    // compounds. The clip's graph is needed to enumerate its node ids.
    const clipGraph = graphState?.clipGraphs?.[clipId]
    if (clipGraph?.nodes) {
      for (const n of clipGraph.nodes) this.releaseNodeResources(n)
    }

    this.compiledChains.delete(clipId)
  }

  /**
   * Free every GPU resource owned by a node and (recursively) any compound it
   * contains: its DAG output FBO (__n_<id>), feedback ping-pong (__npp_<id>),
   * image pre-pass FBO (__img_<id>) + uploaded texture (img_<id>), and legacy
   * per-node buffers. Inner compound nodes use FBO keys namespaced by their
   * enclosing compound id(s) (see executeGraphDAG's scopeId), rebuilt here.
   * Safe no-op for ids that own nothing — both managers ignore unknown keys.
   * Wired to the nodeLifecycle removal hook so deleting ANY node (not just an
   * image node, and including master-graph nodes that never pass through
   * releaseClipResources) frees its resources instead of leaking until dispose.
   * @param {object} node — the removed graph node ({ id, type, subGraph? })
   */
  releaseNodeResources(node) {
    if (!node) return
    const free = (n, scope) => {
      this.fbos.delete(`__n_${scope}${n.id}`)            // DAG per-node output FBO
      this.fbos.deletePingPong(`__npp_${scope}${n.id}`)  // DAG feedback ping-pong
      this.fbos.delete(`__img_${scope}${n.id}`)          // IMAGE_INPUT source FBO
      this.textures.delete(`img_${n.id}`)                // decoded image texture (id-keyed)
      // Legacy buffers from the pre-unification executors — harmless if absent.
      this.fbos.deletePingPong(`__fb_${n.id}`)
      this.fbos.deletePingPong(`__fb_sub_${n.id}`)
      this.fbos.deletePingPong(`__compound_pp_${n.id}`)
      // Descend into a compound's sub-graph; its inner FBOs are namespaced under
      // this node's id (plus any enclosing scope).
      if (n.type === 'COMPOUND' && n.subGraph?.nodes) {
        for (const inner of n.subGraph.nodes) free(inner, `${scope}${n.id}~`)
      }
    }
    free(node, '')
  }

  /**
   * Composite one layer onto another with the blend-mode shader.
   * Reads baseFBOId (everything composited so far) and blendFBOId (the layer to
   * add) and writes the blended result into destFBOId. base / blend / dest must
   * be three distinct FBOs (no read-write aliasing) — the caller ping-pongs two
   * accumulator buffers. Blending is backdrop-aware (see applyBlendMode), so a
   * layer over a still-transparent accumulator shows as itself.
   * @param {string} baseFBOId    — backdrop FBO (current accumulator)
   * @param {string} destFBOId    — destination FBO (must differ from base & blend)
   * @param {string} blendFBOId   — the layer being composited on top
   * @param {number} blendModeIdx — index into BLEND_MODE_NAMES
   * @param {number} opacity      — 0..1 layer opacity
   */
  _compositeTrack(baseFBOId, destFBOId, blendFBOId, blendModeIdx, opacity) {
    const gl = this.gl
    if (!this.compositeProgram || !this.compositeProgram.program) return

    this.fbos.bind(destFBOId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.compositeProgram.program)
    const locs = this.compositeProgram.uniformLocations
    this.fbos.bindTexture(baseFBOId, 0)
    if (locs.u_base != null) gl.uniform1i(locs.u_base, 0)
    this.fbos.bindTexture(blendFBOId, 1)
    if (locs.u_blend != null) gl.uniform1i(locs.u_blend, 1)
    if (locs.u_blend_mode != null) gl.uniform1i(locs.u_blend_mode, blendModeIdx)
    if (locs.u_opacity != null) gl.uniform1f(locs.u_opacity, opacity)
    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Composite an incoming clip over the accumulator with a transition shader
   * instead of the blend-mode compositor. Same FBO contract as _compositeTrack
   * (three distinct FBOs; caller ping-pongs). Standard uniforms are uploaded, so
   * transitions get u_time / u_beat / u_audio_rms for free (audio-reactive).
   *
   * @param {string} baseFBOId  — backdrop FBO: accumulator incl. the outgoing clip
   * @param {string} destFBOId  — destination FBO
   * @param {string} toFBOId    — the incoming clip's finished frame
   * @param {object} transition — { type, params } from clip.transition
   * @param {number} progress   — 0..1 across the overlap window
   * @param {number} opacity    — 0..1 effective clip × track opacity
   * @param {object} standardState — per-frame standard uniform state
   * @returns {boolean} true if the transition pass ran (false → caller falls
   *   back to the blend composite, e.g. unknown type or failed compile)
   */
  _compositeTransition(baseFBOId, destFBOId, toFBOId, transition, progress, opacity, standardState) {
    const gl = this.gl
    const type = transition.type

    let src = this._transitionSources[type]
    if (src === undefined) {
      src = buildTransitionShader(type) || null
      this._transitionSources[type] = src
      if (!src) console.warn(`[Renderer] Unknown transition type "${type}"`)
    }
    if (!src) return false

    // Cache hit is a map lookup + recency refresh; a miss (first use or LRU
    // eviction) recompiles transparently.
    const prog = createShaderProgram(gl, src)
    if (!prog.program) {
      if (!this._transitionWarned.has(type)) {
        this._transitionWarned.add(type)
        console.warn(`[Renderer] Transition "${type}" failed to compile:`, prog.errors)
      }
      return false
    }

    this.fbos.bind(destFBOId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(prog.program)
    const locs = prog.uniformLocations
    this.fbos.bindTexture(baseFBOId, 0)
    if (locs.u_from != null) gl.uniform1i(locs.u_from, 0)
    this.fbos.bindTexture(toFBOId, 1)
    if (locs.u_to != null) gl.uniform1i(locs.u_to, 1)
    if (locs.u_progress != null) gl.uniform1f(locs.u_progress, progress)
    if (locs.u_opacity != null) gl.uniform1f(locs.u_opacity, opacity)

    uploadStandardUniforms(gl, locs, standardState)
    // Registry defaults overlaid with the clip's saved param values.
    const params = { ...getTransitionDefaults(type), ...(transition.params || {}) }
    uploadUniforms(gl, locs, prog.uniformTypes, params)

    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return true
  }

  /**
   * Composite an incoming clip using a NODE-GRAPH transition: a compound
   * library entry (clip.transition.type = "compound:<libId>") whose sub-graph
   * mixes its two image inputs (FROM = accumulator, TO = incoming clip), with
   * any TRANSITION_PROGRESS node inside driven by the live overlap progress.
   * The clip's saved param values (clip.transition.params, keyed by exposed-
   * param index) are applied as live overrides without mutating the entry.
   * Result is composited over the accumulator Normal-mode at `opacity`, same
   * contract as the built-in transition footer.
   * @returns {boolean} false → caller falls back to the blend composite
   *   (missing library entry, compile errors, or an unresolvable output).
   */
  _compositeNodeTransition(baseFBOId, destFBOId, toFBOId, clip, progress, opacity, standardState) {
    const transition = clip.transition
    const libId = transition.type.slice('compound:'.length)
    const entry = this._getGraphStore?.()?.compoundLibrary?.find(c => c.id === libId)
    if (!entry || !entry.subGraph) {
      if (!this._transitionWarned.has(transition.type)) {
        this._transitionWarned.add(transition.type)
        console.warn(`[Renderer] Node transition "${libId}" not found in compound library`)
      }
      return false
    }

    // Compile (or reuse) the entry's sub-graph chain.
    let cached = this._nodeTransitionChains[libId]
    if (!cached || cached.entry !== entry) {
      const compiled = compileGraph(this.gl, entry.subGraph)
      cached = { entry, chain: compiled.chain, errors: compiled.errors }
      this._nodeTransitionChains[libId] = cached
      if (compiled.errors?.length) {
        console.warn(`[Renderer] Node transition "${entry.name}" compiled with errors:`, compiled.errors)
      }
    }
    if (!cached.chain || cached.chain.length === 0) return false

    // Apply the clip's exposed-param values as live overrides.
    let liveNodes = null
    const overrides = transition.params || {}
    const eps = entry.exposedParams || []
    if (eps.length) {
      liveNodes = {}
      for (let i = 0; i < eps.length; i++) {
        const ep = eps[i]
        const map = ep.mappings?.[0]
        if (!map) continue
        const raw = overrides[i] ?? ep.value ?? ep.paramConfig?.default
        const value = (typeof raw === 'number' && typeof map.scaleFactor === 'number')
          ? raw * map.scaleFactor + (map.offset || 0)
          : raw
        const inner = entry.subGraph.nodes.find(n => n.id === map.nodeId)
        const base = liveNodes[map.nodeId]?.params ?? inner?.params ?? {}
        liveNodes[map.nodeId] = { params: { ...base, [map.uniformName]: value } }
      }
    }

    // Inner FBOs are namespaced per clip so two clips using the same library
    // transition never collide (freed in releaseClipResources).
    const resultFBO = executeTransitionCompound(
      this, cached.chain, entry.subGraph, baseFBOId, toFBOId,
      standardState, progress, `tr~${clip.id}~`, liveNodes
    )
    if (!resultFBO) return false

    this._compositeTrack(baseFBOId, destFBOId, resultFBO, 0 /* Normal */, opacity)
    return true
  }

  /**
   * Blit an FBO to the screen using the passthrough shader.
   */
  _blitToScreen(fboId) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.passthroughProgram.program)
    this.fbos.bindTexture(fboId, 0)
    const loc = this.passthroughProgram.uniformLocations.u_texture
    if (loc != null) gl.uniform1i(loc, 0)
    this.drawQuad()
  }

  /**
   * Ensure a default blank FBO exists for audio-only rendering.
   * Creates a transparent-black full-screen FBO that can be used as
   * input when no video source is connected.
   */
  _ensureDefaultFBO() {
    if (!this.fbos.getTexture('__default_input')) {
      this.fbos.create('__default_input', this.width, this.height)
    }
    // Re-clear every frame so resize or reuse always has valid content
    const gl = this.gl
    this.fbos.bind('__default_input')
    gl.clearColor(0.05, 0.05, 0.06, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Render an isolated clip graph (when user is editing a per-clip graph).
   */
  _renderClipGraphIsolated(clipId, clips, graphState, standardState) {
    const gl = this.gl
    const clip = clips.find(c => c.id === clipId)
    if (!clip) return

    let videoEl = this._videoElements.get(clipId)
    if (videoEl && videoEl._fileUrl !== clip.fileUrl) {
      this._videoElements.delete(clipId)
      videoEl = null
    }
    if (!videoEl) {
      videoEl = document.createElement(clip.fileType === 'audio' ? 'audio' : 'video')
      videoEl.src = clip.fileUrl
      videoEl._fileUrl = clip.fileUrl
      videoEl.muted = true // isolated mode defaults to muted
      videoEl.loop = false
      videoEl.crossOrigin = 'anonymous'
      videoEl.playsInline = true
      videoEl.autoplay = false
      videoEl.preload = 'auto'
      this._videoElements.set(clipId, videoEl)
    }

    // Connect to audio engine dynamically when context becomes active
    const audioEngine = getAudioEngine()
    if (audioEngine.ctx && videoEl._connectedToAudioEngine !== audioEngine.ctx) {
      audioEngine.connectMediaElement(videoEl)
      videoEl._connectedToAudioEngine = audioEngine.ctx
    }

    // Sync playback
    const appState = this._getAppStore ? this._getAppStore() : {}
    const playheadTime = appState.playheadTime || 0
    const sourceTime = getClipSourceTime(clip, playheadTime)
    this._syncVideoPlayback(clip, videoEl, sourceTime, true) // Muted in isolated mode

    // Pause other video elements that are not the current isolated clip
    for (const [id, el] of this._videoElements) {
      if (id !== clipId) {
        if (!el.paused) el.pause()
      }
    }

    const texId = `clip_${clipId}`
    const hasTexture = !!this.textures.getTexture(texId)

    if (videoEl.readyState < 2 && !hasTexture && clip.fileType !== 'audio') return

    // Upload video frame or use cached texture if seeking
    if (!hasTexture && clip.fileType !== 'audio') {
      this.textures.create(texId, videoEl.videoWidth || 1920, videoEl.videoHeight || 1080)
    }
    if (clip.fileType !== 'audio' && videoEl.readyState >= 2 && (!hasTexture || videoEl.currentTime !== videoEl._lastUploadedTime)) {
      this.textures.uploadVideoFrame(texId, videoEl)
      videoEl._lastUploadedTime = videoEl.currentTime
    }

    // Render to input FBO
    const inputFBOId = `clip_input_${clipId}`
    if (!this.fbos.getTexture(inputFBOId)) {
      this.fbos.create(inputFBOId, this.width, this.height)
    }

    if (clip.fileType === 'audio') {
      // Audio-only clip: use the default blank FBO as input so visualizers have a texture
      this._ensureDefaultFBO()
      this.fbos.blit('__default_input', inputFBOId, this.width, this.height)
    } else {
      this.fbos.bind(inputFBOId)
      gl.viewport(0, 0, this.width, this.height)
      gl.useProgram(this.passthroughProgram.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.textures.getTexture(texId))
      const loc = this.passthroughProgram.uniformLocations.u_texture
      if (loc != null) gl.uniform1i(loc, 0)
      this.drawQuad()
    }

    // Execute clip graph
    const clipGraph = graphState.clipGraphs?.[clipId]
    if (clipGraph) {
      if (!this.compiledChains.has(clipId) || this._needsRecompile) {
        const result = compileGraph(gl, clipGraph)
        this.compiledChains.set(clipId, result)
      }

      const { chain, edges } = this.compiledChains.get(clipId)
      // Audio-only clips have no real source texture → let generative effects show.
      standardState.hasSource = clip.fileType === 'audio' ? 0 : 1
      const clipTap = this.previewTapEnabled ? clipGraph.tapPointNodeId : null

      // "Through master" preview: render the (tapped) clip result to an FBO, then
      // pass it through the master effect chain to screen — so a node can be
      // previewed *with* master FX applied, not only in raw isolation.
      const masterGraph = graphState.masterGraph
      const throughMaster = this.previewTapEnabled && appState.previewThroughMaster &&
        masterGraph && masterGraph.nodes.some(n => !NON_EFFECT_TYPES.includes(n.type))

      // Keyframes animate in the isolated view too, so authoring is WYSIWYG.
      const kfClipNodes = this._withKeyframes(buildNodeMap(clipGraph), clipId, playheadTime - clip.timelineStart)

      if (throughMaster) {
        const clipOutId = `clip_isolated_master_in_${clipId}`
        if (!this.fbos.getTexture(clipOutId)) this.fbos.create(clipOutId, this.width, this.height)
        else this.fbos.resize(clipOutId, this.width, this.height)
        executeChain(this, chain, inputFBOId, clipOutId, standardState, {}, kfClipNodes, edges, clipTap)

        if (!this.masterChain || this._needsRecompile) {
          this.masterChain = compileGraph(gl, masterGraph)
        }
        // The master pass renders its own full OUTPUT — no master tap is applied here.
        const kfMasterNodes = this._withKeyframes(buildNodeMap(masterGraph), 'master', playheadTime)
        executeChain(this, this.masterChain.chain, clipOutId, null, standardState, {}, kfMasterNodes, this.masterChain.edges, null)
      } else {
        executeChain(this, chain, inputFBOId, null, standardState, {}, kfClipNodes, edges, clipTap)
      }
    } else {
      // No graph — passthrough
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, this.width, this.height)
      gl.useProgram(this.passthroughProgram.program)
      this.fbos.bindTexture(inputFBOId, 0)
      const ptLoc = this.passthroughProgram.uniformLocations.u_texture
      if (ptLoc != null) gl.uniform1i(ptLoc, 0)
      this.drawQuad()
    }

    this._needsRecompile = false
  }

  /**
   * Clean up all GL resources.
   */
  dispose() {
    this.stop()
    // Stop receiving image-removal callbacks; this renderer's managers are about
    // to be disposed, so a late callback would operate on dead GL resources.
    if (this._unsubNodeRemoval) {
      this._unsubNodeRemoval()
      this._unsubNodeRemoval = null
    }
    document.removeEventListener('visibilitychange', this._handleVisibility)
    this.textures.dispose()
    this.fbos.dispose()
    // Delete cached shader programs tied to this GL context. The cache is keyed
    // only by source, so leaving stale programs behind would risk returning
    // programs from a dead context after a remount.
    clearProgramCache(this.gl)
    this.compiledChains.clear()
    this.masterChain = null
    // Intentionally omitting loseContext() as it causes GPU process crashes
    // on certain AMD drivers during React Strict Mode unmount/remount cycles.
    // The browser will garbage collect the context naturally when the canvas is destroyed.
  }
}
