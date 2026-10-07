/**
 * Translation-memory tab of the Knowledge page (Phase 4): language-pair
 * selectors, text search, the most-used entries and per-row / full deletion.
 *
 * `translationMemoryRepo` exposes no filtered listing yet, so rows are read
 * through `top()` (already sorted by `hits` descending) and narrowed here.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Table,
  type TableColumn,
} from '@/components/ui'
import { IconSearch, IconTrash } from '@/components/layout/icons'
import { getDb } from '@/db/db'
import { translationMemoryRepo } from '@/db/repo-knowledge'
import type { TranslationMemoryRecord } from '@/db/types'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/stores/toastStore'

const LANGUAGE_CODES = ['en', 'my', 'zh', 'ja', 'ar', 'hi'] as const
const TOP_LIMIT = 100
const NO_ROWS: TranslationMemoryRecord[] = []

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TmTab() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'my' ? 'my-MM' : 'en-US'

  const [sourceLang, setSourceLang] = useState('all')
  const [targetLang, setTargetLang] = useState('all')
  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<TranslationMemoryRecord | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)

  const allRows =
    useLiveQuery(() => translationMemoryRepo.top(Number.MAX_SAFE_INTEGER), []) ?? NO_ROWS

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows
      .filter(
        (row) =>
          (sourceLang === 'all' || row.sourceLang === sourceLang) &&
          (targetLang === 'all' || row.targetLang === targetLang),
      )
      .filter(
        (row) =>
          needle.length === 0 ||
          row.sourceText.toLowerCase().includes(needle) ||
          row.targetText.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.hits - a.hits || b.lastUsedAt - a.lastUsedAt)
      .slice(0, TOP_LIMIT)
  }, [allRows, sourceLang, targetLang, search])

  const languageOptions = [
    { value: 'all', label: t('knowledge.tm.allLanguages') },
    ...LANGUAGE_CODES.map((code) => ({ value: code, label: t(`knowledge.tm.lang.${code}`) })),
  ]

  async function confirmDeleteRow() {
    if (!pendingDelete) return
    // The repository has no per-row remove yet, so the table handles it directly.
    await getDb().translationMemory.delete(pendingDelete.id)
    setPendingDelete(null)
  }

  async function clearAll() {
    setBusy(true)
    try {
      await translationMemoryRepo.clear()
      toast('success', t('knowledge.tm.clearedTitle'))
      setConfirmClear(false)
    } catch (error) {
      toast('danger', t('toast.failed'), messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const columns: TableColumn<TranslationMemoryRecord>[] = [
    {
      key: 'source',
      header: t('knowledge.tm.colSource'),
      render: (row) => <span className="block whitespace-normal">{row.sourceText}</span>,
    },
    {
      key: 'target',
      header: t('knowledge.tm.colTarget'),
      render: (row) => <span className="block whitespace-normal text-muted">{row.targetText}</span>,
    },
    {
      key: 'hits',
      header: t('knowledge.tm.colHits'),
      align: 'right',
      render: (row) => <span className="tabular-nums">{row.hits}</span>,
    },
    {
      key: 'updated',
      header: t('common.updated'),
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-muted">
          {formatDateTime(row.updatedAt, locale)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      align: 'right',
      render: (row) => (
        <IconButton
          size="sm"
          variant="danger"
          label={t('knowledge.tm.deleteLabel')}
          icon={<IconTrash />}
          onClick={() => setPendingDelete(row)}
        />
      ),
    },
  ]

  const caption = t('knowledge.tm.caption')

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-2 sm:gap-3">
          <div className="w-44">
            <Select
              label={t('knowledge.tm.sourceLang')}
              value={sourceLang}
              onChange={(event) => setSourceLang(event.target.value)}
              options={languageOptions}
            />
          </div>
          <div className="w-44">
            <Select
              label={t('knowledge.tm.targetLang')}
              value={targetLang}
              onChange={(event) => setTargetLang(event.target.value)}
              options={languageOptions}
            />
          </div>
          <div className="min-w-48 flex-1">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('knowledge.tm.searchPlaceholder')}
              aria-label={t('knowledge.tm.searchPlaceholder')}
              iconLeft={<IconSearch className="h-4 w-4" />}
            />
          </div>
          <Button
            size="sm"
            variant="danger"
            iconLeft={<IconTrash className="h-4 w-4" />}
            disabled={allRows.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            {t('knowledge.tm.clear')}
          </Button>
        </div>
      </Card>

      {allRows.length === 0 ? (
        <EmptyState title={t('knowledge.tm.emptyTitle')} body={t('knowledge.tm.emptyBody')} />
      ) : (
        <>
          <p className="text-xs text-muted">{caption}</p>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={caption}
            empty={
              <EmptyState
                size="sm"
                title={t('knowledge.tm.noResults')}
                action={
                  <Button size="sm" onClick={() => setSearch('')}>
                    {t('common.clear')}
                  </Button>
                }
              />
            }
          />
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('knowledge.tm.deleteTitle')}
        body={t('knowledge.tm.deleteBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        onConfirm={() => void confirmDeleteRow()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={confirmClear}
        title={t('knowledge.tm.clearTitle')}
        body={t('knowledge.tm.clearBody')}
        confirmLabel={t('knowledge.tm.clear')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        loading={busy}
        onConfirm={() => void clearAll()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}
