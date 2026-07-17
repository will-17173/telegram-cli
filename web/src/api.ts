export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export type AccountSummary = {
  name: string
  user_id: number
  username: string
  display_name: string
  auth_state: 'authenticated' | 'logged_out'
}

export type AccountData = {
  current_account: string | null
  accounts: AccountSummary[]
}

export type ChatSummary = {
  chat_id: number
  chat_name: string | null
  msg_count: number
  first_msg: string
  last_msg: string
}

export type MessageRow = {
  id: number
  msg_id: number
  msg_ids: number[]
  grouped_id: string | null
  sender_name: string | null
  sender_id: number | null
  content: string | null
  timestamp: string
  media_summary: string | null
  downloaded: boolean
  reply_context?: ReplyContext
  attachments: MessageAttachment[]
}

export type ReplyContext =
  | { message_id: number; resolved: false }
  | {
    message_id: number
    resolved: true
    timestamp: string
    sender_id: number | null
    sender_name: string | null
    content: string | null
    attachments: MessageAttachment[]
  }

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type MessageAttachment = {
  chat_id: number
  msg_id: number
  attachment_index: number
  parent_attachment_index: number | null
  role: string
  kind: string
  subtype: string | null
  downloadable: boolean
  downloaded: boolean
  downloaded_at: string | null
  download_path: string | null
  file_id: string | null
  unique_file_id: string | null
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  width: number | null
  height: number | null
  duration_seconds: number | null
  thumbnail_file_id: string | null
  thumbnail_unique_file_id: string | null
  thumbnail_width: number | null
  thumbnail_height: number | null
  emoji: string | null
  title: string | null
  performer: string | null
  latitude: number | null
  longitude: number | null
  address: string | null
  phone_number: string | null
  url: string | null
  preview_jpeg_base64: string | null
  metadata: JsonValue
}

export type Page<T> = {
  items: T[]
  total?: number
  next_cursor?: string | null
}

export type SyncTaskState =
  | { status: 'idle' }
  | { status: 'running'; account: string; chat_id: number; limit: number; started_at: string }
  | { status: 'done'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; synced: number }
  | { status: 'error'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; error: { code: string; message: string; details?: unknown } }

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  return unwrap<T>(response)
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return unwrap<T>(response)
}

async function unwrap<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    const text = await response.text()
    throw new Error(text.trim() || `HTTP ${response.status}`)
  }
  const payload = await response.json() as ApiResult<T>
  if (!payload.ok) throw new Error(`${payload.error.code}: ${payload.error.message}`)
  return payload.data
}
