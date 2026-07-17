import type { Command } from 'commander'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommandFailure, HandlerResult } from './types.js'
import { MessageDB } from '../storage/message-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { TelegramChatType, TelegramClientAdapter, TelegramUser } from '../telegram/types.js'
import type { ArchiveMessage } from '../telegram/archive-types.js'
import { MessageService } from '../services/message-service.js'
import { SyncService } from '../services/sync-service.js'
import { DownloadService, type DownloadInput, type DownloadStatusStore } from '../services/download-service.js'
import { ListenAlbumAggregator } from '../services/listen-album-aggregator.js'
import { AutoDownloadCoordinator, type AutoDownloadEvent } from '../services/auto-download-coordinator.js'
import { actionDetail, chatTable, recordDetail, syncSummary, userDetail } from '../presenters/human.js'
import { formatListenLine } from '../presenters/listen-message.js'
import { renderInteractiveListen } from '../presenters/ink/listen.js'
import { runWithAuthenticatedAccountContext, type AccountCommandOptions } from './account-options.js'
import { hideBenignUpdateWarnings, runTelegramCommand, runTelegramWriteCommand } from './telegram-runner.js'
import { createListenReplyResolver } from '../services/listen-reply-resolver.js'
import { parseTimeRange } from './time-range.js'

type MachineOptions = AccountCommandOptions

type ChatsFlags = MachineOptions & {
  type?: string
  group?: boolean
  channel?: boolean
  user?: boolean
}

type SendFlags = MachineOptions & {
  reply?: string
  preview: boolean
  file: string[]
}

type EditFlags = MachineOptions & {
  preview: boolean
}

type DeleteFlags = MachineOptions

