import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getJson,
  patchJson,
  postJson,
  type AccountData,
  type ChatSummary,
  type GuardActivityItem,
  type GuardGroup,
  type GuardRule,
  type GuardRuntimeState,
  type JsonValue,
  type MessageAttachment,
  type MessageRow,
  type Page,
  type SyncTaskState,
} from './api.js'

const DEFAULT_MESSAGE_PAGE_SIZE = 50
const MESSAGE_PAGE_SIZE_OPTIONS = [25, 50, 100] as const
const SYNC_LIMIT = 500
const GUARD_RULE_DEFAULT_PRIORITY = 100

type GuardRuleConditionKind =
  | 'message_contains_text'
  | 'message_matches_regex'
  | 'message_contains_url'
  | 'message_contains_invite_link'
  | 'message_repeated'
  | 'message_rate_exceeded'
  | 'member_is_new'
  | 'member_age_less_than'
  | 'message_command'

type GuardRuleActionKind =
  | 'delete_message'
  | 'warn'
  | 'mute'
  | 'ban'
  | 'reply'
  | 'send_message'
  | 'record_only'

export type GuardRuleDraft = {
  name: string
  enabled: boolean
  priority: number
  conditionType: GuardRuleConditionKind
  conditionText: string
  conditionSeconds: number
  conditionCount: number
  actionType: GuardRuleActionKind
  actionText: string
  actionSeconds: number
}

const DEFAULT_GUARD_RULE_DRAFT: GuardRuleDraft = {
  name: '',
  enabled: true,
  priority: GUARD_RULE_DEFAULT_PRIORITY,
  conditionType: 'message_contains_url',
  conditionText: '',
  conditionSeconds: 60,
  conditionCount: 5,
  actionType: 'delete_message',
  actionText: '',
  actionSeconds: 600,
}

export function attachmentKey(attachment: MessageAttachment): string {
  return `${attachment.chat_id}:${attachment.msg_id}:${attachment.attachment_index}`
}

export function attachmentDepth(
  attachment: MessageAttachment,
  attachments: MessageAttachment[],
): number {
  let depth = 0
  let parentIndex = attachment.parent_attachment_index
  const seen = new Set<number>([attachment.attachment_index])
  while (parentIndex != null) {
    const parent = attachments.find((candidate) => (
      candidate.chat_id === attachment.chat_id
      && candidate.msg_id === attachment.msg_id
      && candidate.attachment_index === parentIndex
    ))
    if (parent == null || seen.has(parent.attachment_index)) return depth
    depth += 1
    seen.add(parent.attachment_index)
    parentIndex = parent.parent_attachment_index
  }
  return depth
}

function attachmentLabel(attachment: MessageAttachment): string {
  return attachment.subtype == null ? attachment.kind : `${attachment.kind}/${attachment.subtype}`
}

function attachmentDisplayName(attachment: MessageAttachment): string {
  return attachment.file_name ?? `${attachment.chat_id}-${attachment.msg_id}-${attachment.attachment_index}.${attachmentExtension(attachment)}`
}

function attachmentExtension(attachment: MessageAttachment): string {
  if (attachment.mime_type === 'image/jpeg') return 'jpg'
  if (attachment.mime_type === 'image/png') return 'png'
  if (attachment.mime_type === 'video/mp4') return 'mp4'
  if (attachment.mime_type === 'application/pdf') return 'pdf'
  if (attachment.kind === 'photo') return 'jpg'
  if (attachment.kind === 'video') return 'mp4'
  if (attachment.kind === 'voice') return 'ogg'
  return 'bin'
}

type DownloadVisualState = 'none' | 'downloaded' | 'partial' | 'not-downloaded'

function attachmentDownloadState(attachment: MessageAttachment): DownloadVisualState {
  if (!attachment.downloadable) return 'none'
  return attachment.downloaded ? 'downloaded' : 'not-downloaded'
}

function messageDownloadState(message: MessageRow): DownloadVisualState {
  const downloadable = message.attachments.filter((attachment) => attachment.downloadable)
  if (downloadable.length === 0) return 'none'
  const downloaded = downloadable.filter((attachment) => attachment.downloaded).length
  if (downloaded === downloadable.length) return 'downloaded'
  if (downloaded > 0) return 'partial'
  return 'not-downloaded'
}

function downloadStateLabel(state: DownloadVisualState): string {
  if (state === 'downloaded') return 'Downloaded'
  if (state === 'partial') return 'Partially downloaded'
  if (state === 'not-downloaded') return 'Not downloaded'
  return ''
}

function DownloadStatusIcon({ state }: { state: DownloadVisualState }) {
  const label = downloadStateLabel(state)
  if (state === 'none') return null
  return (
    <span
      className={`download-status-icon download-status-${state}`}
      title={label}
      data-tooltip={label}
      aria-label={label}
      role="img"
    />
  )
}

type MessageFilterOverrides = {
  senderId?: string
  senderName?: string
  text?: string
  since?: string
  until?: string
}

type BlockedSender = {
  key: string
  sender_id: number | null
  sender_name: string | null
  label: string
  blocked_at: string
}

const SENDER_AVATAR_BACKGROUNDS = [
  'linear-gradient(135deg, #ff8a65 0%, #f4511e 100%)',
  'linear-gradient(135deg, #f6bf26 0%, #f29900 100%)',
  'linear-gradient(135deg, #4dd0a9 0%, #0aa37f 100%)',
  'linear-gradient(135deg, #4fc3f7 0%, #1e88e5 100%)',
  'linear-gradient(135deg, #7e9cff 0%, #5865d9 100%)',
  'linear-gradient(135deg, #ba68c8 0%, #8e24aa 100%)',
  'linear-gradient(135deg, #f06292 0%, #d81b60 100%)',
  'linear-gradient(135deg, #90a4ae 0%, #546e7a 100%)',
]

export function guardOnlyMode(search = typeof window === 'undefined' ? '' : window.location.search): boolean {
  return new URLSearchParams(search).get('guard') === '1'
}

