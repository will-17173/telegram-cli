import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const factories = vi.hoisted(() => ({
  create: vi.fn(),
  proxy: vi.fn(),
}))

vi.mock('@mtcute/node', () => ({
  BaseSqliteStorageDriver: class {},
  BaseSqliteStorage: class { constructor(_driver: unknown) {} },
  TelegramClient: function (options: unknown) { factories.create(options) },
  proxyTransportFromUrl: factories.proxy,
}))

import { createAccountAuthClient } from '../../src/account/account-authenticator.js'
import { getConfigPath } from '../../src/config/env.js'
import { writeConfiguration } from '../../src/config/credential-store.js'

describe('scoped account authentication clients', () => {
  const directories: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it('uses the requested data directory credentials and proxy without mutating process configuration', () => {
    const environmentDir = mkdtempSync(join(tmpdir(), 'tg-auth-env-'))
    const scopedDir = mkdtempSync(join(tmpdir(), 'tg-auth-scoped-'))
    directories.push(environmentDir, scopedDir)
    vi.stubEnv('DATA_DIR', environmentDir)
    vi.stubEnv('TG_API_ID', '')
    vi.stubEnv('TG_API_HASH', '')
    vi.stubEnv('TG_PROXY', '')
    writeConfiguration(getConfigPath(environmentDir), {
      credentials: { apiId: 111, apiHash: 'other_hash' }, proxy: 'socks5://other-proxy',
    })
    writeConfiguration(getConfigPath(scopedDir), {
      credentials: { apiId: 222, apiHash: 'scoped_hash' }, proxy: 'socks5://scoped-proxy',
    })
    const transport = () => undefined
    factories.proxy.mockReturnValue(transport)
    const sessionPath = join(scopedDir, 'staged-session')

    createAccountAuthClient(sessionPath, scopedDir)

    expect(factories.create).toHaveBeenCalledWith(expect.objectContaining({
      apiId: 222,
      apiHash: 'scoped_hash',
      storage: expect.objectContaining({ filename: sessionPath }),
      transport,
      logLevel: 0,
      disableUpdates: true,
    }))
    expect(factories.proxy).toHaveBeenCalledWith('socks5://scoped-proxy')
    expect(process.env.DATA_DIR).toBe(environmentDir)
    expect(process.env.TG_API_ID).toBe('')
    expect(process.env.TG_API_HASH).toBe('')
  })
})
