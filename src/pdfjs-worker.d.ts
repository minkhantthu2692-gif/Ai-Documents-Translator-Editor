/**
 * `pdfjs-dist/build/pdf.worker.mjs` ships no type declarations — we only ever
 * read its single export and hand it to pdf.js as `globalThis.pdfjsWorker`.
 */
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
