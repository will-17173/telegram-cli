import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StoredMessageInput } from '../../src/storage/message-db.js'

const renderInteractiveListen = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../src/presenters/ink/listen.js', () => ({ renderInteractiveListen }))

const client = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  listen: vi.fn(async ({ onMessage, signal }: { onMessage: (message: StoredMessageInput) => void; signal: AbortSignal }) => {
    if (!signal.aborted) {
      onMessage(fixtureMessage())
      onMessage(fixtureMessage())
    }
    return 'stopped'
  }),
}))

vi.mock('../../src/telegram/client-factory.js', () => ({
  createTelegramClient: () => client,
}))

import { createApp } from '../../src/cli/app.js'

describe('listen command', () => {
  beforeEach(() => {
    client.close.mockClear()
    client.listen.mockClear()
    renderInteractiveListen.mockClear()
  })

  it('uses the interactive Ink listener in a TTY', async () => {
    const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '-1001'])
    } finally {
      restoreProperty(process.stdin, 'isTTY', stdinIsTty)
      restoreProperty(process.stdout, 'isTTY', stdoutIsTty)
    }

    expect(renderInteractiveListen).toHaveBeenCalledOnce()
    expect(renderInteractiveListen).toHaveBeenCalledWith(expect.objectContaining({
      chats: [-1001],
      sendTo: -1001,
      showMedia: true,
    }))
  })

  it('prints each received message to stdout', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen'])
    } finally {
      write.mockRestore()
    }

    const output = writes.join('')

    expect(client.listen).toHaveBeenCalledOnce()
    expect(output).toContain('Alice')
    expect(output).toContain('Hello from listen')
    expect(output).toContain('────────')
    expect(output.split('Hello from listen\n').length - 1).toBe(1)
    expect(output).toContain('listening completed\n')
  })

  it('shows attached media by default', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen'])
    } finally {
      write.mockRestore()
    }

    const output = writes.join('')

    expect(output).toContain('📎 Photo')
  })

  it('hides attached media when --no-media is enabled', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--no-media'])
    } finally {
      write.mockRestore()
    }

    expect(writes.join('')).not.toContain('📎 Photo')
  })

  it('prints a Telegram media album as one captioned message', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    client.listen.mockImplementationOnce(async ({ onMessage }: { onMessage: (message: StoredMessageInput) => void }) => {
      onMessage(albumMessage(11, ''))
      onMessage(albumMessage(12, 'album caption'))
      return 'stopped'
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen'])
    } finally {
      write.mockRestore()
    }

    const output = writes.join('')
    expect(output.split('Alice\n').length - 1).toBe(1)
    expect(output.split('album caption\n').length - 1).toBe(1)
    expect(output.split('📎 Photo\n').length - 1).toBe(2)
  })

  it('flushes a pending album before waiting to reconnect', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    client.listen
      .mockImplementationOnce(async ({ onMessage }: { onMessage: (message: StoredMessageInput) => void }) => {
        onMessage(albumMessage(21, 'before disconnect'))
        return 'disconnected'
      })
      .mockImplementationOnce(async () => 'stopped')

    try {
      const listening = createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--persist'])
      await vi.advanceTimersByTimeAsync(0)
      expect(writes.join('')).toContain('before disconnect')
      await vi.advanceTimersByTimeAsync(5000)
      await listening
    } finally {
      write.mockRestore()
      vi.useRealTimers()
    }
  })

  it('hides benign mtcute update synchronization warnings', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    client.listen.mockImplementationOnce(async () => {
      process.stdout.write('2026-07-10T07:22:05.655Z [WRN] [updates] error fetching difference for 2470425740: 400 CHANNEL_INVALID\n')
      process.stdout.write('2026-07-10T07:22:05.718Z [WRN] [updates] local pts not available for postponed updateNewChannelMessage (cid = 2470425740), skipping\n')
      process.stdout.write('2026-07-10T07:22:05.719Z [WRN] [updates] pts_before does not match local_pts\n')
      return 'stopped'
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen'])
    } finally {
      write.mockRestore()
    }

    const output = writes.join('')
    expect(output).not.toContain('CHANNEL_INVALID')
    expect(output).not.toContain('local pts not available')
    expect(output).not.toContain('pts_before does not match local_pts')
    expect(output).toContain('listening completed')
  })
})

function restoreProperty(target: NodeJS.ReadStream | NodeJS.WriteStream, key: 'isTTY', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor == null) {
    delete (target as unknown as { isTTY?: boolean }).isTTY
  } else {
    Object.defineProperty(target, key, descriptor)
  }
}

function fixtureMessage(): StoredMessageInput {
  const raw = { _ : 'messageMediaPhoto', photo: { file_name: 'IMG_001.jpg' } }
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: 'Hello from listen',
    timestamp: '2026-03-09T10:03:00.000Z',
    raw_json: raw,
  }
}

function albumMessage(msgId: number, content: string): StoredMessageInput {
  return {
    ...fixtureMessage(),
    msg_id: msgId,
    content,
    raw_json: {
      _: 'message',
      groupedId: { low: 77, high: 0 },
      media: { _: 'messageMediaPhoto', photo: {} },
    },
  }
}
