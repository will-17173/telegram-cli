export type DesktopCategory = 'telegram' | 'messages' | 'groups' | 'contacts' | 'folders' | 'notifications' | 'accounts' | 'settings' | 'data'

export type DesktopField = {
  name: string
  description: string
  required: boolean
  variadic: boolean
  kind: 'string' | 'boolean'
  flag?: string
  negated?: boolean
  repeatable?: boolean
  defaultValue?: string | boolean | string[]
  choices?: string[]
}

export type DesktopCommand = {
  id: string
  path: string[]
  category: DesktopCategory
  description: string
  arguments: DesktopField[]
  options: DesktopField[]
  requiresAccount: boolean
  destructive: boolean
  longRunning: boolean
}

export type DesktopCommandInput = {
  commandId: string
  account?: string
  arguments?: Record<string, string | string[]>
  options?: Record<string, string | boolean | string[]>
  confirmed?: boolean
}

export type DesktopListenInput = {
  chat: string
  text?: string
  files?: string[]
  reply?: number
  linkPreview?: boolean
}

export type DesktopTask = {
  id: string
  commandId: string
  account: string | null
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  stdout: string
  stderr: string
  result: unknown | null
  truncated: boolean
}

export type DesktopAuthSession = {
  id: string
  requestedAccount?: string
  status: 'phone' | 'code' | 'password' | 'working' | 'done' | 'error' | 'cancelled'
  hint?: string
  error?: { code: string; message: string }
  account?: { name: string; user_id: number; username: string; display_name: string; auth_state: 'authenticated' | 'logged_out' }
}
