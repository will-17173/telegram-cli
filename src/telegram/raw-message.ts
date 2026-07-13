export function parseRawMessage(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isRecord(value) ? value : null
}

export function extractReplyToMessageId(value: unknown): number | null {
  const raw = parseRawMessage(value)
  if (raw == null) return null
  const replyTo = raw.replyTo ?? raw.reply_to
  if (!isRecord(replyTo)) return null
  const messageId = replyTo.replyToMsgId ?? replyTo.reply_to_msg_id
  return typeof messageId === 'number' && Number.isInteger(messageId) && messageId > 0
    ? messageId
    : null
}

export function extractGroupedId(value: unknown): string | null {
  const raw = parseRawMessage(value)
  if (raw == null) return null
  const groupedId = raw.groupedId ?? raw.grouped_id
  if (typeof groupedId === 'string' || typeof groupedId === 'number') return String(groupedId)
  if (!isRecord(groupedId)) return null
  const low = groupedId.low
  const high = groupedId.high
  if (!isLongPart(low) || !isLongPart(high)) return null
  return `${low}:${high}`
}

function isLongPart(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
