/**
 * Records the sidecar's `POST /extract` answer for the generated PDFs.
 *
 * `src/sidecar/extractParity.test.ts` replays these recordings through the
 * normaliser and compares the result with what pdf.js produced for the same
 * page. Recording rather than mocking keeps the fixture byte-identical to a
 * real server's response, so the test fails if `sidecar/server.py` changes
 * shape — which is exactly when the adapter needs re-checking.
 *
 * Needs the sidecar running (see `sidecar/README.md`), then:
 *
 *   node scripts/record-sidecar-extract.mjs
 *   npx prettier --write "fixtures/sidecar/*.json"
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = (process.env.VITE_PDF_SIDECAR_URL || 'http://localhost:8790').replace(/\/+$/, '')
const outDir = join(root, 'fixtures', 'sidecar')

/**
 * Fixture → page range, exactly as `sidecarExtract` would ask for it.
 *
 * Between them these six cover the whole adapter: a table drawn cell by cell,
 * a long document's running head/list/URL/formula page, a rotated watermark,
 * a page of `/Link` annotations, a half-image page, and a scan with no text
 * layer at all.
 */
const targets = [
  ['table.pdf', '0-1'],
  ['text-300p.pdf', '0-2'],
  ['complex.pdf', '0'],
  ['links.pdf', '0'],
  ['mixed.pdf', '0'],
  ['scanned.pdf', '0'],
]

async function main() {
  const health = await fetch(`${base}/health`)
    .then((response) => response.json())
    .catch(() => null)
  if (!health?.ok) {
    console.error(`sidecar not reachable at ${base} — start sidecar/server.py first`)
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  for (const [name, pages] of targets) {
    const response = await fetch(`${base}/extract?mode=text&pages=${pages}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: readFileSync(join(root, 'fixtures', name)),
    })
    if (!response.ok) {
      console.error(`${name}: /extract answered ${response.status}`)
      process.exit(1)
    }
    const payload = await response.json()
    // Wall-clock time of the run, not part of the protocol.
    delete payload.ms

    const file = join(outDir, `${name.replace(/\.pdf$/, '')}.json`)
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`${name} pages ${pages} -> fixtures/sidecar/${file.split(/[\\/]/).pop()}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
