import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Argument, Command, Option } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../../src/account/account-store.js'
import { createApp } from '../../src/cli/app.js'
import { DesktopTaskError, DesktopTaskRunner, type DesktopTaskRunnerOptions } from '../../src/web/command-tasks.js'
import type { DesktopCommandInput, DesktopListenInput } from '../../src/web/workspace-types.js'

const roots: string[] = []
const runners: DesktopTaskRunner[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-desktop-tasks-'))
  roots.push(root)
  new AccountStore(join(root, 'accounts.json')).write({
    version: 2,
    current_account: 'work',
    accounts: ['work', 'other'].map((name, index) => ({
      name, user_id: index + 1, username: name, phone: `100000${index}`, display_name: name, auth_state: 'authenticated',
    })),
  })
  return root
}

class FakeChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  signals: NodeJS.Signals[] = []
  ignoreInterrupt = false

  override kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(signal as NodeJS.Signals)
    if (signal !== 'SIGINT' || !this.ignoreInterrupt) this.complete(null, signal as NodeJS.Signals)
    return true
  }

  complete(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, signal)
  }
}

function fakeRunner(options: Partial<DesktopTaskRunnerOptions> = {}) {
  const children: FakeChild[] = []
  const calls: Array<{ executable: string; args: string[]; options: SpawnOptions }> = []
  const runner = new DesktopTaskRunner({
    dataDir: makeRoot(),
    cliEntry: '/fixed/telegram-cli.js',
    spawn: (executable, args, spawnOptions) => {
      calls.push({ executable, args, options: spawnOptions })
      const child = new FakeChild()
      children.push(child)
      return child
    },
    ...options,
  })
  runners.push(runner)
  return { runner, calls, children }
}

function expectError(action: () => unknown, code: string, status = 400): void {
  try { action() } catch (error) {
    expect(error).toBeInstanceOf(DesktopTaskError)
    expect(error).toMatchObject({ code, status })
    return
  }
  throw new Error(`Expected ${code}`)
}

