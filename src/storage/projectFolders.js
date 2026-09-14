/**
 * DaliVid — storage/projectFolders.js
 * One folder per project, and the list of projects we know about.
 *
 * ── The model ──
 * A project IS a folder the user chose for it. Not a folder that contains all
 * projects — projects live wherever their footage lives, which is the point.
 *
 *   <the folder the user picked>/
 *     project.json      the edit
 *     media/            this project's media, under their real filenames
 *     backups/          previous versions of project.json
 *
 * So the vault's root is the OPEN PROJECT's folder, and it changes every time a
 * project is opened. Everything downstream of the vault stays as it is, because
 * the vault has always been written against a directory handle.
 *
 * ── What this module owns ──
 * The registry: which projects exist, what they are called, and the handle for
 * each. The registry's *metadata* is plain data in IndexedDB and can be read
 * with no permission at all — that is what lets the project window show a list
 * of projects without prompting for anything. Only opening one needs a click.
 *
 * ── Why the permission prompt is not fought ──
 * A stored handle does not carry its permission across a page load. That is the
 * browser working as intended, and one click per project opened is a fair price
 * for media that never needs relinking. Do not try to route around it.
 */

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval'
import { setRootHandle } from './webVault.js'

/** Metadata for every project we have seen. Readable without any permission. */
const INDEX_KEY = 'dalivid_project_index'
/** One stored directory handle per project. */
const handleKey = (id) => `dalivid_pfolder_${id}`

/** The project document, at the root of the project's own folder. */
export const PROJECT_DOC = 'project.json'
export const MEDIA_DIR = 'media'
export const BACKUP_DIR = 'backups'

let _current = null          // { id, name, folderName, handle }
const _listeners = new Set()

/** True when this browser can pick a folder at all (Chromium-only today). */
export function isFolderSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/** The open project's folder, or null when no project is open. */
export function currentProjectFolder() {
  return _current ? { id: _current.id, name: _current.name, folderName: _current.folderName } : null
}

