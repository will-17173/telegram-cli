import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachDesktopListenInput } from '../../src/cli/desktop-listen.js'
import { writeConfiguration } from '../../src/config/credential-store.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'
import type { TelegramClientAdapter } from '../../src/telegram/types.js'

type IpcResult = {
  type: string
  requestId?: string
  result?: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }
}

describe('desktop listen input', () => {
  let dataDir: string
  let bus: EventEmitter
  let responses: IpcResult[]
  let controller: AbortController
  let dispose: () => void
  let onSent: ReturnType<typeof vi.fn<(messages: StoredMessageInput[]) => void>>
  let client: Pick<TelegramClientAdapter, 'sendMessage' | 'sendMedia'>
  let originalSend: PropertyDescriptor | undefined
  let originalConnected: PropertyDescriptor | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-desktop-listen-'))
    writeConfiguration(join(dataDir, 'config.json'), { writeAccess: true })
    vi.stubEnv('DATA_DIR', dataDir)
    vi.stubEnv('TG_DESKTOP_IPC', '1')
    bus = new EventEmitter()
    responses = []
    controller = new AbortController()
    dispose = () => undefined
    onSent = vi.fn()
    client = {
      sendMessage: vi.fn(async () => ({ msg_id: 7, sent_message: message(7) })),
      sendMedia: vi.fn(async () => ({ messages: [{ msg_id: 8, sent_message: message(8) }, { msg_id: 9, sent_message: message(9) }] })),
    }
    originalSend = Object.getOwnPropertyDescriptor(process, 'send')
    originalConnected = Object.getOwnPropertyDescriptor(process, 'connected')
    Object.defineProperty(process, 'connected', { configurable: true, value: true, writable: true })
    Object.defineProperty(process, 'send', { configurable: true, value: vi.fn((response: IpcResult, callback?: (error: Error | null) => void) => {
      responses.push(response)
      callback?.(null)
      return true
    }) })
    const originalOn = process.on.bind(process)
    const originalOff = process.off.bind(process)
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'message' || event === 'disconnect') bus.on(event, listener)
      else originalOn(event, listener)
      return process
    }) as typeof process.on)
    vi.spyOn(process, 'off').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'message' || event === 'disconnect') bus.off(event, listener)
      else originalOff(event, listener)
      return process
    }) as typeof process.off)
  })

  afterEach(() => {
    dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    restoreProperty('send', originalSend)
    restoreProperty('connected', originalConnected)
    rmSync(dataDir, { recursive: true, force: true })
  })

  function attach(): void {
    dispose = attachDesktopListenInput(client as TelegramClientAdapter, { signal: controller.signal, onSent })
  }

  function send(input: unknown, requestId = 'request-1'): void {
    bus.emit('message', { type: 'tg-desktop-listen-send', requestId, input })
  }

  async function result(requestId = 'request-1'): Promise<NonNullable<IpcResult['result']>> {
    await vi.waitFor(() => expect(responses.some((response) => response.requestId === requestId)).toBe(true))
    return responses.find((response) => response.requestId === requestId)!.result!
  }

  it('subscribes only in a desktop IPC worker and announces readiness', () => {
    vi.stubEnv('TG_DESKTOP_IPC', '')
    attach()
    expect(bus.listenerCount('message')).toBe(0)
    vi.stubEnv('TG_DESKTOP_IPC', '1')
    Object.defineProperty(process, 'send', { configurable: true, value: undefined })
    attach()
    expect(bus.listenerCount('message')).toBe(0)
    Object.defineProperty(process, 'send', { configurable: true, value: vi.fn() })
    attach()
    expect(bus.listenerCount('message')).toBe(1)
    expect(process.send).toHaveBeenCalledWith({ type: 'tg-desktop-listen-ready' }, expect.any(Function))
  })

  it('sends text and replies through the existing client with the selected preview setting', async () => {
    attach()
    send({ chat: '-100123', text: 'hello there', reply: 3, linkPreview: false })

    expect(await result()).toEqual({ ok: true, data: { sent: true, msg_id: 7, chat: '-100123', reply_to: 3 } })
    expect(client.sendMessage).toHaveBeenCalledWith({ chat: -100123, message: 'hello there', reply: 3, linkPreview: false })
    expect(onSent).toHaveBeenCalledWith([message(7)])
    expect(JSON.stringify(responses)).not.toContain('hello there')
    expect(JSON.stringify(responses)).not.toContain('stored sent message')
  })

  it('sends media captions and replies without shell parsing file names', async () => {
    attach()
    const path = join(dataDir, 'quoted $(never-execute) `file`.txt')
    writeFileSync(path, 'local fixture')
    send({ chat: '@alice', text: 'caption', files: [path], reply: 3 })

    expect(await result()).toEqual({ ok: true, data: {
      sent: true, msg_id: 8, msg_ids: [8, 9], chat: '@alice', files: [path], reply_to: 3,
    } })
    expect(client.sendMedia).toHaveBeenCalledWith({ chat: '@alice', files: [path], caption: 'caption', reply: 3 })
    expect(onSent).toHaveBeenCalledWith([message(8), message(9)])
    expect(JSON.stringify(responses)).not.toContain('caption')
  })

  it('blocks disabled remote writes and rechecks policy for later sends', async () => {
    writeConfiguration(join(dataDir, 'config.json'), { writeAccess: false })
    attach()
    send({ chat: '@alice', text: 'blocked' })

    expect(await result()).toMatchObject({ ok: false, error: { code: 'write_access_disabled' } })
    expect(client.sendMessage).not.toHaveBeenCalled()
    writeConfiguration(join(dataDir, 'config.json'), { writeAccess: true })
    send({ chat: '@alice', text: 'allowed' }, 'request-2')
    expect((await result('request-2')).ok).toBe(true)
    expect(client.sendMessage).toHaveBeenCalledOnce()
  })

  it.each([
    null,
    [],
    { chat: '' , text: 'hello' },
    { chat: '@alice' },
    { chat: '@alice', text: '' },
    { chat: '@alice', text: 42 },
    { chat: '@alice', text: 'x'.repeat(4097) },
    { chat: 'x'.repeat(513), text: 'hello' },
    { chat: '@alice\0', text: 'hello' },
    { chat: '@alice', text: 'hello', reply: 0 },
    { chat: '@alice', text: 'hello', reply: 1.5 },
    { chat: '@alice', text: 'hello', reply: Number.MAX_SAFE_INTEGER + 1 },
    { chat: '@alice', text: 'hello', linkPreview: 'false' },
    { chat: '@alice', files: ['\0'] },
    { chat: '@alice', files: [42] },
    { chat: '@alice', text: 'hello', files: {} },
    { chat: '@alice', text: 'hello', extra: 'unknown' },
  ])('validates hostile or malformed IPC input %#', async (input) => {
    attach()
    send(input)

    expect(await result()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(client.sendMedia).not.toHaveBeenCalled()
  })

  it('rejects non-files and unreadable paths without echoing their contents', async () => {
    attach()
    send({ chat: '@alice', files: [dataDir] })
    expect(await result()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    send({ chat: '@alice', files: [join(dataDir, 'missing-secret-file')] }, 'request-2')
    expect(await result('request-2')).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(JSON.stringify(responses)).not.toContain('missing-secret-file')
    expect(client.sendMedia).not.toHaveBeenCalled()
  })

  it('serializes sends and bounds pending requests', async () => {
    let finishFirst: () => void = () => undefined
    vi.mocked(client.sendMessage).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishFirst = resolve })
      return { msg_id: 7 }
    })
    attach()
    for (let index = 0; index < 33; index++) send({ chat: '@alice', text: String(index) }, `request-${index}`)

    expect(client.sendMessage).toHaveBeenCalledOnce()
    expect(await result('request-32')).toMatchObject({ ok: false, error: { code: 'listen_send_busy' } })
    finishFirst()
    await result('request-31')
    expect(client.sendMessage).toHaveBeenCalledTimes(32)
    expect(vi.mocked(client.sendMessage).mock.calls.map(([input]) => input.message)).toEqual(
      Array.from({ length: 32 }, (_, index) => String(index)),
    )
  })

  it('reports Telegram failures safely and continues accepting requests', async () => {
    vi.mocked(client.sendMessage).mockRejectedValueOnce(new Error('network failure containing private input'))
    attach()
    send({ chat: '@alice', text: 'private input' })

    expect(await result()).toEqual({ ok: false, error: { code: 'telegram_error', message: 'Unable to send the Telegram message.' } })
    expect(JSON.stringify(responses)).not.toContain('private input')
    send({ chat: '@alice', text: 'retry' }, 'request-2')
    expect((await result('request-2')).ok).toBe(true)
  })

  it('reports local saving failure after a successful remote send', async () => {
    onSent.mockImplementationOnce(() => { throw new Error('private local message data') })
    attach()
    send({ chat: '@alice', text: 'hello' })

    expect(await result()).toEqual({ ok: false, error: { code: 'listen_save_failed', message: 'Message sent, but local saving failed.' } })
    expect(client.sendMessage).toHaveBeenCalledOnce()
    expect(JSON.stringify(responses)).not.toContain('private local message data')
  })

  it.each(['dispose', 'abort', 'disconnect'] as const)('ends pending sends and removes listeners on %s', async (action) => {
    let finish: () => void = () => undefined
    vi.mocked(client.sendMessage).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { msg_id: 7, sent_message: message(7) }
    })
    attach()
    send({ chat: '@alice', text: 'first' })
    send({ chat: '@alice', text: 'queued' }, 'request-2')
    if (action === 'dispose') dispose()
    else if (action === 'abort') controller.abort()
    else bus.emit('disconnect')

    const code = action === 'disconnect' ? 'listen_disconnected' : 'listen_stopping'
    expect(await result()).toMatchObject({ ok: false, error: { code } })
    expect(await result('request-2')).toMatchObject({ ok: false, error: { code } })
    expect(bus.listenerCount('message')).toBe(0)
    expect(bus.listenerCount('disconnect')).toBe(0)
    finish()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(responses.filter((response) => response.requestId === 'request-1')).toHaveLength(1)
    expect(onSent).not.toHaveBeenCalled()
    expect(client.sendMessage).toHaveBeenCalledOnce()
  })

  it('ignores unrelated and uncorrelatable IPC messages', () => {
    attach()
    bus.emit('message', { type: 'other-message' })
    bus.emit('message', { type: 'tg-desktop-listen-send', input: { chat: '@alice', text: 'missing ID' } })

    expect(responses).toEqual([{ type: 'tg-desktop-listen-ready' }])
    expect(client.sendMessage).not.toHaveBeenCalled()
  })
})

function message(id: number): StoredMessageInput {
  return {
    platform: 'telegram', chat_id: 100, chat_name: 'Test chat', msg_id: id,
    sender_id: 42, sender_name: 'Alice', content: 'stored sent message', timestamp: '2026-10-13T12:00:00Z',
    reply_to_msg_id: null, media_group_id: null, raw_json: null, attachments: [],
  }
}

function restoreProperty(key: 'send' | 'connected', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete process[key]
  else Object.defineProperty(process, key, descriptor)
}
