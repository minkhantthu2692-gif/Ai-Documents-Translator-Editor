/** Central repository registry. */

import { apiKeyRepo } from './repo-apiKeys'
import { cacheRepo } from './repo-cache'
import { blockRepo, pageRepo, translationRepo } from './repo-content'
import { eventRepo } from './repo-events'
import { glossaryRepo, translationMemoryRepo } from './repo-knowledge'
import { jobRepo } from './repo-jobs'
import { outboxRepo } from './repo-outbox'
import { projectRepo } from './repo-projects'
import { settingsRepo } from './repo-settings'
import { usageRepo } from './repo-usage'

export const repos = {
  projects: projectRepo,
  pages: pageRepo,
  blocks: blockRepo,
  translations: translationRepo,
  glossary: glossaryRepo,
  translationMemory: translationMemoryRepo,
  cache: cacheRepo,
  jobs: jobRepo,
  events: eventRepo,
  settings: settingsRepo,
  apiKeys: apiKeyRepo,
  usage: usageRepo,
  outbox: outboxRepo,
}

export {
  projectRepo,
  pageRepo,
  blockRepo,
  translationRepo,
  glossaryRepo,
  translationMemoryRepo,
  cacheRepo,
  jobRepo,
  eventRepo,
  settingsRepo,
  apiKeyRepo,
  usageRepo,
  outboxRepo,
}
