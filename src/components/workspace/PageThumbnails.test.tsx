/**
 * The Pages panel's restored state.
 *
 * The queue persists after every item, but the phase transition that ends a
 * run happens *after* that write — so for a long time the stored snapshot said
 * `running` even when the document was fully parsed. On the next visit the
 * panel displayed it, found nothing left to re-queue (so the queue emitted no
 * events to correct it) and offered Pause/Cancel that could not pause anything.
 *
 * What is pinned here: the panel must show what the *live* queue says once a
 * restore has found no work, and must keep the controls when it did find some.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { pageRepo } from '@/db/repo-content'
import type { QueuePhase, QueueSnapshot } from '@/core/jobQueue'
import { PageThumbnails } from './PageThumbnails'

interface VirtuosoGridProps {
  data?: unknown[]
  itemContent?: (index: number, item: unknown) => ReactNode
  computeItemKey?: (index: number, item: unknown) => string
  rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
}

vi.mock('react-virtuoso', () => ({
  VirtuosoGrid: ({ data, itemContent, computeItemKey, rangeChanged }: VirtuosoGridProps) => {
    const items = data ?? []
    queueMicrotask(() => rangeChanged?.({ startIndex: 0, endIndex: items.length - 1 }))
    return (
      <div data-testid="virtuoso-mock">
        {items.map((item, index) => (
          <div key={computeItemKey?.(index, item) ?? String(index)}>
            {itemContent?.(index, item)}
          </div>
        ))}
      </div>
    )
  },
}))

const loadParseSnapshot = vi.fn<(projectId: string) => Promise<QueueSnapshot | null>>()
const restoreParse = vi.fn<(projectId: string, resume: boolean) => Promise<number>>()
const parseSnapshot = vi.fn<() => QueueSnapshot>()
const subscribeParse = vi.fn<(listener: (event: unknown) => void) => () => void>()

vi.mock('@/pdf/parseQueue', () => ({
  cancelParse: vi.fn(),
  ensurePagesExtracted: vi.fn(() => 0),
  loadParseSnapshot: (projectId: string) => loadParseSnapshot(projectId),
  parseSnapshot: () => parseSnapshot(),
  pauseParse: vi.fn(),
  resumeParse: vi.fn(),
  restoreParse: (projectId: string, resume: boolean) => restoreParse(projectId, resume),
  retryParse: vi.fn(),
  startParse: vi.fn(),
  subscribeParse: (listener: (event: unknown) => void) => subscribeParse(listener),
}))

/* The panel only needs the document to *open*; nothing is rendered from it. */
vi.mock('@/pdf/projectAnalysis', () => ({
  ensureProjectDocument: vi.fn(async () => ({
    fileId: 'file_test',
    outcome: { status: 'opened', pageCount: 3 },
  })),
}))

const PROJECT_ID = 'prj_restore_panel'

function snapshot(phase: QueuePhase, completed: number): QueueSnapshot {
  return {
    phase,
    total: 1,
    completed,
    failed: 0,
    active: 0,
    pendingIds: [],
    failedIds: [],
  }
}

async function seedPages(count: number, analysisState: 'done' | 'queued'): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await pageRepo.upsert({
      projectId: PROJECT_ID,
      index,
      width: 612,
      height: 792,
      analysisState,
    })
  }
}

function mount(): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <PageThumbnails projectId={PROJECT_ID} />
    </I18nextProvider>,
  )
}

describe('PageThumbnails restored state', () => {
  let db: AppDatabase

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    db = new AppDatabase(`aidt-thumbs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    loadParseSnapshot.mockReset()
    restoreParse.mockReset()
    parseSnapshot.mockReset()
    subscribeParse.mockClear()
    /* No live queue in jsdom: nothing emits unless a test says so. */
    subscribeParse.mockImplementation(() => () => undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it('shows what the live queue says when a stored run has nothing left to do', async () => {
    await seedPages(3, 'done')
    loadParseSnapshot.mockResolvedValue(snapshot('running', 1))
    restoreParse.mockResolvedValue(0)
    parseSnapshot.mockReturnValue(snapshot('done', 1))
    mount()

    await waitFor(() =>
      expect(screen.getByTestId('page-parse-progress')).toHaveTextContent('3 / 3'),
    )
    // The stored phase is `running`, but the restore re-queued no windows.
    await waitFor(() => expect(screen.getByTestId('page-parse-complete')).toBeInTheDocument())
    expect(restoreParse).toHaveBeenCalledWith(PROJECT_ID, true)
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('keeps the controls when the stored run still has windows to work through', async () => {
    await seedPages(6, 'queued')
    loadParseSnapshot.mockResolvedValue(snapshot('running', 0))
    restoreParse.mockResolvedValue(2)
    parseSnapshot.mockReturnValue(snapshot('running', 0))
    mount()

    await waitFor(() => expect(restoreParse).toHaveBeenCalledWith(PROJECT_ID, true))
    expect(await screen.findByRole('button', { name: /pause/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    expect(screen.queryByTestId('page-parse-complete')).toBeNull()
  })

  it('restores a paused run as paused, not running', async () => {
    await seedPages(4, 'queued')
    loadParseSnapshot.mockResolvedValue(snapshot('paused', 1))
    restoreParse.mockResolvedValue(1)
    parseSnapshot.mockReturnValue(snapshot('paused', 1))
    mount()

    await waitFor(() => expect(restoreParse).toHaveBeenCalledWith(PROJECT_ID, false))
    expect(await screen.findByRole('button', { name: /resume/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull()
  })
})
