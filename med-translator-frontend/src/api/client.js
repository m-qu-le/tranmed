import axios from 'axios'

export const API_BASE_URL = (
  import.meta.env.VITE_API_URL || 'https://tranmed.onrender.com/api/translate'
).replace(/\/+$/, '')

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
})

export async function putPdfToR2(uploadUrl, file, { onProgress, signal } = {}) {
  const target = new URL(uploadUrl)
  if (target.protocol !== 'https:' || !target.hostname.endsWith('.r2.cloudflarestorage.com')) {
    throw new Error('Backend trả về URL upload R2 không hợp lệ.')
  }
  return axios.put(target.toString(), file, {
    headers: { 'Content-Type': 'application/pdf' },
    timeout: 15 * 60_000,
    signal,
    onUploadProgress: onProgress,
  })
}

export default api
