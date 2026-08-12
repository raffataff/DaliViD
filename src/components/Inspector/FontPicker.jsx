/**
 * DaliVid — FontPicker.jsx
 * The Font field in the text inspector.
 *
 * A native <select> was the obvious thing here and is the wrong thing: option
 * elements only honour font-family on some platforms, so the one piece of
 * information that actually matters when choosing a typeface — what it looks
 * like — would be invisible on the others. This renders each entry in its own
 * face, which turns picking a font from a guessing game into a glance.
 *
 * The panel is position:fixed and anchored off the trigger's bounding box
 * because the Inspector is a scrolling column; an absolutely-positioned popup
 * would be clipped by it.
 *
 * Opening the picker is also what triggers the bundled fonts to download. That
 * is deliberate: a project that never touches text never pays for them, and by
 * the time a user has opened this list they have asked to see them.
 */

import { useState, useEffect, useRef, useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import {
  listAllFonts, resolveFont, onFontsChanged, preloadPickerFonts, requestFont,
  FONT_GROUP_ORDER,
} from '../../utils/fontRegistry'
import { promptForFontFiles } from '../../utils/fontImport'
import { localFontsSupported } from '../../utils/localFonts'
import FontBrowserModal from '../common/FontBrowserModal'
import './FontPicker.css'

const PANEL_WIDTH = 268
const PANEL_MAX_HEIGHT = 380

/** Subscribe to the registry so added/removed/loaded fonts refresh the list. */
function useFonts() {
  return useSyncExternalStore(onFontsChanged, listAllFonts, listAllFonts)
}

/** Search and heading share one name for the user's own fonts. */
const groupHeading = (group) => (group === 'Project' ? 'Your fonts' : group)
const groupSearchName = (group) => groupHeading(group).toLowerCase()

/**
 * @param {{ value: string, onChange: (fontId: string) => void }} props
 *   `value` is a fontRegistry id (or a legacy CSS stack from an old project —
 *   resolveFont handles both).
 */
export default function FontPicker({ value, onChange }) {
  const fonts = useFonts()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [anchor, setAnchor] = useState(null)
  const [browser, setBrowser] = useState(null)   // 'computer' | 'google' | null

  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const searchRef = useRef(null)
  // 'center' | 'nearest' | false — see the reveal effect below. A ref, not
  // state, because arming it must not itself cause a render.
  const revealActiveRef = useRef(false)

  const current = resolveFont(value)

  // Flat, filtered, group-ordered list. Also the keyboard navigation order, so
  // arrow keys move through exactly what the user can see.
  //
  // Group names match on PREFIX while names match anywhere. That asymmetry is
  // deliberate: with a substring match, typing "play" also matches the *group*
  // "Display", so looking for Playfair hands you Bebas Neue and Anton as well.
  // Searching by category ("serif", "mono") is something people do from the
  // start of the word, so a prefix is all it needs to be.
  const q = query.trim().toLowerCase()
  const matches = fonts.filter(f => !q
    || f.label.toLowerCase().includes(q)
    || groupSearchName(f.group).startsWith(q))
  const ordered = FONT_GROUP_ORDER.flatMap(group => matches.filter(f => f.group === group))

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  const choose = useCallback((font) => {
    onChange(font.id)
    close()
  }, [onChange, close])

  const openPanel = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor(rect)
    // Fetch the faces so the list can render itself honestly.
    preloadPickerFonts()
    setQuery('')
    setActiveIndex(Math.max(0, ordered.findIndex(f => f.id === current.id)))
    // Centre the current font on open — you want to see what it sits between,
    // not just that it exists. 'nearest' would park it against an edge.
    revealActiveRef.current = 'center'
    setOpen(true)
  }, [ordered, current.id])

  // The selected face must be available even when the picker was never opened —
  // otherwise the trigger would show the font's name in a fallback typeface.
  useEffect(() => { requestFont(value) }, [value])

  // Dismiss on an outside click, on Escape, and on a scroll or resize that could
  // move the trigger out from under the panel — which is position:fixed against
  // a rect captured once, at open time.
  //
  // The scroll listener must be capture-phase to see scrolls inside nested
  // containers (scroll events don't bubble), and that is exactly why it also has
  // to exclude the panel's OWN subtree: the list is overflow-y:auto, so a
  // blanket handler closed the popup the moment you wheeled through it. It also
  // closed it on open, because two things scroll that list programmatically —
  // revealing the selected row, and the reflow as the preview faces finish
  // downloading. Which of the two symptoms you got depended only on whether the
  // current font happened to be visible already, which is why this read as two
  // unrelated bugs.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e) => {
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return
      close()
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    const onScroll = (e) => {
      // A document-level scroll targets `document`, which no element contains —
      // so the case this listener actually exists for still closes.
      const t = e.target
      if (t instanceof Node && panelRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  // preventScroll is load-bearing: focusing an element inside a fixed panel can
  // otherwise make the browser scroll an ancestor to "reveal" it, which is a
  // real scroll of the Inspector column and would legitimately dismiss us.
  useLayoutEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true })
  }, [open])

  // Keep the highlighted row in view — but only when the highlight moved for a
  // reason the pointer cannot see (opening, arrow keys, a new search). Running
  // on every activeIndex change fought the mouse, because hovering a row sets
  // activeIndex too: the scroll moved a different row under the cursor, which
  // set activeIndex again, which scrolled again.
  useLayoutEffect(() => {
    const block = revealActiveRef.current
    if (!open || !block) return
    revealActiveRef.current = false
    panelRef.current
      ?.querySelector('.font-picker__item--active')
      ?.scrollIntoView({ block })
  }, [open, activeIndex])

  const onSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!ordered.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      // Arrow keys move the highlight somewhere the user isn't looking, so this
      // is one of the two cases that may scroll the list itself.
      revealActiveRef.current = 'nearest'
      setActiveIndex(i => (i + step + ordered.length) % ordered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const font = ordered[activeIndex]
      if (font) choose(font)
    }
  }

  const handleAddFont = async () => {
    close()
    const added = await promptForFontFiles()
    if (added.length) onChange(added[added.length - 1].id)
  }

  // Whatever the source, a font that has just been added is almost certainly the
  // one the user wants right now — so selecting it is the last step of adding it.
  const openBrowser = (which) => { close(); setBrowser(which) }
  const handleBrowserAdded = (font) => onChange(font.id)

  // Panel placement: below the trigger, flipped above when there isn't room,
  // and pulled inside the viewport horizontally.
  let panelStyle = null
  if (open && anchor) {
    const below = window.innerHeight - anchor.bottom - 8
    const flip = below < 220 && anchor.top > below
    const height = Math.min(PANEL_MAX_HEIGHT, flip ? anchor.top - 12 : below)
    panelStyle = {
      width: PANEL_WIDTH,
      maxHeight: Math.max(180, height),
      left: Math.max(8, Math.min(anchor.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)),
      ...(flip ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }),
    }
  }

  return (
    <div className="inspector__field">
      <label className="inspector__label">Font</label>

      <button
        ref={triggerRef}
        type="button"
        className={`font-picker__trigger ${current.missing ? 'font-picker__trigger--missing' : ''}`}
        title={current.missing
          ? 'This project uses a font that is not on this machine — re-add the font file to restore it'
          : `${current.label} — click to choose a font`}
        onClick={() => (open ? close() : openPanel())}
      >
        <span
          className="font-picker__trigger-label"
          style={{ fontFamily: `"${current.family}", ${current.fallback}` }}
        >
          {current.missing ? 'Missing font' : current.label}
        </span>
        <span className="font-picker__caret" aria-hidden="true">▾</span>
      </button>

      {open && panelStyle && (
        <div ref={panelRef} className="font-picker__panel" style={panelStyle}>
          <input
            ref={searchRef}
            className="font-picker__search"
            placeholder="Search fonts…"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              // A new query rebuilds the list under the highlight, so send it
              // back to the top of the results rather than wherever row 0 of
              // the previous result set happened to leave the scroll.
              revealActiveRef.current = 'nearest'
              setActiveIndex(0)
            }}
            onKeyDown={onSearchKeyDown}
          />

          <div className="font-picker__list">
            {ordered.length === 0 && (
              <div className="font-picker__empty">No font matches “{query}”</div>
            )}

            {FONT_GROUP_ORDER.map(group => {
              const inGroup = ordered.filter(f => f.group === group)
              if (!inGroup.length) return null
              return (
                <div key={group}>
                  <div className="font-picker__group">{groupHeading(group)}</div>
                  {inGroup.map(font => {
                    const index = ordered.indexOf(font)
                    const [min, max] = font.weights || [400, 400]
                    return (
                      <button
                        key={font.id}
                        type="button"
                        className={
                          'font-picker__item'
                          + (font.id === current.id ? ' font-picker__item--selected' : '')
                          + (index === activeIndex ? ' font-picker__item--active' : '')
                        }
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(font)}
                      >
                        <span
                          className="font-picker__sample"
                          style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
                        >
                          {font.label}
                        </span>
                        <span className="font-picker__meta mono">
                          {min === max ? min : `${min}–${max}`}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>

          <div className="font-picker__sources">
            <button type="button" className="font-picker__add" onClick={handleAddFont}>
              + From a file…
            </button>
            {localFontsSupported() && (
              <button type="button" className="font-picker__add" onClick={() => openBrowser('computer')}>
                + From this computer…
              </button>
            )}
            <button type="button" className="font-picker__add" onClick={() => openBrowser('google')}>
              + Google Fonts…
            </button>
          </div>
        </div>
      )}

      {browser && (
        <FontBrowserModal
          mode={browser}
          onClose={() => setBrowser(null)}
          onAdded={handleBrowserAdded}
        />
      )}
    </div>
  )
}
