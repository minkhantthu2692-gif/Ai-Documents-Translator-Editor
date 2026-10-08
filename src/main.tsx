import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@/styles/fonts'
import './index.css'
import '@/i18n'
import { App } from './App'
import { applyPersistedLanguage, applyTheme, useUiStore } from '@/stores/uiStore'
import { useImportedModelsStore } from '@/stores/importedModelsStore'
import { logEvent } from '@/core/eventLogger'

// Apply persisted preferences before the first paint.
applyTheme(useUiStore.getState().theme)
applyPersistedLanguage(useUiStore.getState().language)

// Register imported models early so no model dropdown renders without them.
void useImportedModelsStore.getState().ensureLoaded()

// Deployed under a sub-path (GitHub Pages project site) → routes and the
// service worker must resolve against the build's BASE_URL, not the root.
const APP_BASE = import.meta.env.BASE_URL

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root is missing')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename={APP_BASE}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

logEvent({
  state: 'APP',
  action: 'app.boot',
  severity: 'info',
  messageMy: 'အက်ပ် စတင်ဖွင့်ပြီး',
  messageEn: 'Application booted',
  technicalDetail: `version=${import.meta.env.VITE_APP_VERSION ?? '0.1.0'} mode=${
    import.meta.env.MODE
  }`,
})

// Progressive web app: installable + offline shell (production builds only).
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${APP_BASE}sw.js`).catch((error: unknown) => {
        console.warn('[sw] registration failed', error)
      })
    })
  } else {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister()
    })
  }
}
