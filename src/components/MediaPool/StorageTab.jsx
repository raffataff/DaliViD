/**
 * DaliVid — StorageTab.jsx
 * What the vault is holding, and how to get space back.
 *
 * Media that survives a reload is media that occupies disk, so the moment the
 * app started copying files it also owed the user a way to see the cost and
 * reclaim it. Without this panel, "why is this site using 8 GB?" is a question
 * only the browser's own settings can answer — and the only remedy it offers is
 * deleting everything, projects included.
 *
 * Two numbers matter and they are deliberately shown separately:
 *   • **In use** — blobs the open project still references.
 *   • **Unused** — blobs nothing references any more. Safe to purge.
 * A blob can be shared by several projects, so "unused" is judged against what
 * is reachable right now, and purging is always an explicit action.
 */

import { useState, useEffect, useCallback } from 'react'
import useMediaStore from '../../store/useMediaStore'
import { vault, vaultSupported } from '../../storage/index.js'
import { collectAllReachableHashes, collectReachableFiles, collectGarbage } from '../../utils/projectMedia'
import { requestPersistentStorage } from '../../utils/projectSerializer'
import { formatBytes } from '../../utils/imageProcessing'
import { addToast } from '../common/Toast'

export default function StorageTab() {
  const refs = useMediaStore(s => s.refs)
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)

  const refresh = useCallback(async () => {
    if (!vaultSupported) { setStats({ unsupported: true }); return }
    try {
      const [usage, blobs] = await Promise.all([vault.usage(), vault.listBlobs()])
      // Across EVERY project, not just the open one. Judged against the open
      // project alone, another project's media reads as "used by no project" and
      // the purge button below cheerfully deletes it.
      // In a project folder, files are identified by NAME and the folder holds
      // one project — so the reachable set is local and exact. In browser storage
      // they are identified by hash and shared, so it has to span every project
      // or a sweep here deletes another one's media.
      const external = !!usage.external
      const reachable = external ? collectReachableFiles() : await collectAllReachableHashes()
      if (!reachable) { setStats({ error: 'could not read saved projects' }); return }

      const byKey = new Map(refs.map(r => [external ? r.file : r.hash, r]))

      const inUse = []
      const unused = []
      for (const b of blobs) {
        const key = external ? b.file : b.hash
        const ref = byKey.get(key)
        const row = {
          ...b,
          key,
          filename: ref?.filename || (external ? b.file : '(not in this project)'),
          kind: ref?.kind || '—',
        }
        ;(reachable.has(key) ? inUse : unused).push(row)
      }
      inUse.sort((a, b) => b.bytes - a.bytes)
      unused.sort((a, b) => b.bytes - a.bytes)

      setStats({
        usage,
        inUse,
        unused,
        inUseBytes: inUse.reduce((n, b) => n + b.bytes, 0),
        unusedBytes: unused.reduce((n, b) => n + b.bytes, 0),
      })
    } catch (err) {
      console.error('[DaliVid] Could not read storage stats:', err)
      setStats({ error: String(err) })
    }
  }, [refs])

  useEffect(() => { refresh() }, [refresh])

  const handlePurge = useCallback(async () => {
    setBusy(true)
    try {
      const { deleted, freed } = await collectGarbage()
      addToast({
        message: deleted > 0
          ? `Freed ${formatBytes(freed)} from ${deleted} unused file${deleted === 1 ? '' : 's'}.`
          : 'Nothing to purge — every stored file is still in use.',
        type: 'success',
      })
      await refresh()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Could not purge unused media.', type: 'error' })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  /**
   * Ask the browser to stop treating this origin's storage as disposable.
   *
   * Chrome decides by engagement heuristics, not by asking the user, so this can
   * legitimately be refused — and the app calls it once on boot anyway, when
   * those heuristics are least likely to be met. Offering it as a button means a
   * user who has since bookmarked or installed the app can get a real answer
   * instead of a permanently pessimistic banner. A refusal says what actually
   * moves the needle rather than "denied".
   */
  const handleRequestPersist = useCallback(async () => {
    setAsking(true)
    try {
      const granted = await requestPersistentStorage()
      if (granted) {
        addToast({ message: 'Persistent storage granted — the browser will keep your projects and media.', type: 'success' })
      } else {
        addToast({
          message: 'The browser declined for now. It usually grants this once the site is bookmarked or installed as an app — try again after that.',
          type: 'warning',
          duration: 11000,
        })
      }
      await refresh()
    } catch (err) {
      console.error(err)
      addToast({ message: 'Could not request persistent storage.', type: 'error' })
    } finally {
      setAsking(false)
    }
  }, [refresh])

  if (!stats) return <div className="media-pool__empty">Reading storage…</div>
  if (stats.unsupported) {
    return (
      <div className="media-pool__empty">
        This browser has no Origin Private File System, so imported media can&rsquo;t be stored
        and won&rsquo;t survive a reload.
      </div>
    )
  }
  if (stats.error) return <div className="media-pool__empty">Couldn&rsquo;t read storage: {stats.error}</div>

  const { usage, inUse, unused, inUseBytes, unusedBytes } = stats
  const quotaPct = usage.quota ? Math.min(100, (usage.total / usage.quota) * 100) : null

  return (
    <div className="storage-tab">
      <div className="storage-tab__summary">
        <div className="storage-tab__stat">
          <span className="storage-tab__stat-value">{formatBytes(inUseBytes)}</span>
          <span className="storage-tab__stat-label">Media in use</span>
        </div>
        <div className="storage-tab__stat">
          <span className="storage-tab__stat-value">{formatBytes(unusedBytes)}</span>
          <span className="storage-tab__stat-label">Unused</span>
        </div>
        <div className="storage-tab__stat">
          <span className="storage-tab__stat-value">
            {usage.quota ? formatBytes(usage.quota - usage.total) : '—'}
          </span>
          <span className="storage-tab__stat-label">{usage.external ? 'Quota n/a' : 'Free'}</span>
        </div>
      </div>

      {quotaPct != null && (
        <div className="storage-tab__meter" title={`${formatBytes(usage.total)} of ${formatBytes(usage.quota)}`}>
          <div className="storage-tab__meter-fill" style={{ width: `${quotaPct}%` }} />
        </div>
      )}

      {/* Persistence is best-effort and a refusal is silent, so say which it is.
          A user whose only copy is evictable deserves to know that. */}
      {/* Folder mode changes what this panel is even talking about: these are
          ordinary files on disk, so eviction and browser quota do not apply and
          offering to "ask the browser to keep them" would be nonsense. */}
      <p className={`storage-tab__note${usage.external || usage.persisted ? '' : ' storage-tab__note--warn'}`}>
        {usage.external
          ? 'These files live in your project folder on disk. The browser can’t clear them, and there’s no quota beyond your free space.'
          : usage.persisted
            ? 'This browser has agreed to keep your projects and media (persistent storage granted).'
            : 'Storage here is best-effort — the browser may clear it under disk pressure. Move this project into a folder (Project Settings) to keep it on disk.'}
      </p>

      {!usage.external && !usage.persisted && (
        <button className="storage-tab__purge" onClick={handleRequestPersist} disabled={asking}>
          {asking ? 'Asking…' : 'Ask the browser to keep this storage'}
        </button>
      )}

      {unused.length > 0 && (
        <button className="storage-tab__purge" onClick={handlePurge} disabled={busy}>
          {busy ? 'Purging…' : `Purge ${unused.length} unused file${unused.length === 1 ? '' : 's'} (${formatBytes(unusedBytes)})`}
        </button>
      )}

      <div className="storage-tab__section">
        <h4>In use ({inUse.length})</h4>
        {inUse.length === 0 && <p className="storage-tab__hint">No stored media yet.</p>}
        {inUse.map(b => (
          <div className="storage-tab__row" key={b.key}>
            <span className="storage-tab__row-name" title={b.filename}>{b.filename}</span>
            <span className="storage-tab__row-kind">{b.kind}</span>
            <span className="storage-tab__row-size">{formatBytes(b.bytes)}</span>
          </div>
        ))}
      </div>

      {unused.length > 0 && (
        <div className="storage-tab__section">
          <h4>Used by no project ({unused.length})</h4>
          {unused.map(b => (
            <div className="storage-tab__row storage-tab__row--unused" key={b.key}>
              <span className="storage-tab__row-name" title={b.key}>{b.filename}</span>
              <span className="storage-tab__row-kind">{b.kind}</span>
              <span className="storage-tab__row-size">{formatBytes(b.bytes)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
