import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Input, Select, Stepper, Switch, Textarea } from '@/components/ui'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { IconFile, IconLanguage, IconCheck } from '@/components/layout/icons'
import { projectRepo } from '@/db/repo-projects'
import { logEvent } from '@/core/eventLogger'
import { toast } from '@/stores/toastStore'

/** Language names are shown in their own language (proper nouns). */
const LANGUAGES: Array<{ value: string; label: string; native: string }> = [
  { value: 'en', label: 'English', native: 'English' },
  { value: 'my', label: 'Burmese', native: 'မြန်မာ' },
  { value: 'th', label: 'Thai', native: 'ไทย' },
  { value: 'zh', label: 'Chinese', native: '中文' },
  { value: 'ja', label: 'Japanese', native: '日本語' },
  { value: 'ko', label: 'Korean', native: '한국어' },
  { value: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { value: 'fr', label: 'French', native: 'Français' },
  { value: 'es', label: 'Spanish', native: 'Español' },
  { value: 'de', label: 'German', native: 'Deutsch' },
  { value: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { value: 'hi', label: 'Hindi', native: 'हिन्दी' },
]

function languageLabel(value: string): string {
  const match = LANGUAGES.find((language) => language.value === value)
  return match ? `${match.label} (${match.native})` : value
}

export function NewProjectPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [sourceLang, setSourceLang] = useState('en')
  const [targetLang, setTargetLang] = useState('my')
  const [runOcr, setRunOcr] = useState(true)
  const [useTm, setUseTm] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const languageOptions = useMemo(
    () =>
      LANGUAGES.map((language) => ({
        value: language.value,
        label: `${language.label} — ${language.native}`,
      })),
    [],
  )

  const steps = [
    { id: 'details', label: t('newProject.stepName') },
    { id: 'languages', label: t('newProject.stepLanguages') },
    { id: 'options', label: t('newProject.stepOptions') },
    { id: 'review', label: t('newProject.stepReview') },
  ]

  const canNext =
    (step === 0 && name.trim().length > 0) ||
    (step === 1 && sourceLang !== targetLang) ||
    step === 2 ||
    step === 3

  function validate(): string | null {
    if (!name.trim()) return t('newProject.nameRequired')
    if (sourceLang === targetLang) return t('newProject.sameLanguage')
    return null
  }

  async function create() {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    try {
      const project = await projectRepo.create({
        name: name.trim(),
        sourceLang,
        targetLang,
        notes: notes.trim(),
      })
      logEvent({
        state: 'PROJECT',
        action: 'project.create',
        projectId: project.id,
        severity: 'success',
        messageMy: `စီမံကိန်း ဖန်တီးပြီး: ${project.name}`,
        messageEn: `Project created: ${project.name}`,
        technicalDetail: `${sourceLang}→${targetLang} id=${project.id}`,
      })
      toast('success', t('newProject.created'), project.name)
      navigate(`/workspace/${project.id}`)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      logEvent({
        state: 'PROJECT',
        action: 'project.create.failed',
        severity: 'error',
        messageMy: 'စီမံကိန်း ဖန်တီး၍ မရပါ',
        messageEn: 'Project could not be created',
        technicalDetail: message,
      })
      toast('danger', t('toast.failed'), message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('newProject.title')}
        subtitle={t('newProject.subtitle')}
        actions={
          <Link to="/projects">
            <Button variant="ghost" size="sm">
              {t('common.cancel')}
            </Button>
          </Link>
        }
      />

      <Card>
        <Stepper
          items={steps}
          current={step}
          ariaLabel={t('newProject.title')}
          renderMarker={(_item, index) =>
            index < step ? <IconCheck className="h-3 w-3" /> : index + 1
          }
        />
      </Card>

      <Card
        title={steps[step].label}
        actions={
          <span className="text-xs text-faint">
            {step + 1} / {steps.length}
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          {step === 0 ? (
            <>
              <Input
                label={t('newProject.projectName')}
                placeholder={t('newProject.projectNamePlaceholder')}
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setError(null)
                }}
                error={error && !name.trim() ? error : undefined}
                maxLength={120}
                autoFocus
              />
              <Textarea
                label={t('newProject.notes')}
                placeholder={t('newProject.notesPlaceholder')}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
              />
            </>
          ) : null}

          {step === 1 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label={t('newProject.sourceLanguage')}
                options={languageOptions}
                value={sourceLang}
                onChange={(event) => {
                  setSourceLang(event.target.value)
                  setError(null)
                }}
                error={sourceLang === targetLang ? t('newProject.sameLanguage') : undefined}
              />
              <Select
                label={t('newProject.targetLanguage')}
                options={languageOptions}
                value={targetLang}
                onChange={(event) => {
                  setTargetLang(event.target.value)
                  setError(null)
                }}
                error={sourceLang === targetLang ? t('newProject.sameLanguage') : undefined}
              />
              <p className="text-xs text-muted sm:col-span-2">
                {t('newProject.languagePair', {
                  source: languageLabel(sourceLang),
                  target: languageLabel(targetLang),
                })}
              </p>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3 rounded-md border border-dashed border-border bg-raised/40 px-3 py-3">
                <span aria-hidden="true" className="mt-0.5 text-faint">
                  <IconFile className="h-4 w-4" />
                </span>
                <p className="text-xs leading-relaxed text-muted">
                  <span className="font-medium text-text">{t('newProject.sourceFile')}</span>
                  <br />
                  {t('newProject.sourceFileHint')}
                </p>
              </div>
              <Switch
                checked={runOcr}
                onChange={setRunOcr}
                label={t('newProject.ocrToggle')}
                description={t('newProject.ocrToggleDesc')}
              />
              <Switch
                checked={useTm}
                onChange={setUseTm}
                label={t('newProject.tmToggle')}
                description={t('newProject.tmToggleDesc')}
              />
            </div>
          ) : null}

          {step === 3 ? (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-md border border-border px-3 py-2">
                <dt className="text-xs text-faint">{t('newProject.projectName')}</dt>
                <dd className="mt-0.5 truncate font-medium text-text">{name || '—'}</dd>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <dt className="flex items-center gap-1.5 text-xs text-faint">
                  <IconLanguage className="h-3.5 w-3.5" />
                  {t('newProject.reviewTitle')}
                </dt>
                <dd className="mt-0.5 font-medium text-text">
                  {t('newProject.languagePair', {
                    source: languageLabel(sourceLang),
                    target: languageLabel(targetLang),
                  })}
                </dd>
              </div>
              <div className="rounded-md border border-border px-3 py-2 sm:col-span-2">
                <dt className="text-xs text-faint">{t('newProject.notes')}</dt>
                <dd className="mt-0.5 text-text">{notes || '—'}</dd>
              </div>
            </dl>
          ) : null}

          {error && step !== 0 ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <Button
          variant="secondary"
          disabled={step === 0}
          onClick={() => {
            setError(null)
            setStep((current) => Math.max(0, current - 1))
          }}
        >
          {t('common.back')}
        </Button>
        <div className="flex items-center gap-2">
          {step < steps.length - 1 ? (
            <Button
              variant="primary"
              disabled={!canNext}
              onClick={() => {
                const problem = validate()
                if (step === 0 && problem === t('newProject.nameRequired')) {
                  setError(problem)
                  return
                }
                if (step === 1 && sourceLang === targetLang) {
                  setError(t('newProject.sameLanguage'))
                  return
                }
                setError(null)
                setStep((current) => Math.min(steps.length - 1, current + 1))
              }}
            >
              {t('common.next')}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void create()}>
              {t('newProject.create')}
            </Button>
          )}
        </div>
      </div>
    </PageContainer>
  )
}
