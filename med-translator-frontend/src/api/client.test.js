import { beforeEach, describe, expect, it, vi } from 'vitest'

const { axiosPut } = vi.hoisted(() => ({ axiosPut: vi.fn() }))
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({})),
    put: axiosPut,
  },
}))

import { putPdfToR2 } from './client.js'

describe('putPdfToR2', () => {
  beforeEach(() => axiosPut.mockReset().mockResolvedValue({ status: 200 }))

  it('sends PDF bytes only to an absolute Cloudflare R2 URL', async () => {
    const file = new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })
    const url = 'https://account.r2.cloudflarestorage.com/incoming/batch/job.pdf?signature=test'
    await putPdfToR2(url, file)
    expect(axiosPut).toHaveBeenCalledWith(
      url,
      file,
      expect.objectContaining({ headers: { 'Content-Type': 'application/pdf' } }),
    )
  })

  it('refuses backend or non-R2 upload destinations', async () => {
    const file = new File(['%PDF'], 'source.pdf', { type: 'application/pdf' })
    await expect(putPdfToR2('https://tranmed.onrender.com/api/upload', file))
      .rejects.toThrow(/URL upload R2 không hợp lệ/)
    expect(axiosPut).not.toHaveBeenCalled()
  })
})
