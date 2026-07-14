import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { TelegramClient } from '@mtcute/node'

import { getDataDir, getTelegramCredentials, getTelegramProxy } from '../config/env.js'
import { getSessionPath } from '../config/env.js'
import { MtcuteTelegramClient } from './mtcute-client.js'
import { telegramTransportOptions } from './proxy.js'
import type { TelegramClientAdapter } from './types.js'

const DEFAULT_CREDENTIALS_WARNING = 'warning: using default Telegram API credentials, which have stricter flood limits and may trigger FLOOD_WAIT during frequent or large requests. Run tg config set --api-id <id> --api-hash <hash> to configure your own.\n'
const WARNING_STATE_DIR = 'warnings'
const DEFAULT_CREDENTIALS_WARNING_MARKER = 'default-credentials'

export function createTelegramClient(sessionPath?: string): TelegramClientAdapter {
  const credentials = getTelegramCredentials()
  const storage = sessionPath ?? getSessionPath()

  if (credentials.source === 'default') {
    warnAboutDefaultCredentialsOnceToday()
  }

  const client = new TelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage,
    ...telegramTransportOptions(getTelegramProxy()),
  })

  return new MtcuteTelegramClient(client)
}

function warnAboutDefaultCredentialsOnceToday(): void {
  const markerPath = claimDailyWarningMarker()
  if (markerPath === null) return

  try {
    process.stderr.write(DEFAULT_CREDENTIALS_WARNING)
  } catch (error) {
    if (markerPath) {
      try {
        unlinkSync(markerPath)
      } catch {
        // A later invocation can still retry when the marker can be removed.
      }
    }
    throw error
  }
}

function claimDailyWarningMarker(): string | undefined | null {
  const stateDir = join(getDataDir(), WARNING_STATE_DIR)
  const markerPath = join(stateDir, `${DEFAULT_CREDENTIALS_WARNING_MARKER}-${localDateKey(new Date())}`)

  try {
    mkdirSync(stateDir, { recursive: true })
    const descriptor = openSync(markerPath, 'wx', 0o600)
    closeSync(descriptor)
    return markerPath
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return null

    // Warning persistence is best effort and must not prevent the CLI from running.
    return undefined
  }
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
