import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getJson,
  postJson,
  type AccountData,
  type ChatSummary,
  type MessageAttachment,
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
  const [senderId, setSenderId] = useState('')
  const [senderName, setSenderName] = useState('')
  const [text, setText] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [syncTask, setSyncTask] = useState<SyncTaskState>({ status: 'idle' })
  const [downloadStatus, setDownloadStatus] = useState<Record<string, string>>({})
  const [loadingChats, setLoadingChats] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [error, setError] = useState('')
  const chatRequestId = useRef(0)
  const messageRequestId = useRef(0)
  const accountRef = useRef(account)
  const selectedChatRef = useRef(selectedChat)

  accountRef.current = account
  selectedChatRef.current = selectedChat

  useEffect(() => {
    getJson<AccountData>('/api/accounts')
      .then((data) => {
        setAccounts(data)
        setAccount(data.current_account ?? data.accounts[0]?.name ?? '')
      })
      .catch((caught) => setError(errorText(caught)))
  }, [])

  useEffect(() => {
    const requestId = chatRequestId.current + 1
    chatRequestId.current = requestId
    if (!account) {
      setChats([])
      setSelectedChat(null)
      setMessages([])
      setNextCursor(null)
      return
    }
    setLoadingChats(true)
    setError('')
    const params = new URLSearchParams({ account, limit: '100' })
    if (chatQuery.trim()) params.set('q', chatQuery.trim())

    getJson<Page<ChatSummary>>(`/api/chats?${params}`)
      .then((page) => {
        if (requestId !== chatRequestId.current) return
        setChats(page.items)
        if (page.items.length === 0) {
          messageRequestId.current += 1
          setMessages([])
          setNextCursor(null)
        }
        const current = selectedChatRef.current
        const next = current != null && page.items.some((item) => item.chat_id === current.chat_id)
          ? current
          : page.items[0] ?? null
        if (next?.chat_id !== current?.chat_id) {
          messageRequestId.current += 1
          setMessages([])
          setNextCursor(null)
        }
        setSelectedChat(next)
      })
      .catch((caught) => {
        if (requestId === chatRequestId.current) setError(errorText(caught))
      })
      .finally(() => {
        if (requestId === chatRequestId.current) setLoadingChats(false)
      })
  }, [account, chatQuery])

  useEffect(() => {
    if (!account || selectedChat == null) {
      messageRequestId.current += 1
      setMessages([])
      setNextCursor(null)
      setLoadingMessages(false)
      return
    }
    void loadMessages(null)
  }, [account, selectedChat?.chat_id])

  const selectedSummary = useMemo(() => {
    if (selectedChat == null) return 'No chat selected'
    return `${selectedChat.msg_count} messages from ${formatDate(selectedChat.first_msg)} to ${formatDate(selectedChat.last_msg)}`
  }, [selectedChat])

  async function loadMessages(cursor: string | null) {
    if (!account || selectedChat == null) return
    const requestId = messageRequestId.current + 1
    messageRequestId.current = requestId
    const requestAccount = account
    const requestChat = selectedChat
    const requestSenderId = senderId.trim()
    const requestSenderName = senderName.trim()
    const requestText = text.trim()
    const requestSince = since
    const requestUntil = until
    setLoadingMessages(true)
    setError('')
    try {
      const params = new URLSearchParams({
        account: requestAccount,
        chatId: String(requestChat.chat_id),
        limit: String(MESSAGE_LIMIT),
      })
      if (requestSenderId) params.set('senderId', requestSenderId)
      if (requestSenderName) params.set('senderName', requestSenderName)
      if (requestText) params.set('text', requestText)
      if (requestSince) params.set('since', new Date(requestSince).toISOString())
      if (requestUntil) params.set('until', new Date(requestUntil).toISOString())
      if (cursor) params.set('cursor', cursor)

      const page = await getJson<Page<MessageRow>>(`/api/messages?${params}`)
      if (requestId !== messageRequestId.current) return
      setMessages((current) => cursor ? current.concat(page.items) : page.items)
      setNextCursor(page.next_cursor ?? null)
    } catch (caught) {
      if (requestId === messageRequestId.current) setError(errorText(caught))
    } finally {
      if (requestId === messageRequestId.current) setLoadingMessages(false)
    }
  }

  async function downloadAttachments(attachments: MessageAttachment[]) {
    if (!account || attachments.length === 0) return
    const keys = attachments.map((attachment) => attachment.key)
    setDownloadStatus((current) => {
      const next = { ...current }
      for (const key of keys) next[key] = 'Downloading'
      return next
    })
    setError('')
    try {
      const result = await postJson<{ downloaded: Array<{ path: string }> }>('/api/download-media', {
        account,
        attachments: attachments.map((attachment) => ({
          chat_id: attachment.chat_id,
          msg_id: attachment.msg_id,
          file_name: attachment.file_name,
        })),
      })
      const destination = result.downloaded.length === 1 ? result.downloaded[0]?.path : `${result.downloaded.length} files`
      setDownloadStatus((current) => {
        const next = { ...current }
        for (const key of keys) next[key] = destination == null ? 'Downloaded' : `Downloaded to ${destination}`
        return next
      })
    } catch (caught) {
      const message = errorText(caught)
      setError(message)
      setDownloadStatus((current) => {
        const next = { ...current }
        for (const key of keys) next[key] = message
        return next
      })
    }
  }

  async function syncCurrentChat() {
    if (!account || selectedChat == null || syncTask.status === 'running') return
    const syncAccount = account
    const syncChat = selectedChat
    setError('')
    setSyncTask({
      status: 'running',
      account: syncAccount,
      chat_id: syncChat.chat_id,
      limit: SYNC_LIMIT,
      started_at: new Date().toISOString(),
    })
    try {
      const state = await postJson<SyncTaskState>('/api/sync-task', {
        account: syncAccount,
        chatId: syncChat.chat_id,
        limit: SYNC_LIMIT,
      })
      setSyncTask(state)
      if (accountRef.current === syncAccount && selectedChatRef.current?.chat_id === syncChat.chat_id) {
        await loadMessages(null)
      }
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
        <span className={`sync-pill sync-pill-${syncTask.status}`} role="status" aria-live="polite">Sync: {syncTask.status}</span>
      </header>

      {error && <div className="error-strip" role="alert">{error}</div>}

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
                aria-current={chat.chat_id === selectedChat?.chat_id ? 'true' : undefined}
                aria-pressed={chat.chat_id === selectedChat?.chat_id}
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
              <span>Sender ID</span>
              <input value={senderId} onChange={(event) => setSenderId(event.target.value)} inputMode="numeric" placeholder="123456789" />
            </label>
            <label>
              <span>Sender name</span>
              <input value={senderName} onChange={(event) => setSenderName(event.target.value)} placeholder="name" />
            </label>
            <label>
              <span>Text</span>
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder="message text" />
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
            {messages.map((message) => {
              const downloadable = message.attachments.filter((attachment) => attachment.downloadable)
              return (
                <li key={message.id} className="message-row">
                  <div className="message-meta">
                    <time dateTime={message.timestamp}>{formatDate(message.timestamp)}</time>
                    <span>{messageIdLabel(message)}</span>
                  </div>
                  <div className="message-body">
                    <div className="sender-line">
                      <strong>{message.sender_name ?? 'Unknown'}</strong>
                      <span>ID {message.sender_id ?? 'unknown'}</span>
                    </div>
                    <p>{message.content ?? ''}</p>
                    {message.media_summary && <div className="media-summary">{message.media_summary}</div>}
                    {message.attachments.length > 0 && (
                      <div className="attachment-list">
                        {message.attachments.map((attachment) => (
                          <div className="attachment-row" key={attachment.key}>
                            {attachment.preview_jpeg_base64
                              ? <img alt="" src={`data:image/jpeg;base64,${attachment.preview_jpeg_base64}`} />
                              : <span className="attachment-thumb" aria-hidden="true">{attachment.kind.slice(0, 3).toUpperCase()}</span>}
                            <div>
                              <span className="attachment-label">{attachment.kind}</span>
                              <small>{attachment.file_name}</small>
                              {downloadStatus[attachment.key] && <small>{downloadStatus[attachment.key]}</small>}
                            </div>
                            <button
                              type="button"
                              onClick={() => void downloadAttachments([attachment])}
                              disabled={!attachment.downloadable || downloadStatus[attachment.key] === 'Downloading'}
                            >
                              Download
                            </button>
                          </div>
                        ))}
                        {downloadable.length > 1 && (
                          <button className="download-all" type="button" onClick={() => void downloadAttachments(downloadable)}>
                            Download all
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
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
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function messageIdLabel(message: MessageRow): string {
  return message.msg_ids.length > 1
    ? `Messages ${message.msg_ids.join(', ')}`
    : `Message ${message.msg_id}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
