/** Formats a byte count for display (B / kB / MB / GB). */
export function formatBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 ? 0 : precision
  return `${value.toFixed(digits)} ${units[exponent]}`
}

/** Formats large numbers with locale-aware grouping. */
export function formatNumber(value: number, locale = 'en-US'): string {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat(locale).format(value)
}

/** Compact number formatting for stat cards (1.2k, 3.4M). */
export function formatCompact(value: number, locale = 'en-US'): string {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}

/** Localised date-time, falling back to a stable ISO prefix. */
export function formatDateTime(timestamp: number, locale = 'en-US'): string {
  if (!timestamp) return '—'
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** "3 minutes ago" style relative time. */
export function formatRelative(timestamp: number, locale = 'en-US'): string {
  if (!timestamp) return '—'
  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 1000],
    ['minute', 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['year', 365 * 24 * 60 * 60 * 1000],
  ]
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  let divisor = 1000
  for (const [candidateUnit, candidateDivisor] of units) {
    if (abs >= candidateDivisor) {
      unit = candidateUnit
      divisor = candidateDivisor
    }
  }
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      Math.round(diff / divisor),
      unit,
    )
  } catch {
    return formatDateTime(timestamp, locale)
  }
}
