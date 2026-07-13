import { describe, expect, it } from 'vitest'

import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'

const expectedPaths = [
  'member add',
  'member kick',
  'member ban',
  'member unban',
  'member mute',
  'member unmute',
  'member purge',
  'admin promote',
  'admin demote',
  'admin rank',
  'admin transfer-owner',
  'chat title',
  'chat description',
  'chat username',
  'chat photo',
  'chat slowmode',
  'chat ttl',
  'chat protect',
  'chat join-requests',
  'chat join-to-send',
  'chat default-permissions',
  'chat sticker-set',
  'chat leave',
  'chat delete',
  'invite list',
  'invite show',
  'invite create',
  'invite edit',
  'invite revoke',
  'invite members',
  'invite approve',
  'invite decline',
  'invite approve-all',
  'invite decline-all',
  'topic list',
  'topic create',
  'topic edit',
  'topic close',
  'topic reopen',
  'topic pin',
  'topic unpin',
  'topic reorder',
  'topic delete',
  'topic general-hidden',
  'message pin',
  'message unpin',
  'message unpin-all',
  'message delete'
] as const

function commandPath(command: (typeof GROUP_COMMANDS)[number]): string {
  return command.path.join(' ')
}

describe('GROUP_COMMANDS', () => {
  it('contains the complete command tree without flattened aliases', () => {
    expect(GROUP_COMMANDS.map(commandPath).sort()).toEqual([...expectedPaths].sort())
  })

  it('uses each command path exactly once', () => {
    const paths = GROUP_COMMANDS.map(commandPath)

    expect(new Set(paths).size).toBe(paths.length)
  })

  it('contains exactly the supported top-level groups', () => {
    const groups = new Set(GROUP_COMMANDS.map((command) => command.path[0]))

    expect([...groups].sort()).toEqual([
      'admin',
      'chat',
      'invite',
      'member',
      'message',
      'topic'
    ])
  })

  it('marks query-only invite and topic commands as risk-free', () => {
    const risks = new Map(GROUP_COMMANDS.map((command) => [commandPath(command), command.risk]))

    expect(risks.get('invite list')).toBe('none')
    expect(risks.get('invite show')).toBe('none')
    expect(risks.get('invite members')).toBe('none')
    expect(risks.get('topic list')).toBe('none')
  })

  it('requires confirmation for destructive commands', () => {
    const risks = new Map(GROUP_COMMANDS.map((command) => [commandPath(command), command.risk]))

    for (const path of [
      'member ban',
      'member kick',
      'member purge',
      'admin transfer-owner',
      'chat leave',
      'invite revoke',
      'invite approve-all',
      'invite decline-all',
      'topic delete',
      'message delete',
      'message unpin-all'
    ]) {
      expect(risks.get(path), path).not.toBe('none')
    }
    expect(risks.get('chat delete')).toBe('confirm-title')
  })

  it('is frozen against runtime mutation', () => {
    expect(Object.isFrozen(GROUP_COMMANDS)).toBe(true)
  })
})
