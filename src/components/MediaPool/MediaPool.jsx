import { useState, useCallback, useMemo, useEffect } from 'react'
import useTimelineStore from '../../store/useTimelineStore'
import useGraphStore from '../../store/useGraphStore'
import useAudioStore from '../../store/useAudioStore'
import useAppStore from '../../store/useAppStore'
import { copyFileToProjectFolder } from '../../utils/projectSerializer'
import { COMPOUND_PRESETS } from '../../shaders/compoundPresets'
import { setCameraStream, getCameraStream, removeCameraStream } from '../../gl/cameraRegistry'
import { getAudioEngine } from '../../audio/AudioEngine'
import { prepareImageDataURL, dataUrlBytes, formatBytes } from '../../utils/imageProcessing'
import { makeTextClipParams, TEXT_PRESETS, DEFAULT_GENERATOR_DURATION } from '../../utils/generatorClips'
import { addToast } from '../common/Toast'
import {
  startScreenCapture, startRecording, stopRecording, stopRecordingIfActive,
  openRecordingSink, isRecording, getRecordingInfo, mp4Supported, tsStamp,
} from '../../utils/screenRecorder'
import './MediaPool.css'

const TABS = [
  { id: 'videos', label: 'Videos' },
  { id: 'images', label: 'Images' },
  { id: 'text', label: 'Text' },
  { id: 'cameras', label: 'Cameras' },
  { id: 'screens', label: 'Screen' },
  { id: 'audio', label: 'Audio' },
  { id: 'effects', label: 'Effects' },
  { id: 'scopes', label: 'Scopes' },
]

// Clip ids already warned about a large in-memory recording (module-level so we
// don't mutate Zustand clip objects and warn at most once per recording).
const _memWarned = new Set()

