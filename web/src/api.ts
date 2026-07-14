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
  sender_name: string | null
  sender_id: number | null
  content: string | null
  timestamp: string
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
  const payload = await response.json() as ApiResult<T>
  if (!payload.ok) throw new Error(`${payload.error.code}: ${payload.error.message}`)
  return payload.data
}
