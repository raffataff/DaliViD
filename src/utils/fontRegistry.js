/**
 * DaliVid — fontRegistry.js
 * The single source of truth for every typeface the text rasterizer can draw:
 * the curated set we bundle, the system stacks kept for backwards compatibility,
 * and whatever the user drops in.
 *
 * ── Why a registry rather than a list of CSS strings ──
 * The old TEXT_FONTS array stored raw CSS stacks like `'Inter, system-ui, Arial'`
 * straight into clip params. That had two problems. Inter was never actually
 * installed, so "Sans" silently rendered as whatever the OS happened to provide
 * — meaning the same project looked different on two machines and an export
 * didn't necessarily match the preview. And a raw stack carries no metadata, so
 * the Weight dropdown offered 100–900 for faces that ship a single weight and
 * the browser faked the rest by smearing outlines.
 *
 * Params now store a stable font *id*. `resolveFont` is deliberately tolerant:
 * it accepts an id, a legacy CSS stack, or a bare family name, and always
 * returns a descriptor. That means old projects keep working with no migration
 * pass over saved data — resolution happens at render time.
 *
 * ── Loading and the raster cache ──
 * Canvas 2D does not wait for fonts. `ctx.font = '700 96px "Bebas Neue"'` with
 * the face still in flight silently draws in a fallback, and textRegistry then
 * caches that wrong raster under its signature — so the mistake sticks until an
 * unrelated param changes. The fix is `fontStateToken`, which folds a font's
 * load state into the raster signature: the cache entry made while a font was
 * loading is a *different* entry from the one made after it arrived, so the
 * renderer re-rasterizes on the next frame with no invalidation bookkeeping.
 *
 * ── Cost ──
 * Bundled faces are lazily imported one family at a time, so an idle project
 * downloads no fonts at all and picking "Playfair Display" fetches only
 * Playfair. Weight-axis-only CSS (`wght.css`) is used in preference to
 * `index.css` because the latter also carries optical-size and static-weight
 * duplicates of the same family.
 */

import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval'
import { readSfntMetadata, DEFAULT_WEIGHT_RANGE } from './fontMetadata.js'

const FONT_KEY_PREFIX = 'dalivid_font_'
export const CUSTOM_FONT_PREFIX = 'custom:'

/** Accept filter for the font file picker / drop zone. */
export const FONT_FILE_ACCEPT = '.ttf,.otf,.woff,.woff2,.ttc,font/ttf,font/otf,font/woff,font/woff2'

/** Order the picker groups render in. */
export const FONT_GROUP_ORDER = ['Project', 'Sans', 'Condensed', 'Serif', 'Slab', 'Display', 'Script', 'Mono', 'System']

/**
 * The bundled set. `css` is a lazy import of the fontsource stylesheet; Vite
 * code-splits each one into its own chunk, so nothing is fetched until a family
 * is actually selected. `italicCss` is separate because a real italic is a
 * second file — families without one get the browser's synthesized oblique,
 * which is the same behaviour as before and better than blocking the checkbox.
 *
 * DM Sans and JetBrains Mono are already loaded eagerly in main.jsx (they are
 * the app's own UI typefaces), so their upright CSS is marked preloaded.
 */
