import type { Command } from 'commander'
import type { HandlerResult } from './types.js'
import { MessageDB } from '../storage/message-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { TelegramClientAdapter, TelegramUser } from '../telegram/types.js'
import { MessageService } from '../services/message-service.js'
import { SyncService } from '../services/sync-service.js'
import { ListenAlbumAggregator } from '../services/listen-album-aggregator.js'
import { AutoDownloadCoordinator, type AutoDownloadEvent } from '../services/auto-download-coordinator.js'
import { actionDetail, chatTable, recordDetail, syncSummary, userDetail } from '../presenters/human.js'
import { formatListenLine } from '../presenters/listen-message.js'
import { renderInteractiveListen } from '../presenters/ink/listen.js'
import { runWithAuthenticatedAccountContext, type AccountCommandOptions } from './account-options.js'
import { hideBenignUpdateWarnings, runTelegramCommand } from './telegram-runner.js'
import { createListenReplyResolver } from '../services/listen-reply-resolver.js'

type MachineOptions = AccountCommandOptions

type SendFlags = MachineOptions & {
  reply?: string
  preview: boolean
  file: string[]
}

type EditFlags = MachineOptions & {
  preview: boolean
}

type DeleteFlags = MachineOptions

type SyncFlags = MachineOptions & {
  limit?: string
  delay?: string
}

type RefreshFlags = SyncFlags & {
  delay?: string
  maxChats?: string
}

type ListenOptions = MachineOptions & {
  persist?: boolean
  retrySeconds?: string
  sendTo?: string
  media?: boolean
  interactive?: boolean
  autoDownload?: boolean
}

