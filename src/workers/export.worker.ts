/**
 * Export worker (Phase 4).
 *
 * Owns every byte-consuming format: HTML/print documents, Markdown, plain
 * text, CSV/TSV, JSON, DOCX, EPUB, the raster PDF and the image pack. The
 * main thread only collects rows and shows progress, so exporting a 300-page
 * document never freezes the editor.
 *
 * One request â†’ `progress` messages â†’ one terminal `done`/`failed` message,
 * correlated by `id`. Blobs cross the boundary in either direction untouched.
 */

/// <reference lib="webworker" />

import { buildFontCss, toBase64, type FontFaceInfo } from '@/fonts'
import { blobToDataUrl } from '@/export/imageCodec'
import { buildCsv, buildTsv } from '@/export/delimited'
import { buildDocx } from '@/export/docx'
import { buildEpub } from '@/export/epub'
import { buildHtmlDocument, DEFAULT_HTML_OPTIONS } from '@/export/html'
import { buildJsonDocument } from '@/export/json'
import { buildMarkdown } from '@/export/markdown'
import { buildRasterPdf, rasterOptionsFrom } from '@/export/pdfRaster'
import { DEFAULT_FONT_STACK, fileNameFor, isDocumentEmpty } from '@/export/shared'
import { buildPlainText } from '@/export/text'
import { buildImagesZip } from '@/export/zipImages'
import { WORKER_MIME, type ExportBuildRequest, type ExportWorkerResponse } from '@/export/protocol'
import type { ExportArtifact, ExportIssue, ExportStage } from '@/export/types'
import { containsMyanmar } from '@/lib/text'

const scope = self as unknown as DedicatedWorkerGlobalScope

/** Excel needs a BOM to read UTF-8 CSV correctly (ASCII-safe construction). */
const BOM = String.fromCharCode(0xfeff)

class ExportBuildFailure extends Error {
  readonly code: ExportIssue['code']
  readonly fonts: string[]
  constructor(code: ExportIssue['code'], detail: string, fonts: string[]) {
    super(detail)
    this.name = 'ExportBuildFailure'
    this.code = code
    this.fonts = fonts
  }
}

function post(message: ExportWorkerResponse): void {
  scope.postMessage(message)
}

function progress(id: string, stage: ExportStage, done: number, total: number): void {
  post({ kind: 'progress', id, stage, done, total })
}

/** Most frequent block family â€” the font DOCX declares for its runs. */
function dominantFamily(request: ExportBuildRequest): string {
  const counts = new Map<string, number>()
  for (const page of request.doc.pages) {
    for (const block of page.blocks) {
      const family = block.fontFamily.trim()
      if (family.length === 0) continue
      counts.set(family, (counts.get(family) ?? 0) + 1)
    }
  }
  let best = 'Noto Sans'
  let bestCount = 0
  for (const [family, count] of counts) {
    if (count > bestCount) {
      best = family
      bestCount = count
    }
  }
  return best
}

async function pageImageUrls(
  images: ExportBuildRequest['images'],
): Promise<Array<{ index: number; dataUrl: string }>> {
  const out: Array<{ index: number; dataUrl: string }> = []
  for (const image of images) {
    try {
      out.push({ index: image.index, dataUrl: await blobToDataUrl(image.blob) })
    } catch {
      /* skip artwork we could not encode */
    }
  }
  return out
}

/** Base64 payloads for the EPUB `@font-face` injection. */
async function fontPayloads(
  faces: FontFaceInfo[],
  families: string[],
): Promise<Array<{ fileName: string; mimeType: string; base64: string }>> {
  const wanted = new Set(families.map((family) => family.toLowerCase()))
  const out: Array<{ fileName: string; mimeType: string; base64: string }> = []
  for (const face of faces) {
    if (!wanted.has(face.family.toLowerCase())) continue
    if (out.length >= 8) break
    try {
      const response = await fetch(face.url)
      if (!response.ok) continue
      const buffer = await response.arrayBuffer()
      const name = face.url.split('/').pop()?.split('?')[0] ?? `${face.family}.woff2`
      out.push({
        fileName: name,
        mimeType: name.endsWith('.woff2') ? 'font/woff2' : 'font/woff',
        base64: toBase64(buffer),
      })
    } catch {
      /* a font we cannot fetch simply is not embedded */
    }
  }
  return out
}

