import { describe, expect, it, vi } from 'vitest'
import { uploadBatchToLocal } from './localUploader.js'

describe('uploadBatchToLocal', () => {
  it('serializes direct multipart uploads and becomes close-safe only after every job is persisted', async () => {
    const post = vi.fn(async (_url, form) => ({
      data: { jobs: [{ jobId: form.get('clientUploadId'), originalName: form.get('files').name, status: 'pending' }] },
    }))
    const progress = vi.fn()
    const entries = [
      { clientUploadId: 'local-one', file: new File(['%PDF-one'], 'one.pdf', { type: 'application/pdf' }) },
      { clientUploadId: 'local-two', file: new File(['%PDF-two'], 'two.pdf', { type: 'application/pdf' }) },
    ]

    const result = await uploadBatchToLocal({
      clientBatchId: 'batch-local',
      folderName: 'Sách local',
      entries,
      apiClient: { post },
      onProgress: progress,
    })

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0][1].get('folderName')).toBe('Sách local')
    expect(result.canCloseClient).toBe(true)
    expect(result.confirmedFiles).toBe(2)
    expect(progress.mock.calls.at(-1)[0].percent).toBe(100)
  })
})
