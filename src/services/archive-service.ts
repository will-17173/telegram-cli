import {
  closeSync,
  copyFileSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ParsedTimeRange } from '../commands/time-range.js'
import type { HandlerResult } from '../commands/types.js'
import { toAttachmentLocator } from '../telegram/attachment-locator.js'
import type { ArchiveChat, ArchiveMessage, TelegramArchiveAdapter } from '../telegram/archive-types.js'
import type { Attachment } from '../telegram/media-types.js'
import { isTelegramAuthSessionError } from '../telegram/errors.js'
import { archiveChatFile, archiveMediaFile } from './archive-layout.js'
import {
  readArchiveManifest,
  validateArchiveAccount,
  writeArchiveManifest,
} from './archive-manifest.js'
import {
  renderArchiveHeader,
  renderArchiveMessage,
  scanArchiveRecovery,
  type ArchiveAttachmentRenderState,
} from './archive-markdown.js'
import type {
  ArchiveChatState,
  ArchiveCommandResult,
  ArchiveManifest,
} from './archive-types.js'

const DEFAULT_HISTORY_MS = 7 * 86_400_000
const MANIFEST_FILE = 'archive-manifest.json'
const BLOCK_SEPARATOR = '\n\n---\n\n'

export type ArchiveAccountIdentity = {
  userId: number
  name: string
}

export type ArchiveServiceInput = {
  account: ArchiveAccountIdentity
  chats: Array<string | number>
  all: boolean
  output: string
  range?: ParsedTimeRange
  full?: boolean
  rebuild?: boolean
  media?: boolean
  now?: Date
}

type EffectiveRange = {
  since?: Date
  until?: Date
  full: boolean
}

type ChatArchiveResult = {
  state: ArchiveChatState
  messages: number
  media: number
  warnings: ArchiveCommandResult['warnings']
  finalize: () => void
  rollback: () => void
}

type MediaDownloadResult = {
  path?: string
  archived: boolean
  reused?: boolean
  warning?: ArchiveCommandResult['warnings'][number]
}

type MessageMediaDownloadResult = {
  states: ArchiveAttachmentRenderState[]
  archived: number
  warnings: ArchiveCommandResult['warnings']
}

type PreparedMediaTarget = {
  root: string
  destination: string
  directory: string
  identities: string[]
  reused: boolean
}

export type ArchiveTransactionOperations = {
  backupDestination: (source: string, backup: string) => void
  replaceDestination: (temporary: string, destination: string) => void
  rollbackDestination: (destination: string, backup?: string) => void
  cleanupBackup: (backup: string) => void
  syncDirectory: (directory: string) => void
}

type ArchiveServiceDependencies = {
  writeManifest?: typeof writeArchiveManifest
  writeArchive?: typeof writeArchiveFile
  restoreManifest?: (path: string, manifest: ArchiveManifest | null) => void
  transaction?: Partial<ArchiveTransactionOperations>
}

class ArchiveOperationError extends Error {
  constructor(message: string, readonly fatal = false) {
    super(message)
  }
}

export class ArchiveService {
  private readonly writeManifest: typeof writeArchiveManifest
  private readonly writeArchive: typeof writeArchiveFile
  private readonly restoreManifest: (path: string, manifest: ArchiveManifest | null) => void
  private readonly transaction: ArchiveTransactionOperations

