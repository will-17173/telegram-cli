export type ArchiveChatState = {
  title: string
  file: string
  initial_since: string | null
  initial_until: string | null
  full_history: boolean
  last_message_id: number | null
  last_message_date: string | null
  last_run: string
}

export type ArchiveManifest = {
  schema_version: 1
  account_name: string
  account_user_id: number
  created_at: string
  updated_at: string
  chats: Record<string, ArchiveChatState>
}

export type ArchiveChatCompletion = {
  chat_id: number
  title: string
  file: string
  messages_archived: number
  media_archived: number
}

export type ArchiveChatFailure = {
  chat_id: number
  title: string
  error: string
}

export type ArchiveWarning = {
  chat_id: number | null
  code: string
  message: string
}

export type ArchiveCommandResult = {
  manifest: string
  completed: ArchiveChatCompletion[]
  failed: ArchiveChatFailure[]
  warnings: ArchiveWarning[]
}
