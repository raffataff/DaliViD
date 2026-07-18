/**
 * DaliVid — screenRecorder.js
 *
 * Screen/window/tab capture (getDisplayMedia) + optional record-to-file.
 *
 * Two independent concerns:
 *   1. Capture — hand a live MediaStream to the pipeline (cameraRegistry), so a
 *      screen becomes a live clip exactly like a camera (per-clip shaders, blend,
 *      fades, transitions all for free).
 *   2. Record — run a MediaRecorder on the SOURCE stream's tracks (native
 *      res/fps, hardware-accelerated encode), streaming chunks straight to disk.
 *      This costs the WebGL render loop nothing — we never touch the canvas.
 *
 * The recorder-handle map lives at module scope so recording survives MediaPool
 * tab switches / re-renders (same pattern as the node-editor clipboard).
 */

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * Prompt the browser's screen/window/tab picker and return the live stream.
 * @param {object}  opts
 * @param {number}  opts.maxHeight     Cap capture height (0 = native). Downsampled
 *                                     in the browser's capture pipeline before it
 *                                     ever reaches us — cuts per-frame texImage2D cost.
 * @param {boolean} opts.optimizeForText  contentHint 'detail' (sharp UI/text) vs
 *                                        'motion' (smooth framerate — VJ default).
 */
export async function startScreenCapture({ maxHeight = 1080, optimizeForText = false } = {}) {
  const video = { frameRate: { ideal: 60, max: 60 } }
  if (maxHeight > 0) { video.height = { ideal: maxHeight, max: maxHeight } }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chromium-only hints — silently ignored elsewhere:
    selfBrowserSurface: 'exclude',   // don't offer DaliViD's own tab (feedback loop)
    surfaceSwitching: 'include',     // allow switching the shared tab mid-session
    systemAudio: 'include',
  })
  const vt = stream.getVideoTracks()[0]
  // 'motion' = favor framerate (VJ default); 'detail' = favor sharpness (text/UI).
  if (vt) vt.contentHint = optimizeForText ? 'detail' : 'motion'
  return stream
}

// ── Format / codec selection ─────────────────────────────────────────────────

const MIME_LADDERS = {
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  mp4:  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'],
}

/** First MIME in the format's ladder the browser can actually record, or ''. */
export function pickMimeType(format) {
  const supports = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported
  if (!supports) return ''
  return (MIME_LADDERS[format] || MIME_LADDERS.webm)
    .find(m => MediaRecorder.isTypeSupported(m)) || ''
}

/** Whether this browser can natively mux MP4 via MediaRecorder (Chromium ≥ 126). */
export function mp4Supported() { return !!pickMimeType('mp4') }

// ── Recorder ─────────────────────────────────────────────────────────────────

const _active = new Map() // clipId → RecorderHandle

/** Timestamp for suggested filenames → YYYYMMDD_HHMMSS. */
export function tsStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function isRecording(clipId) { return _active.has(clipId) }

/** Live stats for the UI timer (poll on an interval — do NOT re-render per chunk). */
export function getRecordingInfo(clipId) {
  const h = _active.get(clipId)
  if (!h) return null
  return {
    elapsedSec: (performance.now() - h.startedAt) / 1000,
    bytes: h.bytes,
    ext: h.ext,
    sinkKind: h.sink?.kind || null,
  }
}

/**
 * Build a MediaRecorder over the source stream's tracks (NOT clones — stopping a
 * recorder never stops its tracks, so the live feed is unaffected). Does NOT
 * start yet; the caller sets `handle.sink` (openRecordingSink) then calls
 * `handle.recorder.start(1000)` so chunks stream straight to disk.
 */
export function startRecording(clipId, stream, { format = 'webm', onError } = {}) {
  if (_active.has(clipId)) return _active.get(clipId)
  const vt = stream.getVideoTracks()[0]
  const s = vt?.getSettings?.() || {}
  const w = s.width || 1920, h = s.height || 1080, fps = s.frameRate || 30
  const mimeType = pickMimeType(format)
  const recorder = new MediaRecorder(
    new MediaStream([vt, ...stream.getAudioTracks()].filter(Boolean)),
    {
      ...(mimeType ? { mimeType } : {}),
      // ~0.08 bits/px/frame, clamped 6–30 Mbps — good VP9/H.264 screen quality.
      videoBitsPerSecond: Math.min(30e6, Math.max(6e6, Math.round(w * h * fps * 0.08))),
      audioBitsPerSecond: 192_000,
    }
  )
  const handle = {
    clipId, recorder, mimeType,
    width: w, height: h, fps: Math.round(fps),
    ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm',
    startedAt: performance.now(), bytes: 0,
    sink: null,            // set by openRecordingSink before recorder.start
    memChunks: [],         // only used by the in-memory fallback sink
  }
  recorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) return
    handle.bytes += e.data.size
    try { await handle.sink?.write(e.data) }
    catch (err) { onError?.(err) }      // e.g. disk full
  }
  _active.set(clipId, handle)
  return handle
}

