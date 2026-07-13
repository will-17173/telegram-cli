import type { StoredMessageInput } from '../storage/message-db.js'
import { extractGroupedId } from '../telegram/raw-message.js'

type TimerHandle = ReturnType<typeof setTimeout>

type PendingAlbum = {
  messages: StoredMessageInput[]
  timer: TimerHandle
}

export type ListenAlbumAggregatorOptions = {
  emit: (messages: StoredMessageInput[]) => void
  onError?: (error: unknown) => void
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
      this.emit([message])
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
    this.emit([...album.messages].sort((left, right) => left.msg_id - right.msg_id))
  }

  private emit(messages: StoredMessageInput[]): void {
    try {
      this.options.emit(messages)
    } catch (error) {
      if (this.options.onError == null) throw error
      this.options.onError(error)
    }
  }
}
