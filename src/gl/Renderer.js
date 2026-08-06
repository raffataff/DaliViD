/**
 * DaliVid — Renderer.js
 * Main WebGL2 rendering engine that drives the multi-pass FBO pipeline.
 * Handles the render loop, per-frame execution, and compositing.
 */

import { createShaderProgram, uploadStandardUniforms, uploadUniforms, clearProgramCache } from './ShaderProgram.js'
import { TextureManager } from './TextureManager.js'
import { FBOManager } from './FBOManager.js'
import { BLEND_MODES_GLSL, getBlendModeIndex } from './BlendModes.glsl.js'
import { compileGraph, executeChain, executeTransitionCompound, getActiveClip, getActiveClips, getClipSourceTime, resolveFloatConnections, buildNodeMap, normalizeParams } from './clipGraphManager.js'
import { getAudioEngine } from '../audio/AudioEngine.js'
import { getCameraStream, removeCameraStream } from './cameraRegistry.js'
import { ensureNodeImage, removeNodeImage } from './imageRegistry.js'
import { ensureText, removeText } from './textRegistry.js'
import { onNodeRemoved } from './nodeLifecycle.js'
import { setDetectedAlpha, getDetectedAlpha } from './alphaRegistry.js'
import { getShaderSource } from '../shaders/shaderRegistry.js'
import { buildTransitionShader, getTransitionDefaults } from '../shaders/transitionRegistry.js'
import { evaluateKeyframes } from '../utils/keyframes.js'
import { hexToVec3 } from '../utils/paramParser.js'
import {
  EDGE_HEAD, EDGE_TAIL, clipEdgeState, clipEnvelopeGain,
  findPrevOverlap, findNextOverlap,
  transitionGraphKey, isTransitionGraphKey, isGraphType, isCompoundType, compoundIdOf,
} from '../utils/clipTransitions.js'
import {
  ALPHA_IGNORE, ALPHA_MODE_INDEX, ALPHA_PROBE_SIZE, ALPHA_PROBE_MAX_ATTEMPTS,
  classifyAlphaSample, resolveAlphaMode, alphaSourceKey,
} from '../utils/alphaModes.js'
import { CLIP_TRANSFORM_NODE_ID, resolveClipTransform, isIdentityTransform, clipSupportsTransform } from '../utils/clipTransform.js'

// Node types that are not effect passes (sources, outputs, audio routing). Used
// to decide whether a graph actually has any effects worth running.
// NOTE: the self-drawing sources — IMAGE_INPUT, TEXT_INPUT, SHAPE_INPUT — are
// deliberately NOT listed: they produce pixels with no effect program, so a graph
// containing only (say) a shape → OUTPUT still has something to render.
const NON_EFFECT_TYPES = ['OUTPUT', 'CLIP_OUTPUT', 'EFFECT_OUTPUT', 'AUDIO_INPUT', 'AUDIO_SPLITTER', 'VIDEO_INPUT', 'CAMERA_INPUT', 'SCREEN_INPUT', 'CLIP_SOURCE', 'EFFECT_INPUT', 'TRANSITION_PROGRESS', 'ENVELOPE', 'RAMP', 'LFO']

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

// Source alpha interpretation — the video → clip_input pass (see utils/alphaModes).
// DaliVid's pipeline is STRAIGHT alpha throughout, so an imported source is
// converted here, once, and nothing downstream has to care where it came from.
// u_alpha_mode MUST match ALPHA_MODE_INDEX: 0 = ignore, 1 = straight, 2 = premultiplied.
const ALPHA_INTERPRET_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform int u_alpha_mode;
uniform vec3 u_alpha_matte;   // colour the source was matted against (usually black)
out vec4 fragColor;
void main() {
  vec4 c = texture(u_texture, v_uv);
  if (u_alpha_mode == 0) {          // Ignore — force opaque
    fragColor = vec4(c.rgb, 1.0);
    return;
  }
  if (u_alpha_mode == 2) {          // Premultiplied — undo src*a + matte*(1-a)
    float a = max(c.a, 1.0 / 255.0);
    vec3 straight = (c.rgb - u_alpha_matte * (1.0 - c.a)) / a;
    fragColor = vec4(clamp(straight, 0.0, 1.0), c.a);
    return;
  }
  fragColor = c;                    // Straight — already what the pipeline wants
}
`

// Preview backdrop — what "transparent" looks like on screen. Runs only when the
// backdrop is not plain black (the default present already composites over black
// for free via the colour mask), so the common path pays nothing.
const BACKDROP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform int u_backdrop;     // 0 = black, 1 = checkerboard, 2 = white
uniform int u_alpha_view;   // 1 = show the alpha channel as greyscale
out vec4 fragColor;
void main() {
  vec4 c = texture(u_texture, v_uv);
  if (u_alpha_view == 1) {  // Matte view: white = opaque, black = transparent
    fragColor = vec4(vec3(c.a), 1.0);
    return;
  }
  vec3 bg = vec3(0.0);
  if (u_backdrop == 1) {
    vec2 cell = floor(v_uv * u_resolution / 16.0);
    bg = mix(vec3(0.38), vec3(0.26), mod(cell.x + cell.y, 2.0));
  } else if (u_backdrop == 2) {
    bg = vec3(1.0);
  }
  fragColor = vec4(c.rgb + bg * (1.0 - c.a), 1.0);
}
`

// Present fragment shader — the compositor's LAST pass, screen-bound only.
//
// applyBlendMode accumulates in PREMULTIPLIED alpha: `composited = src * a +
// base.rgb * (1 - a)` with `outA = a`, which is the numerically correct space
// to composite in (and why the recursive base term isn't scaled by base.a).
// The canvas, however, is created with `premultipliedAlpha: false`, so the
// browser multiplies by alpha AGAIN when compositing the canvas onto the page.
// On an opaque frame (a == 1) the two conventions agree, which is why this
// never showed — it only bites on partial alpha, i.e. exactly a clip fading to
// or from nothing, where a linear 50% dissolve landed at 25% brightness.
//
// Undoing the premultiply once, here, fixes it without touching any FBO or
// blend mode: opaque pixels divide by 1.0 and come out bit-identical. Kept
// separate from PASSTHROUGH_FS because that shader is also used for FBO→FBO
// copies, where the premultiplied chain must be preserved.
const PRESENT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_texture, v_uv);
  fragColor = c.a > 0.0001 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}
