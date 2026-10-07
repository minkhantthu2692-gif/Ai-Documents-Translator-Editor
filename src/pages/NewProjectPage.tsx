import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Progress,
  Select,
  Stepper,
  Switch,
  Textarea,
  type BadgeTone,
} from '@/components/ui'
import { DropZone } from '@/components/ui/DropZone'
import { StatusPanel } from '@/components/ui/StatusPanel'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { IconCheck, IconFile, IconTrash } from '@/components/layout/icons'
import { createId } from '@/core/id'
import { logEvent } from '@/core/eventLogger'
import { REASON_CODES, type ReasonCode } from '@/core/reasonCodes'
import { toast } from '@/stores/toastStore'
import { projectRepo } from '@/db/repo-projects'
import { sourceFileRepo } from '@/db/repo-sourceFiles'
import { checkPdfFile, isFileSizeWarning } from '@/pdf/fileValidation'
import { AnalysisCancelled, AnalysisError, analysisClient } from '@/pdf/analysisClient'
import { closeDocument, isDocumentOpen, openDocument, persistProbe } from '@/pdf/projectAnalysis'
import {
  estimateTranslationWork,
  isReadyToStart,
  primaryBlocker,
  runPreflight,
  type PreflightCheck,
} from '@/pdf/preflight'
import { startParse } from '@/pdf/parseQueue'
import type { ProbeResult } from '@/pdf/pdfExtract'
import { isOcrAvailable, isOcrLanguageSupported } from '@/ocr/ocrClient'

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

/**
 * Free-tier limits handed to the quota check. Deliberately unset in Phase 2:
 * no AI provider is configured yet (apiKey/provider checks are pending too), so
 * inventing a limit here would block Start on every large document. Phase 3
 * replaces this with the limits of the configured provider.
 */
const FREE_TIER = { maxRequests: 0, maxTokens: 0 }

type FileStatus = 'queued' | 'analyzing' | 'ready' | 'password' | 'error'

interface PickedFile {
  /** createId('src') — becomes the sourceFileRepo row id. */
  id: string
  file: File
  name: string
  size: number
  valid: boolean
  invalidReason: ReasonCode | null
  status: FileStatus
  /** 0..100 while the probe runs. */
  progress: number
  pageCount: number
  password?: string
  passwordReason?: 'missing' | 'incorrect'
  probe?: ProbeResult
  errorReason?: ReasonCode
}

interface RejectedFile {
  id: string
  name: string
  reason: ReasonCode
}

const STATUS_LABEL: Record<FileStatus, string> = {
  queued: 'newProject.fileQueued',
  analyzing: 'newProject.fileAnalyzing',
  ready: 'newProject.fileReady',
  password: 'newProject.filePassword',
  error: 'newProject.fileFailed',
}

const STATUS_TONE: Record<FileStatus, BadgeTone> = {
  queued: 'neutral',
  analyzing: 'primary',
  ready: 'success',
  password: 'warning',
  error: 'danger',
}

function languageLabel(value: string): string {
  const match = LANGUAGES.find((language) => language.value === value)
  return match ? `${match.label} (${match.native})` : value
}

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '')
}

