import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './api/client.js'
import App from './App.jsx'

vi.mock('./api/client.js', () => ({
  API_BASE_URL: 'http://localhost/api/translate',
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

class MockEventSource {
  static instance

  constructor() {
    MockEventSource.instance = this
  }

  close = vi.fn()
}

describe('App', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) {
        return Promise.resolve({ data: { isHibernating: false, stats: null } })
      }
      return Promise.resolve({ data: [] })
    })
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('alert', vi.fn())
  })

  it('renders the translator shell and empty state', async () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: /StudyMed Translator/i })).toBeInTheDocument()
    expect(await screen.findByText(/Chưa có tài liệu nào/i)).toBeInTheDocument()
  })

  it('keeps a 100-chapter batch local and feeds only the first file', async () => {
    let capacityChecks = 0
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) {
        return Promise.resolve({ data: { isHibernating: false, stats: null } })
      }
      if (url.endsWith('/capacity')) {
        capacityChecks += 1
        return Promise.resolve({
          data: {
            canAcceptUpload: capacityChecks === 1,
            maxFileSizeBytes: 10_000,
          },
        })
      }
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })
    api.post.mockResolvedValue({
      data: {
        jobs: [{ jobId: 'job-1', originalName: 'chapter-1.pdf', status: 'pending' }],
      },
    })

    render(<App />)
    const input = document.getElementById('fileInput')
    const files = Array.from({ length: 100 }, (_, index) => new File(
      [`%PDF-chapter-${index + 1}`],
      `chapter-${String(index + 1).padStart(3, '0')}.pdf`,
      { type: 'application/pdf' },
    ))
    fireEvent.change(screen.getByLabelText('Tên thư mục'), { target: { value: 'Sách 100 chương' } })
    fireEvent.change(input, { target: { files } })
    fireEvent.click(screen.getByRole('button', { name: /Thêm 100 file/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    const submittedForm = api.post.mock.calls[0][1]
    expect(submittedForm.getAll('files')).toHaveLength(1)
    expect(submittedForm.get('files').name).toBe('chapter-001.pdf')
    expect(submittedForm.get('folderName')).toBe('Sách 100 chương')
    expect(submittedForm.get('clientUploadId')).toMatch(/^[0-9a-f-]{36}$/i)
    expect(screen.getByText(/100 files/i)).toBeInTheDocument()
  })

  it('re-uploads the same file after FILE_MISSING instead of skipping to the next file', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/status')) {
        return Promise.resolve({ data: { isHibernating: false, stats: null } })
      }
      if (url.endsWith('/capacity')) {
        return Promise.resolve({ data: { canAcceptUpload: true, maxFileSizeBytes: 10_000 } })
      }
      return Promise.resolve({ data: { items: [], nextCursor: null } })
    })
    api.post.mockResolvedValue({
      data: {
        jobs: [{ jobId: 'job-reused', originalName: 'chapter-1.pdf', status: 'pending' }],
      },
    })

    render(<App />)
    const firstFile = new File(['%PDF-first'], 'chapter-1.pdf', { type: 'application/pdf' })
    const secondFile = new File(['%PDF-second'], 'chapter-2.pdf', { type: 'application/pdf' })
    fireEvent.change(document.getElementById('fileInput'), { target: { files: [firstFile, secondFile] } })
    fireEvent.click(screen.getByRole('button', { name: /Thêm 2 file/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    const firstForm = api.post.mock.calls[0][1]
    const firstUploadId = firstForm.get('clientUploadId')

    MockEventSource.instance.onmessage({
      data: JSON.stringify({
        type: 'status',
        jobId: 'job-reused',
        status: 'failed',
        errorCode: 'FILE_MISSING',
        error: 'File gốc đã bị mất trên Render.',
      }),
    })

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    const retryForm = api.post.mock.calls[1][1]
    expect(retryForm.get('files').name).toBe('chapter-1.pdf')
    expect(retryForm.get('clientUploadId')).toBe(firstUploadId)
    expect(api.post.mock.calls.some(([, form]) => form.get('files').name === 'chapter-2.pdf')).toBe(false)
  })
})