/** Subscribe to open/close. Returns an unsubscribe function. */
export function onProjectFolderChange(fn) {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

function notify() {
  const info = currentProjectFolder()
  for (const fn of _listeners) {
    try { fn(info) } catch { /* a listener must not break the link */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<Array<{id,name,folderName,lastOpened}>>} newest first. */
export async function listKnownProjects() {
  try {
    const rows = await idbGet(INDEX_KEY)
    if (!Array.isArray(rows)) return []
    return [...rows].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))
  } catch {
    return []
  }
}

async function writeIndex(rows) {
  await idbSet(INDEX_KEY, rows)
}

/** Add or update a project's entry, without touching its handle. */
async function upsertEntry(entry) {
  const rows = await listKnownProjects()
  const next = rows.filter(r => r.id !== entry.id)
  next.unshift({ ...rows.find(r => r.id === entry.id), ...entry })
  await writeIndex(next)
}

/**
 * Forget a project.
 *
 * Removes it from the list and drops our handle. **The folder and everything in
 * it are left completely alone** — this is "stop showing me this", not "delete
 * my work", and the UI must say so.
 */
export async function forgetProject(id) {
  const rows = await listKnownProjects()
  await writeIndex(rows.filter(r => r.id !== id))
  await idbDel(handleKey(id)).catch(() => {})
  if (_current?.id === id) await closeProject()
}

/** Update the stored display name, e.g. after a rename in Project Settings. */
export async function renameKnownProject(id, name) {
  const rows = await listKnownProjects()
  await writeIndex(rows.map(r => (r.id === id ? { ...r, name } : r)))
  if (_current?.id === id) {
    _current.name = name
    notify()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Picking, opening, closing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask the user for a folder. Must be called from a user gesture.
 * @returns {Promise<FileSystemDirectoryHandle|null>} null if they cancelled
 */
export async function pickFolder() {
  if (!isFolderSupported()) {
    throw new Error('Choosing a folder needs Chrome, Edge or Opera.')
  }
  let handle
  try {
    handle = await window.showDirectoryPicker({
      id: 'dalivid-project',
      mode: 'readwrite',
      startIn: 'documents',
    })
  } catch (err) {
    if (err?.name === 'AbortError') return null      // dialog closed — not an error
    throw err
  }

  const state = await handle.requestPermission({ mode: 'readwrite' })
  if (state !== 'granted') throw new Error('Write access to that folder was not granted.')
  return handle
}

/**
 * Is there already a project in this folder?
 *
 * Checked before creating one, so "New Project" into an occupied folder is a
 * question rather than an overwrite. Reading `project.json` is also how a folder
 * the app has never seen gets adopted — see `adoptFolder`.
 *
 * @returns {Promise<object|null>} the parsed document, or null
 */
export async function readProjectDoc(handle) {
  try {
    const fh = await handle.getFileHandle(PROJECT_DOC)
    return JSON.parse(await (await fh.getFile()).text())
  } catch { /* not at the root — try the legacy nesting below */ }

  // A build before this one could write the browser-storage layout into a
  // project folder, leaving the document at `projects/<id>/project.json`. Read
  // it so those folders still open; the next save writes it to the root and the
  // folder heals itself.
  try {
    const projects = await handle.getDirectoryHandle('projects', { create: false })
    for await (const [, sub] of projects.entries()) {
      if (sub.kind !== 'directory') continue
      try {
        const fh = await sub.getFileHandle(PROJECT_DOC)
        return JSON.parse(await (await fh.getFile()).text())
      } catch { /* keep looking */ }
    }
  } catch { /* no nested layout either */ }

  return null
}

/**
 * Make `handle` the open project's folder.
 *
 * `setRootHandle` is imported STATICALLY on purpose. It used to be a dynamic
 * import, to dodge a circular dependency that does not actually exist — webVault
 * knows nothing about this module. The cost was real: under Vite's HMR a
 * dynamically imported module can resolve to a *different instance* from the one
 * `index.js` already holds, so the root would be set on one copy while
 * `isExternalRoot()` kept answering from the other. Everything then writes to the
 * browser-storage layout inside the user's folder, with no error to show for it.
 */
async function activate(handle, { id, name }) {
  _current = { id, name, folderName: handle.name, handle }
  setRootHandle(handle)
  await idbSet(handleKey(id), handle)
  await upsertEntry({ id, name, folderName: handle.name, lastOpened: Date.now() })
  notify()
}

/**
 * Register a brand-new project in a folder the user just picked.
 * The caller writes `project.json` afterwards, through the normal save path.
 */
export async function createProjectIn(handle, { id, name }) {
  await activate(handle, { id, name })
  await writeFolderReadme(handle)
  return currentProjectFolder()
}

/**
 * Open a project already in the registry.
 *
 * @param {string} id
 * @param {{prompt?: boolean}} [opts] `prompt: true` may show the browser's
 *   permission dialog, so it MUST come from a user gesture.
 * @returns {Promise<{ok: boolean, reason?: string, name?: string, doc?: object}>}
 */
export async function openKnownProject(id, { prompt = true } = {}) {
  let handle
  try {
    handle = await idbGet(handleKey(id))
  } catch {
    handle = null
  }
  if (!handle) return { ok: false, reason: 'no-handle' }

  let state
  try {
    state = await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    return { ok: false, reason: 'stale' }
  }
  if (state === 'prompt' && prompt) {
    try { state = await handle.requestPermission({ mode: 'readwrite' }) } catch { state = 'denied' }
  }
  if (state !== 'granted') return { ok: false, reason: 'denied' }

  const doc = await readProjectDoc(handle)
  if (!doc) return { ok: false, reason: 'missing-doc' }

  const name = doc.project?.name || 'Untitled Project'
  await activate(handle, { id: doc.project?.id || id, name })
  return { ok: true, name, doc }
}

/**
 * Adopt a folder the user points at — the route back to a project this browser
 * has never seen, or one whose entry was forgotten. Copying a project folder to
 * another machine and opening it there is the same path.
 *
 * @returns {Promise<{ok: boolean, reason?: string, doc?: object, name?: string}>}
 */
export async function adoptFolder(handle) {
  const doc = await readProjectDoc(handle)
  if (!doc) return { ok: false, reason: 'no-project' }

  const id = doc.project?.id || crypto.randomUUID()
  const name = doc.project?.name || 'Untitled Project'
  await activate(handle, { id, name })
  return { ok: true, doc, name }
}

/**
 * Projects still living in browser storage, from before folders existed.
 *
 * Read straight from OPFS rather than through the vault, so the answer does not
 * depend on which project is open. Without this the whole pre-folder library
 * would be unreachable the moment the Projects window stopped listing it —
 * stranding exactly the work this feature was meant to protect.
 *
 * @returns {Promise<Array<{id, name, savedAt}>>}
 */
export async function listBrowserProjects() {
  const out = new Map()

  if (navigator.storage?.getDirectory) {
    try {
      const opfs = await navigator.storage.getDirectory()
      const dir = await opfs.getDirectoryHandle('projects', { create: false })
      for await (const [id, handle] of dir.entries()) {
        if (handle.kind !== 'directory') continue
        try {
          const fh = await handle.getFileHandle(PROJECT_DOC)
          const doc = JSON.parse(await (await fh.getFile()).text())
          out.set(id, { id, name: doc.project?.name || 'Untitled Project', savedAt: doc.savedAt || null })
        } catch { /* unreadable — skip it, don't fail the list */ }
      }
    } catch { /* no projects dir yet */ }
  }

  // Older still: documents that never made it out of IndexedDB.
  try {
    const { keys, get } = await import('idb-keyval')
    for (const k of await keys()) {
      if (typeof k !== 'string' || !k.startsWith('dalivid_project_')) continue
      const doc = await get(k)
      const id = doc?.project?.id
      if (!id || out.has(id)) continue
      out.set(id, { id, name: doc.project?.name || 'Untitled Project', savedAt: doc.savedAt || null })
    }
  } catch { /* idb-keyval unavailable */ }

  return [...out.values()].sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0))
}

/**
 * How much browser storage the pre-folder projects are holding.
 *
 * Read directly from OPFS, like everything else in this group, so asking the
 * question never moves the vault's root out from under an open project.
 *
 * @returns {Promise<{projects: number, blobs: number, bytes: number}>}
 */
export async function browserStorageStats() {
  const out = { projects: 0, blobs: 0, bytes: 0 }
  if (!navigator.storage?.getDirectory) return out

  const opfs = await navigator.storage.getDirectory()
  try {
    const dir = await opfs.getDirectoryHandle('projects', { create: false })
    for await (const [, h] of dir.entries()) if (h.kind === 'directory') out.projects++
  } catch { /* none */ }
  try {
    const dir = await opfs.getDirectoryHandle('blobs', { create: false })
    for await (const [, h] of dir.entries()) {
      if (h.kind !== 'file') continue
      out.blobs++
      out.bytes += (await h.getFile()).size
    }
  } catch { /* none */ }
  return out
}

/**
 * Permanently delete one pre-folder project from browser storage.
 *
 * **Deliberately does NOT go through the vault.** Routing this through
 * `projectStore.deleteProject` would mean pointing the vault back at browser
 * storage first, which drops the playback URLs of whatever folder project is
 * open — deleting a stale test project must not disturb the work in progress.
 *
 * Media is left in place; `reclaimBrowserMedia` collects it once, afterwards,
 * when the full picture of what is still referenced is available.
 */
export async function deleteBrowserProject(id) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(id))) throw new TypeError('unsafe project id')

  if (navigator.storage?.getDirectory) {
    try {
      const opfs = await navigator.storage.getDirectory()
      const dir = await opfs.getDirectoryHandle('projects', { create: false })
      await dir.removeEntry(id, { recursive: true })
    } catch { /* already gone */ }
  }
  // The older IndexedDB copy too, or the project reappears on the next boot.
  try {
    const { del } = await import('idb-keyval')
    await del(`dalivid_project_${id}`)
  } catch { /* idb-keyval unavailable */ }
}

