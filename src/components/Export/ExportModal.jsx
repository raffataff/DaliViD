import { useState, useRef } from 'react'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import useAppStore from '../../store/useAppStore'
import useTimelineStore from '../../store/useTimelineStore'
import { addToast } from '../common/Toast'
import { IconClose } from '../common/Icons'
import './ExportModal.css'

/**
 * Render the full timeline audio to a single AudioBuffer using an
 * OfflineAudioContext. Every audio- and video-clip's audio is decoded, placed at
 * its timeline position, trimmed to its in/out, and speed-adjusted — respecting
 * track mute and solo. Returns null when there is nothing audible to render.
 */
async function renderTimelineAudio(durationSec, clips, tracks) {
  if (!durationSec || durationSec <= 0) return null
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineCtx) return null

  const sampleRate = 44100
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

  let scheduled = 0
  for (const clip of clips) {
    if (!clip.fileUrl) continue
    if (clip.fileType !== 'audio' && clip.fileType !== 'video') continue

    const track = trackById[clip.trackId]
    if (track && track.muted) continue
    if (soloActive && (!track || !track.solo)) continue

    let audioBuf
    try {
      audioBuf = await decode(clip.fileUrl)
    } catch (e) {
      // A video with no audio track throws here — that's fine, just skip it.
      console.warn('[Export] Could not decode audio for clip', clip.filename, e?.message)
      continue
    }
    if (!audioBuf || audioBuf.duration <= 0) continue

    const timelineDur = Math.max(0, clip.timelineEnd - clip.timelineStart)
    if (timelineDur <= 0) continue

    const src = offline.createBufferSource()
    src.buffer = audioBuf
    src.playbackRate.value = clip.speed || 1
    src.connect(offline.destination)

    const when = Math.max(0, clip.timelineStart)
    const offset = Math.min(Math.max(0, clip.sourceStart || 0), audioBuf.duration)
    src.start(when, offset)
    src.stop(when + timelineDur)
    scheduled++
  }

  if (scheduled === 0) return null
  return offline.startRendering()
}

/**
 * Encode a rendered AudioBuffer into the muxer's AAC audio track. Feeds the PCM
 * to a WebCodecs AudioEncoder in planar-float chunks with sequential timestamps.
 */
