/**
 * DaliVid — projectSerializer.js
 * Save/Load project state to/from IndexedDB via idb-keyval.
 * Also provides JSON export/import for file-based save.
 */

import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval'
import useAppStore from '../store/useAppStore.js'
import useGraphStore from '../store/useGraphStore.js'
import useTimelineStore from '../store/useTimelineStore.js'

const PROJECT_PREFIX = 'dalivid_project_'
const AUTOSAVE_KEY = 'dalivid_autosave'

/**
 * Serialize the entire project state into a plain object.
 * @param {Function} getAppStore
 * @param {Function} getGraphStore
 * @param {Function} getTimelineStore
 * @returns {object}
 */
export function serializeProject(getAppStore, getGraphStore, getTimelineStore) {
  const app = getAppStore()
  const graph = getGraphStore()
  const timeline = getTimelineStore()

  return {
    version: 1,
    savedAt: new Date().toISOString(),

    project: {
      name: app.projectName,
      id: app.projectId,
      fps: app.fps,
      resolution: { ...app.resolution },
      colorSpace: app.colorSpace,
    },

    timeline: {
      tracks: timeline.tracks.map(t => ({
        id: t.id,
        name: t.name,
        type: t.type,
        muted: t.muted,
        solo: t.solo,
        locked: t.locked,
        blendMode: t.blendMode,
        opacity: t.opacity,
        color: t.color,
        zOrder: t.zOrder,
      })),
      clips: timeline.clips.map(c => ({
        id: c.id,
        trackId: c.trackId,
        filename: c.filename,
        fileType: c.fileType,
        timelineStart: c.timelineStart,
        timelineEnd: c.timelineEnd,
        sourceStart: c.sourceStart,
        sourceEnd: c.sourceEnd,
        speed: c.speed,
        opacity: c.opacity,
        blendMode: c.blendMode,
        transform: { ...c.transform },
        metadata: { ...c.metadata },
        hasEffects: c.hasEffects,
        // Note: fileUrl (blob URL) is NOT saved — user must re-import files
      })),
      markers: timeline.markers.map(m => ({ ...m })),
      inPoint: timeline.inPoint,
      outPoint: timeline.outPoint,
      keyframes: timeline.keyframes.map(k => ({
        ...k,
        keys: k.keys.map(key => ({ ...key })),
      })),
    },

    graph: {
      masterGraph: {
        nodes: graph.masterGraph.nodes.map(n => ({
          id: n.id,
          type: n.type,
          name: n.name,
          position: { ...n.position },
          params: { ...n.params },
          shaderCode: n.shaderCode,
          customShaderSource: n.customShaderSource,
          bypassed: n.bypassed,
          locked: n.locked,
          audioBindings: { ...n.audioBindings },
        })),
        edges: graph.masterGraph.edges.map(e => ({ ...e })),
        tapPointNodeId: graph.masterGraph.tapPointNodeId,
      },
      clipGraphs: Object.fromEntries(
        Object.entries(graph.clipGraphs).map(([clipId, g]) => [
          clipId,
          {
            nodes: g.nodes.map(n => ({
              id: n.id,
              type: n.type,
              name: n.name,
              position: { ...n.position },
              params: { ...n.params },
              shaderCode: n.shaderCode,
              customShaderSource: n.customShaderSource,
              bypassed: n.bypassed,
              locked: n.locked,
              audioBindings: n.audioBindings ? { ...n.audioBindings } : {},
            })),
            edges: g.edges.map(e => ({ ...e })),
            tapPointNodeId: g.tapPointNodeId,
          }
        ])
      ),
      compoundLibrary: graph.compoundLibrary.map(c => ({
        id: c.id,
        name: c.name,
        version: c.version,
        subGraph: c.subGraph,
        exposedParams: c.exposedParams,
      })),
    },

    ui: {
      graphLevel: app.graphLevel,
      graphClipId: app.graphClipId,
      graphCompoundPath: [...app.graphCompoundPath],
      editMode: app.editMode,
    },
  }
}

