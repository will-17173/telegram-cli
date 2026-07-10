import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import stringWidth from 'string-width'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import type { TelegramClientAdapter } from '../../telegram/types.js'
import type { StoredMessageInput } from '../../storage/message-db.js'
import { resolveAttachmentDestination } from '../../services/attachment-download.js'
import { ListenAlbumAggregator } from '../../services/listen-album-aggregator.js'
import { buildListenMessage, type ListenAttachment, type ListenMessageRow } from '../listen-message.js'
import { applyMessageArrival, applyScroll, takeListenViewport, type ListenScrollState } from './listen-scroll.js'
import { decodeImagePreview, type PreviewCell } from './image-preview.js'
import { ListenScrollbar, calculateScrollbar, listenContentWidth, useTransientScrollbar } from './listen-scrollbar.js'
import { isMouseInput, useMouseScroll, withMouseReporting, type MouseScrollDirection } from './mouse-scroll.js'

export type ListenMessage = ListenMessageRow & {
  key: string
  chatId: number
  msgId: number
}

export type AttachmentDownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: number | null }
  | { status: 'completed'; path: string }
  | { status: 'failed'; error: string }

type DownloadableAttachment = {
  key: string
  message: ListenMessage
  attachment: ListenAttachment
}

type ListenRuntimeOptions = {
  chats: Array<string | number> | undefined
  persist: boolean
  retrySeconds: number
  sendTo: string | number | undefined
  showMedia: boolean
  createClient: () => TelegramClientAdapter
  stopSignal: AbortSignal
  onRequestStop: () => void
}

const MESSAGE_SEPARATOR = '────────────────────────────────────────────'
/** Maximum number of grouped messages retained by a long-running interactive listener. */
export const LISTEN_HISTORY_LIMIT = 500
export const LISTEN_COMPOSER_THEME = {
  background: '#454950',
  foreground: '#d7dae0',
  cursor: '#8ecbff',
  target: '#f0d38a',
  hint: '#9bdca8',
} as const

type ListenComposerProps = {
  input: string
  sendTargetLabel: string
  terminalWidth: number
  sending?: boolean
  hint?: string
}

export function ListenComposer({
  input,
  sendTargetLabel,
  terminalWidth,
  sending = false,
  hint = 'Enter to send · Ctrl+C to exit',
}: ListenComposerProps): React.JSX.Element {
  const inputText = `› ${input}${sending ? ' (sending...)' : ''}`
  const blankRow = ' '.repeat(Math.max(0, terminalWidth))
  const inputRowFill = ' '.repeat(Math.max(0, terminalWidth - stringWidth(inputText) - 1))

  return (
    <Box flexDirection="column">
      <Text backgroundColor={LISTEN_COMPOSER_THEME.background}>{blankRow}</Text>
      <Text backgroundColor={LISTEN_COMPOSER_THEME.background} color={LISTEN_COMPOSER_THEME.foreground}>
        {inputText}<Text backgroundColor={LISTEN_COMPOSER_THEME.cursor}> </Text>{inputRowFill}
      </Text>
      <Text backgroundColor={LISTEN_COMPOSER_THEME.background}>{blankRow}</Text>
      <Box justifyContent="space-between">
        <Text color={LISTEN_COMPOSER_THEME.target}>To: {sendTargetLabel}</Text>
        <Text color={LISTEN_COMPOSER_THEME.hint}>{hint}</Text>
      </Box>
    </Box>
  )
}

type ListenAttachmentLineProps = {
  label: string
  selected: boolean
  state: AttachmentDownloadState
}

export function ListenAttachmentLine({ label, selected, state }: ListenAttachmentLineProps): React.JSX.Element {
  const action = state.status === 'idle'
    ? '󰇚 Download'
    : state.status === 'downloading'
      ? `Downloading${state.progress == null ? '...' : ` ${state.progress}%`}`
      : state.status === 'completed'
        ? state.path
        : `Failed: ${state.error}`
  return (
    <Text wrap="truncate-end" backgroundColor={selected ? '#3b5368' : undefined} color={selected ? 'white' : undefined}>
      {selected ? '› ' : '  '}{label}  [{action}]
    </Text>
  )
}

