import type { AccountContext } from '../account/account-presets.js'
import type { Command } from 'commander'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import { runWithAuthenticatedAccountContext, type AccountCommandOptions } from './account-options.js'
import type { HandlerResult } from './types.js'
import { WriteAccessPolicy } from '../services/write-access-policy.js'

type StreamWrite = typeof process.stdout.write

const BENIGN_UPDATE_WARNINGS = [
  'pts_before does not match local_pts',
  'local pts not available for postponed updateNewChannelMessage',
  'error fetching common difference',
  'error fetching difference for',
  'Session is reset',
  'MtprotoSession.resetState',
] as const

export async function runTelegramCommand(
  options: AccountCommandOptions,
  handler: (client: TelegramClientAdapter, context: AccountContext) => Promise<HandlerResult>,
  command?: Command,
): Promise<void> {
  await runWithAuthenticatedAccountContext(options, async (context) => {
    const restoreStdoutWarnings = hideBenignUpdateWarnings(process.stdout)
    const restoreStderrWarnings = hideBenignUpdateWarnings(process.stderr)

    let client: TelegramClientAdapter
    try {
      client = createTelegramClient(context.sessionPath)
    } catch (error) {
      restoreStdoutWarnings()
      restoreStderrWarnings()
      return commandFailure('config_error', error)
    }

    try {
      return await handler(client, context)
    } catch (error) {
      const authError = toAuthSessionError(error, context.account.name)
      return authError ?? commandFailure('telegram_error', error)
    } finally {
      restoreStdoutWarnings()
      restoreStderrWarnings()
      await client.close().catch(() => undefined)
    }
  }, command)
}

export async function runTelegramWriteCommand(
  options: AccountCommandOptions,
  handler: (client: TelegramClientAdapter, context: AccountContext) => Promise<HandlerResult>,
  command?: Command,
): Promise<void> {
  await runWithAuthenticatedAccountContext(options, async (context) => {
    const restoreStdoutWarnings = hideBenignUpdateWarnings(process.stdout)
    const restoreStderrWarnings = hideBenignUpdateWarnings(process.stderr)

    const access = new WriteAccessPolicy().check()
    if (!access.ok) {
      restoreStdoutWarnings()
      restoreStderrWarnings()
      return access
    }

    let client: TelegramClientAdapter
    try {
      client = createTelegramClient(context.sessionPath)
    } catch (error) {
      restoreStdoutWarnings()
      restoreStderrWarnings()
      return commandFailure('config_error', error)
    }

    try {
      return await handler(client, context)
    } catch (error) {
      const authError = toAuthSessionError(error, context.account.name)
      return authError ?? commandFailure('telegram_error', error)
    } finally {
      restoreStdoutWarnings()
      restoreStderrWarnings()
      await client.close().catch(() => undefined)
    }
  }, command)
}

export function hideBenignUpdateWarnings(stream: NodeJS.WriteStream): () => void {
  const write = stream.write
  stream.write = ((chunk: Parameters<StreamWrite>[0], encoding?: Parameters<StreamWrite>[1], cb?: Parameters<StreamWrite>[2]) => {
    const rendered = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    const isBenignUpdateWarning = BENIGN_UPDATE_WARNINGS.some((warning) => rendered.includes(warning))
      || (rendered.includes('error fetching difference for') && rendered.includes('400 CHANNEL_INVALID'))
    if (isBenignUpdateWarning) {
      return true
    }
    return write.call(stream, chunk, encoding, cb)
  }) as StreamWrite

  return () => {
    stream.write = write
  }
}

function toAuthSessionError(error: unknown, accountName: string): HandlerResult<never> | null {
  if (isAuthKeyUnregistered(error)) {
    return {
      ok: false,
      error: {
        code: 'telegram_account_session_expired',
        message: `Session for account "${accountName}" is no longer valid. Re-add the account: tg account remove ${accountName} --force && tg account add.`,
      },
    }
  }
  return null
}

function isAuthKeyUnregistered(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false

  const candidate = error as { text?: unknown; message?: unknown; code?: unknown }
  const text = typeof candidate.text === 'string'
    ? candidate.text
    : undefined

  if (text === 'AUTH_KEY_UNREGISTERED') return true

  const code = typeof candidate.code === 'number' ? candidate.code : undefined
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return message.includes('AUTH_KEY_UNREGISTERED') && code === 401
}

function commandFailure(code: string, error: unknown): HandlerResult<never> {
  return { ok: false, error: { code, message: errorMessage(error) } }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