/**
 * Deserialize a project into store actions.
 * @param {object} data — serialized project
 * @param {Function} getAppStore
 * @param {Function} getGraphStore
 * @param {Function} getTimelineStore
 */
export function deserializeProject(data, getAppStore) {
  if (!data || data.version !== 1) {
    console.error('[ProjectSerializer] Unsupported project version:', data?.version)
    return false
  }

  const app = getAppStore()

  // Restore project settings
  if (data.project) {
    app.setProjectSettings({
      projectName: data.project.name,
      projectId: data.project.id,
      fps: data.project.fps,
      resolution: data.project.resolution,
      colorSpace: data.project.colorSpace,
    })
  }

  // Restore timeline — need to set state directly via Zustand
  if (data.timeline) {
    useTimelineStore.setState({
      tracks: data.timeline.tracks || [],
      clips: data.timeline.clips || [],
      markers: data.timeline.markers || [],
      inPoint: data.timeline.inPoint,
      outPoint: data.timeline.outPoint,
      keyframes: data.timeline.keyframes || [],
    })
  }

  // Restore graph
  if (data.graph) {
    useGraphStore.setState({
      masterGraph: {
        nodes: data.graph.masterGraph?.nodes || [],
        edges: data.graph.masterGraph?.edges || [],
        tapPointNodeId: data.graph.masterGraph?.tapPointNodeId || null,
        compiledChain: [],
        compileErrors: [],
      },
      clipGraphs: Object.fromEntries(
        Object.entries(data.graph.clipGraphs || {}).map(([clipId, g]) => [
          clipId,
          {
            nodes: g.nodes || [],
            edges: g.edges || [],
            tapPointNodeId: g.tapPointNodeId || null,
            compiledChain: [],
            compileErrors: [],
          }
        ])
      ),
      compoundLibrary: data.graph.compoundLibrary || [],
    })
  }

  // Restore UI state
  if (data.ui) {
    useAppStore.setState({
      graphLevel: data.ui.graphLevel || 'master',
      graphClipId: data.ui.graphClipId || null,
      graphCompoundPath: data.ui.graphCompoundPath || [],
      editMode: data.ui.editMode || 'overwrite',
    })
  }

  return true
}



/**
 * Save project to IndexedDB.
 */
export async function saveProject(getAppStore, getGraphStore, getTimelineStore) {
  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)
  const key = `${PROJECT_PREFIX}${data.project.id}`
  await idbSet(key, data)
  console.log('[ProjectSerializer] Saved project:', data.project.name)
  return data
}

/**
 * Autosave to IndexedDB.
 */
export async function autosave(getAppStore, getGraphStore, getTimelineStore) {
  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)
  await idbSet(AUTOSAVE_KEY, data)
  return data
}

/**
 * Load project from IndexedDB by ID.
 */
export async function loadProject(projectId) {
  const key = `${PROJECT_PREFIX}${projectId}`
  const data = await idbGet(key)
  return data || null
}

/**
 * Load autosave.
 */
export async function loadAutosave() {
  return await idbGet(AUTOSAVE_KEY) || null
}

/**
 * List all saved projects.
 */
export async function listProjects() {
  const allKeys = await idbKeys()
  const projectKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(PROJECT_PREFIX))
  const projects = []
  for (const key of projectKeys) {
    const data = await idbGet(key)
    if (data) {
      projects.push({
        id: data.project.id,
        name: data.project.name,
        savedAt: data.savedAt,
      })
    }
  }
  return projects.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}

/**
 * Delete a saved project.
 */
export async function deleteProject(projectId) {
  const key = `${PROJECT_PREFIX}${projectId}`
  await idbDel(key)
}

/**
 * Export project as a JSON file download.
 */
