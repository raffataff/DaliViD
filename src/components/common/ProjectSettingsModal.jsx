/**
 * DaliVid — ProjectSettingsModal.jsx
 * Everything that belongs to THIS project: what it is called, how it renders,
 * where it lives, and how to step back through its saved versions.
 *
 * Storage lives here rather than in the Projects window on purpose. A folder is
 * a property of one project — showing it above a list of all projects implied
 * they shared it, which is not the model. Here it sits beside the name and the
 * resolution, which is what it actually is: a setting for the open project.
 */

import { useState, useEffect, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import useTimelineStore from '../../store/useTimelineStore'
import useMediaStore from '../../store/useMediaStore'
import { saveProject } from '../../utils/projectSerializer'
import {
  currentProjectFolder, onProjectFolderChange, renameKnownProject,
  isFolderSupported, pickFolder, readProjectDoc, createProjectIn, moveProjectToFolder,
} from '../../storage/index.js'
import { vault } from '../../storage/index.js'
import { listBackups, restoreBackup } from '../../storage/projectStore'
import { collectGarbage } from '../../utils/projectMedia'
import { formatBytes } from '../../utils/imageProcessing'
import { IconClose } from './Icons'
import { addToast } from './Toast'
import './ProjectSettingsModal.css'

const RESOLUTIONS = [
  ['1280x720', '720p (1280x720)'],
  ['1920x1080', '1080p (1920x1080)'],
  ['2560x1440', '1440p (2560x1440)'],
  ['3840x2160', '4K (3840x2160)'],
]

function when(iso) {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  if (Number.isNaN(+d)) return 'unknown'
  const mins = Math.round((Date.now() - d) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleString()
}

export default function ProjectSettingsModal() {
  const isOpen = useAppStore(s => s.projectSettingsOpen)
  const setOpen = useAppStore(s => s.setProjectSettingsOpen)

  const projectName = useAppStore(s => s.projectName)
  const projectId = useAppStore(s => s.projectId)
  const resolution = useAppStore(s => s.resolution)
  const fps = useAppStore(s => s.fps)

  const [name, setName] = useState(projectName)
  const [folder, setFolder] = useState(currentProjectFolder())
  const [backups, setBackups] = useState([])
  const [mediaBytes, setMediaBytes] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => onProjectFolderChange(setFolder), [])
  useEffect(() => { if (isOpen) setName(projectName) }, [isOpen, projectName])

  const refresh = useCallback(async () => {
    if (!isOpen) return
    try { setBackups(await listBackups(projectId)) } catch { setBackups([]) }
    try {
      const blobs = await vault.listBlobs()
      setMediaBytes(blobs.reduce((n, b) => n + b.bytes, 0))
    } catch { setMediaBytes(null) }
  }, [isOpen, projectId])

  useEffect(() => { refresh() }, [refresh])

  const close = useCallback(() => setOpen(false), [setOpen])

  // ── Project fields ────────────────────────────────────────────────────────

  const commitName = useCallback(async () => {
    const next = name.trim() || 'Untitled Project'
    if (next === projectName) return
    useAppStore.getState().setProjectName(next)
    await renameKnownProject(projectId, next)
  }, [name, projectName, projectId])

  // `setResolution` takes two arguments, not an object — passing a `{width,height}`
  // silently sets `resolution.width` to the object and blanks the render size.
  const setResolution = useCallback((str) => {
    const [w, h] = str.split('x').map(n => parseInt(n, 10))
    if (Number.isFinite(w) && Number.isFinite(h)) useAppStore.getState().setResolution(w, h)
  }, [])

  // ── Storage ───────────────────────────────────────────────────────────────

  /**
   * Move this project into a folder — the route out of browser storage for
   * anything made before folders existed.
   *
   * Order is the safety property: copy the media first, stamp the refs, then
   * write project.json into the new folder. Nothing in browser storage is
   * deleted, so an interruption anywhere leaves the original working.
   */
  const moveToFolder = useCallback(async () => {
    setBusy(true)
    try {
      const handle = await pickFolder()
      if (!handle) return

      const existing = await readProjectDoc(handle)
      if (existing) {
        addToast({
          message: `That folder already holds “${existing.project?.name || 'a project'}”. Pick an empty one.`,
          type: 'warning',
          duration: 9000,
        })
        return
      }

      const refs = useMediaStore.getState().refs
      const written = await moveProjectToFolder(handle, refs)

      // The refs now name files in the new folder, not hashes in browser storage.
      useMediaStore.setState(state => ({
        refs: state.refs.map(r => (written.has(r.id) ? { ...r, file: written.get(r.id) } : r)),
      }))

      await createProjectIn(handle, { id: projectId, name: projectName })
      await saveProject(useAppStore.getState, useGraphStore.getState, useTimelineStore.getState)

      // Re-resolve playback against the new root before anything tries to play.
      await useMediaStore.getState().hydrate(useMediaStore.getState().refs)

      addToast({
        message: `Moved into "${handle.name}" — ${written.size} media file${written.size === 1 ? '' : 's'} copied. The browser-storage copy was left alone.`,
        type: 'success',
        duration: 10000,
      })
      await refresh()
    } catch (err) {
      console.error('[ProjectSettings] move failed:', err)
      addToast({ message: err.message || 'Could not move this project.', type: 'error', duration: 9000 })
    } finally {
      setBusy(false)
    }
  }, [projectId, projectName, refresh])

  const purge = useCallback(async () => {
    setBusy(true)
    try {
      const { deleted, freed } = await collectGarbage()
      addToast({
        message: deleted > 0
          ? `Removed ${deleted} unused file${deleted === 1 ? '' : 's'} (${formatBytes(freed)}) from this project's media folder.`
          : 'Nothing to remove — every file in this project is in use.',
        type: 'success',
      })
      await refresh()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Could not tidy the media folder.', type: 'error' })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const doRestore = useCallback(async (backupId) => {
    setBusy(true)
    try {
      // restoreBackup writes through writeProject, so the version being replaced
      // is itself backed up first — restoring the wrong one is undoable.
      await restoreBackup(projectId, backupId)
      addToast({ message: 'Backup restored. Reopen the project to see it.', type: 'success', duration: 8000 })
      await refresh()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Could not restore that backup.', type: 'error' })
    } finally {
      setBusy(false)
    }
  }, [projectId, refresh])

  if (!isOpen) return null

  const resStr = `${resolution.width}x${resolution.height}`
  const custom = !RESOLUTIONS.some(([v]) => v === resStr)

  return (
    <div className="psm__backdrop" onClick={close}>
      <div className="psm" onClick={e => e.stopPropagation()}>
        <div className="psm__head">
          <h2>Project Settings</h2>
          <button className="psm__close" onClick={close} aria-label="Close"><IconClose /></button>
        </div>

        <div className="psm__body">
          <section className="psm__section">
            <h3>Project</h3>

            <label className="psm__field">
              <span>Name</span>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
              />
            </label>

            <div className="psm__row">
              <label className="psm__field">
                <span>Resolution</span>
                <select value={custom ? '' : resStr} onChange={e => setResolution(e.target.value)}>
                  {custom && <option value="">{resStr} (custom)</option>}
                  {RESOLUTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </label>

              <label className="psm__field">
                <span>Frame Rate</span>
                <select value={fps} onChange={e => useAppStore.getState().setFps(Number(e.target.value))}>
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </label>
            </div>
            <p className="psm__hint">
              Changing resolution or frame rate affects how this project renders and exports from
              now on. It doesn&rsquo;t re-render anything already exported.
            </p>
          </section>

          <section className="psm__section">
            <h3>Storage</h3>

            {folder ? (
              <>
                <div className="psm__folder">
                  <span className="psm__folder-name" title={folder.folderName}>{folder.folderName}</span>
                  <span className="psm__folder-size">
                    {mediaBytes == null ? '' : `${formatBytes(mediaBytes)} of media`}
                  </span>
                </div>
                <p className="psm__hint">
                  This project&rsquo;s edit, media and backups all live in that folder. Back it up or
                  move it and the whole project goes with it. Browsers ask for access again each
                  time the app loads — that&rsquo;s one click when you open the project.
                </p>
                <button className="psm__btn" disabled={busy} onClick={purge}>
                  Tidy unused media
                </button>
              </>
            ) : (
              <>
                <p className="psm__warn">
                  This project is in browser storage, not a folder. It works, but clearing your
                  browsing data would take it with it, and you can&rsquo;t back it up or move it to
                  another machine.
                </p>
                <button
                  className="psm__btn psm__btn--primary"
                  disabled={busy || !isFolderSupported()}
                  onClick={moveToFolder}
                >
                  {busy ? 'Moving…' : 'Move into a folder…'}
                </button>
                {!isFolderSupported() && (
                  <p className="psm__hint">Moving to a folder needs Chrome, Edge or Opera.</p>
                )}
              </>
            )}
          </section>

          <section className="psm__section">
            <h3>Version history</h3>
            {backups.length === 0 && (
              <p className="psm__hint">
                No saved versions yet. One is kept each time you save, at most every few minutes.
              </p>
            )}
            {backups.map(b => (
              <div className="psm__backup" key={b.backupId}>
                <span>{when(b.savedAt)}</span>
                <span className="psm__backup-size">{formatBytes(b.bytes)}</span>
                <button disabled={busy} onClick={() => doRestore(b.backupId)}>Restore</button>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
