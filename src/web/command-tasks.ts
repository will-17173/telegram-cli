import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import { isSafeAccountName } from '../account/account-name.js'
import { AccountStore } from '../account/account-store.js'
import { getDesktopCommandDefinitions, type DesktopCommandDefinition } from './command-catalog.js'
import type { DesktopCommand, DesktopCommandInput, DesktopField, DesktopListenInput, DesktopTask } from './workspace-types.js'

type TaskAccess = 'none' | 'read' | 'session' | 'files'
type TaskResources = { access: TaskAccess; account: string | null }
type SpawnChild = (executable: string, args: string[], options: SpawnOptions) => ChildProcess

export type DesktopTaskRunnerOptions = {
  dataDir: string
  isAccountBusy?: (account: string | null) => boolean
  spawn?: SpawnChild
  commandFactory?: () => Command
  cliEntry?: string
  nodeArgs?: string[]
  environment?: NodeJS.ProcessEnv
  maxOutputBytes?: number
  maxTasks?: number
  cancelTimeoutMs?: number
  sendTimeoutMs?: number
}

type PendingSend = {
  input?: DesktopListenInput
  timer: ReturnType<typeof setTimeout>
  resolve: (data: unknown) => void
  reject: (error: DesktopTaskError) => void
  sent: boolean
}

type RunningTask = {
  task: DesktopTask
  child: ChildProcess
  resources: TaskResources
  output: BoundedOutput
  errors: BoundedOutput
  cancelled: boolean
  killTimer?: ReturnType<typeof setTimeout>
  done: Promise<void>
  finish: () => void
  clearSecret?: () => void
  listenReady: boolean
  listenDisconnected: boolean
  listenPaused: boolean
  pendingSends: Map<string, PendingSend>
  detachListen?: () => void
}

export class DesktopTaskError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DesktopTaskError'
  }
}

