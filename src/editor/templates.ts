/**
 * Project templates (Phase 4).
 *
 * A template is a preset: terminology scope, prompt quality and a starter
 * glossary. Applying one writes project-scoped glossary rows (never touching
 * the shared glossary) and merges the terminology rules into the project's
 * translate config, so the next run picks them up without re-entering them.
 */

import { defaultModelFor, type ProviderId } from '@/config/models.config'
import { glossaryRepo } from '@/db/repo-knowledge'
import { projectRepo } from '@/db/repo-projects'
import { SETTING_KEYS, settingsRepo } from '@/db/repo-settings'
import type { QualityLevel, TerminologyScope, TranslateRunConfig } from '@/translate/types'

export type TemplateId = 'academic' | 'engineering' | 'legal' | 'novel'

export interface TemplateTerm {
  sourceTerm: string
  targetTerm: string
  notes: string
}

export interface ProjectTemplate {
  id: TemplateId
  nameEn: string
  nameMy: string
  descriptionEn: string
  descriptionMy: string
  quality: QualityLevel
  terminologyScope: TerminologyScope
  translateImages: boolean
  glossary: TemplateTerm[]
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'academic',
    nameEn: 'Academic paper',
    nameMy: 'သုတေသာစာတမ်း',
    descriptionEn: 'Formal prose, precise terminology, citations kept verbatim.',
    descriptionMy: 'စည်းကမ်းရှိသော စာသား၊ တိကျသော ဝေါဟာရ၊ ကိုးကားချက်များ မပြောင်းလဲပါ။',
    quality: 'high',
    terminologyScope: 'first',
    translateImages: true,
    glossary: [
      { sourceTerm: 'hypothesis', targetTerm: 'ယူဆချက်', notes: 'Research hypothesis' },
      { sourceTerm: 'methodology', targetTerm: 'နည်းဗျူဟာ', notes: 'How the study was run' },
      { sourceTerm: 'abstract', targetTerm: 'အကျဉ်းချုပ်', notes: 'Paper summary' },
      {
        sourceTerm: 'peer review',
        targetTerm: 'အသန့်ရှင်းစိစစ်ခြင်း',
        notes: 'Journal review process',
      },
      { sourceTerm: 'citation', targetTerm: 'ကိုးကားခြင်း', notes: 'Reference to a source' },
    ],
  },
  {
    id: 'engineering',
    nameEn: 'Engineering manual',
    nameMy: 'စက်ပစ္စည်း လက်စွဲစာအုပ်',
    descriptionEn: 'Short imperative sentences, units and part numbers untouched.',
    descriptionMy: 'တိုတောင်းသော ညွှန်ကြားချက်များ၊ ယူနစ်နှင့် ပစ္စည်းအမှတ်များ မပြောင်းပါ။',
    quality: 'medium',
    terminologyScope: 'document',
    translateImages: true,
    glossary: [
      { sourceTerm: 'torque', targetTerm: 'တာယာအား', notes: 'Rotational force' },
      { sourceTerm: 'tolerance', targetTerm: 'ခွင့်လွှတ်အမှား', notes: 'Allowed deviation' },
      { sourceTerm: 'schematic', targetTerm: 'ဇုန်ပုံ', notes: 'Circuit / assembly diagram' },
      { sourceTerm: 'maintenance', targetTerm: 'ထိန်းသိမ်းခြင်း', notes: 'Service procedure' },
      { sourceTerm: 'specification', targetTerm: 'သတ်မှတ်ချက်', notes: 'Technical spec' },
    ],
  },
  {
    id: 'legal',
    nameEn: 'Legal document',
    nameMy: 'ဥပဒေစာရေးကြောင်း',
    descriptionEn: 'Maximum quality, defined terms kept identical everywhere.',
    descriptionMy: 'အမြင့်ဆုံး အရည်အသွေး၊ သတ်မှတ်ထားသော ဝေါဟာရများ အတိအကျ သုံးပါသည်။',
    quality: 'high',
    terminologyScope: 'document',
    translateImages: false,
    glossary: [
      { sourceTerm: 'liability', targetTerm: 'တာဝန်ရှိခြင်း', notes: 'Legal responsibility' },
      { sourceTerm: 'indemnity', targetTerm: 'လျှော်ကြေး', notes: 'Compensation promise' },
      { sourceTerm: 'jurisdiction', targetTerm: 'တရားစီရင်ပိုင်ခွင့်', notes: 'Court authority' },
      { sourceTerm: 'breach', targetTerm: 'ချိုးဖောက်မှု', notes: 'Contract violation' },
      { sourceTerm: 'governing law', targetTerm: 'လက်နက်ကိုင်ဥပဒေ', notes: 'Applicable law' },
    ],
  },
  {
    id: 'novel',
    nameEn: 'Novel / fiction',
    nameMy: 'ဝတ္ထု / စာပေ',
    descriptionEn: 'Fluent, natural prose — dialogue rhythm preserved.',
    descriptionMy: 'သဘာဝကျသော ပုံဖော်ခြင်း၊ စကားပြော ခံစားချက် မပျက်ပါ။',
    quality: 'medium',
    terminologyScope: 'every',
    translateImages: false,
    glossary: [
      { sourceTerm: 'narrator', targetTerm: 'ပြောဆိုသူ', notes: 'Storyteller voice' },
      { sourceTerm: 'dialogue', targetTerm: 'စကားပြောခြင်း', notes: 'Quoted speech' },
      { sourceTerm: 'protagonist', targetTerm: 'ဇာတ်လိုက်', notes: 'Main character' },
      { sourceTerm: 'setting', targetTerm: 'နောက်ခံ', notes: 'Where/when it happens' },
      { sourceTerm: 'chapter', targetTerm: 'အခန်း', notes: 'Book division' },
    ],
  },
]

