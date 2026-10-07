/**
 * Templates tab of the Knowledge page (Phase 4): the four preset project
 * templates, their starter glossaries and apply / clear per project.
 *
 * Applying writes project-scoped glossary rows and merges the terminology
 * rules into the project's translate config (see `@/editor/templates`); the
 * current marker is read back through `currentTemplateId` in a live query so
 * the badge updates as soon as a template is applied or cleared.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Button, Card, ConfirmDialog, Select } from '@/components/ui'
import { projectRepo } from '@/db/repo-projects'
import {
  applyTemplate,
  clearTemplate,
  currentTemplateId,
  PROJECT_TEMPLATES,
  type ProjectTemplate,
} from '@/editor/templates'
import { toast } from '@/stores/toastStore'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TemplatesTab() {
  const { t, i18n } = useTranslation()

  const [projectId, setProjectId] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const projects = useLiveQuery(() => projectRepo.list(), [])
  const activeProjects = (projects ?? []).filter((project) => !project.archived)
  const appliedId = useLiveQuery(
    () => (projectId ? currentTemplateId(projectId) : Promise.resolve(null)),
    [projectId],
  )

  const projectName = activeProjects.find((project) => project.id === projectId)?.name ?? ''

  function localName(template: ProjectTemplate): string {
    return i18n.language === 'my' ? template.nameMy : template.nameEn
  }

  function localDescription(template: ProjectTemplate): string {
    return i18n.language === 'my' ? template.descriptionMy : template.descriptionEn
  }

  async function apply(template: ProjectTemplate) {
    if (!projectId) return
    setBusyId(template.id)
    try {
      const result = await applyTemplate(projectId, template.id)
      toast(
        'success',
        t('knowledge.templates.appliedTitle'),
        t('knowledge.templates.appliedBody', {
          name: localName(template),
          added: result.added,
          skipped: result.skipped,
        }),
      )
    } catch (error) {
      toast('danger', t('toast.failed'), messageOf(error))
    } finally {
      setBusyId(null)
    }
  }

  async function clearApplied() {
    if (!projectId) return
    setBusyId('clear')
    try {
      await clearTemplate(projectId)
      toast('success', t('knowledge.templates.clearedTitle'), projectName)
      setConfirmClear(false)
    } catch (error) {
      toast('danger', t('toast.failed'), messageOf(error))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Select
              label={t('knowledge.templates.projectLabel')}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder={t('knowledge.templates.projectPlaceholder')}
              options={activeProjects.map((project) => ({
                value: project.id,
                label: project.name,
              }))}
            />
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {t('knowledge.templates.explainer')}
        </p>
        {activeProjects.length === 0 ? (
          <p className="mt-1 text-[11px] text-faint">{t('knowledge.templates.emptyProjects')}</p>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {PROJECT_TEMPLATES.map((template) => {
          const applied = projectId !== '' && appliedId === template.id
          return (
            <Card key={template.id} className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-text">{localName(template)}</h3>
                    {applied ? (
                      <Badge tone="success">{t('knowledge.templates.appliedBadge')}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    {localDescription(template)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="info" title={t('knowledge.templates.qualityLabel')}>
                      {t(`knowledge.templates.quality.${template.quality}`)}
                    </Badge>
                    <Badge tone="primary" title={t('knowledge.templates.scopeLabel')}>
                      {t(`knowledge.templates.scope.${template.terminologyScope}`)}
                    </Badge>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={projectId === ''}
                    loading={busyId === template.id}
                    onClick={() => void apply(template)}
                  >
                    {t('common.apply')}
                  </Button>
                  {applied ? (
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busyId === 'clear'}
                      onClick={() => setConfirmClear(true)}
                    >
                      {t('knowledge.templates.clear')}
                    </Button>
                  ) : null}
                </div>
              </div>

              <details className="mt-3 border-t border-border pt-2">
                <summary className="cursor-pointer select-none text-xs font-medium text-accent">
                  {t('knowledge.templates.previewLabel', { count: template.glossary.length })}
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {template.glossary.map((term) => (
                    <li
                      key={term.sourceTerm}
                      className="flex flex-wrap items-baseline gap-2 text-xs"
                    >
                      <span className="font-medium text-text">{term.sourceTerm}</span>
                      <span aria-hidden="true" className="text-faint">
                        →
                      </span>
                      <span className="text-muted">{term.targetTerm}</span>
                      {term.notes ? <span className="text-faint">{term.notes}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          )
        })}
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t('knowledge.templates.clearTitle')}
        body={t('knowledge.templates.clearBody', { project: projectName })}
        confirmLabel={t('knowledge.templates.clear')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="danger"
        loading={busyId === 'clear'}
        onConfirm={() => void clearApplied()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}
