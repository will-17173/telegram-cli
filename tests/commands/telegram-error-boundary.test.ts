import { afterEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  listChats: vi.fn(),
  getChatInfo: vi.fn(),
  close: vi.fn(async () => undefined),
}))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))

import { createApp } from '../../src/cli/app.js'

afterEach(() => {
  vi.clearAllMocks()
  createTelegramClient.mockImplementation(() => client)
  vi.unstubAllEnvs()
  process.exitCode = 0
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
