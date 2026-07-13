export type GroupCommandRisk = 'none' | 'confirm' | 'confirm-title'

export type GroupCommandValueKind =
  | 'user'
  | 'users'
  | 'text'
  | 'id'
  | 'ids'
  | 'duration'
  | 'toggle'
  | 'path'
  | 'permissions'
  | 'invite'

export interface GroupCommandArgument {
  name: string
  kind: GroupCommandValueKind
  required: boolean
  rest?: boolean
}

export interface GroupCommandDefinition {
  path: readonly [string, string]
  summary: string
  usage: string
  risk: GroupCommandRisk
  args: readonly GroupCommandArgument[]
  capability?: 'group' | 'supergroup' | 'forum' | 'admin' | 'creator'
}
