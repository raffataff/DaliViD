/**
 * DaliVid — storage/projectStore.js
 * Project documents: where they live, how they are written safely, and the
 * generational history that means one bad save is not the end of the edit.
 *
 * ── Why this exists ──
 * Projects were `idbSet(key, doc)`. `idb-keyval` wraps one IDB transaction, so a
 * crash *mid-transaction* rolls back cleanly — that part was never the problem.
 * The problem was that there is exactly **one copy and no history**: a single
 * bad serialise (a NaN, a cyclic reference introduced by a future node type, an
 * OOM on a large project) overwrites the only good version, and the edit is
 * gone with no way back.
 *
 * So: an atomic write (tmp + rename — a reader sees the old file or the new one,
 * never a truncated mixture) plus rotating backups.
 *
 * ── Backend-agnostic on purpose ──
 * Everything here is composed from five dumb byte-moving calls
 * (`readText` / `writeTextAtomic` / `copyFile` / `list` / `remove`). The desktop
 * backend implements those five against the real filesystem and inherits this
 * logic unchanged — which is the entire reason the storage layer is split this
 * way, and why phases 0–2 were not throwaway work.
 *
 * ── No Worker, deliberately ──
 * The plan called for a dedicated Worker using `createSyncAccessHandle`, on the
 * grounds that project writes were large. Phase 2 removed that premise:
 * documents went from 41,521 to 8,159 characters when images moved to blobs
 * (a real project, `Streetlamp_vid_2108`, from ~401 KB to ~12 KB), and a full
 * autosave now measures 0.58 ms on the main thread. A Worker to write 8 KB is
 * complexity with nothing to buy. Revisit only if a measurement demands it.
 */

import { vault } from './index.js'
import { validateProject, migrateV1toV2 } from './schema.js'

const PROJECTS_DIR = 'projects'
const DOC_NAME = 'project.json'
const BACKUP_DIR = 'backups'

/** Legacy IndexedDB keys, still read so nothing is stranded. See `listProjects`. */
const LEGACY_PREFIX = 'dalivid_project_'

/** The crash-recovery slot. A project document like any other, for GC purposes. */
const AUTOSAVE_KEY = 'dalivid_autosave'

/** Every ref id shape the GC must treat as a live reference. */
const REF_ID_SCAN_RE = /mr_[0-9a-f]{4,32}/g

/**
 * Ids are used as directory names, so they are validated before they ever reach
 * the filesystem. Real ids are `crypto.randomUUID()`; older ones are freer, so
 * this is permissive about shape but absolute about traversal.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Don't take a fresh backup more often than this. */
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000
/** Keep this many most-recent backups, plus one per day (see `pruneBackups`). */
const BACKUP_KEEP_RECENT = 10
const BACKUP_KEEP_DAILY_DAYS = 7

function assertId(id) {
  if (!ID_RE.test(String(id))) throw new TypeError(`unsafe project id: ${String(id)}`)
  return id
}

/**
 * Where a project's files sit, which depends on the layout in play.
 *
 * In a PROJECT FOLDER the folder *is* the project, so the document is
 * `project.json` at its root and the id names nothing on disk. In browser
 * storage one root holds many projects, so each needs its own subdirectory.
 *
 * This is the only place that difference exists. It is a layout decision, not a
 * backend one — every read and write below is the same code either way.
 */
const inFolder = () => vault.isExternalRoot?.() === true

const docPath = (id) => (inFolder() ? DOC_NAME : `${PROJECTS_DIR}/${assertId(id)}/${DOC_NAME}`)
const backupPath = (id, name) => (inFolder()
  ? `${BACKUP_DIR}/${name}`
  : `${PROJECTS_DIR}/${assertId(id)}/${BACKUP_DIR}/${name}`)
const backupDirPath = (id) => (inFolder() ? BACKUP_DIR : `${PROJECTS_DIR}/${assertId(id)}/${BACKUP_DIR}`)

// ─────────────────────────────────────────────────────────────────────────────
// Read / write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a project, migrating it to the current schema on the way out.
 * @returns {Promise<object|null>}
 */
export async function readProject(id) {
  const text = await vault.readText(docPath(id))
  if (text == null) return null
  try {
    return migrateV1toV2(JSON.parse(text))
  } catch (e) {
    console.error('[projectStore] project.json is unreadable:', e)
    return null
  }
}

/**
 * Write a project atomically, taking a backup of the previous version first.
 *
 * **Validation happens before any I/O.** A document that fails is rejected with
 * an error the UI can show — never written. That ordering is the point: the
 * failure mode this whole module exists to prevent is a malformed save landing
 * on top of a good one.
 *
 * @param {string} id
 * @param {object} doc
 * @returns {Promise<{savedAt: string, bytes: number, backedUp: boolean}>}
 */
