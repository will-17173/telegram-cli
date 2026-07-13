import {
  GROUP_COMMAND_CATALOG,
  type GroupCommandKey,
} from '../group-commands/catalog.js'
import { REPLY_COMMAND_USAGE } from '../services/listen-composer-command.js'

export { REPLY_COMMAND_USAGE }

export interface ReplyListenCommandDefinition {
  readonly id: 'reply'
  readonly kind: 'reply'
  readonly category: 'general'
  readonly path: readonly ['reply']
  readonly summary: 'Reply to a message'
  readonly usage: typeof REPLY_COMMAND_USAGE
  readonly keywords: readonly ['reply', 'respond', 'message', 'file']
}

type GroupListenCommandDefinitionByKey = {
  [K in GroupCommandKey]: {
    readonly id: `group:${K}`
    readonly kind: 'group'
    readonly category: 'group'
    readonly path: (typeof GROUP_COMMAND_CATALOG)[K]['path']
    readonly summary: (typeof GROUP_COMMAND_CATALOG)[K]['summary']
    readonly usage: (typeof GROUP_COMMAND_CATALOG)[K]['usage']
    readonly keywords: readonly string[]
    readonly groupKey: K
    readonly groupDefinition: (typeof GROUP_COMMAND_CATALOG)[K]
  }
}

export type GroupListenCommandDefinition =
  GroupListenCommandDefinitionByKey[GroupCommandKey]

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

const groupCommands = [
  createGroupCommand(GROUP_COMMAND_CATALOG['member add']), createGroupCommand(GROUP_COMMAND_CATALOG['member kick']),
  createGroupCommand(GROUP_COMMAND_CATALOG['member ban']), createGroupCommand(GROUP_COMMAND_CATALOG['member unban']),
  createGroupCommand(GROUP_COMMAND_CATALOG['member mute']), createGroupCommand(GROUP_COMMAND_CATALOG['member unmute']),
  createGroupCommand(GROUP_COMMAND_CATALOG['member purge']), createGroupCommand(GROUP_COMMAND_CATALOG['admin promote']),
  createGroupCommand(GROUP_COMMAND_CATALOG['admin demote']), createGroupCommand(GROUP_COMMAND_CATALOG['admin rank']),
  createGroupCommand(GROUP_COMMAND_CATALOG['admin transfer-owner']), createGroupCommand(GROUP_COMMAND_CATALOG['chat title']),
  createGroupCommand(GROUP_COMMAND_CATALOG['chat description']), createGroupCommand(GROUP_COMMAND_CATALOG['chat username']),
  createGroupCommand(GROUP_COMMAND_CATALOG['chat photo']), createGroupCommand(GROUP_COMMAND_CATALOG['chat slowmode']),
  createGroupCommand(GROUP_COMMAND_CATALOG['chat ttl']), createGroupCommand(GROUP_COMMAND_CATALOG['chat protect']),
  createGroupCommand(GROUP_COMMAND_CATALOG['chat join-requests']), createGroupCommand(GROUP_COMMAND_CATALOG['chat join-to-send']),
  createGroupCommand(GROUP_COMMAND_CATALOG['chat default-permissions']), createGroupCommand(GROUP_COMMAND_CATALOG['chat sticker-set']),
  createGroupCommand(GROUP_COMMAND_CATALOG['chat leave']), createGroupCommand(GROUP_COMMAND_CATALOG['chat delete']),
  createGroupCommand(GROUP_COMMAND_CATALOG['invite list']), createGroupCommand(GROUP_COMMAND_CATALOG['invite show']),
  createGroupCommand(GROUP_COMMAND_CATALOG['invite create']), createGroupCommand(GROUP_COMMAND_CATALOG['invite edit']),
  createGroupCommand(GROUP_COMMAND_CATALOG['invite revoke']), createGroupCommand(GROUP_COMMAND_CATALOG['invite members']),
  createGroupCommand(GROUP_COMMAND_CATALOG['invite approve']), createGroupCommand(GROUP_COMMAND_CATALOG['invite decline']),
  createGroupCommand(GROUP_COMMAND_CATALOG['invite approve-all']), createGroupCommand(GROUP_COMMAND_CATALOG['invite decline-all']),
  createGroupCommand(GROUP_COMMAND_CATALOG['topic list']), createGroupCommand(GROUP_COMMAND_CATALOG['topic create']),
  createGroupCommand(GROUP_COMMAND_CATALOG['topic edit']), createGroupCommand(GROUP_COMMAND_CATALOG['topic close']),
  createGroupCommand(GROUP_COMMAND_CATALOG['topic reopen']), createGroupCommand(GROUP_COMMAND_CATALOG['topic pin']),
  createGroupCommand(GROUP_COMMAND_CATALOG['topic unpin']), createGroupCommand(GROUP_COMMAND_CATALOG['topic reorder']),
  createGroupCommand(GROUP_COMMAND_CATALOG['topic delete']), createGroupCommand(GROUP_COMMAND_CATALOG['topic general-hidden']),
  createGroupCommand(GROUP_COMMAND_CATALOG['message pin']), createGroupCommand(GROUP_COMMAND_CATALOG['message unpin']),
  createGroupCommand(GROUP_COMMAND_CATALOG['message unpin-all']), createGroupCommand(GROUP_COMMAND_CATALOG['message delete']),
] as const

type CatalogCommand = (typeof GROUP_COMMAND_CATALOG)[GroupCommandKey]
type GroupKeyOf<D extends CatalogCommand> = D['path'] extends readonly [
  infer Family extends string,
  infer Action extends string,
] ? `${Family} ${Action}` : never

function createGroupCommand<const D extends CatalogCommand>(groupDefinition: D) {
  const groupKey = groupDefinition.path.join(' ') as GroupKeyOf<D>
  return freezeDefinition({
    id: `group:${groupKey}` as const,
    kind: 'group',
    category: 'group',
    path: groupDefinition.path as D['path'],
    summary: groupDefinition.summary as D['summary'],
    usage: groupDefinition.usage as D['usage'],
    keywords: [...groupDefinition.path],
    groupKey,
    groupDefinition,
  })
}

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
