/**
 * DaliVid — AudioEngine.js
 * Web Audio API engine providing:
 *  - 8-band FFT analysis (sub-bass → brilliance + RMS)
 *  - Beat detection via energy-threshold algorithm
 *  - Microphone input with latency offset
 *  - Source priority: solo clip > timeline audio > mic > silence
 *
 * Usage:
 *   const engine = new AudioEngine()
 *   engine.init()
 *   engine.connectMediaElement(videoEl)
 *   engine.startAnalysis(useAudioStore.getState)  // pass store accessor
 */

const BAND_RANGES = [
  [20, 60],     // 0: Sub-bass
  [60, 250],    // 1: Bass
  [250, 500],   // 2: Low-mid
  [500, 2000],  // 3: Mid
  [2000, 4000], // 4: Upper-mid
  [4000, 6000], // 5: Presence
  [6000, 20000],// 6: Brilliance
  // 7: RMS (computed separately)
]

export class AudioEngine {
  constructor() {
    this.ctx = null
    this.analyser = null
    this.fftSize = 2048
    this.smoothingTimeConstant = 0.8

    // Source nodes
    this.mediaSource = null
    this.micSource = null
    this.micStream = null

    // Gain nodes for routing
    this.mediaGain = null
    this.micGain = null
    this.masterGain = null

    // Analysis
    this.freqData = null
    this.timeData = null
    this.bandValues = new Float32Array(8)

    // Beat detection state
    this.beatEnergy = 0
    this.beatThreshold = 0.35
    this.beatDecay = 0.98
    this.beatMinInterval = 150 // ms
    this.lastBeatTime = 0

    // RAF
    this.rafId = null
    this.isRunning = false

    // Per-source (stem) analysers: name → { analyser, freqData, timeData,
    // bandValues, beatEnergy, beatThreshold, lastBeatTime, connected:Set }.
    // Tapped PRE-gain, so a muted stem clip still drives reactivity.
    this.sourceAnalysers = new Map()

    // Store accessor
    this._getStore = null

    // Active source tracking
    this.activeSource = 'silence' // 'solo' | 'track' | 'mic' | 'silence'
  }

