import {
  CliInterruptedError,
  InteractionRequiredError,
  InvalidInputError,
  isCliInputError,
  readSecret,
} from './secure-input.js'

type SecretRequest = { type: 'tg-desktop-secret-request'; name: 'ownershipPassword' }

export type DesktopSecretTransport = {
  enabled: boolean
  connected: boolean
  on: (event: 'message' | 'disconnect', listener: (value?: unknown) => void) => void
  off: (event: 'message' | 'disconnect', listener: (value?: unknown) => void) => void
  send: (request: SecretRequest, callback: (error: Error | null) => void) => void
  disconnect: () => void
}

export type DesktopSecretOptions = {
  signal?: AbortSignal
  transport?: DesktopSecretTransport
  timeoutMs?: number
  readTerminalSecret?: typeof readSecret
}

export async function readOwnershipPassword(options: DesktopSecretOptions = {}): Promise<string> {
  const transport = options.transport ?? processTransport()
  if (!transport.enabled) return (options.readTerminalSecret ?? readSecret)('Telegram 2FA password: ', { signal: options.signal })
  if (options.signal?.aborted) throw interrupted(options.signal)
  if (!transport.connected) throw new InteractionRequiredError()

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer != null) clearTimeout(timer)
      transport.off('message', onMessage)
      transport.off('disconnect', onDisconnect)
      options.signal?.removeEventListener('abort', onAbort)
      try { transport.disconnect() } catch { /* The parent may have already closed its IPC channel. */ }
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onMessage = (message?: unknown) => {
      if (!isSecretResponse(message)) return
      if (typeof message.value !== 'string' || message.value.length === 0) {
        fail(new InvalidInputError('The ownership password must be a non-empty string.'))
        return
      }
      if (settled) return
      settled = true
      cleanup()
      resolve(message.value)
    }
    const onDisconnect = () => fail(new InteractionRequiredError())
    const onAbort = () => fail(interrupted(options.signal!))
    transport.on('message', onMessage)
    transport.on('disconnect', onDisconnect)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => fail(new InteractionRequiredError()), options.timeoutMs ?? 10_000)
    try {
      transport.send({ type: 'tg-desktop-secret-request', name: 'ownershipPassword' }, error => {
        if (error != null) fail(new InteractionRequiredError())
      })
    } catch {
      fail(new InteractionRequiredError())
    }
  })
}

function processTransport(): DesktopSecretTransport {
  return {
    enabled: process.env.TG_DESKTOP_IPC === '1' && typeof process.send === 'function',
    connected: process.connected === true,
    on: (event, listener) => { process.on(event, listener) },
    off: (event, listener) => { process.off(event, listener) },
    send: (request, callback) => { process.send!(request, callback) },
    disconnect: () => { if (process.connected) process.disconnect?.() },
  }
}

function isSecretResponse(value: unknown): value is { value: unknown } {
  if (typeof value !== 'object' || value == null) return false
  const message = value as Record<string, unknown>
  return message.type === 'tg-desktop-secret-response' && message.name === 'ownershipPassword'
}

function interrupted(signal: AbortSignal): Error {
  return isCliInputError(signal.reason) ? signal.reason : new CliInterruptedError()
}
