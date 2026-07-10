import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  listChats: vi.fn(),
  getChatInfo: vi.fn(),
  close: vi.fn(async () => undefined),
}))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))

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

afterEach(() => {
  vi.clearAllMocks()
  createTelegramClient.mockImplementation(() => client)
  vi.unstubAllEnvs()
  process.env.DATA_DIR && rmSync(process.env.DATA_DIR, { force: true, recursive: true })
  process.exitCode = 0
  delete process.env.DATA_DIR
})

describe('Telegram command error boundary', () => {
  it('renders a concise rich error when chats rejects and closes the client', async () => {
    vi.stubEnv('OUTPUT', 'rich')
    client.listChats.mockRejectedValueOnce(new Error('network unavailable'))

    const result = await run(['chats'])

    expect(result).toEqual({ stdout: '', stderr: 'network unavailable\n', code: 1 })
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('renders structured JSON when info rejects and closes the client', async () => {
    client.getChatInfo.mockRejectedValueOnce(new Error('request failed'))

    const result = await run(['info', '42', '--json'])

    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      schema_version: '1',
      error: { code: 'telegram_error', message: 'request failed' },
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('human')
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('shows a focused session error when auth key is unregistered', async () => {
    const rpcError = new Error('Telegram API error 401: AUTH_KEY_UNREGISTERED') as Error & { code: number; text: string }
    rpcError.code = 401
    rpcError.text = 'AUTH_KEY_UNREGISTERED'

    client.listChats.mockRejectedValueOnce(rpcError)

    const result = await run(['chats', '--json'])
    const payload = JSON.parse(result.stdout)

    expect(payload).toEqual({
      ok: false,
      schema_version: '1',
      error: {
        code: 'telegram_account_session_expired',
        message: 'Session for account "alice" is no longer valid. Re-add the account: tg account remove alice --force && tg account add.',
      },
    })
    expect(result.code).toBe(1)
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('renders a config error when client construction throws without trying to close', async () => {
    vi.stubEnv('OUTPUT', 'rich')
    createTelegramClient.mockImplementationOnce(() => { throw new Error('TG_API_ID is required') })

    const result = await run(['chats'])

    expect(result).toEqual({ stdout: '', stderr: 'TG_API_ID is required\n', code: 1 })
    expect(client.close).not.toHaveBeenCalled()
  })

  it('does not construct a client for an output-format conflict', async () => {
    const result = await run(['chats', '--json', '--yaml'])

    expect(result.stdout).toContain('code: invalid_output_format')
    expect(result.code).toBe(1)
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(client.close).not.toHaveBeenCalled()
  })
})

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-command-'))
  seedAccount(dataDir)
  vi.stubEnv('DATA_DIR', dataDir)
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
  process.exitCode = 0
  try {
    await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
  } finally {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), code: Number(process.exitCode ?? 0) }
}
