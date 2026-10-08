/**
 * Secret redaction for anything leaving the device.
 *
 * The assistant context (and any answer text the proxy echoes back) runs
 * through here before it is shown or sent. Patterns cover the shapes this app
 * can actually contain: OpenAI/OpenRouter/GitHub/AWS/Google keys, `Bearer …`
 * headers, JWTs, `key=`/`token=` query-style pairs, our own sealed payload
 * blobs, long hex fingerprints and generic long opaque tokens. Redaction is
 * deliberately aggressive — a false positive only costs a `[REDACTED]` in a
 * log line, a miss can leak a live key.
 */

export const REDACTED = '[REDACTED]'

interface Rule {
  pattern: RegExp
  replace: (...args: unknown[]) => string
}

const RULES: Rule[] = [
  // Authorization headers: Bearer <token> / Basic <base64>.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: () => `Bearer ${REDACTED}` },
  // OpenAI / OpenRouter style keys.
  { pattern: /\bsk-[A-Za-z0-9_-]{10,}\b/g, replace: () => REDACTED },
  { pattern: /\bsk-or-v1-[A-Za-z0-9]{10,}\b/g, replace: () => REDACTED },
  // GitHub tokens.
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: () => REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => REDACTED },
  // AWS access key ids.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  // Google API keys.
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: () => REDACTED },
  // JWTs (three base64url segments).
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACTED,
  },
  // key=/token=/secret=/password= pairs in URLs, logs and config fragments.
  {
    pattern:
      /\b(key|token|secret|password|passphrase|apikey|api_key|access_token)\s*[=:]\s*("?)[^\s"',&;]{6,}\2/gi,
    replace: (...args: unknown[]) => {
      const [, key, quote] = args as [string, string, string]
      return `${key}=${quote}${REDACTED}${quote}`
    },
  },
  // Our sealed-payload format (see core/crypto encodeSealed) and similar blobs.
  { pattern: /\bv1\.[A-Za-z0-9+/=]{20,}\.[A-Za-z0-9+/=]{10,}\b/g, replace: () => REDACTED },
  // Long hex fingerprints (sha256, device secrets, …).
  { pattern: /\b[0-9a-f]{32,}\b/gi, replace: () => REDACTED },
  // Long base64 blobs that are not words.
  { pattern: /\b[A-Za-z0-9+/]{48,}={0,2}\b/g, replace: () => REDACTED },
]

/** Redacts every secret-shaped substring of one string. */
export function redactText(value: string): string {
  let out = value
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace)
  return out
}

/**
 * Deep-redacts strings inside any JSON-ish value (clones plain objects and
 * arrays; leaves primitives and exotic values untouched). Cycles are guarded
 * so an accidental self-reference cannot hang the loop.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactText(value) as unknown as T
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return null as unknown as T
  seen.add(value as object)
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen)) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redact(item, seen)
  }
  return out as unknown as T
}
