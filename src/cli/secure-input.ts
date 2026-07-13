import { StringDecoder } from 'node:string_decoder'
import { createInterface } from 'node:readline/promises'

export type SecureInputOptions = {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  signal?: AbortSignal
}

export class CliInterruptedError extends Error {
  readonly code = 'interrupted'
  readonly exitCode: number
  readonly signal: 'SIGINT' | 'SIGHUP' | 'SIGTERM'

  constructor(signal: 'SIGINT' | 'SIGHUP' | 'SIGTERM' = 'SIGINT') {
    super('Operation interrupted.')
    this.name = 'CliInterruptedError'
    this.signal = signal
    this.exitCode = signal === 'SIGHUP' ? 129 : signal === 'SIGTERM' ? 143 : 130
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

export class InputBusyError extends Error {
  readonly code = 'input_busy'

  constructor() {
    super('Interactive terminal input is already in use.')
    this.name = 'InputBusyError'
  }
}

const activeTerminalInputs = new WeakSet<NodeJS.ReadStream>()
type DataListener = (...args: any[]) => void
const managedReadlineDataListeners = new WeakMap<NodeJS.ReadStream, Set<DataListener>>()
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function createInterruptScope(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  // SIGKILL cannot be observed by a process, so the OS terminal driver is the only cleanup boundary for it.
  const handlers = {
    SIGINT: () => controller.abort(new CliInterruptedError('SIGINT')),
    SIGHUP: () => controller.abort(new CliInterruptedError('SIGHUP')),
    SIGTERM: () => controller.abort(new CliInterruptedError('SIGTERM')),
  } satisfies Record<'SIGINT' | 'SIGHUP' | 'SIGTERM', () => void>
  for (const [signal, handler] of Object.entries(handlers)) {
    process.once(signal as keyof typeof handlers, handler)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, handler] of Object.entries(handlers)) {
        process.removeListener(signal as keyof typeof handlers, handler)
      }
    },
  }
}

export async function readVisibleInput(promptText: string, options: SecureInputOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  if (input.isTTY !== true) throw new InteractionRequiredError()
  throwIfAborted(options.signal)
  if (activeTerminalInputs.has(input)) throw new InputBusyError()

  activeTerminalInputs.add(input)
  let readline: ReturnType<typeof createInterface> | undefined
  let onSigint: (() => void) | undefined
  try {
    const existingDataListeners = input.rawListeners('data')
    readline = createInterface({ input, output, terminal: true })
    const managedListeners = managedReadlineDataListeners.get(input) ?? new Set()
    for (const listener of input.rawListeners('data') as DataListener[]) {
      if (!existingDataListeners.includes(listener)) managedListeners.add(listener)
    }
    managedReadlineDataListeners.set(input, managedListeners)
    let rejectInterrupt: ((error: CliInterruptedError) => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupt = reject
    })
    onSigint = () => rejectInterrupt?.(new CliInterruptedError())
    readline.once('SIGINT', onSigint)
    return await Promise.race([
      readline.question(promptText, { signal: options.signal }).catch(error => {
        if (options.signal?.aborted) throw abortReason(options.signal)
        throw error
      }),
      interrupted,
    ])
  } finally {
    if (readline && onSigint) readline.removeListener('SIGINT', onSigint)
    readline?.close()
    activeTerminalInputs.delete(input)
  }
}

export async function readSecret(promptText: string, options: SecureInputOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') throw new InteractionRequiredError()
  throwIfAborted(options.signal)
  if (input.readableEnded || input.destroyed) throw new CliInterruptedError()
  const managedListeners = managedReadlineDataListeners.get(input) ?? new Set()
  const currentDataListeners = input.rawListeners('data') as DataListener[]
  const unmanagedListeners = currentDataListeners
    .filter(listener => !managedListeners.has(listener))
  if (activeTerminalInputs.has(input) || unmanagedListeners.length > 0) throw new InputBusyError()

  const suspendedManagedListeners = currentDataListeners.filter(listener => managedListeners.has(listener))
  activeTerminalInputs.add(input)
  let operationFailed = false
  try {
    for (const listener of suspendedManagedListeners) input.removeListener('data', listener)
    return await readSecretFromTerminal(promptText, input, output, options.signal)
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    let restoreError: unknown
    for (const listener of suspendedManagedListeners) {
      try {
        if (!(input.rawListeners('data') as DataListener[]).includes(listener)) input.on('data', listener)
      } catch (error) {
        restoreError ??= error
      }
    }
    activeTerminalInputs.delete(input)
    if (!operationFailed && restoreError !== undefined) throw restoreError
  }
}