type DownloadFlags = MachineOptions & {
  chat?: string
  msgId?: string
  msg_id?: string
  attachment?: string
  groupedId?: string
  grouped_id?: string
  from?: string
  to?: string
  date?: string
  since?: string
  until?: string
  all?: boolean
  force?: boolean
  output?: string
  concurrency?: string
}

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
    .option('--type <type>', 'Filter by chat type')
    .option('--group', 'List group chats')
    .option('--channel', 'List channels')
    .option('--user', 'List private user chats')
    .option('--json')
    .option('--yaml')
    .action(async (options: ChatsFlags, command: Command) => {
      const filter = resolveChatTypeFilter(options)
      if (!filter.ok) {
        await runWithAuthenticatedAccountContext(options, async () => filter, command)
        return
      }
      await runTelegramCommand(options, async (client) => {
        const listedChats = await client.listChats(filter.type)
        const chats = filter.includeSupergroups
          ? listedChats.filter(chat => chat.type === 'group' || chat.type === 'supergroup')
          : listedChats
        return { ok: true, data: chats, human: chatTable(chats) }
      }, command)
    })

  app.command('history')
    .description('Backfill older chat history from the local oldest message')
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
      const onProgress = createSyncProgressReporter(options)
      await renderSyncResult(options, async (service) => service.sync({ chat, limit, pageDelay, onProgress }), command)
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
      const reporter = createRefreshStatusReporter(options)
      const stop = createInterruptibleSyncAllStop(options)
      try {
        await renderSyncResult(options, async (service) => {
          const result = await service.refresh({
            limit,
            delay,
            maxChats,
            onChatStart: reporter?.onChatStart,
            onChatComplete: reporter?.onChatComplete,
            onProgress: reporter?.onProgress,
            stopSignal: stop.signal,
          })
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
      } finally {
        stop.dispose()
      }
      if (stop.interrupted) process.exitCode = 130
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

  app.command('download')
    .description('Download media attached to Telegram messages')
    .argument('[chat]')
    .argument('[msgId]')
    .option('--chat <chat>', 'Chat id, username, or title')
    .option('--msg-id <msgId>', 'Download one Telegram message id')
    .option('--msg_id <msgId>', 'Alias for --msg-id')
    .option('-a, --attachment <number>', 'Download one attachment number from a single message')
    .option('--grouped-id <id>', 'Download all media in a Telegram album grouped_id')
    .option('--grouped_id <id>', 'Alias for --grouped-id')
    .option('--from <msgId>', 'First message id in an inclusive range')
    .option('--to <msgId>', 'Last message id in an inclusive range')
    .option('--date <date>', 'Download media for a local date (YYYY-MM-DD)')
    .option('--since <since>', 'Only download media after this time')
    .option('--until <until>', 'Only download media before this time')
    .option('--all', 'Download all media from the chat, newest to oldest')
    .option('--force', 'Redownload media even when local status says it was already downloaded')
    .option('-o, --output <path>', 'Download directory')
    .option('-j, --concurrency <count>', 'Concurrent downloads', '3')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, msgId: string | undefined, options: DownloadFlags, command: Command) => {
      const input = buildDownloadInput(chat, msgId, options)
      if (!input.ok) {
        await runWithAuthenticatedAccountContext(options, async () => input, command)
        return
      }

      await runTelegramCommand(options, async (client, context) => {
        const groupedMessages = localGroupedDownloadMessages(context.dbPath, input.data)
        if (input.data.groupedId != null && groupedMessages.length === 0) {
          return {
            ok: false,
            error: {
              code: 'download_grouped_id_not_found',
              message: `Grouped album ${input.data.groupedId} was not found in the local cache for ${String(input.data.chat)}. Sync or refresh the chat first, then retry.`,
            },
          }
        }
        const downloadDb = new MessageDB(context.dbPath)
        try {
          return await new DownloadService(client.archive, {
            downloadStatusStore: messageDbDownloadStatusStore(downloadDb),
            onNotice: (message) => {
              if (!effectiveOutputIsStructured(options)) process.stderr.write(`${message}\n`)
            },
          }).download({
            ...input.data,
            ...(groupedMessages.length === 0 ? {} : { groupedMessages }),
          })
        } finally {
          downloadDb.close()
        }
      }, command)
    })

  app.command('listen')
    .description('Listen for new Telegram messages')
    .argument('[chats...]')
    .option('--persist', 'Reconnect automatically')
    .option('--retry-seconds <seconds>', 'Reconnect delay', '5')
    .option('--send-to <chat>', 'Set default outgoing chat for interactive mode')
    .option('--no-media', 'Hide rendered attachment list and previews for incoming messages')
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
      const shutdownListeners = new Set<() => void>()
      const stopListening = () => controller.abort()
      const requestShutdown = () => {
        if (shutdownListeners.size === 0) stopListening()
        else for (const listener of shutdownListeners) listener()
      }
      const restoreUpdateWarnings = hideBenignUpdateWarnings(process.stdout)
      const restoreUpdateErrors = hideBenignUpdateWarnings(process.stderr)
      let autoDownloader: AutoDownloadCoordinator | undefined

      process.on('SIGINT', requestShutdown)
      process.on('SIGTERM', requestShutdown)

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
              shutdownRequests: {
                subscribe: (listener) => {
                  shutdownListeners.add(listener)
                  return () => shutdownListeners.delete(listener)
                },
              },
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
        process.off('SIGINT', requestShutdown)
        process.off('SIGTERM', requestShutdown)
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

function resolveChatTypeFilter(options: ChatsFlags):
  | { ok: true; type?: TelegramChatType; includeSupergroups?: boolean }
  | CommandFailure {
  const selected = [options.type, options.group, options.channel, options.user].filter(Boolean)
  if (selected.length > 1) {
    return {
      ok: false,
      error: {
        code: 'invalid_option',
        message: 'Only one chat type filter may be used: --group, --channel, --user, or --type.',
      },
    }
  }

  if (options.group) return { ok: true, includeSupergroups: true }
  if (options.channel) return { ok: true, type: 'channel' }
  if (options.user) return { ok: true, type: 'user' }
  return { ok: true, type: options.type as TelegramChatType | undefined }
}

