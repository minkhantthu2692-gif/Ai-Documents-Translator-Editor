/**
 * Raster page composition (Phase 4).
 *
 * Turns one page of the export document into a single image: the rendered
 * page *background* (figures, rules, watermarks — the analysis worker erased
 * the original text for us) with the translated text painted on top using the
 * same wrap/auto-fit rules as the HTML output. This is what makes the raster
 * PDF and the PNG/JPG pack show the translation rather than the original.
 *
 * Runs inside the export worker on an `OffscreenCanvas`: the main thread never
 * sees a pixel, so a 300-page raster export still keeps the UI responsive.
 */

import { createCanvasMeasurer, fitBlockText, type TextMeasurer } from '@/editor/autofit'
import { listPrefix, pageBlocks, fontStackFor } from './shared'
import type { ExportBlock, ExportPage } from './types'

export interface CompositeOptions {
  /** Pixels per PDF point (2 = 144 dpi). */
  scale: number
  /** Extra font families appended after each block's own family. */
  fontStack: string
  /** Output type (`image/jpeg` also takes a 0..1 `quality`). */
  type?: 'image/png' | 'image/jpeg'
  quality?: number
}

/** Canvas measuring context for a worker thread (no DOM available there). */
export function workerMeasurer(): TextMeasurer {
  return createCanvasMeasurer(() => {
    if (typeof OffscreenCanvas === 'undefined') return null
    return new OffscreenCanvas(1, 1).getContext('2d')
  })
}

function alignmentOf(block: ExportBlock): CanvasTextAlign {
  if (block.alignment === 'center') return 'center'
  if (block.alignment === 'right') return 'right'
  return 'left'
}

function textOf(block: ExportBlock): string {
  if (block.translatedText.trim().length > 0) return block.translatedText
  return block.sourceText
}

/** Paints one block (wrap → auto-fit → one `fillText` per line). */
function drawBlock(
  ctx: OffscreenCanvasRenderingContext2D,
  block: ExportBlock,
  options: CompositeOptions,
  measure: TextMeasurer,
): void {
  const text = textOf(block)
  if (text.trim().length === 0) return

  const font = {
    fontFamily: block.fontFamily,
    bold: block.bold,
    italic: block.italic,
  }
  const fitted = fitBlockText({
    text,
    box: { width: block.width, height: block.height },
    ...font,
    originalSize: block.fontSize,
    lineHeight: block.lineHeight,
    measure,
  })

  const scale = options.scale
  const size = fitted.fontSize
  const family = fontStackFor(block, { fontStack: options.fontStack })
  ctx.font = `${font.italic ? 'italic ' : ''}${font.bold ? '700 ' : '400 '}${size * scale}px ${family}`
  ctx.fillStyle = /^#[0-9a-f]{3,8}$/i.test(block.color) ? block.color : '#000000'
  ctx.direction = block.direction === 'rtl' ? 'rtl' : 'ltr'
  ctx.textAlign = alignmentOf(block)
  ctx.textBaseline = 'top'

  const anchorX = (): number => {
    const align = alignmentOf(block)
    if (align === 'center') return (block.x + block.width / 2) * scale
    if (align === 'right') return (block.x + block.width) * scale
    return block.x * scale
  }

  const lines = fitted.lines.length > 0 ? fitted.lines : [text]
  const step = size * block.lineHeight * scale
  const x = anchorX()

  lines.forEach((line, index) => {
    const value = index === 0 ? `${listPrefix(block, line)}${line}` : line
    if (value.length === 0) return
    ctx.fillText(value, x, block.y * scale + index * step)
  })
}

/**
 * Composites one page. `background` may be null (blank sheet with text) — the
 * callers treat a failed background render as "no artwork", never as a
 * reason to drop the text.
 */
export async function compositePage(
  page: ExportPage,
  background: Blob | null,
  options: CompositeOptions,
): Promise<Blob> {
  const scale = Math.max(0.5, options.scale)
  const width = Math.max(1, Math.round(page.width * scale))
  const height = Math.max(1, Math.round(page.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('COMPOSITE_NO_CONTEXT')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  if (background) {
    try {
      const bitmap = await createImageBitmap(background)
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close?.()
    } catch {
      /* keep the white sheet */
    }
  }

  const measure = workerMeasurer()
  for (const block of pageBlocks(page)) {
    try {
      drawBlock(ctx, block, options, measure)
    } catch {
      /* a single unrenderable block must not fail the whole page */
    }
  }

  return canvas.convertToBlob(
    options.type === 'image/jpeg'
      ? { type: 'image/jpeg', quality: options.quality ?? 0.85 }
      : { type: 'image/png' },
  )
}