export function exportProjectAsJSON(getAppStore, getGraphStore, getTimelineStore) {
  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${data.project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.dalivid.json`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Import project from a JSON file.
 * @returns {Promise<object|null>}
 */
export function importProjectFromJSON() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.dalivid.json'
    input.onchange = (e) => {
      const file = e.target.files[0]
      if (!file) { resolve(null); return }

      const reader = new FileReader()
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result)
          resolve(data)
        } catch (err) {
          console.error('[ProjectSerializer] Invalid JSON:', err)
          resolve(null)
        }
      }
      reader.readAsText(file)
    }
    input.click()
  })
}

/**
 * Copy a file object to a directory's subfolder (e.g. 'media' or 'audio')
 */
export async function copyFileToProjectFolder(projectDirHandle, file, folderName) {
  try {
    const subDirHandle = await projectDirHandle.getDirectoryHandle(folderName, { create: true })
    const fileHandle = await subDirHandle.getFileHandle(file.name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(file)
    await writable.close()
    console.log(`[ProjectSerializer] Copied ${file.name} to project folder /${folderName}`)
    return fileHandle
  } catch (err) {
    console.error('[ProjectSerializer] Failed to copy file to folder:', err)
    throw err
  }
}

/**
 * Save project.json directly to the project folder.
 */
export async function saveProjectToFolder(projectDirHandle, getAppStore, getGraphStore, getTimelineStore) {
  const data = serializeProject(getAppStore, getGraphStore, getTimelineStore)
  
  // Also ensure folder structure is initialized
  await projectDirHandle.getDirectoryHandle('media', { create: true })
  await projectDirHandle.getDirectoryHandle('audio', { create: true })
  await projectDirHandle.getDirectoryHandle('renders', { create: true })

  const fileHandle = await projectDirHandle.getFileHandle('project.json', { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(data, null, 2))
  await writable.close()
  
  console.log('[ProjectSerializer] Saved project to folder:', data.project.name)
  return data
}

/**
 * Load project.json from the project folder.
 */
export async function loadProjectFromFolder(projectDirHandle) {
  try {
    const fileHandle = await projectDirHandle.getFileHandle('project.json')
    const file = await fileHandle.getFile()
    const text = await file.text()
    return JSON.parse(text)
  } catch (err) {
    console.error('[ProjectSerializer] Failed to load project.json from folder:', err)
    return null
  }
}

/**
 * Scan timeline clips, read the local files from the project folder,
 * generate Blob URLs, and update the clips' fileUrl property in the timeline store.
 */
export async function restoreMediaFilesFromFolder(projectDirHandle, clips, updateClipAction) {
  let restoredCount = 0
  for (const clip of clips) {
    // If the fileUrl is missing (or is a stale blob URL from a previous session), restore it!
    const folderName = clip.fileType === 'audio' ? 'audio' : 'media'
    try {
      const subDirHandle = await projectDirHandle.getDirectoryHandle(folderName)
      const fileHandle = await subDirHandle.getFileHandle(clip.filename)
      const file = await fileHandle.getFile()
      const url = URL.createObjectURL(file)
      
      // Update clip url in store
      updateClipAction(clip.id, { fileUrl: url })
      
      restoredCount++
    } catch (err) {
      console.warn(`[ProjectSerializer] Could not restore file ${clip.filename} from ${folderName} folder:`, err)
    }
  }
  console.log(`[ProjectSerializer] Restored ${restoredCount} media files from folder.`)
}

/**
 * Verify and request directory permission if needed.
 */
export async function verifyDirectoryPermission(fileHandle, readWrite = true) {
  const options = {}
  if (readWrite) {
    options.mode = 'readwrite'
  }
  try {
    // Check if permission was already granted
    if ((await fileHandle.queryPermission(options)) === 'granted') {
      return true
    }
    // Request permission
    if ((await fileHandle.requestPermission(options)) === 'granted') {
      return true
    }
  } catch (err) {
    console.error('[ProjectSerializer] Permission verification failed:', err)
  }
  return false
}

/**
 * Save directory handle to IndexedDB
 */
export async function saveProjectFolderHandle(projectId, handle) {
  await idbSet(`project_folder_${projectId}`, handle)
}

/**
 * Load directory handle from IndexedDB
 */
export async function loadProjectFolderHandle(projectId) {
  return await idbGet(`project_folder_${projectId}`)
}
