/**
 * DaliVid — TextureManager.js
 * Manages WebGL texture allocation, video/camera frame uploads,
 * and an LRU texture unit cache.
 */

export class TextureManager {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl
    this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)
    this.textures = new Map() // id → { texture, unit, lastUsed, width, height }
    this.nextUnit = 0
    this.unitAssignments = new Map() // unit → textureId
    this.frameCounter = 0
  }

  /**
   * Create a new empty texture.
   * @param {string} id — unique texture identifier
   * @param {number} width
   * @param {number} height
   * @param {object} options — { format, internalFormat, type, filter, wrap }
   * @returns {WebGLTexture}
   */
  create(id, width, height, options = {}) {
    const gl = this.gl
    const {
      internalFormat = gl.RGBA8,
      format = gl.RGBA,
      type = gl.UNSIGNED_BYTE,
      filter = gl.LINEAR,
      wrap = gl.CLAMP_TO_EDGE,
    } = options

    const texture = gl.createTexture()
    const unit = this._assignUnit(id)

    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)

    this.textures.set(id, {
      texture,
      unit,
      lastUsed: this.frameCounter,
      width,
      height,
      internalFormat,
      format,
      type,
    })

    return texture
  }

  /**
   * Create a texture optimized for half-float (HDR pipeline).
   * Falls back to RGBA8 if half-float is unavailable.
   */
  createHalfFloat(id, width, height) {
    const gl = this.gl
    // Check for half-float support
    const halfFloatExt = gl.getExtension('EXT_color_buffer_half_float')
    const linearExt = gl.getExtension('OES_texture_half_float_linear')

    if (halfFloatExt) {
      return this.create(id, width, height, {
        internalFormat: gl.RGBA16F,
        format: gl.RGBA,
        type: gl.HALF_FLOAT,
        filter: linearExt ? gl.LINEAR : gl.NEAREST,
      })
    }

    // Fallback to RGBA8
    return this.create(id, width, height)
  }

  /**
   * Upload a video/camera frame to an existing texture via texSubImage2D.
   * @param {string} id — texture id
   * @param {HTMLVideoElement|HTMLCanvasElement|ImageBitmap} source
   */
  uploadVideoFrame(id, source) {
    const gl = this.gl
    const entry = this.textures.get(id)
    if (!entry) return

    const unit = this._bindForUpdate(id)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, entry.texture)

    // Skip uploading if it's an audio-only video element (videoWidth === 0)
    if (source instanceof HTMLVideoElement && source.videoWidth === 0) {
      return
    }

    // Use texSubImage2D for efficiency if dimensions match
    const sourceWidth = source.videoWidth || source.width
    const sourceHeight = source.videoHeight || source.height

    // HTML elements are top-down, WebGL expects bottom-up
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    if (entry.width === sourceWidth && entry.height === sourceHeight) {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        entry.format, entry.type, source
      )
    } else {
      // Dimensions changed — reallocate
      entry.width = sourceWidth
      entry.height = sourceHeight
      gl.texImage2D(
        gl.TEXTURE_2D, 0, entry.internalFormat,
        entry.format, entry.type, source
      )
    }

    // Reset state
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)

    entry.lastUsed = this.frameCounter
  }

  /**
   * Upload raw pixel data to a texture.
   */
  uploadData(id, width, height, data, options = {}) {
    const gl = this.gl
    const entry = this.textures.get(id)
    if (!entry) return

    const {
      format = gl.RGBA,
      type = gl.UNSIGNED_BYTE,
    } = options

    const unit = this._bindForUpdate(id)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, entry.texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, type, data)
    entry.lastUsed = this.frameCounter
  }

  /**
   * Bind a texture to its assigned texture unit for sampling.
   * @param {string} id
   * @param {number} [uniformUnit] — override the unit to bind to (for sampler uniforms)
   * @returns {number} the texture unit
   */
  bind(id, uniformUnit = undefined) {
    const gl = this.gl
    const entry = this.textures.get(id)
    if (!entry) return -1

    const unit = uniformUnit !== undefined ? uniformUnit : entry.unit
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, entry.texture)
    entry.lastUsed = this.frameCounter
    return unit
  }

  /**
   * Get the raw WebGLTexture object.
   */
  getTexture(id) {
    const entry = this.textures.get(id)
    return entry ? entry.texture : null
  }

  /**
   * Get the texture unit assigned to this texture.
   */
  getUnit(id) {
    const entry = this.textures.get(id)
    return entry ? entry.unit : -1
  }

  /**
   * Delete a texture.
   */
  delete(id) {
    const gl = this.gl
    const entry = this.textures.get(id)
    if (entry) {
      gl.deleteTexture(entry.texture)
      this.unitAssignments.delete(entry.unit)
      this.textures.delete(id)
    }
  }

  /**
   * Advance the frame counter (call once per frame).
   */
  tick() {
    this.frameCounter++
  }

  /**
   * Assign a texture unit via LRU eviction.
   */
  _assignUnit(id) {
    // Use reserved units first (0-7 for standard textures)
    if (this.nextUnit < this.maxTextureUnits - 2) {
      const unit = this.nextUnit++
      this.unitAssignments.set(unit, id)
      return unit
    }

    // Evict LRU — find the least recently used unit
    let lruUnit = 0
    let lruTime = Infinity
    for (const [unit, texId] of this.unitAssignments) {
      const entry = this.textures.get(texId)
      if (entry && entry.lastUsed < lruTime) {
        lruTime = entry.lastUsed
        lruUnit = unit
      }
    }

    const evictedId = this.unitAssignments.get(lruUnit)
    if (evictedId) {
      const evicted = this.textures.get(evictedId)
      if (evicted) evicted.unit = -1 // Mark as unbound
    }

    this.unitAssignments.set(lruUnit, id)
    return lruUnit
  }

  /**
   * Ensure texture is bound for update (reassign unit if evicted).
   */
  _bindForUpdate(id) {
    const entry = this.textures.get(id)
    if (!entry) return 0
    if (entry.unit === -1) {
      entry.unit = this._assignUnit(id)
    }
    return entry.unit
  }

  /**
   * Clean up all textures.
   */
  dispose() {
    const gl = this.gl
    for (const [, entry] of this.textures) {
      gl.deleteTexture(entry.texture)
    }
    this.textures.clear()
    this.unitAssignments.clear()
  }
}
