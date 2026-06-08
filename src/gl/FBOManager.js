/**
 * DaliVid — FBOManager.js
 * Manages framebuffer allocation, ping-pong double-buffering,
 * and thumbnail extraction for the node graph.
 */

export class FBOManager {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl
    this.fbos = new Map() // id → { fbo, texture, width, height }
    this.pingPongPairs = new Map() // id → { current: 0|1, fbos: [fbo0, fbo1] }
    this.thumbnailFBO = null
    this.thumbnailSize = 64
    this._hasHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float')
    this._hasLinearHalfFloat = !!gl.getExtension('OES_texture_half_float_linear')
  }

  /**
   * Create a framebuffer with a color attachment.
   * @param {string} id
   * @param {number} width
   * @param {number} height
   * @param {object} [options]
   * @returns {{ fbo: WebGLFramebuffer, texture: WebGLTexture }}
   */
  create(id, width, height, options = {}) {
    const gl = this.gl
    const { halfFloat = true } = options

    const fbo = gl.createFramebuffer()
    const texture = gl.createTexture()

    let internalFormat, format, type, filter
    if (halfFloat && this._hasHalfFloat) {
      internalFormat = gl.RGBA16F
      format = gl.RGBA
      type = gl.HALF_FLOAT
      filter = this._hasLinearHalfFloat ? gl.LINEAR : gl.NEAREST
    } else {
      internalFormat = gl.RGBA8
      format = gl.RGBA
      type = gl.UNSIGNED_BYTE
      filter = gl.LINEAR
    }

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

    // Check completeness
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn(`[FBOManager] FBO ${id} incomplete (${status}). Falling back to RGBA8.`)
      // Fallback to RGBA8 if half-float failed
      if (halfFloat && this._hasHalfFloat) {
        gl.deleteFramebuffer(fbo)
        gl.deleteTexture(texture)
        return this.create(id, width, height, { halfFloat: false })
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const entry = { fbo, texture, width, height, internalFormat, format, type }
    this.fbos.set(id, entry)
    return entry
  }

  /**
   * Create a ping-pong pair for feedback effects (u_prev_frame).
   * @param {string} id — base ID (creates id_0 and id_1)
   * @param {number} width
   * @param {number} height
   * @returns {{ read, write, swap }}
   */
  createPingPong(id, width, height) {
    const fbo0 = this.create(`${id}_0`, width, height)
    const fbo1 = this.create(`${id}_1`, width, height)

    const pair = {
      current: 0,
      fbos: [fbo0, fbo1],
      get read() { return this.fbos[this.current] },
      get write() { return this.fbos[1 - this.current] },
      swap() { this.current = 1 - this.current },
    }

    this.pingPongPairs.set(id, pair)
    return pair
  }

  /**
   * Get a ping-pong pair by base ID.
   */
  getPingPong(id) {
    return this.pingPongPairs.get(id) || null
  }

  /**
   * Bind an FBO for rendering.
   * @param {string} id — null to bind default framebuffer (screen)
   */
  bind(id) {
    const gl = this.gl
    if (id === null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return
    }
    const entry = this.fbos.get(id)
    if (entry) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, entry.fbo)
      gl.viewport(0, 0, entry.width, entry.height)
    }
  }

  /**
   * Bind an FBO's texture for reading (as input to next pass).
   * @param {string} id
   * @param {number} unit — texture unit to bind to
   */
  bindTexture(id, unit = 0) {
    const gl = this.gl
    const entry = this.fbos.get(id)
    if (entry) {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
    }
  }

  /**
   * Get the WebGLTexture from an FBO.
   */
  getTexture(id) {
    const entry = this.fbos.get(id)
    return entry ? entry.texture : null
  }

  /**
   * Resize an existing FBO (e.g. when canvas resolution changes).
   */
  resize(id, width, height) {
    const gl = this.gl
    const entry = this.fbos.get(id)
    if (!entry) return
    if (entry.width === width && entry.height === height) return

    gl.bindTexture(gl.TEXTURE_2D, entry.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, entry.internalFormat, width, height, 0,
                  entry.format, entry.type, null)
    entry.width = width
    entry.height = height
  }

  /**
   * Resize all managed FBOs to a new resolution (except the thumbnail FBO).
   */
  resizeAll(width, height) {
    for (const [id] of this.fbos) {
      if (id === '__thumbnail__') continue
      this.resize(id, width, height)
    }
  }

  /**
   * Resize a ping-pong pair.
   */
  resizePingPong(id, width, height) {
    this.resize(`${id}_0`, width, height)
    this.resize(`${id}_1`, width, height)
  }

  /**
   * Blit from one FBO to another (or to screen).
   * @param {string} srcId — source FBO id
   * @param {string|null} dstId — destination FBO id (null = screen)
   * @param {number} dstWidth
   * @param {number} dstHeight
   */
  blit(srcId, dstId, dstWidth, dstHeight) {
    const gl = this.gl
    const src = this.fbos.get(srcId)
    if (!src) return

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo)

    if (dstId === null) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    } else {
      const dst = this.fbos.get(dstId)
      if (!dst) return
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo)
      dstWidth = dst.width
      dstHeight = dst.height
    }

    gl.blitFramebuffer(
      0, 0, src.width, src.height,
      0, 0, dstWidth, dstHeight,
      gl.COLOR_BUFFER_BIT, gl.LINEAR
    )

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
  }

  /**
   * Extract a 64x64 thumbnail from an FBO to a canvas element.
   * Uses blitting for GPU-side downsampling (no readPixels).
   * @param {string} srcId — source FBO
   * @param {HTMLCanvasElement} targetCanvas — 64x64 canvas ref
   */
  extractThumbnail(srcId, targetCanvas) {
    const gl = this.gl
    const src = this.fbos.get(srcId)
    if (!src || !targetCanvas) return

    // Ensure thumbnail FBO exists
    if (!this.thumbnailFBO) {
      this.thumbnailFBO = this.create('__thumbnail__', this.thumbnailSize, this.thumbnailSize, { halfFloat: false })
    }

    // Blit source → thumbnail FBO
    this.blit(srcId, '__thumbnail__', this.thumbnailSize, this.thumbnailSize)

    // Read pixels from thumbnail FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.thumbnailFBO.fbo)
    const pixels = new Uint8Array(this.thumbnailSize * this.thumbnailSize * 4)
    gl.readPixels(0, 0, this.thumbnailSize, this.thumbnailSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // Write to canvas
    const ctx = targetCanvas.getContext('2d')
    const imageData = ctx.createImageData(this.thumbnailSize, this.thumbnailSize)
    // Flip Y (WebGL is bottom-up)
    for (let y = 0; y < this.thumbnailSize; y++) {
      const srcRow = (this.thumbnailSize - 1 - y) * this.thumbnailSize * 4
      const dstRow = y * this.thumbnailSize * 4
      for (let x = 0; x < this.thumbnailSize * 4; x++) {
        imageData.data[dstRow + x] = pixels[srcRow + x]
      }
    }
    ctx.putImageData(imageData, 0, 0)
  }

  /**
   * Read pixels from an FBO (for scopes, export, etc.).
   */
  readPixels(id, x, y, width, height) {
    const gl = this.gl
    const entry = this.fbos.get(id)
    if (!entry) return null

    gl.bindFramebuffer(gl.FRAMEBUFFER, entry.fbo)
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return pixels
  }

  /**
   * Delete an FBO.
   */
  delete(id) {
    const gl = this.gl
    const entry = this.fbos.get(id)
    if (entry) {
      gl.deleteFramebuffer(entry.fbo)
      gl.deleteTexture(entry.texture)
      this.fbos.delete(id)
    }
  }

  /**
   * Clean up all FBOs.
   */
  dispose() {
    for (const [id] of this.fbos) {
      this.delete(id)
    }
    this.fbos.clear()
    this.pingPongPairs.clear()
  }
}
