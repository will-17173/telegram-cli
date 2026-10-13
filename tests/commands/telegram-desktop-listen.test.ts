import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountDbPath } from '../../src/account/account-presets.js'
import { writeConfiguration } from '../../src/config/credential-store.js'
import { MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'

const client = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  listen: vi.fn(),
  sendMessage: vi.fn(async () => ({ msg_id: 12, sent_message: sentMessage() })),
  sendMedia: vi.fn(),
}))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/presenters/ink/listen.js', () => ({ renderInteractiveListen: vi.fn() }))

import { createApp } from '../../src/cli/app.js'

describe('desktop IPC through the listen command', () => {
  let dataDir: string
  let responses: Array<{ type: string; requestId?: string; result?: { ok: boolean } }>
  let originalSend: PropertyDescriptor | undefined
  let originalConnected: PropertyDescriptor | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-listen-command-ipc-'))
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice', user_id: 42, username: 'alice', phone: '123456789', display_name: 'Alice', auth_state: 'authenticated',
      }],
    }))
    writeConfiguration(join(dataDir, 'config.json'), { writeAccess: true })
    vi.stubEnv('DATA_DIR', dataDir)
    vi.stubEnv('TG_DESKTOP_IPC', '1')
    responses = []
    originalSend = Object.getOwnPropertyDescriptor(process, 'send')
    originalConnected = Object.getOwnPropertyDescriptor(process, 'connected')
    Object.defineProperty(process, 'connected', { configurable: true, value: true })
    Object.defineProperty(process, 'send', { configurable: true, value: (response: typeof responses[number], callback?: (error: Error | null) => void) => {
      responses.push(response)
      callback?.(null)
      return true
    } })
    client.close.mockClear()
    client.sendMessage.mockClear()
    client.listen.mockReset()
    createTelegramClient.mockClear()
    client.listen.mockImplementation(async () => {
      process.emit('message', {
        type: 'tg-desktop-listen-send', requestId: 'desktop-send-1', input: { chat: '100', text: 'sent from desktop', reply: 8 },
      }, undefined)
      await vi.waitFor(() => expect(responses.find((response) => response.requestId === 'desktop-send-1')?.result?.ok).toBe(true))
      return 'stopped'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    restoreProperty('send', originalSend)
    restoreProperty('connected', originalConnected)
    vi.unstubAllEnvs()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('stores sent messages with --save and detaches IPC before client shutdown', async () => {
    const initialMessageListeners = process.listeners('message')
    client.close.mockImplementationOnce(async () => {
      expect(responses.at(-1)?.type).toBe('tg-desktop-listen-unready')
      expect(process.listeners('message')).toEqual(initialMessageListeners)
    })

    await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--no-interactive', '--save'])

    expect(responses[0]?.type).toBe('tg-desktop-listen-ready')
    expect(client.sendMessage).toHaveBeenCalledWith({ chat: 100, message: 'sent from desktop', reply: 8, linkPreview: true })
    expect(client.close).toHaveBeenCalledOnce()
    const db = new MessageDB(accountDbPath(dataDir, 'alice'))
    try {
      expect(db.getMessagesByKeys([{ chatId: 100, msgId: 12 }])[0]?.content).toBe('sent from desktop')
    } finally {
      db.close()
    }
  })

  it('does not store outgoing message content when --save is absent', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--no-interactive'])

    expect(client.sendMessage).toHaveBeenCalledOnce()
    const db = new MessageDB(accountDbPath(dataDir, 'alice'))
    try {
      expect(db.getMessagesByKeys([{ chatId: 100, msgId: 12 }])).toEqual([])
    } finally {
      db.close()
    }
  })

  it('aborts and closes an active listener when the desktop parent disconnects', async () => {
    const originalDisconnectListeners = process.listeners('disconnect')
    let signal: AbortSignal | undefined
    client.listen.mockImplementationOnce(async (options: { signal: AbortSignal }) => {
      signal = options.signal
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      return 'stopped'
    })
    const listening = createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--no-interactive', '--persist'])
    await vi.waitFor(() => expect(client.listen).toHaveBeenCalledOnce())

    try {
      Object.defineProperty(process, 'connected', { configurable: true, value: false })
      process.emit('disconnect')
      await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    } finally {
      process.emit('SIGINT')
      await listening
    }

    expect(client.close).toHaveBeenCalledOnce()
    expect(createTelegramClient).toHaveBeenCalledOnce()
    expect(process.listeners('disconnect')).toEqual(originalDisconnectListeners)
  })

  it.each(['disconnect', 'SIGINT'] as const)('closes a client blocked during connection on %s and awaits the same close promise', async (event) => {
    if (event === 'SIGINT') vi.stubEnv('TG_DESKTOP_IPC', '')
    const originalDisconnectListeners = process.listeners('disconnect')
    let signal: AbortSignal | undefined
    let rejectConnection!: (error: Error) => void
    const connecting = new Promise<void>((_resolve, reject) => { rejectConnection = reject })
    let releaseClose!: () => void
    const closing = new Promise<void>((resolve) => { releaseClose = resolve })
    client.listen.mockImplementationOnce(async (options: { signal: AbortSignal }) => {
      signal = options.signal
      // Model connect/getMe ignoring the signal until the client is destroyed.
      await connecting
      return 'stopped'
    })
    client.close.mockImplementationOnce(async () => {
      rejectConnection(new Error('connection closed'))
      await closing
    })
    let settled = false
    const listening = createApp().exitOverride().parseAsync([
      'node', 'tg', 'listen', '--no-interactive', ...(event === 'disconnect' ? ['--persist'] : []),
    ]).then(() => { settled = true })
    await vi.waitFor(() => expect(client.listen).toHaveBeenCalledOnce())

    try {
      if (event === 'SIGINT') process.emit('SIGINT')
      else {
        Object.defineProperty(process, 'connected', { configurable: true, value: false })
        process.emit('disconnect')
      }
      await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce())
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(signal?.aborted).toBe(true)
      expect(settled).toBe(false)
      expect(createTelegramClient).toHaveBeenCalledOnce()
    } finally {
      rejectConnection(new Error('connection closed'))
      releaseClose()
      await listening
    }

    expect(settled).toBe(true)
    expect(client.close).toHaveBeenCalledOnce()
    expect(getEventListeners(signal!, 'abort')).toEqual([])
    expect(process.listeners('disconnect')).toEqual(originalDisconnectListeners)
  })

  it('removes the per-client abort callback before normal listener shutdown', async () => {
    let signal: AbortSignal | undefined
    client.listen.mockImplementationOnce(async (options: { signal: AbortSignal }) => {
      signal = options.signal
      return 'stopped'
    })
    client.close.mockImplementationOnce(async () => {
      expect(getEventListeners(signal!, 'abort')).toEqual([])
    })

    await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--no-interactive'])

    expect(client.close).toHaveBeenCalledOnce()
  })

  it.each(['SIGINT', 'disconnect'] as const)('exits a long reconnect delay promptly on %s without creating another client', async (event) => {
    vi.useFakeTimers()
    const originalDisconnectListeners = process.listeners('disconnect')
    client.listen.mockResolvedValueOnce('disconnected').mockResolvedValue('stopped')
    let settled = false
    const listening = createApp().exitOverride().parseAsync([
      'node', 'tg', 'listen', '--no-interactive', '--persist', '--retry-seconds', '600',
    ]).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)

    expect(client.close).toHaveBeenCalledOnce()
    expect(responses.at(-1)?.type).toBe('tg-desktop-listen-unready')
    expect(process.listeners('disconnect')).toHaveLength(originalDisconnectListeners.length + 1)
    if (event === 'SIGINT') process.emit('SIGINT')
    else process.emit('disconnect')
    await vi.advanceTimersByTimeAsync(0)
    try {
      expect(settled).toBe(true)
      expect(createTelegramClient).toHaveBeenCalledOnce()
      expect(client.listen).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      if (!settled) {
        process.emit('SIGINT')
        await vi.advanceTimersByTimeAsync(600_000)
      }
      await listening
    }
    expect(process.listeners('disconnect')).toEqual(originalDisconnectListeners)
  })

  it('keeps ordinary CLI listeners running on unrelated process disconnect events', async () => {
    vi.stubEnv('TG_DESKTOP_IPC', '')
    const originalDisconnectListeners = process.listeners('disconnect')
    let signal: AbortSignal | undefined
    client.listen.mockImplementationOnce(async (options: { signal: AbortSignal }) => {
      signal = options.signal
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      return 'stopped'
    })
    const listening = createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--no-interactive'])
    await vi.waitFor(() => expect(client.listen).toHaveBeenCalledOnce())

    try {
      expect(process.listeners('disconnect')).toEqual(originalDisconnectListeners)
      process.emit('disconnect')
      expect(signal?.aborted).toBe(false)
    } finally {
      process.emit('SIGINT')
      await listening
    }
    expect(client.close).toHaveBeenCalledOnce()
  })
})

function sentMessage(): StoredMessageInput {
  return {
    platform: 'telegram', chat_id: 100, chat_name: 'Test chat', msg_id: 12,
    sender_id: 42, sender_name: 'Alice', content: 'sent from desktop', timestamp: '2026-10-13T12:00:00Z',
    reply_to_msg_id: 8, media_group_id: null, raw_json: null, attachments: [],
  }
}

function restoreProperty(key: 'send' | 'connected', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete process[key]
  else Object.defineProperty(process, key, descriptor)
}
