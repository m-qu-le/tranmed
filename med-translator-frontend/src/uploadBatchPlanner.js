export const MAX_FILES_PER_UPLOAD_BATCH = 500
export const MAX_UPLOAD_BATCH_BYTES = 2 * 1024 * 1024 * 1024

function directoryNameFromRelativePath(file, fallbackName) {
  const relativePath = typeof file?.webkitRelativePath === 'string'
    ? file.webkitRelativePath.replaceAll('\\', '/')
    : ''
  const parts = relativePath.split('/').filter(Boolean)
  const directories = parts.slice(0, -1)
  if (directories.length === 0) return fallbackName

  // A directory picker includes the selected root as the first segment. Drop
  // it when there are child folders so selecting "File chờ dịch" yields a
  // separate logical batch for each book, while selecting one book still
  // retains that book's name.
  return directories.length > 1
    ? directories.slice(1).join(' / ')
    : directories[0]
}

function splitBounded(files) {
  const batches = []
  let current = []
  let currentBytes = 0
  for (const file of files) {
    const exceedsBatch = current.length >= MAX_FILES_PER_UPLOAD_BATCH
      || currentBytes + file.size > MAX_UPLOAD_BATCH_BYTES
    if (exceedsBatch && current.length > 0) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(file)
    currentBytes += file.size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Turn one file selection into safe, independently resumable upload batches.
 * Directory picks retain their immediate child-folder names; regular file
 * picks use the name entered by the user.
 */
export function planUploadBatches(inputFiles, {
  fallbackFolderName = 'Mặc định',
  groupByDirectory = false,
} = {}) {
  const groups = new Map()
  for (const file of Array.from(inputFiles || [])) {
    const folderName = groupByDirectory
      ? directoryNameFromRelativePath(file, fallbackFolderName)
      : fallbackFolderName
    const files = groups.get(folderName) || []
    files.push(file)
    groups.set(folderName, files)
  }

  const plans = []
  for (const [folderName, files] of groups) {
    const batches = splitBounded(files)
    batches.forEach((batchFiles, index) => {
      const partSuffix = batches.length > 1 ? ` · phần ${index + 1}/${batches.length}` : ''
      plans.push({
        folderName,
        displayName: `${folderName}${partSuffix}`,
        files: batchFiles,
        part: index + 1,
        totalParts: batches.length,
      })
    })
  }
  return plans
}
