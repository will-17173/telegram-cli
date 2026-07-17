import { existsSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, extname, join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { CommandFailure, HandlerResult, HumanOutput } from '../commands/types.js'
import type { ArchiveMessage, TelegramArchiveAdapter } from '../telegram/archive-types.js'
import { AttachmentLookupError, toAttachmentLocator } from '../telegram/attachment-locator.js'
import type { Attachment, MediaKind } from '../telegram/media-types.js'
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
  force?: boolean
  output: string
  concurrency?: number
}

export type DownloadedMedia = {
  chat_id: number
  msg_id: number
  selection_index: number
  attachment_index: number
  kind: MediaKind
  path: string
}

export type DownloadSkip = {
  msg_id: number
  selection_index: number
  attachment_index: number
  kind: MediaKind
  reason: string
}

export type DownloadFailure = {
  msg_id: number
  selection_index: number
  attachment_index: number
  kind: MediaKind
  code: 'attachment_changed' | 'media_access_denied' | 'download_partial_failure'
  error: string
}

export type DownloadWarning = {
  msg_id: number
  attachment_index: number
  code: 'download_status_update_failed'
  message: string
}

export type DownloadStatusStore = {
  isAttachmentDownloaded(input: { chatId: number; msgId: number; attachmentIndex: number }): boolean
  markAttachmentDownloaded(input: { chatId: number; msgId: number; attachmentIndex: number; path: string; downloadedAt: string }): boolean
}

export type DownloadResult = {
  chat: string | number
  output: string
  requested: number
  downloaded: number
  skipped: number
  already_downloaded: number
  failed: number
  flood_waits: number
  files: DownloadedMedia[]
  skips: DownloadSkip[]
  failures: DownloadFailure[]
  warnings: DownloadWarning[]
}

type DownloadDependencies = {
  sleep?: (milliseconds: number) => Promise<void>
  exists?: (path: string) => boolean
  uuid?: () => string
  now?: () => Date
  onNotice?: (message: string) => void
  downloadStatusStore?: DownloadStatusStore
}

type DownloadTarget = {
  chat: string | number
  message: ArchiveMessage
  attachment: Attachment
  selectionIndex: number
  destination: string
}

const MAX_FLOOD_RETRIES = 5

export class DownloadService {
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly exists: (path: string) => boolean
  private readonly uuid: () => string
  private readonly now: () => Date
  private readonly onNotice: (message: string) => void
  private readonly downloadStatusStore?: DownloadStatusStore

