/**
 * DaliVid — FolderPicker.jsx
 * The one place the connected project folder is shown and changed.
 *
 * This component IS the visibility and revocability that the old, removed folder
 * feature lacked. It is not decoration: a standing grant over a folder on
 * someone's disk has to be something they can see and take back from inside the
 * app, and this is where both happen.
 *
 * Every action here runs from a real click, because the browser requires a user
 * gesture both to open the picker and to re-grant permission on a stored folder.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  isFolderSupported, isFolderConnected, connectedFolderName, onFolderChange,
  savedFolder, pickFolder, reconnectFolder, disconnectFolder,
  writeFolderReadme, browserProjectCount, importBrowserProjects,
} from '../../storage/index.js'
import { formatBytes } from '../../utils/imageProcessing'
import { addToast } from './Toast'
import './FolderPicker.css'

export default function FolderPicker({ onChanged, compact = false }) {
  const supported = isFolderSupported()
  const [connected, setConnected] = useState(isFolderConnected())
  const [name, setName] = useState(connectedFolderName())
  const [saved, setSaved] = useState(null)      // a folder chosen in a past session
  const [busy, setBusy] = useState(false)
  const [strayCount, setStrayCount] = useState(0)

  // Keep in step when another part of the app connects or disconnects.
  useEffect(() => onFolderChange(({ connected: c, name: n }) => {
    setConnected(c)
    setName(n)
  }), [])

  const refreshState = useCallback(async () => {
    setSaved(await savedFolder())
    setStrayCount(isFolderConnected() ? await browserProjectCount() : 0)
  }, [])

  useEffect(() => { refreshState() }, [refreshState, connected])

  const choose = useCallback(async () => {
    setBusy(true)
    try {
      const picked = await pickFolder()
      if (!picked) return                      // user closed the dialog
      writeFolderReadme()
      addToast({ message: `Projects will be kept in "${picked.name}".`, type: 'success' })
      onChanged?.()
    } catch (err) {
      console.error('[FolderPicker] could not connect a folder:', err)
      addToast({ message: err.message || 'Could not use that folder.', type: 'error', duration: 9000 })
    } finally {
      setBusy(false)
      refreshState()
    }
  }, [onChanged, refreshState])

  const reconnect = useCallback(async () => {
    setBusy(true)
    try {
      const res = await reconnectFolder({ prompt: true })
      if (res.connected) {
        addToast({ message: `Reconnected to "${res.name}".`, type: 'success' })
        onChanged?.()
      } else {
        addToast({
          message: res.needsPermission
            ? 'Access to that folder was not granted, so DaliViD is using browser storage.'
            : 'That folder could not be reached — it may have been moved or deleted. Choose it again.',
          type: 'warning',
          duration: 9000,
        })
      }
    } finally {
      setBusy(false)
      refreshState()
    }
  }, [onChanged, refreshState])

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      await disconnectFolder()
      addToast({
        message: 'Folder disconnected. Your files were left untouched; DaliViD is back on browser storage.',
        type: 'info',
        duration: 8000,
      })
      onChanged?.()
    } finally {
      setBusy(false)
      refreshState()
    }
  }, [onChanged, refreshState])

  const bringAcross = useCallback(async () => {
    setBusy(true)
    try {
      const { copied, skipped, bytes } = await importBrowserProjects()
      addToast({
        message: copied > 0
          ? `Copied ${copied} file${copied === 1 ? '' : 's'} (${formatBytes(bytes)}) into the folder.`
          : `Nothing new to copy — ${skipped} file${skipped === 1 ? '' : 's'} were already there.`,
        type: 'success',
        duration: 8000,
      })
      onChanged?.()
    } catch (err) {
      console.error('[FolderPicker] copy failed:', err)
      addToast({ message: 'Could not copy everything across. Nothing was deleted.', type: 'error', duration: 9000 })
    } finally {
      setBusy(false)
      refreshState()
    }
  }, [onChanged, refreshState])

  if (!supported) {
    return (
      <div className="fp fp--muted">
        <span className="fp__label">Storage</span>
        <span className="fp__value">
          This browser keeps projects in browser storage. Choosing a folder needs Chrome, Edge or Opera.
        </span>
      </div>
    )
  }

  if (connected) {
    return (
      <div className="fp fp--on">
        <span className="fp__label">Project folder</span>
        <div className="fp__body">
          <span className="fp__name" title={name}>{name}</span>
          <div className="fp__actions">
            <button disabled={busy} onClick={choose}>Change…</button>
            <button disabled={busy} onClick={disconnect}>Disconnect</button>
          </div>
        </div>
        {strayCount > 0 && (
          <div className="fp__notice">
            {strayCount} project{strayCount === 1 ? '' : 's'} still in browser storage.
            <button disabled={busy} onClick={bringAcross}>Copy into this folder</button>
          </div>
        )}
        {!compact && (
          <p className="fp__hint">
            Everything for these projects — the edit, your media and the backups — lives in this
            folder. Back it up or move it and the projects go with it.
          </p>
        )}
      </div>
    )
  }

  // Chosen previously, but the browser drops the permission on every page load
  // and will only restore it from a click. That click is the whole cost of this
  // feature, and it replaces relinking every file in the project.
  if (saved) {
    return (
      <div className="fp fp--off">
        <span className="fp__label">Project folder</span>
        <div className="fp__body">
          <span className="fp__name" title={saved.name}>{saved.name} — not connected</span>
          <div className="fp__actions">
            <button className="fp__primary" disabled={busy} onClick={reconnect}>Reconnect</button>
            <button disabled={busy} onClick={disconnect}>Forget</button>
          </div>
        </div>
        {!compact && (
          <p className="fp__hint">
            Browsers ask again each time the app loads. Until you reconnect, DaliViD is using
            browser storage and won&rsquo;t see the projects in that folder.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="fp fp--off">
      <span className="fp__label">Project folder</span>
      <div className="fp__body">
        <span className="fp__name">Using browser storage</span>
        <div className="fp__actions">
          <button className="fp__primary" disabled={busy} onClick={choose}>Choose folder…</button>
        </div>
      </div>
      {!compact && (
        <p className="fp__hint">
          Pick a folder to keep your projects and media in, and they stop depending on this
          browser — you can back them up, and clearing browsing data won&rsquo;t touch them.
        </p>
      )}
    </div>
  )
}
