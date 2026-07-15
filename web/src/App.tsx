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

const DEFAULT_MESSAGE_PAGE_SIZE = 50
const MESSAGE_PAGE_SIZE_OPTIONS = [25, 50, 100] as const
const SYNC_LIMIT = 500

export function App() {
  const [accounts, setAccounts] = useState<AccountData>({ current_account: null, accounts: [] })
  const [account, setAccount] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [selectedChat, setSelectedChat] = useState<ChatSummary | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [messageTotal, setMessageTotal] = useState(0)
  const [messagePage, setMessagePage] = useState(1)
  const [messagePageInput, setMessagePageInput] = useState('1')
  const [messagePageSize, setMessagePageSize] = useState(DEFAULT_MESSAGE_PAGE_SIZE)
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
      setMessageTotal(0)
      setMessagePage(1)
      setMessagePageInput('1')
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
          setMessageTotal(0)
          setMessagePage(1)
          setMessagePageInput('1')
        }
        const current = selectedChatRef.current
        const next = current != null && page.items.some((item) => item.chat_id === current.chat_id)
          ? current
          : page.items[0] ?? null
        if (next?.chat_id !== current?.chat_id) {
          messageRequestId.current += 1
          setMessages([])
          setMessageTotal(0)
          setMessagePage(1)
          setMessagePageInput('1')
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
      setMessageTotal(0)
      setMessagePage(1)
      setMessagePageInput('1')
      setLoadingMessages(false)
      return
    }
    void loadMessages(1)
  }, [account, selectedChat?.chat_id, messagePageSize])

  const selectedSummary = useMemo(() => {
    if (selectedChat == null) return 'No chat selected'
    return `${selectedChat.msg_count} messages from ${formatDate(selectedChat.first_msg)} to ${formatDate(selectedChat.last_msg)}`
  }, [selectedChat])

  const selectedChatName = selectedChat?.chat_name ?? (selectedChat == null ? 'Select a chat' : `Chat ${selectedChat.chat_id}`)
  const totalMessagePages = Math.max(1, Math.ceil(messageTotal / messagePageSize))
  const visibleMessagePages = paginationWindow(messagePage, totalMessagePages)

  async function loadMessages(pageNumber: number) {
    if (!account || selectedChat == null) return
    const targetPage = Math.max(1, Math.trunc(pageNumber))
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
        limit: String(messagePageSize),
        offset: String((targetPage - 1) * messagePageSize),
      })
      if (requestSenderId) params.set('senderId', requestSenderId)
      if (requestSenderName) params.set('senderName', requestSenderName)
      if (requestText) params.set('text', requestText)
      if (requestSince) params.set('since', new Date(requestSince).toISOString())
      if (requestUntil) params.set('until', new Date(requestUntil).toISOString())

      const page = await getJson<Page<MessageRow>>(`/api/messages?${params}`)
      if (requestId !== messageRequestId.current) return
      setMessages(page.items)
      setMessageTotal(page.total ?? page.items.length)
      setMessagePage(targetPage)
      setMessagePageInput(String(targetPage))
    } catch (caught) {
      if (requestId === messageRequestId.current) setError(errorText(caught))
    } finally {
      if (requestId === messageRequestId.current) setLoadingMessages(false)
    }
  }

  function goToMessagePage() {
    const pageNumber = Number.parseInt(messagePageInput, 10)
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      setMessagePageInput(String(messagePage))
      return
    }
    void loadMessages(Math.min(pageNumber, totalMessagePages))
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
      if (state.status === 'error') {
        setError(syncErrorText(state))
        return
      }
      if (accountRef.current === syncAccount && selectedChatRef.current?.chat_id === syncChat.chat_id) {
        await loadMessages(messagePage)
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
          <div>
            <strong>Telegram CLI</strong>
            <span>Local message console</span>
          </div>
        </div>
        <label className="account-picker">
          <span>Account</span>
          <select value={account} onChange={(event) => { setAccount(event.target.value); setSelectedChat(null); setMessages([]); setMessageTotal(0); setMessagePage(1); setMessagePageInput('1') }}>
            {accounts.accounts.map((item) => (
              <option key={item.name} value={item.name}>
                {item.display_name || item.username || item.name}
              </option>
            ))}
          </select>
        </label>
        <span className={`sync-pill sync-pill-${syncTask.status}`} role="status" aria-live="polite" title={syncTask.status === 'error' ? syncErrorText(syncTask) : undefined}>Sync {syncTask.status}</span>
      </header>

      {error && <div className="error-strip" role="alert">{error}</div>}

      <section className="workspace" aria-label="Telegram message browser">
        <aside className="sidebar">
          <div className="sidebar-tools">
            <div className="panel-kicker">Chats</div>
            <label>
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
                <span className="chat-meta">
                  <span>{chat.msg_count} messages</span>
                  <time dateTime={chat.last_msg}>{formatDate(chat.last_msg)}</time>
                </span>
              </button>
            ))}
            {!loadingChats && chats.length === 0 && <p className="empty-note">No local chats found.</p>}
          </div>
        </aside>

        <section className="messages-pane">
          <div className="chat-header">
            <div>
              <span className="panel-kicker">Message stream</span>
              <div className="chat-title-row">
                <h1>{selectedChatName}</h1>
                {selectedChat != null && <span className="selected-chat-id">Chat ID {displayChatId(selectedChat.chat_id)}</span>}
              </div>
              <p>{selectedSummary}</p>
            </div>
            <button className="primary-action" onClick={syncCurrentChat} disabled={selectedChat == null || syncTask.status === 'running'} type="button">
              Sync current chat
            </button>
          </div>

          <section className="filter-panel" aria-label="Message filters">
            <div className="filter-panel-heading">
              <span className="panel-kicker">Filters</span>
              <span>{loadingMessages ? 'Reading local cache' : `${messages.length} of ${messageTotal} shown`}</span>
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
              <button onClick={() => void loadMessages(1)} disabled={selectedChat == null || loadingMessages} type="button">
                Search
              </button>
            </div>
          </section>

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
                    {message.reply_context && (
                      <div className={message.reply_context.resolved ? 'reply-snippet' : 'reply-snippet reply-snippet-missing'}>
                        <div className="reply-snippet-meta">
                          {message.reply_context.resolved && <time dateTime={message.reply_context.timestamp}>{formatDate(message.reply_context.timestamp)}</time>}
                          <span>{replySenderLabel(message.reply_context)}</span>
                          <span>{replyMessageIdLabel(message.reply_context)}</span>
                        </div>
                        {replyContentLabel(message.reply_context) && <p>{replyContentLabel(message.reply_context)}</p>}
                        {message.reply_context.resolved && message.reply_context.attachments.length > 0 && (
                          <div className="reply-attachment-list">
                            {message.reply_context.attachments.map((attachment) => (
                              <div className="reply-attachment" key={attachment.key}>
                                {attachment.preview_jpeg_base64
                                  ? <img alt="" src={`data:image/jpeg;base64,${attachment.preview_jpeg_base64}`} />
                                  : <span className="reply-attachment-thumb" aria-hidden="true">{attachment.kind.slice(0, 3).toUpperCase()}</span>}
                                <span>{attachment.kind}</span>
                                <small>{attachment.file_name}</small>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <p>{message.content ?? ''}</p>
                    {message.media_summary && <div className="media-summary">{message.media_summary}</div>}
                    {message.attachments.length > 0 && (
                      <div className="attachment-list">
                        {message.attachments.map((attachment) => (
                          <div className="attachment-row" key={attachment.key}>
                            {attachment.preview_jpeg_base64
                              ? <img alt="" src={`data:image/jpeg;base64,${attachment.preview_jpeg_base64}`} />
                              : <span className="attachment-thumb" aria-hidden="true">{attachment.kind.slice(0, 3).toUpperCase()}</span>}
                            <div className="attachment-copy">
                              <span className="attachment-label">{attachment.kind}</span>
                              <small>{attachment.file_name}</small>
                              {downloadStatus[attachment.key] && <small>{downloadStatus[attachment.key]}</small>}
                            </div>
                            <button
                              className="attachment-action"
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
          {selectedChat != null && (
            <nav className="message-pager" aria-label="Message pages">
              <label className="pager-size">
                <span>Page size</span>
                <select
                  value={messagePageSize}
                  onChange={(event) => {
                    setMessagePageSize(Number.parseInt(event.target.value, 10))
                    setMessagePage(1)
                    setMessagePageInput('1')
                  }}
                >
                  {MESSAGE_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <div className="pager-main">
                <button onClick={() => void loadMessages(1)} disabled={loadingMessages || messagePage <= 1} type="button">
                  First
                </button>
                <button onClick={() => void loadMessages(messagePage - 1)} disabled={loadingMessages || messagePage <= 1} type="button">
                  Previous
                </button>
                <div className="pager-pages" aria-label="Page numbers">
                  {visibleMessagePages.map((pageItem) => (
                    typeof pageItem === 'number'
                      ? (
                        <button
                          className={pageItem === messagePage ? 'pager-page pager-page-current' : 'pager-page'}
                          key={pageItem}
                          onClick={() => void loadMessages(pageItem)}
                          disabled={loadingMessages || pageItem === messagePage}
                          aria-current={pageItem === messagePage ? 'page' : undefined}
                          type="button"
                        >
                          {pageItem}
                        </button>
                      )
                      : <span className="pager-ellipsis" key={pageItem}>...</span>
                  ))}
                </div>
                <button onClick={() => void loadMessages(messagePage + 1)} disabled={loadingMessages || messagePage >= totalMessagePages} type="button">
                  Next
                </button>
                <button onClick={() => void loadMessages(totalMessagePages)} disabled={loadingMessages || messagePage >= totalMessagePages} type="button">
                  Last
                </button>
              </div>
              <div className="pager-jump-group">
                <label className="pager-jump">
                  <span>Jump to</span>
                  <input
                    value={messagePageInput}
                    onChange={(event) => setMessagePageInput(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') goToMessagePage() }}
                    inputMode="numeric"
                    aria-label="Jump to message page"
                  />
                </label>
                <span className="pager-count">/ {totalMessagePages}</span>
                <button onClick={goToMessagePage} disabled={loadingMessages} type="button">
                  Go
                </button>
              </div>
            </nav>
          )}
        </section>
      </section>
    </main>
  )
}

type PaginationItem = number | 'ellipsis-left' | 'ellipsis-right'

export function paginationWindow(currentPage: number, totalPages: number): PaginationItem[] {
  const safeTotal = Math.max(1, Math.trunc(totalPages))
  const safeCurrent = Math.min(Math.max(1, Math.trunc(currentPage)), safeTotal)
  if (safeTotal <= 7) return Array.from({ length: safeTotal }, (_, index) => index + 1)

  if (safeCurrent <= 4) return [1, 2, 3, 4, 'ellipsis-right', safeTotal]
  if (safeCurrent >= safeTotal - 3) return [1, 'ellipsis-left', safeTotal - 3, safeTotal - 2, safeTotal - 1, safeTotal]

  return [
    1,
    'ellipsis-left',
    safeCurrent - 2,
    safeCurrent - 1,
    safeCurrent,
    safeCurrent + 1,
    safeCurrent + 2,
    'ellipsis-right',
    safeTotal,
  ]
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

function replySenderLabel(context: MessageRow['reply_context']): string {
  if (context == null) return 'message'
  if (!context.resolved) return 'message'
  return context.sender_name?.trim() || (context.sender_id == null ? 'Unknown' : `ID ${context.sender_id}`)
}

function replyContentLabel(context: MessageRow['reply_context']): string {
  if (context == null) return ''
  if (!context.resolved) return 'Message not found in the local cache.'
  if ((context.content == null || context.content.trim() === '') && context.attachments.length > 0) return ''
  return context.content?.trim() || '(no text)'
}

function replyMessageIdLabel(context: MessageRow['reply_context']): string {
  return context == null ? '' : `#${context.message_id}`
}

export function displayChatId(chatId: number): string {
  return chatId > 1_000_000_000 ? `-100${chatId}` : String(chatId)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function syncErrorText(state: SyncTaskState): string {
  return state.status === 'error'
    ? `Sync failed (${state.error.code}): ${state.error.message}`
    : ''
}
