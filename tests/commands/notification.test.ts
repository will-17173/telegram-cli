import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notificationState = {
  chat_id: 42,
  chat_name: 'Team',
  explicit_muted: false,
  mute_until: null,
  effective_muted: false,
}

const notifications = vi.hoisted(() => ({
  get: vi.fn(),
  setMuteUntil: vi.fn(),
}))
const client = vi.hoisted(() => ({
  notifications,
  close: vi.fn(async () => undefined),
}))
const renderResult = vi.hoisted(() => vi.fn(async (result: { ok: boolean }) => {
  if (!result.ok) process.exitCode = 1
}))
const createTelegramClient = vi.hoisted(() => vi.fn((_sessionPath: string) => client))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'

const dataDirs: string[] = []

function seedAccount(writeAccess = true): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-notification-'))
  dataDirs.push(dataDir)
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
    version: 1,
    current_account: 'alice',
    accounts: [
      { name: 'alice', user_id: 1, username: 'alice', phone: '10001', display_name: 'Alice' },
    ],
  })}\n`)
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify({ write_access: writeAccess })}\n`)
  vi.stubEnv('DATA_DIR', dataDir)
}

async function run(...args: string[]): Promise<void> {
  await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
}

beforeEach(() => {
  seedAccount()
  notifications.get.mockResolvedValue(notificationState)
  notifications.setMuteUntil.mockResolvedValue(notificationState)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dir of dataDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('notification commands', () => {
  it('runs info through the authenticated read path and renders account/global output options', async () => {
    await run('--account', 'alice', '--markdown', 'notification', 'info', '@team')

    expect(notifications.get).toHaveBeenCalledWith('@team')
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: notificationState,
    }), { account: 'alice', markdown: true })
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('mutes for a parsed relative duration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))

    await run('notification', 'mute', '@team', '8h', '--json')

    expect(notifications.setMuteUntil).toHaveBeenCalledOnce()
    expect(notifications.setMuteUntil).toHaveBeenCalledWith('@team', new Date('2026-07-13T20:00:00Z'))
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), { json: true })
  })

  it('defaults mute to forever', async () => {
    await run('notification', 'mute', '@team')

    expect(notifications.setMuteUntil).toHaveBeenCalledWith('@team', new Date(2147483647 * 1000))
  })

  it('unmutes by passing null', async () => {
    await run('notification', 'unmute', '@team', '--yaml')

    expect(notifications.setMuteUntil).toHaveBeenCalledWith('@team', null)
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), { yaml: true })
  })

  it('rejects invalid duration before account resolution and client construction', async () => {
    vi.unstubAllEnvs()

    await run('notification', 'mute', '@team', '0h')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'invalid_notification_duration',
        message: 'Notification duration must be a positive integer followed by s, m, h, d, or w, or forever.',
      },
    }, {})
  })

  it('rejects a relative duration beyond Telegram maximum before client construction', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))

    await run('notification', 'mute', '@team', '999w')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'invalid_notification_duration',
        message: 'Notification duration must be a positive integer followed by s, m, h, d, or w, or forever.',
      },
    }, {})
  })

  it.each([
    ['mute', ['notification', 'mute', '@team', '1h']],
    ['unmute', ['notification', 'unmute', '@team']],
  ])('blocks %s before client construction when write access is disabled', async (_name, args) => {
    vi.unstubAllEnvs()
    seedAccount(false)

    await run(...args)

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(notifications.setMuteUntil).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'write_access_disabled',
        message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
      },
    }, {})
  })

  it('keeps info operational when write access is disabled', async () => {
    vi.unstubAllEnvs()
    seedAccount(false)

    await run('notification', 'info', '@team')

    expect(createTelegramClient).toHaveBeenCalledOnce()
    expect(notifications.get).toHaveBeenCalledWith('@team')
  })

  it.each([
    ['info', ['notification', 'info', '@team']],
    ['mute', ['notification', 'mute', '@team', '1h']],
    ['unmute', ['notification', 'unmute', '@team']],
  ])('rejects %s output conflicts before client construction', async (_name, args) => {
    await run(...args, '--json', '--yaml')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_output_format', message: 'Use only one of --json, --yaml, or --markdown.' },
    }, { yaml: true })
  })
})
