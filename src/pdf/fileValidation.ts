/**
 * File-level validation for PDF imports.
 *
 * Cheap checks that run *before* pdf.js ever touches the bytes: name, magic
 * header, size limits. Page-count limits are checked once the document opens
 * (see `checkPageCount`).
 */

import type { ReasonCode } from '@/core/reasonCodes'

/** Hard cap: beyond this the browser is likely to run out of memory. */
export const MAX_FILE_BYTES = 150 * 1024 * 1024
/** Softer warning threshold shown in the pre-flight list. */
export const WARN_FILE_BYTES = 50 * 1024 * 1024
/** Hard cap for page count (the pipeline is page-windowed for big documents). */
export const MAX_PAGE_COUNT = 1000
/** Warning threshold for page count. */
export const WARN_PAGE_COUNT = 500

export interface FileCheck {
  ok: boolean
  reasonCode: ReasonCode | null
  /** English technical detail for the log; UI copy comes from the reason code. */
  detail: string
}

const OK: FileCheck = { ok: true, reasonCode: null, detail: 'ok' }

/** `.pdf` extension check (case-insensitive). */
export function hasPdfExtension(name: string): boolean {
  return /\.pdf$/i.test(name.trim())
}

/**
 * Reads the first kilobyte and looks for the `%PDF-` header.
 * The spec allows arbitrary junk before the header (up to 1024 bytes).
 */
export async function hasPdfMagicBytes(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer())
  const needle = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
  for (let i = 0; i + needle.length <= head.length; i += 1) {
    let match = true
    for (let j = 0; j < needle.length; j += 1) {
      if (head[i + j] !== needle[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

/** Full pre-pdf.js check: extension, magic header and size. */
export async function checkPdfFile(file: File): Promise<FileCheck> {
  if (!hasPdfExtension(file.name)) {
    return { ok: false, reasonCode: 'FILE_NOT_PDF', detail: 'missing .pdf extension' }
  }
  if (file.size === 0) {
    return { ok: false, reasonCode: 'FILE_NOT_PDF', detail: 'file is empty' }
  }
  const sizeCheck = checkFileSize(file.size)
  if (!sizeCheck.ok) return sizeCheck
  try {
    const ok = await hasPdfMagicBytes(file)
    if (!ok) return { ok: false, reasonCode: 'FILE_NOT_PDF', detail: 'missing %PDF- header' }
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'FILE_NOT_PDF',
      detail: `unreadable file: ${(error as Error).message}`,
    }
  }
  return OK
}

export function checkFileSize(bytes: number): FileCheck {
  if (bytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      reasonCode: 'FILE_TOO_LARGE',
      detail: `${bytes} > ${MAX_FILE_BYTES} bytes`,
    }
  }
  return OK
}

/** True when the size is allowed but worth warning about. */
export function isFileSizeWarning(bytes: number): boolean {
  return bytes > WARN_FILE_BYTES && bytes <= MAX_FILE_BYTES
}

export function checkPageCount(pages: number): FileCheck {
  if (!Number.isFinite(pages) || pages <= 0) {
    return { ok: false, reasonCode: 'PDF_CORRUPTED', detail: `invalid page count ${pages}` }
  }
  if (pages > MAX_PAGE_COUNT) {
    return { ok: false, reasonCode: 'TOO_MANY_PAGES', detail: `${pages} > ${MAX_PAGE_COUNT}` }
  }
  return OK
}

export function isPageCountWarning(pages: number): boolean {
  return pages > WARN_PAGE_COUNT && pages <= MAX_PAGE_COUNT
}
