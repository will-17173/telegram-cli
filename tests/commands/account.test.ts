import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import YAML from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAccountRegistryPath } from '../../src/config/env.js'
import { createApp } from '../../src/cli/app.js'

const AUTH_USER = {
  id: 1001,
  displayName: 'Alice Doe',
  firstName: 'Alice',
  lastName: 'Doe',
  username: 'AliceUser',
  phoneNumber: '+86 138 0013 8000',
}

const telegramClientFactory = vi.hoisted(() => vi.fn(function MockTelegramClient(this: { storage: string }, options: { storage: string }) {
  const client = {
    start: vi.fn(async () => {
      mkdirSync(dirname(options.storage), { recursive: true })
      writeFileSync(options.storage, 'uncommitted-session')
    }),
    getMe: vi.fn(async () => AUTH_USER),
    destroy: vi.fn(async () => {
      writeFileSync(options.storage, 'committed-session')
    }),
  }
  return client
}))
const proxyTransportFromUrl = vi.hoisted(() => vi.fn())

vi.mock('@mtcute/node', () => ({
  TelegramClient: telegramClientFactory,
  proxyTransportFromUrl,
}))

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  proxyTransportFromUrl.mockReset()
  process.exitCode = 0
})

function createDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-account-cmd-'))
  tempDirs.push(dataDir)
  return dataDir
}

function seedAccounts(dataDir: string, registry: {
  version: 1
  current_account: string | null
  accounts: Array<{ name: string; user_id: number; username: string; phone: string; display_name: string }>
}): void {
  writeFileSync(getAccountRegistryPath(dataDir), `${JSON.stringify(registry, null, 2)}\n`)
}

async function run(
  args: string[],
  dataDir: string,
  stdinIsTty = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalStdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdout: string[] = []
  const stderr: string[] = []

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinIsTty })
  vi.stubEnv('DATA_DIR', dataDir)
  process.exitCode = 0

  try {
    await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    if (originalStdinIsTty == null) {
      delete (process.stdin as { isTTY?: boolean }).isTTY
    } else {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTty)
    }
  }

  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    code: Number(process.exitCode ?? 0),
  }
}

