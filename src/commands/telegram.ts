import type { Command } from 'commander'
import { renderResult } from '../cli/output.js'
import type { HandlerResult } from './types.js'
import { outputFormatConflict } from './types.js'
import { MessageDB } from '../storage/message-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { TelegramClientAdapter, TelegramUser } from '../telegram/types.js'
import { MessageService } from '../services/message-service.js'
import { SyncService } from '../services/sync-service.js'
import { ListenAlbumAggregator } from '../services/listen-album-aggregator.js'
import { actionDetail, chatTable, recordDetail, syncSummary, userDetail } from '../presenters/human.js'
import { formatListenLine } from '../presenters/listen-message.js'
import { renderInteractiveListen } from '../presenters/ink/listen.js'

type MachineOptions = {
  json?: boolean
  yaml?: boolean
}

type SendFlags = MachineOptions & {
  reply?: string
  preview: boolean
}

type EditFlags = MachineOptions & {
  preview: boolean
}

type DeleteFlags = MachineOptions

type SyncFlags = MachineOptions & {
  limit?: string
}

type RefreshFlags = SyncFlags & {
  delay?: string
  maxChats?: string
}

type ListenOptions = {
  persist?: boolean
  retrySeconds?: string
  sendTo?: string
  media?: boolean
  interactive?: boolean
}

