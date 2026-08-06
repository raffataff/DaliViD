import { useState, useRef } from 'react'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
// WebM is the only container the browser will encode with an alpha channel:
// H.264 has no alpha at all, and MP4/HEVC-with-alpha is a Safari decode-only
// story. Same author and API shape as mp4-muxer above, so the two paths stay
// symmetrical. (Both are superseded by `mediabunny` — see CLAUDE.md backlog.)
import { Muxer as WebMMuxer, ArrayBufferTarget as WebMArrayBufferTarget } from 'webm-muxer'
import useAppStore from '../../store/useAppStore'
import useTimelineStore from '../../store/useTimelineStore'
import useAudioStore from '../../store/useAudioStore'
import useGraphStore from '../../store/useGraphStore'
import { getAudioEngine } from '../../audio/AudioEngine'
import { addToast } from '../common/Toast'
import { IconClose } from '../common/Icons'
import {
  EDGE_HEAD, getEdgeTransition, findPrevOverlap, findNextOverlap,
  clipEdgeState, clipEnvelopeGain,
} from '../../utils/clipTransitions'
import './ExportModal.css'

/**
 * Render timeline audio to a single AudioBuffer using an OfflineAudioContext.
 * Every audio- and video-clip's audio is decoded, placed at its timeline
 * position, trimmed to its in/out, and speed-adjusted — respecting track mute
 * and solo. Returns null when there is nothing audible to render.
 *
 * `rangeStart` offsets the render window: the buffer covers timeline time
 * [rangeStart, rangeStart + durationSec], with clips clipped to that window
 * (a clip already playing at rangeStart starts mid-source). Buffer time 0 =
 * timeline time rangeStart, matching the video frame loop's offset playhead.
 */
async function renderTimelineAudio(durationSec, clips, tracks, rangeStart = 0, sampleRate = 44100) {
  if (!durationSec || durationSec <= 0) return null
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineCtx) return null

  const channels = 2
  const length = Math.ceil(durationSec * sampleRate)
  const offline = new OfflineCtx(channels, length, sampleRate)

  const trackById = {}
  for (const t of tracks) trackById[t.id] = t
  const soloActive = tracks.some(t => t.solo)

  // Decode each unique source once; the decoded buffer can feed many sources.
  const bufferCache = new Map()
  const decode = (url) => {
    if (!bufferCache.has(url)) {
      bufferCache.set(url, fetch(url)
        .then(res => res.arrayBuffer())
        .then(arr => offline.decodeAudioData(arr)))
    }
    return bufferCache.get(url)
  }

  // Reversed clips need a reversed copy of the decoded buffer — a BufferSource
  // has no negative playbackRate either. Cached per URL alongside the forward
  // buffer so several reversed clips off one file only pay for it once.
  const reversedCache = new Map()
  const decodeReversed = async (url) => {
    if (!reversedCache.has(url)) {
      reversedCache.set(url, (async () => {
        const src = await decode(url)
        const out = offline.createBuffer(src.numberOfChannels, src.length, src.sampleRate)
        for (let ch = 0; ch < src.numberOfChannels; ch++) {
          const from = src.getChannelData(ch)
          const to = out.getChannelData(ch)
          for (let i = 0, n = from.length; i < n; i++) to[i] = from[n - 1 - i]
        }
        return out
      })())
    }
    return reversedCache.get(url)
  }

  // Each clip's edge geometry, resolved once. The gain curve below is then just
  // clipEnvelopeGain sampled over time — the SAME function the live renderer
  // calls per frame, so an exported fade or transition can't drift from what
  // was previewed.
  const edgeContext = new Map() // clip → { prev, next }
  for (const c of clips) {
    edgeContext.set(c, { prev: findPrevOverlap(c, clips), next: findNextOverlap(c, clips) })
  }

  // Ducking the OUTGOING side of a crossfade is the one thing a clip's own
  // envelope can't know, so it's collected here: any later clip whose head
  // transition plays over this one ramps this clip's audio down.
  const duckWindows = (clip) => {
    const windows = []
    for (const nxt of clips) {
      if (nxt === clip || nxt.trackId !== clip.trackId) continue
      if (!getEdgeTransition(nxt, EDGE_HEAD)?.type) continue
      if (nxt.timelineStart <= clip.timelineStart || nxt.timelineStart >= clip.timelineEnd) continue
      const end = Math.min(clip.timelineEnd, nxt.timelineEnd)
      if (end - nxt.timelineStart > 0.001) windows.push({ start: nxt.timelineStart, end })
    }
    return windows
  }

  let scheduled = 0
  for (const clip of clips) {
    if (!clip.fileUrl) continue
    if (clip.fileType !== 'audio' && clip.fileType !== 'video') continue
    // Clip-level audio controls: hard-muted / zero-volume clips are skipped
    // outright (no decode), matching live playback.
    if (clip.audioMuted || clip.volume === 0) continue

    const track = trackById[clip.trackId]
    if (track && track.muted) continue
    if (soloActive && (!track || !track.solo)) continue

    let audioBuf
    try {
      audioBuf = clip.reversed ? await decodeReversed(clip.fileUrl) : await decode(clip.fileUrl)
    } catch (e) {
      // A video with no audio track throws here — that's fine, just skip it.
      console.warn('[Export] Could not decode audio for clip', clip.filename, e?.message)
      continue
    }
    if (!audioBuf || audioBuf.duration <= 0) continue

    // Intersect the clip with the export range. `when` is buffer time (range-
    // relative); a clip already playing at rangeStart starts mid-source.
    const winStart = Math.max(clip.timelineStart, rangeStart)
    const winEnd = Math.min(clip.timelineEnd, rangeStart + durationSec)
    const playDur = winEnd - winStart
    if (playDur <= 0.001) continue

    const src = offline.createBufferSource()
    src.buffer = audioBuf
    src.playbackRate.value = clip.speed || 1

    const when = winStart - rangeStart
    const skipIntoClip = winStart - clip.timelineStart // timeline s skipped at the clip's head
    // Forward source time at winStart. Reversed clips read the flipped buffer,
    // where forward time t sits at (duration - t) — so the head of a reversed
    // clip is the TAIL of the file.
    const forwardAt = clip.reversed
      ? (clip.sourceEnd || audioBuf.duration) - skipIntoClip * (clip.speed || 1)
      : (clip.sourceStart || 0) + skipIntoClip * (clip.speed || 1)
    const offset = Math.min(
      Math.max(0, clip.reversed ? audioBuf.duration - forwardAt : forwardAt),
      audioBuf.duration
    )

    // Gain envelope: clip volume × fade ramps × transition crossfades — the
    // same math as Renderer._clipAudioGain, sampled at 30 Hz and handed to a
    // GainNode as one value curve (no ramp-ordering headaches), so the export
    // mix matches live playback exactly. Sampled over the PLAYED window in
    // timeline time, so range exports keep fades/crossfades aligned.
    const gainNode = offline.createGain()
    src.connect(gainNode)
    gainNode.connect(offline.destination)

    const { prev, next } = edgeContext.get(clip) || {}
    const ducks = duckWindows(clip)
    const steps = Math.max(2, Math.ceil(playDur * 30))
    const curve = new Float32Array(steps)
    for (let s = 0; s < steps; s++) {
      const tt = winStart + (s / (steps - 1)) * playDur
      // clipEnvelopeGain covers volume, mute, fade ramps AND transition-owned
      // windows in both directions — including a tail transition fading the
      // sound out to nothing alongside the picture.
      let g = clipEnvelopeGain(clip, clipEdgeState(clip, prev, next, tt))
      for (const w of ducks) {
        if (tt > w.end) continue // duck only while the incoming clip overlaps
        g *= 1 - Math.max(0, Math.min(1, (tt - w.start) / (w.end - w.start)))
      }
      curve[s] = g
    }
    try {
      gainNode.gain.setValueCurveAtTime(curve, when, Math.max(0.01, playDur))
    } catch {
      gainNode.gain.value = curve[0] // curve scheduling unavailable — static gain
    }

    src.start(when, offset)
    src.stop(when + playDur)
    scheduled++
  }

  if (scheduled === 0) return null
  return offline.startRendering()
}