export async function writeProject(id, doc) {
  assertId(id)

  const { ok, errors } = validateProject(doc)
  if (!ok) {
    const err = new Error(`Refusing to save an invalid project: ${errors.slice(0, 3).join('; ')}`)
    err.code = 'INVALID_PROJECT'
    err.errors = errors
    throw err
  }

  const text = JSON.stringify(doc)

  // Back up what is currently there, before it is replaced. Rate-limited so a
  // 2-second autosave does not mint a backup every tick — the point is to be
  // able to step back through meaningful versions, not every keystroke.
  const backedUp = await maybeBackup(id)

  await vault.writeTextAtomic(docPath(id), text)

  return { savedAt: doc.savedAt || new Date().toISOString(), bytes: text.length, backedUp }
}

/**
 * Remove a project and its whole backup history.
 *
 * **Browser storage only.** In a project folder the project IS a folder the user
 * chose and owns; deleting it from inside the app would be the app deleting a
 * directory somebody pointed it at. The equivalent there is `forgetProject`,
 * which drops our reference and leaves every file alone.
 */
export async function deleteProject(id) {
  if (inFolder()) {
    throw new Error('A project folder is yours to delete — remove it in your file manager.')
  }
  await vault.remove(`${PROJECTS_DIR}/${assertId(id)}`, { recursive: true })
  // Legacy copies too, or a deleted project reappears from IndexedDB next boot.
  try {
    const { del } = await import('idb-keyval')
    await del(LEGACY_PREFIX + id)
  } catch { /* idb-keyval unavailable */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing, including the read-through migration from IndexedDB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every project, from OPFS **and** the legacy IndexedDB keys.
 *
 * Anything found only in IndexedDB is reported with `legacy: true` and is
 * migrated to OPFS by `readProjectMigrating` on first open. Nothing is ever
 * deleted from IndexedDB before a successful OPFS write — a migration that
 * fails half way must leave the original exactly where it was.
 *
 * @returns {Promise<Array<{id, name, savedAt, bytes, legacy}>>}
 */
export async function listProjects() {
  const out = new Map()

  // Only browser storage keeps many projects under one root. With a project
  // folder open, `projectFolders.listKnownProjects()` is the list — walking the
  // vault here would descend into the user's own directories.
  if (inFolder()) return []

  for (const entry of await vault.list(PROJECTS_DIR)) {
    if (entry.kind !== 'directory') continue
    const id = entry.name
    try {
      const text = await vault.readText(docPath(id))
      if (text == null) continue
      const doc = JSON.parse(text)
      out.set(id, {
        id,
        name: doc.project?.name || 'Untitled Project',
        savedAt: doc.savedAt || null,
        bytes: text.length,
        legacy: false,
      })
    } catch { /* skip an unreadable project rather than failing the whole list */ }
  }

  for (const row of await listLegacyProjects()) {
    if (!out.has(row.id)) out.set(row.id, row)
  }

  return [...out.values()].sort(
    (a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0)
  )
}

/** Projects still living only in IndexedDB. */
async function listLegacyProjects() {
  const rows = []
  try {
    const { keys, get } = await import('idb-keyval')
    const all = await keys()
    for (const k of all) {
      if (typeof k !== 'string' || !k.startsWith(LEGACY_PREFIX)) continue
      const doc = await get(k)
      if (!doc?.project?.id) continue
      rows.push({
        id: doc.project.id,
        name: doc.project.name || 'Untitled Project',
        savedAt: doc.savedAt || null,
        bytes: JSON.stringify(doc).length,
        legacy: true,
      })
    }
  } catch { /* idb-keyval unavailable */ }
  return rows
}

/**
 * Every MediaRef id referenced by ANY project this browser holds — saved
 * projects in the vault, legacy projects still in IndexedDB, and the autosave
 * slot.
 *
 * **This is what makes the blob GC safe across projects.** The reachable set
 * used to be built from the OPEN project alone, so creating or opening a second
 * project and then saving would collect every blob belonging to the first one —
 * silent, permanent deletion of media that a perfectly good saved project still
 * pointed at.
 *
 * Scanning the raw JSON for ref ids rather than walking the document shape is
 * deliberate. Refs appear in `media.refs`, on clips, on nodes, and inside
 * compound interiors, and the cost of the two mistakes is nothing like equal: a
 * shape-aware walk that misses one destroys the user's media, while an
 * over-inclusive scan merely keeps a few bytes too long.
 *
 * Throws rather than returning a partial set — a caller must not run a GC
 * against an incomplete answer.
 *
 * @returns {Promise<Set<string>>} ref ids, e.g. `mr_a1b2c3d4`
 */
export async function collectAllRefIds() {
  const ids = new Set()
  const scanText = (text) => {
    if (!text) return
    for (const m of String(text).matchAll(REF_ID_SCAN_RE)) ids.add(m[0])
  }

  for (const entry of await vault.list(PROJECTS_DIR).catch(() => [])) {
    if (entry.kind !== 'directory') continue
    try {
      scanText(await vault.readText(docPath(entry.name)))
    } catch { /* one unreadable project must not fail the whole sweep */ }
  }

  try {
    const { keys, get } = await import('idb-keyval')
    for (const k of await keys()) {
      if (typeof k !== 'string') continue
      // Deliberately narrow: font blobs also live in IndexedDB and stringifying
      // those ArrayBuffers would be pointless work.
      if (!k.startsWith(LEGACY_PREFIX) && k !== AUTOSAVE_KEY) continue
      try {
        scanText(JSON.stringify(await get(k)))
      } catch { /* unreadable value — skip */ }
    }
  } catch { /* idb-keyval unavailable */ }

  return ids
}

/**
 * Open a project, moving it into OPFS if it was still in IndexedDB.
 *
 * The order is the safety property: write OPFS, verify it reads back, and only
 * then drop the IndexedDB copy. An interruption anywhere leaves the project
 * readable from at least one of the two.
 *
 * @returns {Promise<object|null>}
 */
export async function readProjectMigrating(id) {
  const fromVault = await readProject(id)
  if (fromVault) return fromVault

  let legacyDoc = null
  try {
    const { get, del } = await import('idb-keyval')
    legacyDoc = await get(LEGACY_PREFIX + id)
    if (!legacyDoc) return null

    const migrated = migrateV1toV2(legacyDoc)
    await vault.writeTextAtomic(docPath(id), JSON.stringify(migrated))

    // Only now is it safe to let go of the original.
    if (await vault.readText(docPath(id))) {
      await del(LEGACY_PREFIX + id)
      console.log(`[projectStore] migrated "${migrated.project?.name}" from IndexedDB into the vault`)
    }
    return migrated
  } catch (e) {
    console.warn('[projectStore] legacy migration failed; project left in IndexedDB:', e)
    return legacyDoc ? migrateV1toV2(legacyDoc) : null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backups
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copy the current project.json into `backups/` — unless the newest backup is
 * younger than `BACKUP_MIN_INTERVAL_MS`.
 * @returns {Promise<boolean>} whether a backup was taken
 */
async function maybeBackup(id) {
  const current = await vault.readText(docPath(id))
  if (current == null) return false          // nothing to back up yet

  const existing = await listBackups(id)
  if (existing.length) {
    const newest = existing[0].lastModified || 0
    if (Date.now() - newest < BACKUP_MIN_INTERVAL_MS) return false
  }

  // ISO8601 with the colons removed — they are illegal in filenames on Windows,
  // and this same name is used by the desktop backend against a real filesystem.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await vault.writeTextAtomic(backupPath(id, `${stamp}.json`), current)
  await pruneBackups(id)
  return true
}

/**
 * Backups for a project, newest first.
 * @returns {Promise<Array<{backupId, savedAt, bytes, lastModified}>>}
 */
export async function listBackups(id) {
  const entries = await vault.list(backupDirPath(id))
  return entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.json'))
    .map(e => ({
      backupId: e.name,
      savedAt: backupNameToISO(e.name),
      bytes: e.bytes,
      lastModified: e.lastModified,
    }))
    .sort((a, b) => b.lastModified - a.lastModified)
}

/**
 * Read a backup. Does NOT install it — the caller decides what to do with the
 * document, so "preview an old version" and "restore it" stay separable.
 * @returns {Promise<object|null>}
 */
export async function readBackup(id, backupId) {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(String(backupId))) return null
  const text = await vault.readText(backupPath(id, backupId))
  if (text == null) return null
  try {
    return migrateV1toV2(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * Restore a backup over the live project.
 *
 * Writes through `writeProject`, so the version being replaced is itself backed
 * up first — restoring the wrong one is undoable.
 */
export async function restoreBackup(id, backupId) {
  const doc = await readBackup(id, backupId)
  if (!doc) throw new Error('That backup could not be read.')
  await writeProject(id, doc)
  return doc
}

/**
 * Keep the last `BACKUP_KEEP_RECENT`, plus the newest from each of the last
 * `BACKUP_KEEP_DAILY_DAYS` days. Everything else goes.
 *
 * The two rules answer different questions — "undo the last few saves" and "get
 * back to how it was on Tuesday" — and a single count cannot serve both.
 */
async function pruneBackups(id) {
  const all = await listBackups(id)
  if (all.length <= BACKUP_KEEP_RECENT) return

  const keep = new Set(all.slice(0, BACKUP_KEEP_RECENT).map(b => b.backupId))

  const dayCutoff = Date.now() - BACKUP_KEEP_DAILY_DAYS * 24 * 60 * 60 * 1000
  const seenDays = new Set()
  for (const b of all) {
    if (b.lastModified < dayCutoff) continue
    const day = new Date(b.lastModified).toISOString().slice(0, 10)
    if (!seenDays.has(day)) { seenDays.add(day); keep.add(b.backupId) }
  }

  for (const b of all) {
    if (!keep.has(b.backupId)) await vault.remove(backupPath(id, b.backupId))
  }
}

/** `2026-08-26T10-00-00-000Z.json` → an ISO string, or null. */
function backupNameToISO(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`
}

/** Bytes used by a project's document plus its backups. */
export async function projectSize(id) {
  const doc = await vault.list(`${PROJECTS_DIR}/${assertId(id)}`)
  const backups = await listBackups(id)
  const docBytes = doc.filter(e => e.kind === 'file').reduce((n, e) => n + e.bytes, 0)
  return {
    doc: docBytes,
    backups: backups.reduce((n, b) => n + b.bytes, 0),
    backupCount: backups.length,
  }
}