`

// Un-premultiply for the alpha export path. Same principle as PRESENT_FS
// but kept separate because it runs with an alternate call path that reads
// the drawing buffer outside the colour mask.
const UNPREMULTIPLY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_texture, v_uv);
  fragColor = c.a > 0.0001 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
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

    // Per-source alpha probes (see utils/alphaModes). Keyed by media filename so
    // splits/duplicates of one file share a single detection.
    // { mode, attempts, settled } — `settled` stops the readPixels stall once a
    // verdict is in or the attempt budget is spent.
    this._alphaProbes = new Map()

    // Export flag: when true the present pass keeps REAL alpha in the drawing
    // buffer (un-premultiplied) instead of flattening onto black, so a PNG or a
    // VP9-alpha encode can carry transparency. See _presentToScreen.
    this._presentAlpha = false

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

    // Screen-bound present pass (un-premultiplies — see PRESENT_FS).
    const presentResult = createShaderProgram(this.gl, PRESENT_FS)
    this.presentProgram = presentResult

    const compResult = createShaderProgram(this.gl, COMPOSITE_FS)
    this.compositeProgram = compResult

    // Alpha handling: source interpretation on the way in, backdrop + matte view
    // on the way to the screen, un-premultiply on the way to an alpha export.
    this.alphaProgram = createShaderProgram(this.gl, ALPHA_INTERPRET_FS)
    this.backdropProgram = createShaderProgram(this.gl, BACKDROP_FS)
    this.unpremultiplyProgram = createShaderProgram(this.gl, UNPREMULTIPLY_FS)

    // Image source program — the IMAGE_INPUT shader (fit/transform/reactive).
    // Single source of truth: the same registry shader the node card parses for
    // its @param sliders, so the controls always match what's rendered.
    const imgSrc = getShaderSource('IMAGE_INPUT')
    if (imgSrc) this.imageProgram = createShaderProgram(this.gl, imgSrc)

    // Text source program — the TEXT_INPUT shader (transform + reactive). Same
    // single-source-of-truth pattern as the image program.
    const txtSrc = getShaderSource('TEXT_INPUT')
    if (txtSrc) this.textProgram = createShaderProgram(this.gl, txtSrc)

    // Shape source program — the SHAPE_INPUT SDF shader. Same pattern again; no
    // texture is involved, the shape is evaluated per-pixel.
    const shpSrc = getShaderSource('SHAPE_INPUT')
    if (shpSrc) this.shapeProgram = createShaderProgram(this.gl, shpSrc)

    // Master widescreen bars — the LETTERBOX node's own shader, driven with an
    // explicit custom ratio. Reusing it means the project-level toggle and the
    // in-graph node produce pixel-identical bars.
    const lbSrc = getShaderSource('LETTERBOX')
    if (lbSrc) this.barsProgram = createShaderProgram(this.gl, lbSrc)

    // Per-clip Pan / Zoom — the TRANSFORM node's own shader again, so a clip's
    // Inspector transform and an in-graph TRANSFORM node reframe identically.
    const xfSrc = getShaderSource('TRANSFORM')
    if (xfSrc) this.transformProgram = createShaderProgram(this.gl, xfSrc)
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
   * Render a TEXT source (TEXT_INPUT node OR a text timeline clip) into an FBO.
   * Rasterizes the text to a canvas (cached in textRegistry, re-drawn only when a
   * style/text/resolution change alters the signature), uploads it to a texture,
   * then draws it through the text program (transform + audio-reactive) so it can
   * feed downstream effect nodes exactly like an image/video source.
   * @param {string} id — node id or clip id (keys the raster + texture)
   * @param {string} fboId — destination FBO (already created/resized by caller)
   * @param {object} standardState — standard uniform state for this frame
   * @param {object} params — text + style params (+ u_txt_* transform uniforms)
   */
  renderTextNode(id, fboId, standardState, params) {
    const gl = this.gl
    if (!this.textProgram || !this.textProgram.program) return

    // Start from a clean transparent FBO (empty text reads as nothing).
    this.fbos.bind(fboId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Rasterize at (super-sampled) render resolution so text is crisp in preview
    // AND export. 2× oversampling gives smooth edges when the shader samples it
    // back down; capped so the canvas edge never exceeds the GPU's max texture.
    const maxTex = this.maxTextureSize || 2048
    const ss = Math.max(1, Math.min(2, maxTex / Math.max(this.width, this.height)))
    const rw = Math.max(1, Math.round(this.width * ss))
    const rh = Math.max(1, Math.round(this.height * ss))
    const entry = ensureText(id, params, rw, rh)
    const texId = `txt_${id}`
    let tex = this.textures.getTexture(texId)
    if (!tex || entry.uploadedSignature !== entry.signature) {
      // Re-create on any change: the canvas size tracks the output resolution.
      if (tex) this.textures.delete(texId)
      this.textures.create(texId, entry.canvas.width, entry.canvas.height)
      this.textures.uploadVideoFrame(texId, entry.canvas) // handles HTMLCanvasElement
      entry.uploadedSignature = entry.signature
      tex = this.textures.getTexture(texId)
    }

    gl.useProgram(this.textProgram.program)
    const locs = this.textProgram.uniformLocations
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (locs.u_image != null) gl.uniform1i(locs.u_image, 0)

    uploadStandardUniforms(gl, locs, standardState)
    uploadUniforms(gl, locs, this.textProgram.uniformTypes, params)

    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Render a SHAPE source (SHAPE_INPUT node OR a shape timeline clip) into an FBO.
   * Pure GPU: there is nothing to decode or upload — the SDF shader draws the
   * shape straight into the target FBO, so it costs one full-screen pass and is
   * resolution-independent in preview and export alike.
   * @param {string} fboId — destination FBO (already created/resized by caller)
   * @param {object} standardState — standard uniform state for this frame
   * @param {object} params — normalized shape params (u_shp_*, colors as vec3)
   */
  renderShapeNode(fboId, standardState, params) {
    const gl = this.gl
    if (!this.shapeProgram || !this.shapeProgram.program) return

    // Transparent start: everything the shape doesn't cover must composite as
    // "nothing", not black.
    this.fbos.bind(fboId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.shapeProgram.program)
    const locs = this.shapeProgram.uniformLocations
    uploadStandardUniforms(gl, locs, standardState)
    uploadUniforms(gl, locs, this.shapeProgram.uniformTypes, params)

    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * The project's widescreen-bars settings, or null when bars are off / unusable.
   * Read fresh each frame so toggling in the Toolbar or Inspector is immediate.
   */
  _masterBars() {
    const bars = this._getAppStore?.()?.masterBars
    if (!bars || !bars.enabled) return null
    if (!this.barsProgram || !this.barsProgram.program) return null
    return bars
  }

  /**
   * Present a finished frame to the screen: straight blit normally, or through
   * the letterbox pass when project widescreen bars are enabled. Export reads the
   * same canvas, so bars are baked into exports with no extra plumbing.
   *
   * ── Why the alpha is masked off ──
   * The compositor's output is PREMULTIPLIED (applyBlendMode returns
   * `src*a + base*(1-a)` with `outA = a + base.a*(1-a)`), but the canvas is
   * created `premultipliedAlpha: false`. Writing the accumulator's alpha
   * straight to the drawing buffer therefore made the browser multiply RGB by
   * alpha a SECOND time when compositing the canvas onto the page: a linear
   * fade rendered as a quadratic one (50% opacity showed at 25% brightness),
   * which is why a fade-out looked like it dropped out early and never landed
   * cleanly on "nothing" — and, since both export paths read this canvas, the
   * same wrong curve was baked into renders.
   *
   * The screen is cleared to OPAQUE black each frame and the present draw masks
   * alpha writes off, so the drawing buffer stays a=1 everywhere. That makes the
   * present exactly "composite over black" — the backdrop every NLE assumes —
   * and it costs nothing: no extra pass, no extra program. FBO passes are
   * unaffected; the mask is restored immediately.
   *
   * @param {string} fboId — FBO holding the finished frame
   * @param {object|null} bars — result of _masterBars() for this frame
   */
  _presentToScreen(fboId, bars) {
    const gl = this.gl

    // Export path: keep the real alpha instead of flattening onto black.
    if (this._presentAlpha) { this._presentAlphaToScreen(fboId, bars); return }

    const src = this._applyPreviewBackdrop(fboId)
    gl.colorMask(true, true, true, false)
    try {
      this._presentPass(src, bars)
    } finally {
      gl.colorMask(true, true, true, true)
    }
  }

  /**
   * Composite the finished frame over the preview backdrop (checkerboard/white),
   * or replace it with the alpha-matte view. Returns the FBO the present should
   * read — which is the INPUT unchanged in the default case, because "over
   * black" is already exactly what the colour-masked present does for free.
   * So the normal preview still costs zero extra passes.
   */
  _applyPreviewBackdrop(fboId) {
    // Both of these are things you look AT the picture through, never part of
    // the picture. Every export path reads this same canvas, so without this
    // gate an export started with the checkerboard on would bake a checkerboard
    // into the file — and one started in matte view would render a greyscale
    // matte. `previewTapEnabled` is already the renderer's "this frame is for
    // output, not for the eye" flag (both export paths and the frame save clear
    // it), so it is the right thing to hang this on.
    if (!this.previewTapEnabled) return fboId

    const app = this._getAppStore?.() || {}
    const backdrop = app.previewBackdrop || 'black'
    const alphaView = !!app.previewAlphaView
    if ((!alphaView && backdrop === 'black') || !this.backdropProgram?.program) return fboId

    const gl = this.gl
    const dstId = '__preview_backdrop'
    if (!this.fbos.getTexture(dstId)) this.fbos.create(dstId, this.width, this.height)
    else this.fbos.resize(dstId, this.width, this.height)

    this.fbos.bind(dstId)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.backdropProgram.program)
    const locs = this.backdropProgram.uniformLocations
    this.fbos.bindTexture(fboId, 0)
    if (locs.u_texture != null) gl.uniform1i(locs.u_texture, 0)
    if (locs.u_resolution != null) gl.uniform2f(locs.u_resolution, this.width, this.height)
    if (locs.u_backdrop != null) gl.uniform1i(locs.u_backdrop, backdrop === 'checker' ? 1 : backdrop === 'white' ? 2 : 0)
    if (locs.u_alpha_view != null) gl.uniform1i(locs.u_alpha_view, alphaView ? 1 : 0)
    this.drawQuad()

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return dstId
  }

  /**
   * Present with transparency intact, for an alpha export.
   *
   * Runs the ordinary present (including bars) into an FBO rather than the
   * screen, then un-premultiplies on the way to the drawing buffer: the
   * compositor's output is premultiplied but the canvas is
   * `premultipliedAlpha: false`, so straight colour is what it expects. The
   * colour mask is deliberately NOT applied here — the whole point is that the
   * drawing buffer keeps a real alpha channel for `toDataURL` / `VideoFrame`
   * to pick up. (`_renderFrame` clears the screen transparent to match.)
   */
  _presentAlphaToScreen(fboId, bars) {
    const gl = this.gl
    if (!this.unpremultiplyProgram?.program) { this._presentPass(fboId, bars); return }

    // Bars need a pass of their own before the un-premultiply; without them the
    // finished frame is already where it needs to be and the staging copy is
    // skipped entirely.
    let srcId = fboId
    if (bars) {
      srcId = '__present_alpha'
      if (!this.fbos.getTexture(srcId)) this.fbos.create(srcId, this.width, this.height)
      else this.fbos.resize(srcId, this.width, this.height)
      this._presentPass(fboId, bars, srcId)
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.unpremultiplyProgram.program)
    this.fbos.bindTexture(srcId, 0)
    const loc = this.unpremultiplyProgram.uniformLocations.u_texture
    if (loc != null) gl.uniform1i(loc, 0)
    this.drawQuad()
  }

  /**
   * The present draw itself (see _presentToScreen for the alpha handling).
   * `dstFBOId` null draws to the screen; an id draws into that FBO instead,
   * which is how the alpha-export path gets a bars-applied frame it can
   * un-premultiply.
   */
  _presentPass(fboId, bars, dstFBOId = null) {
    if (!bars) { this._blitToScreen(fboId, dstFBOId); return }

    const gl = this.gl
    const locs = this.barsProgram.uniformLocations
    if (dstFBOId) this.fbos.bind(dstFBOId)
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.barsProgram.program)

    this.fbos.bindTexture(fboId, 0)
    if (locs.u_texture != null) gl.uniform1i(locs.u_texture, 0)
    if (locs.u_resolution != null) gl.uniform2f(locs.u_resolution, this.width, this.height)
    // Drive the shader's "custom ratio" branch so the preset list in the node's
    // dropdown and the project setting stay independent.
    if (locs.u_lb_aspect != null) gl.uniform1i(locs.u_lb_aspect, 0)
    if (locs.u_lb_custom != null) gl.uniform1f(locs.u_lb_custom, Math.max(0.02, bars.aspect || 2.39))
    if (locs.u_lb_color != null) {
      const c = hexToVec3(bars.color || '#000000')
      gl.uniform3f(locs.u_lb_color, c[0], c[1], c[2])
    }
    if (locs.u_lb_opacity != null) gl.uniform1f(locs.u_lb_opacity, bars.opacity == null ? 1 : bars.opacity)
    if (locs.u_lb_feather != null) gl.uniform1f(locs.u_lb_feather, bars.feather || 0)
    if (locs.u_lb_offset != null) gl.uniform1f(locs.u_lb_offset, bars.offset || 0)
    if (locs.u_lb_zoom != null) gl.uniform1f(locs.u_lb_zoom, bars.zoom || 0)

    this.drawQuad()
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

    // Bind output FBO. FBOManager.bind already sets the viewport from the
    // target's OWN dimensions, and that is what makes scaled (half / quarter-res)
    // targets possible — this used to hard-code the canvas size straight
    // afterwards, silently overriding it, which is why a scaled pass would have
    // written one corner of its buffer. Identical behaviour for every full-size
    // FBO (they are all canvas-sized); the fallback covers drawing to the screen,
    // where there is no entry to read dimensions from.
    this.fbos.bind(outputFBOId)
    if (!outputFBOId) gl.viewport(0, 0, this.width, this.height)
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

    // Clear the screen. A timeline with clips clears to BLACK, because black is
    // what "no picture" means in a video program: it's the backdrop the present
    // pass flattens onto, so a clip fading out to nothing lands on exactly the
    // same colour the gap after it shows — no step at the end of the fade. The
    // empty-project idle colour stays the panel grey so a brand-new project
    // doesn't look like a dead output.
    //
    // An alpha export is the one exception: it wants "no picture" to mean
    // genuinely nothing, so uncovered regions land in the file as transparent
    // rather than as black.
    const hasTimelineContent = clips.length > 0
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    if (this._presentAlpha) gl.clearColor(0, 0, 0, 0)
    else if (hasTimelineContent) gl.clearColor(0, 0, 0, 1)
    else gl.clearColor(0.05, 0.05, 0.06, 1.0)
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

    // If in isolated clip graph mode, just render that clip's graph.
    //
    // A TRANSITION graph is the exception: it is meaningless in isolation (it
    // mixes two sides that only exist in the composite), so editing one keeps
    // the FULL pipeline on screen. Scrub the region and you watch the actual
    // transition you're building, in context, with the real neighbouring clip.
    const editingTransition = graphLevel === 'clip' && isTransitionGraphKey(graphClipId)
    if (graphLevel === 'clip' && graphClipId && !editingTransition) {
      this._renderClipGraphIsolated(graphClipId, clips, graphState, standardState)
    } else {
      // Full compositing pipeline
      this._renderFullPipeline(tracks, clips, graphState, standardState, playheadTime)
    }

    // High-performance direct DOM updates for modulated parameters to bypass React re-renders
    const displayElements = document.querySelectorAll('[data-node-param-display]')
    if (displayElements.length > 0) {
      // This pass reads the graph OPEN IN THE EDITOR, so the clip window is
      // cleared: buildTimeCtx then derives it from that graph's clip rather than
      // from whichever clip happened to render last.
      const floatOverrides = resolveFloatConnections(this, null, null, { ...standardState, clipTime: null, clipDuration: null })
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
    return clipEnvelopeGain(clip, clipEdgeState(clip, null, null, playheadTime))
  }

  _syncVideoPlayback(clip, videoEl, sourceTime, isMuted = false, gain = 1) {
    // ── Reversed clips ──
    // No browser supports a negative playbackRate, so a reversed clip is driven
    // as a seek-per-frame scrubber: the element stays PAUSED and we walk
    // currentTime backwards. Two consequences we lean on deliberately:
    //  · We never queue a second seek while one is in flight — the decoder is
    //    the bottleneck and a backlog would make the picture lag the playhead
    //    further every frame. The previous frame simply repeats instead, so the
    //    preview degrades to the decoder's seek rate rather than falling behind.
    //  · A paused element produces no sound, so reversed clips are SILENT in the
    //    preview. Export reverses the decoded AudioBuffer properly
    //    (ExportModal.renderTimelineAudio), so the rendered file does have audio.
    if (clip.reversed) {
      if (!videoEl.paused && !videoEl._playPending) videoEl.pause()
      if (videoEl._playbackGain) videoEl._playbackGain.gain.value = 0
      else if (!videoEl.muted) videoEl.muted = true

      // Never seek to exactly `duration`: that lands the element in the `ended`
      // state with no frame to present, which is black. A reversed clip's FIRST
      // frame is sourceEnd — normally the media duration exactly — so without
      // this clamp every reversed clip starts on a black frame.
      const dur = videoEl.duration
      const target = (Number.isFinite(dur) && dur > 0)
        ? Math.max(0, Math.min(sourceTime, dur - 0.04))
        : Math.max(0, sourceTime)

      // Seek/upload handshake. The render loop calls this BEFORE it uploads the
      // frame, so issuing a seek on every pass would leave `seeking` true at
      // upload time forever and the clip would never receive a decoded frame —
      // a permanently black preview. Asking for the next frame only once the
      // last one has actually been uploaded makes reverse alternate
      // seek-frame / upload-frame, which is correct and self-throttling: the
      // decoder, not the render loop, sets the pace. (`_lastUploadedTime` is
      // undefined for audio-only elements, which have no upload step — treat
      // those as always consumed so they still track the playhead.)
      const consumed = videoEl._lastUploadedTime == null ||
        videoEl._lastUploadedTime === videoEl.currentTime
      if (!videoEl.seeking && consumed && Math.abs(videoEl.currentTime - target) > 0.001) {
        videoEl.currentTime = target
        videoEl._lastSetSourceTime = target
      }
      return
    }

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
    const inputFBOId = `clip_input_${clip.id}`

    // ── Generator clips (text / image / shape) ──
    // No media element — the source frame is synthesized straight into the clip's
    // input FBO, then the shared per-clip graph tail runs exactly as for video.
    if (clip.fileType === 'image' || clip.fileType === 'text' || clip.fileType === 'shape') {
      if (!this.fbos.getTexture(inputFBOId)) this.fbos.create(inputFBOId, this.width, this.height)
      if (clip.fileType === 'image') {
        this.renderImageNode(clip.id, inputFBOId, standardState, normalizeParams(clip.params || {}))
      } else if (clip.fileType === 'shape') {
        this.renderShapeNode(inputFBOId, standardState, normalizeParams(clip.params || {}))
      } else {
        this.renderTextNode(clip.id, inputFBOId, standardState, clip.params || {})
      }
      const xfId = this._applyClipTransform(clip, inputFBOId, standardState, playheadTime)
      return this._runClipGraph(clip, xfId, graphState, standardState, playheadTime)
    }

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
    // Never sample MID-SEEK. While a seek is in flight `currentTime` already
    // reports the target but the decoder has not presented that frame yet, so
    // uploading now gets either a stale picture or — on a paused element — a
    // blank one. Holding the previous good texture until the seek lands is both
    // correct and what the eye expects (the picture holds, it doesn't flash).
    // The one exception is the very first frame, where there's no texture to
    // fall back on and something is better than black.
    const settled = !videoEl.seeking
    if (videoEl.readyState >= 2 &&
        (!hasTexture || (settled && videoEl.currentTime !== videoEl._lastUploadedTime))) {
      this.textures.uploadVideoFrame(texId, videoEl)
      // Only stamp a settled frame, so a bootstrap upload is re-done properly
      // once the decoder catches up.
      if (settled) videoEl._lastUploadedTime = videoEl.currentTime
      // Probe THIS frame for an alpha channel. Driven off the upload rather than
      // the frame loop so successive attempts see genuinely different pictures —
      // a clip can open on an opaque frame and reveal its alpha a second later.
      // Live streams are always opaque, so they never pay for a probe.
      if (settled && !isLiveStream) this._probeSourceAlpha(clip, texId)
    }

    if (!this.fbos.getTexture(inputFBOId)) {
      this.fbos.create(inputFBOId, this.width, this.height)
    }

    // Render the video texture into the clip's input FBO, converting whatever
    // the decoder handed us into the pipeline's straight-alpha convention.
    this._drawSourceWithAlpha(clip, texId, inputFBOId, isLiveStream)

    // Reframe (pan/zoom/rotate) before the clip's effect graph sees the frame.
    const xfFBOId = this._applyClipTransform(clip, inputFBOId, standardState, playheadTime)
    return this._runClipGraph(clip, xfFBOId, graphState, standardState, playheadTime)
  }

  /**
   * Apply a clip's Pan / Zoom / Rotate framing to its source frame, BEFORE its
   * effect graph runs — so effects operate on the picture you actually see (a
   * glitch on a punched-in shot glitches the punched-in framing, not the wide).
   *
   * Returns the FBO the graph should read from: the untouched input FBO when the
   * clip has no transform — the common case, costing no pass and no extra VRAM —
   * or a dedicated `clip_xf_<id>` FBO holding the reframed picture.
   *
   * Note this magnifies a canvas-resolution FBO, so a large punch-in on video is
   * a real upscale and will soften. Stills avoid that by zooming on the
   * IMAGE_INPUT node instead, which samples the image at its native size.
   *
   * @param {object} clip
   * @param {string} inputFBOId — FBO already holding the clip's source frame
   * @param {object} standardState — per-frame standard uniform state
   * @param {number} playheadTime — absolute timeline seconds
   * @returns {string} FBO id to feed the clip graph
   */
  _applyClipTransform(clip, inputFBOId, standardState, playheadTime) {
    if (!this.transformProgram || !this.transformProgram.program) return inputFBOId
    if (!clipSupportsTransform(clip)) return inputFBOId

    // Transform keyframes live under a reserved node id and, like every other
    // clip keyframe, are clip-relative in time so they survive the clip moving.
    const keyframes = this._getTimelineStore?.()?.keyframes
    const kfVals = keyframes && keyframes.length > 0
      ? evaluateKeyframes(keyframes, clip.id, playheadTime - clip.timelineStart)?.[CLIP_TRANSFORM_NODE_ID]
      : null
    if (!clip.transform && !kfVals) return inputFBOId

    const params = resolveClipTransform(clip.transform, kfVals)
    if (isIdentityTransform(params)) return inputFBOId

    const gl = this.gl
    const outFBOId = `clip_xf_${clip.id}`
    if (!this.fbos.getTexture(outFBOId)) this.fbos.create(outFBOId, this.width, this.height)

    // Transparent start: with the default "Transparent" edge mode, whatever the
    // framing doesn't cover must composite as nothing, not black.
    this.fbos.bind(outFBOId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.transformProgram.program)
    const locs = this.transformProgram.uniformLocations
    this.fbos.bindTexture(inputFBOId, 0)
    if (locs.u_texture != null) gl.uniform1i(locs.u_texture, 0)
    uploadStandardUniforms(gl, locs, standardState)
    uploadUniforms(gl, locs, this.transformProgram.uniformTypes, params)

    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    return outFBOId
  }

  /**
   * Draw a decoded source texture into `dstFBOId`, applying the clip's alpha
   * interpretation (see utils/alphaModes). This is the ONLY place an imported
   * source's alpha is reasoned about — everything downstream is straight alpha.
   *
   * @param {object} clip — the timeline clip (reads `alphaMode` / `alphaMatte`)
   * @param {string} texId — decoded source texture id
   * @param {string} dstFBOId — destination FBO (already created by the caller)
   * @param {boolean} isLive — live camera/screen streams are always opaque
   */
  _drawSourceWithAlpha(clip, texId, dstFBOId, isLive = false) {
    const gl = this.gl
    const prog = this.alphaProgram?.program ? this.alphaProgram : this.passthroughProgram

    this.fbos.bind(dstFBOId)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(prog.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.textures.getTexture(texId))
    const locs = prog.uniformLocations
    if (locs.u_texture != null) gl.uniform1i(locs.u_texture, 0)

    if (locs.u_alpha_mode != null) {
      // A live stream has no alpha to interpret; forcing Ignore also stops a
      // stray decoder alpha value from punching a hole in a camera feed.
      const mode = isLive
        ? ALPHA_IGNORE
        : resolveAlphaMode(clip.alphaMode, getDetectedAlpha(alphaSourceKey(clip)))
      gl.uniform1i(locs.u_alpha_mode, ALPHA_MODE_INDEX[mode] ?? ALPHA_MODE_INDEX.straight)
    }
    if (locs.u_alpha_matte != null) {
      const m = hexToVec3(clip.alphaMatte || '#000000')
      gl.uniform3f(locs.u_alpha_matte, m[0], m[1], m[2])
    }

    this.drawQuad()
  }

  /**
   * One-shot GPU probe: does this source actually carry an alpha channel, and if
   * so is it straight or premultiplied? (See `classifyAlphaSample` for the test.)
   *
   * Point-samples the decoded frame into a small RGBA8 FBO and reads it back.
   * Deliberately does NOT average: averaging would destroy the very relationship
   * being measured (premultiplied colour never exceeds its own alpha), whereas
   * point samples preserve each pixel's rgb-vs-a relationship exactly.
   *
   * `readPixels` is a synchronous GPU stall, so this is strictly budgeted: at
   * most ALPHA_PROBE_MAX_ATTEMPTS per source, ever, and it stops the instant it
   * finds alpha. Results are shared by filename, so splitting a clip is free.
   */
  _probeSourceAlpha(clip, texId) {
    const key = alphaSourceKey(clip)
    if (!key) return
    let rec = this._alphaProbes.get(key)
    if (rec?.settled) return
    if (!rec) {
      rec = { mode: ALPHA_IGNORE, attempts: 0, settled: false }
      this._alphaProbes.set(key, rec)
    }

    const gl = this.gl
    const tex = this.textures.getTexture(texId)
    if (!tex || !this.passthroughProgram?.program) return

    const probeId = '__alpha_probe'
    // RGBA8, not the default half-float: readPixels(RGBA/UNSIGNED_BYTE) is the
    // one format combination WebGL2 guarantees for a colour attachment.
    // `fixedSize` keeps setResolution's resizeAll from inflating the sample grid
    // to canvas size, which would leave the readback covering one corner of the
    // frame instead of the whole of it.
    if (!this.fbos.getTexture(probeId)) {
      this.fbos.create(probeId, ALPHA_PROBE_SIZE, ALPHA_PROBE_SIZE, { halfFloat: false, fixedSize: true })
    }

    try {
      this.fbos.bind(probeId)
      gl.viewport(0, 0, ALPHA_PROBE_SIZE, ALPHA_PROBE_SIZE)
      gl.useProgram(this.passthroughProgram.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      const loc = this.passthroughProgram.uniformLocations.u_texture
      if (loc != null) gl.uniform1i(loc, 0)
      this.drawQuad()

      const pixels = new Uint8Array(ALPHA_PROBE_SIZE * ALPHA_PROBE_SIZE * 4)
      gl.readPixels(0, 0, ALPHA_PROBE_SIZE, ALPHA_PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

      const { mode } = classifyAlphaSample(pixels)
      rec.attempts++
      if (mode !== ALPHA_IGNORE) {
        rec.mode = mode
        rec.settled = true
      } else if (rec.attempts >= ALPHA_PROBE_MAX_ATTEMPTS) {
        rec.settled = true
      }
      // Publish every verdict, including the interim "no alpha yet", so the
      // Inspector readout is never blank once a clip has rendered a frame.
      setDetectedAlpha(key, rec.mode)
    } catch (e) {
      // A probe is an optimisation, never a reason to lose a frame.
      console.warn('[DaliVid] Alpha probe failed:', e?.message)
      rec.settled = true
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, this.width, this.height)
    }
  }

  /**
   * Shared per-clip effect-graph tail: given the clip's source frame already in
   * `inputFBOId`, run its graph (if any) and return the FBO holding the result
   * (the graph output, or the input FBO when the clip has no effect nodes). Used
   * by every clip kind — video, live stream, image and text.
   */
  _runClipGraph(clip, inputFBOId, graphState, standardState, playheadTime) {
    const gl = this.gl
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
        standardState.hasSource = 1 // a real source frame feeds this clip graph
        // Clip-local time context for TIME nodes (Clip Time / Clip Progress), set
        // per clip like hasSource. Cleared before the master pass so a master TIME
        // node never inherits the last clip's window.
        this._setClipTimeContext(standardState, clip, playheadTime)
        // Keyframed params are clip-relative in time, so keys survive clip moves.
        const kfNodes = this._withKeyframes(buildNodeMap(clipGraph), clip.id, playheadTime - clip.timelineStart)
        executeChain(this, chain, inputFBOId, outputFBOId, standardState, {}, kfNodes, edges, this.previewTapEnabled ? clipGraph.tapPointNodeId : null)
        clipResultFBOId = outputFBOId
      }
    }

    return clipResultFBOId
  }

  /**
   * Stamp a clip's local time window onto the per-frame standard state, so TIME
   * nodes inside that clip's graph can resolve "Clip Time" (seconds from the
   * clip's first frame) and "Clip Progress" (0 → 1 across the clip). Pass
   * `clip = null` for the master graph, where both degenerate to the playhead.
   */
  _setClipTimeContext(standardState, clip, playheadTime) {
    if (!clip) {
      standardState.clipTime = null
      standardState.clipDuration = null
      return
    }
    standardState.clipTime = playheadTime - clip.timelineStart
    standardState.clipDuration = Math.max(0, clip.timelineEnd - clip.timelineStart)
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
    this._setClipTimeContext(standardState, clip, playheadTime)
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

    // Scratch buffer for transition-OUT only: the "before" state of the frame
    // (this clip already composited over the accumulator), which the transition
    // reads as u_from while dissolving TO the bare accumulator. Created lazily
    // on first use so a project with no transition-out never allocates it.
    const scratchId = '__compositor_scratch'

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

      // Edge state for every active clip, computed ONCE per frame and reused by
      // both the picture and the audio below — that shared derivation is the
      // point of utils/clipTransitions: sound can't drift from the image
      // because they read the same numbers.
      //
      // The neighbours are looked up from the FULL clip list, not from
      // `activeClips`. Using the active neighbours would be cheaper but wrong:
      // whether a clip overlaps this one's start or end is a property of the
      // timeline, not of this instant, and a neighbour can enter or leave the
      // active set part-way through a region. Deriving it from `activeClips`
      // made a region change length mid-play — the transition's progress would
      // jump, or a tail would snap back to full opacity the frame the next clip
      // became active. Two short scans per clip is a cheap price for a region
      // that holds still.
      const edgeStates = {}
      for (const c of activeClips) {
        edgeStates[c.id] = clipEdgeState(
          c, findPrevOverlap(c, clips), findNextOverlap(c, clips), playheadTime
        )
      }

      // Per-clip audio: volume × mute × whatever envelope owns this instant —
      // the plain fade ramp, or a transition's progress when one has taken the
      // window over. A head transition additionally ducks the clip it is
      // crossfading FROM, which is the one thing the outgoing clip's own state
      // can't know. Plain overlaps with no transition keep both clips audible
      // (layering is a valid use); mute or fade a clip to silence it.
      for (const c of activeClips) {
        this._audioGains[c.id] = clipEnvelopeGain(c, edgeStates[c.id])
      }
      for (const c of activeClips) {
        const es = edgeStates[c.id]
        if (!es.headTransition || es.head?.mode !== 'crossfade') continue
        // The outgoing clip is named by the region itself, not inferred from
        // ordering — and it is guaranteed active here, since the region ends at
        // its timelineEnd.
        const outId = es.head.prev.id
        if (this._audioGains[outId] != null) this._audioGains[outId] *= 1 - es.headProgress
      }

      for (let ci = 0; ci < activeClips.length; ci++) {
        const clip = activeClips[ci]
        const isLive = clip.fileType === 'camera' || clip.fileType === 'screen'
        // Generator clips (text/image/shape) synthesize their own frame — no fileUrl.
        const isGenerator = clip.fileType === 'image' || clip.fileType === 'text' || clip.fileType === 'shape'
        // Non-live, non-generator clips must be a renderable video file (fileUrl).
        if (!isLive && !isGenerator && (clip.fileType !== 'video' || !clip.fileUrl)) continue

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

        // `fade` is the plain linear ramp for whichever edge windows a shader
        // did NOT take over (clipEdgeState suppresses the ramp under a typed
        // transition, so the two can't stack into a double dip).
        const es = edgeStates[clip.id]
        const opacity = Math.max(0, Math.min(1, clipOpacity)) * Math.max(0, Math.min(1, trackOpacity)) * es.fade

        // Edge transitions own their window outright, replacing the blend
        // composite. At most one is live per frame — clipEdgeState already
        // resolves the short-clip case where the two regions overlap.
        //
        // Both directions are the SAME pass, only the sides swap:
        //   head → FROM = the accumulator (previous clip over the lower tracks,
        //          or just the backdrop when nothing precedes it), TO = the clip
        //   tail → FROM = the clip, TO = the accumulator (what's behind it)
        // which is what makes "transition out to nothing" work at all: the
        // outgoing side is a real texture and the incoming side is the empty
        // backdrop, the exact mirror of a transition in from nothing.
        let composited = false
        if (es.headTransition) {
          composited = this._compositeEdgeTransition(
            accumReadId, accumWriteId, accumReadId, clipResultFBOId,
            clip, EDGE_HEAD, es.headTransition, es.headProgress, opacity, standardState, graphState
          )
        } else if (es.tailTransition) {
          composited = this._compositeEdgeTransition(
            accumReadId, accumWriteId, clipResultFBOId, accumReadId,
            clip, EDGE_TAIL, es.tailTransition, es.tailProgress, opacity, standardState, graphState
          )
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
        // Audio visuals take the plain ramp: an audio clip has no picture to
        // transition, so its edges are always the default fade.
        const fade = clipEdgeState(clip, null, null, playheadTime).fade
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

      // The master chain ALWAYS renders into an FBO, never straight to the
      // screen, so that _presentToScreen is the single choke point every frame
      // passes through. It has to be: the alpha colour-mask, the preview
      // backdrop, the alpha-export un-premultiply and the widescreen bars are
      // all present-time concerns, and when the chain drew itself to the
      // drawing buffer (which it did whenever the master graph had effects and
      // bars were off) every one of them was silently skipped — including the
      // fade-out alpha fix, which is why it only ever worked on some projects.
      // The cost is one full-screen blit, i.e. exactly what a bars-on frame
      // already paid.
      const bars = this._masterBars()
      const presentFBOId = '__master_present'
      if (!this.fbos.getTexture(presentFBOId)) this.fbos.create(presentFBOId, this.width, this.height)
      else this.fbos.resize(presentFBOId, this.width, this.height)

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
        // A self-drawing source (IMAGE / TEXT / SHAPE) produces pixels with no
        // effect program, so the chain must run even with zero effect nodes
        // (source → OUTPUT).
        const hasGeneratorSource = this.masterChain.chain.some(n => n.isImage || n.isText || n.isShape)

        if (effectNodes.length > 0 || hasGeneratorSource) {
          // No video composited this frame → generative effects should self-display.
          standardState.hasSource = hasContent ? 1 : 0
          // Master graph has no clip window — a TIME node here reads the timeline.
          this._setClipTimeContext(standardState, null, playheadTime)
          const kfMaster = this._withKeyframes(buildNodeMap(masterGraph), 'master', playheadTime)
          executeChain(this, this.masterChain.chain, masterInputFBOId, presentFBOId, standardState, {}, kfMaster, this.masterChain.edges, this.previewTapEnabled ? masterGraph.tapPointNodeId : null)
          this._presentToScreen(presentFBOId, bars)
        } else {
          if (hasContent) this._presentToScreen(masterInputFBOId, bars)
        }
      } else {
        if (hasContent) this._presentToScreen(masterInputFBOId, bars)
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

    // Cleanup for generator clips (text/image): they back no media element, so
    // they never pass through the loop above. Track the ones we've rendered and
    // free a generator's resources once it leaves the timeline.
    if (!this._generatorClips) this._generatorClips = new Set()
    for (const c of clips) {
      if (c.fileType === 'image' || c.fileType === 'text' || c.fileType === 'shape') this._generatorClips.add(c.id)
    }
    if (this._generatorClips.size > 0) {
      const liveIds = new Set(clips.map(c => c.id))
      for (const id of [...this._generatorClips]) {
        if (!liveIds.has(id)) {
          this.releaseClipResources(id, graphState)
          this._generatorClips.delete(id)
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
    this.fbos.delete(`clip_xf_${clipId}`)   // pan/zoom pass (only exists if used)
    this.fbos.delete(`clip_output_${clipId}`)

    // Generator clips (text/image) key their source raster/texture by clip id.
    this.textures.delete(`img_${clipId}`)
    this.textures.delete(`txt_${clipId}`)
    removeNodeImage(clipId)
    removeText(clipId)

    // Node-transition FBOs are namespaced `…tr~<clipId>~<edge>~…` (see
    // _compositeGraphTransition); enumerate-and-match frees them without needing
    // to know which transition (or which of its inner nodes) ran.
    const trScope = `tr~${clipId}~`
    for (const key of [...this.fbos.fbos.keys()]) {
      if (key.includes(trScope)) this.fbos.delete(key)
    }

    // Free each node's GPU resources; releaseNodeResources descends into
    // compounds. The clip's graph is needed to enumerate its node ids — and its
    // two private transition graphs are clip-owned too, so they go with it.
    for (const key of [clipId, transitionGraphKey(clipId, EDGE_HEAD), transitionGraphKey(clipId, EDGE_TAIL)]) {
      const g = graphState?.clipGraphs?.[key]
      if (g?.nodes) for (const n of g.nodes) this.releaseNodeResources(n)
      this.compiledChains.delete(key)
      delete this._nodeTransitionChains[key]
    }
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
      this.fbos.delete(`__txt_${scope}${n.id}`)          // TEXT_INPUT source FBO
      this.textures.delete(`txt_${n.id}`)                // rasterized text texture (id-keyed)
      this.fbos.delete(`__shp_${scope}${n.id}`)          // SHAPE_INPUT source FBO (no texture)
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
   * Run one of a clip's edge transitions and composite the result. Dispatches on
   * the transition's type to one of three implementations, all of which share
   * the same FROM / TO / BACKDROP contract so a transition behaves identically
   * whichever edge it is on:
   *
   *   'graph'            → this clip edge's PRIVATE node graph (clipGraphs under
   *                        a synthetic key — see utils/clipTransitions)
   *   'compound:<libId>' → a shared compound-library entry
   *   anything else      → a built-in registry shader
   *
   * Same FBO contract as _compositeTrack: three distinct FBOs, caller ping-pongs.
   *
   * @param {string} baseFBOId — backdrop: the accumulator as it stands
   * @param {string} destFBOId — destination (must differ from base)
   * @param {string} fromFBOId — the side the region starts on
   * @param {string} toFBOId   — the side the region ends on
   * @param {object} clip
   * @param {string} edge      — EDGE_HEAD | EDGE_TAIL
   * @param {object} transition — { type, params }
   * @param {number} progress  — 0..1 across the region
   * @param {number} opacity   — 0..1 effective clip × track opacity
   * @param {object} standardState
   * @param {object} graphState — store snapshot (holds clipGraphs)
   * @returns {boolean} false → caller falls back to the plain blend composite
   *   (unknown type, missing graph, compile failure). Falling back rather than
   *   dropping the frame means a broken transition degrades to a hard cut
   *   instead of a black hole in the timeline.
   */
  _compositeEdgeTransition(baseFBOId, destFBOId, fromFBOId, toFBOId, clip, edge, transition, progress, opacity, standardState, graphState) {
    const type = transition?.type
    if (!type) return false

    if (isGraphType(type)) {
      const key = transitionGraphKey(clip.id, edge)
      const graph = graphState?.clipGraphs?.[key]
      if (!graph || !graph.nodes || graph.nodes.length === 0) {
        this._warnTransitionOnce(key, `[Renderer] Transition graph "${key}" is empty`)
        return false
      }
      return this._compositeGraphTransition(
        baseFBOId, destFBOId, fromFBOId, toFBOId, clip, edge,
        graph, key, null, null, progress, opacity, standardState
      )
    }

    if (isCompoundType(type)) {
      const libId = compoundIdOf(type)
      const entry = this._getGraphStore?.()?.compoundLibrary?.find(c => c.id === libId)
      if (!entry || !entry.subGraph) {
        this._warnTransitionOnce(type, `[Renderer] Node transition "${libId}" not found in compound library`)
        return false
      }
      return this._compositeGraphTransition(
        baseFBOId, destFBOId, fromFBOId, toFBOId, clip, edge,
        entry.subGraph, `lib:${libId}`, entry, transition.params, progress, opacity, standardState
      )
    }

    return this._compositeBuiltinTransition(
      baseFBOId, destFBOId, fromFBOId, toFBOId, transition, progress, opacity, standardState
    )
  }

  /** Warn once per key — a broken transition runs every frame, so this is the
   *  difference between one console line and a flooded console. */
  _warnTransitionOnce(key, message) {
    if (this._transitionWarned.has(key)) return
    this._transitionWarned.add(key)
    console.warn(message)
  }

  /**
   * Built-in registry transition: one full-screen shader pass. Standard uniforms
   * are uploaded, so transitions get u_time / u_beat / u_audio_rms for free
   * (audio-reactive with no wiring).
   * @returns {boolean} true if the pass ran
   */
  _compositeBuiltinTransition(baseFBOId, destFBOId, fromFBOId, toFBOId, transition, progress, opacity, standardState) {
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
      this._warnTransitionOnce(type, `[Renderer] Transition "${type}" failed to compile: ${prog.errors}`)
      return false
    }

    this.fbos.bind(destFBOId)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(prog.program)
    const locs = prog.uniformLocations
    this.fbos.bindTexture(fromFBOId, 0)
    if (locs.u_from != null) gl.uniform1i(locs.u_from, 0)
    this.fbos.bindTexture(toFBOId, 1)
    if (locs.u_to != null) gl.uniform1i(locs.u_to, 1)
    // The opacity fallback target. On a head pass this is the same FBO as
    // u_from (two units, one texture — free); on a tail it is the same as u_to.
    this.fbos.bindTexture(baseFBOId, 2)
    if (locs.u_backdrop != null) gl.uniform1i(locs.u_backdrop, 2)
    if (locs.u_progress != null) gl.uniform1f(locs.u_progress, progress)
    if (locs.u_opacity != null) gl.uniform1f(locs.u_opacity, opacity)

    uploadStandardUniforms(gl, locs, standardState)
    // Registry defaults overlaid with the clip's saved values. normalizeParams
    // converts '#rrggbb' colour params to vec3 — uploadUniforms can't guess.
    const params = normalizeParams({ ...getTransitionDefaults(type), ...(transition.params || {}) })
    uploadUniforms(gl, locs, prog.uniformTypes, params)

    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return true
  }

  /**
   * Node-graph transition: a sub-graph whose first two image EFFECT_INPUT
   * terminals are bound FROM / TO, with any TRANSITION_PROGRESS node inside
   * driven by the live region progress. Backs both the per-clip private graph
   * and shared compound-library entries — they differ only in where the graph
   * comes from and whether exposed-param overrides apply.
   *
   * @param {object} subGraph — { nodes, edges }
   * @param {string} cacheKey — compile-cache key (graph key, or `lib:<id>`)
   * @param {object|null} entry — library entry, when this is a shared compound
   * @param {object|null} overrides — exposed-param values by index (entry only)
   * @returns {boolean} false → caller falls back to the blend composite
   */
  _compositeGraphTransition(baseFBOId, destFBOId, fromFBOId, toFBOId, clip, edge, subGraph, cacheKey, entry, overrides, progress, opacity, standardState) {
    // Compile (or reuse) the sub-graph's chain.
    //
    // Invalidation is by `topologyVersion`, NOT by object identity: the store
    // replaces the graph object on every param change too, so identity would
    // recompile the whole sub-graph on each frame of a slider drag. Baked params
    // don't matter here — executeTransitionCompound passes a live node map, so
    // the executor reads current values off the graph regardless of what the
    // chain was compiled with. topologyVersion bumps on exactly the changes that
    // DO need a recompile (nodes, edges, shader source, bypass), and on project
    // load, so it is both sufficient and cheap.
    const topo = this._getGraphStore?.()?.topologyVersion ?? 0
    let cached = this._nodeTransitionChains[cacheKey]
    if (!cached || cached.topo !== topo) {
      const compiled = compileGraph(this.gl, subGraph)
      cached = { source: subGraph, topo, chain: compiled.chain, errors: compiled.errors }
      this._nodeTransitionChains[cacheKey] = cached
      if (compiled.errors?.length) {
        console.warn(`[Renderer] Transition graph "${cacheKey}" compiled with errors:`, compiled.errors)
      }
    }
    if (!cached.chain || cached.chain.length === 0) return false

    // Shared library entries expose params on the clip; a private graph is
    // edited directly, so its node params ARE the values (no override layer).
    let liveNodes = null
    const eps = entry?.exposedParams || []
    if (eps.length) {
      const vals = overrides || {}
      liveNodes = {}
      for (let i = 0; i < eps.length; i++) {
        const ep = eps[i]
        const map = ep.mappings?.[0]
        if (!map) continue
        const raw = vals[i] ?? ep.value ?? ep.paramConfig?.default
        const value = (typeof raw === 'number' && typeof map.scaleFactor === 'number')
          ? raw * map.scaleFactor + (map.offset || 0)
          : raw
        const inner = subGraph.nodes.find(n => n.id === map.nodeId)
        const base = liveNodes[map.nodeId]?.params ?? inner?.params ?? {}
        liveNodes[map.nodeId] = { params: { ...base, [map.uniformName]: value } }
      }
    }

    // The clip owns the transition, so a TIME node inside reads that clip's
    // window (region progress is available separately via TRANSITION_PROGRESS).
    this._setClipTimeContext(standardState, clip, standardState.playhead ?? 0)

    // Inner FBOs are namespaced per clip AND per edge, so a clip using the same
    // transition on both ends doesn't have its head and tail fighting over one
    // set of buffers. Freed by releaseClipResources (which matches on `tr~<id>~`).
    const resultFBO = executeTransitionCompound(
      this, cached.chain, subGraph, fromFBOId, toFBOId,
      standardState, progress, `tr~${clip.id}~${edge}~`, liveNodes
    )
    if (!resultFBO) return false

    this._compositeTrack(backdropFBOId, destFBOId, resultFBO, 0 /* Normal */, opacity)
    return true
  }

  /**
   * Blit an FBO to the screen (or to `dstFBOId`) using the passthrough shader.
   */
  _blitToScreen(fboId, dstFBOId = null) {
    const gl = this.gl
    const prog = this.passthroughProgram
    if (dstFBOId) this.fbos.bind(dstFBOId)
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(prog.program)
    this.fbos.bindTexture(fboId, 0)
    const loc = prog.uniformLocations.u_texture
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

    const appState = this._getAppStore ? this._getAppStore() : {}
    const playheadTime = appState.playheadTime || 0
    // Reassigned below once the source frame exists: the clip's pan/zoom pass
    // returns the FBO the graph should read, so the isolated view is framed the
    // same way the timeline is (authoring effects on the real framing).
    let inputFBOId = `clip_input_${clipId}`
    if (!this.fbos.getTexture(inputFBOId)) {
      this.fbos.create(inputFBOId, this.width, this.height)
    }

    if (clip.fileType === 'image' || clip.fileType === 'text' || clip.fileType === 'shape') {
      // Generator source (no media element): synthesize straight into the input
      // FBO so the clip graph — and this isolated editor view — see it directly.
      if (clip.fileType === 'image') this.renderImageNode(clipId, inputFBOId, standardState, normalizeParams(clip.params || {}))
      else if (clip.fileType === 'shape') this.renderShapeNode(inputFBOId, standardState, normalizeParams(clip.params || {}))
      else this.renderTextNode(clipId, inputFBOId, standardState, clip.params || {})
      // Pause any playing media while editing a generator clip.
      for (const [, el] of this._videoElements) { if (!el.paused) el.pause() }
    } else {
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
        this._probeSourceAlpha(clip, texId)
      }

      if (clip.fileType === 'audio') {
        // Audio-only clip: use the default blank FBO as input so visualizers have a texture
        this._ensureDefaultFBO()
        this.fbos.blit('__default_input', inputFBOId, this.width, this.height)
      } else {
        // Same alpha interpretation as the composited path, so keying a clip in
        // the isolated editor and then watching it on the timeline agree.
        this._drawSourceWithAlpha(clip, texId, inputFBOId)
      }
    }

    inputFBOId = this._applyClipTransform(clip, inputFBOId, standardState, playheadTime)

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
      this._setClipTimeContext(standardState, clip, playheadTime)
      const clipTap = this.previewTapEnabled ? clipGraph.tapPointNodeId : null

      // "Through master" preview: render the (tapped) clip result to an FBO, then
      // pass it through the master effect chain to screen — so a node can be
      // previewed *with* master FX applied, not only in raw isolation.
      const masterGraph = graphState.masterGraph
      const throughMaster = this.previewTapEnabled && appState.previewThroughMaster &&
        masterGraph && masterGraph.nodes.some(n => !NON_EFFECT_TYPES.includes(n.type))

      // Keyframes animate in the isolated view too, so authoring is WYSIWYG.
      const kfClipNodes = this._withKeyframes(buildNodeMap(clipGraph), clipId, playheadTime - clip.timelineStart)

      // Like the full pipeline, the isolated view lands in an FBO and presents
      // through _presentToScreen — so the transparency checkerboard and the
      // alpha-matte view work HERE, which is where keying is actually done.
      // Bars stay off in isolation (deliberate: a clip is not a delivery).
      const isoId = '__isolated_present'
      if (!this.fbos.getTexture(isoId)) this.fbos.create(isoId, this.width, this.height)
      else this.fbos.resize(isoId, this.width, this.height)

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
        executeChain(this, this.masterChain.chain, clipOutId, isoId, standardState, {}, kfMasterNodes, this.masterChain.edges, null)
      } else {
        executeChain(this, chain, inputFBOId, isoId, standardState, {}, kfClipNodes, edges, clipTap)
      }
      this._presentToScreen(isoId, null)
    } else {
      // No graph — present the source frame directly.
      this._presentToScreen(inputFBOId, null)
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
