import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeCredentials } from '../../src/config/credential-store.js'
import { getConfigPath } from '../../src/config/env.js'

const telegramClientConstructor = vi.hoisted(() => vi.fn(function MockTelegramClient() {}))

vi.mock('@mtcute/node', () => ({
  TelegramClient: telegramClientConstructor,
  MtPeerNotFoundError: class MtPeerNotFoundError extends Error {},
}))

const WARNING = 'warning: using default Telegram API credentials. Run tg config set --api-id <id> --api-hash <hash> to configure your own.\n'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-client-factory-test-'))
  vi.stubEnv('DATA_DIR', dataDir)
  vi.stubEnv('TG_API_ID', '')
  vi.stubEnv('TG_API_HASH', '')
  vi.stubEnv('TG_SESSION_NAME', '')
  telegramClientConstructor.mockClear()
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dataDir, { force: true, recursive: true })
})

describe('createTelegramClient', () => {
  it('warns on stderr once per process when two clients use default credentials', async () => {
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