  constructor(
    private readonly source: TelegramArchiveAdapter,
    dependencies: ArchiveServiceDependencies = {},
  ) {
    this.writeManifest = dependencies.writeManifest ?? writeArchiveManifest
    this.writeArchive = dependencies.writeArchive ?? writeArchiveFile
    this.restoreManifest = dependencies.restoreManifest ?? restoreManifestSnapshot
    const sync = dependencies.transaction?.syncDirectory ?? syncDirectory
    this.transaction = {
      backupDestination: dependencies.transaction?.backupDestination
        ?? ((source, backup) => backupFile(source, backup, sync)),
      replaceDestination: dependencies.transaction?.replaceDestination
        ?? ((temporary, destination) => {
          renameSync(temporary, destination)
          sync(dirname(destination))
        }),
      rollbackDestination: dependencies.transaction?.rollbackDestination
        ?? ((destination, backup) => {
          if (backup == null) {
            try {
              unlinkSync(destination)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          } else {
            renameSync(backup, destination)
          }
          sync(dirname(destination))
        }),
      cleanupBackup: dependencies.transaction?.cleanupBackup
        ?? ((backup) => {
          unlinkSync(backup)
          sync(dirname(backup))
        }),
      syncDirectory: sync,
    }
  }

  async archive(input: ArchiveServiceInput): Promise<HandlerResult<ArchiveCommandResult>> {
    validateInput(input)

    const now = input.now ?? new Date()
    const timestamp = now.toISOString()
    const manifestPath = join(input.output, MANIFEST_FILE)
    const existing = readArchiveManifest(manifestPath)
    if (existing != null) validateArchiveAccount(existing, input.account)

    let manifest: ArchiveManifest = existing ?? {
      schema_version: 2,
      account_name: input.account.name,
      account_user_id: input.account.userId,
      created_at: timestamp,
      updated_at: timestamp,
      chats: {},
    }
    let manifestPersisted = existing != null

    const chats = await this.source.resolveChats({
      chats: input.all ? undefined : input.chats,
      all: input.all,
    })
    mkdirSync(input.output, { recursive: true })

    const result: ArchiveCommandResult = {
      manifest: manifestPath,
      completed: [],
      failed: [],
      warnings: [],
    }

    for (const chat of chats) {
      const previous = manifest.chats[String(chat.id)]

      try {
        const range = effectiveRange(input, previous, now)
        validateEffectiveRange(range)
        const archived = await this.archiveChat(
          chat,
          input.output,
          range,
          now,
          previous,
          input.rebuild === true,
          input.media === true,
        )
        const candidate: ArchiveManifest = {
          ...manifest,
          account_name: input.account.name,
          updated_at: timestamp,
          chats: {
            ...manifest.chats,
            [String(chat.id)]: archived.state,
          },
        }
        try {
          this.writeManifest(manifestPath, candidate)
        } catch {
          const failures = ['archive_manifest_commit_failed']
          let fatal = false
          try {
            this.restoreManifest(manifestPath, manifestPersisted ? manifest : null)
          } catch {
            failures.push('archive_manifest_recovery_failed')
            fatal = true
          }
          try {
            archived.rollback()
          } catch {
            failures.push('archive_rollback_failed')
            fatal = true
          }
          throw new ArchiveOperationError(failures.join(';'), fatal)
        }
        manifest = candidate
        manifestPersisted = true
        let cleanupFailed = false
        try {
          archived.finalize()
        } catch {
          cleanupFailed = true
        }
        result.completed.push({
          chat_id: chat.id,
          title: chat.title,
          file: archived.state.file,
          messages_archived: archived.messages,
          media_archived: archived.media,
        })
        result.warnings.push(...archived.warnings)
        if (cleanupFailed) {
          result.warnings.push({
            chat_id: chat.id,
            code: 'archive_backup_cleanup_failed',
            message: 'Archive committed, but recovery-backup cleanup could not be confirmed.',
          })
        }
      } catch (error) {
        if (isTelegramAuthSessionError(error)) throw error
        const failure = publicArchiveFailure(error)
        result.failed.push({
          chat_id: chat.id,
          title: chat.title,
          error: failure.message,
        })
        if (failure.fatal) break
      }
    }

    if (result.failed.length === 0 && result.warnings.length === 0) {
      return { ok: true, data: result }
    }
    return {
      ok: false,
      error: {
        code: 'archive_partial_failure',
        message: 'Archive completed with one or more chat or attachment failures.',
        details: {
          completed: result.completed,
          failed: result.failed,
          warnings: result.warnings,
        },
      },
    }
  }

  private async archiveChat(
    chat: ArchiveChat,
    output: string,
    range: EffectiveRange,
    now: Date,
    previous?: ArchiveChatState,
    rebuild = false,
    downloadMedia = false,
  ): Promise<ChatArchiveResult> {
    const file = previous?.file ?? archiveChatFile(chat.id, chat.title)
    const destination = join(output, file)
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const ownedPaths: string[] = []
    const segments: string[] = []
    let backup: string | undefined
    let replacementAttempted = false
    let newest: ArchiveMessage | undefined
    let messages = 0
    let media = 0
    const warnings: ArchiveCommandResult['warnings'] = []

    try {
      const incremental = previous != null && !rebuild && existsSync(destination)
      const recovery = incremental
        ? await scanArchiveRecovery(createReadStream(destination), {
          expectedChatId: chat.id,
          onMedia: downloadMedia ? async (link) => {
            const recovered = recoveredMessageForLink(chat, link.messageId, link.attachmentIndex, link.path)
            const downloaded = await this.downloadMediaFile(
              output,
              chat,
              recovered,
              recovered.attachments[0]!,
              link.path,
              token,
            )
            if (downloaded.archived && !downloaded.reused) media += 1
            if (downloaded.warning != null) warnings.push(downloaded.warning)
          } : undefined,
        })
        : { maxId: null, maxTimestamp: null }
      const effectiveMinId = incremental
        ? maxDefined(previous.last_message_id, recovery.maxId)
        : undefined
      const fetchedIds = new Set<number>()
      let pageNumber = 0
      for await (const page of this.source.iterHistoryPages({
        chat: chat.id,
        since: range.since,
        until: range.until,
        minId: effectiveMinId,
      })) {
        if (page.length === 0) continue
        const unseen = page.filter((item) => {
          if (effectiveMinId != null && item.msg_id <= effectiveMinId) return false
          if (fetchedIds.has(item.msg_id)) return false
          fetchedIds.add(item.msg_id)
          return true
        })
        if (unseen.length === 0) continue
        const segment = join(output, `.${basename(file)}.${token}.${pageNumber}.segment`)
        pageNumber += 1
        ownedPaths.push(segment)

        const chronological = [...unseen].reverse()
        const rendered: string[] = []
        for (const item of chronological) {
          const downloaded = downloadMedia
            ? await this.downloadAttachments(output, chat, item, token)
            : notRequestedAttachmentStates(item)
          media += downloaded.archived
          warnings.push(...downloaded.warnings)
          rendered.push(renderArchiveMessage(item, downloaded.states))
        }
        writeExclusive(segment, rendered.join(BLOCK_SEPARATOR))
        segments.push(segment)
        messages += chronological.length

        for (const item of unseen) {
          if (newest == null || item.msg_id > newest.msg_id) newest = item
        }
      }

      const temporary = join(output, `.${basename(file)}.${token}.tmp`)
      ownedPaths.push(temporary)
      await this.writeArchive(
        temporary,
        renderArchiveHeader(chat, now),
        segments.reverse(),
        incremental ? destination : undefined,
      )
      removeOwned(segments)
      backup = existsSync(destination)
        ? join(output, `.${basename(file)}.${token}.backup`)
        : undefined
      if (backup != null) {
        this.transaction.backupDestination(destination, backup)
      }
      replacementAttempted = true
      this.transaction.replaceDestination(temporary, destination)

      return {
        messages,
        media,
        warnings,
        finalize: () => {
          if (backup != null) this.transaction.cleanupBackup(backup)
        },
        rollback: () => this.transaction.rollbackDestination(destination, backup),
        state: {
          title: chat.title,
          file,
          initial_since: incremental
            ? previous.initial_since
            : range.since?.toISOString() ?? null,
          initial_until: incremental
            ? previous.initial_until
            : range.until?.toISOString() ?? null,
          full_history: incremental ? previous.full_history : range.full,
          last_message_id: newest?.msg_id ?? effectiveMinId ?? null,
          last_message_date: newest?.timestamp == null
            ? recoveredCursorTimestamp(previous, recovery, effectiveMinId)
            : new Date(newest.timestamp).toISOString(),
          last_run: now.toISOString(),
        },
      }
    } catch (error) {
      removeOwnedQuietly(ownedPaths)
      if (replacementAttempted) {
        try {
          this.transaction.rollbackDestination(destination, backup)
        } catch {
          throw new ArchiveOperationError(
            'archive_persistence_failed;archive_rollback_failed',
            true,
          )
        }
        throw new ArchiveOperationError('archive_persistence_failed')
      }
      if (backup != null) {
        try {
          this.transaction.cleanupBackup(backup)
        } catch {
          throw new ArchiveOperationError('archive_backup_cleanup_failed')
        }
      }
      throw error
    }
  }

  private async downloadAttachments(
    output: string,
    chat: ArchiveChat,
    message: ArchiveMessage,
    token: string,
  ): Promise<MessageMediaDownloadResult> {
    const states: ArchiveAttachmentRenderState[] = []
    const warnings: ArchiveCommandResult['warnings'] = []
    let archived = 0

    for (const attachment of orderedAttachments(message)) {
      if (!attachment.downloadable) {
        states.push({ attachment, status: 'not_downloadable' })
        continue
      }
      const downloaded = await this.downloadAttachment(output, chat, message, attachment, token)
      if (downloaded.archived) archived += 1
      if (downloaded.warning != null) warnings.push(downloaded.warning)
      states.push({
        attachment,
        status: downloaded.archived
          ? downloaded.reused === true ? 'reused' : 'downloaded'
          : 'failed',
        ...(downloaded.path == null ? {} : { path: downloaded.path }),
      })
    }

    return { states, archived, warnings }
  }

  private async downloadAttachment(
    output: string,
    chat: ArchiveChat,
    message: ArchiveMessage,
    attachment: Attachment,
    token: string,
  ): Promise<MediaDownloadResult> {
    const relativePath = archiveMediaFile(
      chat.id,
      message.msg_id,
      attachment.attachment_index,
      attachment.file_name ?? `${chat.id}-${message.msg_id}-${attachment.attachment_index}.bin`,
    )
    return this.downloadMediaFile(output, chat, message, attachment, relativePath, token)
  }

  private async downloadMediaFile(
    output: string,
    chat: ArchiveChat,
    message: ArchiveMessage,
    attachment: Attachment,
    relativePath: string,
    token: string,
  ): Promise<MediaDownloadResult> {
    const messageId = message.msg_id
    let prepared: PreparedMediaTarget
    try {
      prepared = this.prepareMediaTarget(output, chat.id, messageId, attachment.attachment_index, relativePath)
    } catch {
      return mediaDownloadFailure(chat.id, messageId, attachment.attachment_index, relativePath)
    }
    if (prepared.reused) return { path: relativePath, archived: true, reused: true }

    const { destination, directory, root } = prepared
    const temporary = join(root, `.media-stage.${token}.${chat.id}.${messageId}.tmp`)
    let stagingOwned = false
    let stagingIdentity = ''
    try {
      stagingIdentity = createOwnedStagingFile(temporary)
      stagingOwned = true
      const beforeDownload = this.prepareMediaTarget(output, chat.id, messageId, attachment.attachment_index, relativePath)
      assertSameMediaTarget(prepared, beforeDownload)
      if (beforeDownload.reused) {
        removeOwnedStagingFile(temporary, stagingIdentity)
        stagingOwned = false
        return { path: relativePath, archived: true, reused: true }
      }
      await this.source.downloadMedia({
        chat: chat.id,
        msgId: messageId,
        attachment: toAttachmentLocator(attachment),
        destination: temporary,
      })
      assertOwnedRegularNonEmptyFile(temporary, stagingIdentity)
      const descriptor = openSync(
        temporary,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      )
      try {
        const status = fstatSync(descriptor, { bigint: true })
        if (!status.isFile()
          || status.size === 0n
          || fileIdentity(status) !== stagingIdentity) {
          throw new Error('archive_unsafe_media_temp')
        }
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      const current = this.prepareMediaTarget(output, chat.id, messageId, attachment.attachment_index, relativePath)
      assertSameMediaTarget(prepared, current)
      if (current.reused) {
        removeOwnedStagingFile(temporary, stagingIdentity)
        stagingOwned = false
        return { path: relativePath, archived: true, reused: true }
      }
      assertOwnedRegularNonEmptyFile(temporary, stagingIdentity)
      // Node has no openat/renameat. Revalidation pins every parent identity immediately
      // before this commit, but a same-user directory swap can still race the rename itself.
      renameSync(temporary, destination)
      stagingOwned = false
      this.transaction.syncDirectory(directory)
      return { path: relativePath, archived: true }
    } catch (error) {
      if (stagingOwned) removeOwnedStagingFile(temporary, stagingIdentity)
      if (isTelegramAuthSessionError(error)) throw error
      return mediaDownloadFailure(chat.id, messageId, attachment.attachment_index, relativePath)
    }
  }

  private prepareMediaTarget(
    output: string,
    chatId: number,
    messageId: number,
    attachmentIndex: number,
    relativePath: string,
  ): PreparedMediaTarget {
    const expectedPrefix = `${messageId}-${attachmentIndex}-`
    const components = relativePath.split('/')
    if (components.length !== 3
      || components[0] !== 'media'
      || components[1] !== String(chatId)
      || !components[2]?.startsWith(expectedPrefix)
      || archiveMediaFile(chatId, messageId, attachmentIndex, components[2].slice(expectedPrefix.length))
        !== relativePath) {
      throw new Error('archive_unsafe_media_path')
    }

    const root = realpathSync(output)
    const rootStatus = lstatSync(root, { bigint: true })
    if (!rootStatus.isDirectory()) throw new Error('archive_unsafe_media_root')
    const identities = [fileIdentity(rootStatus)]
    let directory = root
    for (const component of components.slice(0, -1)) {
      const next = join(directory, component)
      let status
      try {
        status = lstatSync(next, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        mkdirSync(next, { mode: 0o700 })
        this.transaction.syncDirectory(directory)
        status = lstatSync(next, { bigint: true })
      }
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error('archive_unsafe_media_directory')
      }
      const realDirectory = realpathSync(next)
      if (!pathIsWithin(root, realDirectory)) throw new Error('archive_unsafe_media_directory')
      identities.push(fileIdentity(status))
      directory = realDirectory
    }

    const destination = join(directory, components.at(-1)!)
    if (!pathIsWithin(root, destination)) throw new Error('archive_unsafe_media_destination')
    try {
      const status = lstatSync(destination, { bigint: true })
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error('archive_unsafe_media_destination')
      }
      return { root, destination, directory, identities, reused: status.size > 0n }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { root, destination, directory, identities, reused: false }
    }
  }
}

function validateInput(input: ArchiveServiceInput): void {
  const chats = input.chats ?? []
  if (!input.all && chats.length === 0) throw new Error('archive_scope_required')
  if (input.all && chats.length > 0) throw new Error('archive_scope_conflict')
  if (input.full && input.range?.since != null) throw new Error('archive_full_range_conflict')

  const now = input.now ?? new Date()
  const since = input.range?.since
  const until = input.range?.until
  const effectiveSince = input.full || (input.rebuild && since == null && until == null)
    ? since
    : since ?? new Date(now.getTime() - DEFAULT_HISTORY_MS)
  if (!validDate(now)
    || (since != null && !validDate(since))
    || (until != null && !validDate(until))
    || (effectiveSince != null && until != null && effectiveSince.getTime() >= until.getTime())) {
    throw new Error('archive_invalid_time_range')
  }
}

function effectiveRange(
  input: ArchiveServiceInput,
  previous: ArchiveChatState | undefined,
  now: Date,
): EffectiveRange {
  const explicitRange = input.range?.since != null || input.range?.until != null
  if (input.rebuild && previous != null && !input.full && !explicitRange) {
    return {
      since: previous.initial_since == null ? undefined : new Date(previous.initial_since),
      until: previous.initial_until == null ? undefined : new Date(previous.initial_until),
      full: previous.full_history,
    }
  }

  return {
    since: input.full
      ? undefined
      : input.range?.since ?? new Date(now.getTime() - DEFAULT_HISTORY_MS),
    until: input.range?.until,
    full: input.full === true,
  }
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function maxDefined(left: number | null, right: number | null): number | undefined {
  if (left == null) return right ?? undefined
  if (right == null) return left
  return Math.max(left, right)
}

function recoveredCursorTimestamp(
  previous: ArchiveChatState | undefined,
  recovery: { maxId: number | null; maxTimestamp: string | null },
  effectiveMinId: number | undefined,
): string | null {
  if (effectiveMinId == null) return null
  if (recovery.maxId === effectiveMinId) return recovery.maxTimestamp
  if (previous?.last_message_id === effectiveMinId) return previous.last_message_date
  return null
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot !== ''
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
}

function createOwnedStagingFile(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    const status = fstatSync(descriptor, { bigint: true })
    if (!status.isFile()) throw new Error('archive_unsafe_media_temp')
    return fileIdentity(status)
  } finally {
    closeSync(descriptor)
  }
}

function assertSameMediaTarget(
  expected: PreparedMediaTarget,
  actual: PreparedMediaTarget,
): void {
  if (expected.root !== actual.root
    || expected.destination !== actual.destination
    || expected.directory !== actual.directory
    || expected.identities.length !== actual.identities.length
    || expected.identities.some((identity, index) => identity !== actual.identities[index])) {
    throw new Error('archive_unsafe_media_destination')
  }
}

function fileIdentity(status: BigIntStats): string {
  if (status.ino <= 0n || status.dev < 0n) throw new Error('archive_unusable_file_identity')
  return `${status.dev}:${status.ino}`
}

function assertOwnedRegularNonEmptyFile(path: string, identity: string): void {
  const status = lstatSync(path, { bigint: true })
  if (status.isSymbolicLink()
    || !status.isFile()
    || status.size === 0n
    || fileIdentity(status) !== identity) {
    throw new Error('archive_unsafe_media_temp')
  }
}

function removeOwnedStagingFile(path: string, identity: string): void {
  try {
    const status = lstatSync(path, { bigint: true })
    if (status.isSymbolicLink() || !status.isFile() || fileIdentity(status) !== identity) return
    unlinkSync(path)
  } catch {
    // Never follow or remove a staging path whose ownership can no longer be proven.
  }
}

function mediaDownloadFailure(
  chatId: number,
  messageId: number,
  attachmentIndex: number,
  relativePath: string,
): MediaDownloadResult {
  const fileName = basename(relativePath).slice(`${messageId}-${attachmentIndex}-`.length)
  return {
    path: relativePath,
    archived: false,
    warning: {
      chat_id: chatId,
      code: 'archive_media_failed',
      message: `Media download failed for message #${messageId} attachment #${attachmentIndex} ${fileName}.`,
    },
  }
}

function orderedAttachments(message: ArchiveMessage): Attachment[] {
  return message.attachments
    .slice()
    .sort((left, right) => left.attachment_index - right.attachment_index)
}

function notRequestedAttachmentStates(message: ArchiveMessage): MessageMediaDownloadResult {
  return {
    states: orderedAttachments(message).map((attachment) => ({
      attachment,
      status: attachment.downloadable ? 'not_requested' : 'not_downloadable',
    })),
    archived: 0,
    warnings: [],
  }
}

function recoveredMessageForLink(
  chat: ArchiveChat,
  messageId: number,
  attachmentIndex: number,
  relativePath: string,
): ArchiveMessage {
  const prefix = `${messageId}-${attachmentIndex}-`
  const fileName = basename(relativePath).startsWith(prefix)
    ? basename(relativePath).slice(prefix.length)
    : basename(relativePath)
  return {
    platform: 'telegram',
    chat_id: chat.id,
    chat_name: chat.title,
    msg_id: messageId,
    sender_id: null,
    sender_name: null,
    content: null,
    timestamp: new Date(0).toISOString(),
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [{
      attachment_index: attachmentIndex,
      parent_attachment_index: null,
      role: 'primary',
      kind: 'document',
      subtype: null,
      downloadable: true,
      file_id: null,
      unique_file_id: null,
      file_name: fileName,
      mime_type: null,
      file_size: null,
      width: null,
      height: null,
      duration_seconds: null,
      thumbnail_file_id: null,
      thumbnail_unique_file_id: null,
      thumbnail_width: null,
      thumbnail_height: null,
      emoji: null,
      title: null,
      performer: null,
      latitude: null,
      longitude: null,
      address: null,
      phone_number: null,
      url: null,
      preview_jpeg_base64: null,
      metadata: {},
    }],
  }
}

function validateEffectiveRange(range: EffectiveRange): void {
  if ((range.since != null && !validDate(range.since))
    || (range.until != null && !validDate(range.until))
    || (range.since != null
      && range.until != null
      && range.since.getTime() >= range.until.getTime())) {
    throw new ArchiveOperationError('archive_invalid_time_range')
  }
}

function publicArchiveFailure(error: unknown): { message: string; fatal: boolean } {
  if (error instanceof ArchiveOperationError) {
    return { message: error.message, fatal: error.fatal }
  }
  return { message: 'archive_chat_failed', fatal: false }
}

function writeExclusive(path: string, value: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, value, 'utf8')
    fsyncSync(descriptor)
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
}