export function registerTelegramCommands(app: Command): void {
  app.command('status')
    .description('Show Telegram authentication status')
    .option('--json')
    .option('--yaml')
    .action(async (options: MachineOptions) => {
      await renderTelegramResult(options, async (client) => {
        try {
          const user = await client.getCurrentUser()
          return {
            ok: true,
            data: {
              authenticated: true,
              user: normalizeTelegramUser(user),
            },
            human: {
              kind: 'summary',
              title: 'Telegram status',
              fields: [
                { label: 'Authenticated', value: 'Yes', tone: 'success' },
                ...userDetail(normalizeTelegramUser(user)).fields,
              ],
            },
          }
        } catch (error) {
          return {
            ok: false,
            error: { code: 'auth_error', message: errorMessage(error) },
          }
        }
      })
    })

  app.command('whoami')
    .description('Show the authenticated Telegram account')
    .option('--json')
    .option('--yaml')
    .action(async (options: MachineOptions) => {
      await renderTelegramResult(options, async (client) => {
        try {
          const user = normalizeTelegramUser(await client.getCurrentUser())
          return {
            ok: true,
            data: { user },
            human: userDetail(user),
          }
        } catch (error) {
          return {
            ok: false,
            error: { code: 'auth_error', message: errorMessage(error) },
          }
        }
      })
    })

  app.command('chats')
    .description('List available Telegram chats')
    .option('--type <type>')
    .option('--json')
    .option('--yaml')
    .action(async (options: MachineOptions & { type?: string }) => {
      await renderTelegramResult(options, async (client) => {
        const chats = await client.listChats(options.type as any)
        return { ok: true, data: chats, human: chatTable(chats) }
      })
    })

  app.command('history')
    .description('Fetch chat history and store it locally')
    .argument('<chat>')
    .option('-n, --limit <limit>', 'Max messages to fetch', '1000')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: SyncFlags) => {
      const limit = Number.parseInt(options.limit ?? '0', 10)
      await renderSyncResult(options, async (service) => service.history({ chat, limit }))
    })

  app.command('sync')
    .description('Sync new messages from a Telegram chat')
    .argument('<chat>')
    .option('-n, --limit <limit>', 'Max messages to fetch', '5000')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: SyncFlags) => {
      const limit = Number.parseInt(options.limit ?? '0', 10)
      await renderSyncResult(options, async (service) => service.sync({ chat, limit }))
    })

  app.command('sync-all')
    .description('Sync messages from all Telegram chats')
    .option('-n, --limit <limit>', 'Max messages per chat', '5000')
    .option('--delay <delay>', 'Seconds between chats', '1')
    .option('--max-chats <maxChats>', 'Maximum chats to sync')
    .option('--json')
    .option('--yaml')
    .action(async (options: RefreshFlags) => {
      const limit = Number.parseInt(options.limit ?? '0', 10)
      const delay = Number.parseFloat(options.delay ?? '0')
      const maxChats = options.maxChats == null ? undefined : Number.parseInt(options.maxChats, 10)
      await renderSyncResult(options, async (service) => {
        const result = await service.refresh({ limit, delay, maxChats })
        if (!result.ok) return result
        return {
          ok: true,
          data: {
            new_messages: result.data.new_messages,
            chats: result.data.chats,
            results: result.data.results,
          },
          human: syncSummary(result.data),
        }
      })
    })

  app.command('refresh')
    .description('Refresh all chats with new Telegram messages')
    .option('-n, --limit <limit>', 'Max messages per chat', '5000')
    .option('--delay <delay>', 'Seconds between chats', '1')
    .option('--max-chats <maxChats>', 'Maximum chats to sync')
    .option('--json')
    .option('--yaml')
    .action(async (options: RefreshFlags) => {
      const limit = Number.parseInt(options.limit ?? '0', 10)
      const delay = Number.parseFloat(options.delay ?? '0')
      const maxChats = options.maxChats == null ? undefined : Number.parseInt(options.maxChats, 10)
      await renderSyncResult(options, async (service) => service.refresh({ limit, delay, maxChats }))
    })

  app.command('info')
    .description('Show information about a Telegram chat')
    .argument('<chat>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: MachineOptions) => {
      await renderTelegramResult(options, async (client) => {
        const info = await client.getChatInfo(parseChat(chat))
        if (!info) return { ok: false, error: { code: 'chat_not_found', message: `Chat '${chat}' not found on Telegram.` } }
        return { ok: true, data: info, human: recordDetail('Chat info', info) }
      })
    })

  app.command('send')
    .description('Send a message to a Telegram chat')
    .argument('<chat>')
    .argument('<message>')
    .option('-r, --reply <reply>', 'Message ID to reply to')
    .option('--no-preview')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, message: string, options: SendFlags) => {
      const reply = options.reply == null ? undefined : Number.parseInt(options.reply, 10)
      await renderMessageResult(options, 'Message sent', (service) => service.send({
        chat,
        message,
        reply,
        linkPreview: options.preview,
      }))
    })

  app.command('edit')
    .description('Edit a Telegram message')
    .argument('<chat>')
    .argument('<msgId>')
    .argument('<text>')
    .option('--no-preview')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, msgId: string, text: string, options: EditFlags) => {
      const msgIdNum = Number.parseInt(msgId, 10)
      await renderMessageResult(options, 'Message edited', (service) => service.edit({
        chat,
        msgId: msgIdNum,
        text,
        linkPreview: options.preview,
      }))
    })

  app.command('delete')
    .description('Delete Telegram messages')
    .argument('<chat>')
    .argument('<msgIds...>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, msgIds: string[], options: DeleteFlags) => {
      await renderMessageResult(options, 'Messages deleted', (service) => service.delete({
        chat,
        msgIds: msgIds.map((id) => Number.parseInt(id, 10)),
      }))
    })

  app.command('listen')
    .description('Listen for new Telegram messages')
    .argument('[chats...]')
    .option('--persist', 'Reconnect automatically')
    .option('--retry-seconds <seconds>', 'Reconnect delay', '5')
    .option('--send-to <chat>', 'Set default outgoing chat for interactive mode')
    .option('--no-media', 'Hide attachment summary for incoming messages')
    .option('--no-interactive', 'Use plain text listen output')
    .action(async (chats: string[], options: ListenOptions) => {
      const persist = Boolean(options.persist)
      const retrySeconds = Number.parseFloat(options.retrySeconds ?? '5')
      const parsedChats = parseChats(chats)?.map(parseChat)
      const showMedia = options.media !== false
      const useInteractive = options.interactive !== false && process.stdin.isTTY === true && process.stdout.isTTY === true
      const sendTo = options.sendTo == null ? resolveSingleSendTarget(parsedChats) : parseChat(options.sendTo)
      const seenMessages = new Set<string>()
      const seenMessageOrder: string[] = []
      const controller = new AbortController()
      const stopListening = () => controller.abort()
      const restoreUpdateWarnings = hideBenignUpdateWarnings(process.stdout.write.bind(process.stdout), process.stdout)
      const restoreUpdateErrors = hideBenignUpdateWarnings(process.stderr.write.bind(process.stderr), process.stderr)
      const albumAggregator = new ListenAlbumAggregator({
        emit: (messages) => process.stdout.write(formatListenLine(messages, { showMedia })),
      })

      process.on('SIGINT', stopListening)
      process.on('SIGTERM', stopListening)

      try {
        if (useInteractive) {
          await renderInteractiveListen({
            chats: parsedChats,
            persist,
            retrySeconds,
            sendTo,
            showMedia,
            createClient,
            stopSignal: controller.signal,
            onRequestStop: stopListening,
          })
          return
        }

        while (true) {
          const client = createClient()
          let retry = false
          try {
            const result = await client.listen({
              chats: parsedChats,
              signal: controller.signal,
              onMessage: (message) => {
                const key = `${message.chat_id}:${message.msg_id}`
                if (seenMessages.has(key)) return
                seenMessages.add(key)
                seenMessageOrder.push(key)
                if (seenMessages.size > 5000) {
                  const oldest = seenMessageOrder.shift()
                  if (oldest != null) seenMessages.delete(oldest)
                }
                albumAggregator.add(message)
              },
            })
            if (!persist || result === 'stopped') break
            if (result === 'disconnected') {
              retry = true
            }
          } catch (error) {
            if (!persist) throw error
            retry = true
          } finally {
            albumAggregator.flush()
            await client.close().catch(() => undefined)
          }
          if (retry) {
            await sleep(retrySeconds)
            continue
          }
          break
        }
      } finally {
        process.off('SIGINT', stopListening)
        process.off('SIGTERM', stopListening)
        restoreUpdateWarnings()
        restoreUpdateErrors()
        albumAggregator.dispose()
      }
      process.stdout.write('listening completed\n')
    })
}