export class DesktopTaskRunner {
  private readonly dataDir: string
  private readonly commands: Map<string, DesktopCommandDefinition>
  private readonly tasks = new Map<string, DesktopTask>()
  private readonly running = new Map<string, RunningTask>()
  private readonly spawnChild: SpawnChild
  private readonly maxOutputBytes: number
  private readonly maxTasks: number
  private readonly cancelTimeoutMs: number
  private readonly sendTimeoutMs: number
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly options: DesktopTaskRunnerOptions) {
    if (typeof options.dataDir !== 'string' || options.dataDir.trim() === '' || options.dataDir.includes('\0')) {
      throw invalidRequest('dataDir must be a non-empty path.')
    }
    this.dataDir = resolve(options.dataDir)
    this.commands = new Map(getDesktopCommandDefinitions(options.commandFactory?.()).map(definition => [definition.command.id, definition]))
    this.spawnChild = options.spawn ?? spawn
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 256 * 1024, 'maxOutputBytes')
    this.maxTasks = positiveInteger(options.maxTasks ?? 100, 'maxTasks')
    this.cancelTimeoutMs = positiveInteger(options.cancelTimeoutMs ?? 2_000, 'cancelTimeoutMs')
    this.sendTimeoutMs = positiveInteger(options.sendTimeoutMs ?? 30_000, 'sendTimeoutMs')
  }

  start(input: DesktopCommandInput): DesktopTask {
    if (this.closed) throw new DesktopTaskError(500, 'runner_closed', 'The desktop task runner is closed.')
    const { definition, validated } = this.validateInput(input)
    const resources = this.resolveResources(definition.command, validated)
    this.assertAvailable(resources)
    this.makeHistorySpace()

    const args = this.buildArguments(definition, validated, resources.account)
    const invocation = this.cliInvocation()
    const environment: NodeJS.ProcessEnv = { ...process.env, ...this.options.environment, DATA_DIR: this.dataDir }
    // A database override inherited from the web launcher must never escape this data directory.
    delete environment.DB_PATH
    delete environment.TG_DESKTOP_IPC
    let ownershipPassword: string | undefined
    if (definition.command.id === 'group admin transfer-owner') {
      ownershipPassword = validated.options?.ownershipPassword as string
      delete validated.options?.ownershipPassword
      environment.TG_DESKTOP_IPC = '1'
    }
    const useIpc = ownershipPassword != null || definition.command.id === 'listen'
    if (useIpc) environment.TG_DESKTOP_IPC = '1'

    let child: ChildProcess
    try {
      child = this.spawnChild(process.execPath, [...invocation.nodeArgs, invocation.entry, ...args], {
        env: environment,
        stdio: useIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      ownershipPassword = undefined
      throw new DesktopTaskError(500, 'execution_failed', errorMessage(error))
    }

    const task: DesktopTask = {
      id: randomUUID(),
      commandId: definition.command.id,
      account: resources.account,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      result: null,
      truncated: false,
    }
    let finish!: () => void
    const done = new Promise<void>(resolveDone => { finish = resolveDone })
    const running: RunningTask = {
      task,
      child,
      resources,
      output: new BoundedOutput(this.maxOutputBytes),
      errors: new BoundedOutput(this.maxOutputBytes),
      cancelled: false,
      done,
      finish,
      listenReady: false,
      listenDisconnected: false,
      listenPaused: false,
      pendingSends: new Map(),
    }
    this.tasks.set(task.id, task)
    this.running.set(task.id, running)
    if (ownershipPassword != null) {
      const clearSecret = () => {
        ownershipPassword = undefined
        child.off('message', onSecretRequest)
        child.off('disconnect', clearSecret)
      }
      const onSecretRequest = (message: unknown) => {
        if (!isRecord(message) || message.type !== 'tg-desktop-secret-request' || message.name !== 'ownershipPassword' || ownershipPassword == null) return
        const password = ownershipPassword
        clearSecret()
        try {
          child.send?.({ type: 'tg-desktop-secret-response', name: 'ownershipPassword', value: password }, error => {
            if (error != null) this.cancel(task.id)
          })
        } catch {
          this.cancel(task.id)
        }
      }
      running.clearSecret = clearSecret
      child.on('message', onSecretRequest)
      child.once('disconnect', clearSecret)
    }
    if (definition.command.id === 'listen') this.attachListen(running)
    child.stdout?.on('data', chunk => this.captureOutput(running, 'stdout', chunk))
    child.stderr?.on('data', chunk => this.captureOutput(running, 'stderr', chunk))
    child.once('error', error => {
      this.captureOutput(running, 'stderr', `${errorMessage(error)}\n`)
      task.result = { ok: false, error: { code: 'execution_failed', message: errorMessage(error) } }
      this.finishTask(running, null)
    })
    child.once('close', code => this.finishTask(running, code))
    return copyTask(task)
  }

  list(): DesktopTask[] {
    return [...this.tasks.values()].reverse().map(copyTask)
  }

  get(id: string): DesktopTask | undefined {
    const task = this.tasks.get(id)
    return task == null ? undefined : copyTask(task)
  }

  cancel(id: string): DesktopTask | undefined {
    const running = this.running.get(id)
    if (running != null && !running.cancelled) {
      running.cancelled = true
      running.clearSecret?.()
      this.rejectSends(running, new DesktopTaskError(409, 'task_not_running', 'The listener is being cancelled.'))
      this.signalChild(running, 'SIGINT')
      if (this.running.has(id)) {
        running.killTimer = setTimeout(() => this.signalChild(running, 'SIGKILL'), this.cancelTimeoutMs)
        running.killTimer.unref()
      }
    }
    return this.get(id)
  }

  async sendInput(id: string, input: DesktopListenInput): Promise<unknown> {
    const task = this.tasks.get(id)
    if (task == null) throw new DesktopTaskError(404, 'not_found', 'Desktop task not found.')
    const running = this.running.get(id)
    if (task.commandId !== 'listen' || running == null || running.cancelled) {
      throw new DesktopTaskError(409, 'task_not_running', 'Select a running listener before sending a message.')
    }
    if (running.listenDisconnected) throw new DesktopTaskError(409, 'listen_unavailable', 'The listener input channel is closed.')
    if (running.listenPaused) throw new DesktopTaskError(409, 'listen_unavailable', 'The listener is reconnecting. Wait for it to become ready before sending.')
    const validated = validateListenInput(input)
    if (running.pendingSends.size >= 32) throw new DesktopTaskError(409, 'send_queue_full', 'The listener already has too many pending messages.')
    const requestId = randomUUID()
    return new Promise<unknown>((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        running.pendingSends.delete(requestId)
        rejectSend(new DesktopTaskError(500, 'listen_send_timeout', 'The listener did not complete the message in time.'))
      }, this.sendTimeoutMs)
      running.pendingSends.set(requestId, { input: validated, timer, resolve: resolveSend, reject: rejectSend, sent: false })
      if (running.listenReady) this.deliverListenInput(running, requestId)
    })
  }

  isAccountBusy(account?: string): boolean {
    const internallyBusy = [...this.running.values()].some(({ resources }) => resources.access !== 'none'
      && resources.access !== 'read'
      && (account == null || resources.account == null || resources.account === account))
    return internallyBusy || this.options.isAccountBusy?.(account ?? null) === true
  }

  close(): Promise<void> {
    this.closing ??= this.closeTasks()
    return this.closing
  }

  private async closeTasks(): Promise<void> {
    this.closed = true
    const running = [...this.running.values()]
    for (const { task } of running) this.cancel(task.id)
    await Promise.all(running.map(task => task.done))
  }

  private validateInput(input: DesktopCommandInput): { definition: DesktopCommandDefinition; validated: DesktopCommandInput } {
    if (!isRecord(input)) throw invalidRequest('Request body must be a JSON object.')
    assertKeys(input, new Set(['commandId', 'account', 'arguments', 'options', 'confirmed']), 'request')
    if (typeof input.commandId !== 'string') throw invalidRequest('commandId must be a string.')
    const definition = this.commands.get(input.commandId)
    if (definition == null) throw invalidRequest('Unknown desktop command.')
    if (input.account !== undefined && (typeof input.account !== 'string' || !isSafeAccountName(input.account.trim()))) {
      throw invalidRequest('account must be a valid non-empty account name.')
    }
    if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw invalidRequest('confirmed must be a boolean.')
    if (definition.command.destructive && input.confirmed !== true) {
      throw new DesktopTaskError(400, 'confirmation_required', 'Confirm this operation before running it.')
    }
    const argumentValues = validateFields(input.arguments, definition.command.arguments, 'arguments')
    const optionValues = validateFields(input.options, definition.command.options, 'options')
    const validated = {
      commandId: input.commandId,
      account: input.account?.trim(),
      arguments: argumentValues as DesktopCommandInput['arguments'],
      options: optionValues,
      confirmed: input.confirmed,
    }
    return { definition, validated }
  }

  private resolveResources(command: DesktopCommand, input: DesktopCommandInput): TaskResources {
    if (command.id === 'data reset' && input.options?.allAccounts === true) {
      if (input.account != null) throw invalidRequest('allAccounts cannot be combined with account.')
      return { access: 'files', account: null }
    }
    const accountFileCommand = ['account remove', 'account logout', 'account rename'].includes(command.id)
    let account = input.account ?? null
    if (accountFileCommand) {
      const name = input.arguments?.name
      account = typeof name === 'string' ? name : account
    }
    if (command.requiresAccount || accountFileCommand) {
      const registry = new AccountStore(join(this.dataDir, 'accounts.json')).read()
      account ??= registry.current_account
      if (account == null) throw new DesktopTaskError(400, 'account_required', 'Select an account before running this operation.')
      if (!registry.accounts.some(candidate => candidate.name === account)) {
        throw new DesktopTaskError(400, 'account_not_found', `Account "${account}" is not registered.`)
      }
      // Account logout selects its positional name rather than the global account option.
      if (command.id === 'account logout' && input.arguments?.name == null) input.arguments = { ...input.arguments, name: account }
    }
    if (accountFileCommand || command.id === 'purge' || command.id === 'data reset') return { access: 'files', account }
    if (command.category === 'messages' || command.id === 'export') return { access: 'read', account }
    if (command.requiresAccount) return { access: 'session', account }
    return { access: 'none', account }
  }

  private assertAvailable(resources: TaskResources): void {
    if (resources.access === 'none') return
    const conflict = [...this.running.values()].some(({ resources: active }) => {
      if (active.access === 'none') return false
      if (active.account != null && resources.account != null && active.account !== resources.account) return false
      return active.access === 'files' || resources.access === 'files'
        || (active.access === 'session' && resources.access === 'session')
    })
    const externallyBusy = resources.access !== 'read' && this.options.isAccountBusy?.(resources.account) === true
    if (conflict || externallyBusy) throw new DesktopTaskError(409, 'account_busy', 'The account is already running another operation. Wait for it to finish or cancel it.')
  }

  private buildArguments(definition: DesktopCommandDefinition, input: DesktopCommandInput, account: string | null): string[] {
    const args = account == null ? [] : [`--account=${account}`]
    args.push(...definition.command.path)
    const optionValues = { ...input.options }
    if (definition.command.destructive && definition.command.options.some(field => field.name === 'yes')) optionValues.yes = true
    if (definition.command.id === 'listen') optionValues.interactive = false
    for (const field of definition.command.options) {
      const value = optionValues[field.name]
      if (value === undefined || field.flag == null) continue
      if (field.kind === 'boolean') {
        if (value === !field.negated) args.push(field.flag)
      } else {
        for (const item of Array.isArray(value) ? value : [value]) {
          args.push(field.flag.startsWith('--') ? `${field.flag}=${item}` : `${field.flag}${item}`)
        }
      }
    }
    if (supportsJson(definition.cli)) args.push('--json')
    const positionals: string[] = []
    let omitted = false
    for (const field of definition.command.arguments) {
      const value = input.arguments?.[field.name]
      if (value === undefined || (Array.isArray(value) && value.length === 0)) {
        omitted = true
        continue
      }
      if (omitted) throw invalidRequest(`Provide earlier positional arguments before ${field.name}, or use its option alias.`)
      positionals.push(...(Array.isArray(value) ? value : [value]))
    }
    if (positionals.length > 0) args.push('--', ...positionals)
    return args
  }

  private cliInvocation(): { entry: string; nodeArgs: string[] } {
    if (this.options.cliEntry != null) return { entry: this.options.cliEntry, nodeArgs: this.options.nodeArgs ?? [] }
    const launchedEntry = process.argv[1]
    // ncc moves this module into index.js. Reuse the actual CLI entry in the sidecar.
    const entry = launchedEntry != null && process.argv.slice(2).includes('web') && existsSync(launchedEntry)
      ? resolve(launchedEntry)
      : fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url))
    const nodeArgs = this.options.nodeArgs ?? (extname(entry) === '.ts' ? ['--import', createRequire(import.meta.url).resolve('tsx')] : [])
    return { entry, nodeArgs }
  }

  private makeHistorySpace(): void {
    while (this.tasks.size >= this.maxTasks) {
      const oldest = [...this.tasks.values()].find(task => !this.running.has(task.id))
      if (oldest == null) throw new DesktopTaskError(409, 'task_limit', 'Too many desktop tasks are running.')
      this.tasks.delete(oldest.id)
    }
  }

  private captureOutput(running: RunningTask, stream: 'stdout' | 'stderr', chunk: string | Buffer): void {
    const output = stream === 'stdout' ? running.output : running.errors
    output.append(chunk)
    running.task[stream] = output.text()
    running.task.truncated = running.output.truncated || running.errors.truncated
  }

  private attachListen(running: RunningTask): void {
    const onMessage = (message: unknown) => {
      if (!isRecord(message)) return
      if (message.type === 'tg-desktop-listen-ready') {
        running.listenReady = true
        running.listenPaused = false
        for (const requestId of running.pendingSends.keys()) this.deliverListenInput(running, requestId)
        return
      }
      if (message.type === 'tg-desktop-listen-unready') {
        running.listenReady = false
        running.listenPaused = true
        this.rejectSends(running, new DesktopTaskError(409, 'listen_unavailable', 'The listener is reconnecting. Wait for it to become ready before sending.'))
        return
      }
      if (message.type !== 'tg-desktop-listen-result' || typeof message.requestId !== 'string' || !isRecord(message.result)) return
      const pending = running.pendingSends.get(message.requestId)
      if (pending == null) return
      clearTimeout(pending.timer)
      running.pendingSends.delete(message.requestId)
      if (message.result.ok === true) {
        this.captureOutput(running, 'stdout', 'sent: message delivered\n')
        pending.resolve(message.result.data ?? null)
      } else if (message.result.ok === false && isRecord(message.result.error)) {
        const code = typeof message.result.error.code === 'string' ? message.result.error.code : 'listen_send_failed'
        pending.reject(new DesktopTaskError(listenFailureStatus(code), code,
          typeof message.result.error.message === 'string' ? message.result.error.message : 'The listener could not send the message.'))
      } else {
        pending.reject(new DesktopTaskError(500, 'listen_send_failed', 'The listener returned an invalid send result.'))
      }
    }
    const onDisconnect = () => {
      running.listenDisconnected = true
      this.rejectSends(running, new DesktopTaskError(409, 'listen_unavailable', 'The listener input channel is closed.'))
    }
    running.child.on('message', onMessage)
    running.child.once('disconnect', onDisconnect)
    running.detachListen = () => {
      running.child.off('message', onMessage)
      running.child.off('disconnect', onDisconnect)
    }
  }

  private deliverListenInput(running: RunningTask, requestId: string): void {
    const pending = running.pendingSends.get(requestId)
    if (pending == null || pending.sent || pending.input == null) return
    pending.sent = true
    const input = pending.input
    pending.input = undefined
    const fail = () => {
      if (!running.pendingSends.delete(requestId)) return
      clearTimeout(pending.timer)
      pending.reject(new DesktopTaskError(500, 'listen_send_failed', 'Unable to send input to the listener.'))
    }
    try {
      if (running.child.send == null) fail()
      else running.child.send({ type: 'tg-desktop-listen-send', requestId, input }, error => { if (error != null) fail() })
    } catch { fail() }
  }

  private rejectSends(running: RunningTask, error: DesktopTaskError): void {
    for (const pending of running.pendingSends.values()) {
      clearTimeout(pending.timer)
      pending.input = undefined
      pending.reject(error)
    }
    running.pendingSends.clear()
  }

  private signalChild(running: RunningTask, signal: NodeJS.Signals): void {
    try {
      running.child.kill(signal)
    } catch (error) {
      this.captureOutput(running, 'stderr', `${errorMessage(error)}\n`)
    }
  }

  private finishTask(running: RunningTask, exitCode: number | null): void {
    if (!this.running.has(running.task.id)) return
    running.clearSecret?.()
    running.detachListen?.()
    this.rejectSends(running, new DesktopTaskError(409, 'task_not_running', 'The listener has stopped.'))
    if (running.killTimer != null) clearTimeout(running.killTimer)
    const { task } = running
    task.exitCode = exitCode
    task.result ??= extractStructuredResult(task.stdout, running.output.truncated)
    task.status = running.cancelled ? 'cancelled' : exitCode === 0 && !isFailureResult(task.result) ? 'succeeded' : 'failed'
    task.finishedAt = new Date().toISOString()
    this.running.delete(task.id)
    running.finish()
  }
}