/**
 * Delete every media file in browser storage that no remaining project needs.
 *
 * The reachable set is scanned out of the surviving project documents and the
 * autosave slot, by ref id, so a document shape this function does not know
 * about still keeps its media. Over-inclusion wastes bytes; under-inclusion
 * destroys someone's footage, and only one of those is recoverable.
 *
 * @returns {Promise<{deleted: number, freed: number, kept: number}>}
 */
export async function reclaimBrowserMedia() {
  const result = { deleted: 0, freed: 0, kept: 0 }
  if (!navigator.storage?.getDirectory) return result

  const opfs = await navigator.storage.getDirectory()
  const reachable = new Set()
  const scan = (text) => {
    if (!text) return
    for (const m of String(text).matchAll(/mr_([0-9a-f]{4,32})/g)) reachable.add(m[1])
  }

  try {
    const dir = await opfs.getDirectoryHandle('projects', { create: false })
    for await (const [, sub] of dir.entries()) {
      if (sub.kind !== 'directory') continue
      try {
        scan(await (await (await sub.getFileHandle(PROJECT_DOC)).getFile()).text())
      } catch { /* unreadable — skip */ }
    }
  } catch { /* no projects left */ }

  try {
    const { keys, get } = await import('idb-keyval')
    for (const k of await keys()) {
      if (typeof k !== 'string') continue
      if (!k.startsWith('dalivid_project_') && k !== 'dalivid_autosave') continue
      try { scan(JSON.stringify(await get(k))) } catch { /* skip */ }
    }
  } catch { /* idb-keyval unavailable */ }

  try {
    const dir = await opfs.getDirectoryHandle('blobs', { create: false })
    const doomed = []
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue
      if (reachable.has(name)) { result.kept++; continue }
      doomed.push([name, (await h.getFile()).size])
    }
    for (const [name, bytes] of doomed) {
      await dir.removeEntry(name).catch(() => {})
      result.deleted++
      result.freed += bytes
    }
  } catch { /* no blobs */ }

  return result
}

