import { existsSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, extname, join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { HandlerResult, HumanOutput } from '../commands/types.js'
import type { ArchiveMessage, TelegramArchiveAdapter } from '../telegram/archive-types.js'
import { sanitizeAttachmentFileName } from './attachment-download.js'

export type DownloadInput = {
  chat: string | number
  messageId?: number
  groupedId?: string
  groupedMessages?: ArchiveMessage[]
  attachment?: number
  fromId?: number
  toId?: number
  since?: Date
  until?: Date
  all?: boolean
  output: string
  concurrency?: number
}

export type DownloadedMedia = {
  chat_id: number
  msg_id: number
  attachment: number
  path: string
}

export type DownloadResult = {
  chat: string | number
  output: string
  requested: number
  downloaded: number
  skipped: number
  failed: number
  flood_waits: number
  files: DownloadedMedia[]
  failures: Array<{ msg_id: number; attachment: number; error: string }>
}

type DownloadDependencies = {
  sleep?: (milliseconds: number) => Promise<void>
  exists?: (path: string) => boolean
  uuid?: () => string
}

type DownloadTarget = {
  chat: string | number
  message: ArchiveMessage
  attachment: number
  destination: string
}

const MAX_FLOOD_RETRIES = 5

export class DownloadService {
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly exists: (path: string) => boolean
  private readonly uuid: () => string

  constructor(
    private readonly source: TelegramArchiveAdapter,
    dependencies: DownloadDependencies = {},
  ) {
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.exists = dependencies.exists ?? existsSync
    this.uuid = dependencies.uuid ?? randomUUID
  }

  async download(input: DownloadInput): Promise<HandlerResult<DownloadResult>> {
    const invalid = validateDownloadInput(input)
    if (invalid != null) return invalid
    if (input.groupedId != null && input.groupedMessages == null) {
      return {
        ok: false,
        error: {
          code: 'download_grouped_id_not_resolved',
          message: `Grouped album ${input.groupedId} was not resolved from the local message cache.`,
        },
      }
    }

    const targets = await this.collectTargets(input)
    if ((input.messageId != null || input.groupedId != null) && input.attachment != null && targets.length === 0) {
      return {
        ok: false,
        error: {
          code: 'download_attachment_not_found',
          message: `${input.groupedId == null ? `Message ${input.messageId}` : `Grouped album ${input.groupedId}`} does not have attachment ${input.attachment}.`,
        },
      }
    }

    const result: DownloadResult = {
      chat: input.chat,
      output: input.output,
      requested: targets.length,
      downloaded: 0,
      skipped: this.lastSkipped,
      failed: 0,
      flood_waits: 0,
      files: [],
      failures: [],
    }

    await mkdir(input.output, { recursive: true })
    await this.runDownloads(targets, Math.max(1, Math.floor(input.concurrency ?? 3)), result)
    result.files.sort((left, right) => right.msg_id - left.msg_id || left.attachment - right.attachment)

    const output = { ...result, human: downloadSummary(result) }
    if (result.failed > 0) {
      return {
        ok: false,
        error: {
          code: 'download_partial_failure',
          message: 'Download completed with one or more attachment failures.',
          details: output,
        },
      }
    }
    return { ok: true, data: result, human: output.human }
  }

  private lastSkipped = 0

  private async collectTargets(input: DownloadInput): Promise<DownloadTarget[]> {
    this.lastSkipped = 0
    if (input.groupedMessages != null) return this.targetsFromGroupedMessages(input.groupedMessages, input)

    const targets: DownloadTarget[] = []
    const reserved = new Set<string>()
    const lower = lowerMessageId(input)
    const upper = upperMessageId(input)
    const minId = lower == null ? undefined : lower - 1

    for await (const page of this.source.iterHistoryPages({
      chat: input.chat,
      ...(input.since == null ? {} : { since: input.since }),
      ...(input.until == null ? {} : { until: input.until }),
      ...(minId == null ? {} : { minId }),
    })) {
      for (const message of page) {
        if (lower != null && message.msg_id < lower) continue
        if (upper != null && message.msg_id > upper) continue
        if (!matchesDateRange(message, input)) continue
        if (message.attachment?.downloadable !== true) {
          if (message.attachment != null) this.lastSkipped += 1
          continue
        }
        const attachmentNumber = 1
        if (input.attachment != null && input.attachment !== attachmentNumber) continue
        const destination = uniqueDestination(input.output, fileNameForMessage(message), this.exists, reserved)
        reserved.add(destination)
        targets.push({ chat: input.chat, message, attachment: attachmentNumber, destination })
      }
    }

    return targets
  }

  private targetsFromGroupedMessages(
    messages: ArchiveMessage[],
    input: DownloadInput,
  ): DownloadTarget[] {
    const reserved = new Set<string>()
    const ordered = [...messages].sort((left, right) => left.msg_id - right.msg_id)
    const targets: DownloadTarget[] = []
    ordered.forEach((message, index) => {
      const attachmentNumber = index + 1
      if (input.attachment != null && input.attachment !== attachmentNumber) return
      if (message.attachment?.downloadable !== true) {
        if (message.attachment != null) this.lastSkipped += 1
        return
      }
      const destination = uniqueDestination(input.output, fileNameForMessage(message), this.exists, reserved)
      reserved.add(destination)
      targets.push({ chat: input.chat, message, attachment: attachmentNumber, destination })
    })
    return targets
  }

  private async runDownloads(targets: DownloadTarget[], concurrency: number, result: DownloadResult): Promise<void> {
    let index = 0
    const worker = async () => {
      while (index < targets.length) {
        const target = targets[index]!
        index += 1
        await this.downloadOne(target, result)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  }

  private async downloadOne(target: DownloadTarget, result: DownloadResult): Promise<void> {
    await mkdir(dirname(target.destination), { recursive: true })
    const temporary = join(dirname(target.destination), `.telegram-cli-download-${this.uuid()}.part`)
    const handle = await open(temporary, 'wx')
    await handle.close()

    try {
      let floodRetries = 0
      while (true) {
        try {
          await this.source.downloadMedia({
            chat: target.chat,
            messageId: target.message.msg_id,
            destination: temporary,
          })
          break
        } catch (error) {
          const seconds = floodWaitSeconds(error)
          if (!Number.isFinite(seconds) || floodRetries >= MAX_FLOOD_RETRIES) throw error
          floodRetries += 1
          result.flood_waits += 1
          await this.sleep((seconds + 1) * 1000)
        }
      }
      await rename(temporary, target.destination)
      result.downloaded += 1
      result.files.push({
        chat_id: target.message.chat_id,
        msg_id: target.message.msg_id,
        attachment: target.attachment,
        path: target.destination,
      })
    } catch (error) {
      result.failed += 1
      result.failures.push({
        msg_id: target.message.msg_id,
        attachment: target.attachment,
        error: errorMessage(error),
      })
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

function validateDownloadInput(input: DownloadInput): HandlerResult<never> | null {
  if (String(input.chat).trim() === '') return invalidOption('chat must be a non-empty string.')
  if (!input.output.trim()) return invalidOption('output must be a non-empty path.')
  if (input.messageId != null && !isPositiveInteger(input.messageId)) return invalidOption('message id must be a positive integer.')
  if (input.attachment != null && !isPositiveInteger(input.attachment)) return invalidOption('attachment must be a positive integer.')
  if (input.fromId != null && !isPositiveInteger(input.fromId)) return invalidOption('from id must be a positive integer.')
  if (input.toId != null && !isPositiveInteger(input.toId)) return invalidOption('to id must be a positive integer.')
  if (input.concurrency != null && !isPositiveInteger(input.concurrency)) return invalidOption('concurrency must be a positive integer.')
  if (input.since != null && input.until != null && input.since.getTime() >= input.until.getTime()) {
    return invalidOption('since must be earlier than until.')
  }
  const scopes = [
    input.messageId != null,
    input.groupedId != null,
    input.fromId != null || input.toId != null,
    input.since != null || input.until != null,
    input.all === true,
  ].filter(Boolean).length
  if (scopes !== 1) {
    return invalidOption('Select exactly one download scope: message id, --grouped-id, --from/--to, --date/--since/--until, or --all.')
  }
  if (input.groupedId != null && input.groupedId.trim() === '') return invalidOption('grouped id must be a non-empty string.')
  if (input.attachment != null && input.messageId == null && input.groupedId == null) {
    return invalidOption('--attachment can only be used with a single message id or --grouped-id.')
  }
  return null
}

function invalidOption(message: string): HandlerResult<never> {
  return { ok: false, error: { code: 'invalid_option', message } }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function lowerMessageId(input: DownloadInput): number | undefined {
  if (input.messageId != null) return input.messageId
  if (input.fromId != null && input.toId != null) return Math.min(input.fromId, input.toId)
  return input.fromId ?? input.toId
}

function upperMessageId(input: DownloadInput): number | undefined {
  if (input.messageId != null) return input.messageId
  if (input.fromId != null && input.toId != null) return Math.max(input.fromId, input.toId)
  return input.fromId ?? input.toId
}

function matchesDateRange(message: ArchiveMessage, input: DownloadInput): boolean {
  const timestamp = Date.parse(message.timestamp)
  if (!Number.isFinite(timestamp)) return false
  if (input.since != null && timestamp < input.since.getTime()) return false
  if (input.until != null && timestamp >= input.until.getTime()) return false
  return true
}

function fileNameForMessage(message: ArchiveMessage): string {
  const raw = message.attachment?.file_name?.trim()
  if (raw) return raw
  const extension = extensionForAttachment(message.attachment?.type)
  return `${message.chat_id}-${message.msg_id}.${extension}`
}

function extensionForAttachment(type: string | undefined): string {
  switch (type?.toLowerCase()) {
    case 'photo':
      return 'jpg'
    case 'video':
      return 'mp4'
    case 'audio':
      return 'mp3'
    case 'voice':
      return 'ogg'
    case 'sticker':
      return 'webp'
    case 'animation':
      return 'mp4'
    default:
      return 'bin'
  }
}

function uniqueDestination(
  directory: string,
  fileName: string,
  exists: (path: string) => boolean,
  reserved: Set<string>,
): string {
  const safeName = sanitizeAttachmentFileName(fileName)
  let destination = join(directory, safeName)
  if (!exists(destination) && !reserved.has(destination)) return destination
  const extension = extname(safeName)
  const baseName = parse(safeName).name
  let index = 2
  do {
    destination = join(directory, `${baseName} (${index})${extension}`)
    index += 1
  } while (exists(destination) || reserved.has(destination))
  return destination
}

function floodWaitSeconds(error: unknown): number {
  if (error != null && typeof error === 'object') {
    const maybe = error as { seconds?: unknown; text?: unknown; message?: unknown }
    if (typeof maybe.seconds === 'number' && Number.isFinite(maybe.seconds)) return maybe.seconds
    const text = typeof maybe.text === 'string' ? maybe.text : typeof maybe.message === 'string' ? maybe.message : ''
    const match = /FLOOD_WAIT_(\d+)/.exec(text)
    if (match != null) return Number(match[1])
  }
  return Number.NaN
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function downloadSummary(result: DownloadResult): HumanOutput {
  return {
    kind: 'summary',
    title: 'Download',
    fields: [
      { label: 'Requested', value: String(result.requested) },
      { label: 'Downloaded', value: String(result.downloaded), tone: result.failed === 0 ? 'success' : 'warning' },
      { label: 'Skipped', value: String(result.skipped) },
      { label: 'Failed', value: String(result.failed), tone: result.failed === 0 ? 'default' : 'danger' },
      { label: 'Flood Waits', value: String(result.flood_waits), tone: result.flood_waits === 0 ? 'default' : 'warning' },
      { label: 'Output', value: result.output },
    ],
    table: {
      columns: ['MESSAGE', 'ATTACHMENT', 'PATH'],
      rows: result.files.map((file) => [String(file.msg_id), String(file.attachment), file.path]),
      emptyText: 'No media downloaded.',
    },
  }
}