export function App() {
  const guardOnly = guardOnlyMode()
  const [view, setView] = useState<'messages' | 'guard'>(guardOnly ? 'guard' : 'messages')
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
  const [blockedSenders, setBlockedSenders] = useState<BlockedSender[]>([])
  const [blacklistOpen, setBlacklistOpen] = useState(false)
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
    if (guardOnly) return
    getJson<AccountData>('/api/accounts')
      .then((data) => {
        setAccounts(data)
        setAccount(data.current_account ?? data.accounts[0]?.name ?? '')
      })
      .catch((caught) => setError(errorText(caught)))
  }, [guardOnly])

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

  useEffect(() => {
    setBlockedSenders(readBlockedSenders(senderBlacklistStorageKey(account, selectedChat?.chat_id ?? null)))
    setBlacklistOpen(false)
  }, [account, selectedChat?.chat_id])

  const selectedSummary = useMemo(() => {
    if (selectedChat == null) return 'No chat selected'
    return `${selectedChat.msg_count} messages from ${formatDate(selectedChat.first_msg)} to ${formatDate(selectedChat.last_msg)}`
  }, [selectedChat])

  const selectedChatName = selectedChat?.chat_name ?? (selectedChat == null ? 'Select a chat' : `Chat ${selectedChat.chat_id}`)
  const totalMessagePages = Math.max(1, Math.ceil(messageTotal / messagePageSize))
  const visibleMessagePages = paginationWindow(messagePage, totalMessagePages)
  const blockedSenderKeys = useMemo(() => new Set(blockedSenders.map((sender) => sender.key)), [blockedSenders])
  const visibleMessages = useMemo(() => visibleMessagesForBlacklist(messages, blockedSenderKeys), [messages, blockedSenderKeys])
  const hiddenMessageCount = messages.length - visibleMessages.length

  async function loadMessages(pageNumber: number, filterOverrides: MessageFilterOverrides = {}) {
    if (!account || selectedChat == null) return
    const targetPage = Math.max(1, Math.trunc(pageNumber))
    const requestId = messageRequestId.current + 1
    messageRequestId.current = requestId
    const requestAccount = account
    const requestChat = selectedChat
    const requestSenderId = (filterOverrides.senderId ?? senderId).trim()
    const requestSenderName = (filterOverrides.senderName ?? senderName).trim()
    const requestText = (filterOverrides.text ?? text).trim()
    const requestSince = filterOverrides.since ?? since
    const requestUntil = filterOverrides.until ?? until
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

  function resetMessageFilters() {
    const cleared = { senderId: '', senderName: '', text: '', since: '', until: '' }
    setSenderId('')
    setSenderName('')
    setText('')
    setSince('')
    setUntil('')
    setMessagePage(1)
    setMessagePageInput('1')
    void loadMessages(1, cleared)
  }

  function filterByMessageSender(message: MessageRow) {
    if (message.sender_id == null) return
    const filters = {
      senderId: String(message.sender_id),
      senderName: '',
      text: '',
      since: '',
      until: '',
    }
    setSenderId(filters.senderId)
    setSenderName('')
    setText('')
    setSince('')
    setUntil('')
    setMessagePage(1)
    setMessagePageInput('1')
    void loadMessages(1, filters)
  }

  function blockMessageSender(message: MessageRow) {
    const key = senderBlacklistKey(message.sender_name, message.sender_id)
    if (key == null) return
    updateBlockedSenders((current) => {
      if (current.some((sender) => sender.key === key)) return current
      return [
        ...current,
        {
          key,
          sender_id: message.sender_id,
          sender_name: message.sender_name,
          label: senderDisplayLabel(message.sender_name, message.sender_id),
          blocked_at: new Date().toISOString(),
        },
      ]
    })
  }

  function removeBlockedSender(key: string) {
    updateBlockedSenders((current) => current.filter((sender) => sender.key !== key))
  }

  function updateBlockedSenders(updater: (current: BlockedSender[]) => BlockedSender[]) {
    setBlockedSenders((current) => {
      const next = updater(current)
      writeBlockedSenders(senderBlacklistStorageKey(account, selectedChat?.chat_id ?? null), next)
      return next
    })
  }

  async function downloadAttachments(attachments: MessageAttachment[]) {
    if (!account || attachments.length === 0) return
    const keys = attachments.map(attachmentKey)
    setDownloadStatus((current) => {
      const next = { ...current }
      for (const key of keys) next[key] = 'Downloading'
      return next
    })
    setError('')
    try {
      const result = await postJson<{
        downloaded: Array<{ path: string }>
        warnings: Array<{ code: string; message: string }>
      }>('/api/download-media', {
        account,
        attachments: attachments.map((attachment) => ({
          chat_id: attachment.chat_id,
          msg_id: attachment.msg_id,
          attachment_index: attachment.attachment_index,
        })),
      })
      const destination = result.downloaded.length === 1 ? result.downloaded[0]?.path : `${result.downloaded.length} files`
      setDownloadStatus((current) => {
        const next = { ...current }
        for (const key of keys) next[key] = destination == null ? 'Downloaded' : `Downloaded to ${destination}`
        return next
      })
      if (result.warnings.length > 0) {
        setError(result.warnings.map((warning) => warning.message).join(' '))
      }
      await loadMessages(messagePage)
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
            <span>{guardOnly ? 'Guard console' : 'Local message console'}</span>
          </div>
        </div>
        {!guardOnly && <label className="account-picker">
          <span>Account</span>
          <select value={account} onChange={(event) => { setAccount(event.target.value); setSelectedChat(null); setMessages([]); setMessageTotal(0); setMessagePage(1); setMessagePageInput('1') }}>
            {accounts.accounts.map((item) => (
              <option key={item.name} value={item.name}>
                {item.display_name || item.username || item.name}
              </option>
            ))}
          </select>
        </label>}
        {!guardOnly && <nav className="view-tabs" aria-label="Workspace view">
          <button className={view === 'messages' ? 'active-tab' : ''} onClick={() => setView('messages')} type="button">
            Messages
          </button>
          <button className={view === 'guard' ? 'active-tab' : ''} onClick={() => setView('guard')} type="button">
            Guard
          </button>
        </nav>}
        {!guardOnly && <span className={`sync-pill sync-pill-${syncTask.status}`} role="status" aria-live="polite" title={syncTask.status === 'error' ? syncErrorText(syncTask) : undefined}>Sync {syncTask.status}</span>}
      </header>

      {error && <div className="error-strip" role="alert">{error}</div>}

      {!guardOnly && view === 'messages' ? (
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
              <div className="filter-panel-heading-actions">
                <span>
                  {loadingMessages
                    ? 'Reading local cache'
                    : `${visibleMessages.length} of ${messageTotal} shown${hiddenMessageCount > 0 ? `, ${hiddenMessageCount} hidden` : ''}`}
                </span>
                <button
                  className="manage-sender-blacklist secondary-action"
                  type="button"
                  onClick={() => setBlacklistOpen(true)}
                  disabled={selectedChat == null}
                >
                  Blacklist {blockedSenders.length}
                </button>
              </div>
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
              <button className="secondary-action" onClick={resetMessageFilters} disabled={selectedChat == null || loadingMessages} type="button">
                Reset
              </button>
            </div>
          </section>

          <ol className="message-list" aria-busy={loadingMessages}>
            {visibleMessages.map((message) => {
              const orderedAttachments = message.attachments
                .slice()
                .sort((left, right) => left.msg_id - right.msg_id || left.attachment_index - right.attachment_index)
              const downloadable = orderedAttachments.filter((attachment) => attachment.downloadable)
              const avatar = senderAvatar(message.sender_name, message.sender_id)
              const canBlockSender = senderBlacklistKey(message.sender_name, message.sender_id) != null
              return (
                <li key={message.id} className="message-row">
                  <div className="message-meta">
                    <span className="message-status-line">
                      <DownloadStatusIcon state={messageDownloadState(message)} />
                      <time dateTime={message.timestamp}>{formatDate(message.timestamp)}</time>
                    </span>
                    {messageIdLabels(message).map((label) => <span key={label}>{label}</span>)}
                  </div>
                  <div className="message-body">
                    <div className="sender-head">
                      <span className="sender-avatar" style={{ background: avatar.background }} aria-hidden="true">
                        {avatar.label}
                      </span>
                      <div className="sender-line">
                        <strong>{message.sender_name ?? 'Unknown'}</strong>
                        <span>ID {message.sender_id ?? 'unknown'}</span>
                        {message.sender_id != null && (
                          <button
                            className="sender-filter-action"
                            type="button"
                            onClick={() => filterByMessageSender(message)}
                            disabled={loadingMessages}
                            title="Filter messages by this sender"
                            data-tooltip="Filter messages by this sender"
                            aria-label={`Filter messages by ${message.sender_name ?? `ID ${message.sender_id}`} in this chat`}
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M7.5 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                              <path d="M3.5 18.5a4.5 4.5 0 0 1 8 0" />
                              <path d="M14 6.5h6.5" />
                              <path d="M14 11.5h5" />
                              <path d="M14 16.5h6.5" />
                            </svg>
                          </button>
                        )}
                        {canBlockSender && (
                          <button
                            className="sender-block-action"
                            type="button"
                            onClick={() => blockMessageSender(message)}
                            disabled={loadingMessages}
                            title="Hide messages from this sender"
                            data-tooltip="Hide messages from this sender"
                            aria-label={`Hide messages from ${senderDisplayLabel(message.sender_name, message.sender_id)} in this chat`}
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M7.5 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                              <path d="M3.5 18.5a4.5 4.5 0 0 1 8 0" />
                              <path d="M15 8.5 21 14.5" />
                              <path d="M21 8.5 15 14.5" />
                            </svg>
                          </button>
                        )}
                      </div>
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
                              <div
                                className="reply-attachment"
                                key={attachmentKey(attachment)}
                                style={{ marginLeft: 0 }}
                              >
                                {attachment.preview_jpeg_base64
                                  ? <img alt="" src={`data:image/jpeg;base64,${attachment.preview_jpeg_base64}`} />
                                  : <span className="reply-attachment-thumb" aria-hidden="true">{attachment.kind.slice(0, 3).toUpperCase()}</span>}
                                <span>{attachmentLabel(attachment)}</span>
                                <small>{attachmentDisplayName(attachment)}</small>
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
                        {orderedAttachments.map((attachment) => {
                          const key = attachmentKey(attachment)
                          return (
                          <div
                            className="attachment-row"
                            key={key}
                            style={{ marginLeft: `${attachmentDepth(attachment, orderedAttachments) * 20}px` }}
                          >
                            {attachment.preview_jpeg_base64
                              ? <img alt="" src={`data:image/jpeg;base64,${attachment.preview_jpeg_base64}`} />
                              : <span className="attachment-thumb" aria-hidden="true">{attachment.kind.slice(0, 3).toUpperCase()}</span>}
                            <div className="attachment-copy">
                              <span className="attachment-label">
                                <DownloadStatusIcon state={attachmentDownloadState(attachment)} />
                                {attachmentLabel(attachment)}
                              </span>
                              <small>{attachmentDisplayName(attachment)}</small>
                              <small className="attachment-message-id">Message {attachment.msg_id}</small>
                              {downloadStatus[key] && <small>{downloadStatus[key]}</small>}
                            </div>
                            {attachment.downloadable && (
                              <button
                                className="attachment-action"
                                type="button"
                                onClick={() => void downloadAttachments([attachment])}
                                disabled={downloadStatus[key] === 'Downloading'}
                              >
                                Download
                              </button>
                            )}
                          </div>
                          )
                        })}
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
          {!loadingMessages && selectedChat != null && messages.length > 0 && visibleMessages.length === 0 && (
            <p className="empty-note">All messages on this page are hidden by blacklist.</p>
          )}
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
      ) : <GuardWorkbench />}
      {!guardOnly && blacklistOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="blacklist-modal" role="dialog" aria-modal="true" aria-labelledby="sender-blacklist-title">
            <div className="blacklist-modal-heading">
              <div>
                <span className="panel-kicker">Message visibility</span>
                <h2 id="sender-blacklist-title">Sender blacklist</h2>
              </div>
              <button className="modal-close" type="button" onClick={() => setBlacklistOpen(false)} aria-label="Close sender blacklist">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6 6 18 18" />
                  <path d="M18 6 6 18" />
                </svg>
              </button>
            </div>
            {blockedSenders.length === 0
              ? <p className="empty-note">No senders are hidden in this chat.</p>
              : (
                <ul className="blacklist-list">
                  {blockedSenders.map((sender) => {
                    const avatar = senderAvatar(sender.sender_name, sender.sender_id)
                    return (
                      <li key={sender.key} className="blacklist-row">
                        <span className="sender-avatar" style={{ background: avatar.background }} aria-hidden="true">
                          {avatar.label}
                        </span>
                        <span className="blacklist-copy">
                          <strong>{sender.label}</strong>
                          <small>{sender.sender_id == null ? 'Name match' : `ID ${sender.sender_id}`}</small>
                        </span>
                        <button type="button" onClick={() => removeBlockedSender(sender.key)}>
                          Remove
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          </section>
        </div>
      )}
    </main>
  )
}

function GuardWorkbench() {
  const [status, setStatus] = useState<GuardRuntimeState | null>(null)
  const [groups, setGroups] = useState<GuardGroup[]>([])
  const [rules, setRules] = useState<GuardRule[]>([])
  const [activity, setActivity] = useState<GuardActivityItem[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingRules, setLoadingRules] = useState(false)
  const [creatingRule, setCreatingRule] = useState(false)
  const [updatingGroup, setUpdatingGroup] = useState(false)
  const [ruleFormOpen, setRuleFormOpen] = useState(false)
  const [ruleDraft, setRuleDraft] = useState<GuardRuleDraft>(DEFAULT_GUARD_RULE_DRAFT)
  const [error, setError] = useState('')
  const ruleRequestId = useRef(0)
  const selectedGroupIdRef = useRef(selectedGroupId)

  selectedGroupIdRef.current = selectedGroupId

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null
  const enabledGroups = groups.filter((group) => group.enabled).length
  const enabledRules = rules.filter((rule) => rule.enabled).length

  useEffect(() => {
    void loadGuard()
  }, [])

  useEffect(() => {
    if (selectedGroupId == null) {
      ruleRequestId.current += 1
      setRules([])
      setRuleDraft(DEFAULT_GUARD_RULE_DRAFT)
      setRuleFormOpen(false)
      return
    }
    const requestId = ruleRequestId.current + 1
    ruleRequestId.current = requestId
    setRules([])
    setRuleDraft(DEFAULT_GUARD_RULE_DRAFT)
    setRuleFormOpen(false)
    void loadGuardRules(selectedGroupId, requestId)
  }, [selectedGroupId])

  async function loadGuardRules(groupId: number, requestId = ruleRequestId.current + 1): Promise<void> {
    ruleRequestId.current = requestId
    setLoadingRules(true)
    setError('')
    try {
      const page = await getJson<Page<GuardRule>>(`/api/guard/rules?group_id=${groupId}`)
      if (requestId === ruleRequestId.current) setRules(page.items)
    } catch (caught) {
      if (requestId === ruleRequestId.current) setError(errorText(caught))
    } finally {
      if (requestId === ruleRequestId.current) setLoadingRules(false)
    }
  }

  async function loadGuard() {
    setLoading(true)
    setError('')
    try {
      const [statusData, activityData] = await Promise.all([
        getJson<{ runtime: GuardRuntimeState; groups: Page<GuardGroup> }>('/api/guard/status'),
        getJson<Page<GuardActivityItem>>('/api/guard/activity'),
      ])
      setStatus(statusData.runtime)
      setGroups(statusData.groups.items)
      const latestSelectedGroupId = selectedGroupIdRef.current
      const currentGroupId = nextGuardGroupId(statusData.groups.items, latestSelectedGroupId)
      const requestId = ruleRequestId.current + 1
      if (currentGroupId == null) {
        ruleRequestId.current = requestId
        setRules([])
      } else if (currentGroupId === latestSelectedGroupId) {
        void loadGuardRules(currentGroupId, requestId)
      } else {
        ruleRequestId.current = requestId
        setRules([])
      }
      setSelectedGroupId(currentGroupId)
      setActivity(activityData.items)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }

  async function createRule(): Promise<void> {
    if (selectedGroupId == null) return
    setCreatingRule(true)
    setError('')
    try {
      await postJson<GuardRule>('/api/guard/rules', guardRuleRequestFromDraft(selectedGroupId, ruleDraft))
      setRuleDraft(DEFAULT_GUARD_RULE_DRAFT)
      setRuleFormOpen(false)
      await loadGuardRules(selectedGroupId)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setCreatingRule(false)
    }
  }

  function updateRuleDraft(update: Partial<GuardRuleDraft>): void {
    setRuleDraft((current) => ({ ...current, ...update }))
  }

  async function updateSelectedGroup(update: Partial<Pick<GuardGroup, 'enabled' | 'policy'>>): Promise<void> {
    if (selectedGroup == null) return
    setUpdatingGroup(true)
    setError('')
    try {
      const updated = await patchJson<GuardGroup>(`/api/guard/groups/${selectedGroup.id}`, update)
      setGroups((current) => current.map((group) => group.id === updated.id ? updated : group))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setUpdatingGroup(false)
    }
  }

  return (
    <section className="guard-workbench" aria-label="Telegram Guard workbench">
      <div className="guard-overview">
        <div>
          <span className="panel-kicker">Guard console</span>
          <h1>Group automation</h1>
          <p>{status?.error ?? 'Local rules, group policy, and moderation activity from the guard database.'}</p>
        </div>
        <button className="secondary-action" type="button" onClick={() => void loadGuard()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <div className="guard-error" role="alert">{error}</div>}

      <section className="guard-metrics" aria-label="Guard runtime summary">
        <div className="guard-metric guard-metric-runtime">
          <span>Runtime</span>
          <strong>{status?.status ?? 'stopped'}</strong>
          <small>{status?.started_at == null ? 'Not started' : `Started ${formatDate(status.started_at)}`}</small>
        </div>
        <div className="guard-metric">
          <span>Groups</span>
          <strong>{enabledGroups}/{groups.length}</strong>
          <small>Enabled for automation</small>
        </div>
        <div className="guard-metric">
          <span>Queue</span>
          <strong>{status?.queue_length ?? 0}</strong>
          <small>Pending actions</small>
        </div>
        <div className="guard-metric">
          <span>Activity</span>
          <strong>{activity.length}</strong>
          <small>Recent action records</small>
        </div>
      </section>

      <section className="guard-grid">
        <section className="guard-panel guard-groups-panel" aria-label="Managed groups">
          <div className="guard-panel-heading">
            <div>
              <span className="panel-kicker">Managed groups</span>
              <h2>{groups.length} groups</h2>
            </div>
            <span className="guard-count">{loading ? 'Loading' : `${enabledGroups} enabled`}</span>
          </div>
          <div className="guard-list" aria-busy={loading}>
            {groups.map((group) => (
              <button
                className={group.id === selectedGroupId ? 'guard-group-row guard-row-selected' : 'guard-group-row'}
                key={group.id}
                type="button"
                onClick={() => setSelectedGroupId(group.id)}
                aria-pressed={group.id === selectedGroupId}
              >
                <span className="guard-row-main">
                  <strong>{group.title ?? `Chat ${displayChatId(group.chat_id)}`}</strong>
                  <small>{group.account} · {displayChatId(group.chat_id)}</small>
                </span>
                <span className={`guard-status guard-status-${group.runtime_status}`}>{group.runtime_status}</span>
              </button>
            ))}
            {!loading && groups.length === 0 && <p className="empty-note">No managed groups found.</p>}
          </div>
        </section>

        <section className="guard-panel guard-detail-panel" aria-label="Selected group rules and policy">
          <div className="guard-panel-heading">
            <div>
              <span className="panel-kicker">Rules</span>
              <h2>{selectedGroup == null ? 'Select a group' : selectedGroup.title ?? `Chat ${displayChatId(selectedGroup.chat_id)}`}</h2>
            </div>
            <div className="guard-heading-actions">
              <span className="guard-count">{loadingRules ? 'Loading' : `${enabledRules}/${rules.length} enabled`}</span>
              {selectedGroup != null && (
                <button
                  className="secondary-action compact-action"
                  type="button"
                  onClick={() => {
                    setRuleDraft(DEFAULT_GUARD_RULE_DRAFT)
                    setRuleFormOpen(true)
                  }}
                >
                  New rule
                </button>
              )}
            </div>
          </div>

          {selectedGroup != null && (
            <div className="guard-policy-bar" aria-label="Group policy">
              <button
                className={selectedGroup.enabled ? 'guard-arm-toggle guard-arm-toggle-on' : 'guard-arm-toggle'}
                disabled={updatingGroup}
                type="button"
                onClick={() => void updateSelectedGroup({ enabled: !selectedGroup.enabled })}
              >
                <span>{selectedGroup.enabled ? 'Automation on' : 'Automation off'}</span>
                <strong>{selectedGroup.runtime_status}</strong>
              </button>
              <div className="guard-policy-strip">
                <span className={selectedGroup.policy.allow_delete ? 'policy-chip policy-chip-on' : 'policy-chip'}>Delete</span>
                <span className={selectedGroup.policy.allow_mute ? 'policy-chip policy-chip-on' : 'policy-chip'}>Mute</span>
                <span className={selectedGroup.policy.allow_ban ? 'policy-chip policy-chip-on' : 'policy-chip'}>Ban</span>
                <span className={selectedGroup.policy.ignore_admins ? 'policy-chip policy-chip-on' : 'policy-chip'}>{selectedGroup.policy.ignore_admins ? 'Admins ignored' : 'Admins checked'}</span>
                <span className="policy-chip">{selectedGroup.policy.action_cooldown_seconds}s cooldown</span>
              </div>
            </div>
          )}

          <div className="guard-rule-list" aria-busy={loadingRules}>
            {rules.map((rule) => (
              <article className={rule.enabled ? 'guard-rule-row' : 'guard-rule-row guard-rule-disabled'} key={rule.id}>
                <div>
                  <strong>{rule.name}</strong>
                  <small>{guardRuleSummary(rule)}</small>
                </div>
                <span>{rule.enabled ? 'enabled' : 'disabled'}</span>
              </article>
            ))}
            {!loadingRules && selectedGroup != null && rules.length === 0 && <p className="empty-note">No rules configured for this group.</p>}
          </div>
        </section>
      </section>

      <section className="guard-panel" aria-label="Recent guard activity">
        <div className="guard-panel-heading">
          <div>
            <span className="panel-kicker">Activity</span>
            <h2>Recent actions</h2>
          </div>
          <span className="guard-count">{activity.length} records</span>
        </div>
        <div className="guard-activity-list">
          {activity.map((item) => (
            <div className="guard-activity-row" key={`${item.event_id}:${item.action_id}`}>
              <span className={`guard-activity-mark ${guardActivityStatusClass(item.action_status)}`} aria-hidden="true" />
              <div>
                <strong>{item.action_type}</strong>
                <small>{activityDetailLabel(item)}</small>
              </div>
              <span className={guardActivityStatusClass(item.action_status)}>{item.action_status}</span>
              <time dateTime={item.action_created_at}>{formatDate(item.action_created_at)}</time>
            </div>
          ))}
          {activity.length === 0 && <p className="empty-note">No guard activity recorded yet.</p>}
        </div>
      </section>
      {selectedGroup != null && ruleFormOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="guard-rule-modal" role="dialog" aria-modal="true" aria-labelledby="guard-rule-modal-title">
            <div className="guard-rule-modal-heading">
              <div>
                <span className="panel-kicker">New rule</span>
                <h2 id="guard-rule-modal-title">{selectedGroup.title ?? `Chat ${displayChatId(selectedGroup.chat_id)}`}</h2>
                <p>{defaultRuleName(ruleDraft)}</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setRuleFormOpen(false)} aria-label="Close rule editor">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6 6 18 18" />
                  <path d="M18 6 6 18" />
                </svg>
              </button>
            </div>
            <form className="guard-rule-form guard-rule-form-modal" onSubmit={(event) => {
              event.preventDefault()
              void createRule()
            }}>
              <div className="guard-rule-form-heading">
                <div>
                  <strong>Add rule</strong>
                  <small>{defaultRuleName(ruleDraft)}</small>
                </div>
                <div className="rule-template-row" aria-label="Rule templates">
                  <button type="button" onClick={() => setRuleDraft(guardRulePreset('links'))}>Links</button>
                  <button type="button" onClick={() => setRuleDraft(guardRulePreset('flood'))}>Flood</button>
                  <button type="button" onClick={() => setRuleDraft(guardRulePreset('invites'))}>Invites</button>
                  <button
                    className={ruleDraft.enabled ? 'guard-rule-enabled-toggle guard-rule-enabled-toggle-on' : 'guard-rule-enabled-toggle'}
                    type="button"
                    aria-pressed={ruleDraft.enabled}
                    onClick={() => updateRuleDraft({ enabled: !ruleDraft.enabled })}
                  >
                    <span className="guard-rule-toggle-track" aria-hidden="true">
                      <span className="guard-rule-toggle-knob" />
                    </span>
                    <span>{ruleDraft.enabled ? 'Enabled' : 'Disabled'}</span>
                  </button>
                </div>
              </div>
              <div className="guard-rule-form-grid">
                <div className="rule-form-section">
                  <span className="rule-form-section-title">When</span>
                  <label>
                    <span>Trigger</span>
                    <select
                      onChange={(event) => updateRuleDraft({ conditionType: event.currentTarget.value as GuardRuleConditionKind })}
                      value={ruleDraft.conditionType}
                    >
                      <option value="message_contains_url">URL</option>
                      <option value="message_contains_invite_link">Invite link</option>
                      <option value="message_contains_text">Text contains</option>
                      <option value="message_matches_regex">Regex</option>
                      <option value="message_repeated">Repeated message</option>
                      <option value="message_rate_exceeded">Message rate</option>
                      <option value="member_is_new">New member</option>
                      <option value="member_age_less_than">Member age</option>
                      <option value="message_command">Command</option>
                    </select>
                  </label>
                  {ruleDraftNeedsText(ruleDraft.conditionType) && (
                    <label>
                      <span>{ruleDraft.conditionType === 'message_matches_regex' ? 'Pattern' : ruleDraft.conditionType === 'message_command' ? 'Command' : 'Text'}</span>
                      <input
                        onChange={(event) => updateRuleDraft({ conditionText: event.currentTarget.value })}
                        placeholder={conditionPlaceholder(ruleDraft.conditionType)}
                        type="text"
                        value={ruleDraft.conditionText}
                      />
                    </label>
                  )}
                  {ruleDraftNeedsSeconds(ruleDraft.conditionType) && (
                    <label>
                      <span>Seconds</span>
                      <input
                        min="1"
                        onChange={(event) => updateRuleDraft({ conditionSeconds: numberInputValue(event.currentTarget.value, 60) })}
                        type="number"
                        value={ruleDraft.conditionSeconds}
                      />
                    </label>
                  )}
                  {ruleDraft.conditionType === 'message_rate_exceeded' && (
                    <label>
                      <span>Max messages</span>
                      <input
                        min="1"
                        onChange={(event) => updateRuleDraft({ conditionCount: numberInputValue(event.currentTarget.value, 5) })}
                        type="number"
                        value={ruleDraft.conditionCount}
                      />
                    </label>
                  )}
                </div>
                <div className="rule-form-section">
                  <span className="rule-form-section-title">Then</span>
                  <label>
                    <span>Action</span>
                    <select
                      onChange={(event) => updateRuleDraft({ actionType: event.currentTarget.value as GuardRuleActionKind })}
                      value={ruleDraft.actionType}
                    >
                      <option value="delete_message">Delete</option>
                      <option value="warn">Warn</option>
                      <option value="mute">Mute</option>
                      <option value="ban">Ban</option>
                      <option value="reply">Reply</option>
                      <option value="send_message">Post notice</option>
                      <option value="record_only">Record only</option>
                    </select>
                  </label>
                  {ruleDraft.actionType === 'mute' && (
                    <label>
                      <span>Mute seconds</span>
                      <input
                        min="1"
                        onChange={(event) => updateRuleDraft({ actionSeconds: numberInputValue(event.currentTarget.value, 600) })}
                        type="number"
                        value={ruleDraft.actionSeconds}
                      />
                    </label>
                  )}
                  {ruleDraftNeedsActionText(ruleDraft.actionType) && (
                    <label>
                      <span>{ruleDraft.actionType === 'reply' || ruleDraft.actionType === 'send_message' ? 'Message' : 'Reason'}</span>
                      <input
                        onChange={(event) => updateRuleDraft({ actionText: event.currentTarget.value })}
                        placeholder={actionPlaceholder(ruleDraft.actionType)}
                        type="text"
                        value={ruleDraft.actionText}
                      />
                    </label>
                  )}
                </div>
                <div className="rule-form-section rule-form-section-meta">
                  <span className="rule-form-section-title">Rule</span>
                  <label>
                    <span>Name</span>
                    <input
                      onChange={(event) => updateRuleDraft({ name: event.currentTarget.value })}
                      placeholder="No promo links"
                      type="text"
                      value={ruleDraft.name}
                    />
                  </label>
                  <label>
                    <span>Priority</span>
                    <input
                      min="1"
                      onChange={(event) => updateRuleDraft({ priority: numberInputValue(event.currentTarget.value, GUARD_RULE_DEFAULT_PRIORITY) })}
                      type="number"
                      value={ruleDraft.priority}
                    />
                  </label>
                </div>
              </div>
              <div className="guard-rule-modal-actions">
                <button className="secondary-action" type="button" onClick={() => setRuleFormOpen(false)}>
                  Cancel
                </button>
                <button className="primary-action guard-rule-submit" disabled={creatingRule} type="submit">
                  {creatingRule ? 'Saving...' : 'Save rule'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}

export function nextGuardGroupId(groups: readonly GuardGroup[], current: number | null): number | null {
  if (current != null && groups.some((group) => group.id === current)) return current
  return groups[0]?.id ?? null
}

export function guardActivityStatusClass(status: string): string {
  if (status === 'executed') return 'guard-activity-executed'
  if (status === 'failed') return 'guard-activity-failed'
  if (status === 'delayed') return 'guard-activity-delayed'
  if (status === 'dry_run') return 'guard-activity-dry-run'
  if (status === 'skipped') return 'guard-activity-skipped'
  return 'guard-activity-unknown'
}

export function guardRuleRequestFromDraft(groupId: number, draft: GuardRuleDraft): {
  group_id: number
  name: string
  enabled: boolean
  priority: number
  conditions: JsonValue[]
  actions: JsonValue[]
} {
  return {
    group_id: groupId,
    name: draft.name.trim() || defaultRuleName(draft),
    enabled: draft.enabled,
    priority: Math.max(1, Math.trunc(draft.priority)),
    conditions: [guardRuleConditionFromDraft(draft)],
    actions: [guardRuleActionFromDraft(draft)],
  }
}

export function guardRuleConditionFromDraft(draft: GuardRuleDraft): JsonValue {
  switch (draft.conditionType) {
    case 'message_contains_text':
      return { type: 'message_contains_text', text: draft.conditionText.trim(), case_sensitive: false }
    case 'message_matches_regex':
      return { type: 'message_matches_regex', pattern: draft.conditionText.trim() }
    case 'message_contains_url':
    case 'message_contains_invite_link':
    case 'member_is_new':
      return { type: draft.conditionType }
    case 'message_repeated':
      return { type: 'message_repeated', window_seconds: Math.max(1, Math.trunc(draft.conditionSeconds)) }
    case 'message_rate_exceeded':
      return {
        type: 'message_rate_exceeded',
        window_seconds: Math.max(1, Math.trunc(draft.conditionSeconds)),
        max_messages: Math.max(1, Math.trunc(draft.conditionCount)),
      }
    case 'member_age_less_than':
      return { type: 'member_age_less_than', seconds: Math.max(1, Math.trunc(draft.conditionSeconds)) }
    case 'message_command':
      return { type: 'message_command', command: draft.conditionText.trim() }
  }
}

export function guardRuleActionFromDraft(draft: GuardRuleDraft): JsonValue {
  switch (draft.actionType) {
    case 'delete_message':
      return { type: 'delete_message' }
    case 'warn':
      return { type: 'warn', reason: draft.actionText.trim() }
    case 'mute':
      return {
        type: 'mute',
        seconds: Math.max(1, Math.trunc(draft.actionSeconds)),
        ...(draft.actionText.trim() === '' ? {} : { reason: draft.actionText.trim() }),
      }
    case 'ban':
      return { type: 'ban', ...(draft.actionText.trim() === '' ? {} : { reason: draft.actionText.trim() }) }
    case 'reply':
      return { type: 'reply', text: draft.actionText.trim() }
    case 'send_message':
      return { type: 'send_message', text: draft.actionText.trim() }
    case 'record_only':
      return { type: 'record_only', reason: draft.actionText.trim() }
  }
}

function guardRulePreset(preset: 'links' | 'flood' | 'invites'): GuardRuleDraft {
  if (preset === 'flood') {
    return {
      ...DEFAULT_GUARD_RULE_DRAFT,
      name: 'Rate limit',
      conditionType: 'message_rate_exceeded',
      conditionSeconds: 30,
      conditionCount: 5,
      actionType: 'mute',
      actionText: 'flood',
      actionSeconds: 300,
    }
  }
  if (preset === 'invites') {
    return {
      ...DEFAULT_GUARD_RULE_DRAFT,
      name: 'Block invite links',
      conditionType: 'message_contains_invite_link',
      actionType: 'delete_message',
    }
  }
  return {
    ...DEFAULT_GUARD_RULE_DRAFT,
    name: 'Block URLs',
    conditionType: 'message_contains_url',
    actionType: 'delete_message',
  }
}

function guardRuleSummary(rule: GuardRule): string {
  const condition = rule.conditions.map(guardConditionLabel).filter(Boolean).join(' + ') || 'No trigger'
  const action = rule.actions.map(guardActionLabel).filter(Boolean).join(' + ') || 'No action'
  return `${condition} -> ${action} · Priority ${rule.priority}`
}

function guardConditionLabel(condition: JsonValue): string {
  if (!isJsonRecord(condition) || typeof condition.type !== 'string') return ''
  if (condition.type === 'message_contains_url') return 'URL'
  if (condition.type === 'message_contains_invite_link') return 'Invite link'
  if (condition.type === 'message_contains_text') return `Text "${String(condition.text ?? '')}"`
  if (condition.type === 'message_matches_regex') return `Regex ${String(condition.pattern ?? '')}`
  if (condition.type === 'message_repeated') return `Repeat in ${String(condition.window_seconds ?? '?')}s`
  if (condition.type === 'message_rate_exceeded') return `${String(condition.max_messages ?? '?')} msgs / ${String(condition.window_seconds ?? '?')}s`
  if (condition.type === 'member_is_new') return 'New member'
  if (condition.type === 'member_age_less_than') return `Joined < ${String(condition.seconds ?? '?')}s`
  if (condition.type === 'message_command') return `Command ${String(condition.command ?? '')}`
  if (condition.type === 'member_warning_count_at_least') return `${String(condition.count ?? '?')} warnings`
  return condition.type
}

function guardActionLabel(action: JsonValue): string {
  if (!isJsonRecord(action) || typeof action.type !== 'string') return ''
  if (action.type === 'delete_message') return 'Delete'
  if (action.type === 'warn') return 'Warn'
  if (action.type === 'mute') return `Mute ${String(action.seconds ?? '?')}s`
  if (action.type === 'ban') return 'Ban'
  if (action.type === 'reply') return 'Reply'
  if (action.type === 'send_message') return 'Post notice'
  if (action.type === 'record_only') return 'Record'
  return action.type
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function defaultRuleName(draft: GuardRuleDraft): string {
  if (draft.conditionType === 'message_contains_url') return 'Block URLs'
  if (draft.conditionType === 'message_contains_invite_link') return 'Block invite links'
  if (draft.conditionType === 'message_matches_regex') return 'Match regex'
  if (draft.conditionType === 'message_contains_text') return 'Match text'
  if (draft.conditionType === 'message_rate_exceeded') return 'Rate limit'
  if (draft.conditionType === 'message_repeated') return 'Repeated message'
  if (draft.conditionType === 'member_is_new') return 'New member'
  if (draft.conditionType === 'member_age_less_than') return 'Member age'
  return 'Command'
}

function ruleDraftNeedsText(conditionType: GuardRuleConditionKind): boolean {
  return conditionType === 'message_contains_text'
    || conditionType === 'message_matches_regex'
    || conditionType === 'message_command'
}

function ruleDraftNeedsSeconds(conditionType: GuardRuleConditionKind): boolean {
  return conditionType === 'message_repeated'
    || conditionType === 'message_rate_exceeded'
    || conditionType === 'member_age_less_than'
}

function ruleDraftNeedsActionText(actionType: GuardRuleActionKind): boolean {
  return actionType === 'warn'
    || actionType === 'mute'
    || actionType === 'ban'
    || actionType === 'reply'
    || actionType === 'send_message'
    || actionType === 'record_only'
}

function conditionPlaceholder(conditionType: GuardRuleConditionKind): string {
  if (conditionType === 'message_matches_regex') return 'promo|spam'
  if (conditionType === 'message_command') return '/start'
  return 'keyword'
}

function actionPlaceholder(actionType: GuardRuleActionKind): string {
  if (actionType === 'reply' || actionType === 'send_message') return 'Please follow the group rules.'
  return 'Rule matched'
}

function numberInputValue(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function activityDetailLabel(item: GuardActivityItem): string {
  const parts = [
    item.event_type,
    `Chat ${displayChatId(item.chat_id)}`,
    item.user_id == null ? '' : `User ${item.user_id}`,
    item.rule_name == null ? '' : `Rule ${item.rule_name}`,
  ].filter(Boolean)
  return parts.join(' · ')
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

function messageIdLabels(message: MessageRow): string[] {
  if (message.grouped_id != null) {
    return [
      `Grouped ID ${message.grouped_id}`,
      message.msg_ids.length > 1 ? `Messages ${message.msg_ids.join(', ')}` : `Message ${message.msg_id}`,
    ]
  }
  return [`Message ${message.msg_id}`]
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

export function senderAvatar(senderName: string | null, senderId: number | null): { label: string; background: string } {
  const displayName = senderName?.trim() ?? ''
  const hashKey = senderId == null ? displayName : String(senderId)
  const hash = stableHash(hashKey || '?')
  return {
    label: senderAvatarLabel(displayName),
    background: SENDER_AVATAR_BACKGROUNDS[hash % SENDER_AVATAR_BACKGROUNDS.length]!,
  }
}

export function senderBlacklistKey(senderName: string | null, senderId: number | null): string | null {
  if (senderId != null) return `id:${senderId}`
  const normalizedName = senderName?.trim()
  return normalizedName == null || normalizedName === '' ? null : `name:${normalizedName.toLocaleLowerCase()}`
}

export function visibleMessagesForBlacklist<T extends { sender_id: number | null; sender_name: string | null }>(
  messages: readonly T[],
  blockedSenderKeys: ReadonlySet<string | null>,
): T[] {
  return messages.filter((message) => {
    const key = senderBlacklistKey(message.sender_name, message.sender_id)
    return key == null || !blockedSenderKeys.has(key)
  })
}

function senderAvatarLabel(displayName: string): string {
  const parts = displayName.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return parts
      .slice(0, 2)
      .map((part) => Array.from(part)[0] ?? '')
      .join('')
      .toUpperCase()
  }
  return Array.from(displayName)[0]?.toUpperCase() ?? '?'
}

function senderDisplayLabel(senderName: string | null, senderId: number | null): string {
  return senderName?.trim() || (senderId == null ? 'Unknown sender' : `ID ${senderId}`)
}

function senderBlacklistStorageKey(account: string, chatId: number | null): string | null {
  if (account.trim() === '' || chatId == null) return null
  return `tg-web:sender-blacklist:${account}:${chatId}`
}

function readBlockedSenders(key: string | null): BlockedSender[] {
  if (key == null || typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isBlockedSender) : []
  } catch {
    return []
  }
}

function writeBlockedSenders(key: string | null, senders: BlockedSender[]): void {
  if (key == null || typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(senders))
}

function isBlockedSender(value: unknown): value is BlockedSender {
  if (value == null || typeof value !== 'object') return false
  const candidate = value as Partial<BlockedSender>
  return typeof candidate.key === 'string'
    && (typeof candidate.sender_id === 'number' || candidate.sender_id == null)
    && (typeof candidate.sender_name === 'string' || candidate.sender_name == null)
    && typeof candidate.label === 'string'
    && typeof candidate.blocked_at === 'string'
}

function stableHash(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = ((hash << 5) - hash + char.codePointAt(0)!) >>> 0
  }
  return hash
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function syncErrorText(state: SyncTaskState): string {
  return state.status === 'error'
    ? `Sync failed (${state.error.code}): ${state.error.message}`
    : ''
}
