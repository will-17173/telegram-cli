import { describe, expect, it, vi } from 'vitest'

import {
  executeSelectedListenCommand,
  parseSelectedListenCommand,
  type ListenCommandParseResult,
} from '../../src/listen-commands/dispatch.js'
import type { GroupCommandExecutionResult } from '../../src/group-commands/executor.js'
import { matchListenCommands } from '../../src/listen-commands/match.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

const selected = (input: string, index = 0) => matchListenCommands(input)[index]!

const executable = (result: ListenCommandParseResult) => {
  if (result.kind !== 'reply' && result.kind !== 'group') throw new Error(`Expected executable result, received ${result.kind}`)
  return result
}

describe('parseSelectedListenCommand', () => {
  it('parses text and file replies', () => {
    expect(parseSelectedListenCommand('/reply 42 hello', selected('/reply 42 hello'))).toEqual({
      kind: 'reply',
      command: { kind: 'reply', reply: 42, content: 'hello', files: [] },
    })
    expect(parseSelectedListenCommand('/reply 42 note --file ./a.jpg', selected('/reply 42 note --file ./a.jpg'))).toEqual({
      kind: 'reply',
      command: { kind: 'reply', reply: 42, content: 'note', files: ['./a.jpg'] },
    })
  })

  it('preserves reply parser errors and usage', () => {
    expect(parseSelectedListenCommand('/reply nope', selected('/reply nope'))).toEqual({
      kind: 'error',
      message: 'reply message ID must be a positive integer',
      usage: 'reply <message-id> [content] [--file <path> ...]',
    })
  })

  it('parses group writes and queries into typed requests', () => {
    const ban = parseSelectedListenCommand('/member ban @alice', selected('/member ban @alice'))
    expect(ban.kind).toBe('group')
    if (ban.kind === 'group') {
      expect(ban.request.key).toBe('member ban')
      if (ban.request.key === 'member ban') expect(ban.request.values).toEqual({ user: '@alice' })
    }

    const query = parseSelectedListenCommand('/invite list', selected('/invite list'))
    expect(query.kind).toBe('group')
    if (query.kind === 'group') {
      expect(query.request.key).toBe('invite list')
      if (query.request.key === 'invite list') expect(query.request.values).toEqual({})
    }
  })

  it('returns structured group parser errors', () => {
    expect(parseSelectedListenCommand('/member ban', selected('/member ban'))).toEqual({
      kind: 'error',
      message: 'Missing argument: user',
      usage: 'group member ban <user>',
    })
  })

  it('completes partial paths', () => {
    expect(parseSelectedListenCommand('/mem b', selected('/mem b'))).toEqual({
      kind: 'complete', input: '/member ban ',
    })
  })

  it('rejects a selection that is stale for the current input', () => {
    const stale = selected('/member ban @alice')
    expect(parseSelectedListenCommand('/reply 42 hi', stale)).toEqual({
      kind: 'error', message: 'Selected command no longer matches the input',
    })
  })

  it('rejects a non-canonical selected definition', () => {
    const match = selected('/reply 42 hi')
    const forged = { ...match, definition: { ...match.definition } }
    expect(parseSelectedListenCommand('/reply 42 hi', forged)).toEqual({
      kind: 'error', message: 'Selected command is not canonical',
    })
  })
})

describe('executeSelectedListenCommand', () => {
  it('calls only the reply executor for reply commands', async () => {
    const outcome: StoredMessageInput[] = [{
      platform: 'telegram', chat_id: -1001, chat_name: 'Test', msg_id: 43,
      sender_id: 1, sender_name: 'Alice', content: 'sent', timestamp: '2026-01-01T00:00:00.000Z',
    }]
    const executeReply = vi.fn(async () => outcome)
    const executeGroup = vi.fn(async (): Promise<GroupCommandExecutionResult> => ({
      ok: true, data: { chat_id: -1001, invites: [], total: 0 },
    }))
    await expect(executeSelectedListenCommand(
      executable(parseSelectedListenCommand('/reply 42 hi', selected('/reply 42 hi'))),
      { executeReply, executeGroup },
    )).resolves.toEqual({ kind: 'reply', result: outcome })
    expect(executeReply).toHaveBeenCalledOnce()
    expect(executeGroup).not.toHaveBeenCalled()
  })

  it('calls only the group executor for group commands', async () => {
    const executeReply = vi.fn(async (): Promise<StoredMessageInput[]> => [])
    const groupOutcome: GroupCommandExecutionResult = { ok: true, data: { chat_id: -1001, invites: [], total: 0 } }
    const executeGroup = vi.fn(async () => groupOutcome)
    await expect(executeSelectedListenCommand(
      executable(parseSelectedListenCommand('/invite list', selected('/invite list'))),
      { executeReply, executeGroup },
    )).resolves.toEqual({ kind: 'group', result: groupOutcome })
    expect(executeGroup).toHaveBeenCalledOnce()
    expect(executeReply).not.toHaveBeenCalled()
  })

  it('propagates executor exceptions for the Ink boundary to catch', async () => {
    const failure = new Error('network failed')
    await expect(executeSelectedListenCommand(
      executable(parseSelectedListenCommand('/reply 42 hi', selected('/reply 42 hi'))),
      {
        executeReply: async () => { throw failure },
        executeGroup: async (): Promise<GroupCommandExecutionResult> => ({
          ok: true, data: { chat_id: -1001, invites: [], total: 0 },
        }),
      },
    )).rejects.toBe(failure)
  })
})
