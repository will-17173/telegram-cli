import { describe, expect, it, vi } from 'vitest'

import {
  dispatchListenCommand,
  executeSelectedListenCommand,
  type ListenCommandExecutionOutcome,
} from '../../src/listen-commands/dispatch.js'
import { matchListenCommands } from '../../src/listen-commands/match.js'

const selected = (input: string, index = 0) => matchListenCommands(input)[index]!

describe('dispatchListenCommand', () => {
  it('parses text and file replies', () => {
    expect(dispatchListenCommand('/reply 42 hello', selected('/reply 42 hello'))).toEqual({
      kind: 'reply',
      command: { kind: 'reply', reply: 42, content: 'hello', files: [] },
    })
    expect(dispatchListenCommand('/reply 42 note --file ./a.jpg', selected('/reply 42 note --file ./a.jpg'))).toEqual({
      kind: 'reply',
      command: { kind: 'reply', reply: 42, content: 'note', files: ['./a.jpg'] },
    })
  })

  it('preserves reply parser errors and usage', () => {
    expect(dispatchListenCommand('/reply nope', selected('/reply nope'))).toEqual({
      kind: 'error',
      message: 'reply message ID must be a positive integer',
      usage: 'reply <message-id> [content] [--file <path> ...]',
    })
  })

  it('parses group writes and queries into typed requests', () => {
    const ban = dispatchListenCommand('/member ban @alice', selected('/member ban @alice'))
    expect(ban.kind).toBe('group')
    if (ban.kind === 'group') {
      expect(ban.request.key).toBe('member ban')
      if (ban.request.key === 'member ban') expect(ban.request.values).toEqual({ user: '@alice' })
    }

    const query = dispatchListenCommand('/invite list', selected('/invite list'))
    expect(query.kind).toBe('group')
    if (query.kind === 'group') {
      expect(query.request.key).toBe('invite list')
      if (query.request.key === 'invite list') expect(query.request.values).toEqual({})
    }
  })

  it('returns structured group parser errors', () => {
    expect(dispatchListenCommand('/member ban', selected('/member ban'))).toEqual({
      kind: 'error',
      message: 'Missing argument: user',
      usage: 'group member ban <user>',
    })
  })

  it('completes partial paths', () => {
    expect(dispatchListenCommand('/mem b', selected('/mem b'))).toEqual({
      kind: 'complete', input: '/member ban ',
    })
  })

  it('rejects a selection that is stale for the current input', () => {
    const stale = selected('/member ban @alice')
    expect(dispatchListenCommand('/reply 42 hi', stale)).toEqual({
      kind: 'error', message: 'Selected command no longer matches the input',
    })
  })

  it('rejects a non-canonical selected definition', () => {
    const match = selected('/reply 42 hi')
    const forged = { ...match, definition: { ...match.definition } }
    expect(dispatchListenCommand('/reply 42 hi', forged)).toEqual({
      kind: 'error', message: 'Selected command is not canonical',
    })
  })
})

describe('executeSelectedListenCommand', () => {
  it('calls only the reply executor for reply commands', async () => {
    const outcome: ListenCommandExecutionOutcome = { status: 'sent' }
    const executeReply = vi.fn(async () => outcome)
    const executeGroup = vi.fn(async () => ({ status: 'grouped' } satisfies ListenCommandExecutionOutcome))
    await expect(executeSelectedListenCommand(
      dispatchListenCommand('/reply 42 hi', selected('/reply 42 hi')),
      { executeReply, executeGroup },
    )).resolves.toBe(outcome)
    expect(executeReply).toHaveBeenCalledOnce()
    expect(executeGroup).not.toHaveBeenCalled()
  })

  it('calls only the group executor for group commands', async () => {
    const executeReply = vi.fn(async () => ({ status: 'sent' } satisfies ListenCommandExecutionOutcome))
    const executeGroup = vi.fn(async () => ({ status: 'grouped' } satisfies ListenCommandExecutionOutcome))
    await executeSelectedListenCommand(
      dispatchListenCommand('/invite list', selected('/invite list')),
      { executeReply, executeGroup },
    )
    expect(executeGroup).toHaveBeenCalledOnce()
    expect(executeReply).not.toHaveBeenCalled()
  })

  it('propagates executor exceptions for the Ink boundary to catch', async () => {
    const failure = new Error('network failed')
    await expect(executeSelectedListenCommand(
      dispatchListenCommand('/reply 42 hi', selected('/reply 42 hi')),
      {
        executeReply: async () => { throw failure },
        executeGroup: async () => ({ status: 'unused' }),
      },
    )).rejects.toBe(failure)
  })
})
