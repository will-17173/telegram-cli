import {
  closeSync,
  copyFileSync,
  constants,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { ParsedTimeRange } from '../commands/time-range.js'
import type { ArchiveChat, ArchiveMessage, TelegramArchiveAdapter } from '../telegram/archive-types.js'
import { archiveChatFile } from './archive-layout.js'
import {
  readArchiveManifest,
  validateArchiveAccount,
  writeArchiveManifest,
} from './archive-manifest.js'
import { renderArchiveHeader, renderArchiveMessage } from './archive-markdown.js'
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
  finalize: () => void
  rollback: () => void
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
  private readonly restoreManifest: (path: string, manifest: ArchiveManifest | null) => void
  private readonly transaction: ArchiveTransactionOperations

  constructor(
    private readonly source: TelegramArchiveAdapter,
    dependencies: ArchiveServiceDependencies = {},
  ) {
    this.writeManifest = dependencies.writeManifest ?? writeArchiveManifest
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

  async archive(input: ArchiveServiceInput): Promise<ArchiveCommandResult> {
    validateInput(input)

    const now = input.now ?? new Date()
    const timestamp = now.toISOString()
    const manifestPath = join(input.output, MANIFEST_FILE)
    const existing = readArchiveManifest(manifestPath)
    if (existing != null) validateArchiveAccount(existing, input.account)

    let manifest: ArchiveManifest = existing ?? {
      schema_version: 1,
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
        const archived = await this.archiveChat(chat, input.output, range, now, previous)
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
          media_archived: 0,
        })
        if (cleanupFailed) {
          result.warnings.push({
            chat_id: chat.id,
            code: 'archive_backup_cleanup_failed',
            message: 'Archive committed, but recovery-backup cleanup could not be confirmed.',
          })
        }
      } catch (error) {
        const failure = publicArchiveFailure(error)
        result.failed.push({
          chat_id: chat.id,
          title: chat.title,
          error: failure.message,
        })
        if (failure.fatal) break
      }
    }

    return result
  }

  private async archiveChat(
    chat: ArchiveChat,
    output: string,
    range: EffectiveRange,
    now: Date,
    previous?: ArchiveChatState,
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

    try {
      let pageNumber = 0
      for await (const page of this.source.iterHistoryPages({
        chat: chat.id,
        since: range.since,
        until: range.until,
      })) {
        if (page.length === 0) continue
        const segment = join(output, `.${basename(file)}.${token}.${pageNumber}.segment`)
        pageNumber += 1
        ownedPaths.push(segment)

        const chronological = [...page].reverse()
        writeExclusive(segment, chronological.map((item) => renderArchiveMessage(item)).join(BLOCK_SEPARATOR))
        segments.push(segment)
        messages += chronological.length

        for (const item of page) {
          if (newest == null || item.msg_id > newest.msg_id) newest = item
        }
      }

      const temporary = join(output, `.${basename(file)}.${token}.tmp`)
      ownedPaths.push(temporary)
      await writeArchiveFile(temporary, renderArchiveHeader(chat, now), segments.reverse())
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
        finalize: () => {
          if (backup != null) this.transaction.cleanupBackup(backup)
        },
        rollback: () => this.transaction.rollbackDestination(destination, backup),
        state: {
          title: chat.title,
          file,
          initial_since: range.since?.toISOString() ?? null,
          initial_until: range.until?.toISOString() ?? null,
          full_history: range.full,
          last_message_id: newest?.msg_id ?? null,
          last_message_date: newest?.timestamp == null
            ? null
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

async function writeArchiveFile(path: string, header: string, segments: string[]): Promise<void> {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, header, 'utf8')
    for (const segment of segments) {
      writeFileSync(descriptor, BLOCK_SEPARATOR, 'utf8')
      for await (const chunk of createReadStream(segment)) {
        writeFileSync(descriptor, chunk)
      }
    }
    writeFileSync(descriptor, '\n', 'utf8')
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
