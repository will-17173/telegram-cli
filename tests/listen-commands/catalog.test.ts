import { describe, expect, it } from 'vitest'

import { GROUP_COMMAND_CATALOG, GROUP_COMMANDS } from '../../src/group-commands/catalog.js'
import {
  LISTEN_COMMANDS,
  type GroupListenCommandDefinition,
} from '../../src/listen-commands/catalog.js'
import { REPLY_COMMAND_USAGE } from '../../src/services/listen-composer-command.js'

function assertMemberBanNarrowing(command: GroupListenCommandDefinition): void {
  if (command.groupKey !== 'member ban') return

  const path: typeof GROUP_COMMAND_CATALOG['member ban']['path'] = command.path
  const definition: typeof GROUP_COMMAND_CATALOG['member ban'] = command.groupDefinition
  void path
  void definition
}

const invalidMemberBanEntry = {
  id: 'group:member ban',
  kind: 'group',
  category: 'group',
  path: GROUP_COMMAND_CATALOG['chat title'].path,
  summary: GROUP_COMMAND_CATALOG['chat title'].summary,
  usage: GROUP_COMMAND_CATALOG['chat title'].usage,
  keywords: ['member', 'ban'],
  groupKey: 'member ban',
  groupDefinition: GROUP_COMMAND_CATALOG['chat title'],
} as const

// @ts-expect-error a member-ban entry cannot carry the chat-title definition or path
const invalidGroupCommand: GroupListenCommandDefinition = invalidMemberBanEntry
void invalidGroupCommand
void assertMemberBanNarrowing

describe('LISTEN_COMMANDS', () => {
  it('starts with the general reply command', () => {
    expect(LISTEN_COMMANDS[0]).toEqual({
      id: 'reply',
      kind: 'reply',
      category: 'general',
      path: ['reply'],
      summary: 'Reply to a message',
      usage: REPLY_COMMAND_USAGE,
      keywords: ['reply', 'respond', 'message', 'file'],
    })
  })

  it('follows reply with every group command in stable catalog order', () => {
    const groupCommands = LISTEN_COMMANDS.filter(command => command.kind === 'group')

    expect(groupCommands).toHaveLength(GROUP_COMMANDS.length)
    groupCommands.forEach((command, index) => {
      const groupDefinition = GROUP_COMMANDS[index]!
      const key = groupDefinition.path.join(' ') as keyof typeof GROUP_COMMAND_CATALOG

      expect(command).toMatchObject({
        id: `group:${key}`,
        kind: 'group',
        category: 'group',
        path: groupDefinition.path,
        summary: groupDefinition.summary,
        usage: groupDefinition.usage,
        keywords: expect.arrayContaining([...groupDefinition.path]),
        groupKey: key,
      })
      expect(command.groupDefinition).toBe(GROUP_COMMAND_CATALOG[key])
    })
  })

  it('has unique IDs and paths', () => {
    const ids = LISTEN_COMMANDS.map(command => command.id)
    const paths = LISTEN_COMMANDS.map(command => command.path.join(' '))

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('is deeply frozen', () => {
    expect(Object.isFrozen(LISTEN_COMMANDS)).toBe(true)
    for (const command of LISTEN_COMMANDS) {
      expect(Object.isFrozen(command)).toBe(true)
      expect(Object.isFrozen(command.path)).toBe(true)
      expect(Object.isFrozen(command.keywords)).toBe(true)
    }
  })
})