export function registerTelegramCommands(app: Command): void {
  app.command('status')
    .description('Show Telegram authentication status')
    .option('--json')
    .option('--yaml')
    .action(async (options: MachineOptions, command: Command) => {
      await runTelegramCommand(options, async (client) => {
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
      }, command)
    })

  app.command('whoami')
    .description('Show the authenticated Telegram account')
    .option('--json')
    .option('--yaml')
    .action(async (options: MachineOptions, command: Command) => {
      await runTelegramCommand(options, async (client) => {
        const user = normalizeTelegramUser(await client.getCurrentUser())
        return {
          ok: true,
          data: { user },
          human: userDetail(user),
        }
      }, command)
    })

  app.command('chats')
    .description('List available Telegram chats')
    .option('--type <type>')
    .option('--json')
    .option('--yaml')
    .action(async (options: MachineOptions & { type?: string }, command: Command) => {
      await runTelegramCommand(options, async (client) => {
        const chats = await client.listChats(options.type as any)
        return { ok: true, data: chats, human: chatTable(chats) }
      }, command)
    })

  app.command('history')
    .description('Fetch chat history and store it locally')
    .argument('<chat>')
    .option('-n, --limit <limit>', 'Max messages to fetch', '1000')
    .option('--delay <delay>', 'Seconds between history pages', '1')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: SyncFlags, command: Command) => {
      const limit = Number.parseInt(options.limit ?? '0', 10)
      const pageDelay = parsePageDelay(options.delay)
      await renderSyncResult(options, async (service) => service.history({ chat, limit, pageDelay }), command)
    })

  app.command('sync')
    .description('Sync new messages from a Telegram chat')
    .argument('<chat>')
    .option('-n, --limit <limit>', 'Max messages to fetch', '5000')
    .option('--delay <delay>', 'Seconds between history pages', '1')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: SyncFlags, command: Command) => {
      const limit = Number.parseInt(options.limit ?? '0', 10)
      const pageDelay = parsePageDelay(options.delay)
      await renderSyncResult(options, async (service) => service.sync({ chat, limit, pageDelay }), command)
    })

  app.command('sync-all')
    .description('Sync messages from all Telegram chats')
    .option('-n, --limit <limit>', 'Max messages per chat', '5000')
    .option('--delay <delay>', 'Seconds between chats', '1')
    .option('--max-chats <maxChats>', 'Maximum chats to sync')
    .option('--json')
    .option('--yaml')
    .action(async (options: RefreshFlags, command: Command) => {
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
      }, command)
    })

  app.command('refresh')
    .description('Refresh all chats with new Telegram messages')
    .option('-n, --limit <limit>', 'Max messages per chat', '5000')
    .option('--delay <delay>', 'Seconds between chats', '1')
    .option('--max-chats <maxChats>', 'Maximum chats to sync')
    .option('--json')
    .option('--yaml')
    .action(async (options: RefreshFlags, command: Command) => {
      const limit = Number.parseInt(options.limit ?? '0', 10)
      const delay = Number.parseFloat(options.delay ?? '0')
      const maxChats = options.maxChats == null ? undefined : Number.parseInt(options.maxChats, 10)
      await renderSyncResult(options, async (service) => service.refresh({ limit, delay, maxChats }), command)
    })

  app.command('info')
    .description('Show information about a Telegram chat')
    .argument('<chat>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: MachineOptions, command: Command) => {
      await runTelegramCommand(options, async (client) => {
        const info = await client.getChatInfo(parseChat(chat))
        if (!info) return { ok: false, error: { code: 'chat_not_found', message: `Chat '${chat}' not found on Telegram.` } }
        return { ok: true, data: info, human: recordDetail('Chat info', info) }
      }, command)
    })

  app.command('send')
    .description('Send a message to a Telegram chat')
    .argument('<chat>')
    .argument('[message]')
    .option('-f, --file <path>', 'File to attach (repeatable)', collectOption, [])
    .option('-r, --reply <reply>', 'Message ID to reply to')
    .option('--no-preview')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, message: string | undefined, options: SendFlags, command: Command) => {
      const reply = options.reply == null ? undefined : Number(options.reply)
      await renderMessageResult(options, 'Message sent', (service) => service.send({
        chat,
        message,
        files: options.file,
        reply,
        linkPreview: options.preview,
      }), command)
    })

  app.command('edit')
    .description('Edit a Telegram message')
    .argument('<chat>')
    .argument('<msgId>')
    .argument('<text>')
    .option('--no-preview')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, msgId: string, text: string, options: EditFlags, command: Command) => {
      const msgIdNum = Number.parseInt(msgId, 10)
      await renderMessageResult(options, 'Message edited', (service) => service.edit({
        chat,
        msgId: msgIdNum,
        text,
        linkPreview: options.preview,
      }), command)
    })

  app.command('delete')
    .description('Delete Telegram messages')
    .argument('<chat>')
    .argument('<msgIds...>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, msgIds: string[], options: DeleteFlags, command: Command) => {
      await renderMessageResult(options, 'Messages deleted', (service) => service.delete({
        chat,
        msgIds: msgIds.map((id) => Number.parseInt(id, 10)),
      }), command)
    })

  app.command('listen')
    .description('Listen for new Telegram messages')
    .argument('[chats...]')
    .option('--persist', 'Reconnect automatically')
    .option('--retry-seconds <seconds>', 'Reconnect delay', '5')
    .option('--send-to <chat>', 'Set default outgoing chat for interactive mode')
    .option('--no-media', 'Hide attachment summary for incoming messages')
    .option('--auto-download', 'Download incoming attachments automatically')
    .option('--no-interactive', 'Use plain text listen output')
    .action(async (chats: string[], options: ListenOptions, command: Command) => {
      const persist = Boolean(options.persist)
      const retrySeconds = Number.parseFloat(options.retrySeconds ?? '5')
      const parsedChats = parseChats(chats)?.map(parseChat)
      const showMedia = options.media !== false
      const autoDownload = Boolean(options.autoDownload)
      const showChatName = parsedChats == null
      const useInteractive = options.interactive !== false && process.stdin.isTTY === true && process.stdout.isTTY === true
      const sendTo = options.sendTo == null ? resolveSingleSendTarget(parsedChats) : parseChat(options.sendTo)
      const seenMessages = new Set<string>()
      const seenMessageOrder: string[] = []
      const controller = new AbortController()
      const stopListening = () => controller.abort()
      const restoreUpdateWarnings = hideBenignUpdateWarnings(process.stdout)
      const restoreUpdateErrors = hideBenignUpdateWarnings(process.stderr)
      let autoDownloader: AutoDownloadCoordinator | undefined

      process.on('SIGINT', stopListening)
      process.on('SIGTERM', stopListening)

      try {
        await runWithAuthenticatedAccountContext(options, async (context) => {
          const createClient = () => createTelegramClient(context.sessionPath)

          if (useInteractive) {
            await renderInteractiveListen({
              dbPath: context.dbPath,
              chats: parsedChats,
              persist,
              retrySeconds,
              sendTo,
              showMedia,
              autoDownload,
              showChatName,
              createClient,
              stopSignal: controller.signal,
              onRequestStop: stopListening,
            })
            return
          }

          const replyResolver = createListenReplyResolver(context.dbPath)
          let listenOutputError: unknown
          const albumAggregator = new ListenAlbumAggregator({
            emit: (messages) => {
              const replyContext = replyResolver.resolve(messages)
              process.stdout.write(formatListenLine(messages, {
                showMedia,
                showChatName,
                replyContext,
              }))
              replyResolver.remember(messages)
            },
            onError: (error) => {
              listenOutputError ??= error
              controller.abort()
            },
          })

          try {
            if (autoDownload) {
              autoDownloader = new AutoDownloadCoordinator({
                onEvent: printAutoDownloadEvent,
              })
            }

            while (true) {
              const client = createClient()
              let retry = false
              let clientClosed = false
              const closeClient = async () => {
                if (clientClosed) return
                clientClosed = true
                await client.close().catch(() => undefined)
              }
              autoDownloader?.setClient(client)
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
                    autoDownloader?.enqueue(message)
                    albumAggregator.add(message)
                  },
                })
                if (!persist || result === 'stopped') break
                if (result === 'disconnected') retry = true
              } catch (error) {
                if (!persist) throw error
                retry = true
              } finally {
                albumAggregator.flush()
                if (autoDownloader != null) {
                  if (controller.signal.aborted) {
                    autoDownloader.stop()
                    await closeClient()
                    await autoDownloader.waitForActive()
                  } else if (retry) {
                    autoDownloader.setClient(null)
                    await autoDownloader.waitForActive()
                  } else {
                    await autoDownloader.waitForIdle()
                    autoDownloader.setClient(null)
                  }
                }
                await closeClient()
              }
              if (retry) {
                await sleep(retrySeconds)
                continue
              }
              break
            }
            if (listenOutputError != null) throw listenOutputError
          } finally {
            albumAggregator.dispose()
            replyResolver.close()
          }
        }, command)
      } finally {
        process.off('SIGINT', stopListening)
        process.off('SIGTERM', stopListening)
        restoreUpdateWarnings()
        restoreUpdateErrors()
        autoDownloader?.stop()
      }
      process.stdout.write('listening completed\n')
    })
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function printAutoDownloadEvent(event: AutoDownloadEvent): void {
  if (event.status === 'completed') {
    process.stdout.write(`downloaded: ${event.path}\n`)
  } else if (event.status === 'failed') {
    process.stdout.write(`download failed: ${event.key.split(':').slice(0, -1).join(':')}: ${event.error}\n`)
  }
}