function printAutoDownloadEvent(event: AutoDownloadEvent): void {
  if (event.status === 'completed') {
    process.stdout.write(`downloaded: ${event.path}\n`)
  } else if (event.status === 'failed') {
    process.stdout.write(`download failed: ${event.key.split(':').slice(0, -1).join(':')}: ${event.error}\n`)
  }
}

function buildDownloadInput(
  chat: string,
  msgId: string | undefined,
  options: DownloadFlags,
): HandlerResult<DownloadInput> {
  const effectiveChat = options.chat ?? chat
  if (effectiveChat == null || effectiveChat.trim() === '') return invalidOption('chat must be a non-empty string.')
  if (options.chat != null && chat != null && chat.trim() !== '') return invalidOption('chat argument cannot be combined with --chat.')
  const effectiveMsgId = options.msgId ?? options.msg_id ?? msgId
  if ((options.msgId != null || options.msg_id != null) && msgId != null) return invalidOption('message id argument cannot be combined with --msg-id.')
  const parsedMessageId = effectiveMsgId == null ? undefined : parsePositiveInteger(effectiveMsgId)
  if (effectiveMsgId != null && parsedMessageId == null) return invalidOption('message id must be a positive integer.')
  const groupedId = options.groupedId ?? options.grouped_id
  const attachment = options.attachment == null ? undefined : parsePositiveInteger(options.attachment)
  if (options.attachment != null && attachment == null) return invalidOption('attachment must be a positive integer.')
  const fromId = options.from == null ? undefined : parsePositiveInteger(options.from)
  if (options.from != null && fromId == null) return invalidOption('from id must be a positive integer.')
  const toId = options.to == null ? undefined : parsePositiveInteger(options.to)
  if (options.to != null && toId == null) return invalidOption('to id must be a positive integer.')
  const concurrency = options.concurrency == null ? undefined : parsePositiveInteger(options.concurrency)
  if (options.concurrency != null && concurrency == null) return invalidOption('concurrency must be a positive integer.')

  let since: Date | undefined
  let until: Date | undefined
  if (options.date != null) {
    if (options.since != null || options.until != null) {
      return invalidOption('--date cannot be combined with --since or --until.')
    }
    const parsedDate = parseLocalDate(options.date)
    if (parsedDate == null) return invalidOption('--date must use YYYY-MM-DD.')
    since = parsedDate
    until = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate() + 1)
  } else {
    try {
      const range = parseTimeRange({ since: options.since, until: options.until })
      since = range.since
      until = range.until
    } catch {
      return invalidOption('Use positive relative durations or ISO timestamps with zones; --since must be earlier than --until.')
    }
  }

  const scopes = [
    parsedMessageId != null,
    groupedId != null,
    fromId != null || toId != null,
    since != null || until != null,
    options.all === true,
  ].filter(Boolean).length
  if (scopes !== 1) {
    return invalidOption('Select exactly one download scope: message id, --grouped-id, --from/--to, --date/--since/--until, or --all.')
  }
  if (groupedId != null && groupedId.trim() === '') {
    return invalidOption('grouped id must be a non-empty string.')
  }
  if (attachment != null && parsedMessageId == null && groupedId == null) {
    return invalidOption('--attachment can only be used with a single message id or --grouped-id.')
  }

  return {
    ok: true,
    data: {
      chat: parseChat(effectiveChat),
      ...(parsedMessageId == null ? {} : { messageId: parsedMessageId }),
      ...(groupedId == null ? {} : { groupedId }),
      ...(attachment == null ? {} : { attachment }),
      ...(fromId == null ? {} : { fromId }),
      ...(toId == null ? {} : { toId }),
      ...(since == null ? {} : { since }),
      ...(until == null ? {} : { until }),
      ...(options.all === true ? { all: true } : {}),
      ...(options.force === true ? { force: true } : {}),
      output: options.output ?? defaultDownloadOutput(),
      ...(concurrency == null ? {} : { concurrency }),
    },
  }
}