async function encodeAudioTrack(muxer, audioBuffer) {
  const sampleRate = audioBuffer.sampleRate
  const numberOfChannels = audioBuffer.numberOfChannels
  const totalFrames = audioBuffer.length

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error('AudioEncoder error:', e),
  })
  audioEncoder.configure({
    codec: 'mp4a.40.2', // AAC-LC
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
 * Export Modal — frame/video export with codec, resolution, quality settings.
 */
export default function ExportModal() {
  const exportModalOpen = useAppStore(s => s.exportModalOpen)
  const setExportModalOpen = useAppStore(s => s.setExportModalOpen)
  const resolution = useAppStore(s => s.resolution)
  const fps = useAppStore(s => s.fps)

  const [exportType, setExportType] = useState('video') // 'video' | 'frame' | 'gif'
  const [codec, setCodec] = useState('mp4-h264')
  const [quality, setQuality] = useState(0.9)
  const [exportWidth, setExportWidth] = useState(resolution.width)
  const [exportHeight, setExportHeight] = useState(resolution.height)
  const [exportFps, setExportFps] = useState(fps)
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState(0)

  const exportActiveRef = useRef(false)

  if (!exportModalOpen) return null

  const handleExportFrame = () => {
    const canvas = document.getElementById('preview-canvas')
    if (!canvas) return

    const link = document.createElement('a')
    link.download = `dalivid_frame_${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
    setExportModalOpen(false)
    addToast({ message: 'Frame saved as PNG successfully!', type: 'success' })
  }

  const getClipSourceTime = (clip, playheadTime) => {
    const elapsed = playheadTime - clip.timelineStart
    const sourceTime = clip.sourceStart + elapsed * clip.speed
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

    if (codec === 'mp4-h264') {
      if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        addToast({ message: 'WebCodecs API (VideoEncoder) is not supported in this browser. Please use a Chromium-based browser.', type: 'error' })
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

        // Find the best codec configuration supported by hardware
        let selectedCodecString = 'avc1.4d0034' // Main Profile
        const configsToTry = [
          'avc1.4d0034', // Main Profile
          'avc1.64002a', // High Profile
          'avc1.42001f', // Baseline Profile
        ]

        let supportedConfig = null
        for (const testCodec of configsToTry) {
          const testConfig = {
            codec: testCodec,
            width: exportWidth,
            height: exportHeight,
            bitrate: Math.round(quality * 10000000),
            framerate: exportFps,
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
          addToast({ message: 'The selected resolution or frame rate is not supported by your H.264 encoder.', type: 'error' })
          setIsExporting(false)
          return
        }

        // Render the timeline audio offline so it can be muxed alongside the video.
        const { clips: allClips, tracks: allTracks } = useTimelineStore.getState()
        const exportDuration = useTimelineStore.getState().calculateDuration() || 10
        let audioBuffer = null
        if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
          try {
            audioBuffer = await renderTimelineAudio(exportDuration, allClips, allTracks)
          } catch (e) {
            console.warn('[Export] Audio mixdown failed, exporting video only:', e?.message)
          }
        }
        const hasAudio = !!audioBuffer

        // Initialize Muxer — declare the audio track up front when present.
        let muxer = new Muxer({
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
          avc: { format: 'avc' }
        })

        const duration = useTimelineStore.getState().calculateDuration() || 10
        const totalFrames = Math.ceil(duration * exportFps)

        for (let frame = 0; frame < totalFrames; frame++) {
          if (!exportActiveRef.current) break

          const playheadTime = frame / exportFps
          useAppStore.setState({ playheadTime })

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

          // Create VideoFrame from WebGL canvas
          const timestamp = Math.round((frame * 1000000) / exportFps)
          const videoFrame = new VideoFrame(canvas, { timestamp })

          const keyFrame = frame % 30 === 0
          encoder.encode(videoFrame, { keyFrame })
          videoFrame.close() // CRITICAL: prevent GPU memory leaks!

          setProgress((frame / totalFrames) * 100)
        }

        if (exportActiveRef.current) {
          await encoder.flush()

          // Encode the mixed audio into the muxer's AAC track before finalizing.
          if (hasAudio) {
            try {
              await encodeAudioTrack(muxer, audioBuffer)
            } catch (e) {
              console.error('[Export] Audio encode failed, finalizing video only:', e)
            }
          }

          muxer.finalize()

          const { buffer } = muxer.target
          const blob = new Blob([buffer], { type: 'video/mp4' })
          const url = URL.createObjectURL(blob)

          const link = document.createElement('a')
          const projName = useAppStore.getState().projectName || 'Untitled Project'
          link.download = `${projName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.mp4`
          link.href = url
          link.click()

          URL.revokeObjectURL(url)
          addToast({ message: 'Video exported successfully as seekable MP4!', type: 'success' })
          setExportModalOpen(false)
        } else {
          addToast({ message: 'Export cancelled.', type: 'info' })
        }
      } catch (err) {
        console.error('MP4 Export failed:', err)
        addToast({ message: `Export failed: ${err.message}`, type: 'error' })
      } finally {
        // Restore original settings
        renderer.setResolution(originalWidth, originalHeight)
        renderer._renderFrame()

        if (wasPlaying) {
          useAppStore.getState().play()
        } else {
          renderer.pause()
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
          setIsExporting(false)
          setExportModalOpen(false)
          addToast({ message: 'Video exported successfully as WebM!', type: 'success' })
        }

        recorder.start(100)

        const duration = (useTimelineStore.getState().calculateDuration() || 10) * 1000
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
                  <option value="mp4-h264">MP4 (H.264 / AAC)</option>
                  <option value="webm-vp9">WebM (VP9)</option>
                  <option value="webm-vp8">WebM (VP8)</option>
                </select>
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
