/**
 * DaliViD — waveformCache.js
 * Decode audio files once and cache peak envelopes for timeline waveforms.
 *
 * Each file is decoded a single time (per fileUrl) into a fixed number of
 * peak buckets (max |sample| across all channels per bucket). Clips render by
 * slicing the bucket range covering their source in/out, so trims and splits
 * reuse the same decode with zero extra work.
 */

import { useEffect, useState } from 'react'

const BUCKETS = 2000
const cache = new Map() // fileUrl → { promise, data: { peaks, duration } | null }

async function decodePeaks(fileUrl) {
  const resp = await fetch(fileUrl)
  const arr = await resp.arrayBuffer()
  // An OfflineAudioContext decodes without needing a user gesture.
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const ctx = new OfflineCtx(1, 1, 44100)
  const buf = await ctx.decodeAudioData(arr)

  const peaks = new Float32Array(BUCKETS)
  const samplesPerBucket = Math.max(1, Math.floor(buf.length / BUCKETS))
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c)
    for (let b = 0; b < BUCKETS; b++) {
      const start = b * samplesPerBucket
      const end = Math.min(start + samplesPerBucket, data.length)
      let peak = peaks[b]
      // Stride through the bucket — every 32nd sample is plenty for a display
      // envelope and keeps decode post-processing fast on long songs.
      for (let i = start; i < end; i += 32) {
        const v = Math.abs(data[i])
        if (v > peak) peak = v
      }
      peaks[b] = peak
    }
  }
  return { peaks, duration: buf.duration }
}

/**
 * Kick off (or reuse) the decode for a file. Resolves to { peaks, duration }
 * or null when the file has no decodable audio.
 */
export function loadWaveform(fileUrl) {
  if (!fileUrl) return Promise.resolve(null)
  let entry = cache.get(fileUrl)
  if (!entry) {
    entry = { data: null, promise: null }
    entry.promise = decodePeaks(fileUrl)
      .then(data => { entry.data = data; return data })
      .catch(() => { entry.data = null; return null })
    cache.set(fileUrl, entry)
  }
  return entry.promise
}

/** Synchronous cache read — null until the decode finishes. */
export function getWaveform(fileUrl) {
  return cache.get(fileUrl)?.data ?? null
}

/**
 * React hook: returns { peaks, duration } for a file, or null while decoding
 * (or when decoding failed — callers keep whatever placeholder they render).
 */
export function useWaveform(fileUrl) {
  const [data, setData] = useState(() => getWaveform(fileUrl))
  useEffect(() => {
    let alive = true
    setData(getWaveform(fileUrl))
    if (fileUrl) loadWaveform(fileUrl).then(d => { if (alive) setData(d) })
    return () => { alive = false }
  }, [fileUrl])
  return data
}