function messageDbDownloadStatusStore(db: MessageDB): DownloadStatusStore {
  return {
    isAttachmentDownloaded: ({ chatId, msgId, attachmentIndex }) => {
      const [message] = db.getMessagesByKeys([{ chatId, msgId }])
      return message?.attachments.find((attachment) => attachment.attachment_index === attachmentIndex)?.downloaded === true
    },
    markAttachmentDownloaded: (input) => db.markAttachmentDownloaded(input),
  }
}

function effectiveOutputIsStructured(options: { json?: boolean; yaml?: boolean }): boolean {
  return options.json === true || options.yaml === true
}

function localGroupedDownloadMessages(
  dbPath: string,
  input: DownloadInput,
): ArchiveMessage[] {
  if (input.groupedId == null || !existsSync(dbPath)) return []
  const db = new MessageDB(dbPath, { readonly: true })
  try {
    const chatId = typeof input.chat === 'number'
      ? input.chat
      : db.resolveChatId(String(input.chat))
    if (chatId == null) return []
    return db.findMessagesByGroupedId(chatId, input.groupedId)
  } finally {
    db.close()
  }
}

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return String(parsed) === value.trim() && parsed > 0 ? parsed : undefined
}

function parseLocalDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (match == null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
  return date
}

function defaultDownloadOutput(): string {
  return join(homedir(), 'Downloads', 'telegram-cli')
}

function invalidOption(message: string): HandlerResult<never> {
  return { ok: false, error: { code: 'invalid_option', message } }
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

function createSyncProgressReporter(options: SyncFlags): ((count: number) => void) | undefined {
  if (options.json || options.yaml || options.markdown) return undefined
  let reported = 0
  return (count) => {
    const next = Math.floor(count / 100) * 100
    if (next <= reported) return
    for (let current = reported + 100; current <= next; current += 100) {
      process.stderr.write(`fetched ${current} messages...\n`)
    }
    reported = next
  }
}

type RefreshStatusReporter = {
  onChatStart: (chatName: string) => void
  onChatComplete: (chatName: string, count: number, error?: string) => void
  onProgress: (chatName: string, count: number) => void
}

function createRefreshStatusReporter(options: SyncFlags): RefreshStatusReporter | undefined {
  if (options.json || options.yaml || options.markdown) return undefined
  const reportedByChat = new Map<string, number>()
  return {
    onChatStart: (chatName) => {
      process.stderr.write(`${chatName}: syncing...\n`)
    },
    onChatComplete: (chatName, count, error) => {
      if (error == null) {
        process.stderr.write(`${chatName}: synced ${count} new messages.\n`)
      } else {
        process.stderr.write(`${chatName}: failed (${error})\n`)
      }
    },
    onProgress: (chatName, count) => {
      const reported = reportedByChat.get(chatName) ?? 0
      const next = Math.floor(count / 100) * 100
      if (next <= reported) return
      for (let current = reported + 100; current <= next; current += 100) {
        process.stderr.write(`${chatName}: fetched ${current} messages...\n`)
      }
      reportedByChat.set(chatName, next)
    },
  }
}

function createInterruptibleSyncAllStop(options: SyncFlags): { signal: AbortSignal; interrupted: boolean; dispose: () => void } {
  const controller = new AbortController()
  let interrupted = false
  const requestStop = () => {
    if (controller.signal.aborted) return
    interrupted = true
    controller.abort()
    if (!options.json && !options.yaml && !options.markdown) {
      process.stderr.write('sync-all interrupted; finishing current chat before stopping...\n')
    }
  }
  process.once('SIGINT', requestStop)
  process.once('SIGTERM', requestStop)
  return {
    signal: controller.signal,
    get interrupted() {
      return interrupted
    },
    dispose: () => {
      process.off('SIGINT', requestStop)
      process.off('SIGTERM', requestStop)
    },
  }
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
  await runTelegramWriteCommand(options, async (client) => {
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
