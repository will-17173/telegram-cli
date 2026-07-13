import { StringDecoder } from 'node:string_decoder'
import { createInterface } from 'node:readline/promises'

export type SecureInputOptions = {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  signal?: AbortSignal
}

export class CliInterruptedError extends Error {
  readonly code = 'interrupted'
  readonly exitCode = 130

  constructor() {
    super('Operation interrupted.')
    this.name = 'CliInterruptedError'
  }
}

export class InteractionRequiredError extends Error {
  readonly code = 'interaction_required'

  constructor() {
    super('Interactive terminal input is required.')
    this.name = 'InteractionRequiredError'
  }
}

export class InvalidInputError extends Error {
  readonly code = 'invalid_input'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidInputError'
  }
}

export function createInterruptScope(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onSigint = (): void => controller.abort(new CliInterruptedError())
  process.once('SIGINT', onSigint)
  return {
    signal: controller.signal,
    dispose: () => process.removeListener('SIGINT', onSigint),
  }
}

export async function readVisibleInput(promptText: string, options: SecureInputOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  if (input.isTTY !== true) throw new InteractionRequiredError()
  throwIfAborted(options.signal)

  const readline = createInterface({ input, output, terminal: true })
  let rejectInterrupt: ((error: CliInterruptedError) => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject
  })
  const onSigint = (): void => rejectInterrupt?.(new CliInterruptedError())
  readline.once('SIGINT', onSigint)

  try {
    return await Promise.race([
      readline.question(promptText, { signal: options.signal }).catch(error => {
        if (options.signal?.aborted) throw abortReason(options.signal)
        throw error
      }),
      interrupted,
    ])
  } finally {
    readline.removeListener('SIGINT', onSigint)
    readline.close()
  }
}

export async function readSecret(promptText: string, options: SecureInputOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') throw new InteractionRequiredError()
  throwIfAborted(options.signal)
  if (input.readableEnded) throw new CliInterruptedError()

  const originalRawMode = input.isRaw === true
  const wasFlowing = input.readableFlowing === true
  const decoder = new StringDecoder('utf8')
  let value = ''
  let resolveInput: ((value: string) => void) | undefined
  let rejectInput: ((error: unknown) => void) | undefined
  const result = new Promise<string>((resolve, reject) => {
    resolveInput = resolve
    rejectInput = reject
  })
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (const character of text) {
      const code = character.codePointAt(0)
      if (code === 3) {
        rejectInput?.(new CliInterruptedError())
        return
      }
      if (character === '\r' || character === '\n') {
        if (value.length === 0) rejectInput?.(new InvalidInputError('Secret input cannot be empty.'))
        else resolveInput?.(value)
        return
      }
      if (code === 8 || code === 127) {
        value = Array.from(value).slice(0, -1).join('')
        continue
      }
      if (code != null && code >= 32) value += character
    }
  }
  const onError = (error: Error): void => rejectInput?.(error)
  const onOutputError = (error: Error): void => rejectInput?.(error)
  const onEnd = (): void => rejectInput?.(new CliInterruptedError())
  const onAbort = (): void => rejectInput?.(abortReason(options.signal!))

  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    output.once('error', onOutputError)
    input.setRawMode(true)
    if (options.signal?.aborted) return await result
    input.on('data', onData)
    input.once('error', onError)
    input.once('end', onEnd)
    input.resume()
    output.write(promptText)
    return await result
  } finally {
    input.removeListener('data', onData)
    input.removeListener('error', onError)
    input.removeListener('end', onEnd)
    options.signal?.removeEventListener('abort', onAbort)
    try {
      input.setRawMode(originalRawMode)
    } finally {
      try {
        if (!wasFlowing) input.pause()
        output.write('\n')
      } finally {
        output.removeListener('error', onOutputError)
      }
    }
  }
}

export function isCliInterruptedError(error: unknown): error is CliInterruptedError {
  return error instanceof CliInterruptedError
}

export function isCliInputError(
  error: unknown,
): error is CliInterruptedError | InteractionRequiredError | InvalidInputError {
  return error instanceof CliInterruptedError
    || error instanceof InteractionRequiredError
    || error instanceof InvalidInputError
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CliInterruptedError()
}
