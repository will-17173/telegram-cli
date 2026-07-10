import type { StoredMessageInput } from '../storage/message-db.js'

type TimerHandle = ReturnType<typeof setTimeout>

type PendingAlbum = {
  messages: StoredMessageInput[]
  timer: TimerHandle
}

type ListenAlbumAggregatorOptions = {
  emit: (messages: StoredMessageInput[]) => void
  delayMs?: number
}

export class ListenAlbumAggregator {
  private readonly pending = new Map<string, PendingAlbum>()
  private readonly delayMs: number

  constructor(private readonly options: ListenAlbumAggregatorOptions) {
    this.delayMs = options.delayMs ?? 300
  }

  add(message: StoredMessageInput): void {
    const groupedId = extractGroupedId(message.raw_json)
    if (groupedId == null) {
      this.options.emit([message])
      return
    }

    const key = `${message.chat_id}:${groupedId}`
    const existing = this.pending.get(key)
    if (existing != null) clearTimeout(existing.timer)
    const messages = existing == null ? [message] : [...existing.messages, message]
    const timer = setTimeout(() => this.emitPending(key), this.delayMs)
    this.pending.set(key, { messages, timer })
  }

  flush(): void {
    for (const key of [...this.pending.keys()]) this.emitPending(key)
  }

  dispose(): void {
    for (const album of this.pending.values()) clearTimeout(album.timer)
    this.pending.clear()
  }

  private emitPending(key: string): void {
    const album = this.pending.get(key)
    if (album == null) return
    clearTimeout(album.timer)
    this.pending.delete(key)
    this.options.emit([...album.messages].sort((left, right) => left.msg_id - right.msg_id))
  }
}

function extractGroupedId(rawJson: unknown): string | null {
  const raw = parseRawJson(rawJson)
  if (raw == null) return null
  const groupedId = raw.groupedId ?? raw.grouped_id
  if (typeof groupedId === 'string' || typeof groupedId === 'number') return String(groupedId)
  if (isRecord(groupedId)) {
    const low = groupedId.low
    const high = groupedId.high
    if ((typeof low === 'number' || typeof low === 'string') && (typeof high === 'number' || typeof high === 'string')) {
      return `${low}:${high}`
    }
  }
  return null
}

function parseRawJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
