/**
 * Structural shape of tesseract.js's recognition data.
 *
 * tesseract.js returns a rich `Page` object (blocks → paragraphs → lines →
 * words, each with a pixel bbox and confidence). We deliberately declare the
 * subset we consume so the conversion code — and its tests — never need the
 * tesseract package or its worker on the import path.
 */

/** Pixel bounding box, top-left origin (as tesseract reports it). */
export interface OcrBBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrLine {
  text: string
  /** Mean confidence 0..100 (−1 when unknown). */
  confidence: number
  bbox: OcrBBox
}

export interface OcrParagraph {
  lines: OcrLine[]
}

export interface OcrBlock {
  paragraphs: OcrParagraph[]
}

/** The part of tesseract's `Page` the pipeline reads. */
export interface OcrPageData {
  blocks: OcrBlock[] | null
  /** Page-level mean confidence 0..100, when reported. */
  confidence?: number
}
