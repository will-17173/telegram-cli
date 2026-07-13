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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value)
}

function isSafeRelativeFile(value: unknown): value is string {
  return isString(value)
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
    && !/[\p{C}]/u.test(value)
}

function isArchiveChatState(value: unknown): value is ArchiveChatState {
  if (!isRecord(value)) return false

  return isString(value.title)
    && value.title.trim().length > 0
    && isSafeRelativeFile(value.file)
    && isNullableString(value.initial_since)
    && isNullableString(value.initial_until)
    && typeof value.full_history === 'boolean'
    && isNullableInteger(value.last_message_id)
    && isNullableString(value.last_message_date)
    && isString(value.last_run)
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
    || !Number.isSafeInteger(value.account_user_id)
    || !isString(value.created_at)
    || !isString(value.updated_at)
    || !isRecord(value.chats)) {
    throw new Error('archive_manifest_invalid')
  }

  for (const chat of Object.values(value.chats)) {
    if (!isArchiveChatState(chat)) throw new Error('archive_manifest_invalid')
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
    closeSync(fileDescriptor)
    fileDescriptor = null
    renameSync(temporaryPath, path)
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor)
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }
  }
}
