import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const API_ID_PATTERN = /^[1-9]\d*$/
const MISSING_CREDENTIALS_MESSAGE =
  'Telegram API credentials are not configured. Run tg config set --api-id <id> --api-hash <hash>.'
const INVALID_CREDENTIALS_MESSAGE = 'Stored Telegram API configuration is invalid.'

export type TelegramCredentials = {
  apiId: number
  apiHash: string
}

export class MissingCredentialsError extends Error {
  constructor() {
    super(MISSING_CREDENTIALS_MESSAGE)
    this.name = 'MissingCredentialsError'
  }
}

export function validateCredentials(input: {
  apiId: string | number | undefined
  apiHash: string | undefined
}): TelegramCredentials {
  const rawId = String(input.apiId ?? '').trim()
  const apiHash = input.apiHash?.trim() ?? ''
  const apiId = Number.parseInt(rawId, 10)

  if (!API_ID_PATTERN.test(rawId) || !Number.isSafeInteger(apiId)) {
    throw new Error('API ID must be a positive integer.')
  }
  if (!apiHash) {
    throw new Error('API hash is required.')
  }

  return { apiId, apiHash }
}

export function readCredentials(path: string): TelegramCredentials {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new MissingCredentialsError()
    }
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }

  try {
    const parsed: unknown = JSON.parse(contents)
    if (!isCredentialDocument(parsed)) {
      throw new Error(INVALID_CREDENTIALS_MESSAGE)
    }
    return validateCredentials({ apiId: parsed.api_id, apiHash: parsed.api_hash })
  } catch {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }
}

export function writeCredentials(path: string, credentials: TelegramCredentials): void {
  const normalized = validateCredentials(credentials)
  const parent = dirname(path)
  const temporaryPath = join(parent, `.${randomUUID()}.tmp`)
  const document = `${JSON.stringify({
    api_id: normalized.apiId,
    api_hash: normalized.apiHash,
  }, null, 2)}\n`

  mkdirSync(parent, { recursive: true })

  let renamed = false
  try {
    writeFileSync(temporaryPath, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, path)
    renamed = true
    chmodSync(path, 0o600)
  } finally {
    if (!renamed) {
      rmSync(temporaryPath, { force: true })
    }
  }
}

function isCredentialDocument(value: unknown): value is { api_id: number; api_hash: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const document = value as Record<string, unknown>
  return (
    Number.isSafeInteger(document.api_id) &&
    (document.api_id as number) > 0 &&
    typeof document.api_hash === 'string' &&
    document.api_hash.trim().length > 0
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
