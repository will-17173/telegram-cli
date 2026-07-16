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

type AuthStartOptions = {
  phone?: () => Promise<string>
  code?: () => Promise<string>
  password?: () => Promise<string>
  codeSentCallback?: () => Promise<void> | void
}

let simulateInteractiveAuth = false
let interruptInteractiveAuthAt: 'phone' | 'code' | 'password' | undefined

const telegramClientFactory = vi.hoisted(() => vi.fn(function MockTelegramClient(this: { storage: string }, options: { storage: string }) {
  const client = {
    start: vi.fn(async (startOptions?: AuthStartOptions) => {
      if (simulateInteractiveAuth) {
        if (!startOptions?.phone || !startOptions.code || !startOptions.password || !startOptions.codeSentCallback) {
          throw new Error('missing interactive authentication callbacks')
        }
        const phone = startOptions.phone()
        if (interruptInteractiveAuthAt === 'phone') process.emit('SIGINT')
        await phone
        await startOptions.codeSentCallback()
        const code = startOptions.code()
        if (interruptInteractiveAuthAt === 'code') process.emit('SIGINT')
        await code
        const password = startOptions.password()
        if (interruptInteractiveAuthAt === 'password') process.emit('SIGINT')
        await password
      }
      mkdirSync(dirname(options.storage), { recursive: true })
      writeFileSync(options.storage, 'uncommitted-session')
    }),
    getMe: vi.fn(async () => AUTH_USER),
    logOut: vi.fn(async () => undefined),
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
type StdinInput = string | { signal: 'SIGINT' }

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  proxyTransportFromUrl.mockReset()
  simulateInteractiveAuth = false
  interruptInteractiveAuthAt = undefined
  process.exitCode = 0
})

function createDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-account-cmd-'))
  tempDirs.push(dataDir)
  return dataDir
}

function seedAccounts(dataDir: string, registry: {
  version: 1 | 2
  current_account: string | null
  accounts: Array<{
    name: string
    user_id: number
    username: string
    phone: string
    display_name: string
    auth_state?: 'authenticated' | 'logged_out'
  }>
}): void {
  writeFileSync(getAccountRegistryPath(dataDir), `${JSON.stringify(registry, null, 2)}\n`)
}

async function run(
  args: string[],
  dataDir: string,
  stdinIsTty = false,
  stdinInput?: StdinInput | StdinInput[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalStdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const originalStdinIsRaw = Object.getOwnPropertyDescriptor(process.stdin, 'isRaw')
  const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode')
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
  let stdinIsRaw = false
  Object.defineProperty(process.stdin, 'isRaw', { configurable: true, get: () => stdinIsRaw })
  Object.defineProperty(process.stdin, 'setRawMode', {
    configurable: true,
    value: (mode: boolean) => {
      stdinIsRaw = mode
      return process.stdin
    },
  })
  vi.stubEnv('DATA_DIR', dataDir)
  process.exitCode = 0

  try {
    const parsing = createApp().exitOverride().parseAsync(['node', 'tg', ...args])
    if (stdinInput != null) {
      const inputs = Array.isArray(stdinInput) ? stdinInput : [stdinInput]
      const sendInput = (index: number): void => {
        if (index >= inputs.length) return
        setImmediate(() => {
          const input = inputs[index]
          if (typeof input === 'string') process.stdin.emit('data', `${input}\n`)
          else process.emit(input.signal)
          sendInput(index + 1)
        })
      }
      sendInput(0)
    }
    await parsing
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    if (originalStdinIsTty == null) {
      delete (process.stdin as { isTTY?: boolean }).isTTY
    } else {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTty)
    }
    restoreProperty(process.stdin, 'isRaw', originalStdinIsRaw)
    restoreProperty(process.stdin, 'setRawMode', originalSetRawMode)
  }

  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    code: Number(process.exitCode ?? 0),
  }
}

