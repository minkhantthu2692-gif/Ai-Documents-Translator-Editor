import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, Select } from '@/components/ui'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { cn } from '@/lib/cn'

const FONT_OPTIONS = [
  { value: "'Noto Sans Myanmar', sans-serif", label: 'Noto Sans Myanmar' },
  { value: "'Padauk', sans-serif", label: 'Padauk' },
  { value: "'Noto Serif', serif", label: 'Noto Serif (fallback)' },
]

const SAMPLES = [
  {
    id: 'stacked',
    titleKey: 'myanmarTest.stacked',
    descKey: 'myanmarTest.stackedDesc',
    textKey: 'myanmarTest.sampleStacked',
  },
  {
    id: 'medials',
    titleKey: 'myanmarTest.medials',
    descKey: 'myanmarTest.medialsDesc',
    textKey: 'myanmarTest.sampleMedials',
  },
  {
    id: 'ligatures',
    titleKey: 'myanmarTest.ligatures',
    descKey: 'myanmarTest.ligaturesDesc',
    textKey: 'myanmarTest.sampleLigatures',
  },
] as const

export function MyanmarTestPage() {
  const { t } = useTranslation()
  const [fontFamily, setFontFamily] = useState(FONT_OPTIONS[0].value)
  const [fontSize, setFontSize] = useState(24)
  const [lineHeight, setLineHeight] = useState(1.75)

  return (
    <PageContainer>
      <PageHeader
        title={t('myanmarTest.title')}
        subtitle={t('myanmarTest.subtitle')}
        meta={<Badge tone="primary">/dev/myanmar-test</Badge>}
      />

      <Card title={t('myanmarTest.fonts')} description={t('myanmarTest.fontsDesc')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Select
            label={t('myanmarTest.fonts')}
            options={FONT_OPTIONS}
            value={fontFamily}
            onChange={(event) => setFontFamily(event.target.value)}
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-text">{t('myanmarTest.lineHeight')}</span>
            <input
              type="range"
              min={1.4}
              max={2.4}
              step={0.05}
              value={lineHeight}
              onChange={(event) => setLineHeight(Number(event.target.value))}
              className="h-9 w-full accent-[rgb(var(--color-primary))]"
              aria-describedby="lh-hint"
            />
            <span id="lh-hint" className="text-xs text-muted">
              {t('myanmarTest.lineHeightDesc')}
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-text">px</span>
            <input
              type="range"
              min={14}
              max={48}
              step={1}
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
              className="h-9 w-full accent-[rgb(var(--color-primary))]"
              aria-label={t('myanmarTest.fontSize')}
            />
            <span className="text-xs text-muted tabular-nums">{fontSize}px</span>
          </label>
        </div>
        <p className="mt-3 rounded-md border border-border bg-raised/50 px-3 py-2 text-xs text-muted">
          {t('myanmarTest.ratio', { size: fontSize, lh: lineHeight.toFixed(2) })}
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3">
        {SAMPLES.map((sample) => (
          <Card key={sample.id} title={t(sample.titleKey)} description={t(sample.descKey)}>
            <p
              lang="my"
              className={cn('rounded-md border border-border bg-raised/40 px-3 py-3 text-text')}
              style={{
                fontFamily,
                fontSize: `${fontSize}px`,
                lineHeight,
                wordBreak: 'break-word',
              }}
            >
              {t(sample.textKey)}
            </p>
          </Card>
        ))}
      </div>

      <Card title={t('myanmarTest.sampleParagraph')}>
        <p
          lang="my"
          className="text-text"
          style={{
            fontFamily,
            fontSize: `${Math.max(16, fontSize - 4)}px`,
            lineHeight: Math.max(1.75, lineHeight),
          }}
        >
          {t('myanmarTest.sampleParagraph')}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setLineHeight(1.75)
              setFontSize(24)
              setFontFamily(FONT_OPTIONS[0].value)
            }}
          >
            {t('common.reset')}
          </Button>
          <Badge tone="success">line-height ≥ 1.7</Badge>
        </div>
      </Card>

      <Card title={t('myanmarTest.fonts')}>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            'Inter',
            'Roboto',
            'Noto Sans',
            'Noto Serif',
            'Source Serif 4',
            'Noto Sans Myanmar',
            'Padauk',
          ].map((family) => (
            <li
              key={family}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
            >
              <span className="truncate text-sm text-text" style={{ fontFamily: `'${family}'` }}>
                {family}
              </span>
              <span className="text-[11px] text-faint">Ag မ က</span>
            </li>
          ))}
        </ul>
      </Card>
    </PageContainer>
  )
}
