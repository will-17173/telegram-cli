import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  MissingCredentialsError,
  readCredentials,
  validateCredentials,
  type TelegramCredentials,
} from './credential-store.js'

const APP_NAME = 'tg-cli'
const DEFAULT_API_ID = 2040
const DEFAULT_API_HASH = 'b18441a1ff607e10a989891a5462e627'
const PARTIAL_CREDENTIALS_MESSAGE = 'TG_API_ID and TG_API_HASH must be provided together.'

export type CredentialSource = 'environment' | 'stored' | 'default'

export type ResolvedTelegramCredentials = TelegramCredentials & {
  source: CredentialSource
}

export function getTelegramCredentials(): ResolvedTelegramCredentials {
  const apiId = process.env.TG_API_ID?.trim() ?? ''
  const apiHash = process.env.TG_API_HASH?.trim() ?? ''

  if (Boolean(apiId) !== Boolean(apiHash)) {
    throw new Error(PARTIAL_CREDENTIALS_MESSAGE)
  }
  if (apiId && apiHash) {
    return {
      ...validateCredentials({ apiId, apiHash }),
      source: 'environment',
    }
  }

  try {
    return {
      ...readCredentials(getConfigPath()),
      source: 'stored',
    }
  } catch (error) {
    if (!(error instanceof MissingCredentialsError)) throw error

    return {
      apiId: DEFAULT_API_ID,
      apiHash: DEFAULT_API_HASH,
      source: 'default',
    }
  }
}

export function getSessionName(): string {
  const raw = process.env.TG_SESSION_NAME
  return raw && raw.trim() ? raw.trim() : 'tg_cli'
}

export function getDataDir(): string {
  const raw = process.env.DATA_DIR
  const dir = raw && raw.trim() ? resolvePath(raw) : join(defaultDataHome(), APP_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getConfigPath(): string {
  return join(getDataDir(), 'config.json')
}

export function getDbPath(): string {
  const raw = process.env.DB_PATH
  const path = raw && raw.trim() ? resolvePath(raw) : join(getDataDir(), 'messages.db')
  mkdirSync(resolve(path, '..'), { recursive: true })
  return path
}

export function getSessionPath(): string {
  const dir = join(getDataDir(), 'sessions')
  mkdirSync(dir, { recursive: true })
  return join(dir, getSessionName())
}

function resolvePath(raw: string): string {
  const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

function defaultDataHome(): string {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(homedir(), '.local', 'share')
}