export function ListenImagePreview({ rows }: { rows: PreviewCell[][] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex}>  {row.map((cell, cellIndex) => (
          <Text key={cellIndex} color={cell.foreground} backgroundColor={cell.background}>{cell.glyph}</Text>
        ))}</Text>
      ))}
    </Box>
  )
}

type ListenAttachmentWithPreviewProps = ListenAttachmentLineProps & {
  previewCells?: PreviewCell[][]
}

export function ListenAttachmentWithPreview({
  label,
  selected,
  state,
  previewCells,
}: ListenAttachmentWithPreviewProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <ListenAttachmentLine label={label} selected={selected} state={state} />
      {previewCells == null ? null : <ListenImagePreview rows={previewCells} />}
    </Box>
  )
}

export function ListenStatus({ status, unseenCount }: { status: string; unseenCount: number }): React.JSX.Element {
  return <Text dimColor>{status}{unseenCount > 0 ? ` · ↓ ${unseenCount} new messages` : ''}</Text>
}

export async function runInteractiveListen<T>(
  write: (value: string) => unknown,
  run: () => Promise<T>,
): Promise<T> {
  return withMouseReporting({ write, run })
}

export async function renderInteractiveListen(options: ListenRuntimeOptions): Promise<void> {
  await runInteractiveListen(process.stdout.write.bind(process.stdout), async () => {
    const app = render(<InteractiveListen {...options} />, { exitOnCtrlC: false })
    await app.waitUntilExit()
  })
}

