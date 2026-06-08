/**
 * DaliVid — useAudioStore.js
 * Audio state: frequency bands, beat detection, source priority.
 */

import { create } from 'zustand'

const useAudioStore = create((set, get) => ({
  // ── FFT Band Values (0.0 – 1.0) ──
  bands: new Float32Array(8), // [sub-bass, bass, low-mid, mid, upper-mid, presence, brilliance, rms]
  smoothedBands: new Float32Array(8),

  // ── Named Aliases ──
  rms: 0,
  bass: 0,    // bands[1]
  mid: 0,     // bands[3]
  treble: 0,  // bands[6]

  // ── Beat Detection ──
  beat: 0,       // 0.0–1.0, decays fast
  beatCount: 0,  // total beats since playback start
  isBeat: false, // instantaneous beat flag

  // ── Peak Hold (for Scopes) ──
  peakHold: new Float32Array(8),

  // ── Source Priority ──
  activeSource: 'silence', // 'solo' | 'track' | 'mic' | 'silence'
  activeSourceName: 'None',

  // ── Audio Engine State ──
  engineReady: false,
  micEnabled: false,
  latencyOffset: 0, // ms, -500 to +500

  // ── Audio Bindings (for shader params) ──
  bindings: [], // { graphContext, nodeId, paramName, bandIndex, multiplier, offset, invert }

  // ── Actions ──

  /**
   * Update band values from the audio engine (called every frame).
   */
  updateBands: (newBands) => {
    const state = get()
    const smoothed = new Float32Array(8)

    for (let i = 0; i < 8; i++) {
      const current = newBands[i] || 0
      const prev = state.smoothedBands[i]
      // Attack/release smoothing
      const alpha = current > prev ? 0.3 : 0.1
      smoothed[i] = current * alpha + prev * (1 - alpha)
    }

    set({
      bands: new Float32Array(newBands),
      smoothedBands: smoothed,
      rms: smoothed[7],
      bass: smoothed[1],
      mid: smoothed[3],
      treble: smoothed[6],
    })
  },

  /**
   * Update beat from the audio engine.
   */
  updateBeat: (isBeat) => {
    set((state) => ({
      isBeat,
      beat: isBeat ? 1.0 : state.beat * 0.85,
      beatCount: isBeat ? state.beatCount + 1 : state.beatCount,
    }))
  },

  /**
   * Update peak hold values (decay 2dB/frame ≈ multiply by 0.977).
   */
  updatePeakHold: () => {
    set((state) => {
      const peaks = new Float32Array(8)
      for (let i = 0; i < 8; i++) {
        peaks[i] = Math.max(state.smoothedBands[i], state.peakHold[i] * 0.977)
      }
      return { peakHold: peaks }
    })
  },

  /**
   * Set the active audio source.
   */
  setActiveSource: (source, name = '') => {
    set({ activeSource: source, activeSourceName: name || source })
  },

  /**
   * Set audio engine ready state.
   */
  setEngineReady: (ready) => set({ engineReady: ready }),

  /**
   * Toggle microphone.
   */
  toggleMic: () => set((state) => ({ micEnabled: !state.micEnabled })),

  /**
   * Set latency offset.
   */
  setLatencyOffset: (ms) => set({ latencyOffset: Math.max(-500, Math.min(500, ms)) }),

  /**
   * Add an audio binding for a shader param.
   */
  addBinding: (binding) => {
    set((state) => ({
      bindings: [
        ...state.bindings.filter(b =>
          !(b.graphContext === binding.graphContext &&
            b.nodeId === binding.nodeId &&
            b.paramName === binding.paramName)
        ),
        binding,
      ],
    }))
  },

  /**
   * Remove an audio binding.
   */
  removeBinding: (graphContext, nodeId, paramName) => {
    set((state) => ({
      bindings: state.bindings.filter(b =>
        !(b.graphContext === graphContext &&
          b.nodeId === nodeId &&
          b.paramName === paramName)
      ),
    }))
  },

  /**
   * Get computed value for a bound param.
   * formula: clamp(band_value * multiplier + offset, param_min, param_max)
   */
  getBindingValue: (binding, paramMin = 0, paramMax = 1) => {
    const state = get()
    const bandValue = binding.bandIndex === 8
      ? state.beat  // "Beat" binding
      : (state.smoothedBands[binding.bandIndex] || 0)
    let value = bandValue * (binding.multiplier || 1) + (binding.offset || 0)
    if (binding.invert) value = 1 - value
    return Math.max(paramMin, Math.min(paramMax, value))
  },

  /**
   * Reset all values to silence.
   */
  resetToSilence: () => {
    set({
      bands: new Float32Array(8),
      smoothedBands: new Float32Array(8),
      rms: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      beat: 0,
      beatCount: 0,
      isBeat: false,
      peakHold: new Float32Array(8),
      activeSource: 'silence',
      activeSourceName: 'None',
    })
  },
}))

export default useAudioStore
