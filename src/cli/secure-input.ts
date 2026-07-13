import { StringDecoder } from 'node:string_decoder'

export type SecureInputOptions = {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  signal?: AbortSignal
}

type InterruptSignal = 'SIGINT' | 'SIGHUP' | 'SIGTERM'

export class CliInterruptedError extends Error {
  readonly code = 'interrupted'
  readonly exitCode: number
  readonly signal: InterruptSignal

  constructor(signal: InterruptSignal = 'SIGINT') {
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
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const SIGNAL_CLEANUP_GRACE_MS = 100

type PendingOutputWrite = { onError: (error: Error) => void }
type OutputWriteHandle = { detachErrorHandler: () => void }
type OutputWriteState = {
  pending: Set<PendingOutputWrite>
  failed: boolean
  guard: (error: Error) => void
  onClose: () => void
}

const pendingOutputWrites = new WeakMap<NodeJS.WriteStream, OutputWriteState>()
const inputsAwaitingLineFeed = new WeakSet<NodeJS.ReadStream>()
const ignoreOutputError = (): void => undefined

export function createInterruptScope(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const previousExitCode = process.exitCode
  let fallback: NodeJS.Timeout | undefined
  let assignedExitCode: number | undefined
  let disposed = false
  const keepAlive = setTimeout(() => undefined, 2_147_483_647)
  // SIGKILL cannot be observed; for catchable signals, re-raise after a short cooperative cleanup window.
  // Signal exit-status behavior is Unix-tested; Windows signal delivery is limited by Node and the host console.
  const handlers = Object.fromEntries((['SIGINT', 'SIGHUP', 'SIGTERM'] as const).map(processSignal => [
    processSignal,
    () => {
      if (controller.signal.aborted || disposed) return
      const interruption = new CliInterruptedError(processSignal)
      assignedExitCode = interruption.exitCode
      process.exitCode = interruption.exitCode
      clearTimeout(keepAlive)
      controller.abort(interruption)
      if (disposed) return
      fallback = setTimeout(() => {
        removeHandlers()
        process.kill(process.pid, processSignal)
      }, SIGNAL_CLEANUP_GRACE_MS)
      fallback.unref()
    },
  ])) as Record<InterruptSignal, () => void>
  const removeHandlers = (): void => {
    for (const processSignal of Object.keys(handlers) as InterruptSignal[]) {
      process.removeListener(processSignal, handlers[processSignal])
    }
  }
  for (const processSignal of Object.keys(handlers) as InterruptSignal[]) {
    process.once(processSignal, handlers[processSignal])
  }

  return {
    signal: controller.signal,
    dispose: () => {
      disposed = true
      clearTimeout(keepAlive)
      if (fallback) clearTimeout(fallback)
      removeHandlers()
      if (assignedExitCode !== undefined && process.exitCode === assignedExitCode) {
        process.exitCode = previousExitCode
      }
    },
  }
}

export async function readVisibleInput(
  prompt: string,
  streams: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; signal?: AbortSignal } = {},
): Promise<string> {
  return readTerminalInput(prompt, streams, false)
}

export async function readSecret(
  prompt: string,
  streams: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; signal?: AbortSignal } = {},
): Promise<string> {
  return readTerminalInput(prompt, streams, true)
}

async function readTerminalInput(prompt: string, streams: SecureInputOptions, hidden: boolean): Promise<string> {
  const input = streams.input ?? process.stdin
  const output = streams.output ?? process.stderr
  if (input.isTTY !== true || ((hidden || input.isRaw === true) && typeof input.setRawMode !== 'function')) {
    throw new InteractionRequiredError()
  }
  throwIfAborted(streams.signal)
  if (input.readableEnded || input.destroyed) throw new CliInterruptedError()
  if (activeTerminalInputs.has(input) || input.listenerCount('data') > 0) throw new InputBusyError()

  activeTerminalInputs.add(input)
  try {
    drainBufferedInput(input)
    return await readOwnedTerminalInput(prompt, input, output, streams.signal, hidden)
  } finally {
    activeTerminalInputs.delete(input)
  }
}