/**
 * Stop the recorder, flush + close the sink, and return the finished file.
 * @returns {Promise<{file: File, url: string, durationSec: number, ext: string,
 *                     width: number, height: number, fps: number} | null>}
 */
export async function stopRecording(clipId) {
  const handle = _active.get(clipId)
  if (!handle) return null
  const { recorder, sink } = handle

  await new Promise((resolve) => {
    if (recorder.state === 'inactive') { resolve(); return }
    recorder.onstop = () => resolve()
    try { recorder.stop() } catch { resolve() }
  })

  const durationSec = (performance.now() - handle.startedAt) / 1000
  const sinkKind = sink?.kind || null
  _active.delete(clipId)

  let file = null
  try { file = await sink?.close() } catch (err) { console.error('Sink close failed:', err) }
  if (!file) return null

  return {
    file,
    url: URL.createObjectURL(file),
    durationSec,
    ext: handle.ext,
    width: handle.width,
    height: handle.height,
    fps: handle.fps,
    sinkKind,
  }
}

/** Guard used by the track-`ended` handler and End-share: stop only if active. */
export async function stopRecordingIfActive(clipId) {
  if (_active.has(clipId)) return stopRecording(clipId)
  return null
}

// ── Save sinks (streaming write, picker → project folder → in-memory) ─────────

/**
 * Open a streaming write sink for a recording. All sinks expose
 * `{ kind, write(blob), close() → Promise<File> }`.
 *
 * showSaveFilePicker needs transient user activation, so this MUST be called
 * from the Record button's click handler (before recorder.start), not from
 * MediaRecorder.onstop where activation has expired.
 *
 * Fallback chain: picker → project media/ folder → in-memory (anchor download).
 */
export async function openRecordingSink(name, ext, projectFolderHandle, handle) {
  const accept = ext === 'mp4' ? { 'video/mp4': ['.mp4'] } : { 'video/webm': ['.webm'] }
  const mimeType = handle?.mimeType || (ext === 'mp4' ? 'video/mp4' : 'video/webm')

  // 1. Picker (primary) — pre-set inside the project's media/ folder when possible.
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      let startIn = 'videos'
      if (projectFolderHandle) {
        try { startIn = await projectFolderHandle.getDirectoryHandle('media', { create: true }) }
        catch { startIn = 'videos' }
      }
      const fh = await window.showSaveFilePicker({
        suggestedName: name, startIn,
        types: [{ description: 'Video', accept }],
      })
      const writable = await fh.createWritable()
      return {
        kind: 'picker',
        write: (blob) => writable.write(blob),
        close: async () => { await writable.close(); return fh.getFile() },
      }
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn('Save picker unavailable:', err)
      // AbortError (user cancelled) or unsupported → fall through.
    }
  }

  // 2. Project folder direct-write (no user activation needed — granted at link).
  if (projectFolderHandle) {
    try {
      const dir = await projectFolderHandle.getDirectoryHandle('media', { create: true })
      const fh = await dir.getFileHandle(name, { create: true })
      const writable = await fh.createWritable()
      return {
        kind: 'project',
        write: (blob) => writable.write(blob),
        close: async () => { await writable.close(); return fh.getFile() },
      }
    } catch (err) {
      console.warn('Project-folder sink unavailable:', err)
    }
  }

  // 3. In-memory fallback — assemble a Blob and trigger an anchor download.
  return {
    kind: 'memory',
    write: (blob) => { handle.memChunks.push(blob) },
    close: async () => {
      const file = new File([new Blob(handle.memChunks, { type: mimeType })], name, { type: mimeType })
      const url = URL.createObjectURL(file)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return file
    },
  }
}
