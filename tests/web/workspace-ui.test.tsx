import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDesktopCommands } from '../../src/web/command-catalog.js'
import type { DesktopCommand, DesktopField, DesktopTask } from '../../src/web/workspace-types.js'
import { Accounts, AuthenticationForm, authInputAttributes, authRetryAccount, isAuthActive } from '../../web/src/Accounts.js'
import { OperationFields } from '../../web/src/Workspace.js'
import { ListenComposer, listenDefaultChat, listenInput } from '../../web/src/ListenComposer.js'
import {
  boundedTask,
  clearSecretValues,
  createOperationDraft,
  operationInput,
  pathSelectionKind,
  taskSummary,
} from '../../web/src/workspace-form.js'
import { commandLabel, hasCommandTranslation } from '../../web/src/workspace-i18n.js'
import { StructuredResult, TaskResult, copyTaskResult, resultExportFile, resultMarkdown, resultPaths, saveTaskResult, taskResultError, unwrapTaskResult } from '../../web/src/workspace-result.js'

const stringField = (name: string, extra: Partial<DesktopField> = {}): DesktopField => ({ name, description: '', required: false, variadic: false, kind: 'string', ...extra })
const command = (extra: Partial<DesktopCommand> = {}): DesktopCommand => ({
  id: 'send', path: ['send'], category: 'telegram', description: 'Send a message',
  arguments: [stringField('chat', { required: true }), stringField('message')],
  options: [stringField('file', { repeatable: true, defaultValue: [] }), { name: 'preview', description: '', required: false, variadic: false, kind: 'boolean', negated: true, defaultValue: true }],
  requiresAccount: true, destructive: false, longRunning: false,
  ...extra,
})
const task = (extra: Partial<DesktopTask> = {}): DesktopTask => ({
  id: 'task-1', commandId: 'send', account: 'work', status: 'succeeded', startedAt: '2026-10-13T08:00:00Z', finishedAt: '2026-10-13T08:00:01Z', exitCode: 0,
  stdout: '', stderr: '', result: { ok: true, data: { sent: true } }, truncated: false,
  ...extra,
})
const noop = () => {}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('desktop operation forms', () => {
  it('preserves message newlines, repeated file paths, and a disabled negated option', () => {
    const definition = command()
    const draft = createOperationDraft(definition, '@team')
    expect(draft['option:preview']).toBe(true)
    const { input, errors } = operationInput(definition, {
      ...draft, 'argument:message': ' First line\nSecond line\n',
      'option:file': ['/tmp/a file.txt', '/tmp/图片.png'], 'option:preview': false,
    }, 'work')
    expect(errors).toEqual({})
    expect(input).toEqual({
      commandId: 'send', account: 'work', arguments: { chat: '@team', message: ' First line\nSecond line\n' },
      options: { file: ['/tmp/a file.txt', '/tmp/图片.png'], preview: false },
    })
  })

  it('keeps each variadic text row intact rather than splitting it into lines or words', () => {
    const definition = command({ id: 'group chat description', path: ['group', 'chat', 'description'], arguments: [stringField('chat', { required: true }), stringField('text', { required: true, variadic: true })], options: [] })
    const { input } = operationInput(definition, { 'argument:chat': '@team', 'argument:text': [' Two words\nnext line ', '', 'another paragraph'] }, 'work')
    expect(input.arguments?.text).toEqual([' Two words\nnext line ', 'another paragraph'])
  })

  it('requires account, inputs, confirmation, and the exact-title field even when Commander marks it optional', () => {
    const definition = command({ id: 'group chat delete', path: ['group', 'chat', 'delete'], destructive: true, options: [stringField('confirmTitle'), { name: 'yes', description: '', kind: 'boolean', required: false, variadic: false }] })
    const first = operationInput(definition, createOperationDraft(definition), '')
    expect(first.errors).toEqual({ 'argument:chat': 'required', 'option:confirmTitle': 'required', account: 'required', confirmation: 'confirmation' })
    const next = operationInput(definition, { 'argument:chat': '@team', 'option:confirmTitle': ' Team title ', 'option:yes': false }, 'work', true)
    expect(next.errors).toEqual({})
    expect(next.input.confirmed).toBe(true)
    expect(next.input.options).toEqual({ confirmTitle: ' Team title ' })
  })

  it('omits account selection for an all-account reset but retains it for a single account', () => {
    const definition = command({ id: 'data reset', path: ['data', 'reset'], destructive: true, arguments: [], options: [{ name: 'allAccounts', description: '', kind: 'boolean', required: false, variadic: false }] })
    const all = operationInput(definition, { 'option:allAccounts': true }, '', true)
    expect(all.errors).toEqual({})
    expect(all.input.account).toBeUndefined()
    expect(operationInput(definition, { 'option:allAccounts': true }, 'work', true).input.account).toBeUndefined()
    expect(operationInput(definition, { 'option:allAccounts': false }, '', true).errors.account).toBe('required')
  })

  it('clears secrets after submission without altering the payload or other draft values', () => {
    const definition = command({ id: 'config set', path: ['config', 'set'], requiresAccount: false, arguments: [], options: [stringField('apiId'), stringField('apiHash'), stringField('proxy')] })
    const draft = { 'option:apiId': '123', 'option:apiHash': 'hash-value', 'option:proxy': 'socks://user:secret@proxy' }
    const sent = operationInput(definition, draft, '')
    expect(clearSecretValues(definition, draft)).toEqual({ 'option:apiId': '123', 'option:apiHash': '', 'option:proxy': '' })
    expect(sent.input.options?.apiHash).toBe('hash-value')
    expect(draft['option:proxy']).toContain('secret')
  })

  it('masks, requires, and clears the ownership-transfer password without rendering it in task history', () => {
    const definition = command({ id: 'group admin transfer-owner', path: ['group', 'admin', 'transfer-owner'], destructive: true, options: [stringField('ownershipPassword', { required: true, description: 'Telegram 2FA password' })] })
    const draft = { ...createOperationDraft(definition, '@team'), 'option:ownershipPassword': 'one-use-password' }
    expect(operationInput(definition, draft, 'work', true).input.options?.ownershipPassword).toBe('one-use-password')
    expect(clearSecretValues(definition, draft)['option:ownershipPassword']).toBe('')
    const html = renderToStaticMarkup(<OperationFields command={definition} draft={clearSecretValues(definition, draft)} locale="zh-CN" onChange={noop} />)
    expect(html).toContain('Telegram 两步验证密码')
    expect(html).toContain('type="password"')
    expect(html).not.toContain('one-use-password')
  })

  it('renders visible labels, repeated rows, multiline text, inline errors, and masked settings', () => {
    const definition = command({ arguments: [stringField('chat', { required: true }), stringField('text', { required: true, variadic: true })], options: [stringField('apiHash')] })
    const html = renderToStaticMarkup(<OperationFields command={definition} draft={{ 'argument:chat': '', 'argument:text': ['a\nb', 'c'], 'option:apiHash': '' }} errors={{ 'argument:chat': 'required' }} locale="zh-CN" onChange={noop} />)
    expect(html).toContain('聊天')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('请填写此项')
    expect(html).toContain('<textarea')
    expect(html).toContain('a\nb')
    expect(html).toContain('文本 2')
    expect(html).toContain('type="password"')
    expect(html).toContain('高级选项')
  })

  it('uses native picker kinds while retaining manually entered paths', () => {
    expect(pathSelectionKind(command(), stringField('file', { repeatable: true }))).toBe('files')
    expect(pathSelectionKind(command({ path: ['archive'] }), stringField('output'))).toBe('directory')
    expect(pathSelectionKind(command({ path: ['export'] }), stringField('output'))).toBe('save')
    const html = renderToStaticMarkup(<OperationFields command={command()} draft={createOperationDraft(command())} locale="en" onChange={noop} />)
    expect(html).toContain('Enter a path on this computer.')
    expect(html).not.toContain('Choose files')
  })

  it('localizes every currently registered operation in both languages', () => {
    for (const definition of getDesktopCommands()) {
      for (const part of definition.path) expect(hasCommandTranslation(part), `${definition.id}: ${part}`).toBe(true)
      expect(commandLabel(definition, 'zh-CN')).not.toEqual(commandLabel(definition, 'en'))
    }
  })
})

