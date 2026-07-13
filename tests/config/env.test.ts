import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  writeConfiguration,
  writeCredentials,
} from '../../src/config/credential-store.js'
import {
  getConfigPath,
  getDataDir,
  getDbPath,
  getSessionName,
  getSessionPath,
  getTelegramCredentials,
  getTelegramWriteAccess,
  getTelegramProxy,
  getTelegramProxyConfiguration,
} from '../../src/config/env.js'

let tempDirs: string[] = []
const APP_ENV_KEYS = [
  'TG_API_ID',
  'TG_API_HASH',
  'TG_PROXY',
  'TG_SESSION_NAME',
  'DATA_DIR',
  'DB_PATH',
  'OUTPUT',
  'XDG_DATA_HOME',
  'LOCALAPPDATA',
] as const

beforeEach(() => {
  for (const key of APP_ENV_KEYS) {
    vi.stubEnv(key, '')
  }
  vi.stubEnv('DATA_DIR', tempDir())
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
  tempDirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-env-test-'))
  tempDirs.push(dir)
  return dir
}

describe('env config', () => {
  it('prefers a complete environment pair over stored credentials', () => {
    writeCredentials(getConfigPath(), { apiId: 54321, apiHash: 'stored_hash' })
    vi.stubEnv('TG_API_ID', ' 12345 ')
    vi.stubEnv('TG_API_HASH', ' env_hash ')

    expect(getTelegramCredentials()).toEqual({
      apiId: 12345,
      apiHash: 'env_hash',
      source: 'environment',
    })
  })

  it.each([
    ['12345', ''],
    ['', 'env_hash'],
  ])('rejects a partial environment pair even when stored credentials exist', (apiId, apiHash) => {
    writeCredentials(getConfigPath(), { apiId: 54321, apiHash: 'stored_hash' })
    vi.stubEnv('TG_API_ID', apiId)
    vi.stubEnv('TG_API_HASH', apiHash)

    expect(() => getTelegramCredentials()).toThrow(
      'TG_API_ID and TG_API_HASH must be provided together.',
    )
  })

  it('falls back to stored credentials when neither environment variable is set', () => {
    writeCredentials(getConfigPath(), { apiId: 54321, apiHash: 'stored_hash' })

    expect(getTelegramCredentials()).toEqual({
      apiId: 54321,
      apiHash: 'stored_hash',
      source: 'stored',
    })
  })

  it('uses Telegram defaults when neither environment nor stored credentials exist', () => {
    expect(getTelegramCredentials()).toEqual({
      apiId: 2040,
      apiHash: 'b18441a1ff607e10a989891a5462e627',
      source: 'default',
    })
  })

  it('prefers a trimmed environment proxy over the stored proxy', () => {
    writeConfiguration(getConfigPath(), { proxy: 'socks5://stored-proxy' })
    vi.stubEnv('TG_PROXY', ' socks5://environment-proxy ')

    expect(getTelegramProxy()).toBe('socks5://environment-proxy')
  })

  it('falls back to the stored proxy when the environment proxy is empty', () => {
    writeConfiguration(getConfigPath(), { proxy: 'socks5://stored-proxy' })
    vi.stubEnv('TG_PROXY', '   ')

    expect(getTelegramProxy()).toBe('socks5://stored-proxy')
  })

  it('returns undefined when neither environment nor stored proxy exists', () => {
    expect(getTelegramProxy()).toBeUndefined()
  })

  it('reads write-access configuration and defaults to true', () => {
    expect(getTelegramWriteAccess()).toBe(true)

    writeConfiguration(getConfigPath(), { writeAccess: false })
    expect(getTelegramWriteAccess()).toBe(false)
  })

  it('propagates malformed stored configuration when no environment proxy exists', () => {
    writeFileSync(getConfigPath(), '{not json')

    expect(() => getTelegramProxy()).toThrow(
      'Stored Telegram API configuration is invalid.',
    )
  })

  it('reports a trimmed environment proxy and its source', () => {
    writeConfiguration(getConfigPath(), { proxy: 'socks5://stored-proxy' })
    vi.stubEnv('TG_PROXY', ' socks5://environment-proxy ')

    expect(getTelegramProxyConfiguration()).toEqual({
      url: 'socks5://environment-proxy',
      source: 'environment',
    })
  })

  it('reports the stored proxy and its source when the environment proxy is empty', () => {
    writeConfiguration(getConfigPath(), { proxy: 'socks5://stored-proxy' })
    vi.stubEnv('TG_PROXY', '   ')

    expect(getTelegramProxyConfiguration()).toEqual({
      url: 'socks5://stored-proxy',
      source: 'stored',
    })
  })

  it('returns no proxy configuration when neither source exists', () => {
    expect(getTelegramProxyConfiguration()).toBeUndefined()
  })

  it('propagates malformed stored configuration through the source-aware resolver', () => {
    writeFileSync(getConfigPath(), '{not json')

    expect(() => getTelegramProxyConfiguration()).toThrow(
      'Stored Telegram API configuration is invalid.',
    )
  })

  it('uses default API credentials with a proxy-only stored configuration', () => {
    writeConfiguration(getConfigPath(), { proxy: 'socks5://stored-proxy' })

    expect(getTelegramCredentials()).toEqual({
      apiId: 2040,
      apiHash: 'b18441a1ff607e10a989891a5462e627',
      source: 'default',
    })
  })

  it('does not fall back to defaults for malformed stored credentials', () => {
    const path = getConfigPath()
    writeFileSync(path, '{not json')

    expect(() => getTelegramCredentials()).toThrow(
      'Stored Telegram API configuration is invalid.',
    )
  })

  it('does not fall back to defaults for an unreadable stored credential path', () => {
    mkdirSync(getConfigPath())

    expect(() => getTelegramCredentials()).toThrow(
      'Stored Telegram API configuration is invalid.',
    )
  })

  it.each(['abc', '123abc', '0', '-1', '1.5'])(
    'validates environment TG_API_ID=%s through the credential store',
    (value) => {
      vi.stubEnv('TG_API_ID', value)
      vi.stubEnv('TG_API_HASH', 'env_hash')

      expect(() => getTelegramCredentials()).toThrow('API ID must be a positive integer.')
    },
  )

  it('places config.json in DATA_DIR', () => {
    expect(getConfigPath()).toBe(join(getDataDir(), 'config.json'))
  })

  it('creates DATA_DIR from a relative path', () => {
    const relative = `.tmp-tg-cli-env-test-${Date.now()}`
    tempDirs.push(resolve(process.cwd(), relative))
    vi.stubEnv('DATA_DIR', relative)

    expect(getDataDir()).toBe(resolve(process.cwd(), relative))
    expect(existsSync(resolve(process.cwd(), relative))).toBe(true)
  })

  it('creates DB_PATH parent directory', () => {
    const path = join(tempDir(), 'nested', 'messages.db')
    vi.stubEnv('DB_PATH', path)

    expect(getDbPath()).toBe(path)
    expect(existsSync(join(path, '..'))).toBe(true)
  })

  it('places session path under sessions and trims session name', () => {
    const dataDir = tempDir()
    vi.stubEnv('DATA_DIR', dataDir)
    vi.stubEnv('TG_SESSION_NAME', ' custom_session ')

    expect(getSessionName()).toBe('custom_session')
    expect(getSessionPath()).toBe(join(dataDir, 'sessions', 'custom_session'))
  })

  it('uses default session name for whitespace-only TG_SESSION_NAME', () => {
    vi.stubEnv('TG_SESSION_NAME', '   ')

    expect(getSessionName()).toBe('tg_cli')
  })
})