describe('desktop command task execution', () => {
  it('spawns a fixed Node entry with argument arrays, preserving negative IDs and message whitespace', async () => {
    const { runner, calls } = fakeRunner({ environment: { DB_PATH: '/private/real-account.db' } })
    const text = '  first line\nsecond line $(touch /tmp/never) `uname`  '
    const task = runner.start({
      commandId: 'send', account: 'other',
      arguments: { chat: '-10012345', message: text },
      options: { file: ['/tmp/first file.png', '--yaml'], reply: '--yaml', preview: false },
    })

    expect(task).toMatchObject({ status: 'running', account: 'other', stdout: '', stderr: '', finishedAt: null })
    expect(calls[0].executable).toBe(process.execPath)
    expect(calls[0].args).toEqual([
      '/fixed/telegram-cli.js', '--account=other', 'send', '--file=/tmp/first file.png', '--file=--yaml',
      '--reply=--yaml', '--no-preview', '--json', '--', '-10012345', text,
    ])
    expect(calls[0].options).toMatchObject({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(calls[0].options.env?.DATA_DIR).not.toBe(process.env.DATA_DIR)
    expect(calls[0].options.env).not.toHaveProperty('DB_PATH')
    expect(process.env.DB_PATH).not.toBe('/private/real-account.db')
    const parsed = vi.fn()
    const app = createApp().exitOverride()
    app.commands.find(command => command.name() === 'send')!.action((chat, message, options, command) => parsed(chat, message, command.optsWithGlobals()))
    await app.parseAsync(calls[0].args.slice(1), { from: 'user' })
    expect(parsed).toHaveBeenCalledWith('-10012345', text, expect.objectContaining({ account: 'other', file: ['/tmp/first file.png', '--yaml'], reply: '--yaml', preview: false, json: true }))
  })

  it('keeps repeated audit filters, alias options, and false negated values separate', () => {
    const { runner, calls, children } = fakeRunner()
    runner.start({ commandId: 'group audit', arguments: { chat: '-1001' }, options: { user: ['1', '--yes'], type: ['edit', 'delete'] } })
    expect(calls[0].args).toEqual([
      '/fixed/telegram-cli.js', '--account=work', 'group', 'audit', '--user=1', '--user=--yes', '--type=edit', '--type=delete', '--json', '--', '-1001',
    ])
    children[0].complete()
    runner.start({ commandId: 'download', options: { chat: '-1001', msg_id: '11', grouped_id: '22', ext: ['mp4', 'png'] } })
    expect(calls[1].args).toContain('--msg_id=11')
    expect(calls[1].args).toContain('--grouped_id=22')
    expect(calls[1].args).toContain('--chat=-1001')
    children[1].complete()
    runner.start({ commandId: 'listen', arguments: { chats: ['-1001', '--json'] }, options: { interactive: true, media: false } })
    expect(calls[2].args).toEqual([
      '/fixed/telegram-cli.js', '--account=work', 'listen', '--no-media', '--no-interactive', '--', '-1001', '--json',
    ])
  })

  it('requires separate confirmation and adds only supported yes flags', () => {
    const { runner, calls, children } = fakeRunner()
    expectError(() => runner.start({ commandId: 'purge', arguments: { chat: '-1001' }, options: { yes: true } }), 'confirmation_required')
    runner.start({ commandId: 'purge', arguments: { chat: '-1001' }, options: { yes: false }, confirmed: true })
    expect(calls[0].args).toContain('--yes')
    children[0].complete()
    runner.start({ commandId: 'delete', arguments: { chat: '-1001', msgIds: ['1', '2'] }, confirmed: true })
    expect(calls[1].args).not.toContain('--yes')
    expect(calls[1].args.slice(-4)).toEqual(['--', '-1001', '1', '2'])
    children[1].complete()
    runner.start({ commandId: 'group chat delete', arguments: { chat: '-1001' }, options: { confirmTitle: 'Exact title' }, confirmed: true })
    expect(calls[2].args).toContain('--confirm-title=Exact title')
    expect(calls[2].args).toContain('--yes')
  })

  it('selects account logout by its positional name as well as the global account flag', () => {
    const { runner, calls } = fakeRunner()
    const task = runner.start({ commandId: 'account logout', account: 'other', confirmed: true })
    expect(task.account).toBe('other')
    expect(calls[0].args).toEqual(['/fixed/telegram-cli.js', '--account=other', 'account', 'logout', '--yes', '--json', '--', 'other'])
  })

  it.each([
    { commandId: 'web' },
    { commandId: 'guard start' },
    { commandId: 'account login' },
    { commandId: 'account add' },
    { commandId: 'send; touch /tmp/no' },
    { commandId: 'send', arguments: { chat: 'x', message: 'text', injected: 'value' } },
    { commandId: 'send', arguments: { chat: 'x' }, options: { json: true } },
    { commandId: 'send', arguments: { chat: 'x' }, options: { preview: 'false' } },
    { commandId: 'send', arguments: { chat: 'x' }, options: { file: '/tmp/file' } },
    { commandId: 'send', arguments: { chat: 'x', message: '\0' } },
    { commandId: 'send', arguments: { chat: ['x'] } },
    { commandId: 'send', arguments: {} },
    { commandId: 'delete', arguments: { chat: 'x', msgIds: [] }, confirmed: true },
    { commandId: 'send', arguments: { chat: 'x' }, account: '../other' },
    { commandId: 'send', arguments: { chat: 'x' }, account: null },
    { commandId: 'send', arguments: { chat: 'x' }, options: null },
    { commandId: 'send', arguments: { chat: 'x' }, env: { DATA_DIR: '/tmp/other' } },
  ])('rejects invalid or hostile input before spawning: %j', input => {
    const { runner, calls } = fakeRunner()
    expectError(() => runner.start(input as DesktopCommandInput), 'invalid_request')
    expect(calls).toHaveLength(0)
  })

  it('rejects prototype keys and invalid request types', () => {
    const { runner, calls } = fakeRunner()
    for (const input of [null, [], 'send', JSON.parse('{"commandId":"send","arguments":{"chat":"x"},"options":{"__proto__":"x"}}')]) {
      expectError(() => runner.start(input as DesktopCommandInput), 'invalid_request')
    }
    expect(calls).toHaveLength(0)
  })

  it('rejects invalid positional gaps rather than shifting later values into another field', () => {
    const { runner, calls } = fakeRunner()
    expectError(() => runner.start({ commandId: 'download', arguments: { msgId: '42' } }), 'invalid_request')
    expect(calls).toHaveLength(0)
  })

  it('enforces required options, choices, and variadic option types', () => {
    const commandFactory = () => {
      const app = new Command()
      app.command('config').command('test')
        .addArgument(new Argument('[mode]').choices(['on', 'off']))
        .requiredOption('--token <token>')
        .addOption(new Option('--tags <tags...>').choices(['one', 'two']))
        .action(() => {})
      return app
    }
    const { runner, calls } = fakeRunner({ commandFactory })
    expectError(() => runner.start({ commandId: 'config test' }), 'invalid_request')
    expectError(() => runner.start({ commandId: 'config test', options: { token: 'x', tags: ['invalid'] } }), 'invalid_request')
    expectError(() => runner.start({ commandId: 'config test', options: { token: 'x', tags: 'one' } }), 'invalid_request')
    runner.start({ commandId: 'config test', options: { token: '--other', tags: ['one', 'two'] }, arguments: { mode: 'off' } })
    expect(calls[0].args).toEqual(['/fixed/telegram-cli.js', 'config', 'test', '--token=--other', '--tags=one', '--tags=two', '--', 'off'])
  })

  it('rejects missing accounts without reading default user data', () => {
    const root = makeRoot()
    rmSync(join(root, 'accounts.json'))
    const { runner, calls } = fakeRunner({ dataDir: root })
    expectError(() => runner.start({ commandId: 'stats' }), 'account_required')
    expect(calls).toHaveLength(0)
    const other = fakeRunner()
    expectError(() => other.runner.start({ commandId: 'stats', account: 'unknown' }), 'account_not_found')
  })

  it('extracts JSON envelopes around progress and trailing log output', () => {
    const { runner, children } = fakeRunner()
    const task = runner.start({ commandId: 'stats' })
    children[0].stdout.write('fetching...\n')
    children[0].stdout.write(JSON.stringify({ ok: true, schema_version: '2', data: { count: 12, text: '}' } }, null, 2))
    children[0].stdout.write('\nfinished\n')
    children[0].stderr.write('notice\n')
    children[0].complete(0)
    expect(runner.get(task.id)).toMatchObject({
      status: 'succeeded', exitCode: 0, stderr: 'notice\n',
      result: { ok: true, schema_version: '2', data: { count: 12, text: '}' } },
    })
    expect(runner.get(task.id)?.finishedAt).toEqual(expect.any(String))
  })

  it('records nonzero exits, structured failures, and asynchronous spawn errors', () => {
    const { runner, children } = fakeRunner()
    const first = runner.start({ commandId: 'stats' })
    children[0].stdout.write('{"ok":false,"error":{"code":"query_error","message":"Broken"}}\n')
    children[0].complete(0)
    expect(runner.get(first.id)).toMatchObject({ status: 'failed', result: { ok: false, error: { code: 'query_error' } } })
    const second = runner.start({ commandId: 'stats' })
    children[1].stderr.write('failed\n')
    children[1].complete(2)
    expect(runner.get(second.id)).toMatchObject({ status: 'failed', exitCode: 2, result: null })
    const third = runner.start({ commandId: 'stats' })
    children[2].emit('error', new Error('spawn ENOENT'))
    expect(runner.get(third.id)).toMatchObject({ status: 'failed', exitCode: null, stderr: 'spawn ENOENT\n', result: { ok: false, error: { code: 'execution_failed' } } })
  })

  it('bounds each output stream and preserves final results after truncation', () => {
    const { runner, children } = fakeRunner({ maxOutputBytes: 150 })
    const task = runner.start({ commandId: 'stats' })
    children[0].stdout.write('x'.repeat(1_000))
    children[0].stderr.write('y'.repeat(1_000))
    children[0].stdout.write('\n{"ok":true,"data":{"count":1}}\n')
    children[0].complete()
    const state = runner.get(task.id)!
    expect(Buffer.byteLength(state.stdout)).toBeLessThanOrEqual(150)
    expect(Buffer.byteLength(state.stderr)).toBeLessThanOrEqual(150)
    expect(state).toMatchObject({ truncated: true, result: { ok: true, data: { count: 1 } } })
  })

  it('does not mistake a nested tail object for a complete result after truncation', () => {
    const { runner, children } = fakeRunner({ maxOutputBytes: 55 })
    const task = runner.start({ commandId: 'stats' })
    children[0].stdout.write(JSON.stringify({ ok: true, data: { first: 'x'.repeat(100), nested: { count: 3 } } }, null, 2))
    children[0].complete()
    expect(runner.get(task.id)).toMatchObject({ status: 'succeeded', truncated: true, result: null })
  })

  it('allows local reads during listening while blocking other sessions and local file mutation', () => {
    const { runner, children } = fakeRunner()
    runner.start({ commandId: 'listen' })
    expect(runner.isAccountBusy('work')).toBe(true)
    expect(runner.isAccountBusy('other')).toBe(false)
    expectError(() => runner.start({ commandId: 'whoami' }), 'account_busy', 409)
    expectError(() => runner.start({ commandId: 'purge', arguments: { chat: 'x' }, confirmed: true }), 'account_busy', 409)
    expectError(() => runner.start({ commandId: 'data reset', confirmed: true }), 'account_busy', 409)
    expectError(() => runner.start({ commandId: 'account remove', arguments: { name: 'work' }, options: { force: true }, confirmed: true }), 'account_busy', 409)
    expect(runner.start({ commandId: 'stats' })).toMatchObject({ status: 'running' })
    expect(runner.start({ commandId: 'export', arguments: { chat: 'x' } })).toMatchObject({ status: 'running' })
    expect(runner.start({ commandId: 'whoami', account: 'other' })).toMatchObject({ status: 'running' })
    children[0].complete()
    expect(runner.isAccountBusy('work')).toBe(false)
  })

  it('protects all-account resets and external authentication/session activity', () => {
    const busy = vi.fn((account: string | null) => account === 'work')
    const { runner, calls } = fakeRunner({ isAccountBusy: busy })
    expectError(() => runner.start({ commandId: 'listen' }), 'account_busy', 409)
    expect(runner.start({ commandId: 'stats' }).status).toBe('running')
    expect(calls).toHaveLength(1)
    const other = fakeRunner()
    const reset = other.runner.start({ commandId: 'data reset', options: { allAccounts: true }, confirmed: true })
    expect(reset.account).toBeNull()
    expect(other.runner.isAccountBusy('other')).toBe(true)
    expectError(() => other.runner.start({ commandId: 'stats', account: 'other' }), 'account_busy', 409)
    expectError(() => other.runner.start({ commandId: 'data reset', account: 'work', options: { allAccounts: true }, confirmed: true }), 'invalid_request')
  })

  it('reports external session reservations publicly while preserving safe local reads', () => {
    const isAccountBusy = vi.fn((account: string | null) => account == null || account === 'work')
    const { runner } = fakeRunner({ isAccountBusy })
    expect(runner.isAccountBusy('work')).toBe(true)
    expect(runner.isAccountBusy('other')).toBe(false)
    expect(runner.isAccountBusy()).toBe(true)
    expect(runner.start({ commandId: 'stats' }).status).toBe('running')
    expectError(() => runner.start({ commandId: 'whoami' }), 'account_busy', 409)
    expectError(() => runner.start({ commandId: 'data reset', options: { allAccounts: true }, confirmed: true }), 'account_busy', 409)
  })

  it('keeps account ownership until cancellation finishes and escalates to SIGKILL', async () => {
    const { runner, children } = fakeRunner({ cancelTimeoutMs: 10 })
    const task = runner.start({ commandId: 'listen' })
    children[0].ignoreInterrupt = true
    expect(runner.cancel(task.id)?.status).toBe('running')
    runner.cancel(task.id)
    expect(children[0].signals).toEqual(['SIGINT'])
    expectError(() => runner.start({ commandId: 'whoami' }), 'account_busy', 409)
    await vi.waitFor(() => expect(runner.get(task.id)?.status).toBe('cancelled'))
    expect(children[0].signals).toEqual(['SIGINT', 'SIGKILL'])
    expect(runner.isAccountBusy()).toBe(false)
    expect(runner.cancel('missing')).toBeUndefined()
  })

  it('exchanges ownership passwords once over IPC without placing them in argv, env, or task state', () => {
    const { runner, children, calls } = fakeRunner()
    const password = '  hidden `secret` $(value)  '
    const task = runner.start({ commandId: 'group admin transfer-owner', arguments: { chat: '-1001', user: '@owner' }, options: { ownershipPassword: password }, confirmed: true })
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true })
    children[0].send = send as unknown as typeof children[0]['send']
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc'])
    expect(calls[0].options.env?.TG_DESKTOP_IPC).toBe('1')
    expect(calls[0].args.join(' ')).not.toContain(password)
    expect(JSON.stringify(calls[0].options.env)).not.toContain(password)
    expect(JSON.stringify(runner.get(task.id))).not.toContain(password)
    children[0].emit('message', { type: 'tg-desktop-secret-request', name: 'other' })
    expect(send).not.toHaveBeenCalled()
    children[0].emit('message', { type: 'tg-desktop-secret-request', name: 'ownershipPassword' })
    children[0].emit('message', { type: 'tg-desktop-secret-request', name: 'ownershipPassword' })
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({ type: 'tg-desktop-secret-response', name: 'ownershipPassword', value: password }, expect.any(Function))
    expect(children[0].listenerCount('message')).toBe(0)
    expect(children[0].listenerCount('disconnect')).toBe(0)
  })

  it('requires the ownership password and detaches its IPC listener on cancellation or completion', () => {
    const { runner, children } = fakeRunner()
    const base = { commandId: 'group admin transfer-owner', arguments: { chat: 'x', user: '@owner' }, confirmed: true }
    expectError(() => runner.start(base), 'invalid_request')
    const task = runner.start({ ...base, options: { ownershipPassword: 'secret' } })
    expect(children[0].listenerCount('message')).toBe(1)
    runner.cancel(task.id)
    expect(children[0].listenerCount('message')).toBe(0)
    expect(children[0].listenerCount('disconnect')).toBe(0)
    const next = runner.start({ ...base, options: { ownershipPassword: 'secret' } })
    children[1].complete()
    expect(runner.get(next.id)?.status).toBe('succeeded')
    expect(children[1].listenerCount('message')).toBe(0)
  })

  it('closes every child and prevents later starts', async () => {
    const { runner, children } = fakeRunner({ cancelTimeoutMs: 10 })
    runner.start({ commandId: 'listen' })
    runner.start({ commandId: 'listen', account: 'other' })
    children[0].ignoreInterrupt = true
    const closing = runner.close()
    expect(runner.close()).toBe(closing)
    await closing
    expect(children.map(child => child.signals)).toEqual([['SIGINT', 'SIGKILL'], ['SIGINT']])
    expect(runner.list().every(task => task.status === 'cancelled' && task.finishedAt != null)).toBe(true)
    expectError(() => runner.start({ commandId: 'account list' }), 'runner_closed', 500)
  })

  it('waits for listener readiness and correlates simultaneous composer sends without changing task results', async () => {
    const { runner, calls, children } = fakeRunner()
    const task = runner.start({ commandId: 'listen' })
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true })
    children[0].send = send as unknown as typeof children[0]['send']
    const input = { chat: '-1001', text: '  first message\n', files: ['/tmp/file name.png'], reply: 12, linkPreview: false }
    const first = runner.sendInput(task.id, input)
    expect(send).not.toHaveBeenCalled()
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc'])
    expect(calls[0].options.env?.TG_DESKTOP_IPC).toBe('1')
    children[0].emit('message', { type: 'tg-desktop-listen-ready' })
    const second = runner.sendInput(task.id, { chat: '@other', text: 'second' })
    expect(send).toHaveBeenCalledTimes(2)
    const firstRequest = send.mock.calls[0][0] as { type: string; requestId: string; input: DesktopListenInput }
    const secondRequest = send.mock.calls[1][0] as { requestId: string }
    expect(firstRequest).toMatchObject({ type: 'tg-desktop-listen-send', input })
    children[0].emit('message', { type: 'tg-desktop-listen-result', requestId: 'wrong', result: { ok: true, data: {} } })
    children[0].emit('message', { type: 'tg-desktop-listen-result', requestId: secondRequest.requestId, result: { ok: true, data: { sent: true, msg_id: 2 } } })
    children[0].emit('message', { type: 'tg-desktop-listen-result', requestId: firstRequest.requestId, result: { ok: true, data: { sent: true, msg_id: 1 } } })
    await expect(first).resolves.toEqual({ sent: true, msg_id: 1 })
    await expect(second).resolves.toEqual({ sent: true, msg_id: 2 })
    expect(runner.get(task.id)).toMatchObject({ status: 'running', result: null, stdout: 'sent: message delivered\nsent: message delivered\n' })
    expect(runner.get(task.id)?.stdout).not.toContain(input.text)
    expect(JSON.stringify(runner.get(task.id))).not.toContain(input.files[0])
  })

  it.each([
    {}, { chat: '' }, { chat: '-1001' }, { chat: 'x', text: 1 }, { chat: 'x', text: '\0' },
    { chat: 'x', text: 'a'.repeat(4_097) }, { chat: 'x', files: ['/tmp/path'], reply: 0 },
    { chat: 'x', files: 'file' }, { chat: 'x', files: [''] }, { chat: 'x', text: 'text', linkPreview: 'false' },
    { chat: 'x', text: 'text', environment: { DATA_DIR: '/tmp/path' } },
  ])('rejects invalid listener input before IPC delivery: %j', async input => {
    const { runner, children } = fakeRunner()
    const task = runner.start({ commandId: 'listen' })
    const send = vi.fn()
    children[0].send = send
    children[0].emit('message', { type: 'tg-desktop-listen-ready' })
    await expect(runner.sendInput(task.id, input as DesktopListenInput)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects missing/stopped listeners and pending sends on cancellation, disconnect, and exit', async () => {
    const { runner, children } = fakeRunner()
    await expect(runner.sendInput('missing', { chat: 'x', text: 'text' })).rejects.toMatchObject({ status: 404 })
    const stats = runner.start({ commandId: 'stats' })
    await expect(runner.sendInput(stats.id, { chat: 'x', text: 'text' })).rejects.toMatchObject({ status: 409 })
    children[0].complete()
    for (const reason of ['cancel', 'disconnect', 'close']) {
      const task = runner.start({ commandId: 'listen' })
      const child = children.at(-1)!
      const pending = runner.sendInput(task.id, { chat: 'x', text: 'text' })
      const rejected = expect(pending).rejects.toMatchObject({ status: 409 })
      if (reason === 'cancel') runner.cancel(task.id)
      if (reason === 'close') child.complete()
      if (reason === 'disconnect') child.emit('disconnect')
      await rejected
      if (reason === 'disconnect') {
        await expect(runner.sendInput(task.id, { chat: 'x', text: 'text' })).rejects.toMatchObject({ code: 'listen_unavailable' })
        child.complete()
      }
    }
  })

  it('propagates listener write-access and execution failures with bounded send timeouts', async () => {
    const { runner, children } = fakeRunner({ sendTimeoutMs: 10 })
    const task = runner.start({ commandId: 'listen' })
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true })
    children[0].send = send as unknown as typeof children[0]['send']
    children[0].emit('message', { type: 'tg-desktop-listen-ready' })
    const denied = runner.sendInput(task.id, { chat: 'x', text: 'text' })
    const request = send.mock.calls[0][0] as { requestId: string }
    children[0].emit('message', { type: 'tg-desktop-listen-result', requestId: request.requestId, result: { ok: false, error: { code: 'write_access_disabled', message: 'Enable write access first.' } } })
    await expect(denied).rejects.toMatchObject({ status: 400, code: 'write_access_disabled' })
    await expect(runner.sendInput(task.id, { chat: 'x', text: 'text' })).rejects.toMatchObject({ status: 500, code: 'listen_send_timeout' })
    send.mockImplementation((_message, callback) => { callback(new Error('IPC closed')); return false })
    await expect(runner.sendInput(task.id, { chat: 'x', text: 'text' })).rejects.toMatchObject({ status: 500, code: 'listen_send_failed' })
  })

  it('rejects composer sends during a reconnect gap and resumes after readiness', async () => {
    const { runner, children } = fakeRunner()
    const task = runner.start({ commandId: 'listen' })
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true })
    children[0].send = send as unknown as typeof children[0]['send']
    children[0].emit('message', { type: 'tg-desktop-listen-ready' })
    const pending = runner.sendInput(task.id, { chat: 'x', text: 'text' })
    children[0].emit('message', { type: 'tg-desktop-listen-unready' })
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'listen_unavailable' })
    await expect(runner.sendInput(task.id, { chat: 'x', text: 'text' })).rejects.toMatchObject({ status: 409, code: 'listen_unavailable' })
    children[0].emit('message', { type: 'tg-desktop-listen-ready' })
    const resumed = runner.sendInput(task.id, { chat: 'x', text: 'text' })
    const request = send.mock.calls.at(-1)![0] as { requestId: string }
    children[0].emit('message', { type: 'tg-desktop-listen-result', requestId: request.requestId, result: { ok: true, data: { sent: true } } })
    await expect(resumed).resolves.toEqual({ sent: true })
  })

  it('retains bounded history and returns independent task snapshots', () => {
    const { runner, children } = fakeRunner({ maxTasks: 2 })
    const first = runner.start({ commandId: 'stats' })
    children[0].complete()
    const second = runner.start({ commandId: 'stats' })
    children[1].stdout.write('{"ok":true,"data":{"count":2}}')
    children[1].complete()
    const resultCopy = runner.get(second.id)!.result as { data: { count: number } }
    resultCopy.data.count = 999
    const third = runner.start({ commandId: 'stats' })
    expect(runner.get(first.id)).toBeUndefined()
    expect(runner.list().map(task => task.id)).toEqual([third.id, second.id])
    expect(runner.get(second.id)?.result).toEqual({ ok: true, data: { count: 2 } })
  })

  it('runs the actual source CLI against an isolated registry and preserves business output format', async () => {
    const root = makeRoot()
    const runner = new DesktopTaskRunner({ dataDir: root })
    runners.push(runner)
    const task = runner.start({ commandId: 'account list' })
    await vi.waitFor(() => expect(runner.get(task.id)?.status).toBe('succeeded'), { timeout: 10_000 })
    expect(runner.get(task.id)?.result).toMatchObject({ ok: true, schema_version: '2', data: { accounts: expect.arrayContaining([expect.objectContaining({ name: 'work' })]) } })
    const invalid = runner.start({ commandId: 'export', arguments: { chat: 'x' }, options: { format: 'invalid' } })
    await vi.waitFor(() => expect(runner.get(invalid.id)?.status).toBe('failed'), { timeout: 10_000 })
    expect(runner.get(invalid.id)?.result).toMatchObject({ ok: false, error: { code: expect.any(String) } })
  }, 20_000)

  it('cancels an actual isolated Node child without mutating process globals', async () => {
    const root = makeRoot()
    const entry = join(root, 'listen-fixture.mjs')
    writeFileSync(entry, "process.stdout.write('ready\\n')\nprocess.on('SIGINT', () => { process.stdout.write('stopped\\n'); process.exit(0) })\nsetInterval(() => {}, 1000)\n", 'utf8')
    const runner = new DesktopTaskRunner({ dataDir: root, cliEntry: entry, cancelTimeoutMs: 500 })
    runners.push(runner)
    const task = runner.start({ commandId: 'listen' })
    await vi.waitFor(() => expect(runner.get(task.id)?.stdout).toBe('ready\n'))
    runner.cancel(task.id)
    await vi.waitFor(() => expect(runner.get(task.id)?.status).toBe('cancelled'))
    expect(runner.get(task.id)).toMatchObject({ stdout: 'ready\nstopped\n', exitCode: 0 })
  })

  it('exchanges a password with an actual isolated child and lets the IPC command exit naturally', async () => {
    const root = makeRoot()
    const entry = join(root, 'secret-fixture.mjs')
    const helper = pathToFileURL(join(process.cwd(), 'src/cli/desktop-secret.ts')).href
    writeFileSync(entry, `import { readOwnershipPassword } from ${JSON.stringify(helper)}\nconst value = await readOwnershipPassword()\nprocess.stdout.write(JSON.stringify({ok: value === '  ipc-secret  ', data: {received: true}}) + '\\n')\n`, 'utf8')
    const runner = new DesktopTaskRunner({ dataDir: root, cliEntry: entry, nodeArgs: ['--import', createRequire(import.meta.url).resolve('tsx')] })
    runners.push(runner)
    const task = runner.start({ commandId: 'group admin transfer-owner', arguments: { chat: 'x', user: '@owner' }, options: { ownershipPassword: '  ipc-secret  ' }, confirmed: true })
    await vi.waitFor(() => expect(runner.get(task.id)?.status).toBe('succeeded'), { timeout: 5_000 })
    expect(runner.get(task.id)?.result).toEqual({ ok: true, data: { received: true } })
    expect(JSON.stringify(runner.get(task.id))).not.toContain('ipc-secret')
  })

  it('sends composer input through an actual isolated listener child', async () => {
    const root = makeRoot()
    const entry = join(root, 'listen-send-fixture.mjs')
    writeFileSync(entry, "process.on('message', message => { if (message.type === 'tg-desktop-listen-send') process.send({type:'tg-desktop-listen-result', requestId:message.requestId, result:{ok:true,data:{sent:true,msg_id:12,chat:message.input.chat}}}) })\nprocess.on('SIGINT', () => { process.disconnect(); process.exit(0) })\nprocess.send({type:'tg-desktop-listen-ready'})\n", 'utf8')
    const runner = new DesktopTaskRunner({ dataDir: root, cliEntry: entry })
    runners.push(runner)
    const task = runner.start({ commandId: 'listen' })
    await expect(runner.sendInput(task.id, { chat: '-1001', text: 'exact text' })).resolves.toEqual({ sent: true, msg_id: 12, chat: '-1001' })
    await runner.close()
    expect(runner.get(task.id)?.status).toBe('cancelled')
  })
})
