export type TimeRangeInput = {
  since?: string
  until?: string
}

export type ParsedTimeRange = {
  since?: Date
  until?: Date
}

const RELATIVE = /^(\d+)(s|m|h|d|w)$/
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i

const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const

export function parseTimeRange(input: TimeRangeInput, now = new Date()): ParsedTimeRange {
  const since = input.since == null ? undefined : parseBound(input.since, now)
  const until = input.until == null ? undefined : parseBound(input.until, now)

  if (since && until && since.getTime() >= until.getTime()) {
    throw new Error('invalid_time_range: --since must be earlier than --until.')
  }

  return { since, until }
}

function parseBound(value: string, now: Date): Date {
  const trimmed = value.trim()
  const relative = RELATIVE.exec(trimmed)
  if (relative) {
    const amount = Number(relative[1])
    if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid(trimmed)

    return new Date(now.getTime() - amount * UNIT_MS[relative[2] as keyof typeof UNIT_MS])
  }

  if (!ISO_WITH_ZONE.test(trimmed)) {
    throw invalid(trimmed)
  }

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(trimmed)
  }

  return parsed
}

function invalid(value: string): Error {
  return new Error(`invalid_time_range: invalid time value "${value}".`)
}
