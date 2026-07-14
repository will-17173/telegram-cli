export type ApiSuccess<T> = { ok: true; data: T }

export type ApiFailure = { ok: false; error: { code: string; message: string; details?: unknown } }

export type ApiResult<T> = ApiSuccess<T> | ApiFailure

export type WebAccountSummary = {
  name: string
  user_id: number
  username: string
  display_name: string
  auth_state: 'authenticated' | 'logged_out'
}

export type WebChatSummary = {
  chat_id: number
  chat_name: string | null
  msg_count: number
  first_msg: string
  last_msg: string
}

export type WebMessage = {
  id: number
  platform: string
  chat_id: number
  chat_name: string | null
  msg_id: number
  sender_id: number | null
  sender_name: string | null
  content: string | null
  timestamp: string
}

export type WebPage<T> = {
  items: T[]
  total?: number
  next_cursor?: string | null
}
