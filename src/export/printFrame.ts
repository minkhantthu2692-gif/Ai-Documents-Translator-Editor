/**
 * Print-to-PDF frame (Phase 4).
 *
 * The layout-preserving PDF path: the HTML builder emits a document whose
 * `@page` box equals the original page size with zero margins and absolute
 * positioning, we drop it into a hidden iframe, and the browser's own print
 * engine lays the glyphs out — which is the only way to get real Myanmar
 * shaping (ligatures, stacked consonants, medials) into a PDF.
 *
 * Trade-off, surfaced in the Export dialog: the output has *selectable vector
 * text* but depends on the browser's print pipeline (the user confirms the
 * dialog and picks "Save as PDF"). The raster fallback produces a file with no
 * dialog and no text layer instead.
 */

import { sanitizeDocument } from '@/editor/sanitize'

let activeFrame: HTMLIFrameElement | null = null

/** Creates (or reuses) the hidden iframe the printed document lives in. */
function ensureFrame(title: string): HTMLIFrameElement {
  if (activeFrame && activeFrame.isConnected) return activeFrame
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('title', title)
  frame.setAttribute('data-print-frame', '')
  frame.style.cssText = [
    'position:fixed',
    'right:0',
    'bottom:0',
    'width:0',
    'height:0',
    'border:0',
    'opacity:0',
    'pointer-events:none',
    'z-index:-1',
  ].join(';')
  document.body.appendChild(frame)
  activeFrame = frame
  return frame
}

export function disposePrintFrame(): void {
  if (activeFrame && activeFrame.isConnected) activeFrame.remove()
  activeFrame = null
}

/** Waits for the frame's fonts to finish loading (best effort, capped). */
async function waitForFonts(doc: Document, timeoutMs = 6000): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts
  if (!fonts?.ready) return
  await Promise.race([
    fonts.ready.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

export interface PrintResult {
  /** False when the browser rejected the call (popup/permission policies). */
  ok: boolean
  detail: string
}

/**
 * Loads `html` into the hidden frame, waits for fonts, then opens the print
 * dialog. The frame is removed once printing finishes so the DOM stays clean.
 */
export async function printHtmlDocument(html: string, title = 'Print'): Promise<PrintResult> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { ok: false, detail: 'no-dom' }
  }
  const safe = sanitizeDocument(html)
  const frame = ensureFrame(title)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) return { ok: false, detail: 'no-frame' }

  const cleanup = (): void => {
    window.removeEventListener('afterprint', cleanup)
    disposePrintFrame()
  }
  window.addEventListener('afterprint', cleanup)

  doc.open()
  doc.write(safe)
  doc.close()

  try {
    await waitForFonts(doc)
    // Two frames: one for layout, one so the print engine sees the final style.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    win.focus()
    win.print()
    return { ok: true, detail: 'printed' }
  } catch (error) {
    cleanup()
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** True when a print round trip can be attempted in this environment. */
export function canPrint(): boolean {
  return typeof window !== 'undefined' && typeof window.print === 'function'
}