describe('desktop task results', () => {
  it('unwraps successful CLI envelopes and retains structured errors', () => {
    expect(unwrapTaskResult({ ok: true, schema_version: '2', data: [1, 2] })).toEqual([1, 2])
    expect(unwrapTaskResult({ sent: 1 })).toEqual({ sent: 1 })
    expect(taskResultError({ ok: false, error: { code: 'account_busy', message: 'Another task is running', details: { task: 'task-1' } } })).toEqual({ code: 'account_busy', message: 'Another task is running', details: { task: 'task-1' } })
  })

  it('renders heterogeneous tables and nested details with bounded visible rows', () => {
    const data = Array.from({ length: 102 }, (_, id) => id === 1 ? { id, extra: 'extra column' } : { id, message: 'two\nlines', nested: { name: 'Team' } })
    const html = renderToStaticMarkup(<StructuredResult data={data} locale="en" />)
    expect(html).toContain('<table')
    expect(html).toContain('scope="col">extra')
    expect(html).toContain('<dt>name</dt>')
    expect(html).toContain('Showing the first 100 items')
    expect(html).not.toContain('>101<')
  })

  it('bounds log memory and stores only metadata in the task history', () => {
    const original = task({ stdout: 'x'.repeat(80_000), stderr: 'y'.repeat(90_000) })
    const bounded = boundedTask(original)
    expect(bounded.stdout).toHaveLength(64_000)
    expect(bounded.stderr).toHaveLength(64_000)
    expect(bounded.truncated).toBe(true)
    expect(taskSummary(original)).not.toHaveProperty('stdout')
    expect(taskSummary(original)).not.toHaveProperty('result')
    expect(original.stdout).toHaveLength(80_000)
  })

  it('exports Markdown without losing table cells or line breaks', () => {
    expect(resultMarkdown({ ok: true, data: [{ name: 'A|B', text: 'line 1\nline 2' }] })).toContain('| A\\|B | line 1<br>line 2 |')
    expect(resultPaths({ output: '/tmp/a folder', nested: { file_path: '/tmp/file' }, remote: 'https://example.com' })).toEqual(['/tmp/a folder', '/tmp/file'])
  })

  it('shows errors, live diagnostics, and a cancellation control for running tasks', () => {
    const html = renderToStaticMarkup(<TaskResult task={task({ status: 'running', finishedAt: null, exitCode: null, result: { ok: false, error: { code: 'invalid_chat', message: 'Choose a chat' } }, stderr: 'retrying' })} locale="en" onCancel={noop} />)
    expect(html).toContain('Cancel task')
    expect(html).toContain('invalid_chat')
    expect(html).toContain('Choose a chat')
    expect(html).toContain('retrying')
    expect(html).toContain('role="alert"')
  })
})

