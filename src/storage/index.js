/**
 * DaliVid — storage/index.js
 * The singleton `vault`, and the per-project folders that decide where it points.
 *
 * There is one backend. A project folder is not a second one: the vault is
 * written against a `FileSystemDirectoryHandle`, and OPFS's root and a folder
 * the user picked are the same type. Opening a project points the vault at that
 * project's folder; nothing downstream changes.
 *
 * What the UI is allowed to offer comes from `vault.capabilities()` — **no
 * checks for which storage is in use scattered through components.**
 */

import * as webVault from './webVault.js'

export const vault = webVault

/** True when media can be stored at all — OPFS present, or a folder open. */
export const vaultSupported = webVault.isSupported()

export { VaultQuotaError, VaultUnavailableError } from './webVault.js'

export {
  isFolderSupported,
  currentProjectFolder,
  onProjectFolderChange,
  listKnownProjects,
  forgetProject,
  renameKnownProject,
  pickFolder,
  readProjectDoc,
  createProjectIn,
  openKnownProject,
  adoptFolder,
  closeProject,
  writeFolderReadme,
  moveProjectToFolder,
  listBrowserProjects,
  useBrowserStorage,
  browserStorageStats,
  deleteBrowserProject,
  reclaimBrowserMedia,
} from './projectFolders.js'
