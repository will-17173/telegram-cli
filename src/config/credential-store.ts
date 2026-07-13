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

export type TelegramConfigurationUpdate = {
  credentials?: TelegramCredentials
  proxy?: string
}

type StoredTelegramConfiguration = {
  credentials?: TelegramCredentials
  proxy?: string
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
  const configuration = readStoredConfiguration(path)
  if (!configuration?.credentials) {
    throw new MissingCredentialsError()
  }
  return configuration.credentials
}

export function readProxy(path: string): string | undefined {
  return readStoredConfiguration(path)?.proxy
}

export function writeConfiguration(
  path: string,
  update: TelegramConfigurationUpdate,
): void {
  const existing = readStoredConfiguration(path) ?? {}
  const credentials = update.credentials === undefined
    ? existing.credentials
    : validateCredentials(update.credentials)
  const proxy = update.proxy === undefined ? existing.proxy : normalizeProxy(update.proxy)

  if (!credentials && !proxy) {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }

  writeDocument(path, createDocument({ credentials, proxy }))
}

export function writeCredentials(path: string, credentials: TelegramCredentials): void {
  const normalized = validateCredentials(credentials)
  writeConfiguration(path, { credentials: normalized })
}

function readStoredConfiguration(path: string): StoredTelegramConfiguration | undefined {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }

  try {
    return parseDocument(JSON.parse(contents))
  } catch {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }
}

function parseDocument(value: unknown): StoredTelegramConfiguration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }

  const document = value as Record<string, unknown>
  const hasApiId = Object.prototype.hasOwnProperty.call(document, 'api_id')
  const hasApiHash = Object.prototype.hasOwnProperty.call(document, 'api_hash')
  const hasProxy = Object.prototype.hasOwnProperty.call(document, 'proxy')

  if (hasApiId !== hasApiHash) {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }

  let credentials: TelegramCredentials | undefined
  if (hasApiId) {
    if (
      !Number.isSafeInteger(document.api_id) ||
      (document.api_id as number) <= 0 ||
      typeof document.api_hash !== 'string' ||
      document.api_hash.trim().length === 0
    ) {
      throw new Error(INVALID_CREDENTIALS_MESSAGE)
    }
    credentials = validateCredentials({
      apiId: document.api_id as number,
      apiHash: document.api_hash,
    })
  }

  const proxy = hasProxy ? normalizeProxy(document.proxy) : undefined
  if (!credentials && !proxy) {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }

  return { credentials, proxy }
}

function normalizeProxy(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }
  return value.trim()
}

function createDocument(configuration: StoredTelegramConfiguration): Record<string, unknown> {
  const document: Record<string, unknown> = {}
  if (configuration.credentials) {
    document.api_id = configuration.credentials.apiId
    document.api_hash = configuration.credentials.apiHash
  }
  if (configuration.proxy) {
    document.proxy = configuration.proxy
  }
  return document
}

function writeDocument(path: string, value: Record<string, unknown>): void {
  const parent = dirname(path)
  const temporaryPath = join(parent, `.${randomUUID()}.tmp`)
  const document = `${JSON.stringify(value, null, 2)}\n`

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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
