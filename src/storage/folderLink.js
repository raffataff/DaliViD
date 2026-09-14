/**
 * DaliVid — storage/folderLink.js
 * Connecting the vault to a real folder on the user's disk.
 *
 * ── What this is, and why it is not the thing that was removed ──
 * The old folder feature called `showDirectoryPicker` and stashed the handle in
 * IndexedDB, and that was it: no UI said a folder was connected, and nothing
 * could disconnect it. The grant was real, broad, and invisible.
 *
 * Four things make this different, and all four are requirements rather than
 * polish:
 *
 *   1. ONE folder, picked for this purpose. The UI asks for a folder to keep
 *      DaliViD projects in, not for a directory the app happens to want to read.
 *   2. VISIBLE. `connectedFolderName()` drives an indicator that is on screen
 *      wherever projects are managed.
 *   3. REVOCABLE. `disconnectFolder()` drops the handle and returns the app to
 *      browser storage. That is the part the old design had no answer for.
 *   4. RE-CONSENTED, not silently resumed. A stored handle does NOT carry its
 *      permission across a reload — the browser reports `prompt` and we ask
 *      again from a user gesture. We deliberately do not try to route around
 *      that: one click per session is the entire cost, and it replaces relinking
 *      every file in the project.
 *
 * ── How it plugs in ──
 * The whole vault is already written against a `FileSystemDirectoryHandle`, and
 * OPFS's root and a user-picked directory are the same type. So connecting a
 * folder is not a second backend — it is the same backend pointed somewhere
 * else, via `setRootHandle`. Nothing downstream of the vault changes.
 */

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval'
import { setRootHandle } from './webVault.js'

/**
 * Deliberately NOT `project_folder_*`. Those keys belong to the removed feature
 * and `purgeStoredFolderHandles()` deletes them on every boot — reusing the
 * prefix would have the app delete its own handle at startup.
 */
const HANDLE_KEY = 'dalivid_vault_folder'

let _handle = null
let _name = null
const _listeners = new Set()

/** True when this browser can pick a directory at all (Chromium-only today). */
export function isFolderSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/** The connected folder's name, or null when running on browser storage. */
export function connectedFolderName() {
  return _name
}

/** True when the vault is currently pointed at a real folder. */
export function isFolderConnected() {
  return !!_handle
}