export default function MediaPool() {
  const [activeTab, setActiveTab] = useState('videos')
  const [importedVideos, setImportedVideos] = useState([])
  const [importedAudio, setImportedAudio] = useState([])
  const [importedImages, setImportedImages] = useState([])
  const [cameras, setCameras] = useState([])
  // Screen-capture options (apply to the NEXT capture) + recording UI state.
  const [screenQuality, setScreenQuality] = useState(1080) // 0 = native
  const [optimizeForText, setOptimizeForText] = useState(false)
  const [screenFormat, setScreenFormat] = useState('webm')
  const [, setRecordTick] = useState(0) // drives the recording timer/size readout

  const clips = useTimelineStore(s => s.clips)
  const addTrack = useTimelineStore(s => s.addTrack)
  const addClip = useTimelineStore(s => s.addClip)
  const updateClip = useTimelineStore(s => s.updateClip)
  const tracks = useTimelineStore(s => s.tracks)
  const initClipGraph = useGraphStore(s => s.initClipGraph)
  const projectFolderHandle = useAppStore(s => s.projectFolderHandle)
  const micEnabled = useAudioStore(s => s.micEnabled)
  const toggleMic = useAudioStore(s => s.toggleMic)

  // Derive media pool entries from timeline clips so loaded projects show their media
  const videoEntries = useMemo(() => {
    const fromClips = clips
      .filter(c => c.fileType === 'video')
      .map(c => ({
        id: `clip_video_${c.id}`,
        filename: c.filename,
        fileUrl: c.fileUrl || null,
        fileType: 'video',
        width: c.metadata?.width || 1920,
        height: c.metadata?.height || 1080,
        duration: c.metadata?.duration || (c.timelineEnd - c.timelineStart),
        fps: c.metadata?.fps || 30,
        size: c.metadata?.size || 0,
        fromClip: true,
      }))
    // Merge: imported videos take precedence (they have fresh blob URLs), then clip-derived entries
    const importedIds = new Set(importedVideos.map(v => v.filename))
    const clipOnly = fromClips.filter(c => !importedIds.has(c.filename))
    return [...importedVideos, ...clipOnly]
  }, [clips, importedVideos])

  const audioEntries = useMemo(() => {
    const fromClips = clips
      .filter(c => c.fileType === 'audio')
      .map(c => ({
        id: `clip_audio_${c.id}`,
        filename: c.filename,
        fileUrl: c.fileUrl || null,
        fileType: 'audio',
        duration: c.metadata?.duration || (c.timelineEnd - c.timelineStart),
        size: c.metadata?.size || 0,
        fromClip: true,
      }))
    const importedIds = new Set(importedAudio.map(a => a.filename))
    const clipOnly = fromClips.filter(c => !importedIds.has(c.filename))
    return [...importedAudio, ...clipOnly]
  }, [clips, importedAudio])

  // Import video file
  const handleImportVideo = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.mp4,.mov,.webm,.avi,.mkv,.m4v'
    input.multiple = true
    input.onchange = async (e) => {
      const files = Array.from(e.target.files)
      for (const file of files) {
        if (projectFolderHandle) {
          try {
            await copyFileToProjectFolder(projectFolderHandle, file, 'media')
          } catch (err) {
            console.error('Failed to copy imported video file to project folder:', err)
          }
        }

        const url = URL.createObjectURL(file)
        
        // Get video metadata
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.src = url
        
        await new Promise(resolve => {
          video.onloadedmetadata = resolve
          video.onerror = resolve
        })

        // Recorded WebM (MediaRecorder) writes no duration header → duration is
        // Infinity. Seek to the end to force the browser to compute the real
        // duration, then rewind. (Standard workaround; harmless for normal files.)
        if (video.duration === Infinity) {
          video.currentTime = Number.MAX_SAFE_INTEGER
          await new Promise(r => { video.ontimeupdate = () => { video.ontimeupdate = null; r() } })
          video.currentTime = 0
        }

        const entry = {
          id: `media_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          filename: file.name,
          fileUrl: url,
          fileType: 'video',
          width: video.videoWidth || 1920,
          height: video.videoHeight || 1080,
          duration: video.duration || 10,
          fps: 30,
          size: file.size,
          file,
        }

        // Replace any existing pool entry with the same filename (avoid duplicates)
        setImportedVideos(prev => [...prev.filter(v => v.filename !== file.name), entry])

        // If clips already reference this filename (e.g. a project whose media
        // couldn't be restored), relink them to the fresh URL and keep their
        // existing effect graphs — don't add a duplicate clip.
        const existing = useTimelineStore.getState().clips.filter(
          c => c.filename === file.name && c.fileType === 'video'
        )
        if (existing.length > 0) {
          for (const c of existing) updateClip(c.id, { fileUrl: url })
        } else {
          // Auto-create track and clip
          let videoTrack = tracks.find(t => t.type === 'video')
          if (!videoTrack) {
            const trackId = addTrack('video')
            videoTrack = { id: trackId }
          }

          const clipId = addClip(videoTrack.id, {
            filename: file.name,
            fileUrl: url,
            fileType: 'video',
            timelineStart: 0,
            timelineEnd: entry.duration,
            sourceStart: 0,
            sourceEnd: entry.duration,
            width: entry.width,
            height: entry.height,
            fps: entry.fps,
            duration: entry.duration,
          })

          // Init clip effect graph
          initClipGraph(clipId, file.name)
        }
      }
    }
    input.click()
  }, [tracks, addTrack, addClip, updateClip, initClipGraph, projectFolderHandle])

  // Import audio file
  const handleImportAudio = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.mp3,.wav,.ogg,.flac,.aac'
    input.multiple = true
    input.onchange = async (e) => {
      const files = Array.from(e.target.files)
      for (const file of files) {
        if (projectFolderHandle) {
          try {
            await copyFileToProjectFolder(projectFolderHandle, file, 'audio')
          } catch (err) {
            console.error('Failed to copy imported audio file to project folder:', err)
          }
        }

        const url = URL.createObjectURL(file)

        // Get audio metadata
        const audio = document.createElement('audio')
        audio.preload = 'metadata'
        audio.src = url

        await new Promise(resolve => {
          audio.onloadedmetadata = resolve
          audio.onerror = resolve
        })

        const duration = audio.duration || 30

        const entry = {
          id: `audio_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          filename: file.name,
          fileUrl: url,
          fileType: 'audio',
          duration,
          size: file.size,
        }
        setImportedAudio(prev => [...prev.filter(a => a.filename !== file.name), entry])

        // Relink existing audio clips with this filename instead of duplicating.
        const existing = useTimelineStore.getState().clips.filter(
          c => c.filename === file.name && c.fileType === 'audio'
        )
        if (existing.length > 0) {
          for (const c of existing) updateClip(c.id, { fileUrl: url })
        } else {
          let audioTrack = tracks.find(t => t.type === 'audio')
          if (!audioTrack) {
            const trackId = addTrack('audio')
            audioTrack = { id: trackId }
          }
          const clipId = addClip(audioTrack.id, {
            filename: file.name,
            fileUrl: url,
            fileType: 'audio',
            timelineStart: 0,
            timelineEnd: duration,
            sourceStart: 0,
            sourceEnd: duration,
          })
          initClipGraph(clipId, file.name, 'audio')
        }
      }
    }
    input.click()
  }, [tracks, addTrack, addClip, updateClip, initClipGraph, projectFolderHandle])

  // Import still images. Each image is read as a data URL so it can be embedded
  // in the IMAGE_INPUT node's params and persisted with the project. Cards are
  // dragged onto the Node Editor to create an image source node.
  const handleImportImage = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = async (e) => {
      const files = Array.from(e.target.files)
      for (const file of files) {
        try {
          // Downscale + re-encode so the embedded data URL stays small.
          const { dataUrl, width, height } = await prepareImageDataURL(file)
          const after = dataUrlBytes(dataUrl)
          const pct = file.size > 0 ? Math.round((1 - after / file.size) * 100) : 0
          console.log(`[DaliVid] Imported "${file.name}": ${formatBytes(file.size)} → ${formatBytes(after)} (${pct}% smaller)`)
          const entry = {
            id: `image_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            filename: file.name,
            dataUrl,
            width,
            height,
            size: after,
          }
          setImportedImages(prev => [...prev.filter(i => i.filename !== file.name), entry])
        } catch (err) {
          console.error('[DaliVid] Failed to import image:', file.name, err)
        }
      }
    }
    input.click()
  }, [])

  // Add a text clip at the playhead on a video track (creating one if needed),
  // then select it so the Inspector opens for styling.
  const handleAddText = useCallback((presetParams) => {
    const app = useAppStore.getState()
    const playhead = app.playheadTime || 0
    let videoTrack = tracks.find(t => t.type === 'video')
    if (!videoTrack) videoTrack = { id: addTrack('video') }
    const params = makeTextClipParams(presetParams || {})
    const filename = (params.text || 'Text').split('\n')[0].slice(0, 24) || 'Text'
    const clipId = addClip(videoTrack.id, {
      filename, fileType: 'text',
      timelineStart: playhead, timelineEnd: playhead + DEFAULT_GENERATOR_DURATION,
      sourceStart: 0, sourceEnd: DEFAULT_GENERATOR_DURATION,
      params,
    })
    initClipGraph(clipId, filename, 'text')
    app.selectClip?.(clipId)
  }, [tracks, addTrack, addClip, initClipGraph])

  // Detect cameras. Request permission first so device labels are populated
  // (enumerateDevices returns blank labels until camera access is granted).
  const handleDetectCameras = useCallback(async () => {
    try {
      // Prompt for access, then immediately release the probe stream — we only
      // need it so the browser will reveal device labels below.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true })
        probe.getTracks().forEach(t => t.stop())
      } catch (permErr) {
        console.warn('Camera permission not granted:', permErr)
      }

      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter(d => d.kind === 'videoinput')
      setCameras(videoDevices.map(d => ({
        id: d.deviceId,
        label: d.label || `Camera ${d.deviceId.substr(0, 6)}`,
        deviceId: d.deviceId,
      })))
    } catch (err) {
      console.error('Failed to enumerate devices:', err)
    }
  }, [])

  // Start a live camera: open its video+audio stream, add a camera clip to a
  // video track, hand the stream to the renderer, and route its audio into the
  // analysis path.
  const handleSelectCamera = useCallback(async (cam) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cam.deviceId ? { deviceId: { exact: cam.deviceId } } : true,
        audio: true,
      })

      const videoTrackStream = stream.getVideoTracks()[0]
      const settings = videoTrackStream?.getSettings?.() || {}
      const width = settings.width || 1280
      const height = settings.height || 720
      const fps = settings.frameRate ? Math.round(settings.frameRate) : 30

      let videoTrack = tracks.find(t => t.type === 'video')
      if (!videoTrack) {
        const trackId = addTrack('video')
        videoTrack = { id: trackId }
      }

      // Live source has no fixed length; give the timeline clip a default
      // duration the user can trim.
      const duration = 60
      const clipId = addClip(videoTrack.id, {
        filename: cam.label,
        fileType: 'camera',
        timelineStart: 0,
        timelineEnd: duration,
        sourceStart: 0,
        sourceEnd: duration,
        width,
        height,
        fps,
        duration,
      })

      // Register the stream so the Renderer can upload its frames each tick.
      setCameraStream(clipId, stream)
      initClipGraph(clipId, cam.label)

      // Route the webcam's microphone audio (if present) into the analyser.
      if (stream.getAudioTracks().length > 0) {
        await getAudioEngine().useExternalAudioStream(stream)
      }
    } catch (err) {
      console.error('Failed to start camera:', err)
    }
  }, [tracks, addTrack, addClip, initClipGraph])

  // Live screen clips = screen clips with an active stream. Orphans = screen
  // clips whose stream was lost (e.g. after project reload) — offered a Reconnect.
  const screenClips = useMemo(
    () => clips.filter(c => c.fileType === 'screen'),
    [clips]
  )

  // Tick the recording readout (elapsed + size) twice a second while any screen
  // clip is recording. Cheap and avoids re-rendering per MediaRecorder chunk.
  useEffect(() => {
    if (activeTab !== 'screens') return
    const anyRecording = screenClips.some(c => isRecording(c.id))
    if (!anyRecording) return
    const id = setInterval(() => {
      setRecordTick(t => t + 1)
      // Warn once when an in-memory recording grows large (no disk sink).
      for (const c of screenClips) {
        const info = getRecordingInfo(c.id)
        if (info?.sinkKind === 'memory' && info.bytes > 2 * 1024 ** 3 && !_memWarned.has(c.id)) {
          _memWarned.add(c.id)
          addToast({ message: 'Recording is large and held in memory — consider stopping soon.', type: 'warning', duration: 5000 })
        }
      }
    }, 500)
    return () => clearInterval(id)
  }, [activeTab, screenClips])

  // Capture a screen/window/tab as a live clip (mirror of handleSelectCamera).
  const handleCaptureScreen = useCallback(async () => {
    try {
      const stream = await startScreenCapture({ maxHeight: screenQuality, optimizeForText })

      const vt = stream.getVideoTracks()[0]
      const settings = vt?.getSettings?.() || {}
      const width = settings.width || 1920
      const height = settings.height || 1080
      const fps = settings.frameRate ? Math.round(settings.frameRate) : 30
      const label = vt?.label || 'Screen Capture'

      let videoTrack = tracks.find(t => t.type === 'video')
      if (!videoTrack) videoTrack = { id: addTrack('video') }

      const duration = 60 // live source: default trimmable length, same as camera
      const clipId = addClip(videoTrack.id, {
        filename: label,
        fileType: 'screen',
        timelineStart: 0, timelineEnd: duration,
        sourceStart: 0, sourceEnd: duration,
        width, height, fps, duration,
      })

      setCameraStream(clipId, stream) // shared live-stream registry
      initClipGraph(clipId, label)

      // Tab/system audio → reactive engine (same path the webcam mic uses).
      if (stream.getAudioTracks().length > 0) {
        await getAudioEngine().useExternalAudioStream(stream)
      }

      // Browser "Stop sharing" chrome → finalize any recording, then unregister.
      vt.addEventListener('ended', async () => {
        await stopRecordingIfActive(clipId)
        removeCameraStream(clipId)
        setRecordTick(t => t + 1)
        addToast({ message: `Screen share "${label}" ended`, type: 'info' })
      })
    } catch (err) {
      if (err?.name !== 'NotAllowedError') console.error('Screen capture failed:', err)
      // NotAllowedError = user dismissed the picker — silent no-op.
    }
  }, [tracks, addTrack, addClip, initClipGraph, screenQuality, optimizeForText])

  // Reconnect an orphaned screen clip (post-reload) to a fresh capture, keeping
  // its effect graph / keyframes / timeline position.
  const handleReconnectScreen = useCallback(async (clip) => {
    try {
      const stream = await startScreenCapture({ maxHeight: screenQuality, optimizeForText })
      const vt = stream.getVideoTracks()[0]
      setCameraStream(clip.id, stream)
      if (stream.getAudioTracks().length > 0) {
        await getAudioEngine().useExternalAudioStream(stream)
      }
      vt.addEventListener('ended', async () => {
        await stopRecordingIfActive(clip.id)
        removeCameraStream(clip.id)
        setRecordTick(t => t + 1)
      })
      setRecordTick(t => t + 1)
      addToast({ message: `Reconnected "${clip.filename}"`, type: 'success' })
    } catch (err) {
      if (err?.name !== 'NotAllowedError') console.error('Reconnect failed:', err)
    }
  }, [screenQuality, optimizeForText])

  // Start/stop recording the source stream for a screen clip. The save picker
  // must open inside this click handler (transient user activation).
  const handleToggleRecord = useCallback(async (clip) => {
    // Stop → finalize, then auto-import the file into the Videos tab.
    if (isRecording(clip.id)) {
      const result = await stopRecording(clip.id)
      _memWarned.delete(clip.id)
      setRecordTick(t => t + 1)
      if (!result) return
      const { file, url, durationSec, width, height, fps, sinkKind } = result
      setImportedVideos(prev => [...prev.filter(v => v.filename !== file.name), {
        id: `media_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        filename: file.name, fileUrl: url, fileType: 'video',
        width, height, fps,
        duration: durationSec, // measured — never video metadata (WebM = Infinity)
        size: file.size, file,
      }])
      // Keep the project self-contained if the file landed outside its media/ folder.
      if (sinkKind !== 'project' && projectFolderHandle) {
        try { await copyFileToProjectFolder(projectFolderHandle, file, 'media') }
        catch (err) { console.warn('Could not copy recording into project folder:', err) }
      }
      addToast({ message: `Recording saved: ${file.name}`, type: 'success' })
      return
    }

    // Start → build recorder, open the sink (picker), then start streaming.
    const stream = getCameraStream(clip.id)
    if (!stream) {
      addToast({ message: 'No live stream — reconnect the screen first.', type: 'error' })
      return
    }
    const handle = startRecording(clip.id, stream, {
      format: screenFormat,
      onError: (err) => {
        console.error('Recording write error:', err)
        addToast({ message: `Recording error: ${err?.message || err}`, type: 'error' })
        stopRecordingIfActive(clip.id).then(() => setRecordTick(t => t + 1))
      },
    })
    if (!handle.mimeType) {
      addToast({ message: 'This browser can’t record the selected format.', type: 'error' })
      stopRecordingIfActive(clip.id)
      return
    }
    try {
      const name = `screen_${tsStamp()}.${handle.ext}`
      const sink = await openRecordingSink(name, handle.ext, projectFolderHandle, handle)
      handle.sink = sink
      handle.recorder.start(1000) // 1s timeslices → stream chunks to disk
      if (sink.kind === 'project') {
        addToast({ message: 'Recording to the project’s media folder.', type: 'info' })
      }
      setRecordTick(t => t + 1)
    } catch (err) {
      console.error('Failed to start recording:', err)
      stopRecordingIfActive(clip.id)
      addToast({ message: 'Could not start recording.', type: 'error' })
    }
  }, [screenFormat, projectFolderHandle])

  // End a live screen share: stop any recording, drop the stream (clip freezes).
  const handleEndShare = useCallback(async (clip) => {
    await stopRecordingIfActive(clip.id)
    removeCameraStream(clip.id)
    setRecordTick(t => t + 1)
  }, [])

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatDuration = (sec) => {
    const s = Math.max(0, Math.floor(sec))
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  return (
    <>
      <div className="panel__header">
        <span className="panel__header-title">Media Pool</span>
      </div>
      <div className="media-pool__tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`media-pool__tab ${activeTab === tab.id ? 'media-pool__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="panel__content media-pool__content">
        {/* ── Videos Tab ── */}
        {activeTab === 'videos' && (
          <>
            <button className="media-pool__import-btn" onClick={handleImportVideo}>
              + Import Video
            </button>
            {videoEntries.length === 0 ? (
              <div className="media-pool__empty">
                <div className="media-pool__empty-icon">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                    <rect x="4" y="6" width="24" height="20" rx="2" />
                    <path d="M13 12L20 16L13 20V12Z" />
                  </svg>
                </div>
                <p className="media-pool__empty-text">Import video files to get started</p>
                <p className="media-pool__empty-hint">Drag files here or use Import Video</p>
              </div>
            ) : (
              <div className="media-pool__file-list">
                {videoEntries.map(v => (
                  <div key={v.id} className="media-pool__file-item">
                    <div className="media-pool__file-thumb">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                        <rect x="2" y="4" width="20" height="16" rx="2" />
                        <path d="M10 9L15 12L10 15V9Z" fill="currentColor" />
                      </svg>
                    </div>
                    <div className="media-pool__file-info">
                      <div className="media-pool__file-name">{v.filename}</div>
                      <div className="media-pool__file-meta mono">
                        {v.width}×{v.height} · {v.duration.toFixed(1)}s · {formatSize(v.size)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Images Tab ── */}
        {activeTab === 'images' && (
          <>
            <button className="media-pool__import-btn" onClick={handleImportImage}>
              + Import Image
            </button>
            {importedImages.length === 0 ? (
              <div className="media-pool__empty">
                <div className="media-pool__empty-icon">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                    <rect x="4" y="6" width="24" height="20" rx="2" />
                    <circle cx="11" cy="13" r="2.5" />
                    <path d="M4 22l7-6 5 4 4-3 8 7" />
                  </svg>
                </div>
                <p className="media-pool__empty-text">Import images to feed the node graph</p>
                <p className="media-pool__empty-hint">Drag an image card onto the Node Editor</p>
              </div>
            ) : (
              <div className="media-pool__file-list">
                {importedImages.map(img => (
                  <div
                    key={img.id}
                    className="media-pool__file-item media-pool__file-item--interactive"
                    draggable="true"
                    title="Drag onto the Timeline to add an image clip, or onto the Node Editor for an Image source node"
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/dalivid-drag', JSON.stringify({
                        kind: 'node',        // Node Editor → IMAGE_INPUT node
                        clipType: 'image',   // Timeline → image clip
                        nodeType: 'IMAGE_INPUT',
                        name: img.filename || 'Image',
                        imageSrc: img.dataUrl,
                        imageName: img.filename,
                      }))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <div className="media-pool__file-thumb" style={{ overflow: 'hidden', padding: 0 }}>
                      <img src={img.dataUrl} alt="" draggable={false}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div className="media-pool__file-info">
                      <div className="media-pool__file-name">{img.filename}</div>
                      <div className="media-pool__file-meta mono">
                        {img.width}×{img.height} · {formatSize(img.size)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Text Tab ── */}
        {activeTab === 'text' && (
          <>
            <button className="media-pool__import-btn" onClick={() => handleAddText()}>
              + Add Text
            </button>
            <p className="media-pool__empty-hint" style={{ margin: '0 0 8px' }}>
              Adds a text clip at the playhead. Drag a style below onto the Timeline to place it, then edit in the Inspector.
            </p>
            <div className="media-pool__effects-grid">
              {TEXT_PRESETS.map(preset => (
                <div
                  key={preset.id}
                  className="media-pool__effect-card"
                  style={{ borderColor: '#ffcc44' }}
                  draggable="true"
                  title="Drag onto the Timeline to add this text style, or click to add it at the playhead"
                  onClick={() => handleAddText(preset.params)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/dalivid-drag', JSON.stringify({
                      kind: 'timelineClip',
                      clipType: 'text',
                      name: preset.name,
                      params: preset.params,
                    }))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <div className="media-pool__effect-icon" style={{ color: '#ffcc44', fontWeight: 700 }}>T</div>
                  <div className="media-pool__effect-name">{preset.name}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Cameras Tab ── */}
        {activeTab === 'cameras' && (
          <>
            <button className="media-pool__import-btn" onClick={handleDetectCameras}>
              Detect Cameras
            </button>
            {cameras.length === 0 ? (
              <div className="media-pool__empty">
                <p className="media-pool__empty-text">No cameras detected</p>
                <p className="media-pool__empty-hint">Click Detect Cameras to scan</p>
              </div>
            ) : (
              <div className="media-pool__file-list">
                {cameras.map(cam => (
                  <div
                    key={cam.id}
                    className="media-pool__file-item media-pool__file-item--interactive"
                    onClick={() => handleSelectCamera(cam)}
                    title="Click to add this camera to the timeline"
                  >
                    <div className="media-pool__file-thumb" style={{ color: 'var(--accent-cyan)' }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                        <rect x="2" y="6" width="14" height="12" rx="1" />
                        <path d="M16 9.5L22 7V17L16 14.5" />
                      </svg>
                    </div>
                    <div className="media-pool__file-info">
                      <div className="media-pool__file-name">{cam.label}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Screen Tab ── */}
        {activeTab === 'screens' && (
          <>
            <button className="media-pool__import-btn" onClick={handleCaptureScreen}>
              🖥 Capture Screen / Window / Tab
            </button>

            {/* Capture options — apply to the NEXT capture. */}
            <div className="media-pool__screen-options">
              <label className="media-pool__screen-opt">
                <span>Quality</span>
                <select
                  value={screenQuality}
                  onChange={(e) => setScreenQuality(Number(e.target.value))}
                >
                  <option value={720}>720p</option>
                  <option value={1080}>1080p</option>
                  <option value={1440}>1440p</option>
                  <option value={0}>Native</option>
                </select>
              </label>
              <label className="media-pool__screen-opt media-pool__screen-opt--check">
                <input
                  type="checkbox"
                  checked={optimizeForText}
                  onChange={(e) => setOptimizeForText(e.target.checked)}
                />
                <span>Optimize for text</span>
              </label>
            </div>

            {screenClips.length === 0 ? (
              <div className="media-pool__empty">
                <p className="media-pool__empty-text">No screen captures</p>
                <p className="media-pool__empty-hint">Capture a screen, window, or tab to add it to the timeline</p>
              </div>
            ) : (
              <div className="media-pool__file-list">
                {screenClips.map(clip => {
                  const live = !!getCameraStream(clip.id)
                  const recording = isRecording(clip.id)
                  const info = recording ? getRecordingInfo(clip.id) : null
                  return (
                    <div key={clip.id} className="media-pool__file-item">
                      <div className="media-pool__file-thumb" style={{ color: live ? 'var(--accent-cyan)' : 'var(--text-dim, #888)' }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                          <rect x="2" y="4" width="20" height="13" rx="1.5" />
                          <path d="M8 20h8M12 17v3" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="media-pool__file-info">
                        <div className="media-pool__file-name">
                          {live && <span className="media-pool__live-dot" title="Live" />}
                          {clip.filename}
                        </div>
                        <div className="media-pool__file-meta mono">
                          {clip.width}×{clip.height} @ {clip.fps}fps
                          {recording && info && (
                            <span className="media-pool__rec-stats">
                              {' · '}<span className="media-pool__rec-dot" />
                              {formatDuration(info.elapsedSec)} · {formatSize(info.bytes)}
                            </span>
                          )}
                        </div>
                        {live ? (
                          <div className="media-pool__screen-controls">
                            <button
                              className={`media-pool__mini-btn ${recording ? 'media-pool__mini-btn--rec' : ''}`}
                              onClick={() => handleToggleRecord(clip)}
                            >
                              {recording ? '■ Stop' : '● Record'}
                            </button>
                            <select
                              value={screenFormat}
                              disabled={recording}
                              onChange={(e) => setScreenFormat(e.target.value)}
                            >
                              <option value="webm">WebM</option>
                              <option value="mp4" disabled={!mp4Supported()}
                                title={mp4Supported() ? '' : 'Not supported by this browser'}>
                                MP4
                              </option>
                            </select>
                            <button className="media-pool__mini-btn" onClick={() => handleEndShare(clip)}>
                              End share
                            </button>
                          </div>
                        ) : (
                          <div className="media-pool__screen-controls">
                            <button className="media-pool__mini-btn" onClick={() => handleReconnectScreen(clip)}>
                              Reconnect
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <p className="media-pool__empty-hint" style={{ marginTop: 8 }}>
              Tip: for a perfect offline export, record → the file auto-imports to Videos → drop it in
              to replace the live clip.
            </p>
          </>
        )}

        {/* ── Audio Tab ── */}
        {activeTab === 'audio' && (
          <>
            <button className="media-pool__import-btn" onClick={handleImportAudio}>
              + Import Audio
            </button>
            <button
              className="media-pool__import-btn"
              onClick={() => toggleMic()}
              style={micEnabled ? { borderColor: 'var(--accent-magenta)', color: 'var(--accent-magenta)' } : undefined}
            >
              {micEnabled ? '● Microphone On' : 'Enable Microphone'}
            </button>
            {audioEntries.length === 0 ? (
              <div className="media-pool__empty">
                <p className="media-pool__empty-text">No audio files imported</p>
                <p className="media-pool__empty-hint">Import audio or enable microphone</p>
              </div>
            ) : (
              <div className="media-pool__file-list">
                {audioEntries.map(a => (
                  <div key={a.id} className="media-pool__file-item">
                    <div className="media-pool__file-thumb" style={{ color: 'var(--accent-magenta)' }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                        <path d="M4 9v6M8 7v10M12 5v14M16 7v10M20 9v6" />
                      </svg>
                    </div>
                    <div className="media-pool__file-info">
                      <div className="media-pool__file-name">{a.filename}</div>
                      <div className="media-pool__file-meta mono">{formatSize(a.size)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Effects Tab ── */}
        {activeTab === 'effects' && (
          <>
            <div className="media-pool__effects-section">
              <div className="media-pool__section-label">Nodes</div>
              <div className="media-pool__effects-grid">
                {EFFECT_PRESETS.map(effect => (
                  <div
                    key={effect.type}
                    className="media-pool__effect-card"
                    style={{ borderColor: effect.color }}
                    draggable="true"
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/dalivid-drag', JSON.stringify({
                        kind: 'node',
                        nodeType: effect.type,
                        name: effect.name,
                      }))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <div className="media-pool__effect-icon" style={{ color: effect.color }}>
                      {effect.icon}
                    </div>
                    <div className="media-pool__effect-name">{effect.name}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="media-pool__effects-section">
              <div className="media-pool__section-label">Presets</div>
              <div className="media-pool__presets-grid">
                {COMPOUND_PRESETS.map(preset => (
                  <div
                    key={preset.id}
                    className="media-pool__preset-card"
                    style={{ borderColor: preset.color }}
                    draggable="true"
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/dalivid-drag', JSON.stringify({
                        kind: 'preset',
                        presetId: preset.id,
                        name: preset.name,
                      }))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <div className="media-pool__preset-icon" style={{ color: preset.color }}>
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="2" y="4" width="16" height="12" rx="1" />
                        <path d="M6 8h8M6 12h5" strokeLinecap="round" />
                      </svg>
                    </div>
                    <div className="media-pool__preset-name">{preset.name}</div>
                    <div className="media-pool__preset-desc">{preset.description}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Scopes Tab ── */}
        {activeTab === 'scopes' && (
          <div className="media-pool__scopes">
            <ScopesBars />
          </div>
        )}
      </div>
    </>
  )
}

/** Simple 8-band scope visualization */
function ScopesBars() {
  const smoothedBands = useAudioStore(s => s.smoothedBands)
  const rms = useAudioStore(s => s.rms)

  // smoothedBands has 7 values, RMS is the 8th value
  const bands = smoothedBands ? [...smoothedBands, rms] : [0, 0, 0, 0, 0, 0, 0, 0]

  return (
    <div className="media-pool__scopes-bars">
      {bands.map((v, i) => (
        <div key={i} className="media-pool__scope-bar-container">
          <div
            className="media-pool__scope-bar"
            style={{ height: `${Math.min(1, Math.max(0, v)) * 100}%` }}
          />
          <span className="media-pool__scope-label mono">
            {['SUB', 'BASS', 'LO', 'MID', 'HI', 'PRES', 'BRIL', 'RMS'][i]}
          </span>
        </div>
      ))}
    </div>
  )
}

const EFFECT_PRESETS = [
  { type: 'IMAGE_INPUT', name: 'Image', color: '#44cc88', icon: '◳' },
  { type: 'TEXT_INPUT', name: 'Text', color: '#ffcc44', icon: 'T' },
  { type: 'EDGE_DETECTION', name: 'Edge Detection', color: '#ff8844', icon: '◈' },
  { type: 'COLOR_INVERSION', name: 'Color / HSV', color: '#ff44cc', icon: '◐' },
  { type: 'GLITCH', name: 'Glitch', color: '#ff3344', icon: '▦' },
  { type: 'FEEDBACK', name: 'Feedback', color: '#aa44ff', icon: '∞' },
  { type: 'KALEIDOSCOPE', name: 'Kaleidoscope', color: '#44ccff', icon: '✻' },
  { type: 'CHROMATIC_ABERRATION', name: 'Chromatic', color: '#ff44aa', icon: '◎' },
  { type: 'BLOOM', name: 'Bloom', color: '#ffcc44', icon: '✦' },
  { type: 'CRT', name: 'CRT', color: '#88aa44', icon: '▤' },
  { type: 'MIRROR', name: 'Mirror', color: '#cc44ff', icon: '⬔' },
  { type: 'THRESHOLD', name: 'Posterize', color: '#ccaa44', icon: '◧' },
  { type: 'HALFTONE', name: 'Halftone', color: '#aaaacc', icon: '◉' },
  { type: 'BLUR', name: 'Blur', color: '#6688cc', icon: '◌' },
  { type: 'PIXELATE', name: 'Pixelate', color: '#44aa88', icon: '▣' },
  { type: 'NOISE', name: 'Film Grain', color: '#998877', icon: '░' },
  { type: 'VORONOI', name: 'Voronoi', color: '#44ddaa', icon: '⬡' },
  { type: 'FLUID_WARP', name: 'Fluid Warp', color: '#4488ff', icon: '≋' },
  { type: 'PIXEL_SORT', name: 'Pixel Sort', color: '#ff6644', icon: '▥' },
  { type: 'DEPTH_BLUR', name: 'Depth Blur', color: '#6666cc', icon: '◐' },
  { type: 'PARTICLE_DISPLACE', name: 'Particles', color: '#ff88cc', icon: '✧' },
  { type: 'LUT', name: 'LUT / Grade', color: '#ccaa66', icon: '◆' },
  { type: 'EMBOSS', name: 'Emboss', color: '#999999', icon: '◇' },
  { type: 'VIGNETTE', name: 'Vignette', color: '#776644', icon: '◯' },
  { type: 'ASCII', name: 'ASCII', color: '#44cc44', icon: 'A#' },
  { type: 'CHROMA_KEY', name: 'Chroma Key', color: '#00cc44', icon: '◫' },
  { type: 'LENS_DISTORTION', name: 'Lens Dist.', color: '#8888cc', icon: '◠' },
  { type: 'DISPLACEMENT', name: 'Displace', color: '#cc6644', icon: '↯' },
  { type: 'AUDIO_VISUALIZER', name: 'Audio Viz', color: '#ff00aa', icon: '♫' },
  { type: 'MATH_BLEND', name: 'Math/Blend', color: '#448888', icon: '⊕' },
  { type: 'CUSTOM', name: 'Custom', color: '#00e5ff', icon: '{ }' },
  // Generators (Procedural)
  { type: 'BIOMATH', name: 'Bio-Digital', color: '#44aaff', icon: '◈' },
  { type: 'PLASMA', name: 'Plasma', color: '#ff00aa', icon: '◐' },
  { type: 'FRACTAL', name: 'Fractal', color: '#cc44ff', icon: '❋' },
  { type: 'TUNNEL', name: 'Tunnel', color: '#ff8844', icon: '◎' },
  { type: 'GEOMETRIC', name: 'Geometric', color: '#88aa44', icon: '⬡' },
  { type: 'LIGHTNING', name: 'Lightning', color: '#44ffaa', icon: '⚡' },
  { type: 'CRYSTAL', name: 'Crystal', color: '#aaccff', icon: '◇' },
  { type: 'COSMIC', name: 'Cosmic', color: '#aa44ff', icon: '✦' },
  { type: 'WAVES', name: 'Waves', color: '#4488ff', icon: '≋' },
  { type: 'SPACE_DISTORTION', name: 'Distortion', color: '#ccaa44', icon: '↯' },
]