async function readSecretFromTerminal(
  promptText: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  signal: AbortSignal | undefined,
): Promise<string> {
  const originalRawMode = input.isRaw === true
  const wasFlowing = input.readableFlowing === true
  const decoder = new StringDecoder('utf8')
  let value = ''
  let settled = false
  let rawModeTouched = false
  let promptWritten = false
  let promptWrite: Promise<unknown> | undefined
  let resolveInput: ((value: string) => void) | undefined
  let rejectInput: ((error: unknown) => void) | undefined
  const result = new Promise<string>((resolve, reject) => {
    resolveInput = resolve
    rejectInput = reject
  })
  const settleValue = (secret: string): void => {
    if (settled) return
    settled = true
    resolveInput?.(secret)
  }
  const settleError = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectInput?.(error)
  }
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (const character of text) {
      const code = character.codePointAt(0)
      if (code === 3) {
        settleError(new CliInterruptedError())
        return
      }
      if (character === '\r' || character === '\n') {
        if (value.length === 0) settleError(new InvalidInputError('Secret input cannot be empty.'))
        else settleValue(value)
        return
      }
      if (code === 8 || code === 127) {
        value = Array.from(graphemeSegmenter.segment(value), part => part.segment).slice(0, -1).join('')
        continue
      }
      if (code != null && code >= 32) value += character
    }
  }
  const onError = (error: Error): void => settleError(error)
  const onOutputError = (error: Error): void => settleError(error)
  const onEnd = (): void => settleError(new CliInterruptedError())
  const onClose = (): void => settleError(new CliInterruptedError())
  const onAbort = (): void => settleError(abortReason(signal!))

  let operationFailed = false
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    output.once('error', onOutputError)
    input.once('error', onError)
    input.once('end', onEnd)
    input.once('close', onClose)
    if (signal?.aborted) settleError(abortReason(signal))
    if (input.readableEnded || input.destroyed) settleError(new CliInterruptedError())
    if (!settled) {
      rawModeTouched = true
      input.setRawMode(true)
    }
    if (!settled) {
      input.on('data', onData)
      input.resume()
      promptWritten = true
      promptWrite = writeTerminalOutput(output, promptText).then(
        () => undefined,
        error => {
          settleError(error)
          return error
        },
      )
    }
    const secret = await result
    const promptError = await promptWrite
    if (promptError !== undefined) throw promptError
    return secret
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    let cleanupError: unknown
    const cleanup = (action: () => void): void => {
      try {
        action()
      } catch (error) {
        cleanupError ??= error
      }
    }
    cleanup(() => input.removeListener('data', onData))
    cleanup(() => input.removeListener('error', onError))
    cleanup(() => input.removeListener('end', onEnd))
    cleanup(() => input.removeListener('close', onClose))
    cleanup(() => signal?.removeEventListener('abort', onAbort))
    cleanup(() => {
      if (rawModeTouched) input.setRawMode(originalRawMode)
    })
    cleanup(() => {
      if (!wasFlowing) input.pause()
    })
    if (promptWrite) await promptWrite
    if (promptWritten) {
      try {
        await writeTerminalOutput(output, '\n')
      } catch (error) {
        cleanupError ??= error
      }
    }
    cleanup(() => output.removeListener('error', onOutputError))
    value = ''
    if (!operationFailed && cleanupError !== undefined) throw cleanupError
  }
}

function writeTerminalOutput(output: NodeJS.WriteStream, text: string): Promise<void> {
  if (output.write.length < 2) {
    output.write(text)
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      output.removeListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error): void => finish(error)
    output.once('error', onError)
    try {
      output.write(text, finish)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function isCliInterruptedError(error: unknown): error is CliInterruptedError {
  return error instanceof CliInterruptedError
}

export function isCliInputError(
  error: unknown,
): error is CliInterruptedError | InteractionRequiredError | InvalidInputError | InputBusyError {
  return error instanceof CliInterruptedError
    || error instanceof InteractionRequiredError
    || error instanceof InvalidInputError
    || error instanceof InputBusyError
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return isCliInputError(signal.reason) ? signal.reason : new CliInterruptedError()
}
