import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataService } from '../../src/services/data-service.js'
import { MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'

function createService(): { service: DataService; db: MessageDB } {
  const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-data-')), 'messages.db'))
  db.insertBatch([message()])
  return { service: new DataService(db), db }
}

describe('DataService', () => {
  it('adds export detail only when writing a file', () => {
    const { service } = createService()
    const output = join(mkdtempSync(join(tmpdir(), 'tg-cli-export-')), 'messages.txt')

    const result = service.exportMessages({ chat: 'TestGroup', format: 'text', output })

    expect(readFileSync(output, 'utf8')).toBe('[2026-03-09T10:00:00] Alice: Hello')
    expect(result).toEqual({
      ok: true,
      data: { exported: 1, output },
      human: {
        kind: 'detail',
        title: 'Export Complete',
        fields: [
          { label: 'exported', value: '1' },
          { label: 'output', value: output },
        ],
      },
    })
    service.close()
  })

  it('preserves direct text export semantics', () => {
    const { service } = createService()

    const result = service.exportMessages({ chat: 'TestGroup', format: 'text' })

    expect(result).toEqual({
      ok: true,
      data: [{
        id: 1,
        platform: 'telegram',
        chat_id: 100,
        chat_name: 'TestGroup',
        msg_id: 1,
        sender_id: 1,
        sender_name: 'Alice',
        content: 'Hello',
        timestamp: '2026-03-09T10:00:00.000Z',
        raw_json: null,
        preview_jpeg_base64: null,
      }],
      human: { kind: 'text', text: '[2026-03-09T10:00:00] Alice: Hello' },
    })
    service.close()
  })

  it('does not add human output when no messages are available', () => {
    const { service } = createService()

    const result = service.exportMessages({ chat: 'TestGroup', format: 'text', hours: 1 })

    expect(result).toEqual({
      ok: false,
      error: { code: 'no_messages', message: "No messages found for 'TestGroup'." },
    })
    expect('human' in result).toBe(false)
    service.close()
  })

  it('does not add human output when an export file cannot be written', () => {
    const { service } = createService()
    const output = join(mkdtempSync(join(tmpdir(), 'tg-cli-export-')), 'missing', 'messages.txt')

    const result = service.exportMessages({ chat: 'TestGroup', format: 'text', output })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'export_failed',
        message: `Failed to export messages to '${output}': ENOENT: no such file or directory, open '${output}'`,
        details: { code: 'ENOENT', path: output },
      },
    })
    expect('human' in result).toBe(false)
    service.close()
  })

  it('adds a deletion detail to successful purge', () => {
    const { service } = createService()

    const result = service.purge({ chat: 'TestGroup', yes: true })

    expect(result).toEqual({
      ok: true,
      data: { deleted: 1 },
      human: {
        kind: 'detail',
        title: 'Messages Deleted',
        fields: [{ label: 'deleted', value: '1' }],
      },
    })
    service.close()
  })

  it('does not add human output to failures', () => {
    const { service } = createService()

    const result = service.purge({ chat: 'TestGroup', yes: false })

    expect(result).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    expect('human' in result).toBe(false)
    service.close()
  })
})

function message(): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: 'Hello',
    timestamp: '2026-03-09T10:00:00.000Z',
    raw_json: null,
  }
}