function InteractiveListen({
  chats,
  persist,
  retrySeconds,
  sendTo,
  showMedia,
  createClient,
  stopSignal,
  onRequestStop,
}: ListenRuntimeOptions): React.JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [status, setStatus] = useState('connecting...')
  const [messageGroups, setMessageGroups] = useState<StoredMessageInput[][]>([])
  const [input, setInput] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [focus, setFocus] = useState<'input' | 'attachments'>('input')
  const [selectedAttachmentIndex, setSelectedAttachmentIndex] = useState(0)
  const [downloadStates, setDownloadStates] = useState<Record<string, AttachmentDownloadState>>({})
  const [scrollState, setScrollState] = useState<ListenScrollState>({ offset: 0, unseenCount: 0 })
  const [sendTargetLabel, setSendTargetLabel] = useState(sendTo == null ? '' : buildSendTargetLabel(sendTo))
  const terminalWidth = stdout?.columns ?? 80
  const terminalHeight = stdout?.rows ?? 24
  const colorDepth = stdout?.getColorDepth?.() ?? 1
  const contentWidth = listenContentWidth(terminalWidth)
  const previewWidth = Math.max(1, Math.min(24, contentWidth - 2))
  const messageViewCacheRef = useRef<ListenMessageViewCache | null>(null)
  if (messageViewCacheRef.current == null) messageViewCacheRef.current = new ListenMessageViewCache()
  const messages = useMemo(
    () => messageViewCacheRef.current!.build(messageGroups, {
      showMedia,
      previewWidth,
      colorDepth,
    }),
    [messageGroups, showMedia, previewWidth, colorDepth],
  )
  const reservedLines = 7 + (note ? 1 : 0)
  const messagePaneHeight = Math.max(2, terminalHeight - reservedLines)
  const visibleMessages = takeListenViewport(messages, messagePaneHeight, scrollState.offset)
  const clientRef = useRef<TelegramClientAdapter | null>(null)
  const albumAggregatorRef = useRef<ListenAlbumAggregator | null>(null)
  const stoppingRef = useRef(false)
  const seenRef = useRef<Set<string>>(new Set())
  const seenOrderRef = useRef<string[]>([])
  const downloadableAttachments = collectAttachments(visibleMessages)
  const selectedAttachment = downloadableAttachments[selectedAttachmentIndex] ?? downloadableAttachments[0]
  const { visible: scrollbarVisible, show: showScrollbar } = useTransientScrollbar()
  const scrollbarGeometry = calculateScrollbar({
    height: terminalHeight,
    total: messages.length,
    visible: visibleMessages.length,
    offset: scrollState.offset,
  })
  const handleMouseScroll = useCallback((direction: MouseScrollDirection) => {
    showScrollbar()
    setScrollState((current) => applyScroll(current, direction, Math.max(0, messages.length - 1)))
  }, [messages.length, showScrollbar])

  useMouseScroll(handleMouseScroll)

  useEffect(() => {
    const maxOffset = Math.max(0, messages.length - 1)
    setScrollState((current) => {
      const offset = Math.min(current.offset, maxOffset)
      const unseenCount = offset === 0 ? 0 : Math.min(current.unseenCount, messages.length)
      return offset === current.offset && unseenCount === current.unseenCount
        ? current
        : { offset, unseenCount }
    })

    const validAttachmentKeys = new Set(collectAttachments(messages).map((item) => item.key))
    setDownloadStates((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([key]) => validAttachmentKeys.has(key)),
      )
      return Object.keys(retained).length === Object.keys(current).length ? current : retained
    })
    setSelectedAttachmentIndex((current) => Math.min(current, Math.max(0, downloadableAttachments.length - 1)))
    if (downloadableAttachments.length === 0) setFocus('input')
  }, [messages, downloadableAttachments.length])

  useInput((inputText, key) => {
    if (isMouseInput(inputText)) return
    if (key.ctrl && (inputText === 'c' || inputText === 'C' || inputText === '\u0003')) {
      stopListening()
      return
    }
    if (key.tab) {
      if (focus === 'attachments') {
        setFocus('input')
      } else if (downloadableAttachments.length > 0) {
        setFocus('attachments')
        setSelectedAttachmentIndex((current) => Math.min(current, downloadableAttachments.length - 1))
      } else {
        setNote('no downloadable attachments')
      }
      return
    }
    if (focus === 'attachments') {
      if (key.escape) {
        setFocus('input')
        return
      }
      if (key.upArrow || key.downArrow) {
        const offset = key.upArrow ? -1 : 1
        setSelectedAttachmentIndex((current) => {
          const count = downloadableAttachments.length
          return count === 0 ? 0 : (current + offset + count) % count
        })
        return
      }
      if (key.return && selectedAttachment != null) {
        void downloadAttachment(selectedAttachment)
      }
      return
    }
    if (sending) return
    if (key.return) {
      void sendMessage(input)
      return
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1))
      return
    }
    if (key.escape || key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      return
    }
    if (!key.ctrl && !key.meta && inputText.length > 0) {
      setInput((current) => current + inputText)
    }
  })

  useEffect(() => {
    if (stopSignal.aborted) {
      exit()
      return
    }

    const stopFromSignal = () => {
      stopListening()
    }
    stopSignal.addEventListener('abort', stopFromSignal)
    const albumAggregator = new ListenAlbumAggregator({
      emit: (group) => {
        setScrollState((current) => applyMessageArrival(current))
        setMessageGroups((current) => pruneListenMessageGroups([...current, group]).groups)
      },
    })
    albumAggregatorRef.current = albumAggregator

    const run = async (): Promise<void> => {
      try {
        while (true) {
          setStatus('connecting...')
          const client = createClient()
          let retry = false
          clientRef.current = client
          if (sendTo != null) {
            void resolveSendTargetLabel(client, sendTo).then((label) => {
              if (label != null) setSendTargetLabel(label)
            })
          }
          try {
            const result = await client.listen({
              chats,
              signal: stopSignal,
              onConnected: () => setStatus('connected'),
              onMessage: (message: StoredMessageInput) => {
                const key = `${message.chat_id}:${message.msg_id}`
                if (seenRef.current.has(key)) return
                seenRef.current.add(key)
                seenOrderRef.current.push(key)
                if (seenRef.current.size > 5000) {
                  const oldest = seenOrderRef.current.shift()
                  if (oldest != null) seenRef.current.delete(oldest)
                }
                if (sendTo != null) {
                  const inferred = inferSendTargetLabel(sendTo, message)
                  if (inferred != null) setSendTargetLabel(inferred)
                }
                albumAggregator.add(message)
              },
            })

            if (!persist || result === 'stopped') {
              setStatus('stopped')
              break
            }
            if (result === 'disconnected') {
              if (!persist) {
                setStatus('stopped')
                break
              }
              setStatus(`disconnected, retry in ${retrySeconds}s...`)
              retry = true
            }
          } catch (error) {
            if (!persist) {
              setStatus(`listen failed: ${messageFromError(error)}`)
              break
            }
            setNote(`listen failed: ${messageFromError(error)}`)
            retry = true
          } finally {
            albumAggregator.flush()
            await client.close().catch(() => undefined)
            if (clientRef.current === client) clientRef.current = null
          }
          if (retry) {
            await sleep(retrySeconds)
            continue
          }
          break
        }
      } finally {
        if (!stopSignal.aborted) {
          onRequestStop()
          exit()
        }
      }
    }

    void run()

    return () => {
      stopSignal.removeEventListener('abort', stopFromSignal)
      albumAggregator.dispose()
      if (albumAggregatorRef.current === albumAggregator) albumAggregatorRef.current = null
      void clientRef.current?.close().catch(() => undefined)
      clientRef.current = null
    }
  }, [chats, createClient, persist, retrySeconds, sendTo, showMedia, exit, stopSignal, onRequestStop])

  const sendMessage = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (sendTo == null) {
      setNote('set --send-to before sending')
      return
    }

    const client = clientRef.current
    if (!client) {
      setNote('connection is not ready')
      return
    }

    setInput('')
    setSending(true)
    setNote('sending...')
    try {
      await client.sendMessage({
        chat: sendTo,
        message: trimmed,
        linkPreview: true,
      })
      setNote('sent')
    } catch (error) {
      setNote(`send failed: ${messageFromError(error)}`)
    } finally {
      setSending(false)
    }
  }

  const downloadAttachment = async (item: DownloadableAttachment): Promise<void> => {
    const client = clientRef.current
    if (!client) {
      setDownloadStates((current) => ({ ...current, [item.key]: { status: 'failed', error: 'not connected' } }))
      return
    }
    const destination = resolveAttachmentDestination({
      homeDir: homedir(),
      fileName: attachmentFileName(item),
      exists: existsSync,
    })
    mkdirSync(dirname(destination), { recursive: true })
    setDownloadStates((current) => ({ ...current, [item.key]: { status: 'downloading', progress: 0 } }))
    try {
      await client.downloadMessageMedia({
        ...attachmentDownloadTarget(item.attachment),
        destination,
        onProgress: (downloaded, total) => {
          const progress = Number.isFinite(total) && total > 0 ? Math.round(downloaded / total * 100) : null
          setDownloadStates((current) => ({ ...current, [item.key]: { status: 'downloading', progress } }))
        },
      })
      setDownloadStates((current) => ({ ...current, [item.key]: { status: 'completed', path: destination } }))
    } catch (error) {
      setDownloadStates((current) => ({ ...current, [item.key]: { status: 'failed', error: messageFromError(error) } }))
    }
  }

  const stopListening = (): void => {
    if (stoppingRef.current) return
    stoppingRef.current = true
    setStatus('stopping...')
    const albumAggregator = albumAggregatorRef.current
    if (albumAggregator != null) flushListenBeforeExit(albumAggregator, exit)
    else setTimeout(exit, 0)
    onRequestStop()
    clientRef.current?.close().catch(() => undefined)
  }

  return (
    <Box flexDirection="row" width={terminalWidth} height={terminalHeight} overflow="hidden">
      <Box flexDirection="column" width={contentWidth} height={terminalHeight} overflow="hidden">
        <ListenStatus status={status} unseenCount={scrollState.unseenCount} />
        {note ? <Text dimColor>{note}</Text> : null}
        <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
          {messages.length === 0 ? <Text dimColor>Waiting for new messages...</Text> : null}
          {visibleMessages.map((message) => (
            <Box key={message.key} flexDirection="column">
              <Text dimColor wrap="truncate-end">[{message.time}] {message.sender}</Text>
              {message.content == null ? null : <Text wrap="truncate-end">{message.content}</Text>}
              {message.media.map((item, mediaIndex) => {
                const attachmentKey = `${message.key}:${mediaIndex}`
                return (
                  <ListenAttachmentWithPreview
                    key={attachmentKey}
                    label={item.label}
                    selected={focus === 'attachments' && selectedAttachment?.key === attachmentKey}
                    state={downloadStates[attachmentKey] ?? { status: 'idle' }}
                    previewCells={item.previewCells}
                  />
                )
              })}
              <Text dimColor>{MESSAGE_SEPARATOR}</Text>
            </Box>
          ))}
        </Box>
        {sendTo == null ? (
          <Text dimColor>Set --send-to &lt;chat&gt; (or pass one chat to listen) before sending messages.</Text>
        ) : (
          <Box marginTop={1} flexDirection="column" flexShrink={0}>
            <ListenComposer
              input={input}
              sendTargetLabel={sendTargetLabel}
              terminalWidth={contentWidth}
              sending={sending}
              hint={focus === 'attachments' ? '↑/↓ select · Enter download · Tab input' : 'Enter to send · Tab attachments · Ctrl+C exit'}
            />
          </Box>
        )}
      </Box>
      <ListenScrollbar height={terminalHeight} visible={scrollbarVisible} geometry={scrollbarGeometry} />
    </Box>
  )
}

