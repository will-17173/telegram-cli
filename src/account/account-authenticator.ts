import { createInterface } from 'node:readline/promises'
import { TelegramClient } from '@mtcute/node'

import { getTelegramCredentials, getTelegramProxy } from '../config/env.js'
import { telegramTransportOptions } from '../telegram/proxy.js'

export type AuthUser = {
  id: number
  displayName?: string | null
  firstName?: string | null
  lastName?: string | null
  username?: string | null
  phoneNumber?: string | null
}

type AuthClient = {
  start: (options: AuthStartOptions) => Promise<unknown>
  getMe: () => Promise<AuthUser>
  destroy: () => Promise<void>
}

type AuthStartOptions = NonNullable<Parameters<TelegramClient['start']>[0]>

export type AuthenticatedSession = {
  user: AuthUser
  close: () => Promise<void>
}

export type AccountAuthClientFactory = (sessionPath: string) => AuthClient

export async function authenticateAccountAt(
  sessionPath: string,
  createClient: AccountAuthClientFactory = createAccountAuthClient,
): Promise<AuthenticatedSession> {
  const client = createClient(sessionPath)
  const input = createAuthenticationInput()

  try {
    await client.start(input.options)
    const user = await client.getMe()
    return {
      user,
      close: () => client.destroy(),
    }
  } catch (error) {
    await client.destroy().catch(() => undefined)
    throwAccountLoginError(error)
  } finally {
    input.close()
  }
}

function createAuthenticationInput(): { options: AuthStartOptions; close: () => void } {
  const abortController = new AbortController()
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  })
  const onSigint = (): void => abortController.abort()
  process.once('SIGINT', onSigint)

  const question = (text: string): Promise<string> => prompt.question(text, {
    signal: abortController.signal,
  })

  return {
    options: {
      phone: () => question('Phone number: '),
      code: () => question('Login code: '),
      password: () => question('2FA password: '),
      codeSentCallback: () => {
        process.stderr.write('Login code sent.\n')
      },
      invalidCodeCallback: (type) => {
        process.stderr.write(type === 'code'
          ? 'Invalid login code. Please try again.\n'
          : 'Invalid 2FA password. Please try again.\n')
      },
      abortSignal: abortController.signal,
    },
    close: () => {
      process.removeListener('SIGINT', onSigint)
      abortController.abort()
      prompt.close()
    },
  }
}

export function mapAuthUser(user: AuthUser): {
  user_id: number
  username: string
  phone: string
  display_name: string
  name: string
} {
  const displayName = user.displayName?.trim()
  const displayNameFallback = [
    user.firstName,
    user.lastName,
  ].filter((value): value is string => value != null && value.trim().length > 0).join(' ')

  const username = user.username?.trim() || `user-${user.id}`
  const phone = (user.phoneNumber ?? '').replace(/\D/g, '') || String(user.id)
  const preferredName = user.username?.trim().toLowerCase() || ''
  const name = preferredName.length > 0 ? preferredName : phone
  const resolvedDisplayName = displayName && displayName.length > 0
    ? displayName
    : displayNameFallback

  return {
    user_id: user.id,
    username: username.toLowerCase(),
    phone,
    display_name: resolvedDisplayName.length > 0 ? normalizeDisplayName(resolvedDisplayName) : username,
    name,
  }
}

function createAccountAuthClient(sessionPath: string): AuthClient {
  const credentials = getTelegramCredentials()
  return new TelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage: sessionPath,
    ...telegramTransportOptions(getTelegramProxy()),
  })
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim().replace(/\s+/g, ' ')
  const words = normalized.split(' ')

  for (let len = 1; len * 2 <= words.length; len += 1) {
    if (words.length !== len * 2) continue
    const first = words.slice(0, len).join(' ')
    const second = words.slice(len).join(' ')
    if (first === second) return first
  }

  return normalized
}

function throwAccountLoginError(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(message, { cause }) as Error & { code?: string }
  error.code = 'account_login_failed'
  throw error
}
