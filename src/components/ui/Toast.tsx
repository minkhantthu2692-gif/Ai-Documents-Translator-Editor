import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useToastStore, type ToastTone } from '@/stores/toastStore'

const toneClasses: Record<ToastTone, { container: string; dot: string; role: 'status' | 'alert' }> =
  {
    info: { container: 'border-border bg-surface', dot: 'bg-info', role: 'status' },
    success: { container: 'border-success/50 bg-success-bg', dot: 'bg-success', role: 'status' },
    warning: { container: 'border-warning/50 bg-warning-bg', dot: 'bg-warning', role: 'alert' },
    danger: { container: 'border-danger/50 bg-danger-bg', dot: 'bg-danger', role: 'alert' },
  }

export function Toaster() {
  const { t } = useTranslation()
  const toasts = useToastStore((state) => state.toasts)
  const dismiss = useToastStore((state) => state.dismiss)

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottombar-height)+8px)] z-toast flex flex-col items-center gap-2 px-3 md:inset-x-auto md:bottom-4 md:right-4 md:items-end"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((item) => {
        const tone = toneClasses[item.tone]
        return (
          <div
            key={item.id}
            role={tone.role}
            className={cn(
              'toast-enter pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border px-3 py-2.5 shadow-panel',
              tone.container,
            )}
          >
            <span
              aria-hidden="true"
              className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone.dot)}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 break-words text-xs text-muted">{item.description}</p>
              ) : null}
              {item.action ? (
                <button
                  type="button"
                  onClick={() => {
                    item.action?.onClick()
                    dismiss(item.id)
                  }}
                  className="mt-1.5 text-xs font-medium text-accent underline-offset-4 hover:underline"
                >
                  {item.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label={t('toast.close')}
              className="-mr-1 rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-text"
            >
              <span aria-hidden="true" className="block h-3.5 w-3.5">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