function parseChats(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined
  return values
}

function resolveSingleSendTarget(chats: Array<string | number> | undefined): string | number | undefined {
  return chats?.length === 1 ? chats[0] : undefined
}

function parseChat(chat: string): string | number {
  const parsed = Number.parseInt(chat, 10)
  return Number.isNaN(parsed) || String(parsed) !== chat.trim() ? chat : parsed
}

function createClient(): TelegramClientAdapter {
  return createTelegramClient()
}

async function renderSyncResult(options: SyncFlags, handler: (service: SyncService) => Promise<HandlerResult>): Promise<void> {
  await renderTelegramResult(options, async (client) => {
    const result = await runWithSync(client, handler)
    return result.ok && result.human == null
      ? { ...result, human: syncSummary(result.data as Parameters<typeof syncSummary>[0]) }
      : result
  })
}

async function runWithSync(client: TelegramClientAdapter, handler: (service: SyncService) => Promise<HandlerResult>): Promise<HandlerResult> {
  const service = new SyncService(client, new MessageDB())
  try {
    return await handler(service)
  } finally {
    service.close()
  }
}

type StreamWrite = typeof process.stdout.write

const BENIGN_UPDATE_WARNINGS = [
  'pts_before does not match local_pts',
  'local pts not available for postponed updateNewChannelMessage',
  'error fetching common difference',
  'error fetching difference for',
  'Session is reset',
  'MtprotoSession.resetState',
] as const

function hideBenignUpdateWarnings(write: StreamWrite, stream: NodeJS.WritableStream): () => void {
  stream.write = ((chunk: Parameters<StreamWrite>[0], encoding?: Parameters<StreamWrite>[1], cb?: Parameters<StreamWrite>[2]) => {
    const rendered = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    const isBenignUpdateWarning = BENIGN_UPDATE_WARNINGS.some((warning) => rendered.includes(warning))
      || (rendered.includes('error fetching difference for') && rendered.includes('400 CHANNEL_INVALID'))
    if (isBenignUpdateWarning) {
      return true
    }
    return write.call(stream, chunk, encoding, cb)
  }) as StreamWrite

  return () => {
    stream.write = write
  }
}

async function renderMessageResult(
  options: MachineOptions,
  title: string,
  handler: (service: MessageService) => Promise<HandlerResult>,
): Promise<void> {
  await renderTelegramResult(options, async (client) => {
    const service = new MessageService(client)
    const result = await handler(service)
    return result.ok && result.human == null
      ? { ...result, human: actionDetail(title, result.data as Record<string, unknown>) }
      : result
  })
}

async function renderTelegramResult(options: MachineOptions, handler: (client: TelegramClientAdapter) => Promise<HandlerResult>): Promise<void> {
  const conflict = outputFormatConflict(options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  const restoreStdoutWarnings = hideBenignUpdateWarnings(process.stdout.write.bind(process.stdout), process.stdout)
  const restoreStderrWarnings = hideBenignUpdateWarnings(process.stderr.write.bind(process.stderr), process.stderr)

  let client: TelegramClientAdapter
  try {
    client = createClient()
  } catch (error) {
    restoreStdoutWarnings()
    restoreStderrWarnings()
    await renderResult(commandFailure('config_error', error), options)
    return
  }

  let result: HandlerResult
  try {
    result = await handler(client)
  } catch (error) {
    result = commandFailure('telegram_error', error)
  }

  try {
    await renderResult(result, options)
  } finally {
    restoreStdoutWarnings()
    restoreStderrWarnings()
    await client.close()
  }
}

function commandFailure(code: string, error: unknown): HandlerResult<never> {
  return { ok: false, error: { code, message: errorMessage(error) } }
}

function normalizeTelegramUser(user: TelegramUser): {
  id: number
  name: string
  username: string
  first_name: string
  last_name: string
  phone: string
} {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return {
    id: user.id,
    name: name || user.username || String(user.id),
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    phone: user.phone,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(seconds: number): Promise<void> {
  const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  return new Promise((resolve) => {
    setTimeout(resolve, delay)
  })
}
