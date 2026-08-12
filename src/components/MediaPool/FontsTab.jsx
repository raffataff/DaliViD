/**
 * DaliVid — FontsTab.jsx
 * Fonts as first-class project assets, alongside video, images and audio.
 *
 * Why a Media Pool tab and not just a button in the Inspector: a font you have
 * loaded is a thing you own, and things you own belong somewhere you can see
 * them, count them, and take them away again. A picker entry alone gives no way
 * to answer "which fonts does this project have?" or "why did my project file
 * just get 4 MB bigger?".
 *
 * Cards drag onto the Timeline (→ a text clip in that font) and onto the Node
 * Editor (→ a TEXT_INPUT node), matching how image and shape cards behave — so
 * the fastest way to try a typeface is to throw it at the timeline.
 */

import { useState, useCallback, useMemo, useRef, useEffect, useSyncExternalStore } from 'react'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import {
  listCustomFonts, listAllFonts, onFontsChanged, removeCustomFont,
  preloadPickerFonts, clampWeight, BUNDLED_FONTS,
} from '../../utils/fontRegistry'
import { collectFontUsage } from '../../utils/fontUsage'
import { promptForFontFiles, ingestFontFiles } from '../../utils/fontImport'
import { localFontsSupported } from '../../utils/localFonts'
import FontBrowserModal from '../common/FontBrowserModal'
import { addToast } from '../common/Toast'

/** Human-readable byte size. */
function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The drag payload both the Timeline and the Node Editor already understand. */
function fontDragPayload(font) {
  return {
    kind: 'node',
    clipType: 'text',
    nodeType: 'TEXT_INPUT',
    name: font.label,
    params: {
      fontFamily: font.id,
      text: font.label,
      // A display face pinned at 400 must not arrive asking for Bold. The
      // rasterizer would clamp it anyway, but the Inspector would show a lie.
      fontWeight: clampWeight(font.id, '700'),
    },
  }
}

/** Where a project font came from, for the row's meta line. */
const SOURCE_LABEL = { computer: 'from this computer', google: 'Google Fonts' }

/** One row: the family drawn in itself, plus what it costs and where it's used. */
function FontRow({ font, usage, onRemove }) {
  const [min, max] = font.weights || [400, 400]
  const stack = `"${font.family}", ${font.fallback}`
  return (
    <div
      className="media-pool__file-item media-pool__file-item--interactive"
      draggable="true"
      title={`Drag onto the Timeline for a text clip in ${font.label}, or onto the Node Editor for a Text source node`}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/dalivid-drag', JSON.stringify(fontDragPayload(font)))
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <div className="media-pool__font-thumb" style={{ fontFamily: stack }} aria-hidden="true">Ag</div>

      <div className="media-pool__file-info">
        <div className="media-pool__file-name media-pool__font-name" style={{ fontFamily: stack }}>
          {font.label}
        </div>
        <div className="media-pool__file-meta mono">
          {font.variable ? 'Variable ' : ''}{min === max ? min : `${min}–${max}`}
          {font.size ? ` · ${formatSize(font.size)}` : ''}
          {SOURCE_LABEL[font.source] ? ` · ${SOURCE_LABEL[font.source]}` : ''}
          {usage ? ` · used ${usage}×` : ''}
        </div>
      </div>

      {onRemove && (
        <button
          className="media-pool__font-remove"
          title={usage
            ? `Remove — ${usage} text item${usage === 1 ? '' : 's'} will fall back to the default font`
            : 'Remove this font'}
          onClick={(e) => { e.stopPropagation(); onRemove(font, usage) }}
        >
          ×
        </button>
      )}
    </div>
  )
}

export default function FontsTab() {
  const [dragOver, setDragOver] = useState(false)
  const [browser, setBrowser] = useState(null)   // 'computer' | 'google' | null
  // Depth counter, not a boolean: dragenter/dragleave fire for every child the
  // pointer crosses, so a plain flag flickers off the moment you move over a row.
  const dragDepth = useRef(0)

  // listAllFonts returns a cached array whose identity only changes when the
  // registry does, which is what useSyncExternalStore requires of a snapshot.
  useSyncExternalStore(onFontsChanged, listAllFonts, listAllFonts)
  const custom = listCustomFonts()

  // Narrow selectors rather than whole-store subscriptions: this panel must not
  // re-render on every playhead tick or slider drag.
  const clips = useTimelineStore(s => s.clips)
  const masterGraph = useGraphStore(s => s.masterGraph)
  const clipGraphs = useGraphStore(s => s.clipGraphs)
  const compoundLibrary = useGraphStore(s => s.compoundLibrary)

  const usage = useMemo(
    () => collectFontUsage({ masterGraph, clipGraphs, compoundLibrary }, { clips }),
    [masterGraph, clipGraphs, compoundLibrary, clips],
  )

  // Rendering every name in its own typeface means fetching every typeface.
  // Doing it on mount rather than at app startup keeps a project that never
  // opens this tab at zero font downloads.
  useEffect(() => { preloadPickerFonts() }, [])

  const handleRemove = useCallback(async (font, count) => {
    await removeCustomFont(font.id)
    addToast({
      message: count
        ? `Removed "${font.label}" — ${count} text item${count === 1 ? '' : 's'} now show a fallback. Re-add the file to restore it.`
        : `Removed "${font.label}"`,
      type: count ? 'warning' : 'info',
    })
  }, [])

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setDragOver(false)
    await ingestFontFiles(e.dataTransfer?.files)
  }, [])

  const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')

  return (
    <div
      className={`media-pool__font-drop ${dragOver ? 'media-pool__font-drop--over' : ''}`}
      onDragEnter={(e) => { if (carriesFiles(e)) { dragDepth.current++; setDragOver(true) } }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      <button className="media-pool__import-btn" onClick={() => promptForFontFiles()}>
        + Add Fonts
      </button>
      <div className="media-pool__font-sources">
        {localFontsSupported() && (
          <button className="media-pool__font-source" onClick={() => setBrowser('computer')}>
            This computer…
          </button>
        )}
        <button className="media-pool__font-source" onClick={() => setBrowser('google')}>
          Google Fonts…
        </button>
      </div>
      <p className="media-pool__empty-hint" style={{ margin: '0 0 8px' }}>
        Drop .ttf, .otf, .woff or .woff2 files anywhere in this panel. However you add a
        font — a file, one installed on this computer, or Google Fonts — a copy is stored
        with the project and embedded when you save a project file, so it renders the same
        on other machines and in your export.
      </p>

      {custom.length > 0 && (
        <>
          <div className="media-pool__font-group">Your fonts</div>
          <div className="media-pool__file-list">
            {custom.map(font => (
              <FontRow key={font.id} font={font} usage={usage.get(font.id) || 0} onRemove={handleRemove} />
            ))}
          </div>
        </>
      )}

      <div className="media-pool__font-group">Built in</div>
      <div className="media-pool__file-list">
        {BUNDLED_FONTS.map(font => (
          <FontRow key={font.id} font={font} usage={usage.get(font.id) || 0} />
        ))}
      </div>

      {browser && <FontBrowserModal mode={browser} onClose={() => setBrowser(null)} />}
    </div>
  )
}