export type ListenMessageRenderContext = {
  showMedia: boolean
  previewWidth: number
  colorDepth: number
  decodePreview?: typeof decodeImagePreview
}

type ListenMessageCacheEntry = {
  group: StoredMessageInput[]
  showMedia: boolean
  previewWidth: number
  colorDepth: number
  decodePreview: typeof decodeImagePreview | undefined
  message: ListenMessage
}

export class ListenMessageViewCache {
  private entries = new Map<string, ListenMessageCacheEntry>()

  get size(): number {
    return this.entries.size
  }

  build(groups: StoredMessageInput[][], context: ListenMessageRenderContext): ListenMessage[] {
    const previewWidth = normalizedPreviewWidth(context.previewWidth)
    const nextEntries = new Map<string, ListenMessageCacheEntry>()
    const messages = groups.map((group) => {
      const first = group[0]
      if (first == null) throw new Error('Cannot render an empty listen message group')
      const key = `${first.chat_id}:${first.msg_id}`
      const cached = this.entries.get(key)
      if (
        cached?.group === group
        && cached.showMedia === context.showMedia
        && cached.previewWidth === previewWidth
        && cached.colorDepth === context.colorDepth
        && cached.decodePreview === context.decodePreview
      ) {
        nextEntries.set(key, cached)
        return cached.message
      }
      const message = toListenMessage(group, { ...context, previewWidth })
      nextEntries.set(key, {
        group,
        showMedia: context.showMedia,
        previewWidth,
        colorDepth: context.colorDepth,
        decodePreview: context.decodePreview,
        message,
      })
      return message
    })
    this.entries = nextEntries
    return messages
  }
}

