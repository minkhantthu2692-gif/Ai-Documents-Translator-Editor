/**
 * The Apps Script backend, shipped with the app so a user never has to dig
 * through the repository to find it.
 *
 * `apps-script/Code.gs` is the single source of truth: it is imported
 * read-only rather than copied into `public/`, so the file a user pastes into
 * their Sheet is always the one this build was tested against. Neither file
 * contains a secret — the shared TOKEN lives in a Script Property, never in
 * the code, never in the spreadsheet (see the SECURITY NOTES header inside
 * Code.gs).
 */

import codeGs from '../../apps-script/Code.gs?raw'
import manifestJson from '../../apps-script/appsscript.json?raw'

/** Saves `contents` under `filename` through a short-lived object URL. */
export function saveTextFile(filename: string, contents: string, mime: string): string {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return filename
}

/** Downloads `apps-script/Code.gs` — the file to paste into the editor. */
export function downloadAppsScript(): string {
  return saveTextFile('Code.gs', codeGs, 'text/javascript')
}

/** Downloads `apps-script/appsscript.json` — the manifest it is paired with. */
export function downloadAppsScriptManifest(): string {
  return saveTextFile('appsscript.json', manifestJson, 'application/json')
}

/** Raw contents, exported for tests that assert the shipped file is current. */
export function appsScriptSource(): string {
  return codeGs
}
