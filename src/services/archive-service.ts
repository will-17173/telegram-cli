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
import { basename, join } from 'node:path'
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
  rollback: () => string | null
}

type ArchiveServiceDependencies = {
  writeManifest?: typeof writeArchiveManifest
}

export class ArchiveService {
  private readonly writeManifest: typeof writeArchiveManifest

  constructor(
    private readonly source: TelegramArchiveAdapter,
    dependencies: ArchiveServiceDependencies = {},
  ) {
    this.writeManifest = dependencies.writeManifest ?? writeArchiveManifest
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
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          try {
            restoreManifestSnapshot(manifestPath, manifestPersisted ? manifest : null)
          } catch {
            throw new Error(`${message}; archive_manifest_recovery_failed`)
          }
          const rollbackFailure = archived.rollback()
          throw new Error(rollbackFailure == null ? message : `${message}; ${rollbackFailure}`)
        }
        manifest = candidate
        manifestPersisted = true
        archived.finalize()
        result.completed.push({
          chat_id: chat.id,
          title: chat.title,
          file: archived.state.file,
          messages_archived: archived.messages,
          media_archived: 0,
        })
      } catch (error) {
        result.failed.push({
          chat_id: chat.id,
          title: chat.title,
          error: error instanceof Error ? error.message : String(error),
        })
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
      const backup = existsSync(destination)
        ? join(output, `.${basename(file)}.${token}.backup`)
        : undefined
      if (backup != null) {
        ownedPaths.push(backup)
        backupFile(destination, backup)
      }
      renameSync(temporary, destination)

      return {
        messages,
        finalize: () => {
          if (backup != null) removeOwnedQuietly([backup])
        },
        rollback: () => rollbackDestination(destination, backup),
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
    throw new Error('archive_invalid_time_range')
  }
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

function backupFile(source: string, backup: string): void {
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
}

function rollbackDestination(destination: string, backup?: string): string | null {
  try {
    if (backup == null) {
      unlinkSync(destination)
    } else {
      renameSync(backup, destination)
    }
    return null
  } catch {
    return 'archive_rollback_failed'
  }
}

function restoreManifestSnapshot(path: string, manifest: ArchiveManifest | null): void {
  let failure: unknown
  try {
    if (manifest == null) {
      try {
        unlinkSync(path)
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