describe('desktop account authentication', () => {
  it('retains the requested account when retrying a recovered reauthentication session', () => {
    expect(authRetryAccount({ id: 'recovered', status: 'error', requestedAccount: 'work' })).toBe('work')
    expect(authRetryAccount({ id: 'recovered', status: 'cancelled', requestedAccount: 'work' }, 'personal')).toBe('work')
    expect(authRetryAccount({ id: 'new-account', status: 'error' })).toBeUndefined()
    expect(authRetryAccount({ id: 'legacy-session', status: 'error' }, 'work')).toBe('work')
  })
  it('allows pasting codes and using password managers with a labelled credential field', () => {
    expect(authInputAttributes('password')).toEqual({ type: 'password', autoComplete: 'current-password', inputMode: 'text' })
    expect(authInputAttributes('code').autoComplete).toBe('one-time-code')
    const html = renderToStaticMarkup(<AuthenticationForm session={{ id: 'auth-1', status: 'password', hint: 'Password hint' }} locale="en" value="" busy={false} error="" onValueChange={noop} onSubmit={noop} onCancel={noop} onRestart={noop} />)
    expect(html).toContain('for="account-auth-value"')
    expect(html).toContain('type="password"')
    expect(html).toContain('autoComplete="current-password"')
    expect(html).toContain('Password hint')
    expect(html).toContain('Cancel')
  })

  it('shows recoverable authentication errors, working state, and terminal restart actions', () => {
    expect(isAuthActive({ id: 'auth-1', status: 'code' })).toBe(true)
    expect(isAuthActive({ id: 'auth-1', status: 'done' })).toBe(false)
    const html = renderToStaticMarkup(<AuthenticationForm session={{ id: 'auth-1', status: 'error', error: { code: 'invalid_password', message: 'Try again' } }} locale="zh-CN" value="" busy={false} error="" onValueChange={noop} onSubmit={noop} onCancel={noop} onRestart={noop} />)
    expect(html).toContain('invalid_password')
    expect(html).toContain('重新登录')
    const working = renderToStaticMarkup(<AuthenticationForm session={{ id: 'auth-1', status: 'working' }} locale="en" value="" busy={false} error="" onValueChange={noop} onSubmit={noop} onCancel={noop} onRestart={noop} />)
    expect(working).toContain('role="status"')
    expect(working).not.toContain('id="account-auth-value"')
  })

  it('renders empty-account onboarding and a settings affordance', () => {
    const html = renderToStaticMarkup(<Accounts accounts={{ current_account: null, accounts: [] }} account="" locale="en" onAccountsChanged={noop} onSelectAccount={noop} onOpenOperation={noop} />)
    expect(html).toContain('Connect your first Telegram account')
    expect(html).toContain('Add account')
    expect(html).toContain('Configure API and proxy')
  })
})

