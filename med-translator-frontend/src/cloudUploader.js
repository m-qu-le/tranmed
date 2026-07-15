import api, { putPdfToR2 } from './api/client.js'

export class CloudUploadError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'CloudUploadError'
    this.details = details
  }
}

const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))

function isRetryable(error) {
  const status = error?.response?.status
  return !status || status === 408 || status === 429 || status >= 500
}

function isExpiredSignature(error) {
  const status = error?.response?.status
  return status === 400 || status === 401 || status === 403
}

async function retryOperation(operation, { attempts = 3, sleep = wait, retryWhen = isRetryable } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt === attempts || !retryWhen(error)) throw error
      await sleep(300 * (2 ** (attempt - 1)))
    }
  }
  throw lastError
}

async function runPool(items, concurrency, worker) {
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        await worker(items[index], index)
      }
    },
  )
  await Promise.all(runners)
}

function buildManifest({ clientBatchId, folderName, entries }) {
  return {
    clientBatchId,
    folderName,
    files: entries.map(({ file, clientUploadId }) => ({
      clientUploadId,
      name: file.name,
      size: file.size,
      type: 'application/pdf',
    })),
  }
}

export async function uploadBatchToCloud({
  clientBatchId,
  folderName,
  entries,
  concurrency = 4,
  confirmChunkSize = 10,
  apiClient = api,
  putFile = putPdfToR2,
  sleep = wait,
  signal,
  onPrepared = () => {},
  onProgress = () => {},
  onItemState = () => {},
}) {
  const manifest = buildManifest({ clientBatchId, folderName, entries })
  const fileByClientId = new Map(entries.map(entry => [entry.clientUploadId, entry.file]))
  const totalBytes = entries.reduce((sum, entry) => sum + entry.file.size, 0)
  const loadedByClientId = new Map()
  const confirmedJobIds = new Set()
  const failedItems = []

  let prepared = await retryOperation(
    () => apiClient.post('/upload-batches/prepare', manifest, { timeout: 60_000 }),
    { sleep },
  )
  let preparedData = prepared.data
  onPrepared(preparedData)

  const reportProgress = (extra = {}) => {
    const uploadedBytes = [...loadedByClientId.values()].reduce((sum, bytes) => sum + bytes, 0)
    onProgress({
      totalBytes,
      uploadedBytes: Math.min(uploadedBytes, totalBytes),
      percent: totalBytes > 0 ? Math.round(Math.min(uploadedBytes, totalBytes) * 100 / totalBytes) : 0,
      confirmedFiles: confirmedJobIds.size,
      totalFiles: entries.length,
      ...extra,
    })
  }

  for (const item of preparedData.items) {
    if (item.status !== 'uploading') {
      confirmedJobIds.add(item.jobId)
      loadedByClientId.set(item.clientUploadId, item.size)
    }
  }
  reportProgress()

  let pendingConfirmIds = []
  let confirmChain = Promise.resolve()
  let confirmError = null
  let latestConfirmation = null
  const flushConfirm = (force = false) => {
    if (confirmError) return confirmChain
    if (!force && pendingConfirmIds.length < confirmChunkSize) return confirmChain
    if (pendingConfirmIds.length === 0) return confirmChain
    const jobIds = pendingConfirmIds.splice(0, confirmChunkSize)
    confirmChain = confirmChain.then(async () => {
      try {
        const response = await retryOperation(
          () => apiClient.post(
            `/upload-batches/${encodeURIComponent(preparedData.batchId)}/confirm`,
            { items: jobIds.map(jobId => ({ jobId })) },
            { timeout: 60_000 },
          ),
          { sleep },
        )
        latestConfirmation = response.data
        for (const item of response.data.items || []) confirmedJobIds.add(item.jobId)
        reportProgress({ canCloseClient: response.data.canCloseClient })
        return response.data
      } catch (error) {
        pendingConfirmIds.unshift(...jobIds)
        confirmError = error
        return null
      }
    })
    return confirmChain
  }

  const uploadItems = preparedData.items.filter(item => item.status === 'uploading')
  await runPool(uploadItems, concurrency, async item => {
    const file = fileByClientId.get(item.clientUploadId)
    if (!file) {
      failedItems.push({ ...item, error: 'Không còn File object tương ứng trên thiết bị.' })
      onItemState(item.clientUploadId, { status: 'error', error: failedItems.at(-1).error })
      return
    }
    onItemState(item.clientUploadId, { status: 'uploading' })
    let currentItem = item
    try {
      await retryOperation(async attempt => {
        try {
          await putFile(currentItem.uploadUrl, file, {
            signal,
            onProgress: event => {
              loadedByClientId.set(item.clientUploadId, Math.min(event.loaded || 0, file.size))
              reportProgress()
            },
          })
        } catch (error) {
          if (isExpiredSignature(error)) {
            const refreshed = await apiClient.post('/upload-batches/prepare', manifest, { timeout: 60_000 })
            preparedData = refreshed.data
            currentItem = preparedData.items.find(candidate => candidate.clientUploadId === item.clientUploadId)
            if (!currentItem?.uploadUrl) throw new Error('Không thể cấp lại URL upload cho file.')
            if (attempt < 3) throw Object.assign(new Error('Presigned URL đã được làm mới.'), { retryableRefresh: true })
          }
          throw error
        }
      }, {
        sleep,
        retryWhen: error => error?.retryableRefresh || isRetryable(error),
      })
      loadedByClientId.set(item.clientUploadId, file.size)
      onItemState(item.clientUploadId, { status: 'uploaded' })
      pendingConfirmIds.push(item.jobId)
      await flushConfirm(false)
    } catch (error) {
      failedItems.push({ ...item, error: error?.response?.data?.error || error.message })
      onItemState(item.clientUploadId, { status: 'error', error: failedItems.at(-1).error })
    }
  })

  while (pendingConfirmIds.length > 0 && !confirmError) await flushConfirm(true)
  await confirmChain

  const statusResponse = await retryOperation(
    () => apiClient.get(`/upload-batches/${encodeURIComponent(preparedData.batchId)}`, { timeout: 30_000 }),
    { sleep },
  )
  const batchStatus = statusResponse.data
  reportProgress({ canCloseClient: batchStatus.canCloseClient })

  if (failedItems.length > 0 || confirmError || !batchStatus.canCloseClient) {
    throw new CloudUploadError('Một số file chưa được lưu an toàn trên Cloud.', {
      batchId: preparedData.batchId,
      failedItems,
      batchStatus,
      latestConfirmation,
      confirmError: confirmError?.response?.data?.error || confirmError?.message || null,
    })
  }

  return { ...batchStatus, items: preparedData.items }
}