/** Subscribe to connect/disconnect. Returns an unsubscribe function. */
export function onFolderChange(fn) {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

function notify() {
  for (const fn of _listeners) {
    try { fn({ connected: !!_handle, name: _name }) } catch { /* a listener must not break the link */ }
  }
}

/**
 * Point the vault at `handle` (or back at browser storage when null).
 *
 * Switching roots invalidates every cached playback URL, because those URLs
 * reference files in the root we are leaving. `setRootHandle` revokes them; the
 * caller is responsible for reopening a project afterwards.
 */
function activate(handle, name) {
  _handle = handle || null
  _name = handle ? (name || handle.name) : null
  setRootHandle(_handle)
  notify()
}

/**
 * Has the user chosen a folder in a previous session?
 * Cheap — reads the stored handle without touching permissions.
 * @returns {Promise<{name: string}|null>}
 */
export async function savedFolder() {
  if (!isFolderSupported()) return null
  try {
    const handle = await idbGet(HANDLE_KEY)
    return handle ? { name: handle.name } : null
  } catch {
    return null
  }
}

/**
 * Permission on the stored handle, without prompting.
 * @returns {Promise<'granted'|'prompt'|'denied'|'none'>} 'none' = no stored folder
 */
export async function folderPermission() {
  if (!isFolderSupported()) return 'none'
  try {
    const handle = await idbGet(HANDLE_KEY)
    if (!handle) return 'none'
    return await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    return 'none'
  }
}

/**
 * Ask the user to choose the folder DaliViD keeps its projects in.
 *
 * Must be called from a user gesture. `id` makes the browser reopen at the same
 * place next time, and `startIn: 'documents'` keeps the first prompt somewhere
 * sensible rather than wherever the last unrelated download went.
 *
 * @returns {Promise<{name: string}|null>} null if the user cancelled
 */
export async function pickFolder() {
  if (!isFolderSupported()) {
    throw new Error('This browser cannot open a folder. Chrome, Edge and Opera can.')
  }

  let handle
  try {
    handle = await window.showDirectoryPicker({
      id: 'dalivid-projects',
      mode: 'readwrite',
      startIn: 'documents',
    })
  } catch (err) {
    // AbortError is the user closing the dialog — not a failure worth reporting.
    if (err?.name === 'AbortError') return null
    throw err
  }

  // The picker grants for this session; storing the handle only saves the user
  // re-picking, and the browser will still ask on the next page load.
  const state = await handle.requestPermission({ mode: 'readwrite' })
  if (state !== 'granted') {
    throw new Error('Write access to that folder was not granted.')
  }

  await idbSet(HANDLE_KEY, handle)
  activate(handle, handle.name)
  return { name: handle.name }
}

/**
 * Reconnect the folder chosen in a previous session.
 *
 * @param {{ prompt?: boolean }} [opts] — `prompt: true` may show the browser's
 *   permission dialog and therefore MUST be called from a user gesture. With
 *   `prompt: false` this is safe to call on boot: it reconnects silently if the
 *   browser still considers the grant live, and otherwise reports what it needs.
 * @returns {Promise<{connected: boolean, name: string|null, needsPermission: boolean}>}
 */
export async function reconnectFolder({ prompt = false } = {}) {
  if (!isFolderSupported()) return { connected: false, name: null, needsPermission: false }

  let handle
  try {
    handle = await idbGet(HANDLE_KEY)
  } catch {
    handle = null
  }
  if (!handle) return { connected: false, name: null, needsPermission: false }

  let state
  try {
    state = await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    // The handle is stale — the folder was deleted, or the profile moved.
    await idbDel(HANDLE_KEY).catch(() => {})
    return { connected: false, name: null, needsPermission: false }
  }

  if (state === 'prompt' && prompt) {
    try {
      state = await handle.requestPermission({ mode: 'readwrite' })
    } catch {
      state = 'denied'
    }
  }

  if (state !== 'granted') {
    return { connected: false, name: handle.name, needsPermission: state === 'prompt' }
  }

  // Confirm the folder is actually reachable before declaring success — a handle
  // can be granted and still point at a folder that has since been deleted, or
  // that sits on a drive which is not mounted. A read probe is enough: it proves
  // the folder resolves without creating anything in the user's directory.
  try {
    // eslint-disable-next-line no-unused-vars
    for await (const _entry of handle.entries()) break
  } catch {
    return { connected: false, name: handle.name, needsPermission: false }
  }

  activate(handle, handle.name)
  return { connected: true, name: handle.name, needsPermission: false }
}

/**
 * Forget the folder and go back to browser storage.
 *
 * The folder's contents are left completely alone — this revokes the app's
 * access, it does not delete the user's projects.
 */
export async function disconnectFolder() {
  await idbDel(HANDLE_KEY).catch(() => {})
  activate(null, null)
}

/**
 * How many projects are sitting in browser storage.
 *
 * Read straight from OPFS rather than through the vault, so it answers the same
 * whichever root the vault is pointed at — which is the whole point: it is asked
 * *after* connecting a folder, to offer bringing the old projects across.
 *
 * @returns {Promise<number>}
 */
export async function browserProjectCount() {
  if (!navigator.storage?.getDirectory) return 0
  try {
    const opfs = await navigator.storage.getDirectory()
    const projects = await opfs.getDirectoryHandle('projects', { create: false })
    let n = 0
    for await (const [, handle] of projects.entries()) {
      if (handle.kind === 'directory') n++
    }
    return n
  } catch {
    return 0
  }
}

/**
 * Copy everything already in browser storage into the connected folder.
 *
 * Without this, connecting a folder looks exactly like the app losing every
 * project — the list is suddenly empty, because it is reading a different root.
 * That is the single worst first impression this feature could make.
 *
 * Copies handle-to-handle rather than through the vault, so it never depends on
 * which root the vault is currently pointed at, and streams rather than reading
 * whole files into memory. Re-running is cheap and safe: a file already present
 * at the same size is skipped, so an interrupted copy resumes.
 *
 * @returns {Promise<{copied: number, skipped: number, bytes: number}>}
 */
export async function importBrowserProjects() {
  if (!_handle) throw new Error('No folder is connected.')
  if (!navigator.storage?.getDirectory) return { copied: 0, skipped: 0, bytes: 0 }

  const opfs = await navigator.storage.getDirectory()
  const stats = { copied: 0, skipped: 0, bytes: 0 }
  await copyTree(opfs, _handle, stats)
  return stats
}

/** Recursive directory copy, skipping files already present at the same size. */
async function copyTree(fromDir, toDir, stats) {
  for await (const [name, handle] of fromDir.entries()) {
    if (handle.kind === 'directory') {
      const sub = await toDir.getDirectoryHandle(name, { create: true })
      await copyTree(handle, sub, stats)
      continue
    }

    // A `.part` or `.tmp` is an interrupted write, never something to carry over.
    if (name.endsWith('.part') || name.endsWith('.tmp')) continue

    const src = await handle.getFile()
    try {
      const existing = await (await toDir.getFileHandle(name)).getFile()
      if (existing.size === src.size) { stats.skipped++; continue }
    } catch { /* not there yet — copy it */ }

    const dest = await toDir.getFileHandle(name, { create: true })
    const w = await dest.createWritable()
    try {
      // Streams: a multi-GB clip is never held in memory.
      await src.stream().pipeTo(w)
    } catch (err) {
      await w.close().catch(() => {})
      throw err
    }
    stats.copied++
    stats.bytes += src.size
  }
}

/**
 * Write a short note in the folder explaining what it is.
 *
 * Someone finding this folder in a year should not have to guess. Best-effort:
 * failing to write it must never fail the operation that triggered it.
 */
export async function writeFolderReadme() {
  if (!_handle) return
  const text = [
    'DaliViD project folder',
    '======================',
    '',
    'This folder is managed by the DaliViD video editor.',
    '',
    '  projects/   one folder per project: project.json is the edit,',
    '              backups/ holds previous versions of it.',
    '  blobs/      your media, stored under a name derived from the file',
    '              contents. The same clip used in several projects is',
    '              stored once.',
    '',
    'Safe to do: copy, move or back up this whole folder. Open it on another',
    'machine by choosing it again from the app.',
    '',
    'Not safe to do: rename or delete anything inside it. Media is matched by',
    'content, so a renamed file reads as missing. Add media through the app',
    'rather than copying files in here — files dropped in by hand are ignored.',
    '',
  ].join('\n')

  try {
    const fh = await _handle.getFileHandle('README.txt', { create: true })
    const w = await fh.createWritable()
    try { await w.write(text) } finally { await w.close() }
  } catch { /* informational only */ }
}