describe('desktop result export and clipboard', () => {
  it('serializes complete CLI envelopes and plain listener logs for export', async () => {
    const data = task({ result: { ok: true, data: [{ name: '团队', text: 'first\nsecond' }] } })
    const json = await resultExportFile(data, 'json')
    expect(json.filename).toBe('tg-send-task-1.json')
    expect(JSON.parse(json.text)).toEqual(data.result)
    const yaml = await resultExportFile(data, 'yaml')
    expect(yaml.filename).toBe('tg-send-task-1.yaml')
    expect(yaml.text).toContain('团队')
    const markdown = await resultExportFile(data, 'md')
    expect(markdown.text).toContain('first<br>second')
    const plain = await resultExportFile(task({ result: null, stdout: 'incoming\nmessage', stderr: 'notice' }), 'json')
    expect(JSON.parse(plain.text)).toMatchObject({ stdout: 'incoming\nmessage', stderr: 'notice' })
  })

  it('uses native UTF-8 save for every export format without creating blob links', async () => {
    const invoke = vi.fn().mockResolvedValue('/tmp/结果 files.json')
    const createElement = vi.fn()
    vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
    vi.stubGlobal('document', { createElement })
    const data = task({ result: { ok: true, data: { message: '中文\nsecond line' } } })
    for (const format of ['json', 'yaml', 'md'] as const) await expect(saveTaskResult(data, format)).resolves.toBe('/tmp/结果 files.json')
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['save_text', 'save_text', 'save_text'])
    expect(invoke.mock.calls[0]?.[1]).toEqual({ filename: 'tg-send-task-1.json', text: JSON.stringify(data.result, null, 2) })
    expect(invoke.mock.calls[1]?.[1].filename).toBe('tg-send-task-1.yaml')
    expect(invoke.mock.calls[2]?.[1].filename).toBe('tg-send-task-1.md')
    expect(createElement).not.toHaveBeenCalled()
  })

  it('preserves native cancellation and surfaces write errors', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Cannot write destination'))
    vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
    await expect(saveTaskResult(task(), 'json')).resolves.toBeNull()
    await expect(saveTaskResult(task(), 'json')).rejects.toThrow('Cannot write destination')
  })

  it('copies through the native clipboard without requiring browser clipboard support', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
    vi.stubGlobal('navigator', {})
    await copyTaskResult(task())
    expect(invoke).toHaveBeenCalledWith('copy_text', { text: JSON.stringify(task().result, null, 2) })
  })

  it('keeps browser clipboard and blob-download behavior outside native mode', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    const append = vi.fn()
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('document', { createElement: vi.fn().mockReturnValue(link), body: { append } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export-result')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(noop)
    await copyTaskResult(task())
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(task().result, null, 2))
    await expect(saveTaskResult(task(), 'json')).resolves.toBeNull()
    expect(link.href).toBe('blob:export-result')
    expect(link.download).toBe('tg-send-task-1.json')
    expect(append).toHaveBeenCalledWith(link)
    expect(link.click).toHaveBeenCalledOnce()
    expect(link.remove).toHaveBeenCalledOnce()
    vi.runOnlyPendingTimers()
    expect(revoke).toHaveBeenCalledWith('blob:export-result')
  })

  it('labels native exports as saves and browser exports as downloads', () => {
    vi.stubGlobal('window', { __TAURI__: { core: { invoke: vi.fn() } } })
    const native = renderToStaticMarkup(<TaskResult task={task()} locale="en" />)
    expect(native).toContain('Save JSON')
    expect(native).not.toContain('Download JSON')
    vi.stubGlobal('window', {})
    const browser = renderToStaticMarkup(<TaskResult task={task()} locale="zh-CN" />)
    expect(browser).toContain('下载 JSON')
    expect(browser).not.toContain('保存 JSON')
  })
})

