/**
 * DaliVid — FontBrowserModal.jsx
 * The two font sources that aren't a file: the typefaces installed on this
 * computer, and Google Fonts by name.
 *
 * One component for both because the outcome is identical — bytes go through
 * `addFontBuffer` and become an ordinary embedded project font. Only the way you
 * find those bytes differs, so only the middle of the panel changes.
 *
 * Both sources embed rather than reference. A project that renders one typeface
 * in the preview and a different one on another machine is the failure this
 * whole feature exists to prevent, and "it's installed on my computer" is not a
 * property the exported video inherits.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { IconClose } from './Icons'
import { addToast } from './Toast'
import { addFontBuffer } from '../../utils/fontRegistry'
import { listLocalFontFamilies, readLocalFace, localFontsSupported } from '../../utils/localFonts'
import { addGoogleFont, POPULAR_GOOGLE_FONTS } from '../../utils/googleFonts'
import './FontBrowserModal.css'

// A machine with a big font library can list well over a thousand faces.
// Rendering all of them — each in its own typeface — is a real cost for a list
// nobody scrolls to the bottom of, so the view is capped and says so.
const MAX_ROWS = 150

/**
 * @param {{ mode: 'computer'|'google', onClose: () => void, onAdded?: (font) => void }} props
 */
export default function FontBrowserModal({ mode, onClose, onAdded }) {
  const [query, setQuery] = useState('')
  const [families, setFamilies] = useState(null)   // null = not yet requested
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const searchRef = useRef(null)

  useEffect(() => { searchRef.current?.focus() }, [mode])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const grant = useCallback(async () => {
    setBusy(true); setError('')
    try {
      setFamilies(await listLocalFontFamilies())
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [])

  const addFace = useCallback(async (family, face) => {
    setBusy(true); setError('')
    try {
      const { buffer, name } = await readLocalFace(face)
      const font = await addFontBuffer(buffer, { name, source: 'computer' })
      addToast({ message: `Added "${font.label}" from this computer`, type: 'success' })
      onAdded?.(font)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [onAdded, onClose])

  const fetchGoogle = useCallback(async (name) => {
    setBusy(true); setError('')
    try {
      const font = await addGoogleFont(name)
      addToast({ message: `Added "${font.label}" from Google Fonts`, type: 'success' })
      onAdded?.(font)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [onAdded, onClose])

  const q = query.trim().toLowerCase()

  const localRows = useMemo(() => {
    if (!families) return []
    return families.filter(f => !q || f.family.toLowerCase().includes(q))
  }, [families, q])

  const googleRows = useMemo(
    () => POPULAR_GOOGLE_FONTS.filter(n => !q || n.toLowerCase().includes(q)),
    [q],
  )

  return (
    <div className="font-browser__overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="font-browser" role="dialog" aria-modal="true">
        <div className="font-browser__header">
          <h3>{mode === 'computer' ? 'Fonts on this computer' : 'Google Fonts'}</h3>
          <button className="font-browser__close" onClick={onClose} title="Close"><IconClose /></button>
        </div>

        <div className="font-browser__body">
          {mode === 'computer' && !localFontsSupported() && (
            <p className="font-browser__note">
              This browser can’t list installed fonts. Chrome and Edge can; in others,
              “Add font from file” does the same job.
            </p>
          )}

          {mode === 'computer' && localFontsSupported() && families === null && (
            <div className="font-browser__gate">
              <p className="font-browser__note">
                DaliViD will ask your browser for the list of fonts installed on this
                computer. The font you pick is copied into the project, so the text
                still renders correctly on other machines and in your export.
              </p>
              <button className="font-browser__primary" onClick={grant} disabled={busy}>
                {busy ? 'Waiting for permission…' : 'Show my fonts'}
              </button>
            </div>
          )}

          {mode === 'google' && (
            <p className="font-browser__note">
              Type any family name from fonts.google.com. It’s downloaded once and stored
              in the project — after that it works offline and travels with the file.
            </p>
          )}

          {(mode === 'google' || families) && (
            <input
              ref={searchRef}
              className="font-browser__search"
              placeholder={mode === 'computer' ? 'Search installed fonts…' : 'Family name, e.g. Lobster'}
              value={query}
              spellCheck={false}
              onChange={(e) => { setQuery(e.target.value); setError('') }}
              onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'google') fetchGoogle(query) }}
            />
          )}

          {error && <div className="font-browser__error">{error}</div>}

          {mode === 'computer' && families && (
            <>
              <div className="font-browser__list">
                {localRows.length === 0 && <div className="font-browser__empty">No installed font matches “{query}”</div>}
                {localRows.slice(0, MAX_ROWS).map(({ family, faces }) => (
                  <div key={family} className="font-browser__family">
                    {/* Installed fonts can be previewed by family name directly —
                        they're already available to CSS, unlike a webfont. */}
                    <div className="font-browser__family-name" style={{ fontFamily: `"${family}"` }}>{family}</div>
                    <div className="font-browser__faces">
                      {faces.map(face => (
                        <button
                          key={face.postscriptName}
                          className="font-browser__face"
                          disabled={busy}
                          title={`Add ${face.fullName} to this project`}
                          onClick={() => addFace(family, face)}
                        >
                          {face.style}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {localRows.length > MAX_ROWS && (
                <div className="font-browser__truncated">
                  Showing {MAX_ROWS} of {localRows.length} families — narrow the search to see the rest.
                </div>
              )}
            </>
          )}

          {mode === 'google' && (
            <>
              <button
                className="font-browser__primary"
                disabled={busy || !query.trim()}
                onClick={() => fetchGoogle(query)}
              >
                {busy ? 'Downloading…' : `Add “${query.trim() || '…'}”`}
              </button>
              <div className="font-browser__group">Popular</div>
              <div className="font-browser__chips">
                {googleRows.map(name => (
                  <button key={name} className="font-browser__chip" disabled={busy} onClick={() => fetchGoogle(name)}>
                    {name}
                  </button>
                ))}
                {googleRows.length === 0 && (
                  <span className="font-browser__empty">
                    Not in the shortlist — press Enter to fetch “{query.trim()}” anyway.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