function restoreProperty(target: NodeJS.ReadStream, key: 'isRaw' | 'setRawMode', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor == null) delete (target as unknown as Record<string, unknown>)[key]
  else Object.defineProperty(target, key, descriptor)
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
    expect(payload.data.account.auth_state).toBe('authenticated')

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

  it('lists accounts and switches to the selected account when no name is provided', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
        { name: 'bob', user_id: 2002, username: 'bob', phone: '13900139000', display_name: 'Bob' },
      ],
    })

    const result = await run(['account', 'switch'], dataDir, true, '2')

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('1. alice')
    expect(result.stdout).toContain('2. bob')
    const registry = JSON.parse(readFileSync(getAccountRegistryPath(dataDir), 'utf8')) as { current_account: string | null }
    expect(registry.current_account).toBe('bob')
  })

  it('exits 130 when Ctrl-C interrupts interactive account selection', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 1,
      current_account: 'alice',
      accounts: [
        { name: 'alice', user_id: 1001, username: 'alice', phone: '13800138000', display_name: 'Alice' },
        { name: 'bob', user_id: 2002, username: 'bob', phone: '13900139000', display_name: 'Bob' },
      ],
    })

    const result = await run(['account', 'switch'], dataDir, true, { signal: 'SIGINT' })
    const registry = JSON.parse(readFileSync(getAccountRegistryPath(dataDir), 'utf8')) as { current_account: string | null }

    expect(result.code).toBe(130)
    expect(result.stdout).toContain('Select an account:')
    expect(result.stdout).toContain('Operation interrupted.')
    expect(registry.current_account).toBe('alice')
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
      auth_state: 'authenticated',
    })

    expect(yamlPayload.ok).toBe(true)
    expect(yamlPayload.data.current_account).toBe('alice')
    expect(yamlPayload.data.accounts).toHaveLength(2)
    expect(yamlPayload.data.accounts.find((account: { name: string }) => account.name === 'bob')).toBeDefined()
    expect(jsonPayload.data.accounts.find((account: { name: string }) => account.name === 'bob')?.auth_state).toBe('authenticated')
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

  it('logs out a named account with explicit confirmation and retains its messages database', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'authenticated',
      }],
    })
    const accountDir = join(dataDir, 'accounts', 'alice')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, 'session'), 'existing-session')
    writeFileSync(join(accountDir, 'messages.db'), 'retained-messages')

    const result = await run(['account', 'logout', 'alice', '--yes', '--json'], dataDir)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      ok: true,
      data: {
        account: { name: 'alice', auth_state: 'logged_out' },
        retained_db_path: join(accountDir, 'messages.db'),
      },
    })
    expect(readFileSync(join(accountDir, 'messages.db'), 'utf8')).toBe('retained-messages')
  })

  it('uses the current account when logout name is omitted', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'authenticated',
      }],
    })
    const accountDir = join(dataDir, 'accounts', 'alice')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, 'session'), 'existing-session')

    const result = await run(['account', 'logout', '--yes', '--json'], dataDir)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload.data.account).toMatchObject({ name: 'alice', auth_state: 'logged_out' })
  })

  it('requires confirmation for non-interactive logout', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'authenticated',
      }],
    })

    const result = await run(['account', 'logout', 'alice'], dataDir, false)

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('confirmation_required')
    expect(telegramClientFactory).not.toHaveBeenCalled()
  })

  it('writes the interactive logout prompt to stderr and declines without creating a client', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'authenticated',
      }],
    })

    const result = await run(['account', 'logout', 'alice', '--json'], dataDir, true, 'n')
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Log out alice while keeping local messages? [y/N]')
    expect(payload).toMatchObject({ ok: true, data: { account: { name: 'alice' }, changed: false } })
    expect(telegramClientFactory).not.toHaveBeenCalled()
  })

  it('logs in an existing account interactively and emits only the final YAML result on stdout', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'logged_out',
      }],
    })

    const result = await run(['account', 'login', 'alice', '--yaml'], dataDir, true)
    const payload = YAML.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      ok: true,
      data: { account: { name: 'alice', auth_state: 'authenticated' } },
    })
    expect(result.stdout).not.toContain('Log in')
  })

  it('writes mtcute login prompts to stderr and keeps JSON stdout structured', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'logged_out',
      }],
    })
    simulateInteractiveAuth = true

    const result = await run(
      ['account', 'login', 'alice', '--json'],
      dataDir,
      true,
      ['+8613800138000', '12345', 'secret-password'],
    )

    expect(result.code).toBe(0)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    expect(result.stdout.trimStart().startsWith('{')).toBe(true)
    expect(result.stdout).not.toContain('Phone')
    expect(result.stdout).not.toContain('code')
    expect(result.stdout).not.toContain('password')
    expect(result.stderr).toContain('Phone number: ')
    expect(result.stderr).toContain('Login code: ')
    expect(result.stderr).toContain('2FA password: ')
  })

  it('keeps structured account add stdout clean while authenticating interactively', async () => {
    const dataDir = createDataDir()
    simulateInteractiveAuth = true

    const result = await run(
      ['account', 'add', '--yaml'],
      dataDir,
      true,
      ['+8613800138000', '12345', 'secret-password'],
    )
    const payload = YAML.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({ ok: true, data: { account: { name: 'aliceuser' } } })
    expect(result.stdout).not.toContain('Phone number')
    expect(result.stdout).not.toContain('Login code')
    expect(result.stdout).not.toContain('2FA password')
    expect(result.stderr).toContain('Phone number: ')
    expect(result.stderr).toContain('Login code: ')
    expect(result.stderr).toContain('2FA password: ')
  })

  it.each([
    ['phone', []],
    ['code', ['+8613800138000']],
    ['password', ['+8613800138000', '12345']],
  ] as const)('exits 130 on Ctrl-C during the %s login prompt', async (prompt, inputs) => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'logged_out',
      }],
    })
    simulateInteractiveAuth = true
    interruptInteractiveAuthAt = prompt

    const result = await run(['account', 'login', 'alice', '--json'], dataDir, true, [...inputs])
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(130)
    expect(payload).toMatchObject({ ok: false, error: { code: 'interrupted' } })
  })

  it('requires an interactive terminal before starting account login', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'logged_out',
      }],
    })

    const result = await run(['account', 'login', 'alice', '--json'], dataDir, false)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(1)
    expect(payload).toMatchObject({ ok: false, error: { code: 'interaction_required' } })
    expect(telegramClientFactory).not.toHaveBeenCalled()
  })

  it('returns unchanged for an authenticated account without requiring a TTY', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'authenticated',
      }],
    })

    const result = await run(['account', 'login', 'alice', '--json'], dataDir, false)
    const payload = JSON.parse(result.stdout)

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      ok: true,
      data: { changed: false, account: { name: 'alice', auth_state: 'authenticated' } },
    })
    expect(telegramClientFactory).not.toHaveBeenCalled()
  })

  it('leaves account files untouched when login authenticates a different identity', async () => {
    const dataDir = createDataDir()
    seedAccounts(dataDir, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 1001,
        username: 'alice',
        phone: '13800138000',
        display_name: 'Alice',
        auth_state: 'logged_out',
      }],
    })
    const accountDir = join(dataDir, 'accounts', 'alice')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, 'session'), 'original-session')
    writeFileSync(join(accountDir, 'messages.db'), 'original-messages')
    const originalAuthUser = { ...AUTH_USER }
    AUTH_USER.id = 2002

    try {
      const result = await run(['account', 'login', 'alice', '--json'], dataDir, true)
      const payload = JSON.parse(result.stdout)

      expect(result.code).toBe(1)
      expect(payload).toMatchObject({ ok: false, error: { code: 'account_identity_mismatch' } })
      expect(readFileSync(join(accountDir, 'session'), 'utf8')).toBe('original-session')
      expect(readFileSync(join(accountDir, 'messages.db'), 'utf8')).toBe('original-messages')
    } finally {
      Object.assign(AUTH_USER, originalAuthUser)
    }
  })
})
