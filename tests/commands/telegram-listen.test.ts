import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StoredMessageInput } from '../../src/storage/message-db.js'
import type { DownloadMessageMediaOptions } from '../../src/telegram/types.js'

const renderInteractiveListen = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, homedir: () => process.env.DATA_DIR ?? original.homedir() }
})

vi.mock('../../src/presenters/ink/listen.js', () => ({ renderInteractiveListen }))

const client = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  downloadMessageMedia: vi.fn(async ({ destination }: DownloadMessageMediaOptions) => {
    writeFileSync(destination, 'downloaded')
  }),
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

function seedAccount(dataDir: string): void {
  const registryPath = join(dataDir, 'accounts.json')
  writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    current_account: 'alice',
    accounts: [
      {
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
      },
    ],
  }, null, 2)}\n`)
}

describe('listen command', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-listen-'))
    seedAccount(dataDir)
    vi.stubEnv('DATA_DIR', dataDir)
    client.close.mockClear()
    client.downloadMessageMedia.mockClear()
    client.downloadMessageMedia.mockImplementation(async ({ destination }: DownloadMessageMediaOptions) => {
      writeFileSync(destination, 'downloaded')
    })
    client.listen.mockReset()
    client.listen.mockImplementation(async ({ onMessage, signal }: { onMessage: (message: StoredMessageInput) => void; signal: AbortSignal }) => {
      if (!signal.aborted) {
        onMessage(fixtureMessage())
        onMessage(fixtureMessage())
      }
      return 'stopped'
    })
    renderInteractiveListen.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (dataDir) rmSync(dataDir, { force: true, recursive: true })
    dataDir = ''
    delete process.env.DATA_DIR
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

  it('passes --auto-download to the interactive listener', async () => {
    const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--auto-download'])
    } finally {
      restoreProperty(process.stdin, 'isTTY', stdinIsTty)
      restoreProperty(process.stdout, 'isTTY', stdoutIsTty)
    }

    expect(renderInteractiveListen).toHaveBeenCalledWith(expect.objectContaining({ autoDownload: true }))
  })

  it('downloads media in plain mode even when its summary is hidden', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--auto-download', '--no-media'])
    } finally {
      write.mockRestore()
    }

    expect(client.downloadMessageMedia).toHaveBeenCalledOnce()
    const output = writes.join('')
    expect(output).not.toContain('📎 Photo')
    expect(output).toContain(`downloaded: ${join(dataDir, 'Downloads', 'telegram-cli', 'IMG_001.jpg')}\n`)
    expect(output).not.toMatch(/Downloading|%|queued/)
  })

  it('does not download media unless --auto-download is present', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'listen'])

    expect(client.downloadMessageMedia).not.toHaveBeenCalled()
  })

  it('prints download failures without stopping the listener', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    client.downloadMessageMedia.mockImplementation(async ({ msgId, destination }: DownloadMessageMediaOptions) => {
      if (msgId === 1) throw new Error('network unavailable')
      writeFileSync(destination, 'downloaded')
    })
    client.listen.mockImplementationOnce(async ({ onMessage }: { onMessage: (message: StoredMessageInput) => void }) => {
      onMessage({ ...fixtureMessage(), raw_json: { _: 'messageMediaPhoto', photo: { file_name: 'first.jpg' } } })
      onMessage({ ...fixtureMessage(), msg_id: 2, raw_json: { _: 'messageMediaPhoto', photo: { file_name: 'second.jpg' } } })
      return 'stopped'
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--auto-download'])
    } finally {
      write.mockRestore()
    }

    const output = writes.join('')
    expect(client.downloadMessageMedia).toHaveBeenCalledTimes(2)
    expect(output).toContain('download failed: 100:1: network unavailable\n')
    expect(output).toContain(`downloaded: ${join(dataDir, 'Downloads', 'telegram-cli', 'second.jpg')}\n`)
    expect(output).toContain('listening completed\n')
    expect(output).not.toMatch(/Downloading|%|queued/)
  })

  it('closes the client immediately when listening is aborted', async () => {
    let finishDownload: () => void = () => undefined
    client.downloadMessageMedia.mockImplementationOnce(async ({ destination }: DownloadMessageMediaOptions) => {
      await new Promise<void>((resolve) => { finishDownload = resolve })
      writeFileSync(destination, 'downloaded')
    })
    client.listen.mockImplementationOnce(async ({ onMessage }: { onMessage: (message: StoredMessageInput) => void }) => {
      onMessage(fixtureMessage())
      process.emit('SIGINT')
      return 'stopped'
    })

    const listening = createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--auto-download'])
    await vi.waitFor(() => expect(client.downloadMessageMedia).toHaveBeenCalledOnce())

    expect(client.close).toHaveBeenCalledOnce()
    finishDownload()
    await listening
    const downloadDir = join(dataDir, 'Downloads', 'telegram-cli')
    await vi.waitFor(() => {
      expect(existsSync(join(downloadDir, 'IMG_001.jpg'))).toBe(true)
      expect(readdirSync(downloadDir).some((entry) => entry.endsWith('.part'))).toBe(false)
    })
  })

  it('downloads every message in an album', async () => {
    client.listen.mockImplementationOnce(async ({ onMessage }: { onMessage: (message: StoredMessageInput) => void }) => {
      onMessage(albumMessage(11, ''))
      onMessage(albumMessage(12, 'album caption'))
      return 'stopped'
    })

    await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--auto-download'])

    expect(client.downloadMessageMedia).toHaveBeenCalledTimes(2)
    expect(client.downloadMessageMedia.mock.calls.map(([options]) => options.msgId).sort((a, b) => a - b)).toEqual([11, 12])
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
    expect(output).toContain('TestGroup')
    expect(output).toContain('Hello from listen')
    expect(output).toContain('────────')
    expect(output.split('Hello from listen\n').length - 1).toBe(1)
    expect(output).toContain('listening completed\n')
  })

  it('omits chat names when a specific chat is provided', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '-1001'])
    } finally {
      write.mockRestore()
    }

    const output = writes.join('')

    expect(output).toContain('Alice')
    expect(output).toContain('Hello from listen')
    expect(output).not.toContain('TestGroup')
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