describe('account commands', () => {
  it('adds the first account and sets it as current', async () => {
    const dataDir = createDataDir()

    const result = await run(['account', 'add', '--json'], dataDir)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(payload.data.current).toBe(true)
    expect(payload.data.account.user_id).toBe(1001)
    expect(payload.data.account.name).toBe('aliceuser')

    const registry = JSON.parse(readFileSync(getAccountRegistryPath(dataDir), 'utf8')) as { current_account: string | null; accounts: Array<{ name: string; user_id: number }> }
    expect(registry.current_account).toBe('aliceuser')
    expect(registry.accounts).toHaveLength(1)
    expect(registry.accounts[0]?.name).toBe('aliceuser')
    expect(readFileSync(join(dataDir, 'accounts', 'aliceuser', 'session'), 'utf8')).toBe('committed-session')
  })

  it('uses configured proxy transport while authenticating an added account', async () => {
    const dataDir = createDataDir()
    const transport = { kind: 'proxy-transport' }
    vi.stubEnv('TG_PROXY', 'socks5://127.0.0.1:1080')
    proxyTransportFromUrl.mockReturnValue(transport)

    const result = await run(['account', 'add', '--json'], dataDir)

    expect(result.code).toBe(0)
    expect(proxyTransportFromUrl).toHaveBeenCalledOnce()
    expect(proxyTransportFromUrl).toHaveBeenCalledWith('socks5://127.0.0.1:1080')
    expect(telegramClientFactory).toHaveBeenCalledWith(expect.objectContaining({ transport }))
  })

  it('returns current account information when current exists', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
        { name: 'bob', user_id: 2002, username: 'bob', phone: '13900139000', display_name: 'Bob' },
      ],
    })

    const result = await run(['account', 'current', '--json'], dataDir)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(payload.data.current).toBe(true)
    expect(payload.data.account).toMatchObject({
      name: 'alice',
      user_id: 1001,
    })
  })

  it('returns account_not_found when switching to a missing account', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
      ],
    })

    const result = await run(['account', 'switch', 'missing', '--json'], dataDir)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(1)
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('account_not_found')
  })

  it('prevents adding an account already logged in', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
      ],
    })

    const result = await run(['account', 'add', '--json'], dataDir)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(1)
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('account_already_exists')
  })

  it('switches the current account when requested', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
        { name: 'bob', user_id: 2002, username: 'bob', phone: '13900139000', display_name: 'Bob' },
      ],
    })

    const result = await run(['account', 'switch', 'bob', '--json'], dataDir)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(payload.data.current_account).toBe('bob')

    const registry = JSON.parse(readFileSync(getAccountRegistryPath(dataDir), 'utf8')) as {
      current_account: string | null
      accounts: Array<{ name: string }>
    }
    expect(registry.current_account).toBe('bob')
  })

  it('removes an existing account with --force', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
        { name: 'bob', user_id: 2002, username: 'bob', phone: '13900139000', display_name: 'Bob' },
      ],
    })

    const accountDir = join(getAccountRegistryPath(dataDir), '..', 'accounts', 'alice')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, 'session'), 'existing')

    const result = await run(['account', 'remove', 'alice', '--force', '--json'], dataDir, false)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(payload.data.removed).toBe('alice')

    const registry = JSON.parse(readFileSync(getAccountRegistryPath(dataDir), 'utf8')) as {
      current_account: string | null
      accounts: Array<{ name: string }>
    }
    expect(registry.current_account).toBe('bob')
    expect(registry.accounts.some((account) => account.name === 'alice')).toBe(false)
  })

  it('requires --force for non-interactive removal', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
      ],
    })

    const accountDir = join(getAccountRegistryPath(dataDir), '..', 'accounts', 'alice')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, 'session'), 'existing')

    const result = await run(['account', 'remove', 'alice', '--json'], dataDir, false)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(1)
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('account_in_use')
  })

  it('supports account list JSON and YAML output shape', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
        { name: 'bob', user_id: 2002, username: 'bob', phone: '13900139000', display_name: 'Bob' },
      ],
    })

    const jsonResult = await run(['account', 'list', '--json'], dataDir)
    const yamlResult = await run(['account', 'list', '--yaml'], dataDir)
    const jsonPayload = JSON.parse(jsonResult.stdout)
    const yamlPayload = YAML.parse(yamlResult.stdout)

    expect(jsonPayload.ok).toBe(true)
    expect(jsonPayload.data.current_account).toBe('alice')
    expect(jsonPayload.data.accounts).toHaveLength(2)
    expect(jsonPayload.data.accounts[0]).toMatchObject({
      name: 'alice',
      current: true,
    })

    expect(yamlPayload.ok).toBe(true)
    expect(yamlPayload.data.current_account).toBe('alice')
    expect(yamlPayload.data.accounts).toHaveLength(2)
    expect(yamlPayload.data.accounts.find((account: { name: string }) => account.name === 'bob')).toBeDefined()
  })

  it('normalizes duplicated display names when listing accounts', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: '漫漫长夜 W 漫漫长夜 W' },
      ],
    })

    const jsonResult = await run(['account', 'list', '--json'], dataDir)
    const payload = JSON.parse(jsonResult.stdout)

    expect(payload.ok).toBe(true)
    expect(payload.data.accounts[0].display_name).toBe('漫漫长夜 W')
  })

  it('uses displayName as-is when adding an account', async () => {
    const dataDir = createDataDir()
    const originalAuthUser = { ...AUTH_USER }

    AUTH_USER.displayName = '漫漫长夜 W'
    AUTH_USER.firstName = '漫漫长夜'
    AUTH_USER.lastName = 'W'

    try {
      const result = await run(['account', 'add', '--json'], dataDir)
      const payload = JSON.parse(result.stdout)

      expect(result.code).toBe(0)
      expect(payload.ok).toBe(true)
      expect(payload.data.account.display_name).toBe('漫漫长夜 W')
    } finally {
      Object.assign(AUTH_USER, originalAuthUser)
    }
  })
})
