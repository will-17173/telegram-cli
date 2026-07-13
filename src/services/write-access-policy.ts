import type { HandlerResult } from '../commands/types.js'
import { getTelegramWriteAccess } from '../config/env.js'

export type WriteAccessResolver = () => boolean

export class WriteAccessPolicy {
  constructor(private readonly resolveEnabled: WriteAccessResolver = getTelegramWriteAccess) {}

  check(): HandlerResult<{ enabled: true }> {
    return this.resolveEnabled()
      ? { ok: true, data: { enabled: true } }
      : {
        ok: false,
        error: {
          code: 'write_access_disabled',
          message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
        },
      }
  }
}
