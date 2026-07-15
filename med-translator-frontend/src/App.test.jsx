import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api/client.js'
import { uploadBatchToCloud } from './cloudUploader.js'
import App from './App.jsx'

vi.mock('./api/client.js', () => ({
  API_BASE_URL: 'http://localhost/api/translate',
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

vi.mock('./cloudUploader.js', () => ({ uploadBatchToCloud: vi.fn() }))

class MockEventSource {
  static instance
  constructor() { MockEventSource.instance = this }
  close = vi.fn()
}

describe('App Cloud Uploader', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('alert', vi.fn())
  })

  it('renders the translator shell and empty state', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /StudyMed Translator/i })).toBeInTheDocument()
    expect(await screen.findByText(/Chưa có tài liệu nào/i)).toBeInTheDocument()
  })

  it('sends a 200-file manifest to the cloud uploader and shows close-safe only after backend confirmation', async () => {
    uploadBatchToCloud.mockImplementation(async options => {
      expect(options.entries).toHaveLength(200)
      expect(options.concurrency).toBe(4)
      options.onPrepared({
        batchId: 'batch-200',
        items: options.entries.map((entry, index) => ({
          jobId: `job-${index}`,
          clientUploadId: entry.clientUploadId,
          name: entry.file.name,
          status: 'uploading',
        })),
      })
      options.onProgress({
        totalBytes: 2000,
        uploadedBytes: 2000,
        percent: 100,
        confirmedFiles: 200,
        totalFiles: 200,
        canCloseClient: true,
      })
      return { confirmedFiles: 200, confirmedBytes: 2000, canCloseClient: true }
    })

    render(<App />)
    const files = Array.from({ length: 200 }, (_, index) => new File(
      [`%PDF-${index}`],
      `chapter-${index + 1}.pdf`,
      { type: 'application/pdf' },
    ))
    fireEvent.change(screen.getByLabelText('Tên thư mục'), { target: { value: 'Sách 200 chương' } })
    fireEvent.change(document.getElementById('fileInput'), { target: { files } })
    fireEvent.click(screen.getByRole('button', { name: /Upload 200 file lên Cloud/i }))

    await waitFor(() => expect(uploadBatchToCloud).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Đã lưu an toàn trên Cloud — có thể tắt máy/i)).toBeInTheDocument()
    expect(screen.getByText(/xác nhận 200\/200/i)).toBeInTheDocument()
  })

  it('restores a close-safe batch from MongoDB without local File objects', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) {
        return Promise.resolve({ data: { items: [{
          batchId: 'persisted-batch',
          clientBatchId: 'persisted-client',
          folderName: 'Đã lưu',
          status: 'ready',
          totalFiles: 50,
          totalBytes: 5000,
          confirmedFiles: 50,
          confirmedBytes: 5000,
          canCloseClient: true,
        }] } })
      }
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })

    render(<App />)
    expect(await screen.findByText(/trạng thái được phục hồi từ MongoDB/i)).toBeInTheDocument()
    expect(screen.getByText(/có thể tắt máy/i)).toBeInTheDocument()
    expect(uploadBatchToCloud).not.toHaveBeenCalled()
  })

  it('warns before closing only until backend marks the batch close-safe', async () => {
    let finishUpload
    uploadBatchToCloud.mockImplementation(options => new Promise(resolve => {
      options.onPrepared({
        batchId: 'batch-warning',
        items: [{
          jobId: 'job-warning', clientUploadId: options.entries[0].clientUploadId,
          name: options.entries[0].file.name, status: 'uploading',
        }],
      })
      finishUpload = () => {
        options.onProgress({
          totalBytes: 10, uploadedBytes: 10, percent: 100,
          confirmedFiles: 1, totalFiles: 1, canCloseClient: true,
        })
        resolve({ confirmedFiles: 1, confirmedBytes: 10, canCloseClient: true })
      }
    }))

    render(<App />)
    const file = new File(['%PDF-safe'], 'safe.pdf', { type: 'application/pdf' })
    fireEvent.change(document.getElementById('fileInput'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: /Upload 1 file lên Cloud/i }))
    await waitFor(() => expect(uploadBatchToCloud).toHaveBeenCalled())

    const unsafeClose = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unsafeClose)
    expect(unsafeClose.defaultPrevented).toBe(true)

    await act(async () => finishUpload())
    await screen.findByText(/có thể đóng tab hoặc tắt máy/i)
    const safeClose = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(safeClose)
    expect(safeClose.defaultPrevented).toBe(false)
  })

  it('retains the same client IDs for partial-failure retry', async () => {
    uploadBatchToCloud
      .mockRejectedValueOnce(Object.assign(new Error('Một số file chưa an toàn.'), {
        details: { batchId: 'partial-batch' },
      }))
      .mockResolvedValueOnce({ confirmedFiles: 2, confirmedBytes: 20, canCloseClient: true })

    render(<App />)
    const files = [
      new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' }),
      new File(['%PDF-2'], 'two.pdf', { type: 'application/pdf' }),
    ]
    fireEvent.change(document.getElementById('fileInput'), { target: { files } })
    fireEvent.click(screen.getByRole('button', { name: /Upload 2 file lên Cloud/i }))
    const retryButton = await screen.findByRole('button', { name: 'Thử lại' })
    const firstIds = uploadBatchToCloud.mock.calls[0][0].entries.map(entry => entry.clientUploadId)
    fireEvent.click(retryButton)
    await waitFor(() => expect(uploadBatchToCloud).toHaveBeenCalledTimes(2))
    const retryIds = uploadBatchToCloud.mock.calls[1][0].entries.map(entry => entry.clientUploadId)
    expect(retryIds).toEqual(firstIds)
  })
})
