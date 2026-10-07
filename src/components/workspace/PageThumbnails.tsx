import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { VirtuosoGrid } from 'react-virtuoso'
import { Badge, Button, EmptyState, Progress, type BadgeTone } from '@/components/ui'
import type { QueueSnapshot } from '@/core/jobQueue'
import { pageRepo } from '@/db/repo-content'
import { sourceFileRepo } from '@/db/repo-sourceFiles'
import type { PageAnalysisState, PageContentClass, PageRecord } from '@/db/types'
import { analysisClient } from '@/pdf/analysisClient'
import {
  cancelParse,
  ensurePagesExtracted,
  loadParseSnapshot,
  pauseParse,
  resumeParse,
  restoreParse,
  retryParse,
  startParse,
  subscribeParse,
} from '@/pdf/parseQueue'
import { ensureProjectDocument } from '@/pdf/projectAnalysis'
import { getCachedUrl, putCachedUrl, renderCacheKey } from '@/pdf/renderCache'
import { REASON_CODES } from '@/core/reasonCodes'
import { cn } from '@/lib/cn'

/** Page points → CSS px for the low-resolution thumbnail. */
const THUMB_SCALE = 0.28
/** Layout extraction is requested this far ahead of / behind the viewport. */
const PREFETCH_MARGIN = 10
/** Scrolling fires `rangeChanged` constantly; talk to the queue once it settles. */
const REQUEST_DEBOUNCE_MS = 220

const CLASS_TONE: Record<PageContentClass, BadgeTone> = {
  text: 'info',
  scanned: 'warning',
  mixed: 'primary',
  empty: 'neutral',
}

const CLASS_LABEL: Record<PageContentClass, string> = {
  text: 'workspace.pages.classText',
  scanned: 'workspace.pages.classScanned',
  mixed: 'workspace.pages.classMixed',
  empty: 'workspace.pages.classEmpty',
}

const STATE_LABEL: Record<PageAnalysisState, string> = {
  idle: 'workspace.pages.unparsed',
  queued: 'workspace.pages.parsing',
  running: 'workspace.pages.parsing',
  done: 'workspace.pages.parsed',
  failed: 'workspace.pages.failed',
}

const STATE_TONE: Record<PageAnalysisState, BadgeTone> = {
  idle: 'neutral',
  queued: 'primary',
  running: 'primary',
  done: 'success',
  failed: 'danger',
}

const EMPTY_PAGES: PageRecord[] = []

/**
 * Object URL for one page, fetched on demand and cancelled if the row leaves
 * the virtualised window before the worker finishes (a fast scroll must not
 * queue hundreds of renders — the next visit simply asks again).
 */
function useThumbnail(fileId: string | null, pageIndex: number): string | null {
  const key = renderCacheKey(fileId ?? '-', pageIndex, 'thumbnail', THUMB_SCALE)
  const [url, setUrl] = useState<string | null>(null)
  const settled = useRef(false)

  useEffect(() => {
    if (!fileId) {
      setUrl(null)
      return undefined
    }
    const cached = getCachedUrl(key)
    if (cached) {
      settled.current = true
      setUrl(cached)
      return undefined
    }

    settled.current = false
    let mounted = true
    analysisClient
      .render(fileId, pageIndex, THUMB_SCALE, 'thumbnail')
      .then((blob) => {
        const objectUrl = putCachedUrl(key, blob)
        settled.current = true
        if (mounted) setUrl(objectUrl)
      })
      .catch(() => {
        // Cancelled or failed: the skeleton stays and the next visit retries.
        settled.current = true
      })

    return () => {
      mounted = false
      if (!settled.current) analysisClient.cancelRender(fileId, pageIndex)
    }
  }, [fileId, key, pageIndex])

  return url
}

function PageCard({ page, fileId }: { page: PageRecord; fileId: string | null }) {
  const { t } = useTranslation()
  const url = useThumbnail(fileId, page.index)
  const needsOcr = page.contentClass === 'scanned' && page.ocrStatus !== 'done'

  return (
    <article
      data-testid="page-thumb"
      data-page-index={page.index}
      data-analysis={page.analysisState}
      className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="relative h-36 shrink-0 border-b border-border bg-white">
        {url ? (
          <img
            src={url}
            alt=""
            decoding="async"
            className="h-full w-full object-contain"
            data-testid="page-thumb-img"
          />
        ) : (
          <div className="skeleton-shimmer h-full w-full" aria-hidden="true" />
        )}
        <span className="absolute left-1 top-1 rounded-md border border-border bg-surface/95 px-1 py-px text-[10px] tabular-nums text-muted">
          {page.index + 1}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 px-2 py-1.5">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-[11px] text-faint">
            {t('workspace.pages.pageLabel', { n: page.index + 1 })}
          </span>
          <Badge tone={CLASS_TONE[page.contentClass]}>{t(CLASS_LABEL[page.contentClass])}</Badge>
        </div>
        <div className="flex items-center justify-between gap-1">
          {page.analysisState === 'done' ? (
            <span className="truncate text-[10px] tabular-nums text-faint">
              {t('workspace.pages.openBlock', { count: page.blockCount })}
            </span>
          ) : (
            <Badge tone={STATE_TONE[page.analysisState]}>
              {t(STATE_LABEL[page.analysisState])}
            </Badge>
          )}
          {needsOcr ? <Badge tone="warning">{t('workspace.pages.ocrNeeded')}</Badge> : null}
        </div>
      </div>
    </article>
  )
}