function parseChats(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined
  return values
}

function resolveSingleSendTarget(chats: Array<string | number> | undefined): string | number | undefined {
  return chats?.length === 1 ? chats[0] : undefined
}

function parsePageDelay(value: string | undefined): number {
  const raw = value ?? '0'
  return raw.trim() === '' ? Number.NaN : Number(raw)
}

function parseChat(chat: string): string | number {
  const parsed = Number.parseInt(chat, 10)
  return Number.isNaN(parsed) || String(parsed) !== chat.trim() ? chat : parsed
}

async function renderSyncResult(
  options: SyncFlags,
  handler: (service: SyncService) => Promise<HandlerResult>,
  command?: Command,
): Promise<void> {
  await runTelegramCommand(options, async (client, context) => {
    const result = await runWithSync(client, context.dbPath, handler)
    return result.ok && result.human == null
      ? { ...result, human: syncSummary(result.data as Parameters<typeof syncSummary>[0]) }
      : result
  }, command)
}

async function runWithSync(
  client: TelegramClientAdapter,
  dbPath: string,
  handler: (service: SyncService) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const service = new SyncService(client, new MessageDB(dbPath))
  try {
    return await handler(service)
  } finally {
    service.close()
  }
}

async function renderMessageResult(
  options: MachineOptions,
  title: string,
  handler: (service: MessageService) => Promise<HandlerResult>,
  command?: Command,
): Promise<void> {
  await runTelegramCommand(options, async (client) => {
    const service = new MessageService(client)
    const result = await handler(service)
    return result.ok && result.human == null
      ? { ...result, human: actionDetail(title, result.data as Record<string, unknown>) }
      : result
  }, command)
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

function sleep(seconds: number): Promise<void> {
  const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  return new Promise((resolve) => {
    setTimeout(resolve, delay)
  })
}