export const BUNDLED_FONTS = [
  {
    id: 'inter', label: 'Inter', group: 'Sans', family: 'Inter Variable',
    fallback: 'system-ui, sans-serif', weights: [100, 900],
    css: () => import('@fontsource-variable/inter/wght.css'),
    italicCss: () => import('@fontsource-variable/inter/wght-italic.css'),
  },
  {
    id: 'dm-sans', label: 'DM Sans', group: 'Sans', family: 'DM Sans Variable',
    fallback: 'system-ui, sans-serif', weights: [100, 1000], preloaded: true,
    italicCss: () => import('@fontsource-variable/dm-sans/wght-italic.css'),
  },
  {
    id: 'archivo', label: 'Archivo', group: 'Sans', family: 'Archivo Variable',
    fallback: 'system-ui, sans-serif', weights: [100, 900],
    css: () => import('@fontsource-variable/archivo/wght.css'),
    italicCss: () => import('@fontsource-variable/archivo/wght-italic.css'),
  },
  {
    id: 'manrope', label: 'Manrope', group: 'Sans', family: 'Manrope Variable',
    fallback: 'system-ui, sans-serif', weights: [200, 800],
    css: () => import('@fontsource-variable/manrope/wght.css'),
  },
  {
    id: 'montserrat', label: 'Montserrat', group: 'Sans', family: 'Montserrat Variable',
    fallback: 'system-ui, sans-serif', weights: [100, 900],
    css: () => import('@fontsource-variable/montserrat/wght.css'),
    italicCss: () => import('@fontsource-variable/montserrat/wght-italic.css'),
  },
  {
    id: 'space-grotesk', label: 'Space Grotesk', group: 'Sans', family: 'Space Grotesk Variable',
    fallback: 'system-ui, sans-serif', weights: [300, 700],
    css: () => import('@fontsource-variable/space-grotesk/wght.css'),
  },
  {
    id: 'oswald', label: 'Oswald', group: 'Condensed', family: 'Oswald Variable',
    fallback: 'Impact, sans-serif', weights: [200, 700],
    css: () => import('@fontsource-variable/oswald/wght.css'),
  },
  {
    id: 'archivo-narrow', label: 'Archivo Narrow', group: 'Condensed', family: 'Archivo Narrow Variable',
    fallback: 'Impact, sans-serif', weights: [400, 700],
    css: () => import('@fontsource-variable/archivo-narrow/wght.css'),
    italicCss: () => import('@fontsource-variable/archivo-narrow/wght-italic.css'),
  },
  {
    id: 'playfair-display', label: 'Playfair Display', group: 'Serif', family: 'Playfair Display Variable',
    fallback: 'Georgia, serif', weights: [400, 900],
    css: () => import('@fontsource-variable/playfair-display/wght.css'),
    italicCss: () => import('@fontsource-variable/playfair-display/wght-italic.css'),
  },
  {
    id: 'lora', label: 'Lora', group: 'Serif', family: 'Lora Variable',
    fallback: 'Georgia, serif', weights: [400, 700],
    css: () => import('@fontsource-variable/lora/wght.css'),
    italicCss: () => import('@fontsource-variable/lora/wght-italic.css'),
  },
  {
    id: 'source-serif-4', label: 'Source Serif', group: 'Serif', family: 'Source Serif 4 Variable',
    fallback: 'Georgia, serif', weights: [200, 900],
    css: () => import('@fontsource-variable/source-serif-4/wght.css'),
    italicCss: () => import('@fontsource-variable/source-serif-4/wght-italic.css'),
  },
  {
    id: 'fraunces', label: 'Fraunces', group: 'Serif', family: 'Fraunces Variable',
    fallback: 'Georgia, serif', weights: [100, 900],
    css: () => import('@fontsource-variable/fraunces/wght.css'),
    italicCss: () => import('@fontsource-variable/fraunces/wght-italic.css'),
  },
  {
    id: 'roboto-slab', label: 'Roboto Slab', group: 'Slab', family: 'Roboto Slab Variable',
    fallback: 'Georgia, serif', weights: [100, 900],
    css: () => import('@fontsource-variable/roboto-slab/wght.css'),
  },
  {
    id: 'alfa-slab-one', label: 'Alfa Slab One', group: 'Slab', family: 'Alfa Slab One',
    fallback: 'Georgia, serif', weights: [400, 400],
    css: () => import('@fontsource/alfa-slab-one/latin.css'),
  },
  {
    id: 'bebas-neue', label: 'Bebas Neue', group: 'Display', family: 'Bebas Neue',
    fallback: 'Impact, sans-serif', weights: [400, 400],
    css: () => import('@fontsource/bebas-neue/latin.css'),
  },
  {
    id: 'anton', label: 'Anton', group: 'Display', family: 'Anton',
    fallback: 'Impact, sans-serif', weights: [400, 400],
    css: () => import('@fontsource/anton/latin.css'),
  },
  {
    id: 'staatliches', label: 'Staatliches', group: 'Display', family: 'Staatliches',
    fallback: 'Impact, sans-serif', weights: [400, 400],
    css: () => import('@fontsource/staatliches/latin.css'),
  },
  {
    id: 'caveat', label: 'Caveat', group: 'Script', family: 'Caveat Variable',
    fallback: 'cursive', weights: [400, 700],
    css: () => import('@fontsource-variable/caveat/wght.css'),
  },
  {
    id: 'permanent-marker', label: 'Permanent Marker', group: 'Script', family: 'Permanent Marker',
    fallback: 'cursive', weights: [400, 400],
    css: () => import('@fontsource/permanent-marker/latin.css'),
  },
  {
    id: 'jetbrains-mono', label: 'JetBrains Mono', group: 'Mono', family: 'JetBrains Mono Variable',
    fallback: 'ui-monospace, monospace', weights: [100, 800], preloaded: true,
    italicCss: () => import('@fontsource-variable/jetbrains-mono/wght-italic.css'),
  },
]

