/**
 * Page rasterisation for the workspace: thumbnails and text-less backgrounds.
 *
 * Both go through pdf.js onto an `OffscreenCanvas` inside the analysis worker,
 * so the main thread never touches pixels. The background render starts from a
 * normal page image and then *masks the text away*: for every text run we
 * sample the colours on a thin ring just outside its box (median over the four
 * sides) and repaint the box with them. Images and vector graphics outside the
 * boxes are untouched, which is exactly what the translated text overlay needs.
 *
 * Renders are cancellable — the workspace drops stale requests as the user
 * scrolls, and `renderPage` exposes the underlying pdf.js render task.
 */

import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'

export interface RenderPageOptions {
  /** Viewport scale (1 = 72 dpi). Thumbnails use ~0.15–0.25. */
  scale: number
  /** Repaint the text boxes with their sampled surroundings. */
  maskText?: boolean
}

export interface RenderHandle {
  promise: Promise<Blob>
  /** Aborts the pdf.js render task; the promise rejects with a cancel error. */
  cancel: () => void
}

interface ViewportLike {
  width: number
  height: number
  /** PDF user space → viewport pixels. */
  convertToViewportPoint(x: number, y: number): number[]
}

interface TextItemLike {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

type MaskableContext = CanvasRenderingContext2D & {
  getImageData?: (x: number, y: number, w: number, h: number) => ImageData
}

/** Rejection reason used by `cancel()` (pdf.js throws its own subclass). */
export function isRenderCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: string }).name
  return name === 'RenderingCancelledException' || name === 'AbortError'
}

function toBlob(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.75 }).then(async (blob) => {
    // Some engines cannot encode WebP — fall back to PNG rather than fail.
    if (blob && blob.type === 'image/webp') return blob
    return canvas.convertToBlob({ type: 'image/png' })
  })
}

/** Text runs as viewport-space boxes (top-left origin). */
async function textBoxes(
  page: PDFPageProxy,
  viewport: ViewportLike,
): Promise<
  Array<{
    x: number
    y: number
    w: number
    h: number
  }>
> {
  const content = await page.getTextContent()
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = []

  for (const raw of content.items as TextItemLike[]) {
    const str = typeof raw.str === 'string' ? raw.str : ''
    if (str.trim().length === 0 || !raw.transform || !Number.isFinite(raw.width)) continue

    const [, , , , originX, originY] = raw.transform
    const width = Math.max(0, raw.width ?? 0)
    const fontSize = Math.max(1, raw.height ?? Math.abs(raw.transform[3]) ?? 10)
    if (width <= 0.5) continue

    // Baseline origin → the visual box: roughly one em above, a quarter below.
    const [x0, y0] = viewport.convertToViewportPoint(originX, originY - fontSize * 0.28)
    const [x1, y1] = viewport.convertToViewportPoint(originX + width, originY + fontSize * 1.02)
    const x = Math.min(x0, x1)
    const y = Math.min(y0, y1)
    const w = Math.abs(x1 - x0)
    const h = Math.abs(y1 - y0)
    if (w < 0.5 || h < 0.5) continue
    boxes.push({ x, y, w, h })
  }
  return boxes
}

function median(values: number[]): number {
  if (values.length === 0) return 255
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Repaints one box with the median colour of a ring 2 px outside it.
 * Falls back to white when the ring cannot be read (fully transparent edges).
 */
function inpaintBox(
  context: MaskableContext,
  box: { x: number; y: number; w: number; h: number },
): void {
  const margin = 2
  const left = Math.max(0, Math.floor(box.x))
  const top = Math.max(0, Math.floor(box.y))
  const width = Math.ceil(box.w)
  const height = Math.ceil(box.h)
  if (width <= 0 || height <= 0) return

  const reds: number[] = []
  const greens: number[] = []
  const blues: number[] = []
  const step = 4

  const sample = (x: number, y: number): void => {
    if (x < 0 || y < 0) return
    try {
      const pixel = context.getImageData(x, y, 1, 1).data
      // Skip transparent pixels — they are page background, not ink.
      if (pixel[3] < 8) return
      reds.push(pixel[0])
      greens.push(pixel[1])
      blues.push(pixel[2])
    } catch {
      // getImageData can throw on tainted canvases; ignore.
    }
  }

  const right = left + width
  const bottom = top + height
  for (let x = left; x <= right; x += step) {
    sample(x, top - margin)
    sample(x, bottom + margin)
  }
  for (let y = top; y <= bottom; y += step) {
    sample(left - margin, y)
    sample(right + margin, y)
  }

  const fill = `rgb(${median(reds)}, ${median(greens)}, ${median(blues)})`
  context.fillStyle = fill
  context.fillRect(left, top, width, height)
}

/** Starts rendering one page; call `cancel()` to abort a stale request. */
export function renderPage(page: PDFPageProxy, options: RenderPageOptions): RenderHandle {
  const scale = Math.max(0.02, Math.min(8, options.scale))
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.round(viewport.width))
  const height = Math.max(1, Math.round(viewport.height))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true }) as MaskableContext | null

  let task: RenderTask | null = null
  let cancelled = false

  const promise = (async (): Promise<Blob> => {
    if (!context) throw new Error('2D canvas context unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)

    task = page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
      background: '#ffffff',
    })

    await task.promise

    if (options.maskText && !cancelled) {
      const boxes = await textBoxes(page, viewport)
      for (const box of boxes) {
        if (cancelled) break
        inpaintBox(context, box)
      }
    }
    if (cancelled) throw new Error('render cancelled')
    return toBlob(canvas)
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        // The task may already have settled.
      }
    },
  }
}
