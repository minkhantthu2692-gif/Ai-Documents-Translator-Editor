/**
 * Troubleshooting Assistant dialog.
 *
 * Renders the answer produced by `assistantStore` (proxy or offline rules),
 * the mode badge, and one button per safe action. Actions execute through
 * `runSafeAction` and report what happened with a toast; navigation, sync and
 * reload effects are applied here (the actions module stays router-free).
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Modal, Textarea } from '@/components/ui'
import { IconSparkle } from '@/components/layout/icons'
import { runSafeAction } from '@/assistant/actions'
import { assistantProxyUrl } from '@/assistant/client'
import { useAssistantStore } from '@/stores/assistantStore'
import { useSyncStore } from '@/sync/store'
import { toast } from '@/stores/toastStore'

export function AssistantDialog() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const open = useAssistantStore((state) => state.open)
  const question = useAssistantStore((state) => state.question)
  const answer = useAssistantStore((state) => state.answer)
  const mode = useAssistantStore((state) => state.mode)
  const model = useAssistantStore((state) => state.model)
  const fallbackReason = useAssistantStore((state) => state.fallbackReason)
  const busy = useAssistantStore((state) => state.busy)
  const error = useAssistantStore((state) => state.error)
  const seed = useAssistantStore((state) => state.seed)
  const setQuestion = useAssistantStore((state) => state.setQuestion)
  const ask = useAssistantStore((state) => state.ask)
  const closeDialog = useAssistantStore((state) => state.closeDialog)

  // Close = fresh start next time (keeps the question for follow-ups).
  const close = () => {
    useAssistantStore.getState().reset()
    closeDialog()
  }

  useEffect(() => {
    if (!open) return
    // Opening from a failure site may carry a seed; re-ask immediately so the
    // user sees an explanation without typing.
    if (!answer && !busy) void ask()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onAction = async (id: string) => {
    const syncContext = useSyncStore.getState().lastError !== null
    const outcome = await runSafeAction(id, { syncContext })
    toast(
      outcome.ok ? 'success' : 'warning',
      outcome.ok ? outcome.titleEn : outcome.titleMy,
      outcome.ok ? outcome.titleMy : outcome.titleEn,
    )

    if (outcome.effect?.type === 'navigate') {
      close()
      navigate(outcome.effect.to)
      return
    }
    if (outcome.effect?.type === 'sync-now') {
      close()
      void useSyncStore.getState().run('manual')
      return
    }
    if (outcome.effect?.type === 'reload') {
      window.location.reload()
    }
  }

  const hasProxy = assistantProxyUrl().length > 0

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={
        <span className="inline-flex items-center gap-2">
          <IconSparkle className="h-5 w-5" aria-hidden />
          {t('assistant.title')}
        </span>
      }
      description={t('assistant.subtitle')}
      closeLabel={t('common.close')}
    >
      <div data-testid="assistant-dialog" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="assistant-mode"
            data-mode={mode ?? 'offline'}
            className={
              mode === 'proxy'
                ? 'rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success'
                : 'rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning'
            }
          >
            {mode === 'proxy' ? t('assistant.mode.proxy') : t('assistant.mode.offline')}
          </span>
          {model ? <span className="text-xs text-fg-muted">{model}</span> : null}
        </div>

        <div className="flex flex-col gap-2">
          <Textarea
            data-testid="assistant-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('assistant.placeholder')}
            aria-label={t('assistant.placeholder')}
            rows={3}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void ask()
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-fg-muted">{t('assistant.hint')}</span>
            <Button
              data-testid="assistant-ask"
              variant="primary"
              loading={busy}
              iconLeft={<IconSparkle className="h-4 w-4" />}
              onClick={() => void ask()}
            >
              {busy ? t('assistant.thinking') : t('assistant.ask')}
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger" data-testid="assistant-error">
            {t('assistant.failed')}: {error}
          </p>
        ) : null}

        {seed ? (
          <p className="text-xs text-fg-muted" data-testid="assistant-context">
            {t('assistant.contextLabel')}
            {seed.errorCode ? ` · ${seed.errorCode}` : ''}
            {seed.reasonCode ? ` · ${seed.reasonCode}` : ''}
          </p>
        ) : null}

        {answer ? (
          <article data-testid="assistant-answer" className="flex flex-col gap-3">
            <h4 className="text-sm font-semibold text-fg">{answer.title}</h4>
            <p className="text-sm leading-6 text-fg-muted whitespace-pre-wrap">
              {answer.explanation}
            </p>

            {answer.steps.length > 0 ? (
              <section className="flex flex-col gap-1">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {t('assistant.stepsLabel')}
                </h5>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-fg">
                  {answer.steps.map((step, index) => (
                    <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
                  ))}
                </ol>
              </section>
            ) : null}

            {answer.actions.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {t('assistant.actionsLabel')}
                </h5>
                <div className="flex flex-wrap gap-2">
                  {answer.actions.map((action) => (
                    <Button
                      key={action.id}
                      data-testid={`assistant-action-${action.id}`}
                      size="sm"
                      onClick={() => void onAction(action.id)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              </section>
            ) : null}

            {mode === 'offline' ? (
              <p
                className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-muted"
                data-testid="assistant-fallback"
              >
                {hasProxy
                  ? t('assistant.fallbackNote', { reason: fallbackReason ?? '' })
                  : t('assistant.noProxyNote')}
              </p>
            ) : null}
          </article>
        ) : null}
      </div>
    </Modal>
  )
}