/**
 * The five original stacks, kept verbatim so a project saved before this change
 * rasterizes to the exact same pixels. They are always "ready" — there is
 * nothing to fetch — and honest about their weight range: a system Georgia or
 * Impact has one or two real weights, so offering 900 was never truthful.
 */
export const SYSTEM_FONTS = [
  { id: 'system-sans', label: 'System Sans', group: 'System', family: 'system-ui', fallback: 'Arial, sans-serif', weights: [400, 700], system: true },
  { id: 'system-serif', label: 'Georgia', group: 'System', family: 'Georgia', fallback: '"Times New Roman", serif', weights: [400, 700], system: true },
  { id: 'system-mono', label: 'Courier New', group: 'System', family: 'Courier New', fallback: 'ui-monospace, monospace', weights: [400, 700], system: true },
  { id: 'system-impact', label: 'Impact', group: 'System', family: 'Impact', fallback: 'Haettenschweiler, sans-serif', weights: [400, 400], system: true },
  { id: 'system-display', label: 'Arial Black', group: 'System', family: 'Arial Black', fallback: 'Gadget, sans-serif', weights: [400, 900], system: true },
]

/**
 * Legacy `fontFamily` values → font id. These are the exact strings the old
 * TEXT_FONTS array wrote into params.
 *
 * Note the first mapping is a deliberate upgrade rather than a like-for-like:
 * the old "Sans" stack named Inter first but Inter was never bundled, so it
 * resolved to system-ui in practice. Pointing it at the real Inter is what the
 * stack always claimed to do, and matches what a machine with Inter installed
 * already showed.
 */
const LEGACY_STACKS = {
  'Inter, system-ui, Arial, sans-serif': 'inter',
  'Georgia, "Times New Roman", serif': 'system-serif',
  '"Courier New", ui-monospace, monospace': 'system-mono',
  'Impact, Haettenschweiler, sans-serif': 'system-impact',
  '"Arial Black", Gadget, sans-serif': 'system-display',
}

// ── Module state ───────────────────────────────────────────────────────────

/** id → 'idle' | 'loading' | 'ready' | 'error'. Folded into raster signatures. */
const _loadState = new Map()
/** id → in-flight Promise, so concurrent requests share one import. */
const _inflight = new Map()
/** id → custom font descriptor (registered FontFace + metadata). */
const _custom = new Map()
/** Subscribers notified when the font set or a load state changes. */
const _listeners = new Set()

const _byId = new Map()
for (const f of [...BUNDLED_FONTS, ...SYSTEM_FONTS]) _byId.set(f.id, f)
for (const f of SYSTEM_FONTS) _loadState.set(f.id, 'ready')
for (const f of BUNDLED_FONTS) if (f.preloaded) _loadState.set(f.id, 'ready')

/**
 * Cached picker list. React's useSyncExternalStore requires a getSnapshot that
 * returns the *same* reference until something actually changes — rebuilding
 * the array on every call would spin the component forever.
 */
let _snapshot = null

function notify() {
  _snapshot = null
  for (const fn of _listeners) {
    try { fn() } catch (err) { console.warn('[fontRegistry] listener failed:', err) }
  }
}

/**
 * Subscribe to font-set / load-state changes. The Inspector uses this to redraw
 * its picker when a font arrives; the rasterizer needs no subscription because
 * the state is already baked into its cache signature.
 * @returns {() => void} unsubscribe
 */
