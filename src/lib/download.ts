/**
 * File download helpers (Phase 4).
 *
 * No third-party saver: an object URL + a synthetic anchor keeps the export
 * path dependency-free and works for Blobs produced inside a worker.
 */

/** Triggers a download for an in-memory Blob and releases the object URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Give the browser a tick to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

export function saveTextFile(text: string, fileName: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), fileName)
}

export function saveJsonFile(value: unknown, fileName: string): void {
  saveTextFile(JSON.stringify(value, null, 2), fileName, 'application/json;charset=utf-8')
}

/** Reads a picked file as text (CSV/TSV glossary import). */
export function readTextFile(file: Blob): Promise<string> {
  return file.text()
}

/** `report.csv` → `report`, guarding against empty names. */
export function baseName(fileName: string): string {
  const withoutDir = fileName.split(/[\\/]/).pop() ?? fileName
  const dot = withoutDir.lastIndexOf('.')
  return dot > 0 ? withoutDir.slice(0, dot) : withoutDir
}
