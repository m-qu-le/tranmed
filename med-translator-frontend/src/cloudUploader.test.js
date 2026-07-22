import { describe, expect, it, vi } from 'vitest'
import { uploadBatchToCloud } from './cloudUploader.js'

describe('uploadBatchToCloud', () => {
  it('uploads 200 PDFs with concurrency 4, retries PUT and confirms in bounded chunks', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      clientUploadId: `client-${index}`,
      file: new File([`%PDF-${index}`], `chapter-${index}.pdf`, { type: 'application/pdf' }),
    }))
    const items = entries.map((entry, index) => ({
      jobId: `job-${index}`,
      clientUploadId: entry.clientUploadId,
      name: entry.file.name,
      size: entry.file.size,
      status: 'uploading',
      uploadUrl: `https://account.r2.cloudflarestorage.com/incoming/batch/job-${index}.pdf?signed=1`,
    }))
    const confirmed = new Set()
    const confirmChunks = []
    let prepareCalls = 0
    const apiClient = {
      post: vi.fn(async (url, body) => {
        if (url === '/upload-batches/prepare') {
          prepareCalls += 1
          return { data: { batchId: 'batch', status: 'uploading', items } }
        }
        const ids = body.items.map(item => item.jobId)
        confirmChunks.push(ids)
        ids.forEach(id => confirmed.add(id))
        return { data: {
          batchId: 'batch',
          items: ids.map(jobId => ({ jobId, status: 'pending' })),
          confirmedFiles: confirmed.size,
          confirmedBytes: entries
            .filter((entry, index) => confirmed.has(`job-${index}`))
            .reduce((sum, entry) => sum + entry.file.size, 0),
          canCloseClient: confirmed.size === 200,
        } }
      }),
      get: vi.fn(async () => ({ data: {
        batchId: 'batch', totalFiles: 200, confirmedFiles: 200,
        totalBytes: entries.reduce((sum, entry) => sum + entry.file.size, 0),
        confirmedBytes: entries.reduce((sum, entry) => sum + entry.file.size, 0),
        canCloseClient: true,
      } })),
    }
    let active = 0
    let maxActive = 0
    const attempts = new Map()
    const putFile = vi.fn(async (url, file, { onProgress }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const jobId = /job-(\d+)\.pdf/.exec(url)[0]
      const attempt = (attempts.get(jobId) || 0) + 1
      attempts.set(jobId, attempt)
      await Promise.resolve()
      try {
        if (jobId === 'job-0.pdf' && attempt === 1) {
          throw { response: { status: 503 } }
        }
        if (jobId === 'job-1.pdf' && attempt === 1) {
          throw { response: { status: 403 } }
        }
        onProgress({ loaded: file.size, total: file.size })
      } finally {
        active -= 1
      }
    })
    const progress = vi.fn()

    const result = await uploadBatchToCloud({
      clientBatchId: 'client-batch',
      folderName: 'Sách 200 chương',
      entries,
      concurrency: 4,
      confirmChunkSize: 10,
      apiClient,
      putFile,
      sleep: async () => {},
      onProgress: progress,
    })

    expect(result.canCloseClient).toBe(true)
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(putFile).toHaveBeenCalledTimes(202)
    expect(prepareCalls).toBe(2)
    expect(confirmChunks.every(chunk => chunk.length <= 10)).toBe(true)
    expect(new Set(confirmChunks.flat())).toHaveLength(200)
    expect(putFile.mock.calls.every(([url]) => new URL(url).hostname.endsWith('.r2.cloudflarestorage.com'))).toBe(true)
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      percent: 100,
      confirmedFiles: 200,
      canCloseClient: true,
    }))
  })

  it('includes the priority flag in the upload manifest', async () => {
    const entry = {
      clientUploadId: 'priority-client-file',
      file: new File(['%PDF-priority'], 'priority.pdf', { type: 'application/pdf' }),
    }
    const apiClient = {
      post: vi.fn(async (url, body) => {
        if (url === '/upload-batches/prepare') {
          expect(body.priority).toBe(true)
          return { data: {
            batchId: 'priority-batch',
            items: [{ jobId: 'priority-job', clientUploadId: entry.clientUploadId, name: entry.file.name, size: entry.file.size, status: 'uploading', uploadUrl: 'https://account.r2.cloudflarestorage.com/incoming/priority.pdf?signed=1' }],
          } }
        }
        return { data: { items: [{ jobId: 'priority-job', status: 'pending' }], canCloseClient: true } }
      }),
      get: vi.fn(async () => ({ data: { batchId: 'priority-batch', totalFiles: 1, confirmedFiles: 1, totalBytes: entry.file.size, confirmedBytes: entry.file.size, canCloseClient: true } })),
    }

    await uploadBatchToCloud({
      clientBatchId: 'priority-client-batch',
      folderName: 'Ưu tiên',
      priority: true,
      entries: [entry],
      apiClient,
      putFile: async (_url, file, { onProgress }) => onProgress({ loaded: file.size }),
    })

    expect(apiClient.post).toHaveBeenCalledWith('/upload-batches/prepare', expect.objectContaining({ priority: true }), expect.anything())
  })
})
