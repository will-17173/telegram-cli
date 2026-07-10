import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

const telegramClient = vi.hoisted(() => ({
  getCurrentUser: vi.fn(async () => ({
    id: 1,
    name: 'Test User',
    username: 'test',
    first_name: 'Test',
    last_name: 'User',
    phone: null,
  })),
  listChats: vi.fn(async () => [{ id: 42, name: 'General', type: 'group' as const, unread: 3 }]),
  close: vi.fn(async () => undefined),
}))

vi.mock('../../src/telegram/client-factory.js', () => ({
  createTelegramClient: () => telegramClient,
}))

import { createApp } from '../../src/cli/app.js'
import { MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'
import { fixtureMessages, message } from '../fixtures/messages.js'

async function run(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const oldOut = process.stdout.write
  const oldErr = process.stderr.write
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
  process.exitCode = 0
  try {
    await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
  } catch (error) {
    if (typeof error === 'object' && error && 'exitCode' in error) process.exitCode = Number((error as { exitCode: number }).exitCode)
    else throw error
  } finally {
    process.stdout.write = oldOut
    process.stderr.write = oldErr
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), code: Number(process.exitCode ?? 0) }
}

function seed(messages: StoredMessageInput[] = fixtureMessages()): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'tg-cli-contract-')), 'messages.db')
  const db = new MessageDB(dbPath)
  db.insertBatch(messages)
  db.close()
  vi.stubEnv('DB_PATH', dbPath)
  return dbPath
}

afterEach(() => {
  vi.unstubAllEnvs()
  process.exitCode = 0
})

