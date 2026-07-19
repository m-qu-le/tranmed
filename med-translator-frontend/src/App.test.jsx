import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    window.localStorage.clear()
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: {
        isHibernating: false,
        stats: null,
        storage: { configured: true, available: true, cleanupBacklog: 0 },
      } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: { pending: 0, processing: 0, completed: 0, failed: 0 } })
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('alert', vi.fn())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders the translator shell and empty state', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /StudyMed Translator/i })).toBeInTheDocument()
    expect(await screen.findByText(/Chưa có tài liệu nào/i)).toBeInTheDocument()
    expect(await screen.findByText(/Cloud Storage sẵn sàng/i)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tổng quan tiến độ' })).toBeInTheDocument()
  })

  it('shows the daily 15:00 Vietnam wake-up policy while hibernating', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: {
        isHibernating: true,
        stats: {
          startTime: '2026-07-18T07:00:00.000Z',
          wakeupTime: '2026-07-18T08:00:00.000Z',
          wakeupPolicy: 'daily_15_asia_ho_chi_minh',
          hibernationCount: 1,
        },
      } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: { pending: 0, processing: 0, completed: 0, failed: 0 } })
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })

    render(<App />)

    expect(await screen.findByText(/mốc 15:00 mỗi ngày/i)).toBeInTheDocument()
    expect(screen.getByText('Số lần ngủ đông')).toBeInTheDocument()
  })

  it('sorts folders and file names A-Z using natural Vietnamese ordering', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: { pending: 3, processing: 0, completed: 0, failed: 0 } })
      return Promise.resolve({ data: { items: [
        { jobId: 'z-10', folderName: 'Zeta', originalName: 'Bài 10.pdf', status: 'pending' },
        { jobId: 'a-10', folderName: 'Alpha', originalName: 'Bài 10.pdf', status: 'pending' },
        { jobId: 'a-2', folderName: 'Alpha', originalName: 'Bài 2.pdf', status: 'pending' },
      ], nextCursor: null } })
    })

    render(<App />)
    await screen.findByText('📄 Bài 2.pdf')

    const folderToggles = screen.getAllByRole('button', { name: /📁 (Alpha|Zeta)/ })
    expect(folderToggles.map(node => node.textContent.replace(/\s+/g, ''))).toEqual([
      '▼📁Alpha(2files)',
      '▼📁Zeta(1files)',
    ])

    const alphaGroup = screen.getByText(/📁 Alpha \(2 files\)/).closest('.folder-group')
    const alphaFiles = within(alphaGroup).getAllByText(/📄 Bài/).map(node => node.textContent)
    expect(alphaFiles).toEqual(['📄 Bài 2.pdf', '📄 Bài 10.pdf'])
  })

  it('uses global job stats and does not change the dashboard when loading more history', async () => {
    api.get.mockImplementation((url, options) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: {
        pending: 473, processing: 1, completed: 32, failed: 0,
        folders: [{ name: 'Mới', count: 500 }],
        cloud: {
          uploadingBatches: 0, uploadedBytes: 0, totalBytes: 0,
          confirmedFiles: 100, totalFiles: 100, safeFiles: 100,
        },
      } })
      if (options?.params?.cursor) return Promise.resolve({ data: { items: [
        { jobId: 'older-completed', folderName: 'Cũ', status: 'completed' },
      ], nextCursor: null } })
      return Promise.resolve({ data: { items: [
        { jobId: 'new-pending', folderName: 'Mới', status: 'pending' },
      ], nextCursor: 'next-page' } })
    })

    render(<App />)
    const dashboard = screen.getByRole('region', { name: 'Tổng quan tiến độ' })
    expect(await within(dashboard).findByText('32')).toBeInTheDocument()
    expect(within(dashboard).getByText('File đã xong')).toBeInTheDocument()
    expect(within(dashboard).getByText('Chờ 473 · xử lý 1 · lỗi 0')).toBeInTheDocument()
    expect(within(dashboard).getByText('100')).toBeInTheDocument()
    expect(within(dashboard).getByText('Đã xác nhận 100/100 file')).toBeInTheDocument()
    expect(screen.getByText(/📁 Mới \(500 files\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Tải thêm lịch sử' }))
    await screen.findByText('📄 Tài liệu')
    expect(within(dashboard).getByText('32')).toBeInTheDocument()
    expect(screen.getByText(/📁 Mới \(500 files\)/)).toBeInTheDocument()
    expect(api.get.mock.calls.filter(([url]) => url.endsWith('/jobs/stats'))).toHaveLength(1)
  })

  it('debounces job stats refresh only for a real SSE status transition', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: { pending: 0, processing: 1, completed: 0, failed: 0 } })
      return Promise.resolve({ data: { items: [{
        jobId: 'transition-job', folderName: 'Realtime', status: 'processing',
      }], nextCursor: null } })
    })

    render(<App />)
    await screen.findByText(/Đang dịch/i)
    await waitFor(() => expect(api.get.mock.calls.filter(([url]) => url.endsWith('/jobs/stats'))).toHaveLength(1))

    await act(async () => {
      MockEventSource.instance.onmessage({ data: JSON.stringify({ type: 'status', jobId: 'transition-job', status: 'processing' }) })
      MockEventSource.instance.onmessage({ data: JSON.stringify({ type: 'status', jobId: 'transition-job', status: 'completed' }) })
      MockEventSource.instance.onmessage({ data: JSON.stringify({ type: 'status', jobId: 'transition-job', status: 'completed' }) })
      await new Promise(resolve => setTimeout(resolve, 550))
    })

    expect(api.get.mock.calls.filter(([url]) => url.endsWith('/jobs/stats'))).toHaveLength(2)
  })

  it('shows an em dash on initial stats failure and keeps the last snapshot on a later failure', async () => {
    let statsCalls = 0
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      if (url.endsWith('/jobs/stats')) {
        statsCalls += 1
        if (statsCalls === 1) return Promise.reject(new Error('initial stats unavailable'))
        if (statsCalls === 2) return Promise.resolve({ data: { pending: 2, processing: 1, completed: 5, failed: 0 } })
        return Promise.reject(new Error('refresh stats unavailable'))
      }
      return Promise.resolve({ data: { items: [{ jobId: 'stats-job', folderName: 'Stats', status: 'pending' }], nextCursor: null } })
    })

    render(<App />)
    const dashboard = screen.getByRole('region', { name: 'Tổng quan tiến độ' })
    expect(await within(dashboard).findByText('—')).toBeInTheDocument()

    await act(async () => MockEventSource.instance.onopen())
    expect(await within(dashboard).findByText('5')).toBeInTheDocument()
    await act(async () => {
      MockEventSource.instance.onmessage({ data: JSON.stringify({ type: 'status', jobId: 'stats-job', status: 'processing' }) })
      await new Promise(resolve => setTimeout(resolve, 550))
    })
    expect(within(dashboard).getByText('5')).toBeInTheDocument()
  })

  it('hides only safe batches and remembers their batch IDs', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: { pending: 0, processing: 0, completed: 0, failed: 0 } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [
        {
          batchId: 'safe-batch', clientBatchId: 'safe-client', folderName: 'An toàn', status: 'ready',
          totalFiles: 1, totalBytes: 10, confirmedFiles: 1, confirmedBytes: 10, canCloseClient: true,
        },
        {
          batchId: 'unsafe-batch', clientBatchId: 'unsafe-client', folderName: 'Chưa xong', status: 'uploading',
          totalFiles: 2, totalBytes: 20, confirmedFiles: 1, confirmedBytes: 10, canCloseClient: false,
        },
      ] } })
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })

    const view = render(<App />)
    expect(await screen.findByText(/📁 An toàn/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ẩn tất cả batch đã an toàn' }))

    expect(screen.queryByText(/📁 An toàn/)).not.toBeInTheDocument()
    expect(screen.getByText(/📁 Chưa xong/)).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem('studymed.hiddenUploadBatchIds.v1'))).toEqual(['safe-batch'])
    expect(api.post).not.toHaveBeenCalled()
    expect(api.delete).not.toHaveBeenCalled()

    view.unmount()
    render(<App />)
    await waitFor(() => expect(api.get.mock.calls.filter(([url]) => url.endsWith('/upload-batches')).length).toBeGreaterThanOrEqual(2))
    expect(screen.queryByText(/📁 An toàn/)).not.toBeInTheDocument()
    expect(screen.getByText(/📁 Chưa xong/)).toBeInTheDocument()
  })

  it('does not restore a hidden batch from MongoDB', async () => {
    window.localStorage.setItem('studymed.hiddenUploadBatchIds.v1', JSON.stringify(['hidden-batch']))
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: { pending: 0, processing: 0, completed: 0, failed: 0 } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [{
        batchId: 'hidden-batch', clientBatchId: 'hidden-client', folderName: 'Đã ẩn', status: 'ready',
        totalFiles: 1, totalBytes: 10, confirmedFiles: 1, confirmedBytes: 10, canCloseClient: true,
      }] } })
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })

    render(<App />)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/upload-batches', { params: { limit: 20 } }))
    expect(screen.queryByText(/📁 Đã ẩn/)).not.toBeInTheDocument()
  })

  it('falls back to in-memory hidden IDs when localStorage cannot be read', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/jobs/stats')) return Promise.resolve({ data: { pending: 0, processing: 0, completed: 0, failed: 0 } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [{
        batchId: 'visible-batch', clientBatchId: 'visible-client', folderName: 'Vẫn hoạt động', status: 'ready',
        totalFiles: 1, totalBytes: 10, confirmedFiles: 1, confirmedBytes: 10, canCloseClient: true,
      }] } })
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })

    render(<App />)
    expect(await screen.findByText(/📁 Vẫn hoạt động/)).toBeInTheDocument()
    getItem.mockRestore()
  })

  it('ignores malformed hidden-batch JSON without crashing', async () => {
    window.localStorage.setItem('studymed.hiddenUploadBatchIds.v1', '{not-json')

    render(<App />)

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
    expect(screen.getAllByText(/xác nhận 200\/200/i)).toHaveLength(2)
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

  it('applies realtime batch confirmation and resyncs batches after SSE reconnect', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: {
        isHibernating: false,
        stats: null,
        storage: { configured: true, available: true, cleanupBacklog: 0 },
      } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [{
        batchId: 'realtime-batch',
        clientBatchId: 'realtime-client',
        folderName: 'Thần kinh',
        status: 'uploading',
        totalFiles: 2,
        totalBytes: 20,
        confirmedFiles: 1,
        confirmedBytes: 10,
        canCloseClient: false,
      }] } })
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })

    render(<App />)
    expect(await screen.findByText(/Batch chưa upload đủ/i)).toBeInTheDocument()

    await act(async () => {
      MockEventSource.instance.onmessage({ data: JSON.stringify({
        type: 'batchStatus',
        data: {
          batchId: 'realtime-batch', totalFiles: 2, confirmedFiles: 2,
          confirmedBytes: 20, canCloseClient: true, status: 'ready',
        },
      }) })
    })
    expect(await screen.findByText(/Đã xác nhận an toàn trên Cloud/i)).toBeInTheDocument()
    expect(screen.getByText(/Đã lưu an toàn trên Cloud — có thể tắt máy/i)).toBeInTheDocument()

    await act(async () => MockEventSource.instance.onopen())
    await waitFor(() => expect(api.get.mock.calls.filter(([url]) => url.endsWith('/upload-batches')).length).toBeGreaterThanOrEqual(2))
  })

  it('shows every quality pipeline stage with persisted chunk progress', async () => {
    const stages = [
      ['document_context', 'Đang đọc ngữ cảnh toàn tài liệu'],
      ['translate', 'Đang dịch'],
      ['medical_audit', 'Đang kiểm định'],
      ['revise', 'Đang hiệu chỉnh'],
      ['verify', 'Đang xác minh'],
      ['repair', 'Đang sửa lỗi'],
      ['reverify', 'Đang xác minh lại'],
    ]
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      return Promise.resolve({ data: {
        items: stages.map(([stage], index) => ({
          jobId: `quality-${stage}`,
          originalName: `${stage}.pdf`,
          folderName: 'Quality stages',
          status: 'processing',
          translationMode: 'quality',
          currentQualityStage: stage,
          chunkCount: 5,
          completedChunks: index,
          passedChunks: index,
          needsReviewChunks: 0,
          qualityWarnings: [],
        })),
        nextCursor: null,
      } })
    })

    render(<App />)
    for (const [index, [, label]] of stages.entries()) {
      expect(await screen.findByText(`⚙️ ${label} ${index}/5`)).toBeInTheDocument()
    }
    expect(screen.getAllByText(/Kiểm soát chất lượng:/i)).toHaveLength(stages.length)
  })

  it('shows completed quality warnings with page ranges and no diagnostic text', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      return Promise.resolve({ data: { items: [{
        jobId: 'quality-warning',
        originalName: 'warning.pdf',
        folderName: 'Quality warnings',
        status: 'completed',
        translationMode: 'quality',
        chunkCount: 4,
        completedChunks: 4,
        passedChunks: 3,
        needsReviewChunks: 1,
        qualityWarnings: [{ chunkIndex: 3, pageStart: 7, pageEnd: 8 }],
      }], nextCursor: null } })
    })

    render(<App />)
    expect(await screen.findByText('⚠️ Hoàn thành có cảnh báo')).toBeInTheDocument()
    expect(screen.getByText('Phần 4: trang 7–8')).toBeInTheDocument()
    expect(screen.queryByText(/audit|diagnostic/i)).not.toBeInTheDocument()
  })

  it('renders and copies the same quality warning Markdown returned by the result API', async () => {
    const result = [
      '# ⚠️ Lưu ý kiểm soát chất lượng',
      '',
      '> Cần đối chiếu thủ công với PDF gốc.',
      '',
      '## Phần 1 — trang 1',
      '',
      '- Kết quả: Cần xem lại sau 1 vòng sửa.',
      '',
      '---',
      '',
      '# Nội dung bản dịch',
      '',
      'Bản dịch.',
    ].join('\n')
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      if (url.endsWith('/jobs/quality-output/result')) return Promise.resolve({ data: { result } })
      return Promise.resolve({ data: { items: [{
        jobId: 'quality-output',
        originalName: 'warning.pdf',
        folderName: 'Quality warnings',
        status: 'completed',
        translationMode: 'quality',
        chunkCount: 1,
        completedChunks: 1,
        passedChunks: 0,
        needsReviewChunks: 1,
        qualityWarnings: [{ chunkIndex: 0, pageStart: 1, pageEnd: 1 }],
      }], nextCursor: null } })
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /Xem trước/i }))
    expect(await screen.findByRole('heading', { name: '⚠️ Lưu ý kiểm soát chất lượng' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Phần 1 — trang 1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Nội dung bản dịch' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Copy Markdown/i }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(result))
    expect(api.get.mock.calls.filter(([url]) => url.endsWith('/jobs/quality-output/result'))).toHaveLength(1)
  })

  it('keeps the legacy processing display unchanged and omits quality details', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) return Promise.resolve({ data: { isHibernating: false, stats: null } })
      if (url.endsWith('/upload-batches')) return Promise.resolve({ data: { items: [] } })
      return Promise.resolve({ data: { items: [{
        jobId: 'legacy-processing',
        originalName: 'legacy.pdf',
        folderName: 'Legacy',
        status: 'processing',
        translationMode: 'legacy',
        translationPipelineVersion: 'p003-v1',
        chunkCount: 3,
        completedChunks: 1,
      }], nextCursor: null } })
    })

    render(<App />)
    expect(await screen.findByText('⚙️ Đang dịch 1/3')).toBeInTheDocument()
    expect(screen.queryByText(/Kiểm soát chất lượng:/i)).not.toBeInTheDocument()
  })
})