export function pruneListenMessageGroups(
  groups: StoredMessageInput[][],
  limit = LISTEN_HISTORY_LIMIT,
): { groups: StoredMessageInput[][]; removedKeys: string[] } {
  const retainedLimit = Math.max(0, limit)
  const removeCount = Math.max(0, groups.length - retainedLimit)
  const removed = groups.slice(0, removeCount)
  return {
    groups: groups.slice(removeCount),
    removedKeys: removed.flatMap((group) => {
      const first = group[0]
      return first == null ? [] : [`${first.chat_id}:${first.msg_id}`]
    }),
  }
}

export function toListenMessage(
  messages: StoredMessageInput[],
  context: boolean | ListenMessageRenderContext,
): ListenMessage {
  const message = messages[0]
  if (message == null) throw new Error('Cannot render an empty listen message group')
  const renderContext = typeof context === 'boolean'
    ? { showMedia: context, previewWidth: 1, colorDepth: 1 }
    : context
  const { showMedia, previewWidth, colorDepth } = renderContext
  const formatted = buildListenMessage(messages, { showMedia })
  const decodePreview = renderContext.decodePreview ?? decodeImagePreview
  const media = formatted.media.map((attachment) => {
    if (attachment.previewJpegBase64 == null || colorDepth < 24) return attachment
    const preview = decodePreview(attachment.previewJpegBase64, normalizedPreviewWidth(previewWidth))
    return preview == null
      ? attachment
      : { ...attachment, previewRows: preview.rows.length, previewCells: preview.rows }
  })
  return {
    key: `${message.chat_id}:${message.msg_id}`,
    chatId: message.chat_id,
    msgId: message.msg_id,
    ...formatted,
    media,
  }
}

