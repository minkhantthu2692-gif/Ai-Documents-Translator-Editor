import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { readRaw } from '@/lib/storage'
import en from './locales/en.json'
import my from './locales/my.json'

export type Language = 'en' | 'my'

export const UI_STORE_KEY = 'aidt.ui'
export const SUPPORTED_LANGUAGES: Language[] = ['en', 'my']

function detectLanguage(): Language {
  const raw = readRaw(UI_STORE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { state?: { language?: string } }
      const stored = parsed?.state?.language
      if (stored === 'en' || stored === 'my') return stored
    } catch {
      /* fall through to navigator detection */
    }
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('my')) {
    return 'my'
  }
  return 'en'
}

export function applyDocumentLanguage(language: Language): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
  }
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      my: { translation: my },
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
    react: {
      useSuspense: false,
    },
  })
  applyDocumentLanguage(i18n.language as Language)
}

export default i18n
