import {
  GROUP_COMMAND_CATALOG,
  GROUP_COMMANDS,
  type GroupCommandKey,
} from '../group-commands/catalog.js'

export const REPLY_COMMAND_USAGE = 'reply <message-id> [content] [--file <path> ...]'

type GroupCommand = (typeof GROUP_COMMANDS)[number]

export interface ReplyListenCommandDefinition {
  readonly id: 'reply'
  readonly kind: 'reply'
  readonly category: 'general'
  readonly path: readonly ['reply']
  readonly summary: 'Reply to a message'
  readonly usage: typeof REPLY_COMMAND_USAGE
  readonly keywords: readonly ['reply', 'respond', 'message', 'file']
}

export interface GroupListenCommandDefinition {
  readonly id: `group:${GroupCommandKey}`
  readonly kind: 'group'
  readonly category: 'group'
  readonly path: GroupCommand['path']
  readonly summary: GroupCommand['summary']
  readonly usage: GroupCommand['usage']
  readonly keywords: readonly string[]
  readonly groupKey: GroupCommandKey
  readonly groupDefinition: (typeof GROUP_COMMAND_CATALOG)[GroupCommandKey]
}

export type ListenCommandDefinition =
  | ReplyListenCommandDefinition
  | GroupListenCommandDefinition

const replyCommand = freezeDefinition({
  id: 'reply',
  kind: 'reply',
  category: 'general',
  path: ['reply'],
  summary: 'Reply to a message',
  usage: REPLY_COMMAND_USAGE,
  keywords: ['reply', 'respond', 'message', 'file'],
} as const)

const groupCommands = GROUP_COMMANDS.map((groupDefinition): GroupListenCommandDefinition => {
  const groupKey = groupCommandKey(groupDefinition)
  return freezeDefinition({
    id: `group:${groupKey}`,
    kind: 'group',
    category: 'group',
    path: groupDefinition.path,
    summary: groupDefinition.summary,
    usage: groupDefinition.usage,
    keywords: [...groupDefinition.path],
    groupKey,
    groupDefinition: GROUP_COMMAND_CATALOG[groupKey],
  })
})

export const LISTEN_COMMANDS: readonly ListenCommandDefinition[] = Object.freeze([
  replyCommand,
  ...groupCommands,
])

function freezeDefinition<
  const T extends { readonly path: readonly string[]; readonly keywords: readonly string[] },
>(definition: T): T {
  Object.freeze(definition.path)
  Object.freeze(definition.keywords)
  return Object.freeze(definition)
}

function groupCommandKey(definition: GroupCommand): GroupCommandKey {
  const key = definition.path.join(' ')
  if (key in GROUP_COMMAND_CATALOG) return key as GroupCommandKey
  throw new Error(`Group command is missing from catalog: ${key}`)
}
