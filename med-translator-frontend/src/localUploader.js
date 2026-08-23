import api from './api/client.js'

export class LocalUploadError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'LocalUploadError'
    this.details = details
  }
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function retryAfterMs(error) {
  const headers = error?.response?.headers
  const value = headers?.['retry-after'] ?? headers?.get?.('retry-after')
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const suppliedSeconds = Number(error?.response?.data?.retryAfterSeconds)
  if (Number.isFinite(suppliedSeconds) && suppliedSeconds >= 0) return suppliedSeconds * 1000
  return 0
}

function isRetryable(error) {
  const status = error?.response?.status
  return !status || status === 408 || status === 429 || status >= 500
}

async function retry(operation, { attempts = 3, sleep = wait } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isRetryable(error)) throw error
      await sleep(Math.max(300 * (2 ** (attempt - 1)), retryAfterMs(error)))
    }
  }
  throw lastError
}

/**
 * The local protocol is close-safe as soon as each multipart response returns:
 * the backend has verified PDF magic bytes, atomically renamed it under
 * DATA_ROOT, and persisted the job with the caller's idempotency key.
 * Uploads intentionally run one at a time to keep the laptop responsive.
 */
export async function uploadBatchToLocal({
  clientBatchId,
  folderName,
  priority = false,
  entries,
  apiClient = api,
  sleep = wait,
  signal,
  onPrepared = () => {},
  onProgress = () => {},
  onItemState = () => {},
}) {
  const totalBytes = entries.reduce((total, entry) => total + entry.file.size, 0)
  let uploadedBytes = 0
  const preparedItems = []
  const failedItems = []
  onPrepared({ batchId: `local-${clientBatchId}`, items: preparedItems })

  const report = () => onProgress({
    totalBytes,
    uploadedBytes,
    percent: totalBytes > 0 ? Math.round(uploadedBytes * 100 / totalBytes) : 0,
    confirmedFiles: preparedItems.length,
    totalFiles: entries.length,
    canCloseClient: preparedItems.length === entries.length,
  })

  for (const entry of entries) {
    onItemState(entry.clientUploadId, { status: 'uploading' })
    try {
      const response = await retry(async () => {
        const form = new FormData()
        form.append('files', entry.file, entry.file.name)
        form.append('folderName', folderName)
        form.append('priority', String(Boolean(priority)))
        form.append('clientUploadId', entry.clientUploadId)
        return apiClient.post('/', form, {
          signal,
          timeout: 15 * 60_000,
          onUploadProgress: event => {
            const inFlight = Math.min(event.loaded || 0, entry.file.size)
            onProgress({
              totalBytes,
              uploadedBytes: Math.min(uploadedBytes + inFlight, totalBytes),
              percent: totalBytes > 0 ? Math.round(Math.min(uploadedBytes + inFlight, totalBytes) * 100 / totalBytes) : 0,
              confirmedFiles: preparedItems.length,
              totalFiles: entries.length,
              canCloseClient: false,
            })
          },
        })
      }, { sleep })
      const job = response.data?.jobs?.[0]
      if (!job?.jobId) throw new Error('Backend local không xác nhận job sau upload.')
      preparedItems.push({
        jobId: job.jobId,
        clientUploadId: entry.clientUploadId,
        name: job.originalName || entry.file.name,
        status: job.status,
        size: entry.file.size,
      })
      onPrepared({ batchId: `local-${clientBatchId}`, items: [...preparedItems] })
      uploadedBytes += entry.file.size
      onItemState(entry.clientUploadId, { status: 'uploaded' })
      report()
    } catch (error) {
      const message = error?.response?.data?.error || error.message || 'Upload local thất bại.'
      failedItems.push({ clientUploadId: entry.clientUploadId, name: entry.file.name, error: message })
      onItemState(entry.clientUploadId, { status: 'error', error: message })
    }
  }

  if (failedItems.length > 0) {
    throw new LocalUploadError('Một số file chưa được lưu an toàn trên máy.', {
      batchId: `local-${clientBatchId}`,
      failedItems,
      preparedItems,
    })
  }
  return {
    batchId: `local-${clientBatchId}`,
    items: preparedItems,
    totalFiles: entries.length,
    totalBytes,
    confirmedFiles: preparedItems.length,
    confirmedBytes: uploadedBytes,
    canCloseClient: true,
  }
}