function validateListenInput(input: unknown): DesktopListenInput {
  if (!isRecord(input)) throw invalidRequest('Request body must be a JSON object.')
  assertKeys(input, new Set(['chat', 'text', 'files', 'reply', 'linkPreview']), 'listener input')
  if (!validString(input.chat) || input.chat.trim() === '' || input.chat.length > 512) throw invalidRequest('chat must be a non-empty string of at most 512 characters.')
  if (input.text !== undefined && (!validString(input.text) || input.text.length > 4_096)) throw invalidRequest('text must be a string of at most 4096 characters without null characters.')
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 100 || !input.files.every(file => validString(file) && file.trim() !== '' && file.length <= 4_096))) {
    throw invalidRequest('files must be an array of non-empty paths.')
  }
  if (input.reply !== undefined && (typeof input.reply !== 'number' || !Number.isSafeInteger(input.reply) || input.reply <= 0)) {
    throw invalidRequest('reply must be a positive integer.')
  }
  if (input.linkPreview !== undefined && typeof input.linkPreview !== 'boolean') throw invalidRequest('linkPreview must be a boolean.')
  if ((input.text === undefined || input.text === '') && (!Array.isArray(input.files) || input.files.length === 0)) {
    throw invalidRequest('Provide message text or attachments before sending.')
  }
  return {
    chat: input.chat,
    ...(input.text === undefined ? {} : { text: input.text as string }),
    ...(input.files === undefined ? {} : { files: [...input.files as string[]] }),
    ...(input.reply === undefined ? {} : { reply: input.reply as number }),
    ...(input.linkPreview === undefined ? {} : { linkPreview: input.linkPreview as boolean }),
  }
}

