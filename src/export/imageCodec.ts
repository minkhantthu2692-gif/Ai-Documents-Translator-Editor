/**
 * Image helpers for the export worker (Phase 4).
 *
 * The analysis worker hands back WebP (PNG fallback), but `pdf-lib` only
 * understands PNG and JPEG and ZIP packs want the format the user picked — so
 * every raster path goes through here. Decoding uses `createImageBitmap` +
 * `OffscreenCanvas`, both available inside a worker, so the main thread never
 * touches a pixel.
 */

export interface TranscodeOptions {
  /** JPEG only: 0..1 encoder quality. */
  quality?: number
  /** Test seam. */
  decode?: (blob: Blob) => Promise<ImageBitmap>
}

function hasDecoders(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof self !== 'undefined'
  )
}

async function defaultDecode(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob)
}

/** Encodes a blob as `target` (PNG or JPEG), re-encoding only when needed. */
export async function encodeBlob(
  blob: Blob,
  target: 'image/png' | 'image/jpeg',
  options: TranscodeOptions = {},
): Promise<Uint8Array> {
  const alreadyEncoded = blob.type === target
  if (alreadyEncoded || !hasDecoders()) {
    return new Uint8Array(await blob.arrayBuffer())
  }
  const decode = options.decode ?? defaultDecode
  const bitmap = await decode(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no-2d-context')
    ctx.drawImage(bitmap, 0, 0)
    if (target === 'image/jpeg') {
      // JPEG has no alpha: paint the page white first so it does not go black.
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, bitmap.width, bitmap.height)
    }
    const out = await canvas.convertToBlob(
      target === 'image/jpeg'
        ? { type: target, quality: options.quality ?? 0.85 }
        : { type: target },
    )
    return new Uint8Array(await out.arrayBuffer())
  } finally {
    bitmap.close?.()
  }
}

/** `Blob` → `data:<mime>;base64,…` for inlining into HTML/EPUB. */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const mime = blob.type || 'image/png'
  const encoder = typeof btoa === 'function' ? btoa : (value: string) => toNodeBase64(value)
  return `data:${mime};base64,${encoder(binary)}`
}

function toNodeBase64(binary: string): string {
  // Node (Vitest only): Buffer exists there, never in a worker.
  return Buffer.from(binary, 'binary').toString('base64')
}

/** WebP/PNG/JPEG sniffing helper used when a blob reports no MIME type. */
export async function sniffMime(blob: Blob): Promise<string> {
  if (blob.type && blob.type !== 'application/octet-stream') return blob.type
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const ascii = String.fromCharCode(...head)
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp'
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  return 'image/png'
}
