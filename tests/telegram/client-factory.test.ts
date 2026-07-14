import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeCredentials } from '../../src/config/credential-store.js'
import { getConfigPath } from '../../src/config/env.js'

const telegramClientConstructor = vi.hoisted(() => vi.fn(function MockTelegramClient() {}))
const proxyTransportFromUrl = vi.hoisted(() => vi.fn())

vi.mock('@mtcute/node', () => ({
  TelegramClient: telegramClientConstructor,
  MtPeerNotFoundError: class MtPeerNotFoundError extends Error {},
  proxyTransportFromUrl,
}))

const WARNING = 'warning: using default Telegram API credentials, which have stricter flood limits and may trigger FLOOD_WAIT during frequent or large requests. Run tg config set --api-id <id> --api-hash <hash> to configure your own.\n'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-client-factory-test-'))
  vi.stubEnv('DATA_DIR', dataDir)
  vi.stubEnv('TG_API_ID', '')
  vi.stubEnv('TG_API_HASH', '')
  vi.stubEnv('TG_SESSION_NAME', '')
  vi.stubEnv('TG_PROXY', '')
  telegramClientConstructor.mockClear()
  proxyTransportFromUrl.mockReset()
  vi.resetModules()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dataDir, { force: true, recursive: true })
})

describe('createTelegramClient', () => {
  it('warns on stderr once per day when two clients use default credentials', async () => {
    const { createTelegramClient } = await import('../../src/telegram/client-factory.js')

    const output = captureOutput(() => {
      createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))
      createTelegramClient(join(dataDir, 'accounts', 'bob', 'session'))
    })

    expect(output).toEqual({ stdout: '', stderr: WARNING })
    expect(telegramClientConstructor).toHaveBeenCalledTimes(2)
    expect(telegramClientConstructor).toHaveBeenNthCalledWith(1, {
      apiId: 2040,
      apiHash: 'b18441a1ff607e10a989891a5462e627',
      storage: join(dataDir, 'accounts', 'alice', 'session'),
    })
    expect(telegramClientConstructor).toHaveBeenNthCalledWith(2, {
      apiId: 2040,
      apiHash: 'b18441a1ff607e10a989891a5462e627',
      storage: join(dataDir, 'accounts', 'bob', 'session'),
    })
  })

  it('does not warn again after a process restart on the same day', async () => {
    const firstModule = await import('../../src/telegram/client-factory.js')
    const firstOutput = captureOutput(() => {
      firstModule.createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))
    })

    vi.resetModules()
    const secondModule = await import('../../src/telegram/client-factory.js')
    const secondOutput = captureOutput(() => {
      secondModule.createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))
    })

    expect(firstOutput.stderr).toBe(WARNING)
    expect(secondOutput.stderr).toBe('')
  })

  it('warns again on the next local calendar day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 14, 23, 59))

    const firstModule = await import('../../src/telegram/client-factory.js')
    const firstOutput = captureOutput(() => {
      firstModule.createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))
    })

    vi.setSystemTime(new Date(2026, 6, 15, 0, 1))
    vi.resetModules()
    const secondModule = await import('../../src/telegram/client-factory.js')
    const secondOutput = captureOutput(() => {
      secondModule.createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))
    })

    expect(firstOutput.stderr).toBe(WARNING)
    expect(secondOutput.stderr).toBe(WARNING)
  })

  it('warns on a later call when the first stderr write throws synchronously', async () => {
    const { createTelegramClient } = await import('../../src/telegram/client-factory.js')
    const stderr: string[] = []
    const stderrWrite = vi.spyOn(process.stderr, 'write')
      .mockImplementationOnce(() => {
        throw new Error('stderr unavailable')
      })
      .mockImplementationOnce((chunk) => {
        stderr.push(String(chunk))
        return true
      })

    expect(() => createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))).toThrow('stderr unavailable')
    expect(() => createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))).not.toThrow()

    expect(stderr.join('')).toBe(WARNING)
    expect(stderrWrite).toHaveBeenCalledTimes(2)
    expect(telegramClientConstructor).toHaveBeenCalledOnce()
  })

  it('does not emit a duplicate warning when stderr write reenters the factory', async () => {
    const { createTelegramClient } = await import('../../src/telegram/client-factory.js')
    const stderr: string[] = []
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))
      return true
    })

    createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))

    expect(stderr.join('')).toBe(WARNING)
    expect(stderrWrite).toHaveBeenCalledOnce()
    expect(telegramClientConstructor).toHaveBeenCalledTimes(2)
  })

  it('does not warn and passes environment credentials to mtcute', async () => {
    vi.stubEnv('TG_API_ID', '12345')
    vi.stubEnv('TG_API_HASH', 'environment_hash')
    const { createTelegramClient } = await import('../../src/telegram/client-factory.js')

    const output = captureOutput(() => createTelegramClient(join(dataDir, 'accounts', 'alice', 'session')))

    expect(output).toEqual({ stdout: '', stderr: '' })
    expect(telegramClientConstructor).toHaveBeenCalledOnce()
    expect(telegramClientConstructor).toHaveBeenCalledWith({
      apiId: 12345,
      apiHash: 'environment_hash',
      storage: join(dataDir, 'accounts', 'alice', 'session'),
    })
  })

  it('passes configured proxy transport to mtcute', async () => {
    const transport = { kind: 'proxy-transport' }
    vi.stubEnv('TG_API_ID', '12345')
    vi.stubEnv('TG_API_HASH', 'environment_hash')
    vi.stubEnv('TG_PROXY', 'socks5://127.0.0.1:1080')
    proxyTransportFromUrl.mockReturnValue(transport)
    const { createTelegramClient } = await import('../../src/telegram/client-factory.js')

    createTelegramClient(join(dataDir, 'accounts', 'alice', 'session'))

    expect(proxyTransportFromUrl).toHaveBeenCalledOnce()
    expect(proxyTransportFromUrl).toHaveBeenCalledWith('socks5://127.0.0.1:1080')
    expect(telegramClientConstructor).toHaveBeenCalledWith({
      apiId: 12345,
      apiHash: 'environment_hash',
      storage: join(dataDir, 'accounts', 'alice', 'session'),
      transport,
    })
  })

  it('does not warn and passes stored credentials to mtcute', async () => {
    writeCredentials(getConfigPath(), { apiId: 54321, apiHash: 'stored_hash' })
    const { createTelegramClient } = await import('../../src/telegram/client-factory.js')

    const output = captureOutput(() => createTelegramClient(join(dataDir, 'accounts', 'alice', 'session')))

    expect(output).toEqual({ stdout: '', stderr: '' })
    expect(telegramClientConstructor).toHaveBeenCalledOnce()
    expect(telegramClientConstructor).toHaveBeenCalledWith({
      apiId: 54321,
      apiHash: 'stored_hash',
      storage: join(dataDir, 'accounts', 'alice', 'session'),
    })
  })
})

function captureOutput(action: () => unknown): { stdout: string; stderr: string } {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })

  try {
    action()
  } finally {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }

  return { stdout: stdout.join(''), stderr: stderr.join('') }
}
