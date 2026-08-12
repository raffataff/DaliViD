/**
 * DaliVid — fontImport.js
 * Turning files the user chose into registered fonts, with the reporting.
 *
 * Split out from the picker and the Media Pool tab because both need it and
 * because the interesting part is the error handling: one unreadable file in a
 * multi-file drop must not discard the good ones, and "that isn't a font" has
 * to reach the user rather than a console nobody is watching.
 */

import { addCustomFontFile, FONT_FILE_ACCEPT } from './fontRegistry.js'
import { addToast } from '../components/common/Toast.jsx'

/**
 * Add font files to the registry, reporting each outcome.
 * @param {File[]|FileList} files
 * @returns {Promise<object[]>} the descriptors that were added
 */
export async function ingestFontFiles(files) {
  const added = []
  for (const file of [...(files || [])]) {
    try {
      added.push(await addCustomFontFile(file))
    } catch (err) {
      addToast({ message: err?.message || `Could not add ${file.name}`, type: 'error' })
    }
  }

  if (added.length === 1) {
    addToast({ message: `Added font "${added[0].label}"`, type: 'success' })
  } else if (added.length > 1) {
    addToast({ message: `Added ${added.length} fonts`, type: 'success' })
  }
  return added
}

/**
 * Open a file picker and ingest whatever the user chooses.
 * @returns {Promise<object[]>} the descriptors that were added
 */
export async function promptForFontFiles() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = FONT_FILE_ACCEPT
  input.multiple = true

  const files = await new Promise((resolve) => {
    input.onchange = () => resolve([...(input.files || [])])
    // Most browsers fire no event for a dismissed dialog; `cancel` covers the
    // ones that do, so we don't leave an await pending for the page's lifetime.
    input.oncancel = () => resolve([])
    input.click()
  })

  return ingestFontFiles(files)
}