describe('local command contracts', () => {
  it('keeps stats json bytes stable and ansi-free', async () => {
    seed()
    const result = await run(['stats', '--json'])

    expect(result).toEqual({
      stdout: '{\n  "ok": true,\n  "schema_version": "1",\n  "data": {\n    "total": 3,\n    "chats": [\n      {\n        "chat_id": 100,\n        "chat_name": "TestGroup",\n        "msg_count": 2,\n        "first_msg": "2026-03-09T10:00:00.000Z",\n        "last_msg": "2026-03-09T11:00:00.000Z"\n      },\n      {\n        "chat_id": 200,\n        "chat_name": "OtherGroup",\n        "msg_count": 1,\n        "first_msg": "2026-03-08T10:00:00.000Z",\n        "last_msg": "2026-03-08T10:00:00.000Z"\n      }\n    ]\n  }\n}\n',
      stderr: '',
      code: 0,
    })
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    expect(result.stdout).not.toMatch(/\u001b\[/)
  })

  it('keeps whoami json bytes stable with a mocked Telegram client', async () => {
    const result = await run(['whoami', '--json'])

    expect(result).toEqual({
      stdout: '{\n  "ok": true,\n  "schema_version": "1",\n  "data": {\n    "user": {\n      "id": 1,\n      "name": "Test User",\n      "username": "test",\n      "first_name": "Test",\n      "last_name": "User",\n      "phone": null\n    }\n  }\n}\n',
      stderr: '',
      code: 0,
    })
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    expect(result.stdout).not.toMatch(/\u001b\[/)
  })

  it('keeps chats yaml bytes stable with a mocked Telegram client', async () => {
    const result = await run(['chats', '--yaml'])

    expect(result).toEqual({
      stdout: 'ok: true\nschema_version: "1"\ndata:\n  - id: 42\n    name: General\n    type: group\n    unread: 3\n',
      stderr: '',
      code: 0,
    })
    expect(YAML.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: [{ id: 42, name: 'General', type: 'group', unread: 3 }],
    })
    expect(result.stdout).not.toMatch(/\u001b\[/)
  })

  it('prints stats as yaml', async () => {
    seed()
    const result = await run(['stats', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok: true')
    expect(result.stdout).toContain('total: 3')
  })

  it('returns structured chat_not_found', async () => {
    seed()
    const result = await run(['search', 'Web3', '--chat', 'MissingGroup', '--yaml'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('ok: false')
    expect(result.stdout).toContain('code: chat_not_found')
  })

  it('searches by keyword', async () => {
    seed()
    const result = await run(['search', 'Web3', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Message 1: Web3 remote role')
  })

  it('returns a structured output format conflict without a stack trace', async () => {
    seed()
    const result = await run(['stats', '--json', '--yaml'])
    const combined = `${result.stdout}\n${result.stderr}`
    expect(result.code).toBe(1)
    expect(combined).toContain('Use only one of --json or --yaml.')
    expect(combined).not.toContain('Error:')
    expect(combined).not.toContain('at ')
  })

  it('rejects purge output format conflicts before deleting rows', async () => {
    const dbPath = seed()
    const result = await run(['purge', 'TestGroup', '--yes', '--json', '--yaml'])
    const db = new MessageDB(dbPath)
    const remaining = db.count(100)
    db.close()

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: invalid_output_format')
    expect(remaining).toBe(2)
  })

  it('rejects export output format conflicts before writing a file', async () => {
    seed()
    const output = join(mkdtempSync(join(tmpdir(), 'tg-cli-export-')), 'conflict.txt')
    const result = await run(['export', 'TestGroup', '--format', 'text', '--output', output, '--json', '--yaml'])

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: invalid_output_format')
    expect(existsSync(output)).toBe(false)
  })

  it('prints recent messages as yaml', async () => {
    seed(todayMessages())
    const result = await run(['recent', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok: true')
    expect(result.stdout).toContain('today Rust role')
  })

  it('prints top senders as yaml', async () => {
    seed()
    const result = await run(['top', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok: true')
    expect(result.stdout).toContain('msg_count: 3')
  })

  it('prints hourly timeline as yaml', async () => {
    seed()
    const result = await run(['timeline', '--by', 'hour', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('period: 2026-03-09T10')
  })

  it('prints today messages as yaml', async () => {
    seed(todayMessages())
    const result = await run(['today', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('today Web3 role')
  })

  it('filters today messages by comma-separated keywords as yaml', async () => {
    seed(todayMessages())
    const result = await run(['filter', 'Web3,Rust', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('today Web3 role')
    expect(result.stdout).toContain('today Rust role')
    expect(result.stdout).not.toContain('today Golang role')
  })

  it('exports text messages to a file', async () => {
    seed()
    const output = join(mkdtempSync(join(tmpdir(), 'tg-cli-export-')), 'messages.txt')
    const result = await run(['export', 'TestGroup', '--format', 'text', '--output', output])
    const content = readFileSync(output, 'utf8')

    expect(result.code).toBe(0)
    expect(content).toContain('[2026-03-09T10:00:00] Alice: Message 1: Web3 remote role')
    expect(content).toContain('[2026-03-09T11:00:00] Bob: Message 2: Python and Rust')
  })

  it('exports structured json messages to a file', async () => {
    seed()
    const output = join(mkdtempSync(join(tmpdir(), 'tg-cli-export-')), 'messages.json')
    const result = await run(['export', 'TestGroup', '--format', 'json', '--output', output])
    const payload = JSON.parse(readFileSync(output, 'utf8')) as { ok: boolean; data: Array<{ content: string }> }

    expect(result.code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(payload.data).toHaveLength(2)
    expect(payload.data[0]?.content).toBe('Message 1: Web3 remote role')
  })

  it('exports raw message rows in implicit structured mode without double-enveloping', async () => {
    seed()
    const result = await run(['export', 'TestGroup', '--format', 'json'])
    const payload = YAML.parse(result.stdout) as { ok: boolean; data: unknown }

    expect(result.code).toBe(0)
    expect(payload.ok).toBe(true)
    expect(Array.isArray(payload.data)).toBe(true)
    expect(payload.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Message 1: Web3 remote role' }),
    ]))
    expect(typeof payload.data).not.toBe('string')
    expect(result.stdout).not.toContain('data: "{')
  })

  it('returns structured export_failed when output file cannot be written', async () => {
    const dbPath = seed()
    const output = join(dbPath, 'missing-dir', 'messages.txt')
    const result = await run(['export', 'TestGroup', '--format', 'text', '--output', output, '--yaml'])

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('ok: false')
    expect(result.stdout).toContain('code: export_failed')
    expect(result.stdout).not.toContain('Error:')
    expect(result.stdout).not.toContain('at ')
  })

  it('purges a chat with confirmation', async () => {
    const dbPath = seed()
    const result = await run(['purge', 'TestGroup', '--yes', '--yaml'])
    const db = new MessageDB(dbPath)
    const remaining = db.count(100)
    db.close()

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('deleted: 2')
    expect(remaining).toBe(0)
  })

  it('requires confirmation before purging', async () => {
    seed()
    const result = await run(['purge', 'TestGroup', '--yaml'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: confirmation_required')
  })

  it('returns structured ambiguous_chat for partial chat matches', async () => {
    seed([
      message({ chat_id: 300, chat_name: 'AlphaTeam', msg_id: 1, content: 'first alpha' }),
      message({ chat_id: 400, chat_name: 'AlphaGroup', msg_id: 1, content: 'second alpha' }),
    ])
    const result = await run(['search', 'alpha', '--chat', 'Alpha', '--yaml'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: ambiguous_chat')
  })

  it('returns structured invalid_option for invalid numeric flags', async () => {
    seed()
    const result = await run(['search', 'Web3', '--limit', 'nope', '--yaml'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: invalid_option')
  })

  it('returns structured invalid_regex for invalid regex patterns', async () => {
    seed()
    const result = await run(['search', '[', '--regex', '--yaml'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: invalid_regex')
  })
})

function todayMessages(): StoredMessageInput[] {
  const today = new Date()
  today.setHours(10, 0, 0, 0)
  const hourLater = new Date(today.getTime() + 60 * 60 * 1000)
  const twoHoursLater = new Date(today.getTime() + 2 * 60 * 60 * 1000)
  return [
    message({ msg_id: 10, sender_name: 'Alice', content: 'today Web3 role', timestamp: today.toISOString() }),
    message({ msg_id: 11, sender_name: 'Bob', content: 'today Rust role', timestamp: hourLater.toISOString() }),
    message({ msg_id: 12, sender_name: 'Carol', content: 'today Golang role', timestamp: twoHoursLater.toISOString() }),
  ]
}
