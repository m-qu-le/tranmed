import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import LegacyNotice from './LegacyNotice.jsx'

const isLegacyNotice = import.meta.env.VITE_LEGACY_NOTICE === 'true'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isLegacyNotice ? <LegacyNotice /> : <App />}
  </StrictMode>,
)
