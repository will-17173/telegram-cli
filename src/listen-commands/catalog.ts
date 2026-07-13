import {
  GROUP_COMMAND_CATALOG,
  GROUP_COMMANDS,
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

type GroupDefinitionFor<K extends GroupCommandKey> =
  (typeof GROUP_COMMAND_CATALOG)[K]
type GroupListenCommandFor<K extends GroupCommandKey> =
  GroupListenCommandDefinitionByKey[K]

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

const groupCommands: readonly GroupListenCommandDefinition[] =
  GROUP_COMMANDS.map(groupDefinition => toListenGroupCommand(groupDefinition))

function toListenGroupCommand<K extends GroupCommandKey>(
  groupDefinition: GroupDefinitionFor<K>,
): GroupListenCommandFor<K> {
  const joinedPath = groupDefinition.path.join(' ')
  if (!isGroupCommandKey(joinedPath) || GROUP_COMMAND_CATALOG[joinedPath] !== groupDefinition) {
    throw new Error(`Non-canonical group command definition: ${joinedPath}`)
  }

  const groupKey = joinedPath as K
  const definition = freezeDefinition({
    id: `group:${groupKey}` as `group:${K}`,
    kind: 'group',
    category: 'group',
    path: groupDefinition.path,
    summary: groupDefinition.summary,
    usage: groupDefinition.usage,
    keywords: [...groupDefinition.path],
    groupKey,
    groupDefinition,
  })

  // The canonical guard above proves the runtime key and definition share K.
  return definition as unknown as GroupListenCommandFor<K>
}

function isGroupCommandKey(value: string): value is GroupCommandKey {
  return Object.hasOwn(GROUP_COMMAND_CATALOG, value)
}

const listenCommands: readonly ListenCommandDefinition[] = [
  replyCommand,
  ...groupCommands,
]

assertUniqueListenCommands(listenCommands)
export const LISTEN_COMMANDS: readonly ListenCommandDefinition[] = Object.freeze(listenCommands)

export function assertUniqueListenCommands(
  commands: readonly { readonly id: string; readonly path: readonly string[] }[],
): void {
  const ids = new Set<string>()
  const paths = new Set<string>()

  for (const command of commands) {
    if (ids.has(command.id)) throw new Error(`Duplicate listen command ID: ${command.id}`)
    ids.add(command.id)

    const path = command.path.join(' ')
    if (paths.has(path)) throw new Error(`Duplicate listen command path: ${path}`)
    paths.add(path)
  }
}

function freezeDefinition<
  const T extends { readonly path: readonly string[]; readonly keywords: readonly string[] },
>(definition: T): T {
  Object.freeze(definition.path)
  Object.freeze(definition.keywords)
  return Object.freeze(definition)
}