async function build(request: ExportBuildRequest): Promise<ExportArtifact> {
  const { id, doc, options, fontFaces, images } = request
  const issues: ExportIssue[] = []

  if (isDocumentEmpty(doc)) {
    throw new ExportBuildFailure('EXPORT_EMPTY', 'document has no translated text', [])
  }

  // Font CSS: only the families the document uses, inlined as data URLs so the
  // file renders the same on a machine that has none of our fonts installed.
  const families = [
    ...new Set(
      doc.pages.flatMap((page) =>
        page.blocks.map((block) => block.fontFamily).filter((family) => family.trim().length > 0),
      ),
    ),
  ]
  progress(id, 'build', 0, 1)
  const fontCss = await buildFontCss(fontFaces, {
    families: families.length > 0 ? families : null,
    weights: ['400', '500', '600', '700'],
  }).then((result) => {
    if (result.failed.length > 0) {
      issues.push({
        code: 'EXPORT_FONT_MISSING',
        fonts: result.failed,
        detail: 'some font files could not be inlined',
      })
    }
    return result.css
  })

  let blob: Blob
  const format = options.format

  switch (format) {
    case 'pdf':
    case 'bilingual-pdf':
    case 'html': {
      const bilingual = format === 'bilingual-pdf'
      const includeOriginal = bilingual || options.includeOriginal
      const html = buildHtmlDocument(doc, {
        ...DEFAULT_HTML_OPTIONS,
        mode: format === 'html' ? 'screen' : 'print',
        layout: includeOriginal ? 'flow' : 'absolute',
        bilingual: bilingual ? options.bilingual : 'none',
        includeOriginal,
        fontCss,
        fontStack: options.fontStack,
        title: doc.title,
        lang: doc.targetLang,
        generator: 'AI Documents Translator',
        pageImages: await pageImageUrls(images),
      })
      blob = new Blob([html], { type: WORKER_MIME[format] })
      break
    }

    case 'markdown': {
      const text = buildMarkdown(doc, {
        title: doc.title,
        includeOriginal: options.includeOriginal,
        includePageHeadings: true,
      })
      blob = new Blob([text], { type: WORKER_MIME.markdown })
      break
    }

    case 'text': {
      const text = buildPlainText(doc, {
        includeOriginal: options.includeOriginal,
        wrapWidth: 100,
        pageSeparator: '\f',
        pageHeader: '--- Page {{page}} ---',
      })
      blob = new Blob([text], { type: WORKER_MIME.text })
      break
    }

    case 'csv':
    case 'tsv': {
      const text = format === 'csv' ? buildCsv(doc, {}) : buildTsv(doc, {})
      blob = new Blob([format === 'csv' ? BOM + text : text], { type: WORKER_MIME[format] })
      break
    }

    case 'json': {
      const text = buildJsonDocument(doc, { pretty: true, includeGeometry: true })
      blob = new Blob([text], { type: WORKER_MIME.json })
      break
    }

    case 'docx': {
      const bytes = await buildDocx(doc, {
        title: doc.title,
        includeOriginal: options.includeOriginal,
        titleHeading: true,
        font: dominantFamily(request),
        pageHeadings: false,
        pageBreaks: true,
      })
      blob = new Blob([bytes as BlobPart], { type: WORKER_MIME.docx })
      break
    }

    case 'epub': {
      const hasMyanmar = doc.pages.some((page) =>
        page.blocks.some((block) => containsMyanmar(block.translatedText + block.sourceText)),
      )
      const payloadFamilies = [...families]
      if (hasMyanmar && !payloadFamilies.some((family) => /myanmar|padauk/i.test(family))) {
        payloadFamilies.push('Noto Sans Myanmar', 'Padauk')
      }
      const bytes = await buildEpub(doc, {
        title: doc.title,
        author: 'AI Documents Translator',
        lang: doc.targetLang,
        includeOriginal: options.includeOriginal,
        fontStack: options.fontStack || DEFAULT_FONT_STACK,
        fonts: await fontPayloads(fontFaces, payloadFamilies),
      })
      blob = new Blob([bytes as BlobPart], { type: WORKER_MIME.epub })
      break
    }

    case 'pdf-raster': {
      const bytes = await buildRasterPdf(doc, images, {
        ...rasterOptionsFrom(options),
        onPage: (done, total) => progress(id, 'render', done, total),
      })
      blob = new Blob([bytes as BlobPart], { type: WORKER_MIME['pdf-raster'] })
      break
    }

    case 'images': {
      const bytes = await buildImagesZip(doc, images, {
        format: options.imageFormat,
        scale: options.imageScale,
        fontStack: options.fontStack,
        onFile: (done, total) => progress(id, 'render', done, total),
      })
      blob = new Blob([bytes as BlobPart], { type: WORKER_MIME.images })
      break
    }

    default: {
      throw new ExportBuildFailure(
        'EXPORT_UNSUPPORTED',
        `unsupported format: ${String(format)}`,
        [],
      )
    }
  }

  progress(id, 'write', 1, 1)
  return {
    format,
    // Full name with extension: `deliverExport` hands it straight to the
    // downloader, and an extensionless name gets whatever Chrome guesses.
    fileName: fileNameFor(options, format),
    mime: blob.type,
    blob,
    bytes: blob.size,
    issues,
  }
}

scope.addEventListener('message', (event: MessageEvent<ExportBuildRequest>) => {
  const request = event.data
  if (!request || request.kind !== 'build') return

  build(request).then(
    (artifact) => post({ kind: 'done', id: request.id, artifact }),
    (error: unknown) => {
      const failure = error instanceof ExportBuildFailure ? error : null
      post({
        kind: 'failed',
        id: request.id,
        code: failure?.code ?? 'EXPORT_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        fonts: failure?.fonts ?? [],
      })
    },
  )
})