function backupFile(
  source: string,
  backup: string,
  sync: (directory: string) => void,
): void {
  try {
    linkSync(source, backup)
  } catch {
    copyFileSync(source, backup, constants.COPYFILE_EXCL)
    const descriptor = openSync(backup, constants.O_RDONLY)
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
  sync(dirname(backup))
}

function restoreManifestSnapshot(path: string, manifest: ArchiveManifest | null): void {
  let failure: unknown
  try {
    if (manifest == null) {
      try {
        unlinkSync(path)
        syncDirectory(dirname(path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else {
      writeArchiveManifest(path, manifest)
    }
  } catch (error) {
    failure = error
  }

  try {
    const restored = readArchiveManifest(path)
    if (JSON.stringify(restored) === JSON.stringify(manifest)) return
  } catch {
    // Report the recovery failure below without exposing filesystem paths.
  }
  throw failure ?? new Error('archive_manifest_recovery_failed')
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EACCES',
  'EINVAL',
  'EISDIR',
  'ENOSYS',
  'ENOTSUP',
  'EPERM',
])

function syncDirectory(path: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDONLY)
    fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) throw error
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
}

async function writeArchiveFile(
  path: string,
  header: string,
  segments: string[],
  source?: string,
): Promise<void> {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    if (source == null) {
      writeFileSync(descriptor, header, 'utf8')
    } else {
      for await (const chunk of createReadStream(source)) {
        writeFileSync(descriptor, chunk)
      }
    }
    for (const segment of segments) {
      writeFileSync(descriptor, BLOCK_SEPARATOR, 'utf8')
      for await (const chunk of createReadStream(segment)) {
        writeFileSync(descriptor, chunk)
      }
    }
    if (segments.length > 0 || source == null) writeFileSync(descriptor, '\n', 'utf8')
    fsyncSync(descriptor)
    const completed = descriptor
    descriptor = null
    closeSync(completed)
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
}

function removeOwned(paths: string[]): void {
  let firstError: unknown
  for (const path of paths) {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && firstError == null) {
        firstError = error
      }
    }
  }
  if (firstError != null) throw firstError
}

function removeOwnedQuietly(paths: string[]): void {
  try {
    removeOwned(paths)
  } catch {
    // Preserve the archive failure after attempting every owned path.
  }
}