async function readOwnedTerminalInput(
  prompt: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  signal: AbortSignal | undefined,
  hidden: boolean,
): Promise<string> {
  const originalRawMode = input.isRaw === true
  const wasFlowing = input.readableFlowing === true
  const decoder = new StringDecoder('utf8')
  let value = ''
  let settled = false
  let rawModeTouched = false
  let promptStarted = false
  let promptWrite: OutputWriteHandle | undefined
  let operationFailed = false
  let escapeState: 'none' | 'start' | 'sequence' | 'osc' = 'none'
  let resolveInput: ((value: string) => void) | undefined
  let rejectInput: ((error: unknown) => void) | undefined
  const result = new Promise<string>((resolve, reject) => {
    resolveInput = resolve
    rejectInput = reject
  })
  const settleValue = (line: string): void => {
    if (settled) return
    settled = true
    resolveInput?.(line)
  }
  const settleError = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectInput?.(error)
  }
  const onData = (chunk: Buffer | string): void => {
    if (settled) return
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    for (const character of text) {
      const code = character.codePointAt(0)
      if (inputsAwaitingLineFeed.has(input)) {
        inputsAwaitingLineFeed.delete(input)
        if (character === '\n') continue
      }
      if (code === 3) {
        settleError(new CliInterruptedError())
        return
      }
      if (character === '\r' || character === '\n') {
        if (character === '\r') inputsAwaitingLineFeed.add(input)
        if (hidden && value.length === 0) settleError(new InvalidInputError('Secret input cannot be empty.'))
        else settleValue(value)
        return
      }
      if (code === 27) {
        escapeState = 'start'
        continue
      }
      if (escapeState === 'start') {
        escapeState = character === ']'
          ? 'osc'
          : character === '[' || character === 'O' ? 'sequence' : 'none'
        continue
      }
      if (escapeState === 'sequence') {
        if (code != null && code >= 0x40 && code <= 0x7e) escapeState = 'none'
        continue
      }
      if (escapeState === 'osc') {
        if (code === 7) escapeState = 'none'
        continue
      }
      if (code === 8 || code === 127) {
        value = removeFinalGrapheme(value)
        continue
      }
      if (code != null && code >= 32 && (code < 127 || code > 159)) value += character
    }
  }
  const onInputError = (error: Error): void => settleError(error)
  const onOutputError = (error: Error): void => settleError(error)
  const onInputUnavailable = (): void => settleError(new CliInterruptedError())
  const onAbort = (): void => settleError(abortReason(signal!))

  signal?.addEventListener('abort', onAbort, { once: true })
  output.on('error', onOutputError)
  input.once('error', onInputError)
  input.once('end', onInputUnavailable)
  input.once('close', onInputUnavailable)
  try {
    if (signal?.aborted) settleError(abortReason(signal))
    if (input.readableEnded || input.destroyed) settleError(new CliInterruptedError())
    if (!settled && (hidden || originalRawMode)) {
      rawModeTouched = true
      input.setRawMode(hidden)
    }
    if (!settled) {
      input.on('data', onData)
      const unexpectedDataListeners = input.listeners('data').filter(listener => listener !== onData)
      if (unexpectedDataListeners.length > 0) settleError(new InputBusyError())
    }
    if (!settled) input.resume()
    if (!settled) {
      promptStarted = true
      promptWrite = startOutputWrite(output, prompt, settleError)
    }
    return await result
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
    cleanup(() => input.removeListener('error', onInputError))
    cleanup(() => input.removeListener('end', onInputUnavailable))
    cleanup(() => input.removeListener('close', onInputUnavailable))
    cleanup(() => signal?.removeEventListener('abort', onAbort))
    cleanup(() => {
      // A broken writer may keep the token forever, so detach the operation closure before releasing input.
      promptWrite?.detachErrorHandler()
      promptWrite = undefined
    })
    cleanup(() => {
      if (rawModeTouched) input.setRawMode(originalRawMode)
    })
    cleanup(() => {
      if (!wasFlowing) input.pause()
    })
    cleanup(() => output.removeListener('error', onOutputError))
    cleanup(() => {
      if (promptStarted && hidden) startOutputWrite(output, '\n')
    })
    value = ''
    if (!operationFailed && cleanupError !== undefined) throw cleanupError
  }
}

function startOutputWrite(
  output: NodeJS.WriteStream,
  text: string,
  onError: (error: Error) => void = ignoreOutputError,
): OutputWriteHandle {
  const state = getOutputWriteState(output)
  const pendingWrite = { onError }
  const handle = {
    detachErrorHandler: () => {
      pendingWrite.onError = ignoreOutputError
    },
  }
  state.pending.add(pendingWrite)
  try {
    output.write(text, error => {
      state.pending.delete(pendingWrite)
      if (error) {
        state.failed = true
        pendingWrite.onError(error)
        if (state.pending.size === 0) scheduleOutputStateRelease(output, state)
      } else if (state.pending.size === 0 && !state.failed) {
        releaseOutputWriteState(output, state)
      }
    })
  } catch (error) {
    state.pending.delete(pendingWrite)
    if (state.pending.size === 0 && !state.failed) releaseOutputWriteState(output, state)
    throw error instanceof Error ? error : new Error(String(error))
  }
  return handle
}

function scheduleOutputStateRelease(output: NodeJS.WriteStream, state: OutputWriteState): void {
  const immediate = setImmediate(() => {
    if (state.pending.size === 0) releaseOutputWriteState(output, state)
  })
  immediate.unref()
}

function getOutputWriteState(output: NodeJS.WriteStream): OutputWriteState {
  const existing = pendingOutputWrites.get(output)
  if (existing) return existing

  const state = {} as OutputWriteState
  state.pending = new Set()
  state.failed = false
  state.guard = error => {
    for (const pendingWrite of state.pending) pendingWrite.onError(error)
    if (state.pending.size === 0) releaseOutputWriteState(output, state)
  }
  state.onClose = () => releaseOutputWriteState(output, state)
  pendingOutputWrites.set(output, state)
  output.on('error', state.guard)
  output.once('close', state.onClose)
  return state
}

function releaseOutputWriteState(output: NodeJS.WriteStream, state: OutputWriteState): void {
  if (pendingOutputWrites.get(output) !== state) return
  pendingOutputWrites.delete(output)
  state.pending.clear()
  output.removeListener('error', state.guard)
  output.removeListener('close', state.onClose)
}

function removeFinalGrapheme(value: string): string {
  return Array.from(graphemeSegmenter.segment(value), part => part.segment).slice(0, -1).join('')
}

function drainBufferedInput(input: NodeJS.ReadStream): void {
  while (input.read() !== null) {
    // Discard bytes entered before this prompt, including remainder from a multiline paste.
  }
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