function listenFailureStatus(code: string): number {
  if (code === 'invalid_request' || code === 'write_access_disabled') return 400
  if (code === 'listen_send_busy' || code === 'listen_stopping' || code === 'listen_disconnected') return 409
  return 500
}

function validateFields(values: unknown, fields: DesktopField[], label: string): Record<string, string | boolean | string[]> {
  if (values !== undefined && !isRecord(values)) throw invalidRequest(`${label} must be a JSON object.`)
  const record = values ?? {}
  const names = new Set(fields.map(field => field.name))
  assertKeys(record, names, label)
  const result: Record<string, string | boolean | string[]> = {}
  for (const field of fields) {
    const value = Object.hasOwn(record, field.name) ? record[field.name] : undefined
    if (value === undefined) {
      if (field.required && field.defaultValue === undefined) throw invalidRequest(`${label}.${field.name} is required.`)
      continue
    }
    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') throw invalidRequest(`${label}.${field.name} must be a boolean.`)
    } else if (field.variadic || field.repeatable) {
      if (!Array.isArray(value) || !value.every(item => validString(item))) throw invalidRequest(`${label}.${field.name} must be an array of strings.`)
      if (field.required && value.length === 0) throw invalidRequest(`${label}.${field.name} is required.`)
    } else if (!validString(value)) {
      throw invalidRequest(`${label}.${field.name} must be a string without null characters.`)
    }
    if (field.required && value === '') throw invalidRequest(`${label}.${field.name} is required.`)
    if (field.choices != null && (Array.isArray(value) ? value : [value]).some(item => typeof item !== 'string' || !field.choices?.includes(item))) {
      throw invalidRequest(`${label}.${field.name} must be one of: ${field.choices.join(', ')}.`)
    }
    result[field.name] = Array.isArray(value) ? [...value] : value as string | boolean
  }
  return result
}