  /**
   * Initialize the AudioContext and analyser node.
   * Must be called after a user gesture (click/keypress).
   */
  async init() {
    if (this.ctx) return

    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 44100,
      latencyHint: 'interactive',
    })

    // Create analyser
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = this.fftSize
    this.analyser.smoothingTimeConstant = this.smoothingTimeConstant
    this.analyser.minDecibels = -90
    this.analyser.maxDecibels = -10

    // Allocate typed arrays
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount)
    this.timeData = new Uint8Array(this.analyser.fftSize)

    // Gain nodes
    this.mediaGain = this.ctx.createGain()
    this.micGain = this.ctx.createGain()
    this.masterGain = this.ctx.createGain()

    // Route: media/mic → master → analyser → destination
    this.mediaGain.connect(this.masterGain)
    this.micGain.connect(this.masterGain)
    this.masterGain.connect(this.analyser)
    // Don't connect analyser to destination — we don't want to hear analysis output
    // Connect media directly to speakers for playback
    this.mediaGain.connect(this.ctx.destination)

    // Default mic off
    this.micGain.gain.value = 0

    console.log('[AudioEngine] Initialized, sample rate:', this.ctx.sampleRate)
  }

  /**
   * Connect an HTMLMediaElement (video or audio) as an audio source.
   *
   * Routing per element:
   *   source → playbackGain → mediaGain → (master analyser + speakers)
   *   source → per-name analyser              (full signal, PRE-gain)
   *
   * playbackGain carries the clip's audible level (mute/volume/fades — set by
   * the renderer each frame), so the MASTER analysis hears the audible mix
   * while a named source's analyser always hears the raw stem. That's what
   * lets a muted drums.wav still drive visuals.
   *
   * @param {HTMLMediaElement} mediaElement
   * @param {string|null} sourceName — clip filename for per-stem analysis
   */
  connectMediaElement(mediaElement, sourceName = null) {
    if (!this.ctx) return

    try {
      let sourceNode = mediaElement._mediaSourceNode
      if (!sourceNode) {
        sourceNode = this.ctx.createMediaElementSource(mediaElement)
        mediaElement._mediaSourceNode = sourceNode
        const playbackGain = this.ctx.createGain()
        mediaElement._playbackGain = playbackGain
        sourceNode.connect(playbackGain)
        playbackGain.connect(this.mediaGain)
        console.log('[AudioEngine] Created and connected media element source node')
      }
      this.mediaSource = sourceNode
      this.activeSource = 'track'

      // Per-source analysis tap (best-effort; never affects playback).
      if (sourceName) {
        let entry = this.sourceAnalysers.get(sourceName)
        if (!entry) {
          const analyser = this.ctx.createAnalyser()
          analyser.fftSize = this.fftSize
          analyser.smoothingTimeConstant = this.smoothingTimeConstant
          analyser.minDecibels = -90
          analyser.maxDecibels = -10
          entry = {
            analyser,
            freqData: new Uint8Array(analyser.frequencyBinCount),
            timeData: new Uint8Array(analyser.fftSize),
            bandValues: new Float32Array(8),
            beatEnergy: 0,
            beatThreshold: 0.35,
            lastBeatTime: 0,
            connected: new Set(),
          }
          this.sourceAnalysers.set(sourceName, entry)
        }
        if (!entry.connected.has(sourceNode)) {
          sourceNode.connect(entry.analyser)
          entry.connected.add(sourceNode)
        }
      }
    } catch (e) {
      console.warn('[AudioEngine] Could not connect media element:', e.message)
    }
  }

  /**
   * Connect a raw MediaStream (e.g., from getUserMedia).
   */
  connectStream(stream) {
    if (!this.ctx) return

    if (this.micSource) {
      try { this.micSource.disconnect() } catch { /* ok */ }
    }

    this.micSource = this.ctx.createMediaStreamSource(stream)
    this.micSource.connect(this.micGain)
    this.micStream = stream
  }

  /**
   * Route an externally-provided stream's audio (e.g. a webcam's microphone
   * track captured alongside its video) into the mic input path so it is
   * analysed and monitored. Returns true if an audio track was connected.
   */
  async useExternalAudioStream(stream) {
    if (!this.ctx) await this.init()
    if (!stream || typeof stream.getAudioTracks !== 'function') return false
    if (stream.getAudioTracks().length === 0) return false

    this.connectStream(stream)
    this.micGain.gain.setValueAtTime(1, this.ctx.currentTime)
    this.activeSource = 'mic'
    console.log('[AudioEngine] External audio stream connected')
    return true
  }

  /**
   * Enable/disable microphone input.
   */
  async enableMic(enable = true) {
    if (!this.ctx) await this.init()

    if (enable) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        })
        this.connectStream(stream)
        this.micGain.gain.setValueAtTime(1, this.ctx.currentTime)
        this.activeSource = 'mic'
        console.log('[AudioEngine] Microphone enabled')
        return true
      } catch (err) {
        console.error('[AudioEngine] Mic access denied:', err)
        return false
      }
    } else {
      this.micGain.gain.setValueAtTime(0, this.ctx.currentTime)
      if (this.micStream) {
        this.micStream.getTracks().forEach(t => t.stop())
        this.micStream = null
      }
      if (this.micSource) {
        try { this.micSource.disconnect() } catch { /* ok */ }
        this.micSource = null
      }
      this.activeSource = this.mediaSource ? 'track' : 'silence'
      console.log('[AudioEngine] Microphone disabled')
      return true
    }
  }

  /**
   * Start the analysis loop. Writes to Zustand store every frame.
   * @param {Function} getStore — () => store state with updateBands, updateBeat, updatePeakHold
   */
  startAnalysis(getStore) {
    this._getStore = getStore
    if (this.isRunning) return

    this.isRunning = true
    this._analysisLoop()
  }

  /**
   * Stop the analysis loop.
   */
  stopAnalysis() {
    this.isRunning = false
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /**
   * Internal analysis loop — runs at display refresh rate.
   */
  _analysisLoop() {
    if (!this.isRunning) return

    this.rafId = requestAnimationFrame(() => {
      this._analyze()
      this._analysisLoop()
    })
  }

  /**
   * Read an analyser and fill `bandValues` with the 8 bands (7 FFT + RMS).
   * Shared by the master mix and every per-source (stem) analyser.
   */
  _extractBandsInto(analyser, freqData, timeData, bandValues) {
    analyser.getByteFrequencyData(freqData)
    analyser.getByteTimeDomainData(timeData)

    const binCount = analyser.frequencyBinCount
    const sampleRate = this.ctx.sampleRate
    const hzPerBin = sampleRate / this.fftSize

    for (let b = 0; b < 7; b++) {
      const [lo, hi] = BAND_RANGES[b]
      const startBin = Math.floor(lo / hzPerBin)
      const endBin = Math.min(Math.floor(hi / hzPerBin), binCount - 1)

      let sum = 0
      let count = 0
      for (let i = startBin; i <= endBin; i++) {
        sum += freqData[i] / 255
        count++
      }
      bandValues[b] = count > 0 ? sum / count : 0
    }

    let rmsSum = 0
    for (let i = 0; i < timeData.length; i++) {
      const sample = (timeData[i] - 128) / 128
      rmsSum += sample * sample
    }
    bandValues[7] = Math.sqrt(rmsSum / timeData.length)
  }

  /**
   * Perform FFT analysis and extract 8-band values + beat detection —
   * for the master mix and every connected per-source (stem) analyser.
   */
  _analyze() {
    if (!this.analyser || !this.freqData) return

    this._extractBandsInto(this.analyser, this.freqData, this.timeData, this.bandValues)

    // Beat detection — energy threshold on bass + sub-bass
    const bassEnergy = (this.bandValues[0] + this.bandValues[1]) * 0.5
    const now = performance.now()
    const isBeat = bassEnergy > this.beatThreshold &&
                   bassEnergy > this.beatEnergy * 1.2 &&
                   (now - this.lastBeatTime) > this.beatMinInterval

    this.beatEnergy = this.beatEnergy * this.beatDecay + bassEnergy * (1 - this.beatDecay)

    if (isBeat) {
      this.lastBeatTime = now
      // Adaptive threshold
      this.beatThreshold = this.beatThreshold * 0.95 + bassEnergy * 0.05
    }

    // Per-source stems: same extraction + per-source beat state.
    let sourceResults = null
    for (const [name, entry] of this.sourceAnalysers) {
      this._extractBandsInto(entry.analyser, entry.freqData, entry.timeData, entry.bandValues)
      const e = (entry.bandValues[0] + entry.bandValues[1]) * 0.5
      const srcBeat = e > entry.beatThreshold &&
                      e > entry.beatEnergy * 1.2 &&
                      (now - entry.lastBeatTime) > this.beatMinInterval
      entry.beatEnergy = entry.beatEnergy * this.beatDecay + e * (1 - this.beatDecay)
      if (srcBeat) {
        entry.lastBeatTime = now
        entry.beatThreshold = entry.beatThreshold * 0.95 + e * 0.05
      }
      if (!sourceResults) sourceResults = {}
      sourceResults[name] = { bands: entry.bandValues, isBeat: srcBeat }
    }

    // Write to store
    if (this._getStore) {
      const store = this._getStore()
      store.updateBands(this.bandValues)
      store.updateBeat(isBeat)
      store.updatePeakHold()
      if (sourceResults && store.updateSources) store.updateSources(sourceResults)
    }
  }

  /**
   * Resume AudioContext (required after user gesture).
   */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume()
      console.log('[AudioEngine] Context resumed')
    }
  }

  /**
   * Set latency offset for mic input (ms).
   */
  setLatencyOffset(ms) {
    // Latency offset is applied when syncing audio with video
    // This is handled at the rendering level, not the audio level
    this._latencyOffset = ms
  }

  /**
   * Get current FFT band values (for direct access without store).
   */
  getBands() {
    return this.bandValues
  }

  /**
   * Clean up all audio resources.
   */
  dispose() {
    this.stopAnalysis()

    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop())
    }

    if (this.mediaSource) {
      try { this.mediaSource.disconnect() } catch { /* ok */ }
    }
    if (this.micSource) {
      try { this.micSource.disconnect() } catch { /* ok */ }
    }

    if (this.ctx) {
      this.ctx.close().catch(() => {})
    }

    this.ctx = null
    this.analyser = null
    this.mediaSource = null
    this.micSource = null
    this.micStream = null

    console.log('[AudioEngine] Disposed')
  }
}

// Singleton instance
let _instance = null

export function getAudioEngine() {
  if (!_instance) {
    _instance = new AudioEngine()
  }
  return _instance
}

export default AudioEngine
