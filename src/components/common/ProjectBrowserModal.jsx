/**
 * DaliVid — ProjectBrowserModal.jsx
 * The front door: which project to work on.
 *
 * Deliberately just a list of projects. Where each one is stored is a property
 * OF that project and belongs in Project Settings — storage controls here made
 * the window about the app's plumbing rather than about the work, and a folder
 * shown at this level implies every project shares it, which is not the model.
 *
 * Three ways in, and no others:
 *   • a project this browser has opened before   (the list)
 *   • a project folder it has not                ("Open project folder…")
 *   • a new one                                  ("New Project")
 */

import { useState, useEffect, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import useMediaStore from '../../store/useMediaStore'
import { deserializeProject, saveProject, loadProject } from '../../utils/projectSerializer'
import {
  isFolderSupported, listKnownProjects, openKnownProject, forgetProject,
  pickFolder, adoptFolder, listBrowserProjects, useBrowserStorage as switchToBrowserStorage,
  browserStorageStats, deleteBrowserProject, reclaimBrowserMedia,
} from '../../storage/index.js'
import { formatBytes } from '../../utils/imageProcessing'
import { restoreProjectMedia } from '../../utils/projectMedia'
import { addToast } from './Toast'
import './ProjectBrowserModal.css'

function when(ms) {
  if (!ms) return 'never opened'
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`
  return new Date(ms).toLocaleDateString()
}

export default function ProjectBrowserModal({ onClose }) {
  const [rows, setRows] = useState(null)
  const [legacy, setLegacy] = useState([])
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmForget, setConfirmForget] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmClearAll, setConfirmClearAll] = useState(false)

  const currentId = useAppStore(s => s.projectId)
  const setNewProjectModalOpen = useAppStore(s => s.setNewProjectModalOpen)
  const supported = isFolderSupported()

  const refresh = useCallback(async () => {
    setRows(await listKnownProjects())
    setLegacy(await listBrowserProjects())
    setStats(await browserStorageStats())
    setConfirmDelete(null)
    setConfirmClearAll(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /** Save whatever is open before leaving it — switching must not lose work. */
  const saveCurrent = useCallback(async () => {
    if (useTimelineStore.getState().clips.length === 0) return
    try {
      await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)
    } catch (err) {
      console.warn('[ProjectBrowser] could not save the open project first:', err)
    }
  }, [])

  /**
   * Put a loaded document on screen. Shared by every route in, so they cannot
   * drift — the order matters, and getting it wrong is what makes a project look
   * like it opened empty.
   */
  const applyDoc = useCallback(async (doc, label) => {
    // The pool belongs to the outgoing project. Safe to clear here: the vault
    // root has already moved and nothing can still be playing from the old one.
    useMediaStore.getState().clear()

    if (!deserializeProject(doc, useAppStore.getState)) {
      addToast({ message: 'That project is in an unsupported format.', type: 'error' })
      return false
    }
    const { missing } = await restoreProjectMedia(doc)
    useAppStore.getState().markSaved()

    addToast({
      message: missing > 0
        ? `Opened "${label}" — ${missing} media file${missing === 1 ? '' : 's'} missing from its folder.`
        : `Opened "${label}"`,
      type: missing > 0 ? 'warning' : 'success',
    })
    return true
  }, [])

  const open = useCallback(async (id) => {
    if (id === currentId) { onClose?.(); return }
    setBusy(true)
    try {
      await saveCurrent()
      const res = await openKnownProject(id, { prompt: true })
      if (!res.ok) {
        addToast({
          message: res.reason === 'denied'
            ? 'Access to that project’s folder was not granted.'
            : res.reason === 'missing-doc'
              ? 'No project.json in that folder — it may have been moved or emptied.'
              : 'That project’s folder could not be reached. Use “Open project folder…” to point at it again.',
          type: 'warning',
          duration: 9000,
        })
        return
      }
      if (await applyDoc(res.doc, res.name)) onClose?.()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to open that project.', type: 'error' })
    } finally {
      setBusy(false)
      refresh()
    }
  }, [currentId, onClose, saveCurrent, applyDoc, refresh])

  /** Adopt a folder this browser has never seen — or has forgotten. */
  const openFolder = useCallback(async () => {
    setBusy(true)
    try {
      const handle = await pickFolder()
      if (!handle) return
      await saveCurrent()
      const res = await adoptFolder(handle)
      if (!res.ok) {
        addToast({
          message: 'That folder doesn’t hold a DaliViD project — there’s no project.json in it.',
          type: 'warning',
          duration: 9000,
        })
        return
      }
      if (await applyDoc(res.doc, res.name)) onClose?.()
    } catch (err) {
      console.error(err)
      addToast({ message: err.message || 'Could not open that folder.', type: 'error' })
    } finally {
      setBusy(false)
      refresh()
    }
  }, [onClose, saveCurrent, applyDoc, refresh])

  /**
   * Open a project from before folders existed.
   *
   * The vault has to go back to browser storage first, or its media — which is
   * in OPFS under content hashes — resolves against the wrong root and every
   * clip reports missing.
   */
  const openLegacy = useCallback(async (id, label) => {
    setBusy(true)
    try {
      await saveCurrent()
      await switchToBrowserStorage()
      const doc = await loadProject(id)
      if (!doc) {
        addToast({ message: 'That project could not be read.', type: 'error' })
        return
      }
      if (await applyDoc(doc, doc.project?.name || label)) {
        addToast({
          message: 'This project is still in browser storage. Project Settings → Move into a folder… puts it somewhere you can back up.',
          type: 'info',
          duration: 11000,
        })
        onClose?.()
      }
    } catch (err) {
      console.error(err)
      addToast({ message: 'Failed to open that project.', type: 'error' })
    } finally {
      setBusy(false)
      refresh()
    }
  }, [saveCurrent, applyDoc, onClose, refresh])

  /**
   * Permanently delete one pre-folder project, then collect its media.
   *
   * Irreversible, so it is two clicks and never offered for the project that is
   * currently open — deleting the thing you are editing is a state with no good
   * answer. Folder projects are untouched by any of this.
   */
  const deleteLegacy = useCallback(async (id) => {
    setBusy(true)
    try {
      await deleteBrowserProject(id)
      const { deleted, freed } = await reclaimBrowserMedia()
      addToast({
        message: deleted > 0
          ? `Project deleted, and ${formatBytes(freed)} of media it was the last user of.`
          : 'Project deleted.',
        type: 'success',
      })
      await refresh()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Could not delete that project.', type: 'error' })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  /** Delete every pre-folder project at once. The end of the migration. */
  const clearAllLegacy = useCallback(async () => {
    setBusy(true)
    try {
      const targets = legacy.filter(r => r.id !== currentId)
      for (const r of targets) await deleteBrowserProject(r.id)
      const { deleted, freed } = await reclaimBrowserMedia()
      addToast({
        message: `Deleted ${targets.length} project${targets.length === 1 ? '' : 's'}` +
          (deleted > 0 ? `, freeing ${formatBytes(freed)} of media.` : '.'),
        type: 'success',
        duration: 9000,
      })
      await refresh()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Could not clear browser storage.', type: 'error' })
    } finally {
      setBusy(false)
    }
  }, [legacy, currentId, refresh])

  const startNewProject = useCallback(() => {
    onClose?.()
    setNewProjectModalOpen(true)
  }, [onClose, setNewProjectModalOpen])

  const reallyForget = useCallback(async (id) => {
    setBusy(true)
    try {
      await forgetProject(id)
      addToast({
        message: 'Removed from this list. The folder and everything in it were left untouched.',
        type: 'info',
        duration: 8000,
      })
      setConfirmForget(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  return (
    <div className="pbm__backdrop" onClick={onClose}>
      <div className="pbm" onClick={e => e.stopPropagation()}>
        <div className="pbm__head">
          <h2>Projects</h2>
          <div className="pbm__head-actions">
            <button className="pbm__ghost" disabled={busy || !supported} onClick={openFolder}>
              Open project folder…
            </button>
            <button className="pbm__new" disabled={busy || !supported} onClick={startNewProject}>
              New Project
            </button>
            <button className="pbm__close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {/* ONE scrolling body. The browser-storage section used to sit outside
            the scroll container as a sibling of the list, so it grew without
            limit: it overflowed the modal's max height AND squeezed the folder
            list — flex:1 against an unbounded sibling — down to a sliver, which
            looked exactly like "my folder projects aren't listed". */}
        <div className="pbm__body">
          {!supported && (
            <p className="pbm__empty">
              DaliViD keeps each project in a folder on your computer, which needs Chrome, Edge or
              Opera. This browser can&rsquo;t open one.
            </p>
          )}

          {supported && rows === null && <p className="pbm__empty">Loading…</p>}
          {supported && rows?.length === 0 && legacy.length === 0 && (
            <p className="pbm__empty">
              No projects yet. Create one, or point DaliViD at a folder that already holds a project.
            </p>
          )}

          {rows?.length > 0 && (
            <div className="pbm__list">
              {rows.map(r => {
                const isCurrent = r.id === currentId
                return (
                  <div key={r.id} className={`pbm__row${isCurrent ? ' pbm__row--current' : ''}`}>
                    <button
                      className="pbm__row-main"
                      disabled={busy}
                      onClick={() => open(r.id)}
                      title={`Open ${r.name}`}
                    >
                      <span className="pbm__row-name">
                        {r.name}
                        {isCurrent && <span className="pbm__badge">open</span>}
                      </span>
                      <span className="pbm__row-meta">
                        {when(r.lastOpened)}{r.folderName ? ` · ${r.folderName}` : ''}
                      </span>
                    </button>

                    <div className="pbm__row-actions">
                      {confirmForget === r.id ? (
                        <button className="pbm__danger" disabled={busy} onClick={() => reallyForget(r.id)}>
                          Remove from list?
                        </button>
                      ) : (
                        <button disabled={busy} onClick={() => setConfirmForget(r.id)}>Remove</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {legacy.length > 0 && (
            <div className="pbm__legacy">
              <div className="pbm__legacy-head">
                <h3>In browser storage</h3>
                {confirmClearAll ? (
                  <div className="pbm__confirm">
                    <span>Delete {legacy.filter(r => r.id !== currentId).length} project(s) for good?</span>
                    <button className="pbm__danger" disabled={busy} onClick={clearAllLegacy}>
                      Yes, delete
                    </button>
                    <button disabled={busy} onClick={() => setConfirmClearAll(false)}>Cancel</button>
                  </div>
                ) : (
                  <button
                    className="pbm__danger"
                    disabled={busy}
                    onClick={() => setConfirmClearAll(true)}
                  >
                    Delete all{stats?.bytes ? ` (${formatBytes(stats.bytes)})` : ''}
                  </button>
                )}
              </div>

              <p className="pbm__hint">
                Made before projects had folders. They still work — open one and use
                <strong> Project Settings → Move into a folder…</strong> to give it a home on disk.
                Deleting is permanent and only ever touches browser storage; projects in folders
                are never affected.
              </p>

              <div className="pbm__list">
                {legacy.map(r => {
                  const isCurrent = r.id === currentId
                  return (
                    <div className="pbm__row" key={r.id}>
                      <button
                        className="pbm__row-main"
                        disabled={busy}
                        onClick={() => openLegacy(r.id, r.name)}
                        title={`Open ${r.name}`}
                      >
                        <span className="pbm__row-name">
                          {r.name}
                          {isCurrent && <span className="pbm__badge">open</span>}
                        </span>
                        <span className="pbm__row-meta">browser storage</span>
                      </button>

                      <div className="pbm__row-actions">
                        {isCurrent ? (
                          <button disabled title="Close this project before deleting it">Delete</button>
                        ) : confirmDelete === r.id ? (
                          <button className="pbm__danger" disabled={busy} onClick={() => deleteLegacy(r.id)}>
                            Delete for good?
                          </button>
                        ) : (
                          <button disabled={busy} onClick={() => setConfirmDelete(r.id)}>Delete</button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <p className="pbm__foot">
          Removing a project only takes it off this list — its folder and files are never touched.
          Where a project is stored lives in <strong>Project Settings</strong>.
        </p>
      </div>
    </div>
  )
}
