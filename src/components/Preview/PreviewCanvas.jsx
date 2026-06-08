import { useRef, useEffect, useState, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import useAudioStore from '../../store/useAudioStore'
import { Renderer } from '../../gl/Renderer'
import { getAudioEngine } from '../../audio/AudioEngine'
import './PreviewCanvas.css'

/**
 * PreviewCanvas — main preview panel with WebGL2 rendering pipeline.
 * Instantiates the Renderer and connects it to Zustand stores for live updates.
 */
export default function PreviewCanvas() {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [displaySize, setDisplaySize] = useState({ width: 640, height: 360 })
  const [renderFps, setRenderFps] = useState(0)
  const isPanning = useRef(false)
  const lastPanPos = useRef({ x: 0, y: 0 })
  const zoomRef = useRef(1)

  // Keep zoomRef in sync
  useEffect(() => { zoomRef.current = zoom }, [zoom])

  const resolution = useAppStore(s => s.resolution)
  const graphLevel = useAppStore(s => s.graphLevel)
  const isPlaying = useAppStore(s => s.isPlaying)

  // Auto-size canvas to fit container while maintaining aspect ratio
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const update = () => {
      const rect = container.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      if (w <= 0 || h <= 0) return
      const aspectRatio = resolution.width / resolution.height
      let cw, ch
      if (w / h > aspectRatio) {
        ch = Math.floor(h)
        cw = Math.floor(ch * aspectRatio)
      } else {
        cw = Math.floor(w)
        ch = Math.floor(cw / aspectRatio)
      }
      const newWidth = Math.max(100, cw)
      const newHeight = Math.max(56, ch)
      setDisplaySize(prev => {
        if (prev.width === newWidth && prev.height === newHeight) return prev
        return { width: newWidth, height: newHeight }
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [resolution])

  // Initialize Renderer and connect stores
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let renderer = rendererRef.current
    if (!renderer) {
      try {
        renderer = new Renderer(canvas)
        rendererRef.current = renderer
        canvas._renderer = renderer

        // Connect store accessors
        renderer.connectStores(
          () => useAppStore.getState(),
          () => useGraphStore.getState(),
          () => useTimelineStore.getState(),
          () => useAudioStore.getState()
        )

        // FPS callback
        renderer.onFPSUpdate = (fps) => setRenderFps(fps)

        // Start in paused mode (10fps polling for slider updates)
        renderer.pause()

        console.log('[PreviewCanvas] Renderer initialized:', renderer.rendererString)
      } catch (err) {
        console.error('[PreviewCanvas] Failed to create renderer:', err)
        return
      }
    }

    // Update resolution
    renderer.setResolution(displaySize.width, displaySize.height)

    return () => {
      // Don't dispose on HMR — keep the renderer alive
    }
  }, [displaySize])

  // Respond to play/pause state changes
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    if (isPlaying) {
      renderer.start()
    } else {
      renderer.pause()
    }
  }, [isPlaying])

  // Initialize audio engine on first user interaction
  useEffect(() => {
    const initAudio = async () => {
      const engine = getAudioEngine()
      if (!engine.ctx) {
        await engine.init()
      }
      engine.startAnalysis(() => useAudioStore.getState())
      await engine.resume()
    }

    const handler = () => {
      initAudio()
      window.removeEventListener('click', handler)
      window.removeEventListener('keydown', handler)
    }

    window.addEventListener('click', handler)
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('click', handler)
      window.removeEventListener('keydown', handler)
    }
  }, [])

  // Subscribe to graph changes to mark renderer dirty
  useEffect(() => {
    const unsub = useGraphStore.subscribe((state, prevState) => {
      // markDirty() whenever the graph objects change
      if (rendererRef.current) {
        if (!prevState || state.masterGraph !== prevState.masterGraph || state.clipGraphs !== prevState.clipGraphs) {
          rendererRef.current.markDirty()
        }
      }
    })
    return unsub
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rendererRef.current) {
        rendererRef.current.dispose()
        rendererRef.current = null
      }
    }
  }, [])

  // Zoom via mousewheel
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(prev => Math.min(4, Math.max(0.25, prev * factor)))
  }, [])

  // Attach native wheel listener because React 18 makes onWheel passive,
  // which silently prevents e.preventDefault() from working.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // Pan via middle-click
  const handleMouseDown = useCallback((e) => {
    if (e.button === 1) {
      e.preventDefault()
      isPanning.current = true
      lastPanPos.current = { x: e.clientX, y: e.clientY }
    }
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (isPanning.current) {
      const dx = e.clientX - lastPanPos.current.x
      const dy = e.clientY - lastPanPos.current.y
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }))
      lastPanPos.current = { x: e.clientX, y: e.clientY }
    }
  }, [])

  const handleMouseUp = useCallback(() => {
    isPanning.current = false
  }, [])

  const fitToWindow = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const contextLabel = graphLevel === 'master' ? 'MASTER' : 'ISOLATED'
  const contextClass = graphLevel === 'master' ? 'preview__context-label--master' : 'preview__context-label--isolated'

  return (
    <>
      <div className="panel__header">
        <span className="panel__header-title">Preview</span>
        <span className="preview__res-badge mono">{resolution.width}×{resolution.height}</span>
        <div style={{ flex: 1 }} />
        <span className="preview__fps-badge mono">{renderFps} fps</span>
        <button className="panel__header-btn" onClick={fitToWindow} data-tooltip="Fit to Window">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.5 5V2H4.5M9.5 2H12.5V5M12.5 9V12H9.5M4.5 12H1.5V9" />
          </svg>
        </button>
      </div>
      <div
        className={`preview__container ${graphLevel !== 'master' ? 'preview__container--isolated' : ''}`}
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* WebGL Canvas */}
        <div
          className="preview__canvas-wrapper"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: isPanning.current ? 'none' : 'transform 0.15s ease-out'
          }}
        >
        <canvas
          ref={canvasRef}
          className="preview__canvas"
          width={displaySize.width}
          height={displaySize.height}
          id="preview-canvas"
        />
        </div>

        {/* Overlay Indicators */}
        <div className="preview__overlay-top-left">
          <span className={`preview__context-label ${contextClass}`}>
            {contextLabel}
          </span>
        </div>

        <div className="preview__overlay-bottom-right">
          <span className="preview__zoom-level mono">
            {Math.round(zoom * 100)}%
          </span>
        </div>
      </div>
    </>
  )
}