function supportsJson(command: Command): boolean {
  for (let current: Command | null = command; current != null; current = current.parent) {
    if (current.options.some(option => option.attributeName() === 'json')) return true
  }
  return false
}

function extractStructuredResult(output: string, truncated: boolean): unknown | null {
  try { return JSON.parse(output) as unknown } catch { /* Progress output may precede the JSON envelope. */ }
  let lastResult: unknown | null = null
  let lastEnvelope: unknown | null = null
  let skipUntil = 0
  let attempts = 0
  for (const match of output.matchAll(/^\s*[\[{]/gm)) {
    const start = match.index + match[0].search(/[\[{]/)
    if (start < skipUntil) continue
    if (++attempts > 100) break
    const end = jsonEnd(output, start)
    if (end == null) continue
    try {
      const result: unknown = JSON.parse(output.slice(start, end))
      skipUntil = end
      lastResult = result
      if (isRecord(result) && typeof result.ok === 'boolean') lastEnvelope = result
    } catch { /* Plain listen lines and incomplete JSON remain available in the logs. */ }
  }
  return lastEnvelope ?? (truncated ? null : lastResult)
}

function jsonEnd(text: string, start: number): number | undefined {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '{' || character === '[') depth++
    else if (character === '}' || character === ']') {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

class BoundedOutput {
  private buffer = Buffer.alloc(0)
  truncated = false

  constructor(private readonly limit: number) {}

  append(chunk: string | Buffer): void {
    const next = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const combined = Buffer.concat([this.buffer, next])
    this.truncated ||= combined.length > this.limit
    this.buffer = combined.length > this.limit ? Buffer.from(combined.subarray(-this.limit)) : combined
  }

  text(): string {
    let start = 0
    while (start < this.buffer.length && (this.buffer[start] & 0xc0) === 0x80) start++
    return this.buffer.toString('utf8', start)
  }
}

function copyTask(task: DesktopTask): DesktopTask {
  return { ...task, result: task.result == null ? null : structuredClone(task.result) }
}

function isFailureResult(result: unknown): boolean {
  return isRecord(result) && result.ok === false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw invalidRequest(`Unknown ${label} field: ${key}.`)
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0')
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidRequest(`${name} must be a positive integer.`)
  return value
}

function invalidRequest(message: string): DesktopTaskError {
  return new DesktopTaskError(400, 'invalid_request', message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
