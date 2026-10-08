/** Troubleshooting Assistant — public surface. */

export { AssistantBootstrap } from './AssistantBootstrap'
export { AssistantDialog } from './AssistantDialog'
export { EXECUTABLE_ACTIONS, runSafeAction, type ActionOutcome, type ActionEffect } from './actions'
export { assistantEndpoint, assistantProxyUrl, askAssistant, normalizeAnswer } from './client'
export { buildContext } from './context'
export { errorMemory, type MemoryEntry } from './errorMemory'
export { OFFLINE_RULE_IDS, ruleAnswer } from './rules'
export { redact, redactText, REDACTED } from './redact'
export { AssistantError } from './types'
export type {
  AskInput,
  AskResult,
  AssistantAction,
  AssistantAnswer,
  AssistantContext,
  AssistantLang,
  AssistantMode,
  SafeActionId,
} from './types'
