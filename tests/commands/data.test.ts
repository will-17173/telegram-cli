import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/cli/app.js'

const createTelegramClient = vi.hoisted(() => vi.fn())

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-data-command-'))
  roots.push(root)
  return root
}

function seedRegistry(root: string): void {
  writeFileSync(join(root, 'accounts.json'), `${JSON.stringify({
    version: 2,
    current_account: 'work',
    accounts: [
      {
        name: 'work',
        user_id: 100,
        username: 'work',
        phone: '10086',
        display_name: 'Work',
        auth_state: 'authenticated',
      },
      {
        name: 'old',
        user_id: 200,
        username: 'old',
        phone: '10010',
        display_name: 'Old',
        auth_state: 'logged_out',
      },
    ],
  }, null, 2)}\n`)
}

function seedAccountData(root: string, account: string): Record<string, string> {
  const dir = join(root, 'accounts', account)
  mkdirSync(dir, { recursive: true })
  const paths = {
    db: join(dir, 'messages.db'),
    wal: join(dir, 'messages.db-wal'),
    shm: join(dir, 'messages.db-shm'),
    archive: join(dir, 'archive'),
    session: join(dir, 'session'),
  }
  writeFileSync(paths.db, 'db')
  writeFileSync(paths.wal, 'wal')
  writeFileSync(paths.shm, 'shm')
  mkdirSync(paths.archive)
  writeFileSync(join(paths.archive, 'chat.md'), 'archive')
  writeFileSync(paths.session, 'session')
  return paths
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('data reset command', () => {
  it('resets local data for the current account without connecting to Telegram', async () => {
    const root = makeRoot()
    seedRegistry(root)
    const work = seedAccountData(root, 'work')
    const old = seedAccountData(root, 'old')

    const result = await run(root, ['data', 'reset', '--yes', '--json'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: {
        accounts_reset: ['work'],
        removed_paths: expect.arrayContaining([work.db, work.wal, work.shm, work.archive]),
      },
    })
    expect(existsSync(work.db)).toBe(false)
    expect(existsSync(work.archive)).toBe(false)
    expect(existsSync(work.session)).toBe(true)
    expect(existsSync(old.db)).toBe(true)
    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it('resets local data for all accounts including logged-out entries', async () => {
    const root = makeRoot()
    seedRegistry(root)
    const work = seedAccountData(root, 'work')
    const old = seedAccountData(root, 'old')

    const result = await run(root, ['data', 'reset', '--all-accounts', '--yes', '--json'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { accounts_reset: ['work', 'old'] },
    })
    expect(existsSync(work.db)).toBe(false)
    expect(existsSync(old.db)).toBe(false)
    expect(existsSync(old.session)).toBe(true)
    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it('requires --yes before deleting local data', async () => {
    const root = makeRoot()
    seedRegistry(root)
    const work = seedAccountData(root, 'work')

    const result = await run(root, ['data', 'reset', '--json'])

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' },
    })
    expect(existsSync(work.db)).toBe(true)
    expect(existsSync(work.archive)).toBe(true)
  })

  it('rejects --all-accounts combined with global --account without deleting anything', async () => {
    const root = makeRoot()
    seedRegistry(root)
    const work = seedAccountData(root, 'work')
    const old = seedAccountData(root, 'old')

    const result = await run(root, ['--account', 'work', 'data', 'reset', '--all-accounts', '--yes', '--json'])

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_option',
        message: '--all-accounts cannot be combined with --account.',
      },
    })
    expect(existsSync(work.db)).toBe(true)
    expect(existsSync(old.db)).toBe(true)
    expect(createTelegramClient).not.toHaveBeenCalled()
  })
})

async function run(root: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  vi.stubEnv('DATA_DIR', root)
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
