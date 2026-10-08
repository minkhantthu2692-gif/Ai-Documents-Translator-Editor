/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_ENABLE_ANALYTICS?: string
  /** Phase 5 — Apps Script web-app /exec URL (fallback when Settings is empty). */
  readonly VITE_APPS_SCRIPT_URL?: string
  /** Phase 5 — shared sync token (single-user private deployments only). */
  readonly VITE_APPS_SCRIPT_TOKEN?: string
  /** Phase 5 — base URL of the assistant proxy (proxy/ or a CF Worker). */
  readonly VITE_ASSISTANT_PROXY_URL?: string
  /**
   * Local PDF sidecar base URL (PDF phases b2/c/d). Defaults to
   * `http://localhost:8790`; set it to an empty string to disable the sidecar
   * and force the browser-only path.
   */
  readonly VITE_PDF_SIDECAR_URL?: string
  /** Build-time base path, e.g. `/Ai-Documents-Translator-Editor/` on Pages. */
  readonly VITE_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.svg' {
  const src: string
  export default src
}