function formatSize(bytes: number, kB: string, MB: string): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${MB}`
  return `${Math.max(1, Math.round(bytes / 1024))} ${kB}`
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function reasonMessage(code: ReasonCode, isMy: boolean): string {
  const definition = REASON_CODES[code]
  return isMy ? definition.messageMy : definition.messageEn
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-3 py-2">
      <dt className="text-xs leading-[1.75] text-faint">{label}</dt>
      {/* Unknown metadata renders as an em dash, never as an empty row. */}
      <dd className="mt-0.5 truncate text-sm font-medium leading-[1.75] text-text">
        {value.trim() ? value : '—'}
      </dd>
    </div>
  )
}

function FileRow({
  file,
  onRemove,
  showRemove,
}: {
  file: PickedFile
  onRemove: (id: string) => void
  showRemove?: boolean
}) {
  const { t, i18n } = useTranslation()
  const isMy = i18n.language?.startsWith('my') ?? false
  const large = isFileSizeWarning(file.size)

  return (
    <li
      data-testid="file-row"
      className="flex items-start gap-3 rounded-md border border-border bg-surface px-3 py-2.5"
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-faint">
        <IconFile className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm leading-[1.75] text-text">{file.name}</p>
          <Badge tone={STATUS_TONE[file.status]}>{t(STATUS_LABEL[file.status])}</Badge>
        </div>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-[1.75] text-muted">
          {file.pageCount > 0 ? (
            <span>{t('newProject.pagesCount', { count: file.pageCount })}</span>
          ) : null}
          <span className={large ? 'text-warning' : undefined}>
            {formatSize(file.size, t('common.kB'), t('common.mB'))}
          </span>
          {file.status === 'error' && file.errorReason ? (
            <span className="text-danger">{reasonMessage(file.errorReason, isMy)}</span>
          ) : null}
          {file.status === 'password' && file.passwordReason === 'incorrect' ? (
            <span className="text-danger">{t('newProject.passwordIncorrect')}</span>
          ) : null}
        </p>

        {file.status === 'analyzing' ? (
          <Progress
            className="mt-2"
            size="sm"
            value={file.progress}
            label={t('newProject.fileAnalyzing')}
            showLabel
          />
        ) : null}
      </div>

      {showRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 mt-0.5 shrink-0"
          data-testid="file-remove"
          aria-label={`${t('common.remove')} — ${file.name}`}
          title={t('common.remove')}
          onClick={() => onRemove(file.id)}
        >
          <IconTrash className="h-4 w-4" />
        </Button>
      ) : null}
    </li>
  )
}

export function NewProjectPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const isMy = i18n.language?.startsWith('my') ?? false

  const [step, setStep] = useState(0)
  const [files, setFiles] = useState<PickedFile[]>([])
  const [rejected, setRejected] = useState<RejectedFile[]>([])
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [sourceLang, setSourceLang] = useState('en')
  const [targetLang, setTargetLang] = useState('my')
  const [autoDetected, setAutoDetected] = useState(false)
  const [runOcr, setRunOcr] = useState(true)
  const [useTm, setUseTm] = useState(true)
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [passwordFor, setPasswordFor] = useState<string | null>(null)
  const [passwordValue, setPasswordValue] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)

  /** Authoritative list for the async analysis loop (state mirrors it). */
  const filesRef = useRef<PickedFile[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)
  const manualSourceRef = useRef(false)
  /** Set once the files have been handed over to real projects. */
  const handedOffRef = useRef(false)

  const commitFiles = useCallback((next: PickedFile[]) => {
    filesRef.current = next
    setFiles(next)
  }, [])

  const patchFile = useCallback(
    (id: string, patch: Partial<PickedFile>) => {
      commitFiles(filesRef.current.map((file) => (file.id === id ? { ...file, ...patch } : file)))
    },
    [commitFiles],
  )

  const ensureController = useCallback((): AbortController => {
    const current = controllerRef.current
    if (current && !current.signal.aborted) return current
    const controller = new AbortController()
    controllerRef.current = controller
    return controller
  }, [])

  /** Opens one file in the worker and probes it. Stops on a password request. */
  const analyzeFile = useCallback(
    async (id: string, signal: AbortSignal): Promise<'done' | 'password'> => {
      const current = filesRef.current.find((file) => file.id === id)
      if (!current) return 'done'
      try {
        const outcome = await openDocument(id, current.file, {
          password: current.password,
          signal,
        })
        if (signal.aborted) return 'done'
        if (outcome.status === 'password') {
          patchFile(id, { status: 'password', passwordReason: outcome.reason })
          return 'password'
        }
        patchFile(id, { status: 'analyzing', pageCount: outcome.pageCount, progress: 0 })
        const probe = await analysisClient.probe(id, {
          signal,
          onProgress: (done, total) => {
            patchFile(id, { progress: total > 0 ? Math.round((done / total) * 100) : 0 })
          },
        })
        if (signal.aborted) return 'done'
        patchFile(id, { status: 'ready', probe, progress: 100 })
        return 'done'
      } catch (caught) {
        if (caught instanceof AnalysisCancelled || signal.aborted) return 'done'
        patchFile(id, {
          status: 'error',
          errorReason: caught instanceof AnalysisError ? caught.reasonCode : 'PDF_CORRUPTED',
        })
        return 'done'
      }
    },
    [patchFile],
  )

  /**
   * Analyses queued files one at a time. It always reads the *current* list,
   * so files added while a run is going are picked up by the same loop, and it
   * stops (leaving the modal to take over) as soon as a file needs a password.
   */
  const runQueue = useCallback(async (): Promise<void> => {
    if (runningRef.current) return
    const controller = ensureController()
    runningRef.current = true
    try {
      for (;;) {
        const next = filesRef.current.find((file) => file.status === 'queued')
        if (!next || controller.signal.aborted) return
        const result = await analyzeFile(next.id, controller.signal)
        if (result === 'password') {
          setPasswordFor(next.id)
          setPasswordValue('')
          return
        }
      }
    } finally {
      runningRef.current = false
    }
  }, [analyzeFile, ensureController])

  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
      if (handedOffRef.current) return
      const open = filesRef.current
        .filter((file) => isDocumentOpen(file.id))
        .map((file) => closeDocument(file.id))
      void Promise.all(open)
    }
  }, [])

  async function handleFiles(list: File[]) {
    const added: PickedFile[] = []
    const skipped: RejectedFile[] = []
    for (const file of list) {
      const duplicate =
        filesRef.current.some((picked) => picked.name === file.name && picked.size === file.size) ||
        skipped.some((item) => item.name === file.name)
      if (duplicate) continue
      const check = await checkPdfFile(file)
      if (check.ok) {
        added.push({
          id: createId('src'),
          file,
          name: file.name,
          size: file.size,
          valid: true,
          invalidReason: null,
          status: 'queued',
          progress: 0,
          pageCount: 0,
        })
      } else if (check.reasonCode) {
        skipped.push({ id: createId('rej'), name: file.name, reason: check.reasonCode })
      }
    }
    if (added.length > 0) commitFiles([...filesRef.current, ...added])
    if (skipped.length > 0) {
      setRejected((current) => {
        const fresh = skipped.filter((item) => !current.some((seen) => seen.name === item.name))
        return fresh.length > 0 ? [...current, ...fresh] : current
      })
    }
  }

  function removeFile(id: string) {
    void closeDocument(id)
    commitFiles(filesRef.current.filter((file) => file.id !== id))
    if (passwordFor === id) {
      setPasswordFor(null)
      setPasswordValue('')
    }
  }

  function closePasswordModal() {
    if (passwordBusy) return
    setPasswordFor(null)
    setPasswordValue('')
    // The locked file stays in `password`; everything queued behind it continues.
    void runQueue()
  }

  async function submitPassword(event?: FormEvent) {
    event?.preventDefault()
    const id = passwordFor
    if (!id || passwordBusy) return
    const controller = ensureController()
    setPasswordBusy(true)
    try {
      patchFile(id, {
        status: 'analyzing',
        progress: 0,
        password: passwordValue,
        passwordReason: undefined,
      })
      const result = await analyzeFile(id, controller.signal)
      if (result === 'password') return // wrong password — the inline error shows
      setPasswordFor(null)
      setPasswordValue('')
      await runQueue()
    } finally {
      setPasswordBusy(false)
    }
  }

  function skipPasswordFile() {
    const id = passwordFor
    if (!id) return
    setPasswordFor(null)
    setPasswordValue('')
    removeFile(id)
    void runQueue()
  }

  function handleFix(check: PreflightCheck) {
    const locked = filesRef.current.find((file) => file.status === 'password')
    const wantsPassword = check.id === 'encryption' || check.fix?.id === 'enter_password'
    const blockedByLock = locked !== undefined && (check.id === 'pages' || check.id === 'integrity')
    if ((wantsPassword || blockedByLock) && locked) {
      setPasswordFor(locked.id)
      setPasswordValue(locked.password ?? '')
      return
    }
    // "Run OCR" cannot start from the wizard — OCR runs in the workspace right
    // after Start — so the fix switches the option on and says where it runs.
    if (check.fix?.id === 'run_ocr') {
      setRunOcr(true)
      toast('info', t('newProject.ocrOfferAction'), t('newProject.ocrToggle'))
      return
    }
    const action = check.fix
      ? isMy
        ? check.fix.labelMy
        : check.fix.labelEn
      : isMy
        ? check.detailMy
        : check.detailEn
    toast('info', t(check.labelKey), action)
  }

  function applyDetectedLanguage() {
    if (manualSourceRef.current) return
    const first = filesRef.current.find((file) => file.status === 'ready' && file.probe)
    const detected = first?.probe?.summary.documentLanguage ?? null
    if (!detected || detected === targetLang) return
    if (!LANGUAGES.some((language) => language.value === detected)) return
    setSourceLang(detected)
    setAutoDetected(true)
  }

  function goNext() {
    if (step === 0) {
      setRejected([])
      setStep(1)
      void runQueue()
      return
    }
    if (step === 1) {
      const first = filesRef.current[0]
      if (first && !name.trim()) setName(baseName(first.name))
      applyDetectedLanguage()
      setStep(2)
    }
  }

  function goBack() {
    setNameError(null)
    setStep((current) => Math.max(0, current - 1))
  }

  function nameFor(file: PickedFile, total: number): string {
    const base = name.trim()
    if (total === 1) return base
    return `${base} — ${baseName(file.name)}`.slice(0, 120)
  }

  async function start() {
    if (busy) return
    if (!name.trim()) {
      setNameError(t('newProject.nameRequired'))
      return
    }
    const ready = filesRef.current.flatMap((file) =>
      file.probe ? [{ file, probe: file.probe }] : [],
    )
    if (ready.length === 0 || ready.length !== filesRef.current.length) {
      toast('warning', t('newProject.analysisWait'))
      return
    }
    if (!isReadyToStart(checks)) {
      const blocker = primaryBlocker(checks)
      toast(
        'warning',
        t('status.blocked'),
        blocker ? (isMy ? blocker.detailMy : blocker.detailEn) : t('status.startHint'),
      )
      return
    }

    setBusy(true)
    try {
      const projectIds: string[] = []
      for (const { file, probe } of ready) {
        const project = await projectRepo.create({
          name: nameFor(file, ready.length),
          sourceLang,
          targetLang,
          sourceFileName: file.name,
          sourceFileSize: file.size,
          notes: notes.trim(),
        })
        await sourceFileRepo.put({
          id: file.id,
          projectId: project.id,
          file: file.file,
          name: file.name,
          pageCount: file.pageCount,
          // Kept so a reload can re-open an encrypted source without
          // prompting (parsing and thumbnails run on every session).
          password: file.password,
        })
        await persistProbe(project.id, probe)
        startParse(project.id, file.pageCount)
        projectIds.push(project.id)
        logEvent({
          state: 'PROJECT',
          action: 'project.create',
          projectId: project.id,
          severity: 'success',
          messageMy: `စီမံကိန်း ဖန်တီးပြီး: ${project.name}`,
          messageEn: `Project created: ${project.name}`,
          technicalDetail: `${sourceLang}→${targetLang} id=${project.id}`,
        })
      }
      // The cleanup must not close the documents these projects now own.
      handedOffRef.current = true
      toast('success', t('newProject.projectsCreated', { count: projectIds.length }), name.trim())
      navigate(`/workspace/${projectIds[0]}`)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
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

  const languageOptions = useMemo(
    () =>
      LANGUAGES.map((language) => ({
        value: language.value,
        label: `${language.label} — ${language.native}`,
      })),
    [],
  )

  const steps = [
    { id: 'select', label: t('newProject.stepSelect') },
    { id: 'metadata', label: t('newProject.stepMetadata') },
    { id: 'translate', label: t('newProject.stepTranslate') },
  ]

  const waiting = files.some((file) => file.status === 'queued' || file.status === 'analyzing')
  /**
   * Next is gated by analysis only once the metadata step has kicked it off —
   * on the select step every file is `queued` by definition, so requiring
   * "not waiting" there would deadlock the wizard.
   */
  const canNext = files.length > 0 && (step === 0 || !waiting)

  const estimate = useMemo(() => {
    let characters = 0
    let blocks = 0
    for (const file of files) {
      if (!file.probe) continue
      characters += file.probe.summary.totalChars
      blocks += file.probe.probes.reduce((sum, page) => sum + page.lineCount, 0)
    }
    return estimateTranslationWork(characters, blocks)
  }, [files])

  const checks = useMemo<PreflightCheck[]>(() => {
    // While a file is still queued or analysed the panel waits instead of guessing.
    if (files.length === 0 || waiting) return []
    return runPreflight({
      files: files.map((file) => {
        const scanned = file.probe?.summary.ocrNeededPages ?? 0
        return {
          fileName: file.name,
          sizeBytes: file.size,
          pageCount: file.pageCount,
          valid: file.valid,
          invalidReason: file.invalidReason,
          corrupted: file.status === 'error',
          encrypted: file.status === 'password' || (file.probe?.info.encrypted ?? false),
          passwordProvided: Boolean(file.password),
          passwordAccepted: file.status === 'ready',
          textPageCount: file.probe?.summary.textLayerPages ?? 0,
          scannedPageCount: scanned,
          ocrAvailable: isOcrAvailable() && isOcrLanguageSupported(sourceLang),
          ocrEnabled: runOcr && scanned > 0,
          ocrDonePageCount: 0,
        }
      }),
      sourceLang,
      targetLang,
      apiKeyStatus: 'stub',
      provider: null,
      model: null,
      aiReady: false,
      freeTier: FREE_TIER,
      estimate,
    })
  }, [files, waiting, sourceLang, targetLang, runOcr, estimate])

  const readyToStart = checks.length > 0 && isReadyToStart(checks)
  const readyProbe = files.find((file) => file.status === 'ready' && file.probe)?.probe ?? null
  const passwordTarget = files.find((file) => file.id === passwordFor) ?? null
  const passwordError =
    passwordTarget?.passwordReason === 'incorrect' ? t('newProject.passwordIncorrect') : undefined

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
              <DropZone
                multiple
                accept=".pdf,application/pdf"
                data-testid="project-dropzone"
                onFiles={handleFiles}
                title={files.length > 0 ? t('newProject.addMore') : undefined}
              />

              <h3 className="text-[13px] font-medium text-text">{t('newProject.filesLabel')}</h3>

              {files.length === 0 ? (
                <div className="flex flex-col gap-1 rounded-md border border-dashed border-border px-3 py-6 text-center">
                  <p className="text-sm font-medium leading-[1.75] text-text">
                    {t('newProject.noneSelected')}
                  </p>
                  <p className="text-xs leading-[1.75] text-muted">{t('newProject.selectHint')}</p>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {files.map((file) => (
                    <FileRow key={file.id} file={file} onRemove={removeFile} showRemove />
                  ))}
                </ul>
              )}

              {rejected.length > 0 ? (
                <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2.5">
                  <p className="text-xs font-semibold leading-[1.75] text-danger">
                    {t('dropzone.rejected', { count: rejected.length })}
                  </p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {rejected.map((item) => (
                      <li key={item.id} className="text-xs leading-[1.75] text-muted">
                        <span className="font-medium text-text">{item.name}</span>
                        {' — '}
                        {reasonMessage(item.reason, isMy)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}

          {step === 1 ? (
            <>
              {files.length === 0 ? (
                <p className="text-xs leading-[1.75] text-muted">{t('newProject.noneSelected')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {files.map((file) => (
                    <FileRow key={file.id} file={file} onRemove={removeFile} showRemove />
                  ))}
                </ul>
              )}

              {waiting ? (
                <p role="status" className="text-xs leading-[1.75] text-muted">
                  {t('newProject.analysisWait')}
                </p>
              ) : null}

              {readyProbe ? (
                <section className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[13px] font-medium text-text">
                      {t('newProject.metaTitle')}
                    </h3>
                    {readyProbe.summary.convertZawgyi ? (
                      <Badge tone="info">{t('newProject.metaZawgyi')}</Badge>
                    ) : null}
                  </div>

                  <dl
                    data-testid="metadata-table"
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                  >
                    <MetaRow
                      label={t('newProject.metaPages')}
                      value={String(readyProbe.info.pageCount)}
                    />
                    <MetaRow
                      label={t('newProject.metaVersion')}
                      value={readyProbe.info.pdfVersion ?? '—'}
                    />
                    <MetaRow
                      label={t('newProject.metaDocTitle')}
                      value={readyProbe.info.title ?? '—'}
                    />
                    <MetaRow
                      label={t('newProject.metaAuthor')}
                      value={readyProbe.info.author ?? '—'}
                    />
                    <MetaRow
                      label={t('newProject.metaProducer')}
                      value={readyProbe.info.producer ?? '—'}
                    />
                    <MetaRow
                      label={t('newProject.metaCreated')}
                      value={formatDate(readyProbe.info.creationDate)}
                    />
                    <MetaRow
                      label={t('newProject.metaModified')}
                      value={formatDate(readyProbe.info.modificationDate)}
                    />
                    <MetaRow
                      label={t('newProject.metaLanguage')}
                      value={languageLabel(
                        readyProbe.summary.documentLanguage ?? readyProbe.info.language ?? '',
                      )}
                    />
                    <MetaRow
                      label={t('newProject.metaFonts')}
                      value={`${readyProbe.info.fonts.embedded} / ${readyProbe.info.fonts.standard} / ${readyProbe.info.fonts.other}`}
                    />
                    <MetaRow
                      label={t('newProject.metaImages')}
                      value={String(readyProbe.summary.totalImages)}
                    />
                    <MetaRow
                      label={t('newProject.metaAnnotations')}
                      value={String(readyProbe.summary.annotations)}
                    />
                    <MetaRow
                      label={t('newProject.metaFormFields')}
                      value={String(readyProbe.summary.formFields)}
                    />
                    <MetaRow
                      label={t('newProject.metaTextPages')}
                      value={String(readyProbe.summary.textLayerPages)}
                    />
                    <MetaRow
                      label={t('newProject.metaScannedPages')}
                      value={String(readyProbe.summary.ocrNeededPages)}
                    />
                    <MetaRow
                      label={t('newProject.metaMixedPages')}
                      value={String(readyProbe.summary.tally.mixed)}
                    />
                  </dl>

                  {readyProbe.summary.ocrNeededPages > 0 ? (
                    <div className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2.5">
                      <p className="text-xs font-semibold leading-[1.75] text-warning">
                        {t('newProject.ocrOffer', {
                          count: readyProbe.summary.ocrNeededPages,
                        })}
                      </p>
                      <p className="mt-0.5 text-xs leading-[1.75] text-muted">
                        {t('newProject.ocrOfferAction')}
                      </p>
                    </div>
                  ) : null}
                </section>
              ) : null}

              <StatusPanel data-testid="preflight" checks={checks} onFix={handleFix} />
            </>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-4">
              <Input
                label={t('newProject.projectName')}
                placeholder={t('newProject.projectNamePlaceholder')}
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setNameError(null)
                }}
                error={nameError ?? undefined}
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                  label={t('newProject.sourceLanguage')}
                  options={languageOptions}
                  value={sourceLang}
                  hint={autoDetected ? t('newProject.languageAuto') : undefined}
                  onChange={(event) => {
                    manualSourceRef.current = true
                    setAutoDetected(false)
                    setSourceLang(event.target.value)
                  }}
                  error={sourceLang === targetLang ? t('newProject.sameLanguage') : undefined}
                />
                <Select
                  label={t('newProject.targetLanguage')}
                  options={languageOptions}
                  value={targetLang}
                  onChange={(event) => setTargetLang(event.target.value)}
                  error={sourceLang === targetLang ? t('newProject.sameLanguage') : undefined}
                />
                <p className="text-xs leading-[1.75] text-muted sm:col-span-2">
                  {t('newProject.languagePair', {
                    source: languageLabel(sourceLang),
                    target: languageLabel(targetLang),
                  })}
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

              <StatusPanel
                data-testid="preflight"
                checks={checks}
                onFix={handleFix}
                onStart={() => void start()}
                startDisabled={busy}
                startLabel={t('newProject.startLabel')}
              />
              <p className="text-xs leading-[1.75] text-muted">{t('newProject.startHint')}</p>
            </div>
          ) : null}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-2">
        {step > 0 ? (
          <Button variant="secondary" data-testid="wizard-back" onClick={goBack}>
            {t('common.back')}
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}

        <div className="flex items-center gap-2">
          {step < steps.length - 1 ? (
            <Button
              variant="primary"
              data-testid="wizard-next"
              disabled={!canNext}
              onClick={goNext}
            >
              {t('common.next')}
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="wizard-start"
              loading={busy}
              disabled={!readyToStart}
              onClick={() => void start()}
            >
              {t('newProject.startLabel')}
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={passwordFor !== null}
        onClose={closePasswordModal}
        title={t('newProject.passwordTitle')}
        description={t('newProject.passwordDescription')}
        closeLabel={t('common.close')}
        size="sm"
      >
        <form
          data-testid="password-modal"
          className="flex flex-col gap-4"
          onSubmit={(event) => void submitPassword(event)}
        >
          <Input
            label={t('newProject.passwordLabel')}
            type="password"
            value={passwordValue}
            onChange={(event) => setPasswordValue(event.target.value)}
            placeholder={t('newProject.passwordPlaceholder')}
            hint={passwordError ? undefined : t('newProject.passwordMissing')}
            error={passwordError}
            autoComplete="off"
            data-testid="password-input"
            autoFocus
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" data-testid="password-skip" onClick={skipPasswordFile}>
              {t('newProject.passwordSkip')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={passwordBusy}
              data-testid="password-submit"
            >
              {t('newProject.passwordUnlock')}
            </Button>
          </div>
        </form>
      </Modal>
    </PageContainer>
  )
}
