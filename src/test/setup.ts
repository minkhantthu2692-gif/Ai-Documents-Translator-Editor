import '@testing-library/jest-dom/vitest'

// jsdom does not implement matchMedia; the theme switcher needs it.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// jsdom does not implement scrollTo.
if (typeof window !== 'undefined' && !window.scrollTo) {
  window.scrollTo = (() => {}) as unknown as typeof window.scrollTo
}