// 8-band FFT ranges — MUST mirror AudioEngine.BAND_RANGES so the export's audio
// reactivity matches the live preview.
const ANALYSIS_BAND_RANGES = [
  [20, 60],     // 0: Sub-bass
  [60, 250],    // 1: Bass
  [250, 500],   // 2: Low-mid
  [500, 2000],  // 3: Mid
  [2000, 4000], // 4: Upper-mid
  [4000, 6000], // 5: Presence
  [6000, 20000],// 6: Brilliance
]

/**
 * Pre-compute per-frame audio reactivity for the export by analysing the mixed
 * timeline audio offline. During normal playback an AnalyserNode drives the audio
 * store live, but export renders with playback PAUSED — so without this the bands
 * and beat freeze and audio-reactive visuals don't move. Uses
 * OfflineAudioContext.suspend() to sample an AnalyserNode (configured identically
 * to AudioEngine) at each frame's time, then extracts the same 8 bands + RMS and
 * runs the same beat-detection algorithm. Returns one { bands, isBeat } per frame,
 * or null when analysis isn't possible.
 */
async function analyzeTimelineAudio(audioBuffer, fps, totalFrames) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineCtx || !audioBuffer || !fps || totalFrames <= 0) return null

  const sampleRate = audioBuffer.sampleRate
  const offline = new OfflineCtx(1, audioBuffer.length, sampleRate)

  const src = offline.createBufferSource()
  src.buffer = audioBuffer

  // Match AudioEngine's analyser configuration so band values line up with live.
  const analyser = offline.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.8
  analyser.minDecibels = -90
  analyser.maxDecibels = -10
  src.connect(analyser)
  analyser.connect(offline.destination)
  src.start()

  const binCount = analyser.frequencyBinCount
  const hzPerBin = sampleRate / analyser.fftSize
  const freqData = new Uint8Array(binCount)
  const timeData = new Uint8Array(analyser.fftSize)
  const results = new Array(totalFrames)

  // Beat detection state — mirrors AudioEngine._analyze, stepped per export frame
  // (interval measured in frames rather than wall-clock ms).
  let beatEnergy = 0
  let beatThreshold = 0.35
  const beatDecay = 0.98
  let lastBeatFrame = -1e9
  const minBeatFrames = Math.max(1, Math.round((150 / 1000) * fps))

  const sampleFrame = (f) => {
    analyser.getByteFrequencyData(freqData)
    analyser.getByteTimeDomainData(timeData)

    const bands = new Float32Array(8)
    for (let b = 0; b < 7; b++) {
      const [lo, hi] = ANALYSIS_BAND_RANGES[b]
      const startBin = Math.floor(lo / hzPerBin)
      const endBin = Math.min(Math.floor(hi / hzPerBin), binCount - 1)
      let sum = 0, count = 0
      for (let i = startBin; i <= endBin; i++) { sum += freqData[i] / 255; count++ }
      bands[b] = count > 0 ? sum / count : 0
    }
    let rmsSum = 0
    for (let i = 0; i < timeData.length; i++) {
      const s = (timeData[i] - 128) / 128
      rmsSum += s * s
    }
    bands[7] = Math.sqrt(rmsSum / timeData.length)

    const bassEnergy = (bands[0] + bands[1]) * 0.5
    const isBeat = bassEnergy > beatThreshold &&
                   bassEnergy > beatEnergy * 1.2 &&
                   (f - lastBeatFrame) > minBeatFrames
    beatEnergy = beatEnergy * beatDecay + bassEnergy * (1 - beatDecay)
    if (isBeat) {
      lastBeatFrame = f
      beatThreshold = beatThreshold * 0.95 + bassEnergy * 0.05
    }

    results[f] = { bands, isBeat }
  }

  // Schedule a suspend at each frame's time to snapshot the analyser. suspend()
  // times must be > 0 and strictly increasing; frame 0 reuses frame 1's sample.
  for (let f = 1; f < totalFrames; f++) {
    const t = f / fps
    if (t >= audioBuffer.duration) break // past the audio — remaining frames stay silent
    offline.suspend(t).then(() => {
      sampleFrame(f)
      offline.resume()
    })
  }

  await offline.startRendering()

  // Backfill frame 0 and any frames never sampled (past audio end) with silence.
  const silent = { bands: new Float32Array(8), isBeat: false }
  results[0] = results[1] || silent
  for (let f = 0; f < totalFrames; f++) {
    if (!results[f]) results[f] = silent
  }
  return results
}

