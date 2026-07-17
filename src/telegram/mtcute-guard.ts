import type { GuardActionExecutor } from '../guard/action-queue.js'
import type { GuardRuntimeListener, GuardRuntimeListenerHandle, GuardRuntimeListenerStartInput } from '../guard/runtime.js'
import type { GuardEvent } from '../guard/types.js'
import type { NormalizedMessage } from './media-types.js'
import type { TelegramGuardMessageUpdate } from './guard-types.js'

type GuardTelegramClient = {
  groups?: {
    deleteGroupMessages(input: { chat: string | number; messageIds: readonly number[] }): Promise<unknown>
    muteMember(input: { chat: string | number; user: string | number; seconds: number | null }): Promise<unknown>
    banMember(input: { chat: string | number; user: string | number; seconds: number | null }): Promise<unknown>
  }
  listen?(options: {
    chats?: Array<string | number>
    onConnected?: () => void
    onMessage: (message: NormalizedMessage) => void
    signal: AbortSignal
  }): Promise<'stopped' | 'disconnected'>
  sendMessage?(options: { chat: string | number; message: string; reply?: number; linkPreview: boolean }): Promise<unknown>
  getCurrentUser?(): Promise<{ id: number }>
  close?(): Promise<void>
}

export type GuardTelegramClientProvider = {
  getClient(account: string): Promise<GuardTelegramClient>
}

export type MtcuteGuardExecutorOptions = {
  getClient: GuardTelegramClientProvider['getClient']
}

export type MtcuteGuardListenerOptions = {
  getClient: GuardTelegramClientProvider['getClient']
  currentAccountUserId?: (account: string) => Promise<number | null>
}

export class GuardTelegramClientCache implements GuardTelegramClientProvider {
  private readonly clients = new Map<string, GuardTelegramClient>()

  constructor(private readonly createClient: (account: string) => GuardTelegramClient) {}

  async getClient(account: string): Promise<GuardTelegramClient> {
    const existing = this.clients.get(account)
    if (existing != null) return existing
    const client = this.createClient(account)
    this.clients.set(account, client)
    return client
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    const errors: unknown[] = []
    for (const client of clients) {
      if (client.close == null) continue
      try {
        await client.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Failed to close Telegram guard clients')
  }
}

export class MtcuteGuardExecutor implements GuardActionExecutor {
  private readonly getClient: GuardTelegramClientProvider['getClient']

  constructor(options: MtcuteGuardExecutorOptions) {
    this.getClient = options.getClient
  }

  async deleteMessage(input: { account: string; groupId: number; chat: number; messageId: number }): Promise<void> {
    const client = await this.getClient(input.account)
    if (client.groups == null) throw new Error('Telegram group management adapter is unavailable')
    await client.groups.deleteGroupMessages({ chat: input.chat, messageIds: [input.messageId] })
  }

  async muteMember(input: { account: string; groupId: number; chat: number; userId: number; seconds: number }): Promise<void> {
    const client = await this.getClient(input.account)
    if (client.groups == null) throw new Error('Telegram group management adapter is unavailable')
    await client.groups.muteMember({ chat: input.chat, user: input.userId, seconds: input.seconds })
  }

  async banMember(input: { account: string; groupId: number; chat: number; userId: number }): Promise<void> {
    const client = await this.getClient(input.account)
    if (client.groups == null) throw new Error('Telegram group management adapter is unavailable')
    await client.groups.banMember({ chat: input.chat, user: input.userId, seconds: null })
  }

  async reply(input: { account: string; groupId: number; chat: number; messageId: number; text: string }): Promise<void> {
    const client = await this.getClient(input.account)
    if (client.sendMessage == null) throw new Error('Telegram send adapter is unavailable')
    await client.sendMessage({ chat: input.chat, message: input.text, reply: input.messageId, linkPreview: false })
  }

  async sendMessage(input: { account: string; groupId: number; chat: number; text: string }): Promise<void> {
    const client = await this.getClient(input.account)
    if (client.sendMessage == null) throw new Error('Telegram send adapter is unavailable')
    await client.sendMessage({ chat: input.chat, message: input.text, linkPreview: false })
  }
}

export class MtcuteGuardListener implements GuardRuntimeListener {
  private readonly getClient: GuardTelegramClientProvider['getClient']
  private readonly currentAccountUserId: (account: string) => Promise<number | null>

  constructor(options: MtcuteGuardListenerOptions) {
    this.getClient = options.getClient
    this.currentAccountUserId = options.currentAccountUserId ?? (async () => null)
  }

  async start(input: GuardRuntimeListenerStartInput): Promise<GuardRuntimeListenerHandle> {
    const controller = new AbortController()
    const client = await this.getClient(input.account)
    if (client.listen == null) throw new Error('Telegram listen adapter is unavailable')
    const currentAccountUserId = await this.currentAccountUserId(input.account)
    let markConnected!: () => void
    const connected = new Promise<void>((resolve) => {
      markConnected = resolve
    })
    const listening = client.listen({
      chats: [input.chatId],
      signal: controller.signal,
      onConnected: markConnected,
      onMessage: (message) => {
        void Promise.resolve(input.onEvent(normalizeGuardMessageUpdate({
            account: input.account,
            groupId: input.groupId,
            currentAccountUserId,
            message,
          })))
          .catch((error) => {
            controller.abort()
            void input.onError?.(error)
          })
      },
    })
    await Promise.race([
      connected,
      listening.then((result) => {
        throw new Error(`Telegram guard listener ${result} before connecting`)
      }),
    ])
    void listening.then((result) => {
      if (controller.signal.aborted) return
      void input.onError?.(new Error(`Telegram guard listener ${result}`))
    }, (error) => {
      if (controller.signal.aborted) return
      void input.onError?.(error)
    })

    return {
      stop: async () => {
        controller.abort()
        await listening.catch((error) => {
          if (!controller.signal.aborted) throw error
        })
      },
    }
  }
}

export function normalizeGuardMessageUpdate(update: TelegramGuardMessageUpdate): GuardEvent {
  return {
    type: 'message_created',
    account: update.account,
    group_id: update.groupId,
    chat_id: update.message.chat_id,
    chat_title: update.message.chat_name,
    message_id: update.message.msg_id,
    user: update.message.sender_id == null
      ? null
      : {
        id: update.message.sender_id,
        display_name: update.message.sender_name,
        username: stringField(update.message, 'sender_username'),
        is_admin: booleanField(update.message, 'sender_is_admin') ?? true,
        is_bot: booleanField(update.message, 'sender_is_bot') ?? true,
      },
    text: update.message.content,
    created_at: update.message.timestamp,
    member_joined_at: stringField(update.message, 'member_joined_at'),
    current_account_user_id: update.currentAccountUserId,
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  return typeof field === 'string' ? field : null
}

function booleanField(value: Record<string, unknown>, key: string): boolean | null {
  const field = value[key]
  return typeof field === 'boolean' ? field : null
}