describe('live listener composer', () => {
  it('chooses an explicit sending target or a sole listening chat and preserves message text', () => {
    expect(listenDefaultChat({ 'option:sendTo': '@outgoing', 'argument:chats': ['@incoming'] })).toBe('@outgoing')
    expect(listenDefaultChat({ 'argument:chats': ['@incoming', ''] })).toBe('@incoming')
    expect(listenDefaultChat({ 'argument:chats': ['@one', '@two'] })).toBe('')
    const built = listenInput({ chat: '@team', text: ' line 1\nline 2 ', files: ['/tmp/a file', ''], reply: '42', linkPreview: false })
    expect(built.errors).toEqual({})
    expect(built.input).toEqual({ chat: '@team', text: ' line 1\nline 2 ', files: ['/tmp/a file'], reply: 42, linkPreview: false })
  })

  it('allows attachments without text and rejects missing content and unsafe reply IDs', () => {
    expect(listenInput({ chat: '@team', text: '', files: ['/tmp/file'], reply: '', linkPreview: true }).errors).toEqual({})
    expect(listenInput({ chat: '', text: '', files: [''], reply: '9007199254740992', linkPreview: true }).errors).toEqual({ chat: 'required', text: 'content', reply: 'reply' })
    expect(listenInput({ chat: '@team', text: 'hello', files: [], reply: '-1', linkPreview: true }).errors.reply).toBe('reply')
  })

  it('renders the composer only for running listener tasks and keeps manual paths available', () => {
    const live = renderToStaticMarkup(<TaskResult task={task({ commandId: 'listen', status: 'running', result: null })} locale="en" listenChat="@team" />)
    expect(live).toContain('Send while listening')
    expect(live).toContain('value="@team"')
    expect(live).toContain('Reply and attachments')
    expect(live).toContain('Enter a path on this computer.')
    const finished = renderToStaticMarkup(<TaskResult task={task({ commandId: 'listen' })} locale="en" />)
    expect(finished).not.toContain('Send while listening')
    const chinese = renderToStaticMarkup(<ListenComposer taskId="listen-1" locale="zh-CN" />)
    expect(chinese).toContain('监听时发送消息')
    expect(chinese).toContain('发送消息')
  })
})
