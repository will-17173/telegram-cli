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
  readonly name: string
  readonly kind: GroupCommandValueKind
  readonly required: boolean
  readonly rest?: boolean
}

export interface GroupCommandOption {
  readonly name: string
  readonly long: `--${string}`
  readonly kind: GroupCommandValueKind
  readonly summary: string
  readonly required?: boolean
}

export interface GroupCommandDefinition {
  readonly path: readonly [string, string]
  readonly summary: string
  readonly usage: string
  readonly risk: GroupCommandRisk
  readonly args: readonly GroupCommandArgument[]
  readonly options: readonly GroupCommandOption[]
  readonly capability?: 'group' | 'supergroup' | 'forum' | 'admin' | 'creator'
}
