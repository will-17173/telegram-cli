import { useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteJson,
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
import {
  DEFAULT_LOCALE,
  formatDateForLocale,
  formatMessage,
  getStoredLocale,
  messages as localeMessages,
  replaceUrlLocale,
  resolveInitialLocale,
  storeLocale,
  type Locale,
  type WebMessages,
} from './i18n.js'

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

export type DownloadStatus =
  | { state: 'downloading' }
  | { state: 'done'; destination?: string; fileCount?: number }
  | { state: 'error'; message: string }

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

function downloadStateLabel(state: DownloadVisualState, t: WebMessages): string {
  if (state === 'downloaded') return t.messages.downloaded
  if (state === 'partial') return t.messages.partialDownloaded
  if (state === 'not-downloaded') return t.messages.notDownloaded
  return ''
}

export function downloadStatusLabel(status: DownloadStatus, t: WebMessages): string {
  if (status.state === 'downloading') return t.messages.downloading
  if (status.state === 'error') return status.message
  const destination = status.destination ?? (status.fileCount == null ? undefined : formatMessage(t.messages.files, { count: status.fileCount }))
  return destination == null ? t.messages.downloaded : formatMessage(t.messages.downloadedTo, { destination })
}

function DownloadStatusIcon({ state, t }: { state: DownloadVisualState; t: WebMessages }) {
  const label = downloadStateLabel(state, t)
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

function browserNavigatorLanguages(): string[] {
  if (typeof navigator === 'undefined') return []
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return [...navigator.languages]
  return navigator.language == null ? [] : [navigator.language]
}

export function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function initialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  const storage = browserLocalStorage()
  return resolveInitialLocale({
    search: window.location.search,
    storedLocale: getStoredLocale(storage),
    navigatorLanguages: browserNavigatorLanguages(),
  })
}

export function App() {
  const guardOnly = guardOnlyMode()
  const [locale, setLocale] = useState<Locale>(() => initialLocale())
  // Locale dictionary lookup: messages[locale].
  const t = localeMessages[locale]
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
  const [downloadStatus, setDownloadStatus] = useState<Record<string, DownloadStatus>>({})
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
    if (typeof document !== 'undefined') document.documentElement.lang = locale
  }, [locale])

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
    if (selectedChat == null) return t.messages.noChatSelected
    return formatMessage(t.messages.messagesFromTo, {
      count: selectedChat.msg_count,
      first: formatDate(selectedChat.first_msg, locale),
      last: formatDate(selectedChat.last_msg, locale),
    })
  }, [locale, selectedChat, t])

  const selectedChatName = selectedChat?.chat_name ?? (selectedChat == null ? t.messages.selectChat : formatMessage(t.messages.chatId, { id: selectedChat.chat_id }))
  const totalMessagePages = Math.max(1, Math.ceil(messageTotal / messagePageSize))
  const visibleMessagePages = paginationWindow(messagePage, totalMessagePages)
  const blockedSenderKeys = useMemo(() => new Set(blockedSenders.map((sender) => sender.key)), [blockedSenders])
  const visibleMessages = useMemo(() => visibleMessagesForBlacklist(messages, blockedSenderKeys), [messages, blockedSenderKeys])
  const hiddenMessageCount = messages.length - visibleMessages.length

  function changeLocale(nextLocale: Locale): void {
    setLocale(nextLocale)
    if (typeof window === 'undefined') return
    storeLocale(browserLocalStorage(), nextLocale)
    replaceUrlLocale(window.location, window.history, nextLocale)
  }

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
          label: senderDisplayLabel(message.sender_name, message.sender_id, t),
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
      for (const key of keys) next[key] = { state: 'downloading' }
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
      const doneStatus: DownloadStatus = result.downloaded.length === 1
        ? { state: 'done', destination: result.downloaded[0]?.path }
        : { state: 'done', fileCount: result.downloaded.length }
      setDownloadStatus((current) => {
        const next = { ...current }
        for (const key of keys) next[key] = doneStatus
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
        for (const key of keys) next[key] = { state: 'error', message }
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
        setError(syncErrorText(state, t))
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
            <span>{guardOnly ? t.shell.guardConsole : t.shell.localMessageConsole}</span>
          </div>
        </div>
        {!guardOnly && <label className="account-picker">
          <span>{t.shell.account}</span>
          <select value={account} onChange={(event) => { setAccount(event.target.value); setSelectedChat(null); setMessages([]); setMessageTotal(0); setMessagePage(1); setMessagePageInput('1') }}>
            {accounts.accounts.map((item) => (
              <option key={item.name} value={item.name}>
                {item.display_name || item.username || item.name}
              </option>
            ))}
          </select>
        </label>}
        {!guardOnly && <nav className="view-tabs" aria-label={t.shell.workspaceView}>
          <button className={view === 'messages' ? 'active-tab' : ''} onClick={() => setView('messages')} type="button">
            {t.shell.messages}
          </button>
          <button className={view === 'guard' ? 'active-tab' : ''} onClick={() => setView('guard')} type="button">
            {t.shell.guard}
          </button>
        </nav>}
        <label className="language-picker">
          <span>{t.shell.language}</span>
          <select value={locale} onChange={(event) => changeLocale(event.currentTarget.value as Locale)}>
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
        {!guardOnly && <span className={`sync-pill sync-pill-${syncTask.status}`} role="status" aria-live="polite" title={syncTask.status === 'error' ? syncErrorText(syncTask, t) : undefined}>
          {formatMessage(t.shell.syncStatus, { status: syncTask.status })}
        </span>}
      </header>

      {error && <div className="error-strip" role="alert">{error}</div>}

      {!guardOnly && view === 'messages' ? (
      <section className="workspace" aria-label={t.shell.localMessageConsole}>
        <aside className="sidebar">
          <div className="sidebar-tools">
            <div className="panel-kicker">{t.messages.chats}</div>
            <label>
              <input value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} placeholder={t.messages.searchChats} />
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
                <span className="chat-name">{chat.chat_name ?? formatMessage(t.messages.chatId, { id: displayChatId(chat.chat_id) })}</span>
                <span className="chat-meta">
                  <span>{formatMessage(t.messages.messages, { count: chat.msg_count })}</span>
                  <time dateTime={chat.last_msg}>{formatDate(chat.last_msg, locale)}</time>
                </span>
              </button>
            ))}
            {!loadingChats && chats.length === 0 && <p className="empty-note">{t.messages.noLocalChats}</p>}
          </div>
        </aside>

        <section className="messages-pane">
          <div className="chat-header">
            <div>
              <span className="panel-kicker">{t.messages.messageStream}</span>
              <div className="chat-title-row">
                <h1>{selectedChatName}</h1>
                {selectedChat != null && <span className="selected-chat-id">{formatMessage(t.messages.chatId, { id: displayChatId(selectedChat.chat_id) })}</span>}
              </div>
              <p>{selectedSummary}</p>
            </div>
            <button className="primary-action" onClick={syncCurrentChat} disabled={selectedChat == null || syncTask.status === 'running'} type="button">
              {t.messages.syncCurrentChat}
            </button>
          </div>

          <section className="filter-panel" aria-label={t.messages.messageFilters}>
            <div className="filter-panel-heading">
              <span className="panel-kicker">{t.messages.filters}</span>
              <div className="filter-panel-heading-actions">
                <span>
                  {loadingMessages
                    ? t.messages.readingLocalCache
                    : `${formatMessage(t.messages.messagesShown, { visible: visibleMessages.length, total: messageTotal })}${hiddenMessageCount > 0 ? formatMessage(t.messages.hiddenCountSuffix, { count: hiddenMessageCount }) : ''}`}
                </span>
                <button
                  className="manage-sender-blacklist secondary-action"
                  type="button"
                  onClick={() => setBlacklistOpen(true)}
                  disabled={selectedChat == null}
                >
                  {formatMessage(t.messages.blacklistCount, { count: blockedSenders.length })}
                </button>
              </div>
            </div>
            <div className="filters">
              <label>
                <span>{t.messages.senderId}</span>
                <input value={senderId} onChange={(event) => setSenderId(event.target.value)} inputMode="numeric" placeholder="123456789" />
              </label>
              <label>
                <span>{t.messages.senderName}</span>
                <input value={senderName} onChange={(event) => setSenderName(event.target.value)} placeholder="name" />
              </label>
              <label>
                <span>{t.messages.text}</span>
                <input value={text} onChange={(event) => setText(event.target.value)} placeholder="message text" />
              </label>
              <label>
                <span>{t.messages.since}</span>
                <input type="datetime-local" value={since} onChange={(event) => setSince(event.target.value)} />
              </label>
              <label>
                <span>{t.messages.until}</span>
                <input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} />
              </label>
              <button onClick={() => void loadMessages(1)} disabled={selectedChat == null || loadingMessages} type="button">
                {t.common.search}
              </button>
              <button className="secondary-action" onClick={resetMessageFilters} disabled={selectedChat == null || loadingMessages} type="button">
                {t.common.reset}
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
                      <DownloadStatusIcon state={messageDownloadState(message)} t={t} />
                      <time dateTime={message.timestamp}>{formatDate(message.timestamp, locale)}</time>
                    </span>
                    {messageIdLabels(message, t).map((label) => <span key={label}>{label}</span>)}
                  </div>
                  <div className="message-body">
                    <div className="sender-head">
                      <span className="sender-avatar" style={{ background: avatar.background }} aria-hidden="true">
                        {avatar.label}
                      </span>
                      <div className="sender-line">
                        <strong>{message.sender_name ?? t.common.unknown}</strong>
                        <span>{formatMessage(t.messages.id, { id: message.sender_id ?? t.common.unknown.toLowerCase() })}</span>
                        {message.sender_id != null && (
                          <button
                            className="sender-filter-action"
                            type="button"
                            onClick={() => filterByMessageSender(message)}
                            disabled={loadingMessages}
                            title={t.messages.filterBySender}
                            data-tooltip={t.messages.filterBySender}
                            aria-label={formatMessage(t.messages.filterBySenderAria, { sender: message.sender_name ?? formatMessage(t.messages.id, { id: message.sender_id }) })}
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
                            title={t.messages.hideSender}
                            data-tooltip={t.messages.hideSender}
                            aria-label={formatMessage(t.messages.hideSenderAria, { sender: senderDisplayLabel(message.sender_name, message.sender_id, t) })}
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
                          {message.reply_context.resolved && <time dateTime={message.reply_context.timestamp}>{formatDate(message.reply_context.timestamp, locale)}</time>}
                          <span>{replySenderLabel(message.reply_context, t)}</span>
                          <span>{replyMessageIdLabel(message.reply_context)}</span>
                        </div>
                        {replyContentLabel(message.reply_context, t) && <p>{replyContentLabel(message.reply_context, t)}</p>}
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
                                <DownloadStatusIcon state={attachmentDownloadState(attachment)} t={t} />
                                {attachmentLabel(attachment)}
                              </span>
                              <small>{attachmentDisplayName(attachment)}</small>
                              <small className="attachment-message-id">{formatMessage(t.messages.message, { id: attachment.msg_id })}</small>
                              {downloadStatus[key] && <small>{downloadStatusLabel(downloadStatus[key], t)}</small>}
                            </div>
                            {attachment.downloadable && (
                              <button
                                className="attachment-action"
                                type="button"
                                onClick={() => void downloadAttachments([attachment])}
                                disabled={downloadStatus[key]?.state === 'downloading'}
                              >
                                {t.messages.download}
                              </button>
                            )}
                          </div>
                          )
                        })}
                        {downloadable.length > 1 && (
                          <button
                            className="download-all"
                            type="button"
                            onClick={() => void downloadAttachments(downloadable)}
                            disabled={downloadable.some((attachment) => downloadStatus[attachmentKey(attachment)]?.state === 'downloading')}
                          >
                            {t.messages.downloadAll}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>

          {!loadingMessages && selectedChat != null && messages.length === 0 && <p className="empty-note">{t.messages.noMatchingMessages}</p>}
          {!loadingMessages && selectedChat != null && messages.length > 0 && visibleMessages.length === 0 && (
            <p className="empty-note">{t.messages.allHiddenByBlacklist}</p>
          )}
          {selectedChat != null && (
            <nav className="message-pager" aria-label={t.messages.messagePages}>
              <label className="pager-size">
                <span>{t.messages.pageSize}</span>
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
                  {t.messages.first}
                </button>
                <button onClick={() => void loadMessages(messagePage - 1)} disabled={loadingMessages || messagePage <= 1} type="button">
                  {t.messages.previous}
                </button>
                <div className="pager-pages" aria-label={t.messages.pageNumbers}>
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
                  {t.messages.next}
                </button>
                <button onClick={() => void loadMessages(totalMessagePages)} disabled={loadingMessages || messagePage >= totalMessagePages} type="button">
                  {t.messages.last}
                </button>
              </div>
              <div className="pager-jump-group">
                <label className="pager-jump">
                  <span>{t.messages.jumpTo}</span>
                  <input
                    value={messagePageInput}
                    onChange={(event) => setMessagePageInput(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') goToMessagePage() }}
                    inputMode="numeric"
                    aria-label={t.messages.messagePage}
                  />
                </label>
                <span className="pager-count">/ {totalMessagePages}</span>
                <button onClick={goToMessagePage} disabled={loadingMessages} type="button">
                  {t.common.go}
                </button>
              </div>
            </nav>
          )}
        </section>
      </section>
      ) : <GuardWorkbench t={t} locale={locale} />}
      {!guardOnly && blacklistOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="blacklist-modal" role="dialog" aria-modal="true" aria-labelledby="sender-blacklist-title">
            <div className="blacklist-modal-heading">
              <div>
                <span className="panel-kicker">{t.messages.messageVisibility}</span>
                <h2 id="sender-blacklist-title">{t.messages.senderBlacklist}</h2>
              </div>
              <button className="modal-close" type="button" onClick={() => setBlacklistOpen(false)} aria-label={t.messages.closeSenderBlacklist}>
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6 6 18 18" />
                  <path d="M18 6 6 18" />
                </svg>
              </button>
            </div>
            {blockedSenders.length === 0
              ? <p className="empty-note">{t.messages.noSendersHidden}</p>
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
                          <small>{sender.sender_id == null ? t.messages.nameMatch : formatMessage(t.messages.id, { id: sender.sender_id })}</small>
                        </span>
                        <button type="button" onClick={() => removeBlockedSender(sender.key)}>
                          {t.common.remove}
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

function GuardWorkbench({ t, locale }: { t: WebMessages; locale: Locale }) {
  const [status, setStatus] = useState<GuardRuntimeState | null>(null)
  const [groups, setGroups] = useState<GuardGroup[]>([])
  const [rules, setRules] = useState<GuardRule[]>([])
  const [activity, setActivity] = useState<GuardActivityItem[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingRules, setLoadingRules] = useState(false)
  const [discoveringGroups, setDiscoveringGroups] = useState(false)
  const [creatingRule, setCreatingRule] = useState(false)
  const [deletingRuleId, setDeletingRuleId] = useState<number | null>(null)
  const [updatingRuleId, setUpdatingRuleId] = useState<number | null>(null)
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
      await postJson<GuardRule>('/api/guard/rules', guardRuleRequestFromDraft(selectedGroupId, ruleDraft, t))
      setRuleDraft(DEFAULT_GUARD_RULE_DRAFT)
      setRuleFormOpen(false)
      await loadGuardRules(selectedGroupId)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setCreatingRule(false)
    }
  }

  async function deleteRule(rule: GuardRule): Promise<void> {
    if (selectedGroupId == null) return
    setDeletingRuleId(rule.id)
    setError('')
    try {
      await deleteJson<{ deleted: boolean }>(`/api/guard/rules/${rule.id}`)
      await loadGuardRules(selectedGroupId)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setDeletingRuleId(null)
    }
  }

  async function toggleRule(rule: GuardRule): Promise<void> {
    setUpdatingRuleId(rule.id)
    setError('')
    try {
      const updated = await patchJson<GuardRule>(`/api/guard/rules/${rule.id}`, { enabled: !rule.enabled })
      setRules((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setUpdatingRuleId(null)
    }
  }

  function updateRuleDraft(update: Partial<GuardRuleDraft>): void {
    setRuleDraft((current) => ({ ...current, ...update }))
  }

  async function discoverGuardGroups(): Promise<void> {
    setDiscoveringGroups(true)
    setError('')
    try {
      const groupsData = await postJson<Page<GuardGroup>>('/api/guard/groups/discover', {})
      setGroups(groupsData.items)
      const latestSelectedGroupId = selectedGroupIdRef.current
      setSelectedGroupId(nextGuardGroupId(groupsData.items, latestSelectedGroupId))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setDiscoveringGroups(false)
    }
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
    <section className="guard-workbench" aria-label={t.shell.guardConsole}>
      <div className="guard-overview">
        <div>
          <span className="panel-kicker">{t.shell.guardConsole}</span>
          <h1>{t.guard.groupAutomation}</h1>
          <p>{status?.error ?? t.guard.runtimeDescription}</p>
        </div>
        <button className="secondary-action" type="button" onClick={() => void loadGuard()} disabled={loading}>
          {t.common.refresh}
        </button>
      </div>

      {error && <div className="guard-error" role="alert">{error}</div>}

      <section className="guard-metrics" aria-label={t.guard.runtime}>
        <div className="guard-metric guard-metric-runtime">
          <span>{t.guard.runtime}</span>
          <strong>{status?.status ?? 'stopped'}</strong>
          <small>{status?.started_at == null ? t.guard.notStarted : formatMessage(t.guard.started, { date: formatDate(status.started_at, locale) })}</small>
        </div>
        <div className="guard-metric">
          <span>{t.guard.groupsLabel}</span>
          <strong>{enabledGroups}/{groups.length}</strong>
          <small>{t.guard.enabledForAutomation}</small>
        </div>
        <div className="guard-metric">
          <span>{t.guard.queue}</span>
          <strong>{status?.queue_length ?? 0}</strong>
          <small>{t.guard.pendingActions}</small>
        </div>
        <div className="guard-metric">
          <span>{t.guard.activityLabel}</span>
          <strong>{activity.length}</strong>
          <small>{t.guard.recentRecords}</small>
        </div>
      </section>

      <section className="guard-grid">
        <section className="guard-panel guard-groups-panel" aria-label={t.guard.managedGroups}>
          <div className="guard-panel-heading">
            <div>
              <span className="panel-kicker">{t.guard.managedGroups}</span>
              <h2>{formatMessage(t.guard.groups, { count: groups.length })}</h2>
            </div>
            <div className="guard-heading-actions">
              <span className="guard-count">{loading ? t.common.loading : formatMessage(t.guard.groupsEnabled, { enabled: enabledGroups })}</span>
              <button className="secondary-action compact-action" type="button" onClick={() => void discoverGuardGroups()} disabled={discoveringGroups}>
                {discoveringGroups ? t.common.syncing : t.guard.syncGroups}
              </button>
            </div>
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
                  <strong>{group.title ?? formatMessage(t.messages.chatId, { id: displayChatId(group.chat_id) })}</strong>
                  <small>{displayChatId(group.chat_id)}</small>
                </span>
                <span className={`guard-status ${guardGroupStatusClass(group)}`}>{guardGroupStatusLabel(group, t)}</span>
              </button>
            ))}
            {!loading && groups.length === 0 && <p className="empty-note">{t.guard.noManagedGroups}</p>}
          </div>
        </section>

        <section className="guard-panel guard-detail-panel" aria-label={t.guard.selectedGroupRulesAndPolicy}>
          <div className="guard-panel-heading">
            <div>
              <span className="panel-kicker">{t.guard.rules}</span>
              <h2>{selectedGroup == null ? t.guard.selectGroup : selectedGroup.title ?? formatMessage(t.messages.chatId, { id: displayChatId(selectedGroup.chat_id) })}</h2>
            </div>
            <div className="guard-heading-actions">
              <span className="guard-count">{loadingRules ? t.common.loading : formatMessage(t.guard.rulesEnabled, { enabled: enabledRules, total: rules.length })}</span>
              {selectedGroup != null && (
                <button
                  className="secondary-action compact-action"
                  type="button"
                  onClick={() => {
                    setRuleDraft(DEFAULT_GUARD_RULE_DRAFT)
                    setRuleFormOpen(true)
                  }}
                >
                  {t.guard.newRule}
                </button>
              )}
            </div>
          </div>

          {selectedGroup != null && (
            <div className="guard-policy-bar" aria-label={t.guard.groupPolicy}>
              <button
                className={selectedGroup.enabled ? 'guard-arm-toggle guard-arm-toggle-on' : 'guard-arm-toggle'}
                disabled={updatingGroup}
                type="button"
                onClick={() => void updateSelectedGroup({ enabled: !selectedGroup.enabled })}
              >
                <span>{selectedGroup.enabled ? t.guard.rulesOn : t.guard.rulesOff}</span>
                <strong>{guardGroupStatusLabel(selectedGroup, t)}</strong>
              </button>
              <div className="guard-policy-strip" aria-label={t.guard.groupPolicyLimits}>
                <span className="policy-strip-label">{t.guard.policyLimits}</span>
                <span className={selectedGroup.policy.allow_delete ? 'policy-chip policy-chip-on' : 'policy-chip'}>{selectedGroup.policy.allow_delete ? t.guard.deleteAllowed : t.guard.deleteBlocked}</span>
                <span className={selectedGroup.policy.allow_mute ? 'policy-chip policy-chip-on' : 'policy-chip'}>{selectedGroup.policy.allow_mute ? t.guard.muteAllowed : t.guard.muteBlocked}</span>
                <span className={selectedGroup.policy.allow_ban ? 'policy-chip policy-chip-on' : 'policy-chip'}>{selectedGroup.policy.allow_ban ? t.guard.banAllowed : t.guard.banBlocked}</span>
                <span className={selectedGroup.policy.ignore_admins ? 'policy-chip policy-chip-on' : 'policy-chip'}>{selectedGroup.policy.ignore_admins ? t.guard.adminsSkipped : t.guard.adminsIncluded}</span>
                <span className="policy-chip">{formatMessage(t.guard.cooldown, { seconds: selectedGroup.policy.action_cooldown_seconds })}</span>
                <small>{t.guard.policyNote}</small>
              </div>
              <p className="guard-policy-note">{guardGroupStatusDetail(selectedGroup, t)}</p>
            </div>
          )}

          <div className="guard-rule-list" aria-busy={loadingRules}>
            {rules.map((rule) => (
              <article className={rule.enabled ? 'guard-rule-row' : 'guard-rule-row guard-rule-disabled'} key={rule.id}>
                <div>
                  <strong>{rule.name}</strong>
                  <small>{guardRuleSummary(rule, t)}</small>
                </div>
                <button
                  className={rule.enabled ? 'guard-rule-state guard-rule-state-on' : 'guard-rule-state'}
                  disabled={updatingRuleId === rule.id || deletingRuleId === rule.id}
                  type="button"
                  aria-pressed={rule.enabled}
                  onClick={() => void toggleRule(rule)}
                >
                  {updatingRuleId === rule.id ? t.common.updating : rule.enabled ? t.common.enabled : t.common.disabled}
                </button>
                <button
                  className="guard-rule-delete"
                  disabled={deletingRuleId === rule.id || updatingRuleId === rule.id}
                  type="button"
                  onClick={() => void deleteRule(rule)}
                >
                  {deletingRuleId === rule.id ? t.common.deleting : t.common.delete}
                </button>
              </article>
            ))}
            {!loadingRules && selectedGroup != null && rules.length === 0 && <p className="empty-note">{t.guard.noRules}</p>}
          </div>
        </section>
      </section>

      <section className="guard-panel" aria-label={t.guard.activity}>
        <div className="guard-panel-heading">
          <div>
            <span className="panel-kicker">{t.guard.activity}</span>
            <h2>{t.guard.recentActions}</h2>
          </div>
          <span className="guard-count">{formatMessage(t.guard.recentRecordsCount, { count: activity.length })}</span>
        </div>
        <div className="guard-activity-list">
          {activity.map((item) => (
            <div className="guard-activity-row" key={`${item.event_id}:${item.action_id}`}>
              <span className={`guard-activity-mark ${guardActivityStatusClass(item.action_status)}`} aria-hidden="true" />
              <div>
                <strong>{item.action_type}</strong>
                <small>{activityDetailLabel(item, t)}</small>
              </div>
              <span className={guardActivityStatusClass(item.action_status)}>{item.action_status}</span>
              <time dateTime={item.action_created_at}>{formatDate(item.action_created_at, locale)}</time>
            </div>
          ))}
          {activity.length === 0 && <p className="empty-note">{t.guard.noActivity}</p>}
        </div>
      </section>
      {selectedGroup != null && ruleFormOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="guard-rule-modal" role="dialog" aria-modal="true" aria-labelledby="guard-rule-modal-title">
            <div className="guard-rule-modal-heading">
              <div>
                <span className="panel-kicker">{t.guard.newRule}</span>
                <h2 id="guard-rule-modal-title">{selectedGroup.title ?? formatMessage(t.messages.chatId, { id: displayChatId(selectedGroup.chat_id) })}</h2>
                <p>{defaultRuleName(ruleDraft, t)}</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setRuleFormOpen(false)} aria-label={t.guard.closeRuleEditor}>
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
                  <strong>{t.guard.addRule}</strong>
                  <small>{defaultRuleName(ruleDraft, t)}</small>
                </div>
                <div className="rule-template-row" aria-label={t.guard.ruleTemplates}>
                  <button type="button" onClick={() => setRuleDraft(guardRulePreset('links', t))}>{t.guard.links}</button>
                  <button type="button" onClick={() => setRuleDraft(guardRulePreset('flood', t))}>{t.guard.flood}</button>
                  <button type="button" onClick={() => setRuleDraft(guardRulePreset('invites', t))}>{t.guard.invites}</button>
                  <button
                    className={ruleDraft.enabled ? 'guard-rule-enabled-toggle guard-rule-enabled-toggle-on' : 'guard-rule-enabled-toggle'}
                    type="button"
                    aria-pressed={ruleDraft.enabled}
                    onClick={() => updateRuleDraft({ enabled: !ruleDraft.enabled })}
                  >
                    <span className="guard-rule-toggle-track" aria-hidden="true">
                      <span className="guard-rule-toggle-knob" />
                    </span>
                    <span>{ruleDraft.enabled ? t.common.enabled : t.common.disabled}</span>
                  </button>
                </div>
              </div>
              <div className="guard-rule-form-grid">
                <div className="rule-form-section">
                  <span className="rule-form-section-title">{t.guard.when}</span>
                  <label>
                    <span>{t.guard.trigger}</span>
                    <select
                      onChange={(event) => updateRuleDraft({ conditionType: event.currentTarget.value as GuardRuleConditionKind })}
                      value={ruleDraft.conditionType}
                    >
                      <option value="message_contains_url">{t.guard.url}</option>
                      <option value="message_contains_invite_link">{t.guard.inviteLink}</option>
                      <option value="message_contains_text">{t.guard.textContains}</option>
                      <option value="message_matches_regex">{t.guard.pattern}</option>
                      <option value="message_repeated">{t.guard.repeatedMessage}</option>
                      <option value="message_rate_exceeded">{t.guard.messageRate}</option>
                      <option value="member_is_new">{t.guard.newMember}</option>
                      <option value="member_age_less_than">{t.guard.memberAge}</option>
                      <option value="message_command">{t.guard.command}</option>
                    </select>
                  </label>
                  {ruleDraftNeedsText(ruleDraft.conditionType) && (
                    <label>
                      <span>{conditionTextLabel(ruleDraft.conditionType, t)}</span>
                      <input
                        onChange={(event) => updateRuleDraft({ conditionText: event.currentTarget.value })}
                        placeholder={conditionPlaceholder(ruleDraft.conditionType, t)}
                        type="text"
                        value={ruleDraft.conditionText}
                      />
                    </label>
                  )}
                  {ruleDraftNeedsSeconds(ruleDraft.conditionType) && (
                    <label>
                      <span>{t.guard.seconds}</span>
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
                      <span>{t.guard.maxMessages}</span>
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
                  <span className="rule-form-section-title">{t.guard.then}</span>
                  <label>
                    <span>{t.guard.action}</span>
                    <select
                      onChange={(event) => updateRuleDraft({ actionType: event.currentTarget.value as GuardRuleActionKind })}
                      value={ruleDraft.actionType}
                    >
                      <option value="delete_message">{t.common.delete}</option>
                      <option value="warn">{t.guard.warn}</option>
                      <option value="mute">{t.guard.mute}</option>
                      <option value="ban">{t.guard.ban}</option>
                      <option value="reply">{t.guard.reply}</option>
                      <option value="send_message">{t.guard.postNotice}</option>
                      <option value="record_only">{t.guard.recordOnly}</option>
                    </select>
                  </label>
                  {ruleDraft.actionType === 'mute' && (
                    <label>
                      <span>{t.guard.muteSeconds}</span>
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
                      <span>{ruleDraft.actionType === 'reply' || ruleDraft.actionType === 'send_message' ? t.guard.message : t.guard.reason}</span>
                      <input
                        onChange={(event) => updateRuleDraft({ actionText: event.currentTarget.value })}
                        placeholder={actionPlaceholder(ruleDraft.actionType, t)}
                        type="text"
                        value={ruleDraft.actionText}
                      />
                    </label>
                  )}
                </div>
                <div className="rule-form-section rule-form-section-meta">
                  <span className="rule-form-section-title">{t.guard.rule}</span>
                  <label>
                    <span>{t.guard.name}</span>
                    <input
                      onChange={(event) => updateRuleDraft({ name: event.currentTarget.value })}
                      placeholder={t.guard.noPromoLinksPlaceholder}
                      type="text"
                      value={ruleDraft.name}
                    />
                  </label>
                  <label>
                    <span>{t.guard.priority}</span>
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
                  {t.common.cancel}
                </button>
                <button className="primary-action guard-rule-submit" disabled={creatingRule} type="submit">
                  {creatingRule ? t.common.saving : t.guard.saveRule}
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

export function guardGroupStatusLabel(group: Pick<GuardGroup, 'enabled' | 'runtime_status'>, t: WebMessages = localeMessages.en): string {
  if (!group.enabled) return t.guard.rulesOff
  if (group.runtime_status === 'running') return t.guard.listening
  if (group.runtime_status === 'starting') return t.guard.statusStarting
  if (group.runtime_status === 'paused') return t.guard.statusPaused
  if (group.runtime_status === 'error') return t.guard.statusError
  return t.guard.statusRestartNeeded
}

export function guardGroupStatusClass(group: Pick<GuardGroup, 'enabled' | 'runtime_status'>): string {
  if (!group.enabled) return 'guard-status-off'
  if (group.runtime_status === 'running') return 'guard-status-running'
  if (group.runtime_status === 'error') return 'guard-status-error'
  if (group.runtime_status === 'starting') return 'guard-status-starting'
  if (group.runtime_status === 'paused') return 'guard-status-paused'
  return 'guard-status-pending'
}

function guardGroupStatusDetail(group: Pick<GuardGroup, 'enabled' | 'runtime_status'>, t: WebMessages): string {
  if (!group.enabled) return t.guard.rulesOffDetail
  if (group.runtime_status === 'running') return t.guard.rulesListeningDetail
  if (group.runtime_status === 'starting') return t.guard.rulesStartingDetail
  if (group.runtime_status === 'paused') return t.guard.rulesPausedDetail
  if (group.runtime_status === 'error') return t.guard.rulesErrorDetail
  return t.guard.rulesRestartDetail
}

export function guardActivityStatusClass(status: string): string {
  if (status === 'executed') return 'guard-activity-executed'
  if (status === 'failed') return 'guard-activity-failed'
  if (status === 'delayed') return 'guard-activity-delayed'
  if (status === 'dry_run') return 'guard-activity-dry-run'
  if (status === 'skipped') return 'guard-activity-skipped'
  return 'guard-activity-unknown'
}

export function guardRuleRequestFromDraft(groupId: number, draft: GuardRuleDraft, t: WebMessages = localeMessages.en): {
  group_id: number
  name: string
  enabled: boolean
  priority: number
  conditions: JsonValue[]
  actions: JsonValue[]
} {
  return {
    group_id: groupId,
    name: draft.name.trim() || defaultRuleName(draft, t),
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

function guardRulePreset(preset: 'links' | 'flood' | 'invites', t: WebMessages): GuardRuleDraft {
  if (preset === 'flood') {
    return {
      ...DEFAULT_GUARD_RULE_DRAFT,
      name: t.guard.rateLimit,
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
      name: t.guard.blockInviteLinks,
      conditionType: 'message_contains_invite_link',
      actionType: 'delete_message',
    }
  }
  return {
    ...DEFAULT_GUARD_RULE_DRAFT,
    name: t.guard.blockUrls,
    conditionType: 'message_contains_url',
    actionType: 'delete_message',
  }
}

function guardRuleSummary(rule: GuardRule, t: WebMessages): string {
  const condition = rule.conditions.map((item) => guardConditionLabel(item, t)).filter(Boolean).join(' + ') || t.guard.noTrigger
  const action = rule.actions.map((item) => guardActionLabel(item, t)).filter(Boolean).join(' + ') || t.guard.noAction
  return formatMessage(t.guard.ruleSummary, { condition, action, priority: rule.priority })
}

export function guardConditionLabel(condition: JsonValue, t: WebMessages = localeMessages.en): string {
  if (!isJsonRecord(condition) || typeof condition.type !== 'string') return ''
  if (condition.type === 'message_contains_url') return t.guard.url
  if (condition.type === 'message_contains_invite_link') return t.guard.inviteLink
  if (condition.type === 'message_contains_text') return formatMessage(t.guard.textValue, { text: String(condition.text ?? '') })
  if (condition.type === 'message_matches_regex') return formatMessage(t.guard.regexValue, { pattern: String(condition.pattern ?? '') })
  if (condition.type === 'message_repeated') return formatMessage(t.guard.repeatInSeconds, { seconds: String(condition.window_seconds ?? '?') })
  if (condition.type === 'message_rate_exceeded') {
    return formatMessage(t.guard.messageRateValue, {
      count: String(condition.max_messages ?? '?'),
      seconds: String(condition.window_seconds ?? '?'),
    })
  }
  if (condition.type === 'member_is_new') return t.guard.newMember
  if (condition.type === 'member_age_less_than') return formatMessage(t.guard.joinedSeconds, { seconds: String(condition.seconds ?? '?') })
  if (condition.type === 'message_command') return `${t.guard.command} ${String(condition.command ?? '')}`
  if (condition.type === 'member_warning_count_at_least') return formatMessage(t.guard.warningCount, { count: String(condition.count ?? '?') })
  return condition.type
}

function guardActionLabel(action: JsonValue, t: WebMessages): string {
  if (!isJsonRecord(action) || typeof action.type !== 'string') return ''
  if (action.type === 'delete_message') return t.common.delete
  if (action.type === 'warn') return t.guard.warn
  if (action.type === 'mute') return `${t.guard.mute} ${String(action.seconds ?? '?')}s`
  if (action.type === 'ban') return t.guard.ban
  if (action.type === 'reply') return t.guard.reply
  if (action.type === 'send_message') return t.guard.postNotice
  if (action.type === 'record_only') return t.guard.record
  return action.type
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function defaultRuleName(draft: GuardRuleDraft, t: WebMessages): string {
  if (draft.conditionType === 'message_contains_url') return t.guard.blockUrls
  if (draft.conditionType === 'message_contains_invite_link') return t.guard.blockInviteLinks
  if (draft.conditionType === 'message_matches_regex') return t.guard.matchRegex
  if (draft.conditionType === 'message_contains_text') return t.guard.matchText
  if (draft.conditionType === 'message_rate_exceeded') return t.guard.rateLimit
  if (draft.conditionType === 'message_repeated') return t.guard.repeatedMessage
  if (draft.conditionType === 'member_is_new') return t.guard.newMember
  if (draft.conditionType === 'member_age_less_than') return t.guard.memberAge
  return t.guard.command
}

function conditionTextLabel(conditionType: GuardRuleConditionKind, t: WebMessages): string {
  if (conditionType === 'message_matches_regex') return t.guard.pattern
  if (conditionType === 'message_command') return t.guard.command
  return t.messages.text
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

export function conditionPlaceholder(conditionType: GuardRuleConditionKind, t: WebMessages = localeMessages.en): string {
  if (conditionType === 'message_matches_regex') return 'promo|spam'
  if (conditionType === 'message_command') return '/start'
  return t.guard.keywordPlaceholder
}

export function actionPlaceholder(actionType: GuardRuleActionKind, t: WebMessages = localeMessages.en): string {
  if (actionType === 'reply' || actionType === 'send_message') return t.guard.followRulesPlaceholder
  return t.guard.ruleMatchedPlaceholder
}

function numberInputValue(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function activityDetailLabel(item: GuardActivityItem, t: WebMessages = localeMessages.en): string {
  const parts = [
    item.event_type,
    formatMessage(t.messages.chatId, { id: displayChatId(item.chat_id) }),
    item.user_id == null ? '' : formatMessage(t.guard.user, { id: item.user_id }),
    item.rule_name == null ? '' : `${t.guard.rule} ${item.rule_name}`,
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

function formatDate(value: string, locale: Locale = DEFAULT_LOCALE): string {
  return formatDateForLocale(value, locale)
}

function messageIdLabels(message: MessageRow, t: WebMessages): string[] {
  if (message.grouped_id != null) {
    return [
      formatMessage(t.messages.groupedId, { id: message.grouped_id }),
      message.msg_ids.length > 1
        ? formatMessage(t.messages.messagePages, { ids: message.msg_ids.join(', ') })
        : formatMessage(t.messages.message, { id: message.msg_id }),
    ]
  }
  return [formatMessage(t.messages.message, { id: message.msg_id })]
}

export function replySenderLabel(context: MessageRow['reply_context'] | null, t: WebMessages): string {
  if (context == null) return t.messages.messageFallback
  if (!context.resolved) return t.messages.messageFallback
  return context.sender_name?.trim() || (context.sender_id == null ? t.common.unknown : formatMessage(t.messages.id, { id: context.sender_id }))
}

function replyContentLabel(context: MessageRow['reply_context'], t: WebMessages): string {
  if (context == null) return ''
  if (!context.resolved) return t.messages.messageNotFound
  if ((context.content == null || context.content.trim() === '') && context.attachments.length > 0) return ''
  return context.content?.trim() || t.messages.noText
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

function senderDisplayLabel(senderName: string | null, senderId: number | null, t: WebMessages): string {
  return senderName?.trim() || (senderId == null ? t.common.unknown : formatMessage(t.messages.id, { id: senderId }))
}

function senderBlacklistStorageKey(account: string, chatId: number | null): string | null {
  if (account.trim() === '' || chatId == null) return null
  return `tg-web:sender-blacklist:${account}:${chatId}`
}

function readBlockedSenders(key: string | null): BlockedSender[] {
  const storage = browserLocalStorage()
  if (key == null || storage == null) return []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isBlockedSender) : []
  } catch {
    return []
  }
}

function writeBlockedSenders(key: string | null, senders: BlockedSender[]): void {
  const storage = browserLocalStorage()
  if (key == null || storage == null) return
  try {
    storage.setItem(key, JSON.stringify(senders))
  } catch {
    // Sender blacklist persistence is best-effort in restricted browser contexts.
  }
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

function syncErrorText(state: SyncTaskState, t: WebMessages): string {
  return state.status === 'error'
    ? formatMessage(t.messages.syncFailed, { code: state.error.code, message: state.error.message })
    : ''
}
