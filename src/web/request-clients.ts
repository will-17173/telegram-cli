import type { TelegramClientAdapter } from '../telegram/types.js'

// Download/discovery requests own clients for their entire asynchronous lifetime.
export class RequestClients {
  private readonly clients = new Map<TelegramClientAdapter, () => Promise<void>>()
  private closing = false

  get isClosing(): boolean { return this.closing }

  track(client: TelegramClientAdapter): () => Promise<void> {
    const existing = this.clients.get(client)
    if (existing != null) return existing
    let completion: Promise<void> | undefined
    const close = () => {
      completion ??= Promise.resolve().then(() => client.close()).finally(() => this.clients.delete(client))
      return completion
    }
    this.clients.set(client, close)
    if (this.closing) void close().catch(() => undefined)
    return close
  }

  async close(): Promise<void> {
    this.closing = true
    const results = await Promise.allSettled([...this.clients.values()].map((close) => close()))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Unable to close all active request clients.')
  }
}