/**
 * Encode a rendered AudioBuffer into the muxer's audio track. Feeds the PCM to a
 * WebCodecs AudioEncoder in planar-float chunks with sequential timestamps.
 *
 * `codecName` follows the container: AAC-LC for MP4, Opus for WebM (WebM cannot
 * carry AAC). Opus is 48 kHz only in Chrome's encoder, which is why the WebM
 * path renders its mixdown at 48 kHz — see AUDIO_SAMPLE_RATE_OPUS.
 */
async function encodeAudioTrack(muxer, audioBuffer, codecName = 'aac') {
  const sampleRate = audioBuffer.sampleRate
  const numberOfChannels = audioBuffer.numberOfChannels
  const totalFrames = audioBuffer.length

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error('AudioEncoder error:', e),
  })
  audioEncoder.configure({
    codec: codecName === 'opus' ? 'opus' : 'mp4a.40.2', // Opus / AAC-LC
    sampleRate,
    numberOfChannels,
    bitrate: 192000,
  })

  const chans = []
  for (let c = 0; c < numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c))

  const chunkFrames = 4800
  for (let start = 0; start < totalFrames; start += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - start)
    // f32-planar layout: all of channel 0, then all of channel 1, …
    const planar = new Float32Array(frames * numberOfChannels)
    for (let c = 0; c < numberOfChannels; c++) {
      planar.set(chans[c].subarray(start, start + frames), c * frames)
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels,
      timestamp: Math.round((start / sampleRate) * 1e6),
      data: planar,
    })
    audioEncoder.encode(audioData)
    audioData.close()
  }

  await audioEncoder.flush()
  audioEncoder.close()
}

/**
 * Wait until a VideoEncoder's internal queue drains below `max` frames.
 * Each queued frame holds a GPU-backed VideoFrame, so an unbounded queue
 * exhausts GPU memory and crashes the context ("CONTEXT_LOST_WEBGL" /
 * "Mojo is disconnected"). Prefers the 'dequeue' event, falls back to polling.
 */
function waitForEncoderQueue(encoder, max) {
  if (encoder.encodeQueueSize <= max) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      if (encoder.encodeQueueSize <= max) {
        encoder.removeEventListener?.('dequeue', onDequeue)
        resolve()
      }
    }
    const onDequeue = () => done()
    if (typeof encoder.addEventListener === 'function') {
      encoder.addEventListener('dequeue', onDequeue)
    }
    // Poll as a fallback for browsers without the 'dequeue' event.
    const poll = () => {
      if (encoder.encodeQueueSize <= max) {
        encoder.removeEventListener?.('dequeue', onDequeue)
        resolve()
      } else {
        setTimeout(poll, 4)
      }
    }
    poll()
  })
}

// Comfortable encoder budget in pixels/second (~4K30 / 1440p60). Above this, the
// per-frame WebGL render plus H.264 submit rate can outrun a typical hardware
// encoder, so the modal warns and offers a one-click way to lower settings.
const SAFE_PIXEL_RATE = 250_000_000

// Chrome's Opus encoder only accepts 48 kHz, so a WebM export renders its
// mixdown at 48 kHz rather than the MP4 path's 44.1 kHz.
const AUDIO_SAMPLE_RATE_OPUS = 48000

// The one alpha-capable encode path in any browser: VP9 Profile 0, 8-bit, in
// WebM, with the encoder configured `alpha: 'keep'`. Chrome and Firefox decode
// it; Safari does not (it wants HEVC-with-alpha, which no browser will encode).
const VP9_ALPHA_CODEC = 'vp09.00.10.08'

// Single source of truth for the codec dropdown AND the branching below.
// `webCodecs` = frame-locked VideoEncoder path (deterministic, audio muxed in);
// false = the legacy real-time MediaRecorder path.
// `alpha` = carries transparency, which only the VP9/WebM combination can.
const CODECS = [
  { value: 'mp4-h264', label: 'MP4 (H.264 / AAC)', alpha: false, webCodecs: true },
  { value: 'webm-vp9-alpha', label: 'WebM (VP9 + Alpha / Opus)', alpha: true, webCodecs: true },
  { value: 'webm-vp9', label: 'WebM (VP9)', alpha: false, webCodecs: false },
  { value: 'webm-vp8', label: 'WebM (VP8)', alpha: false, webCodecs: false },
]

