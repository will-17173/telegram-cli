import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ArchiveChatState, ArchiveManifest } from './archive-types.js'

type ArchiveAccount = {
  userId: number
  name: string
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu
const ARCHIVE_CHAT_SLUG = /^[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*$/u
const MAX_CHAT_SLUG_BYTES = 80
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EACCES',
  'EINVAL',
  'EISDIR',
  'ENOSYS',
  'ENOTSUP',
  'EPERM',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isString(value)) return false
  const match = ISO_TIMESTAMP.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false

  const [, year, month, day, hour, minute, second] = match
  const numericYear = Number(year)
  const numericMonth = Number(month)
  const daysInMonth = new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate()
  return numericMonth >= 1
    && numericMonth <= 12
    && Number(day) >= 1
    && Number(day) <= daysInMonth
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isNullableMessageId(value: unknown): value is number | null {
  return value === null || isPositiveSafeInteger(value)
}

function isSafeRelativeFile(value: unknown): value is string {
  return isString(value)
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
    && !/[\p{C}]/u.test(value)
    && !/[<>:"|?*]/u.test(value)
    && !/[. ]$/u.test(value)
    && !WINDOWS_RESERVED_NAME.test(value)
    && Buffer.byteLength(value) <= 255
}

function isChatId(value: string): boolean {
  if (!/^-?[1-9]\d*$/u.test(value)) return false
  return Number.isSafeInteger(Number(value))
}

function isArchiveChatState(value: unknown, chatId: string): value is ArchiveChatState {
  if (!isRecord(value)) return false

  return isString(value.title)
    && value.title.trim().length > 0
    && isArchiveChatFile(value.file, chatId)
    && isNullableTimestamp(value.initial_since)
    && isNullableTimestamp(value.initial_until)
    && typeof value.full_history === 'boolean'
    && isNullableMessageId(value.last_message_id)
    && isNullableTimestamp(value.last_message_date)
    && isIsoTimestamp(value.last_run)
}

function isArchiveChatFile(value: unknown, chatId: string): value is string {
  if (!isSafeRelativeFile(value)) return false
  const prefix = `${chatId}-`
  if (!value.startsWith(prefix) || !value.endsWith('.md')) return false

  const slug = value.slice(prefix.length, -3)
  return slug.length > 0
    && Buffer.byteLength(slug) <= MAX_CHAT_SLUG_BYTES
    && slug === slug.normalize('NFKC')
    && slug === slug.toLocaleLowerCase('und')
    && ARCHIVE_CHAT_SLUG.test(slug)
}

function portableFileIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und')
}

function parseArchiveManifest(value: unknown): ArchiveManifest {
  if (!isRecord(value)) throw new Error('archive_manifest_invalid')
  if (value.schema_version !== 1) {
    if (Number.isInteger(value.schema_version)) {
      throw new Error('archive_schema_unsupported')
    }
    throw new Error('archive_manifest_invalid')
  }
  if (!isString(value.account_name) || value.account_name.trim().length === 0
    || !isPositiveSafeInteger(value.account_user_id)
    || !isIsoTimestamp(value.created_at)
    || !isIsoTimestamp(value.updated_at)
    || !isRecord(value.chats)) {
    throw new Error('archive_manifest_invalid')
  }

  const files = new Set<string>()
  for (const [chatId, chat] of Object.entries(value.chats)) {
    if (!isChatId(chatId)) throw new Error('archive_manifest_invalid')
    if (!isArchiveChatState(chat, chatId)) throw new Error('archive_manifest_invalid')
    const fileIdentity = portableFileIdentity(chat.file)
    if (files.has(fileIdentity)) throw new Error('archive_manifest_invalid')
    files.add(fileIdentity)
  }

  return value as ArchiveManifest
}

export function readArchiveManifest(path: string): ArchiveManifest | null {
  if (!existsSync(path)) return null

  try {
    return parseArchiveManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof Error
      && (error.message === 'archive_manifest_invalid'
        || error.message === 'archive_schema_unsupported')) {
      throw error
    }
    throw new Error('archive_manifest_invalid')
  }
}

export function validateArchiveAccount(
  manifest: ArchiveManifest,
  account: ArchiveAccount,
): void {
  if (manifest.account_user_id !== account.userId) {
    throw new Error('archive_account_mismatch')
  }
}

function syncDirectory(path: string): void {
  let fileDescriptor: number | null = null

  try {
    fileDescriptor = openSync(path, constants.O_RDONLY)
    fsyncSync(fileDescriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) throw error
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor)
  }
}

export function writeArchiveManifest(path: string, manifest: ArchiveManifest): void {
  parseArchiveManifest(manifest)
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  let fileDescriptor: number | null = null

  try {
    fileDescriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    writeFileSync(fileDescriptor, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fsyncSync(fileDescriptor)
    const descriptor = fileDescriptor
    fileDescriptor = null
    closeSync(descriptor)
    renameSync(temporaryPath, path)
    syncDirectory(dirname(path))
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor)
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }
  }
}
