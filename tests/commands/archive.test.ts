import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const archive = vi.hoisted(() => vi.fn())
const ArchiveService = vi.hoisted(() => vi.fn(function () {
  return { archive }
}))
const client = vi.hoisted(() => ({
  archive: { resolveChats: vi.fn(), iterHistoryPages: vi.fn(), downloadMedia: vi.fn() },
  close: vi.fn(async () => undefined),
}))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))

vi.mock('../../src/services/archive-service.js', () => ({ ArchiveService }))
vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))

import { createApp } from '../../src/cli/app.js'

const dataDirs: string[] = []

function seedAccounts(current = 'alice', aliceState: 'authenticated' | 'logged_out' = 'authenticated'): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-archive-command-'))
  dataDirs.push(dataDir)
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
    version: 2,
    current_account: current,
    accounts: [
      { name: 'alice', user_id: 101, username: 'alice', phone: '10001', display_name: 'Alice', auth_state: aliceState },
      { name: 'bob', user_id: 202, username: 'bob', phone: '10002', display_name: 'Bob', auth_state: 'authenticated' },
    ],
  })}\n`)
  vi.stubEnv('DATA_DIR', dataDir)
  return dataDir
}

async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
  return { exitCode: Number(process.exitCode ?? 0), stdout: stdout.join(''), stderr: stderr.join('') }
}

const success = {
  ok: true as const,
  data: {
    manifest: 'archive/archive-manifest.json',
    completed: [{ chat_id: -100, title: 'Team', file: '-100-team.md', messages_archived: 3, media_archived: 2 }],
    failed: [],
    warnings: [],
  },
}

beforeEach(() => {
  seedAccounts()
  archive.mockResolvedValue(success)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const directory of dataDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('archive command', () => {
  it('archives selected chats to an explicit output and renders JSON', async () => {
    const output = join(dataDirs[0]!, 'exports', 'team')

    const result = await run(['archive', '@team', '--output', output, '--json'])

    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, schema_version: '2', data: success.data })
    expect(ArchiveService).toHaveBeenCalledWith(client.archive)
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({
      account: { userId: 101, name: 'alice' },
      chats: ['@team'],
      all: false,
      output,
    }))
  })

  it('supports all, full history, media downloads, and Markdown output', async () => {
    const result = await run(['archive', '--all', '--full', '--download-media', '--markdown'])

    expect(result).toMatchObject({ exitCode: 0 })
    expect(result.stdout).toContain('| CHAT | FILE | NEW MESSAGES | DOWNLOADED MEDIA | WARNINGS |')
    expect(result.stdout).toContain('| Team | -100-team.md | 3 | 2 | — |')
    expect(ArchiveService).toHaveBeenCalledWith(client.archive, {
      downloadStatusStore: {
        markAttachmentDownloaded: expect.any(Function),
      },
    })
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({
      chats: [], all: true, full: true, media: true,
    }))
  })

  it('uses an account-local archive directory by default and honors explicit account selection', async () => {
    const dataDir = dataDirs[0]!

    await run(['archive', '@team', '--account', 'bob'])

    expect(archive).toHaveBeenCalledWith(expect.objectContaining({
      account: { userId: 202, name: 'bob' },
      output: join(dataDir, 'accounts', 'bob', 'archive'),
    }))
  })

  it.each([
    ['missing scope', ['archive', '--json'], 'archive_scope_required', 'Select one or more chats or use --all.'],
    ['chats with all', ['archive', '@team', '--all', '--json'], 'archive_scope_conflict', 'Chat arguments cannot be combined with --all.'],
    ['full with since', ['archive', '@team', '--full', '--since', '2026-07-01T00:00:00Z', '--json'], 'archive_full_range_conflict', '--full cannot be combined with --since.'],
    ['reversed bounds', ['archive', '@team', '--since', '2026-07-02T00:00:00Z', '--until', '2026-07-01T00:00:00Z', '--json'], 'archive_invalid_time_range', 'Use positive relative durations or ISO timestamps with zones; --since must be earlier than --until.'],
    ['invalid bound', ['archive', '@team', '--since', 'yesterday', '--json'], 'archive_invalid_time_range', 'Use positive relative durations or ISO timestamps with zones; --since must be earlier than --until.'],
  ])('rejects %s before constructing a Telegram client', async (_label, args, code, message) => {
    const result = await run(args)

    expect(result).toMatchObject({ exitCode: 1 })
    expect(JSON.parse(result.stdout).error).toEqual({ code, message })
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(archive).not.toHaveBeenCalled()
  })

  it('rejects output format conflicts before constructing a Telegram client', async () => {
    const result = await run(['archive', '@team', '--json', '--yaml'])

    expect(result).toMatchObject({ exitCode: 1 })
    expect(result.stdout).toContain('code: invalid_output_format')
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(archive).not.toHaveBeenCalled()
  })

  it('parses relative and ISO time bounds and passes rebuild through', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))

    await run([
      'archive', '@team', '--since', '2d', '--until', '2026-07-13T00:00:00Z', '--rebuild',
    ])

    expect(archive).toHaveBeenCalledWith(expect.objectContaining({
      rebuild: true,
      range: {
        since: new Date('2026-07-11T12:00:00Z'),
        until: new Date('2026-07-13T00:00:00Z'),
      },
    }))
  })

  it('rejects a logged-out account before constructing a Telegram client', async () => {
    vi.unstubAllEnvs()
    seedAccounts('alice', 'logged_out')

    const result = await run(['archive', '@team', '--json'])

    expect(result).toMatchObject({ exitCode: 1 })
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: 'account_logged_out' })
    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it('uses the existing stable error for an expired Telegram session', async () => {
    const expired = { code: 401, text: 'AUTH_KEY_UNREGISTERED' }
    archive.mockRejectedValueOnce(expired)

    const result = await run(['archive', '@team', '--json'])

    expect(result).toMatchObject({ exitCode: 1 })
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'telegram_account_session_expired',
    })
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('sanitizes archive account manifest mismatches', async () => {
    archive.mockRejectedValueOnce(new Error('archive_account_mismatch: /private/session/alice'))

    const result = await run(['archive', '@team', '--json'])

    expect(result).toMatchObject({ exitCode: 1 })
    expect(JSON.parse(result.stdout).error).toEqual({
      code: 'archive_account_mismatch',
      message: 'Archive belongs to a different Telegram account.',
    })
    expect(result.stdout).not.toContain('/private')
  })

  it('sanitizes unexpected archive and local filesystem failures', async () => {
    archive.mockRejectedValueOnce(new Error('EACCES: open /private/session/alice/archive.tmp'))

    const result = await run(['archive', '@team', '--json'])

    expect(result).toMatchObject({ exitCode: 1 })
    expect(JSON.parse(result.stdout).error).toEqual({
      code: 'archive_failed',
      message: 'Archive could not be completed.',
    })
    expect(result.stdout).not.toContain('/private')
    expect(result.stdout).not.toContain('EACCES')
  })

  it('returns nonzero structured output while preserving partial completion details', async () => {
    archive.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'archive_partial_failure',
        message: 'Archive completed with one or more chat or attachment failures.',
        details: {
          completed: success.data.completed,
          failed: [{ chat_id: -200, title: 'Broken', error: 'archive_chat_failed' }],
          warnings: [{ chat_id: -100, code: 'archive_media_failed', message: 'Attachment could not be downloaded.' }],
        },
      },
    })

    const result = await run(['archive', '--all', '--json'])
    const payload = JSON.parse(result.stdout)

    expect(result).toMatchObject({ exitCode: 1, stderr: '' })
    expect(payload.error).toMatchObject({
      code: 'archive_partial_failure',
      details: {
        completed: success.data.completed,
        failed: [{ chat_id: -200, title: 'Broken', error: 'archive_chat_failed' }],
        warnings: [{ chat_id: -100, code: 'archive_media_failed' }],
      },
    })
  })
})