export function onFontsChanged(fn) {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

// ── Resolution ─────────────────────────────────────────────────────────────

/** Fallback used when a project references a font that is no longer available. */
const MISSING_FONT = {
  id: 'system-sans', label: 'Missing font', group: 'System',
  family: 'system-ui', fallback: 'Arial, sans-serif', weights: [400, 700], system: true,
}

/**
 * Turn a stored `fontFamily` param into a font descriptor. Accepts a font id, a
 * legacy CSS stack, or a bare family name, and never returns null — an
 * unresolvable value falls back to the system sans so the frame still renders.
 * @param {string} value
 * @returns {object} font descriptor
 */
export function resolveFont(value) {
  if (!value) return _byId.get('inter') || MISSING_FONT

  const direct = _byId.get(value)
  if (direct) return direct

  const custom = _custom.get(value)
  if (custom) return custom

  const legacy = LEGACY_STACKS[value]
  if (legacy) return _byId.get(legacy) || MISSING_FONT

  // A custom font referenced by a project whose binary we no longer hold — the
  // project was opened on a different machine, or the font was removed.
  if (value.startsWith(CUSTOM_FONT_PREFIX)) {
    return { ...MISSING_FONT, id: value, label: 'Missing font', missing: true }
  }

  // Last resort: match on family name (handles a hand-edited param, and any
  // stack whose first family we happen to bundle).
  const first = String(value).split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  for (const f of _byId.values()) if (f.family.toLowerCase() === first) return f
  for (const f of _custom.values()) if (f.label.toLowerCase() === first) return f

  return MISSING_FONT
}

/**
 * The CSS font-family value to hand to `ctx.font` for a stored param value.
 * Always quoted-then-fallback so a family name with spaces parses and a font
 * that failed to load still draws something sensible.
 */
export function fontStack(value) {
  const f = resolveFont(value)
  return `"${f.family}", ${f.fallback}`
}

/**
 * The weight range a font actually ships, so the Weight dropdown can stop
 * offering weights the browser would have to fake.
 * @returns {[number, number]}
 */
export function fontWeightRange(value) {
  return resolveFont(value).weights || DEFAULT_WEIGHT_RANGE
}

/** Clamp a requested weight into what the font can really do. */
export function clampWeight(value, weight) {
  const [min, max] = fontWeightRange(value)
  const w = Number(weight) || 400
  return String(Math.max(min, Math.min(max, w)))
}

/**
 * Cache-busting token for the text raster signature. Folding load state into
 * the signature is what stops a fallback-font raster — drawn in the window
 * before the real face arrived — from being cached permanently.
 *
 * 'idle' and 'loading' deliberately collapse to one token: both mean "drawn in
 * a fallback", so distinguishing them would only buy an extra re-raster per
 * font as it moves between the two.
 */
export function fontStateToken(value) {
  const f = resolveFont(value)
  const state = _loadState.get(f.id)
  return f.id + ':' + (state === 'ready' || state === 'error' ? state : 'pending')
}

/** True once a font is usable (or is a system stack, which always is). */
export function isFontReady(value) {
  return _loadState.get(resolveFont(value).id) === 'ready'
}

// ── Loading ────────────────────────────────────────────────────────────────

/**
 * Load a font if it isn't loaded already. Safe to call every frame: repeat
 * calls for the same font share one in-flight promise, and a settled font
 * returns immediately.
 * @param {string} value — font id or legacy stack
 * @param {{ italic?: boolean }} [opts]
 * @returns {Promise<boolean>} whether the font is usable
 */
export function loadFont(value, { italic = false } = {}) {
  const font = resolveFont(value)
  // A separate italic file is a separate download, so it gets its own in-flight
  // key — but it is always loaded IN ADDITION to the upright, never instead of
  // it. Loading only the italic would leave the upright face unfetched while
  // the font reported itself ready, and every non-italic clip using it would
  // silently render in a fallback.
  const wantItalic = italic && !!font.italicCss
  const key = font.id + (wantItalic ? ':italic' : '')

  if (_inflight.has(key)) return _inflight.get(key)
  if (_loadState.get(font.id) === 'ready' && (!wantItalic || font._italicLoaded)) {
    return Promise.resolve(true)
  }
  if (font.missing) return Promise.resolve(false)

  const p = (async () => {
    try {
      if (font.custom) {
        // The FontFace was constructed and added at ingest time; awaiting it
        // covers the case where a project restore is still decoding.
        await font.face?.loaded
      } else {
        if (font.css && !font._cssLoaded) {
          await font.css()
          font._cssLoaded = true
        }
        if (wantItalic && !font._italicLoaded) {
          await font.italicCss()
          font._italicLoaded = true
        }
        // Importing the stylesheet only registers @font-face rules — it fetches
        // nothing. document.fonts.load is what pulls the woff2 down and resolves
        // when it is usable; without it the very next canvas draw still gets the
        // fallback. One request per style: a variable font is a single file
        // covering its whole weight axis, so asking for the top weight is enough
        // to have every weight below it.
        if (typeof document !== 'undefined' && document.fonts) {
          const [, max] = font.weights || DEFAULT_WEIGHT_RANGE
          const jobs = [document.fonts.load(`${max} 64px "${font.family}"`)]
          if (wantItalic) jobs.push(document.fonts.load(`italic ${max} 64px "${font.family}"`))
          await Promise.all(jobs)
        }
      }
      _loadState.set(font.id, 'ready')
      notify()
      return true
    } catch (err) {
      console.warn(`[fontRegistry] failed to load "${font.label}":`, err)
      _loadState.set(font.id, 'error')
      notify()
      return false
    } finally {
      _inflight.delete(key)
    }
  })()

  _loadState.set(font.id, 'loading')
  _inflight.set(key, p)
  return p
}

/**
 * Fire-and-forget load, for the render path. The rasterizer must stay
 * synchronous (it runs inside the frame loop), so it kicks the load off here
 * and lets `fontStateToken` invalidate its cached raster when the font lands.
 */
export function requestFont(value, italic = false) {
  const font = resolveFont(value)
  const state = _loadState.get(font.id)
  const needsItalic = italic && !!font.italicCss && !font._italicLoaded
  // A font already loading upright still needs a second call once italic is
  // switched on, so `needsItalic` overrides the in-progress guard.
  if (state === 'ready' && !needsItalic) return
  if ((state === 'loading' || state === 'error') && !needsItalic) return
  loadFont(value, { italic })
}

/**
 * Block until every named font is usable. Export calls this before the first
 * encoded frame — a font arriving mid-render would change the raster partway
 * through the video, and a font arriving never would silently ship the wrong
 * typeface to a file the user can't easily re-check.
 * @param {Iterable<string>} values
 */
export async function ensureFontsReady(values) {
  const jobs = []
  for (const v of new Set(values)) {
    if (!v) continue
    jobs.push(loadFont(v, { italic: true }))
  }
  if (jobs.length) await Promise.all(jobs)
  // One more beat for the font system itself to settle before rasterizing.
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready
}

// ── Custom fonts ───────────────────────────────────────────────────────────

/** Every user-added font, newest last. */
export function listCustomFonts() {
  return [..._custom.values()]
}

/**
 * Bundled + system + custom, for the picker. Stable reference between changes
 * so it can be used directly as a useSyncExternalStore snapshot.
 */
export function listAllFonts() {
  if (!_snapshot) _snapshot = [...listCustomFonts(), ...BUNDLED_FONTS, ...SYSTEM_FONTS]
  return _snapshot
}

/**
 * Load every bundled face so the picker can render each name in its own
 * typeface. Called when the picker opens rather than at startup: seeing the
 * fonts is the whole point of opening it, but a project that never touches text
 * should never pay for them.
 */
export function preloadPickerFonts() {
  for (const f of BUNDLED_FONTS) requestFont(f.id)
}

/**
 * SHA-256 of the font bytes, used as its identity. Content addressing means
 * re-importing the same file (or two projects sharing a font) stores one copy,
 * and a project that references `custom:<hash>` is matched by content rather
 * than by a filename the user may have changed.
 */
async function hashBuffer(buffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(digest).slice(0, 10)]
      .map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // Non-secure context (plain http:// on a LAN IP). FNV-1a over the bytes is
  // not cryptographic but is fine for de-duplicating a handful of local files.
  const bytes = new Uint8Array(buffer)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = (h * 0x01000193) >>> 0 }
  return 'f' + h.toString(16).padStart(8, '0') + bytes.length.toString(16)
}