function normalizedPreviewWidth(previewWidth: number): number {
  return Math.max(1, Math.min(24, previewWidth))
}

function collectAttachments(messages: ListenMessage[]): DownloadableAttachment[] {
  return messages.flatMap((message) => message.media.map((attachment, index) => ({
    key: `${message.key}:${index}`,
    message,
    attachment,
  })))
}

function attachmentFileName(item: DownloadableAttachment): string {
  if (item.attachment.fileName != null) return item.attachment.fileName
  const extension = MEDIA_EXTENSIONS[item.attachment.kind] ?? 'bin'
  return `${item.attachment.chatId}-${item.attachment.messageId}.${extension}`
}

export function attachmentDownloadTarget(attachment: ListenAttachment): { chat: number; msgId: number } {
  return { chat: attachment.chatId, msgId: attachment.messageId }
}

export function flushListenBeforeExit(aggregator: Pick<ListenAlbumAggregator, 'flush'>, exit: () => void): void {
  aggregator.flush()
  setTimeout(exit, 0)
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  Photo: 'jpg',
  Video: 'mp4',
  Audio: 'mp3',
  Voice: 'ogg',
  Sticker: 'webp',
  Animation: 'mp4',
  Document: 'bin',
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildSendTargetLabel(value: string | number): string {
  const normalized = String(value).trim()
  if (isNumericLike(normalized)) {
    return `unknown|${normalized}`
  }
  return `${normalized}|unknown`
}

async function resolveSendTargetLabel(
  client: TelegramClientAdapter,
  sendTo: string | number,
): Promise<string | null> {
  try {
    const info = await client.getChatInfo(sendTo)
    if (info == null) return null
    const fallback = buildSendTargetLabel(sendTo)
    const name = typeof info.Name === 'string' && info.Name.trim() !== '' ? info.Name : undefined
    const id = typeof info.ID === 'string' && info.ID.trim() !== '' ? info.ID : undefined
    if (name == null && id == null) return fallback
    const fallbackParts = fallback.split('|')
    const resolvedName = name == null ? fallbackParts[0] : name
    const resolvedId = id == null ? fallbackParts[1] ?? 'unknown' : id
    return `${resolvedName}|${resolvedId}`
  } catch {
    return null
  }
}

function inferSendTargetLabel(sendTo: string | number, message: StoredMessageInput): string | null {
  const numericSendTo = isNumericValue(sendTo) ? Number(sendTo) : null
  if (numericSendTo != null && message.chat_id === numericSendTo) {
    const name = message.chat_name == null ? 'Unknown' : message.chat_name
    return `${name}|${numericSendTo}`
  }
  const nameMatch = typeof sendTo === 'string' && message.chat_name?.toLowerCase() === String(sendTo).toLowerCase()
  if (nameMatch) return `${message.chat_name ?? 'Unknown'}|${message.chat_id}`
  return null
}

function isNumericLike(value: string): boolean {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) === false && String(parsed) === value
}

function isNumericValue(value: string | number): boolean {
  return typeof value === 'number' || isNumericLike(String(value))
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}
