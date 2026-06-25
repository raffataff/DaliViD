/**
 * DaliVid — Renderer.js
 * Main WebGL2 rendering engine that drives the multi-pass FBO pipeline.
 * Handles the render loop, per-frame execution, and compositing.
 */

import { createShaderProgram, uploadStandardUniforms, uploadUniforms, clearProgramCache } from './ShaderProgram.js'
import { TextureManager } from './TextureManager.js'
import { FBOManager } from './FBOManager.js'
import { BLEND_MODES_GLSL } from './BlendModes.glsl.js'
import { compileGraph, executeChain, getActiveClip, getClipSourceTime, resolveFloatConnections, buildNodeMap } from './clipGraphManager.js'
import { getAudioEngine } from '../audio/AudioEngine.js'

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

void main() {
  vec4 base = texture(u_base, v_uv);
  vec4 blend = texture(u_blend, v_uv);
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

    // Full-screen quad VAO
    this.quadVAO = this._createQuadVAO()

    // Built-in programs
    this.passthroughProgram = null
    this.compositeProgram = null
    this._initBuiltinPrograms()

    // State
    this.width = canvas.width
    this.height = canvas.height
    this.isPlaying = false
    this.isPaused = true
    this.isTabHidden = false
    this.startTime = 0
    this.frameCount = 0
    this.lastFrameTime = 0
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
    const time = (now / 1000) - this.startTime
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
      frame: this.frameCount,
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

  _syncVideoPlayback(clip, videoEl, sourceTime, isMuted = false) {
    if (videoEl.muted !== isMuted) {
      videoEl.muted = isMuted
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

    // Accumulator FBO for compositing multiple tracks
    const accumId = '__compositor_accum'
    if (!this.fbos.getTexture(accumId)) {
      this.fbos.create(accumId, this.width, this.height)
    }

    let hasContent = false
    let lastOutputFBOId = null

    for (const track of videoTracks) {
      if (soloTrack && track.id !== soloTrack.id) continue

      const clip = getActiveClip(clips, track.id, playheadTime)
      if (!clip || clip.fileType !== 'video' || !clip.fileUrl) continue

      activeClipIds.add(clip.id)

      // Get or create video element for this clip
      let videoEl = this._videoElements.get(clip.id)
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

      // Connect to audio engine dynamically when context becomes active
      const audioEngine = getAudioEngine()
      if (audioEngine.ctx && videoEl._connectedToAudioEngine !== audioEngine.ctx) {
        audioEngine.connectMediaElement(videoEl)
        videoEl._connectedToAudioEngine = audioEngine.ctx
      }

      const sourceTime = getClipSourceTime(clip, playheadTime)
      this._syncVideoPlayback(clip, videoEl, sourceTime, track.muted)

      // Upload video frame to texture or use cached texture if seeking
      const texId = `clip_${clip.id}`
      const hasTexture = !!this.textures.getTexture(texId)

      if (videoEl.readyState >= 2 || hasTexture) {
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

        // Render video texture into the input FBO
        this.fbos.bind(inputFBOId)
        gl.viewport(0, 0, this.width, this.height)
        gl.useProgram(this.passthroughProgram.program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.textures.getTexture(texId))
        const loc = this.passthroughProgram.uniformLocations.u_texture
        if (loc != null) gl.uniform1i(loc, 0)
        this.drawQuad()

        // Execute clip's per-clip effect graph
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
            executeChain(this, chain, inputFBOId, outputFBOId, standardState, {}, buildNodeMap(clipGraph), edges)
            clipResultFBOId = outputFBOId
          }
        }

        // Accumulate: for now, last-wins (proper compositing with blend modes is future work)
        lastOutputFBOId = clipResultFBOId
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
        audioEngine.connectMediaElement(audioEl)
        audioEl._connectedToAudioEngine = audioEngine.ctx
      }

      const sourceTime = getClipSourceTime(clip, playheadTime)
      this._syncVideoPlayback(clip, audioEl, sourceTime, track.muted)
    }

    // ── Master Graph Execution ──
    // Feed the composited result (or a blank texture if no video) through the master effect chain
    this._ensureDefaultFBO()
    const masterInputFBOId = hasContent ? lastOutputFBOId : '__default_input'

    if (masterInputFBOId) {
      const masterGraph = graphState.masterGraph
      const NON_EFFECT_TYPES = ['OUTPUT', 'CLIP_OUTPUT', 'EFFECT_OUTPUT', 'AUDIO_INPUT', 'AUDIO_SPLITTER', 'VIDEO_INPUT', 'CAMERA_INPUT', 'CLIP_SOURCE', 'EFFECT_INPUT']
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

        if (effectNodes.length > 0) {
          executeChain(this, this.masterChain.chain, masterInputFBOId, null, standardState, {}, buildNodeMap(masterGraph), this.masterChain.edges)
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
          videoEl.removeAttribute('src')
          videoEl.load()
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

    // Per-node ping-pong buffers are keyed by node id, so we need the clip's
    // graph to find them. Use the passed graph state if available.
    const clipGraph = graphState?.clipGraphs?.[clipId]
    if (clipGraph?.nodes) {
      for (const n of clipGraph.nodes) {
        this.fbos.delete(`__n_${n.id}`)            // DAG per-node output FBO
        this.fbos.deletePingPong(`__npp_${n.id}`)  // DAG feedback ping-pong
        this.fbos.deletePingPong(`__fb_${n.id}`)
        this.fbos.deletePingPong(`__fb_sub_${n.id}`)
        this.fbos.deletePingPong(`__compound_pp_${n.id}`)
      }
    }

    this.compiledChains.delete(clipId)
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
      executeChain(this, chain, inputFBOId, null, standardState, {}, buildNodeMap(clipGraph), edges)
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