/** Turn "Helvetica-Neue_Bold.otf" into "Helvetica Neue Bold". */
function labelFromFilename(name) {
  return String(name)
    .replace(/\.(ttf|otf|woff2?|ttc)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Custom Font'
}

/**
 * Register a font binary with the document and the registry.
 * The CSS family is derived from the content hash rather than the font's own
 * name so that two different files claiming to be "Helvetica" cannot collide
 * with each other or shadow a locally-installed face of the same name.
 */
async function registerFont(id, hash, buffer, label, meta) {
  const family = `DVFont-${hash}`
  const face = new FontFace(family, buffer)
  await face.load()          // throws on a corrupt / unsupported file
  document.fonts.add(face)

  const descriptor = {
    id, label, family, face, hash,
    group: 'Project',
    fallback: 'system-ui, sans-serif',
    weights: meta?.weights || DEFAULT_WEIGHT_RANGE,
    variable: !!meta?.variable,
    source: meta?.source || 'file',
    size: buffer.byteLength,
    custom: true,
  }
  _custom.set(id, descriptor)
  _loadState.set(id, 'ready')
  return descriptor
}

/** Fonts above this are refused — no legitimate display face is this large. */
export const MAX_FONT_BYTES = 30 * 1024 * 1024

/**
 * Register raw font bytes as a project font. The single ingest path behind all
 * three sources — an uploaded file, a face picked out of the system library, and
 * a family fetched from Google Fonts — so that whatever a user adds ends up
 * content-addressed, persisted and portable in exactly the same way.
 *
 * @param {ArrayBuffer} buffer — raw font file bytes
 * @param {object} opts
 * @param {string} opts.name — filename or family, used for the label and errors
 * @param {[number,number]} [opts.weights] — override when the caller knows better
 *   than the file does (a WOFF2 can't be introspected, but the Google Fonts CSS
 *   that pointed at it states its range)
 * @param {'file'|'computer'|'google'} [opts.source]
 * @returns {Promise<object>} the descriptor (the existing one if already held)
 */
export async function addFontBuffer(buffer, { name = 'Custom Font', weights, variable, source = 'file' } = {}) {
  if (!buffer?.byteLength) throw new Error(`${name} is empty`)
  if (buffer.byteLength > MAX_FONT_BYTES) {
    throw new Error(`${name} is ${(buffer.byteLength / 1048576).toFixed(0)} MB — fonts over 30 MB are almost always a mistake`)
  }

  const hash = await hashBuffer(buffer)
  const id = CUSTOM_FONT_PREFIX + hash
  const existing = _custom.get(id)
  if (existing) return existing

  // The font's own name table beats any label the caller guessed at, and its own
  // fvar/OS-2 beats a caller-supplied range — except for WOFF2, which is
  // compressed and tells us nothing, so `weights` fills that gap.
  const meta = readSfntMetadata(buffer)
  const label = meta.family || labelFromFilename(name)
  const descriptor = await registerFont(id, hash, buffer, label, {
    weights: meta.weights || weights,
    variable: meta.variable || variable,
    source,
  }).catch(() => {
    throw new Error(`${name} could not be read as a font (try .ttf, .otf, .woff or .woff2)`)
  })

  // Persist under its own IndexedDB key rather than inside project params.
  // Autosave rewrites the project blob on a debounce as the user types; a
  // multi-megabyte font riding in that blob would turn every keystroke into a
  // multi-megabyte write.
  try {
    await idbSet(FONT_KEY_PREFIX + hash, {
      hash, label, filename: name, data: buffer,
      weights: descriptor.weights, variable: descriptor.variable,
      source, addedAt: Date.now(),
    })
  } catch (err) {
    console.warn('[fontRegistry] could not persist font (it will work this session only):', err)
  }

  notify()
  return descriptor
}

/**
 * Ingest a font file the user picked or dropped.
 * Rejects with a readable message rather than a DOMException, because the two
 * realistic failures — "that's not a font" and "that format isn't supported
 * here" — both need to reach the user as a toast.
 *
 * @param {File} file
 * @returns {Promise<object>} the font descriptor (existing one if re-imported)
 */
export async function addCustomFontFile(file) {
  if (!file) throw new Error('No file provided')
  if (file.size > MAX_FONT_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB — fonts over 30 MB are almost always a mistake`)
  }
  return addFontBuffer(await file.arrayBuffer(), { name: file.name, source: 'file' })
}

/** Forget a custom font, both in this session and on disk. */
export async function removeCustomFont(id) {
  const font = _custom.get(id)
  if (!font) return
  if (font.face) {
    try { document.fonts.delete(font.face) } catch { /* already gone */ }
  }
  _custom.delete(id)
  _loadState.delete(id)
  try { await idbDel(FONT_KEY_PREFIX + font.hash) } catch { /* best effort */ }
  notify()
}

/**
 * Re-register every font stored in IndexedDB. Called once at startup so a
 * project that references a custom font renders correctly on first paint
 * instead of flashing a fallback.
 */
export async function initFontRegistry() {
  try {
    const all = await idbKeys()
    const fontKeys = all.filter(k => typeof k === 'string' && k.startsWith(FONT_KEY_PREFIX))
    for (const key of fontKeys) {
      try {
        const rec = await idbGet(key)
        if (!rec?.data) continue
        const id = CUSTOM_FONT_PREFIX + rec.hash
        if (_custom.has(id)) continue
        await registerFont(id, rec.hash, rec.data, rec.label, { weights: rec.weights, variable: rec.variable })
      } catch (err) {
        console.warn('[fontRegistry] skipping unreadable stored font', key, err)
      }
    }
    if (fontKeys.length) notify()
  } catch (err) {
    console.warn('[fontRegistry] could not read stored fonts:', err)
  }
}

// ── Project persistence ────────────────────────────────────────────────────

/**
 * Metadata for the custom fonts a project uses — no binaries. This is what goes
 * into IndexedDB saves and autosaves, which run constantly; the bytes already
 * live in their own keys, so repeating them here would be both redundant and
 * ruinous for autosave latency.
 * @param {Iterable<string>} usedIds — font ids referenced by clips/nodes
 */
export function serializeCustomFontRefs(usedIds) {
  const wanted = usedIds ? new Set(usedIds) : null
  return listCustomFonts()
    .filter(f => !wanted || wanted.has(f.id))
    .map(f => ({ id: f.id, hash: f.hash, label: f.label, weights: f.weights, variable: f.variable }))
}

/**
 * Add base64 payloads to font refs so a downloaded .dalivid.json is portable.
 * Only called by the explicit "Save Project File" path — never by autosave.
 */
export async function embedCustomFontData(refs) {
  const out = []
  for (const ref of refs || []) {
    try {
      const rec = await idbGet(FONT_KEY_PREFIX + ref.hash)
      out.push(rec?.data ? { ...ref, data: bufferToBase64(rec.data) } : { ...ref })
    } catch {
      out.push({ ...ref })
    }
  }
  return out
}

/**
 * Re-create custom fonts from a loaded project. Fonts already held locally are
 * left alone (content hashing guarantees they're identical); fonts carrying an
 * embedded payload are stored so they survive the next reload.
 *
 * Intentionally not awaited by the load path: a project should open instantly
 * and let the text re-rasterize as each font arrives, rather than holding the
 * whole UI on a font decode.
 * @returns {Promise<{ restored: number, missing: string[] }>}
 */
export async function restoreCustomFonts(refs) {
  const missing = []
  let restored = 0

  for (const ref of refs || []) {
    if (!ref?.hash) continue
    const id = ref.id || CUSTOM_FONT_PREFIX + ref.hash
    if (_custom.has(id)) continue

    try {
      let buffer = (await idbGet(FONT_KEY_PREFIX + ref.hash))?.data
      const fromProject = !buffer && ref.data
      if (fromProject) buffer = base64ToBuffer(ref.data)
      if (!buffer) { missing.push(ref.label || id); continue }

      await registerFont(id, ref.hash, buffer, ref.label || 'Custom Font', ref)
      restored++

      if (fromProject) {
        await idbSet(FONT_KEY_PREFIX + ref.hash, {
          hash: ref.hash, label: ref.label, filename: ref.label,
          data: buffer, weights: ref.weights, variable: ref.variable, addedAt: Date.now(),
        })
      }
    } catch (err) {
      console.warn('[fontRegistry] could not restore font', ref?.label, err)
      missing.push(ref.label || id)
    }
  }

  if (restored || missing.length) notify()
  return { restored, missing }
}

/** Chunked so a multi-megabyte font can't blow the argument limit on apply(). */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBuffer(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}