  constructor(
    private readonly source: TelegramArchiveAdapter,
    dependencies: DownloadDependencies = {},
  ) {
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.exists = dependencies.exists ?? existsSync
    this.uuid = dependencies.uuid ?? randomUUID
    this.now = dependencies.now ?? (() => new Date())
    this.onNotice = dependencies.onNotice ?? (() => undefined)
    this.downloadStatusStore = dependencies.downloadStatusStore
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
    if (this.lastSelectionError != null) {
      return {
        ok: false,
        error: this.lastSelectionError,
      }
    }

    const result: DownloadResult = {
      chat: input.chat,
      output: input.output,
      requested: targets.length,
      downloaded: 0,
      skipped: this.lastSkips.length,
      already_downloaded: this.lastAlreadyDownloaded,
      failed: 0,
      flood_waits: 0,
      files: [],
      skips: this.lastSkips,
      failures: [],
      warnings: [],
    }

    await mkdir(input.output, { recursive: true })
    await this.runDownloads(targets, Math.max(1, Math.floor(input.concurrency ?? 3)), result)
    result.files.sort((left, right) => right.msg_id - left.msg_id || left.selection_index - right.selection_index)

    const output = { ...result, human: downloadSummary(result) }
    if (result.failed > 0) {
      const onlyFailure = result.failures.length === 1 ? result.failures[0] : undefined
      if (
        targets.length === 1
        && result.downloaded === 0
        && input.attachment != null
        && onlyFailure != null
        && (onlyFailure.code === 'attachment_changed' || onlyFailure.code === 'media_access_denied')
      ) {
        return {
          ok: false,
          error: {
            code: onlyFailure.code,
            message: onlyFailure.error,
            details: output,
          },
        }
      }
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

  private lastSkips: DownloadSkip[] = []
  private lastAlreadyDownloaded = 0
  private lastSelectionError: CommandFailure['error'] | null = null

  private async collectTargets(input: DownloadInput): Promise<DownloadTarget[]> {
    this.lastSkips = []
    this.lastAlreadyDownloaded = 0
    this.lastSelectionError = null
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
        const selected = this.selectMessageTargets(message, input, reserved)
        targets.push(...selected)
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
    let selectionIndex = 0
    for (const message of ordered) {
      for (const attachment of orderedAttachments(message)) {
        selectionIndex += 1
        if (input.attachment != null && input.attachment !== selectionIndex) continue
        if (!attachment.downloadable) {
          if (input.attachment === selectionIndex) {
            this.lastSelectionError = {
              code: 'attachment_not_downloadable',
              message: `Attachment ${selectionIndex} in grouped album ${input.groupedId} is not downloadable.`,
            }
          } else if (input.attachment == null) {
            this.lastSkips.push(skipFor(message, attachment, selectionIndex, 'attachment_not_downloadable'))
          }
          continue
        }
        if (this.skipAlreadyDownloaded(message, attachment, selectionIndex, input)) continue
        const destination = uniqueDestination(input.output, fileNameForAttachment(message, attachment), this.exists, reserved)
        reserved.add(destination)
        targets.push({ chat: input.chat, message, attachment, selectionIndex, destination })
      }
    }
    if (input.attachment != null && targets.length === 0 && this.lastSelectionError == null) {
      this.lastSelectionError = {
        code: 'attachment_not_found',
        message: `Grouped album ${input.groupedId} does not have attachment ${input.attachment}.`,
      }
    }
    return targets
  }

  private selectMessageTargets(
    message: ArchiveMessage,
    input: DownloadInput,
    reserved: Set<string>,
  ): DownloadTarget[] {
    const attachments = orderedAttachments(message)
    const targets: DownloadTarget[] = []
    for (const attachment of attachments) {
      const selectionIndex = attachment.attachment_index
      if (input.attachment != null && input.attachment !== selectionIndex) continue
      if (!attachment.downloadable) {
        if (input.attachment === selectionIndex) {
          this.lastSelectionError = {
            code: 'attachment_not_downloadable',
            message: `Attachment ${selectionIndex} in message ${message.msg_id} is not downloadable.`,
          }
        } else if (input.attachment == null) {
          this.lastSkips.push(skipFor(message, attachment, selectionIndex, 'attachment_not_downloadable'))
        }
        continue
      }
      if (this.skipAlreadyDownloaded(message, attachment, selectionIndex, input)) continue
      const destination = uniqueDestination(input.output, fileNameForAttachment(message, attachment), this.exists, reserved)
      reserved.add(destination)
      targets.push({ chat: input.chat, message, attachment, selectionIndex, destination })
    }
    if (input.messageId != null && input.attachment != null && targets.length === 0 && this.lastSelectionError == null) {
      this.lastSelectionError = {
        code: 'attachment_not_found',
        message: `Message ${message.msg_id} does not have attachment ${input.attachment}.`,
      }
    }
    return targets
  }

  private skipAlreadyDownloaded(
    message: ArchiveMessage,
    attachment: Attachment,
    selectionIndex: number,
    input: DownloadInput,
  ): boolean {
    if (input.force === true) return false
    const downloaded = this.downloadStatusStore?.isAttachmentDownloaded({
      chatId: message.chat_id,
      msgId: message.msg_id,
      attachmentIndex: attachment.attachment_index,
    }) === true
    if (!downloaded) return false
    this.lastSkips.push(skipFor(message, attachment, selectionIndex, 'already_downloaded'))
    this.lastAlreadyDownloaded += 1
    this.onNotice(`already downloaded: message ${message.msg_id} attachment ${attachment.attachment_index}`)
    return true
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
            msgId: target.message.msg_id,
            attachment: toAttachmentLocator(target.attachment),
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
        selection_index: target.selectionIndex,
        attachment_index: target.attachment.attachment_index,
        kind: target.attachment.kind,
        path: target.destination,
      })
      const marked = this.downloadStatusStore?.markAttachmentDownloaded({
        chatId: target.message.chat_id,
        msgId: target.message.msg_id,
        attachmentIndex: target.attachment.attachment_index,
        path: target.destination,
        downloadedAt: this.now().toISOString(),
      })
      if (marked === false) {
        result.warnings.push({
          msg_id: target.message.msg_id,
          attachment_index: target.attachment.attachment_index,
          code: 'download_status_update_failed',
          message: `Downloaded media but could not update local status for message ${target.message.msg_id} attachment ${target.attachment.attachment_index}.`,
        })
      }
    } catch (error) {
      result.failed += 1
      result.failures.push({
        msg_id: target.message.msg_id,
        selection_index: target.selectionIndex,
        attachment_index: target.attachment.attachment_index,
        kind: target.attachment.kind,
        code: downloadFailureCode(error),
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

function orderedAttachments(message: ArchiveMessage): Attachment[] {
  return message.attachments
    .slice()
    .sort((left, right) => left.attachment_index - right.attachment_index)
}

function skipFor(
  message: ArchiveMessage,
  attachment: Attachment,
  selectionIndex: number,
  reason: string,
): DownloadSkip {
  return {
    msg_id: message.msg_id,
    selection_index: selectionIndex,
    attachment_index: attachment.attachment_index,
    kind: attachment.kind,
    reason,
  }
}

function fileNameForAttachment(message: ArchiveMessage, attachment: Attachment): string {
  const raw = attachment.file_name?.trim()
  if (raw) return raw
  const extension = extensionForAttachment(attachment)
  return `${message.chat_id}-${message.msg_id}-${attachment.attachment_index}.${extension}`
}

function extensionForAttachment(attachment: Attachment): string {
  const mimeExtension = attachment.mime_type == null
    ? undefined
    : MIME_EXTENSIONS[attachment.mime_type.toLowerCase()]
  if (mimeExtension != null) return mimeExtension
  switch (attachment.kind) {
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
    default:
      return 'bin'
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
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

function downloadFailureCode(error: unknown): DownloadFailure['code'] {
  if (error instanceof AttachmentLookupError) {
    return error.code === 'attachment_changed'
      ? 'attachment_changed'
      : 'media_access_denied'
  }
  if (isMediaAccessDenied(error)) return 'media_access_denied'
  return 'download_partial_failure'
}

function isMediaAccessDenied(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return message.includes('protected')
    || message.includes('permission')
    || message.includes('access')
    || message.includes('paid')
    || message.includes('not downloadable')
    || message.includes('cannot be downloaded')
}

function downloadSummary(result: DownloadResult): HumanOutput {
  return {
    kind: 'summary',
    title: 'Download',
    fields: [
      { label: 'Requested', value: String(result.requested) },
      { label: 'Downloaded', value: String(result.downloaded), tone: result.failed === 0 ? 'success' : 'warning' },
      { label: 'Skipped', value: String(result.skipped) },
      { label: 'Already Downloaded', value: String(result.already_downloaded) },
      { label: 'Failed', value: String(result.failed), tone: result.failed === 0 ? 'default' : 'danger' },
      { label: 'Flood Waits', value: String(result.flood_waits), tone: result.flood_waits === 0 ? 'default' : 'warning' },
      { label: 'Output', value: result.output },
    ],
    table: {
      columns: ['MESSAGE', 'ATTACHMENT', 'PATH'],
      rows: result.files.map((file) => [String(file.msg_id), String(file.selection_index), file.path]),
      emptyText: 'No media downloaded.',
    },
  }
}