export interface PageThumbnailsProps {
  projectId: string
  className?: string
  /** Height of the virtualised viewport (px). */
  height?: number
}

/**
 * Virtualised page strip: renders only what is on screen, pulls low-resolution
 * thumbnails from the worker-backed LRU cache, and asks the parse queue to
 * extract layout for the visible window (plus a small margin).
 */
export function PageThumbnails({ projectId, className, height = 520 }: PageThumbnailsProps) {
  const { t, i18n } = useTranslation()
  const pages = useLiveQuery(() => pageRepo.listByProject(projectId), [projectId], EMPTY_PAGES)
  const source = useLiveQuery(
    () => sourceFileRepo.getLatestByProject(projectId),
    [projectId],
    undefined,
  )

  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [locked, setLocked] = useState(false)
  const timerRef = useRef<number | null>(null)
  const restoredForRef = useRef<string | null>(null)

  const fileId = source?.id ?? null
  const pageCount = pages.length
  const parsedCount = pages.reduce(
    (total, page) => total + (page.analysisState === 'done' ? 1 : 0),
    0,
  )
  const phase = snapshot?.phase ?? 'idle'

  /* The document must be open before anything can be rendered from it. */
  useEffect(() => {
    let cancelled = false
    setLocked(false)
    void ensureProjectDocument(projectId)
      .then(({ outcome }) => {
        if (!cancelled && outcome.status !== 'opened') setLocked(true)
      })
      .catch(() => {
        if (!cancelled) setLocked(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  /* Live queue events (the persisted snapshot itself is restored below). */
  useEffect(() => subscribeParse((event) => setSnapshot(event.snapshot)), [projectId])

  /*
   * Load what the last session persisted, then rebuild the queue for whatever
   * Dexie still reports as unparsed. Without this the panel would claim
   * `running` after a reload while nothing was actually running — and the
   * pause/cancel buttons would silently do nothing.
   */
  useEffect(() => {
    if (restoredForRef.current === projectId || pageCount === 0) return undefined
    restoredForRef.current = projectId
    let cancelled = false
    void loadParseSnapshot(projectId).then((stored) => {
      if (cancelled || !stored) return
      setSnapshot(stored)
      if (stored.phase === 'running') void restoreParse(projectId, true)
      else if (stored.phase === 'paused') void restoreParse(projectId, false)
    })
    return () => {
      cancelled = true
    }
  }, [pageCount, projectId])

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const requestRange = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        const from = Math.max(0, range.startIndex - PREFETCH_MARGIN)
        const to = Math.min(pageCount - 1, range.endIndex + PREFETCH_MARGIN)
        if (to < from) return
        const indexes = Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
        void ensurePagesExtracted(projectId, indexes)
      }, REQUEST_DEBOUNCE_MS)
    },
    [pageCount, projectId],
  )

  if (pageCount === 0) {
    return (
      <div data-testid="page-thumbs" className={className}>
        <EmptyState
          size="sm"
          title={t('workspace.pages.title')}
          body={t('workspace.pages.empty')}
        />
      </div>
    )
  }

  return (
    <section
      data-testid="page-thumbs"
      className={cn('flex min-w-0 flex-col gap-3', className)}
      aria-label={t('workspace.pages.title')}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold text-text">{t('workspace.pages.title')}</span>
          <span className="text-xs tabular-nums text-muted" data-testid="page-parse-progress">
            {t('workspace.pages.parseProgress', { done: parsedCount, total: pageCount })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'running' ? (
            <>
              <Button size="sm" variant="secondary" onClick={pauseParse}>
                {t('pipeline.PAUSE')}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelParse}>
                {t('pipeline.CANCEL')}
              </Button>
            </>
          ) : null}
          {phase === 'paused' ? (
            <>
              <Button size="sm" variant="secondary" onClick={resumeParse}>
                {t('pipeline.RESUME')}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelParse}>
                {t('pipeline.CANCEL')}
              </Button>
            </>
          ) : null}
          {phase === 'failed' ? (
            <Button size="sm" variant="secondary" onClick={retryParse}>
              {t('pipeline.RETRY')}
            </Button>
          ) : null}
          {phase !== 'running' && phase !== 'paused' && parsedCount < pageCount ? (
            <Button
              size="sm"
              variant={phase === 'failed' ? 'secondary' : 'primary'}
              onClick={() => startParse(projectId, pageCount)}
              data-testid="page-parse-start"
            >
              {t('pipeline.PARSE')}
            </Button>
          ) : null}
        </div>
      </header>

      <Progress
        size="sm"
        value={(parsedCount / Math.max(1, pageCount)) * 100}
        ariaLabel={t('workspace.pages.title')}
      />

      {locked ? (
        <p
          data-testid="page-locked"
          className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-xs leading-relaxed text-warning mm-text"
        >
          {i18n.language === 'my'
            ? REASON_CODES.PDF_ENCRYPTED.messageMy
            : REASON_CODES.PDF_ENCRYPTED.messageEn}
        </p>
      ) : null}

      <div
        className="rounded-md border border-border bg-surface p-2"
        data-testid="page-thumb-viewport"
      >
        <VirtuosoGrid
          data={pages}
          style={{ height }}
          listClassName="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          itemClassName="min-w-0 h-[200px]"
          computeItemKey={(_, page) => page.id}
          rangeChanged={requestRange}
          itemContent={(index) => <PageCard page={pages[index]} fileId={fileId} />}
        />
      </div>
    </section>
  )
}