/**
 * Point the vault back at browser storage so a pre-folder project can be read.
 *
 * Its media is in OPFS `blobs/`, keyed by hash, so the root has to move before
 * anything will resolve. Project Settings then offers to move it into a folder.
 */
export async function useBrowserStorage() {
  _current = null
  setRootHandle(null)
  notify()
}

/**
 * Move a project out of browser storage and into a folder of its own.
 *
 * The migration path for everything made before folders existed. Media is copied
 * straight from OPFS `blobs/<hash>` into the folder's `media/<filename>` — as a
 * stream, so a multi-GB clip never lands in memory — and the caller stamps the
 * returned names onto the refs before saving.
 *
 * Nothing in browser storage is deleted. If this dies half way, the original is
 * still the working copy and re-running simply finishes the job.
 *
 * @param {FileSystemDirectoryHandle} handle — the empty folder to move into
 * @param {Array<{id, hash, filename}>} refs — the open project's media refs
 * @returns {Promise<Map<string, string>>} refId → the name used inside media/
 */
export async function moveProjectToFolder(handle, refs) {
  const written = new Map()
  if (!navigator.storage?.getDirectory) return written

  const opfs = await navigator.storage.getDirectory()
  let blobs
  try {
    blobs = await opfs.getDirectoryHandle('blobs', { create: false })
  } catch {
    return written                                  // nothing stored yet
  }
  const media = await handle.getDirectoryHandle(MEDIA_DIR, { create: true })
  const taken = new Set()
  for await (const [name] of media.entries()) taken.add(name)

  for (const ref of refs || []) {
    if (!ref?.hash) continue
    let src
    try {
      src = await (await blobs.getFileHandle(ref.hash)).getFile()
    } catch {
      continue                                      // bytes already gone; ref stays missing
    }

    const name = uniqueAmong(taken, sanitise(ref.filename || ref.hash))
    taken.add(name)

    const dest = await media.getFileHandle(name, { create: true })
    const w = await dest.createWritable()
    try {
      await src.stream().pipeTo(w)
    } catch (err) {
      await w.close().catch(() => {})
      throw err
    }
    written.set(ref.id, name)
  }
  return written
}

function sanitise(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 120).trim()
  return cleaned || 'media'
}

function uniqueAmong(taken, wanted) {
  if (!taken.has(wanted)) return wanted
  const dot = wanted.lastIndexOf('.')
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted
  const ext = dot > 0 ? wanted.slice(dot) : ''
  for (let n = 2; n < 1000; n++) {
    const c = `${stem} (${n})${ext}`
    if (!taken.has(c)) return c
  }
  return `${stem} (${Date.now()})${ext}`
}

/** Close the open project and point the vault at nothing. */
export async function closeProject() {
  _current = null
  setRootHandle(null)
  notify()
}

/**
 * A short note in the project folder saying what it is.
 *
 * Someone finding this folder later should not have to guess, and should know
 * what will break if they tidy it. Best-effort — never fails the caller.
 */
export async function writeFolderReadme(handle = _current?.handle) {
  if (!handle) return
  const text = [
    'DaliViD project',
    '===============',
    '',
    'This folder is one DaliViD project.',
    '',
    '  project.json   the edit itself',
    '  media/         the video, audio and images this project uses',
    '  backups/       previous versions of project.json',
    '',
    'Safe: copy, move or back up this whole folder. Open it again from DaliViD',
    'with "Open project folder" and everything reconnects, including the media.',
    '',
    'Avoid: renaming or deleting anything in media/. The project refers to those',
    'files by name. Add media through the app rather than copying it in here —',
    'files placed here by hand are not picked up.',
    '',
  ].join('\n')
  try {
    const fh = await handle.getFileHandle('README.txt', { create: true })
    const w = await fh.createWritable()
    try { await w.write(text) } finally { await w.close() }
  } catch { /* informational only */ }
}