/**
 * Export Modal — frame/video export with codec, resolution, quality settings.
 */
export default function ExportModal() {
  const exportModalOpen = useAppStore(s => s.exportModalOpen)
  const setExportModalOpen = useAppStore(s => s.setExportModalOpen)
  const resolution = useAppStore(s => s.resolution)
  const fps = useAppStore(s => s.fps)

  const [exportType, setExportType] = useState('video') // 'video' | 'frame' | 'gif'
  const [exportRange, setExportRange] = useState('full') // 'full' | 'inout'
  const [codec, setCodec] = useState('mp4-h264')

  // In/Out range info for the Range selector (live from the timeline store).
  const inPoint = useTimelineStore(s => s.inPoint)
  const outPoint = useTimelineStore(s => s.outPoint)
  const calculateDuration = useTimelineStore(s => s.calculateDuration)
  const [quality, setQuality] = useState(0.9)
  const [exportWidth, setExportWidth] = useState(resolution.width)
  const [exportHeight, setExportHeight] = useState(resolution.height)
  const [exportFps, setExportFps] = useState(fps)
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  // Transparent PNG for the Frame tab. Separate from the codec choice because a
  // still has no codec to constrain it — PNG always supports alpha.
  const [transparentFrame, setTransparentFrame] = useState(false)

  const exportActiveRef = useRef(false)

  const codecInfo = CODECS.find(c => c.value === codec) || CODECS[0]
  const alphaExport = exportType === 'video' && codecInfo.alpha

  // Encoder-load guard: warn when width × height × fps exceeds the safe budget so
  // users don't start an export likely to choke the GPU/encoder. Only the
  // WebCodecs paths are gated; the WebM MediaRecorder path differs.
  const pixelRate = exportWidth * exportHeight * exportFps
  const overBudget = exportType === 'video' && codecInfo.webCodecs && pixelRate > SAFE_PIXEL_RATE

  if (!exportModalOpen) return null

  const handleExportFrame = () => {
    const canvas = document.getElementById('preview-canvas')
    if (!canvas) return

    // Capture the final OUTPUT, not a live preview tap. Render one clean frame
    // with the tap suppressed, then restore so the on-screen preview is unaffected.
    // `_presentAlpha` additionally keeps the drawing buffer's alpha channel (and
    // un-premultiplies it) so uncovered regions land in the PNG as transparent
    // rather than as black.
    const renderer = canvas._renderer
    const prevTap = renderer?.previewTapEnabled
    if (renderer) {
      renderer.previewTapEnabled = false
      renderer._presentAlpha = transparentFrame
      renderer._renderFrame()
    }

    const link = document.createElement('a')
    link.download = `dalivid_frame_${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()

    if (renderer) {
      renderer.previewTapEnabled = prevTap ?? true
      renderer._presentAlpha = false
      renderer._renderFrame()
    }

    setExportModalOpen(false)
    addToast({
      message: transparentFrame
        ? 'Frame saved as a transparent PNG.'
        : 'Frame saved as PNG successfully!',
      type: 'success',
    })
  }

  // Mirrors clipGraphManager.getClipSourceTime (reversed clips walk the source
  // backwards) but clamps to the media's real duration, which is what the
  // export's seek-and-wait loop needs.
  const getClipSourceTime = (clip, playheadTime) => {
    const elapsed = (playheadTime - clip.timelineStart) * clip.speed
    const sourceTime = clip.reversed
      ? clip.sourceEnd - elapsed
      : clip.sourceStart + elapsed
    return Math.max(0, Math.min(clip.metadata.duration || clip.sourceEnd, sourceTime))
  }

  const waitForVideoReady = async (renderer, activeClips, playheadTime) => {
    const promises = []
    for (const clip of activeClips) {
      if (clip.fileType !== 'video') continue
      const videoEl = renderer._videoElements.get(clip.id)
      if (!videoEl) continue

      const targetTime = getClipSourceTime(clip, playheadTime)
      const isClose = Math.abs(videoEl.currentTime - targetTime) < 0.01

      if (videoEl.seeking || !isClose || videoEl.readyState < 2) {
        promises.push(
          new Promise(resolve => {
            let timeout = setTimeout(() => {
              cleanup()
              resolve() // Don't hang the export
            }, 1000)

            const checkReady = () => {
              if (Math.abs(videoEl.currentTime - targetTime) < 0.02 && videoEl.readyState >= 2) {
                cleanup()
                resolve()
              }
            }

            const onSeeked = () => checkReady()
            const onTimeUpdate = () => checkReady()

            const cleanup = () => {
              clearTimeout(timeout)
              videoEl.removeEventListener('seeked', onSeeked)
              videoEl.removeEventListener('timeupdate', onTimeUpdate)
            }

            videoEl.addEventListener('seeked', onSeeked)
            videoEl.addEventListener('timeupdate', onTimeUpdate)

            // Double check immediately
            if (!videoEl.seeking && videoEl.readyState >= 2 && Math.abs(videoEl.currentTime - targetTime) < 0.02) {
              cleanup()
              resolve()
            }
          })
        )
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises)
    }
  }

  const handleExportVideo = async () => {
    const canvas = document.getElementById('preview-canvas')
    const renderer = canvas?._renderer
    if (!canvas || !renderer) {
      addToast({ message: 'Preview renderer not found. Make sure the preview canvas is loaded.', type: 'error' })
      return
    }

    setIsExporting(true)
    setProgress(0)
    exportActiveRef.current = true
    // Exports must always come from the OUTPUT node — never a live preview tap.
    renderer.previewTapEnabled = false

    if (codecInfo.webCodecs) {
      if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        addToast({ message: 'WebCodecs API (VideoEncoder) is not supported in this browser. Please use a Chromium-based browser.', type: 'error' })
        renderer.previewTapEnabled = true
        setIsExporting(false)
        return
      }

      const originalWidth = renderer.width
      const originalHeight = renderer.height
      const wasPlaying = useAppStore.getState().isPlaying

      try {
        if (wasPlaying) {
          useAppStore.getState().pause()
        }
        renderer.stop()

        // Temporarily resize renderer to target export resolution
        renderer.setResolution(exportWidth, exportHeight)

        // Find the best codec configuration supported by hardware.
        // The alpha path has exactly one candidate — VP9 is the only codec any
        // browser will encode with an alpha channel — and `alpha: 'keep'` is
        // part of the support probe, not just the config: an encoder can
        // support VP9 and still refuse alpha, and we need to find that out
        // BEFORE rendering several thousand frames.
        const configsToTry = codecInfo.alpha
          ? [VP9_ALPHA_CODEC]
          : ['avc1.4d0034' /* Main */, 'avc1.64002a' /* High */, 'avc1.42001f' /* Baseline */]
        let selectedCodecString = configsToTry[0]

        let supportedConfig = null
        for (const testCodec of configsToTry) {
          const testConfig = {
            codec: testCodec,
            width: exportWidth,
            height: exportHeight,
            bitrate: Math.round(quality * 10000000),
            framerate: exportFps,
            ...(codecInfo.alpha ? { alpha: 'keep' } : {}),
          }
          try {
            const support = await VideoEncoder.isConfigSupported(testConfig)
            if (support.supported) {
              selectedCodecString = testCodec
              supportedConfig = testConfig
              break
            }
          } catch (e) {
            console.warn(`Codec ${testCodec} support check failed:`, e)
          }
        }

        if (!supportedConfig) {
          addToast({
            message: codecInfo.alpha
              ? 'This browser will not encode VP9 with an alpha channel at these settings. Try a lower resolution, or export a transparent PNG from the Frame tab.'
              : 'The selected resolution or frame rate is not supported by your H.264 encoder.',
            type: 'error',
          })
          renderer.previewTapEnabled = true
          setIsExporting(false)
          return
        }

        // ── Export range ──
        // 'full' renders the whole project; 'inout' renders only the timeline's
        // In→Out window. Everything downstream (frame loop, audio mixdown, stem
        // analysis) is expressed as rangeStart + range-relative time, so the
        // exported file starts at t=0 with the In point's content.
        const timelineState = useTimelineStore.getState()
        const projectDuration = timelineState.calculateDuration() || 10
        const useRange = exportRange === 'inout'
        const rangeStart = useRange ? Math.max(0, timelineState.inPoint ?? 0) : 0
        const rangeEnd = useRange
          ? Math.max(rangeStart + 0.1, timelineState.outPoint ?? projectDuration)
          : projectDuration
        const exportDuration = Math.max(0.1, rangeEnd - rangeStart)

        // Render the timeline audio offline so it can be muxed alongside the video.
        // WebM carries Opus, not AAC, and Chrome's Opus encoder is 48 kHz-only —
        // so the container decides the mixdown rate, not the other way round.
        const { clips: allClips, tracks: allTracks } = timelineState
        const audioCodec = codecInfo.alpha ? 'opus' : 'aac'
        const audioRate = audioCodec === 'opus' ? AUDIO_SAMPLE_RATE_OPUS : 44100
        let audioBuffer = null
        if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
          try {
            audioBuffer = await renderTimelineAudio(exportDuration, allClips, allTracks, rangeStart, audioRate)
          } catch (e) {
            console.warn('[Export] Audio mixdown failed, exporting video only:', e?.message)
          }
        }
        const hasAudio = !!audioBuffer

        // Initialize Muxer — declare the audio track up front when present.
        // `alpha: true` on the WebM video track is what makes the muxer write the
        // encoder's side-data alpha plane into the file; without it the encoder
        // still produces alpha and the container silently drops it.
        let muxer = codecInfo.alpha
          ? new WebMMuxer({
            target: new WebMArrayBufferTarget(),
            video: {
              codec: 'V_VP9',
              width: exportWidth,
              height: exportHeight,
              frameRate: exportFps,
              alpha: true,
            },
            ...(hasAudio ? {
              audio: {
                codec: 'A_OPUS',
                numberOfChannels: audioBuffer.numberOfChannels,
                sampleRate: audioBuffer.sampleRate,
              },
            } : {}),
          })
          : new Muxer({
            target: new ArrayBufferTarget(),
            video: {
              codec: 'avc',
              width: exportWidth,
              height: exportHeight,
            },
            ...(hasAudio ? {
              audio: {
                codec: 'aac',
                numberOfChannels: audioBuffer.numberOfChannels,
                sampleRate: audioBuffer.sampleRate,
              },
            } : {}),
            fastStart: 'in-memory',
          })

        // Setup VideoEncoder
        let encoder = new VideoEncoder({
          output: (chunk, meta) => {
            muxer.addVideoChunk(chunk, meta)
          },
          error: (e) => {
            console.error('VideoEncoder error:', e)
            addToast({ message: `VideoEncoder error: ${e.message}`, type: 'error' })
          },
        })

        encoder.configure({
          codec: selectedCodecString,
          width: exportWidth,
          height: exportHeight,
          bitrate: Math.round(quality * 10000000),
          framerate: exportFps,
          ...(codecInfo.alpha
            ? { alpha: 'keep' }
            : { avc: { format: 'avc' } }),
        })

        // Make the renderer present with a real alpha channel for the whole
        // frame loop: no opaque clear, no colour mask, and the premultiplied
        // accumulator un-premultiplied on its way to the drawing buffer (which
        // is `premultipliedAlpha: false`, so it wants straight colour).
        renderer._presentAlpha = !!codecInfo.alpha

        const totalFrames = Math.ceil(exportDuration * exportFps)

        // Pre-compute per-frame audio reactivity so audio-driven visuals animate in
        // the export (playback is paused, so the live analyser can't drive them).
        // Failure is non-fatal — the export proceeds with static reactivity.
        let audioFrames = null
        if (hasAudio) {
          try {
            // Bounded so a stalled offline render can never hang the export; on
            // timeout we fall back to static reactivity.
            audioFrames = await Promise.race([
              analyzeTimelineAudio(audioBuffer, exportFps, totalFrames),
              new Promise((_, reject) => setTimeout(() => reject(new Error('audio analysis timed out')), 30000)),
            ])
          } catch (e) {
            console.warn('[Export] Per-frame audio analysis failed; reactivity will be static:', e?.message)
          }
        }
        // Per-stem reactivity: for every file named by an AUDIO_INPUT node's
        // "Audio Source", analyse that file's RAW timeline placement offline
        // (ignoring clip/track gains — matching the live pre-gain stem tap) so
        // stem-driven visuals animate identically in the export.
        let stemFrames = null
        if (hasAudio) {
          // audioSource may be stored as an option index (0 = Timeline, 1+ =
          // nth audio file, same ordered list the dropdown builds) or a string.
          const audioNames = [...new Set(allClips.filter(c => c.fileType === 'audio').map(c => c.filename))]
          const resolveSourceName = (v) => {
            if (v == null || v === 0 || v === 'Timeline') return null
            if (typeof v === 'string') return v
            return audioNames[v - 1] ?? null
          }
          const stemNames = new Set()
          const scanGraph = (g) => {
            for (const n of (g?.nodes || [])) {
              if (n.type !== 'AUDIO_INPUT') continue
              const name = resolveSourceName(n.params?.audioSource)
              if (name) stemNames.add(name)
            }
          }
          const graphState = useGraphStore.getState()
          scanGraph(graphState.masterGraph)
          for (const id in graphState.clipGraphs || {}) scanGraph(graphState.clipGraphs[id])

          for (const name of stemNames) {
            try {
              const rawClips = allClips
                .filter(c => c.filename === name)
                .map(c => ({
                  ...c,
                  audioMuted: false, volume: 1, fadeIn: 0, fadeOut: 0,
                  transitionIn: null, transitionOut: null, transition: null,
                }))
              const rawTracks = allTracks.map(t => ({ ...t, muted: false, solo: false }))
              const stemBuf = await renderTimelineAudio(exportDuration, rawClips, rawTracks, rangeStart)
              if (stemBuf) {
                const frames = await analyzeTimelineAudio(stemBuf, exportFps, totalFrames)
                if (frames) {
                  if (!stemFrames) stemFrames = {}
                  stemFrames[name] = frames
                }
              }
            } catch (e) {
              console.warn('[Export] Stem analysis failed for', name, e?.message)
            }
          }
        }

        // Stop the live analysis loop so its (silent, paused) values don't overwrite
        // our per-frame band writes, and start each export from a clean slate.
        const audioEngine = getAudioEngine()
        audioEngine.stopAnalysis()
        useAudioStore.getState().resetToSilence()

        for (let frame = 0; frame < totalFrames; frame++) {
          if (!exportActiveRef.current) break

          // Timeline position = range start + range-relative frame time; the
          // encoded timestamps below stay range-relative (file starts at 0).
          const playheadTime = rangeStart + frame / exportFps
          useAppStore.setState({ playheadTime })

          // Drive time and audio reactivity deterministically for this exact frame.
          // (Playback is paused during export, so the live analyser is idle.)
          renderer._timeOverride = playheadTime
          renderer._frameOverride = frame
          if (audioFrames && audioFrames[frame]) {
            const audioStore = useAudioStore.getState()
            audioStore.updateBands(audioFrames[frame].bands)
            audioStore.updateBeat(audioFrames[frame].isBeat)
          }
          if (stemFrames) {
            const perSource = {}
            for (const name in stemFrames) {
              const f = stemFrames[name]?.[frame]
              if (f) perSource[name] = { bands: f.bands, isBeat: f.isBeat }
            }
            useAudioStore.getState().updateSources?.(perSource)
          }

          // Step 1: Render frame to start seeking video elements
          renderer._renderFrame()

          // Step 2: Detect active clips and wait for video elements to seek
          const activeClips = useTimelineStore.getState().clips.filter(clip => 
            playheadTime >= clip.timelineStart && playheadTime < clip.timelineEnd
          )
          await waitForVideoReady(renderer, activeClips, playheadTime)

          // Step 3: Render again to draw the newly sought video frame to canvas
          renderer._renderFrame()

          // Step 4: Wait a microtick to guarantee WebGL drawing buffer is populated
          await new Promise(resolve => requestAnimationFrame(resolve))

          // Create VideoFrame from WebGL canvas. `alpha: 'keep'` is explicit
          // rather than relying on the default, because the default differs by
          // source type and silently discarding here would produce a perfectly
          // valid VP9-alpha file with a fully opaque alpha plane.
          const timestamp = Math.round((frame * 1000000) / exportFps)
          const videoFrame = new VideoFrame(canvas, {
            timestamp,
            ...(codecInfo.alpha ? { alpha: 'keep' } : {}),
          })

          const keyFrame = frame % 30 === 0
          encoder.encode(videoFrame, { keyFrame })
          videoFrame.close() // CRITICAL: prevent GPU memory leaks!

          // Backpressure: if the encoder falls behind the submit rate, its queue
          // of GPU-backed frames grows until the GPU runs out of memory and the
          // WebGL context is lost. Video exports self-throttle via waitForVideoReady,
          // but audio-only exports have no seek waits, so submission must be gated
          // here or long songs crash the context mid-encode.
          if (encoder.encodeQueueSize > 8) {
            await waitForEncoderQueue(encoder, 4)
          }

          setProgress((frame / totalFrames) * 100)
        }

        if (exportActiveRef.current) {
          await encoder.flush()

          // Encode the mixed audio into the muxer's audio track before finalizing.
          if (hasAudio) {
            try {
              await encodeAudioTrack(muxer, audioBuffer, audioCodec)
            } catch (e) {
              console.error('[Export] Audio encode failed, finalizing video only:', e)
            }
          }

          muxer.finalize()

          const ext = codecInfo.alpha ? 'webm' : 'mp4'
          const { buffer } = muxer.target
          const blob = new Blob([buffer], { type: codecInfo.alpha ? 'video/webm' : 'video/mp4' })
          const url = URL.createObjectURL(blob)

          const link = document.createElement('a')
          const projName = useAppStore.getState().projectName || 'Untitled Project'
          link.download = `${projName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.${ext}`
          link.href = url
          link.click()

          URL.revokeObjectURL(url)
          addToast({
            message: codecInfo.alpha
              ? 'Exported a transparent WebM (VP9 + alpha). Chrome and Firefox show the transparency; Safari does not.'
              : 'Video exported successfully as seekable MP4!',
            type: 'success',
          })
          setExportModalOpen(false)
        } else {
          addToast({ message: 'Export cancelled.', type: 'info' })
        }
      } catch (err) {
        console.error('Export failed:', err)
        addToast({ message: `Export failed: ${err.message}`, type: 'error' })
      } finally {
        // Clear the export overrides and resume the live audio analysis loop before
        // restoring the on-screen preview (so the restore render uses live values).
        renderer._timeOverride = null
        renderer._frameOverride = null
        // Must be cleared before the restore render below, or the preview comes
        // back with an un-premultiplied, unmasked present.
        renderer._presentAlpha = false
        useAudioStore.getState().resetToSilence()
        try { getAudioEngine().startAnalysis(() => useAudioStore.getState()) } catch { /* ok */ }

        // Restore original settings. Guard every GL-touching call: if the context
        // was lost mid-export, setResolution/_renderFrame would throw and leave the
        // modal stuck in the exporting state.
        renderer.previewTapEnabled = true
        const contextLost = renderer.gl?.isContextLost?.()
        if (!contextLost) {
          try {
            renderer.setResolution(originalWidth, originalHeight)
            renderer._renderFrame()
            if (wasPlaying) {
              useAppStore.getState().play()
            } else {
              renderer.pause()
            }
          } catch (e) {
            console.warn('[Export] Renderer restore failed:', e?.message)
          }
        } else {
          addToast({ message: 'Export crashed: the GPU ran out of memory. Try a lower resolution or frame rate.', type: 'error' })
        }

        setIsExporting(false)
        exportActiveRef.current = false
      }
    } else {
      // Fallback to legacy WebM MediaRecorder export
      try {
        const stream = canvas.captureStream(exportFps)
        const mimeType = codec === 'webm-vp9' ? 'video/webm;codecs=vp9' :
                          codec === 'webm-vp8' ? 'video/webm;codecs=vp8' :
                          'video/webm'

        const recorder = new MediaRecorder(stream, {
          mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm',
          videoBitsPerSecond: Math.round(quality * 10000000),
        })

        const chunks = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }

        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'video/webm' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.download = `dalivid_export_${Date.now()}.webm`
          link.href = url
          link.click()
          URL.revokeObjectURL(url)
          renderer.previewTapEnabled = true
          setIsExporting(false)
          setExportModalOpen(false)
          addToast({ message: 'Video exported successfully as WebM!', type: 'success' })
        }

        // WebM records live playback in real time: jump the playhead to the
        // range start so the recording covers the selected window.
        const tl = useTimelineStore.getState()
        const projDur = tl.calculateDuration() || 10
        const rStart = exportRange === 'inout' ? Math.max(0, tl.inPoint ?? 0) : 0
        const rEnd = exportRange === 'inout' ? Math.max(rStart + 0.1, tl.outPoint ?? projDur) : projDur
        useAppStore.getState().setPlayheadTime(rStart)

        recorder.start(100)

        const duration = (rEnd - rStart) * 1000
        const interval = setInterval(() => {
          if (!exportActiveRef.current) {
            clearInterval(interval)
            recorder.stop()
            return
          }
          setProgress(prev => Math.min(prev + (100 / (duration / 100)), 100))
        }, 100)

        setTimeout(() => {
          clearInterval(interval)
          if (recorder.state !== 'inactive') {
            recorder.stop()
          }
        }, duration)

      } catch (err) {
        console.error('WebM Export failed:', err)
        addToast({ message: `Export failed: ${err.message}`, type: 'error' })
        renderer.previewTapEnabled = true
        setIsExporting(false)
      }
    }
  }

  const handleCancel = () => {
    exportActiveRef.current = false
    setIsExporting(false)
  }

  return (
    <div className="export-modal__overlay" onClick={() => !isExporting && setExportModalOpen(false)}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal__header">
          <h3>Export Video</h3>
          {!isExporting && (
            <button className="export-modal__close" onClick={() => setExportModalOpen(false)}>
              <IconClose />
            </button>
          )}
        </div>

        <div className="export-modal__body">
          {/* Export Type */}
          <div className="export-modal__tabs">
            {[
              { id: 'video', label: 'Video' },
              { id: 'frame', label: 'Frame' },
              { id: 'gif', label: 'GIF' },
            ].map(tab => (
              <button
                key={tab.id}
                className={`export-modal__tab ${exportType === tab.id ? 'export-modal__tab--active' : ''}`}
                onClick={() => setExportType(tab.id)}
                disabled={isExporting}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {exportType === 'video' && (
            <>
              <div className="export-modal__field">
                <label>Codec</label>
                <select value={codec} onChange={(e) => setCodec(e.target.value)} disabled={isExporting}>
                  {CODECS.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              {/* Say plainly what alpha costs and where it works — the usual
                  failure is someone exporting "transparent" H.264 and only
                  finding out at the other end that no such thing exists. */}
              {alphaExport && (
                <div className="export-modal__hint" style={{ fontSize: 11, lineHeight: 1.5, opacity: 0.75, margin: '-4px 0 8px' }}>
                  Transparency is preserved. Areas with no clip export as transparent
                  rather than black. Plays with alpha in Chrome, Edge and Firefox;
                  Safari shows black instead. VP9 encodes more slowly than H.264.
                </div>
              )}
              <div className="export-modal__field">
                <label>Range</label>
                {(() => {
                  const projDur = calculateDuration() || 10
                  const rIn = Math.max(0, inPoint ?? 0)
                  const rOut = Math.max(rIn + 0.1, outPoint ?? projDur)
                  const hasRange = inPoint != null || outPoint != null
                  return (
                    <select
                      value={exportRange}
                      onChange={(e) => setExportRange(e.target.value)}
                      disabled={isExporting}
                      title={hasRange ? undefined : 'Set In/Out points on the timeline (I / O keys) to enable range export'}
                    >
                      <option value="full">Full project ({projDur.toFixed(1)}s)</option>
                      <option value="inout" disabled={!hasRange}>
                        {hasRange
                          ? `In → Out (${rIn.toFixed(1)}s – ${rOut.toFixed(1)}s, ${(rOut - rIn).toFixed(1)}s)`
                          : 'In → Out (set I/O points first)'}
                      </option>
                    </select>
                  )
                })()}
              </div>
              <div className="export-modal__field">
                <label>Quality / Bitrate</label>
                <div className="export-modal__slider-row">
                  <input type="range" min={0.1} max={1} step={0.05} value={quality}
                    onChange={(e) => setQuality(parseFloat(e.target.value))} disabled={isExporting} />
                  <span className="mono">{Math.round(quality * 100)}%</span>
                </div>
              </div>
              <div className="export-modal__field">
                <label>Frame Rate</label>
                <select value={exportFps} onChange={(e) => setExportFps(Number(e.target.value))} disabled={isExporting}>
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </div>
            </>
          )}

          {exportType === 'frame' && (
            <div className="export-modal__field">
              <label>Background</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={transparentFrame}
                  onChange={(e) => setTransparentFrame(e.target.checked)}
                  disabled={isExporting}
                />
                Transparent (PNG alpha)
              </label>
            </div>
          )}

          <div className="export-modal__field">
            <label>Resolution</label>
            <div className="export-modal__res-row">
              <input type="number" value={exportWidth}
                onChange={(e) => setExportWidth(Number(e.target.value))} disabled={isExporting} />
              <span>×</span>
              <input type="number" value={exportHeight}
                onChange={(e) => setExportHeight(Number(e.target.value))} disabled={isExporting} />
            </div>
          </div>

          <div className="export-modal__presets">
            {[
              { label: '720p', w: 1280, h: 720 },
              { label: '1080p', w: 1920, h: 1080 },
              { label: '4K', w: 3840, h: 2160 },
            ].map(p => (
              <button key={p.label} className="export-modal__preset-btn"
                onClick={() => { setExportWidth(p.w); setExportHeight(p.h) }} disabled={isExporting}>
                {p.label}
              </button>
            ))}
          </div>

          {overBudget && !isExporting && (
            <div className="export-modal__warning">
              <span>
                ⚠ {exportWidth}×{exportHeight} @ {exportFps}fps is a heavy encoder load
                (~{Math.round(pixelRate / 1e6)}M px/s) and may exhaust GPU memory on
                long exports. Consider a lower resolution or frame rate.
              </span>
              <button
                type="button"
                className="export-modal__preset-btn"
                onClick={() => { setExportWidth(1920); setExportHeight(1080) }}
              >
                Lower to 1080p
              </button>
            </div>
          )}

          {isExporting && (
            <div className="export-modal__progress">
              <div className="export-modal__progress-bar">
                <div className="export-modal__progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="mono">{Math.round(progress)}%</span>
            </div>
          )}
        </div>

        <div className="export-modal__footer">
          {!isExporting ? (
            <button
              className="export-modal__export-btn"
              onClick={exportType === 'frame' ? handleExportFrame : handleExportVideo}
            >
              {exportType === 'frame' ? 'Save Frame (PNG)' : exportType === 'gif' ? 'Export GIF' : 'Start Export'}
            </button>
          ) : (
            <button className="export-modal__cancel-btn" onClick={handleCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
