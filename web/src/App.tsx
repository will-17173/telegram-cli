import { useEffect, useMemo, useState } from 'react'
import {
  getJson,
  postJson,
  type AccountData,
  type ChatSummary,
  type MessageRow,
  type Page,
  type SyncTaskState,
} from './api.js'

const MESSAGE_LIMIT = 50
const SYNC_LIMIT = 500

export function App() {
  const [accounts, setAccounts] = useState<AccountData>({ current_account: null, accounts: [] })
  const [account, setAccount] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [selectedChat, setSelectedChat] = useState<ChatSummary | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [syncTask, setSyncTask] = useState<SyncTaskState>({ status: 'idle' })
  const [loadingChats, setLoadingChats] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getJson<AccountData>('/api/accounts')
      .then((data) => {
        setAccounts(data)
        setAccount(data.current_account ?? data.accounts[0]?.name ?? '')
      })
      .catch((caught) => setError(errorText(caught)))
  }, [])

  useEffect(() => {
    if (!account) return
    setLoadingChats(true)
    setError('')
    const params = new URLSearchParams({ account, limit: '100' })
    if (chatQuery.trim()) params.set('q', chatQuery.trim())

    getJson<Page<ChatSummary>>(`/api/chats?${params}`)
      .then((page) => {
        setChats(page.items)
        setSelectedChat((current) => {
          if (current != null && page.items.some((item) => item.chat_id === current.chat_id)) return current
          return page.items[0] ?? null
        })
      })
      .catch((caught) => setError(errorText(caught)))
      .finally(() => setLoadingChats(false))
  }, [account, chatQuery])

  useEffect(() => {
    if (!account || selectedChat == null) return
    void loadMessages(null)
  }, [account, selectedChat?.chat_id])

  const selectedSummary = useMemo(() => {
    if (selectedChat == null) return 'No chat selected'
    return `${selectedChat.msg_count} messages from ${formatDate(selectedChat.first_msg)} to ${formatDate(selectedChat.last_msg)}`
  }, [selectedChat])

  async function loadMessages(cursor: string | null) {
    if (!account || selectedChat == null) return
    setLoadingMessages(true)
    setError('')
    try {
      const params = new URLSearchParams({
        account,
        chatId: String(selectedChat.chat_id),
        limit: String(MESSAGE_LIMIT),
      })
      if (keyword.trim()) params.set('q', keyword.trim())
      if (since) params.set('since', new Date(since).toISOString())
      if (until) params.set('until', new Date(until).toISOString())
      if (cursor) params.set('cursor', cursor)

      const page = await getJson<Page<MessageRow>>(`/api/messages?${params}`)
      setMessages((current) => cursor ? current.concat(page.items) : page.items)
      setNextCursor(page.next_cursor ?? null)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoadingMessages(false)
    }
  }

  async function syncCurrentChat() {
    if (!account || selectedChat == null || syncTask.status === 'running') return
    setError('')
    setSyncTask({
      status: 'running',
      account,
      chat_id: selectedChat.chat_id,
      limit: SYNC_LIMIT,
      started_at: new Date().toISOString(),
    })
    try {
      const state = await postJson<SyncTaskState>('/api/sync-task', {
        account,
        chatId: selectedChat.chat_id,
        limit: SYNC_LIMIT,
      })
      setSyncTask(state)
      await loadMessages(null)
    } catch (caught) {
      setSyncTask({ status: 'idle' })
      setError(errorText(caught))
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">tg</span>
          <strong>Telegram CLI</strong>
        </div>
        <label className="account-picker">
          <span>Account</span>
          <select value={account} onChange={(event) => { setAccount(event.target.value); setSelectedChat(null); setMessages([]) }}>
            {accounts.accounts.map((item) => (
              <option key={item.name} value={item.name}>
                {item.display_name || item.username || item.name}
              </option>
            ))}
          </select>
        </label>
        <span className={`sync-pill sync-pill-${syncTask.status}`}>Sync: {syncTask.status}</span>
      </header>

      {error && <div className="error-strip">{error}</div>}

      <section className="workspace" aria-label="Telegram message browser">
        <aside className="sidebar">
          <div className="sidebar-tools">
            <label>
              <span>Chats</span>
              <input value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} placeholder="Search chats" />
            </label>
          </div>
          <div className="chat-list" aria-busy={loadingChats}>
            {chats.map((chat) => (
              <button
                className={chat.chat_id === selectedChat?.chat_id ? 'chat-row chat-row-active' : 'chat-row'}
                key={chat.chat_id}
                onClick={() => setSelectedChat(chat)}
                type="button"
              >
                <span className="chat-name">{chat.chat_name ?? `Chat ${chat.chat_id}`}</span>
                <span className="chat-meta">{chat.msg_count} · {formatDate(chat.last_msg)}</span>
              </button>
            ))}
            {!loadingChats && chats.length === 0 && <p className="empty-note">No local chats found.</p>}
          </div>
        </aside>

        <section className="messages-pane">
          <div className="chat-header">
            <div>
              <h1>{selectedChat?.chat_name ?? (selectedChat == null ? 'Select a chat' : `Chat ${selectedChat.chat_id}`)}</h1>
              <p>{selectedSummary}</p>
            </div>
            <button className="primary-action" onClick={syncCurrentChat} disabled={selectedChat == null || syncTask.status === 'running'} type="button">
              Sync current chat
            </button>
          </div>

          <div className="filters">
            <label>
              <span>Keyword</span>
              <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="sender or text" />
            </label>
            <label>
              <span>Since</span>
              <input type="datetime-local" value={since} onChange={(event) => setSince(event.target.value)} />
            </label>
            <label>
              <span>Until</span>
              <input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} />
            </label>
            <button onClick={() => void loadMessages(null)} disabled={selectedChat == null || loadingMessages} type="button">
              Search
            </button>
          </div>

          <ol className="message-list" aria-busy={loadingMessages}>
            {messages.map((message) => (
              <li key={message.id} className="message-row">
                <time>{formatDate(message.timestamp)}</time>
                <div>
                  <strong>{message.sender_name ?? message.sender_id ?? 'Unknown'}</strong>
                  <p>{message.content ?? ''}</p>
                  <small>Telegram message {message.msg_id}</small>
                </div>
              </li>
            ))}
          </ol>

          {!loadingMessages && selectedChat != null && messages.length === 0 && <p className="empty-note">No messages match the current filters.</p>}
          {nextCursor && (
            <button className="load-more" onClick={() => void loadMessages(nextCursor)} disabled={loadingMessages} type="button">
              Load earlier
            </button>
          )}
        </section>
      </section>
    </main>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
