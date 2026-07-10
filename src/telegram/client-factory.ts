import { TelegramClient } from '@mtcute/node'

import { getTelegramCredentials } from '../config/env.js'
import { getSessionPath } from '../config/env.js'
import { MtcuteTelegramClient } from './mtcute-client.js'
import type { TelegramClientAdapter } from './types.js'

const DEFAULT_CREDENTIALS_WARNING = 'warning: using default Telegram API credentials. Run tg config set --api-id <id> --api-hash <hash> to configure your own.\n'

let hasWarnedAboutDefaultCredentials = false

export function createTelegramClient(sessionPath?: string): TelegramClientAdapter {
  const credentials = getTelegramCredentials()
  const storage = sessionPath ?? getSessionPath()

  if (credentials.source === 'default' && !hasWarnedAboutDefaultCredentials) {
    hasWarnedAboutDefaultCredentials = true
    try {
      process.stderr.write(DEFAULT_CREDENTIALS_WARNING)
    } catch (error) {
      hasWarnedAboutDefaultCredentials = false
      throw error
    }
  }

  const client = new TelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage,
  })

  return new MtcuteTelegramClient(client)
}