export function templateById(id: string | null | undefined): ProjectTemplate | null {
  if (!id) return null
  return PROJECT_TEMPLATES.find((template) => template.id === id) ?? null
}

export const TEMPLATE_SETTING_PREFIX = 'project.template.'

export function templateKey(projectId: string): string {
  return `${TEMPLATE_SETTING_PREFIX}${projectId}`
}

export interface ApplyTemplateResult {
  templateId: TemplateId
  /** Glossary rows added for this project. */
  added: number
  /** Terms already present with the same target (skipped). */
  skipped: number
  /** Terminology rules merged into the project's translate config. */
  configUpdated: boolean
}

/** Reads the translate config, filling in the platform defaults. */
export async function loadTranslateConfig(projectId: string): Promise<TranslateRunConfig> {
  const stored = await settingsRepo.get<TranslateRunConfig | null>(
    `translate.config.${projectId}`,
    null,
  )
  if (stored && stored.projectId === projectId) return stored

  const [provider, model] = await Promise.all([
    settingsRepo.get<ProviderId>(SETTING_KEYS.provider, 'gemini'),
    settingsRepo.get<string>(SETTING_KEYS.model, ''),
  ])
  return {
    projectId,
    provider,
    model: model || defaultModelFor(provider),
    quality: 'medium',
    sourceLang: 'en',
    targetLang: 'my',
    translateImages: true,
    terminologyScope: 'first',
    fallbackModels: [],
    strategy: 'round-robin',
  }
}

/**
 * Applies a template to one project. Idempotent: re-applying refreshes the
 * terminology rules and only adds glossary terms that are missing.
 */
export async function applyTemplate(
  projectId: string,
  templateId: TemplateId,
): Promise<ApplyTemplateResult> {
  const template = templateById(templateId)
  if (!template) throw new Error(`Unknown template: ${templateId}`)

  const project = await projectRepo.get(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)

  const existing = await glossaryRepo.list(projectId)
  const seen = new Map(existing.map((row) => [row.sourceTerm.toLowerCase(), row.targetTerm]))
  let added = 0
  let skipped = 0

  for (const term of template.glossary) {
    const key = term.sourceTerm.toLowerCase()
    const current = seen.get(key)
    if (current !== undefined) {
      if (current === term.targetTerm) skipped += 1
      else skipped += 1
      continue
    }
    await glossaryRepo.create({
      projectId,
      sourceTerm: term.sourceTerm,
      targetTerm: term.targetTerm,
      sourceLang: project.sourceLang,
      targetLang: project.targetLang,
      notes: term.notes,
      caseSensitive: false,
    })
    added += 1
  }

  const config = await loadTranslateConfig(projectId)
  await settingsRepo.set(
    `translate.config.${projectId}`,
    {
      ...config,
      quality: template.quality,
      terminologyScope: template.terminologyScope,
      translateImages: template.translateImages,
    } satisfies TranslateRunConfig,
    'translate',
  )
  await settingsRepo.set(templateKey(projectId), templateId, 'project')

  return { templateId, added, skipped, configUpdated: true }
}

export async function currentTemplateId(projectId: string): Promise<TemplateId | null> {
  const value = await settingsRepo.get<TemplateId | null>(templateKey(projectId), null)
  return templateById(value)?.id ?? null
}

/** Removes the project's glossary and the template marker (keeps config). */
export async function clearTemplate(projectId: string): Promise<void> {
  const rows = await glossaryRepo.list(projectId)
  for (const row of rows) await glossaryRepo.remove(row.id)
  await settingsRepo.remove(templateKey(projectId))
}
