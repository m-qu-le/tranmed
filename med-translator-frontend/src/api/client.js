import axios from 'axios'

export const API_BASE_URL = (
  import.meta.env.VITE_API_URL || 'https://tranmed.onrender.com/api/translate'
).replace(/\/+$/, '')

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
})

export default api
