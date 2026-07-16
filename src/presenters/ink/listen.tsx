import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import stringWidth from 'string-width'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import type { TelegramClientAdapter } from '../../telegram/types.js'
import type { StoredMessageInput } from '../../storage/message-db.js'
import {
  attachmentDownloadProgress,
  resolveAttachmentDestination,
} from '../../services/attachment-download.js'
import { ListenAlbumAggregator } from '../../services/listen-album-aggregator.js'
import { AutoDownloadCoordinator, type AutoDownloadEvent } from '../../services/auto-download-coordinator.js'
import { buildListenMessage, type ListenAttachment, type ListenMessageRow } from '../listen-message.js'
import { attachmentDownloadTarget, attachmentFileName, presentMessageAttachments } from '../attachment.js'
import { applyMessageArrival, applyScroll, takeListenViewport, type ListenScrollState } from './listen-scroll.js'
import { decodeImagePreview, type PreviewCell } from './image-preview.js'
import { ListenScrollbar, calculateScrollbar, listenContentWidth, useTransientScrollbar } from './listen-scrollbar.js'
import {
  DISABLE_MOUSE_REPORTING,
  ENABLE_MOUSE_REPORTING,
  isMouseInput,
  useMouseScroll,
  withAlternateScroll,
  type MouseScrollDirection,
} from './mouse-scroll.js'
import { createListenReplyResolver, type ListenReplyResolver } from '../../services/listen-reply-resolver.js'
import { formatReplyContext, type ReplyContext } from '../../services/reply-context.js'
import { executeListenReply, parseListenComposerInput } from '../../services/listen-composer-command.js'
import { ListenCommandMenu, listenCommandMenuAvailability, moveListenCommandSelectionEnabled } from './listen-command-menu.js'
import { completeListenCommand, visibleListenCommandMatches } from '../../listen-commands/match.js'
import { parseSelectedListenCommand } from '../../listen-commands/dispatch.js'
import { GroupCommandResult } from './group-command-result.js'
import { useGroupCommand } from './use-group-command.js'
import { executeGroupCommand } from '../../group-commands/executor.js'
import { GroupWriteService } from '../../services/group-write-service.js'
import { ADMIN_RIGHT_KEYS } from '../../services/group-write-service.js'
import { WriteAccessPolicy } from '../../services/write-access-policy.js'
import { GroupCommandConfirm } from './group-command-confirm.js'
import { truncateCell } from './display-width.js'
import { SecureInput } from './secure-input.js'
import { SyncService } from '../../services/sync-service.js'
import { MessageDB } from '../../storage/message-db.js'
import type { HandlerResult } from '../../commands/types.js'

export type ListenMessage = ListenMessageRow & {
  key: string
  msgId: number
  showMedia: boolean
}

export type AttachmentDownloadState =
  | { status: 'idle' }
  | { status: 'queued' }
  | { status: 'downloading'; progress: number | null }
  | { status: 'completed'; path: string }
  | { status: 'failed'; error: string }

export type DownloadableAttachment = {
  key: string
  message: ListenMessage
  attachment: ListenAttachment
}

export type ListenRuntimeOptions = {
  dbPath: string
  chats: Array<string | number> | undefined
  persist: boolean
  retrySeconds: number
  sendTo: string | number | undefined
  showMedia: boolean
  autoDownload: boolean
  showChatName: boolean
  createClient: () => TelegramClientAdapter
  stopSignal: AbortSignal
  shutdownRequests?: { subscribe: (listener: () => void) => () => void }
  onRequestStop: () => void
  persistMessage?: (message: StoredMessageInput) => void
  createReplyResolver?: (dbPath: string, limit: number) => ListenReplyResolver
}

const MESSAGE_SEPARATOR = '────────────────────────────────────────────'
const LISTEN_MESSAGE_COLORS = {
  metadata: '#8ecbff',
  reply: '#f0d38a',
  content: '#f2f4f8',
  media: '#9bdca8',
  separator: '#56606b',
} as const
const OWNERSHIP_SHUTDOWN_GRACE_MS = 250
/** Maximum number of grouped messages retained by a long-running interactive listener. */
export const LISTEN_HISTORY_LIMIT = 500
const LISTEN_IMAGE_PREVIEWS_ENABLED = false

export function interactiveListenPreviewColorDepth(terminalColorDepth: number): number {
  return LISTEN_IMAGE_PREVIEWS_ENABLED ? terminalColorDepth : 1
}

export type TerminalMetrics = {
  columns: number
  rows: number
  colorDepth: number
}

type ResizableStdout = {
  columns?: number
  rows?: number
  getColorDepth?: () => number
  on: (event: 'resize', listener: () => void) => unknown
  off: (event: 'resize', listener: () => void) => unknown
}

export function useTerminalMetrics(stdout: ResizableStdout | undefined): TerminalMetrics {
  const readMetrics = useCallback((): TerminalMetrics => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
    colorDepth: stdout?.getColorDepth?.() ?? 1,
  }), [stdout])
  const [metrics, setMetrics] = useState<TerminalMetrics>(readMetrics)

  useEffect(() => {
    setMetrics(readMetrics())
    if (stdout == null) return
    const handleResize = () => setMetrics(readMetrics())
    stdout.on('resize', handleResize)
    return () => {
      stdout.off('resize', handleResize)
    }
  }, [stdout, readMetrics])

  return metrics
}
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
  activity?: 'sending' | 'syncing'
  hint?: string
  cursorVisible?: boolean
}

export function listenComposerCursorColor(visible: boolean): string {
  return visible ? LISTEN_COMPOSER_THEME.cursor : LISTEN_COMPOSER_THEME.background
}

export function ListenComposer({
  input,
  sendTargetLabel,
  terminalWidth,
  sending = false,
  activity,
  hint = 'Enter to send · Ctrl+C to exit',
  cursorVisible = true,
}: ListenComposerProps): React.JSX.Element {
  const activeLabel = activity ?? (sending ? 'sending' : undefined)
  const inputText = `› ${input}${activeLabel == null ? '' : ` (${activeLabel}...)`}`
  const blankRow = ' '.repeat(Math.max(0, terminalWidth))
  const inputRowFill = ' '.repeat(Math.max(0, terminalWidth - stringWidth(inputText) - 1))

  return (
    <Box flexDirection="column">
      <Text backgroundColor={LISTEN_COMPOSER_THEME.background}>{blankRow}</Text>
      <Text backgroundColor={LISTEN_COMPOSER_THEME.background} color={LISTEN_COMPOSER_THEME.foreground}>
        {inputText}<Text backgroundColor={listenComposerCursorColor(cursorVisible)}> </Text>{inputRowFill}
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
    : state.status === 'queued'
      ? 'Queued'
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

export function applyAutoDownloadEvent(
  current: Record<string, AttachmentDownloadState>,
  event: AutoDownloadEvent,
  showMedia = true,
): Record<string, AttachmentDownloadState> {
  if (!showMedia) return Object.keys(current).length === 0 ? current : {}
  if (event.status === 'cancelled') {
    if (!(event.key in current)) return current
    const next = { ...current }
    delete next[event.key]
    return next
  }
  const state: AttachmentDownloadState = event.status === 'queued'
    ? { status: 'queued' }
    : event.status === 'downloading'
      ? { status: 'downloading', progress: event.progress }
      : event.status === 'completed'
        ? { status: 'completed', path: event.path }
        : { status: 'failed', error: event.error }
  return { ...current, [event.key]: state }
}

export function canManuallyDownload(state: AttachmentDownloadState): boolean {
  return state.status === 'idle' || state.status === 'failed'
}

export type InteractiveOperationController = ReturnType<typeof createInteractiveOperationController>

export function createInteractiveOperationController() {
  let generation = 0
  let sequence = 0
  let sendOperation = 0
  const downloadOperations = new Map<string, number>()
  return {
    beginGeneration() {
      const ownedGeneration = ++generation
      let active = true
      return {
        isActive: () => active && generation === ownedGeneration,
        dispose: () => {
          active = false
          if (generation === ownedGeneration) {
            generation += 1
            downloadOperations.clear()
          }
        },
      }
    },
    beginSend() {
      const ownedGeneration = generation
      const operation = ++sendOperation
      return () => generation === ownedGeneration && sendOperation === operation
    },
    beginDownload(key: string) {
      const ownedGeneration = generation
      const operation = ++sequence
      downloadOperations.set(key, operation)
      return {
        isCurrent: () => generation === ownedGeneration && downloadOperations.get(key) === operation,
        release: () => {
          if (downloadOperations.get(key) === operation) downloadOperations.delete(key)
        },
      }
    },
    claimDownload(key: string) {
      const operation = ++sequence
      downloadOperations.set(key, operation)
      return {
        release: () => {
          if (downloadOperations.get(key) === operation) downloadOperations.delete(key)
        },
      }
    },
    downloadOwnershipSize: () => downloadOperations.size,
  }
}

type DownloadOwnership = {
  isCurrent: () => boolean
  release: () => void
}

export async function runOwnedAttachmentOperation(
  ownership: DownloadOwnership,
  operation: () => void | Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (ownership.isCurrent()) onError(error)
  } finally {
    ownership.release()
  }
}

export function pruneAttachmentDownloadStates(
  current: Record<string, AttachmentDownloadState>,
  validKeys: ReadonlySet<string>,
  pendingKeys: ReadonlySet<string> = new Set(),
): Record<string, AttachmentDownloadState> {
  const retained = Object.fromEntries(Object.entries(current).filter(([key, state]) => (
    validKeys.has(key) || pendingKeys.has(key) || state.status === 'queued' || state.status === 'downloading'
  )))
  return Object.keys(retained).length === Object.keys(current).length ? current : retained
}

export function registerPendingAttachmentKeys(
  pendingKeys: Set<string>,
  message: StoredMessageInput,
  showMedia: boolean,
): void {
  if (!showMedia) {
    pendingKeys.clear()
    return
  }
  presentMessageAttachments(message).forEach((attachment) => {
    if (attachment.downloadable) pendingKeys.add(attachment.key)
  })
}

export function acceptListenMessage(
  message: StoredMessageInput,
  seen: Set<string>,
  seenOrder: string[],
  emit: (message: StoredMessageInput) => void,
): boolean {
  const key = `${message.chat_id}:${message.msg_id}`
  if (seen.has(key)) return false
  seen.add(key)
  seenOrder.push(key)
  if (seen.size > 5000) {
    const oldest = seenOrder.shift()
    if (oldest != null) seen.delete(oldest)
  }
  emit(message)
  return true
}

type InteractiveCoordinator = Pick<AutoDownloadCoordinator, 'setClient' | 'enqueue' | 'waitForActive' | 'waitForIdle' | 'stop'>

export async function runInteractiveAutoDownloadLifecycle(options: {
  autoDownload: boolean
  chats: Array<string | number> | undefined
  persist: boolean
  retrySeconds: number
  signal: AbortSignal
  createClient: () => TelegramClientAdapter
  createCoordinator?: () => InteractiveCoordinator
  persistMessage?: (message: StoredMessageInput) => void
  acceptMessage?: (message: StoredMessageInput) => boolean
  onBeforeEnqueue?: (message: StoredMessageInput) => void
  onMessage: (message: StoredMessageInput) => void
  onClient?: (client: TelegramClientAdapter | null) => void
  onCoordinator?: (coordinator: InteractiveCoordinator | null) => void
  onStatus?: (status: 'connecting' | 'connected' | 'stopped' | 'disconnected') => void
  onError?: (error: unknown) => void
  flush?: () => void
  sleep?: (seconds: number) => Promise<void>
}): Promise<void> {
  const coordinator = options.autoDownload
    ? (options.createCoordinator ?? (() => new AutoDownloadCoordinator()))()
    : null
  options.onCoordinator?.(coordinator)
  let currentClient: TelegramClientAdapter | null = null
  let closeCurrentClient: (() => Promise<void>) | null = null
  const abort = () => {
    coordinator?.stop()
    void closeCurrentClient?.()
  }
  options.signal.addEventListener('abort', abort)
  try {
    while (!options.signal.aborted) {
      options.onStatus?.('connecting')
      const client = options.createClient()
      let closePromise: Promise<void> | undefined
      const closeClient = (): Promise<void> => {
        closePromise ??= Promise.resolve().then(() => client.close()).catch(() => undefined)
        return closePromise
      }
      currentClient = client
      closeCurrentClient = closeClient
      options.onClient?.(client)
      coordinator?.setClient(client)
      let retry = false
      try {
        const result = await client.listen({
          chats: options.chats,
          signal: options.signal,
          onConnected: () => options.onStatus?.('connected'),
          onMessage: (message) => {
            if (options.signal.aborted) return
            try {
              options.persistMessage?.(message)
            } catch (error) {
              throw new InteractivePersistMessageError(error)
            }
            if (options.acceptMessage?.(message) === false) return
            options.onBeforeEnqueue?.(message)
            coordinator?.enqueue(message)
            options.onMessage(message)
          },
        })
        if (options.persist && result === 'disconnected') {
          retry = true
          options.onStatus?.('disconnected')
        } else {
          options.onStatus?.('stopped')
        }
      } catch (error) {
        const reportedError = error instanceof InteractivePersistMessageError ? error.cause : error
        if (options.persist && !options.signal.aborted && !(error instanceof InteractivePersistMessageError)) retry = true
        options.onError?.(reportedError)
      } finally {
        options.flush?.()
        if (retry) {
          coordinator?.setClient(null)
          await coordinator?.waitForActive()
        } else if (!options.signal.aborted) {
          await coordinator?.waitForIdle()
        } else {
          coordinator?.stop()
        }
        await closeClient()
        if (options.signal.aborted) await coordinator?.waitForActive()
        if (currentClient === client) currentClient = null
        if (closeCurrentClient === closeClient) closeCurrentClient = null
        options.onClient?.(null)
      }
      if (!retry) break
      await (options.sleep ?? sleep)(options.retrySeconds)
    }
  } finally {
    options.signal.removeEventListener('abort', abort)
    options.onCoordinator?.(null)
  }
}

class InteractivePersistMessageError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'InteractivePersistMessageError'
  }
}

export function attachmentDownloadKeyAt(attachments: ListenAttachment[], index: number): string {
  const attachment = attachments[index]
  if (attachment == null) throw new Error(`Missing attachment at index ${index}`)
  return attachment.key
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
  downloadable?: boolean
  previewCells?: PreviewCell[][]
}

export function ListenAttachmentWithPreview({
  label,
  downloadable = true,
  selected,
  state,
  previewCells,
}: ListenAttachmentWithPreviewProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {downloadable
        ? <ListenAttachmentLine label={label} selected={selected} state={state} />
        : <Text wrap="truncate-end">  {label}</Text>}
      {previewCells == null ? null : <ListenImagePreview rows={previewCells} />}
    </Box>
  )
}

export function ListenMessageHeader({ message }: { message: ListenMessage }): React.JSX.Element {
  return (
    <Text color={LISTEN_MESSAGE_COLORS.metadata} dimColor={false} wrap="truncate-end">
      {formatInteractiveListenHeader(message)}
    </Text>
  )
}

export function ListenMessageSeparator(): React.JSX.Element {
  return <Text color={LISTEN_MESSAGE_COLORS.separator}>{MESSAGE_SEPARATOR}</Text>
}

export function ListenMessageBody({
  message,
  selectedAttachmentKey = null,
  attachmentStates = {},
}: {
  message: ListenMessage
  selectedAttachmentKey?: string | null
  attachmentStates?: Record<string, AttachmentDownloadState>
}): React.JSX.Element {
  const showAttachmentRows = message.showMedia
  return (
    <>
      {message.replyContext == null ? null : <Text color={LISTEN_MESSAGE_COLORS.reply} wrap="truncate-end">{formatReplyContext(message.replyContext)}</Text>}
      {message.content == null ? null : <Text color={LISTEN_MESSAGE_COLORS.content} wrap="truncate-end">{message.content}</Text>}
      {message.attachmentSummary == null ? null : <Text color={LISTEN_MESSAGE_COLORS.media} wrap="truncate-end">{message.attachmentSummary}</Text>}
      {showAttachmentRows ? message.attachments.map((item, mediaIndex) => {
        const attachmentKey = attachmentDownloadKeyAt(message.attachments, mediaIndex)
        const indent = '  '.repeat(item.depth)
        return (
          <ListenAttachmentWithPreview
            key={attachmentKey}
            label={`${indent}${item.label}`}
            downloadable={item.downloadable}
            selected={selectedAttachmentKey === attachmentKey}
            state={attachmentStates[attachmentKey] ?? { status: 'idle' }}
            previewCells={item.previewCells}
          />
        )
      }) : null}
    </>
  )
}

export type ResolvedListenGroup = {
  key: string
  messages: StoredMessageInput[]
  replyContext?: ReplyContext
}

type InteractiveReplyResolver = Pick<ListenReplyResolver, 'resolve' | 'remember' | 'close'>
  & Partial<Pick<ListenReplyResolver, 'resolveAsync' | 'closeAsync'>>

export function createInteractiveListenGroupQueue(options: {
  resolver: InteractiveReplyResolver
  schedule?: (run: () => void) => void
  isActive: () => boolean
  onGroup: (group: ResolvedListenGroup) => void
  onError: (error: unknown) => void
}) {
  const pending: StoredMessageInput[][] = []
  const schedule = options.schedule ?? ((run) => setImmediate(run))
  let scheduled: Promise<void> | null = null
  let resolveScheduled: (() => void) | null = null
  let closing = false
  let closed = false
  let closePromise: Promise<void> | null = null

  const closeResolver = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (options.resolver.closeAsync != null) await options.resolver.closeAsync()
    else options.resolver.close()
  }
  const drain = async (): Promise<void> => {
    try {
      while (pending.length > 0) {
        const messages = pending.shift()!
        try {
          const replyContext = options.resolver.resolveAsync == null
            ? options.resolver.resolve(messages)
            : await options.resolver.resolveAsync(messages)
          options.resolver.remember(messages)
          const first = messages[0]
          if (first != null && options.isActive()) {
            options.onGroup({ key: `${first.chat_id}:${first.msg_id}`, messages, replyContext })
          }
        } catch (error) {
          options.onError(error)
          pending.length = 0
          break
        }
      }
    } finally {
      resolveScheduled?.()
      resolveScheduled = null
      scheduled = null
    }
  }
  return {
    enqueue(messages: StoredMessageInput[]): void {
      if (closing) return
      pending.push(messages)
      if (scheduled != null) return
      scheduled = new Promise<void>((resolve) => { resolveScheduled = resolve })
      schedule(() => { void drain() })
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true
        const drainCompletion = scheduled
        if (drainCompletion != null) await drainCompletion
        await closeResolver()
      })()
      return closePromise
    },
  }
}

export function createInteractiveListenRuntime(
  dbPath: string,
  factory: (dbPath: string, limit: number) => InteractiveReplyResolver,
  options: Omit<Parameters<typeof createInteractiveListenGroupQueue>[0], 'resolver'>,
) {
  return createInteractiveListenGroupQueue({
    ...options,
    resolver: factory(dbPath, LISTEN_HISTORY_LIMIT),
  })
}

export function ListenStatus({ status, unseenCount }: { status: string; unseenCount: number }): React.JSX.Element {
  return <Text dimColor>{status}{unseenCount > 0 ? ` · ↓ ${unseenCount} new messages` : ''}</Text>
}

export function formatInteractiveListenSender(
  message: Pick<ListenMessageRow, 'sender' | 'senderId' | 'chatName' | 'chatId'>,
): string {
  const sender = message.senderId == null || message.sender === String(message.senderId)
    ? message.sender
    : `${message.sender} (${message.senderId})`
  return message.chatName == null ? sender : `${message.chatName} (${message.chatId}) | ${sender}`
}

export function formatInteractiveListenHeader(
  message: Pick<ListenMessage, 'time' | 'msgId' | 'sender' | 'senderId' | 'chatName' | 'chatId'>,
): string {
  return `[${message.time}] #${message.msgId} ${formatInteractiveListenSender(message)}`
}

export function ListenStatusArea({
  status,
  unseenCount,
  autoDownload,
}: {
  status: string
  unseenCount: number
  autoDownload: boolean
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <ListenStatus status={status} unseenCount={unseenCount} />
      {autoDownload ? <Text dimColor>Auto-download enabled</Text> : null}
    </Box>
  )
}

export function calculateListenMessagePaneHeight(
  terminalHeight: number,
  hasNote: boolean,
  autoDownload: boolean,
): number {
  const reservedLines = 7 + (hasNote ? 1 : 0) + (autoDownload ? 1 : 0)
  return Math.max(2, terminalHeight - reservedLines)
}

export async function runInteractiveListen<T>(
  write: (value: string) => unknown,
  run: () => Promise<T>,
): Promise<T> {
  return withAlternateScroll({ write, run })
}

export async function renderInteractiveListen(options: ListenRuntimeOptions): Promise<void> {
  await runInteractiveListen(process.stdout.write.bind(process.stdout), async () => {
    const app = render(<InteractiveListen {...options} />, { exitOnCtrlC: false })
    await app.waitUntilExit()
  })
}

export function InteractiveListen({
  dbPath,
  chats,
  persist,
  retrySeconds,
  sendTo,
  showMedia,
  autoDownload,
  showChatName,
  createClient,
  stopSignal,
  onRequestStop,
  persistMessage,
  createReplyResolver,
  shutdownRequests,
}: ListenRuntimeOptions): React.JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminalMetrics = useTerminalMetrics(stdout)
  const [status, setStatus] = useState('connecting...')
  const [messageGroups, setMessageGroups] = useState<ResolvedListenGroup[]>([])
  const [input, setInput] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [composerActivity, setComposerActivity] = useState<'sending' | 'syncing' | undefined>(undefined)
  const [focus, setFocus] = useState<'input' | 'attachments'>('input')
  const [selectedAttachmentKey, setSelectedAttachmentKey] = useState<string | null>(null)
  const [downloadStates, setDownloadStates] = useState<Record<string, AttachmentDownloadState>>({})
  const [scrollState, setScrollState] = useState<ListenScrollState>({ offset: 0, unseenCount: 0 })
  const [sendTargetLabel, setSendTargetLabel] = useState(sendTo == null ? '' : buildSendTargetLabel(sendTo))
  const [knownGroup, setKnownGroup] = useState<Awaited<ReturnType<TelegramClientAdapter['groups']['getGroup']>> | undefined>(undefined)
  const clientRef = useRef<TelegramClientAdapter | null>(null)
  const replyExecutionLockRef = useRef(false)
  const inputGenerationRef = useRef<object>({})
  const commandSelectionRef = useRef(0)
  const knownGroupRef = useRef<Awaited<ReturnType<TelegramClientAdapter['groups']['getGroup']>> | undefined>(undefined)
  const groupLookupGenerationRef = useRef<object>({})
  const selectedAttachmentKeyRef = useRef<string | null>(null)
  const scrollOffsetRef = useRef(0)
  selectedAttachmentKeyRef.current = selectedAttachmentKey
  scrollOffsetRef.current = scrollState.offset
  useEffect(() => {
    groupLookupGenerationRef.current = {}
    knownGroupRef.current = undefined
    setKnownGroup(undefined)
  }, [sendTo])
  const groupCommand = useGroupCommand(useCallback(async (request, options) => {
    const client = clientRef.current
    if (client == null) return { ok: false, error: { code: 'connection_not_ready', message: 'Telegram connection is not ready.' } }
    if (sendTo == null) return { ok: false, error: { code: 'ambiguous_chat', message: 'Select exactly one target chat with --send-to.' } }
    let knownGroup = knownGroupRef.current
    const refreshOwnershipCapability = request.key === 'admin transfer-owner'
      && options?.confirmed === true
      && options.ownershipPassword == null
    if (knownGroup == null || refreshOwnershipCapability) {
      const lookup = {}
      groupLookupGenerationRef.current = lookup
      knownGroup = await client.groups.getGroup(sendTo)
      if (lookup !== groupLookupGenerationRef.current || clientRef.current !== client) {
        return { ok: false, error: { code: 'connection_not_ready', message: 'Telegram connection changed during group verification.' } }
      }
      knownGroupRef.current = knownGroup
      setKnownGroup(knownGroup)
    }
    return executeGroupCommand(request, {
      chat: sendTo,
      groups: new GroupWriteService(client.groups),
      confirmed: options?.confirmed ?? false,
      confirmationTitle: options?.confirmationTitle,
      ownershipPassword: options?.ownershipPassword,
      knownGroup,
      connectionReady: true,
      targetAvailable: true,
      targetCount: 1,
      invalidateGroup: async () => {
        knownGroupRef.current = undefined
        setKnownGroup(undefined)
        if (request.key === 'chat delete' || request.key === 'chat leave') return
        const lookup = {}
        groupLookupGenerationRef.current = lookup
        try {
          const refreshed = await client.groups.getGroup(sendTo)
          if (lookup === groupLookupGenerationRef.current && clientRef.current === client) {
            knownGroupRef.current = refreshed
            setKnownGroup(refreshed)
          }
        } catch (error) {
          if (lookup === groupLookupGenerationRef.current && clientRef.current === client) setNote(`Group updated; refresh failed: ${messageFromError(error)}`)
        }
      },
    })
  }, [sendTo]))
  const irreversibleGroupWriteRef = useRef(false)
  irreversibleGroupWriteRef.current = groupCommand.state.kind === 'executing' && groupCommand.state.irreversible === true
  const terminalWidth = terminalMetrics.columns
  const terminalHeight = terminalMetrics.rows
  const previewColorDepth = interactiveListenPreviewColorDepth(terminalMetrics.colorDepth)
  const contentWidth = listenContentWidth(terminalWidth)
  const previewWidth = Math.max(1, Math.min(24, contentWidth - 2))
  const renderContextRef = useRef<ListenMessageRenderContext>({ showMedia, previewWidth, colorDepth: previewColorDepth, showChatName })
  renderContextRef.current = { showMedia, previewWidth, colorDepth: previewColorDepth, showChatName }
  const messageViewCacheRef = useRef<ListenMessageViewCache | null>(null)
  if (messageViewCacheRef.current == null) messageViewCacheRef.current = new ListenMessageViewCache()
  const messages = useMemo(
    () => messageViewCacheRef.current!.build(messageGroups, renderContextRef.current),
    [messageGroups, showMedia, previewWidth, previewColorDepth, showChatName],
  )
  const messagePaneHeight = calculateListenMessagePaneHeight(terminalHeight, note.length > 0, autoDownload)
  const visibleMessages = takeListenViewport(messages, messagePaneHeight, scrollState.offset)
  const closeGroupCommand = () => {
    commandSelectionRef.current = 0
    groupCommand.close()
  }
  const albumAggregatorRef = useRef<ListenAlbumAggregator | null>(null)
  const autoDownloaderRef = useRef<AutoDownloadCoordinator | null>(null)
  const pendingAttachmentKeysRef = useRef<Set<string>>(new Set())
  const operationControllerRef = useRef<InteractiveOperationController | null>(null)
  if (operationControllerRef.current == null) operationControllerRef.current = createInteractiveOperationController()
  const stoppingRef = useRef(false)
  const lifecycleStopRef = useRef<AbortController | null>(null)
  const deferredStopRef = useRef(false)
  const shutdownRequestedRef = useRef(false)
  const shutdownGraceTimerRef = useRef<NodeJS.Timeout | null>(null)

  function requestOwnershipShutdown(source: 'terminal' | 'external'): void {
    if (deferredStopRef.current || shutdownRequestedRef.current) {
      deferredStopRef.current = false
      shutdownRequestedRef.current = false
      if (shutdownGraceTimerRef.current) clearTimeout(shutdownGraceTimerRef.current)
      shutdownGraceTimerRef.current = null
      groupCommand.setState({ kind: 'error', message: 'Ownership transfer outcome is indeterminate after forced shutdown.' })
      setTimeout(stopListening, 0)
      return
    }
    if (source === 'terminal') {
      deferredStopRef.current = true
      setNote('Group write is already running; wait for its outcome.')
      return
    }
    shutdownRequestedRef.current = true
    setNote('Shutdown requested; waiting briefly for the ownership transfer outcome.')
    shutdownGraceTimerRef.current = setTimeout(() => {
      shutdownGraceTimerRef.current = null
      groupCommand.setState({
        kind: 'error',
        message: 'Ownership transfer outcome is indeterminate because shutdown grace expired.',
      })
      setTimeout(stopListening, 0)
    }, OWNERSHIP_SHUTDOWN_GRACE_MS)
  }

  const seenRef = useRef<Set<string>>(new Set())
  const seenOrderRef = useRef<string[]>([])
  const downloadableAttachments = collectDownloadableAttachments(messages)
  const visibleDownloadableAttachments = collectDownloadableAttachments(visibleMessages)
  const selectedAttachment = downloadableAttachments.find((item) => item.key === selectedAttachmentKey)
  const selectAttachment = (key: string | null): void => {
    selectedAttachmentKeyRef.current = key
    setSelectedAttachmentKey(key)
  }
  const { visible: scrollbarVisible, show: showScrollbar } = useTransientScrollbar()
  const scrollbarGeometry = calculateScrollbar({
    height: terminalHeight,
    total: messages.length,
    visible: visibleMessages.length,
    offset: scrollState.offset,
  })
  const lastScrollDirectionRef = useRef<'up' | 'down'>('up')
  const scrollMessages = useCallback((direction: 'up' | 'down', amount = 1) => {
    lastScrollDirectionRef.current = direction
    const step = Math.max(1, Math.floor(amount))
    const maxOffset = Math.max(0, messages.length - 1)
    scrollOffsetRef.current = direction === 'up'
      ? Math.min(maxOffset, scrollOffsetRef.current + step)
      : Math.max(0, scrollOffsetRef.current - step)
    showScrollbar()
    setScrollState((current) => applyScroll(
      current,
      direction,
      maxOffset,
      amount,
    ))
  }, [messages.length, showScrollbar])

  const handleMouseScroll = useCallback((direction: MouseScrollDirection) => {
    if (focus === 'attachments') scrollMessages(direction)
  }, [focus, scrollMessages])
  useMouseScroll(handleMouseScroll)

  useEffect(() => {
    if (focus !== 'attachments') return
    stdout.write(ENABLE_MOUSE_REPORTING)
    return () => {
      stdout.write(DISABLE_MOUSE_REPORTING)
    }
  }, [focus, stdout])

  useEffect(() => {
    const maxOffset = Math.max(0, messages.length - 1)
    setScrollState((current) => {
      const offset = Math.min(current.offset, maxOffset)
      const unseenCount = offset === 0 ? 0 : Math.min(current.unseenCount, messages.length)
      scrollOffsetRef.current = offset
      return offset === current.offset && unseenCount === current.unseenCount
        ? current
        : { offset, unseenCount }
    })

    const validAttachmentKeys = new Set(collectDownloadableAttachments(messages).map((item) => item.key))
    if (!showMedia) pendingAttachmentKeysRef.current.clear()
    setDownloadStates((current) => pruneAttachmentDownloadStates(
      current,
      validAttachmentKeys,
      pendingAttachmentKeysRef.current,
    ))
    for (const key of validAttachmentKeys) pendingAttachmentKeysRef.current.delete(key)
    const currentSelectedKey = selectedAttachmentKeyRef.current
    if (currentSelectedKey != null && !validAttachmentKeys.has(currentSelectedKey)) {
      selectAttachment(downloadableAttachments[0]?.key ?? null)
    }
    if (downloadableAttachments.length === 0) setFocus('input')
  }, [messages, downloadableAttachments.length])

  useEffect(() => {
    if (focus !== 'attachments' || visibleDownloadableAttachments.length === 0) return
    if (visibleDownloadableAttachments.some((item) => item.key === selectedAttachment?.key)) return
    const fallback = lastScrollDirectionRef.current === 'up'
      ? visibleDownloadableAttachments.at(-1)
      : visibleDownloadableAttachments[0]
    const index = fallback == null
      ? -1
      : downloadableAttachments.findIndex((item) => item.key === fallback.key)
    if (index >= 0) selectAttachment(downloadableAttachments[index]!.key)
  }, [focus, messagePaneHeight, messages, scrollState.offset, selectedAttachmentKey])

  useInput((inputText, key) => {
    if (isMouseInput(inputText)) return
    const modal = groupCommand.state
    if (modal.kind === 'executing' && modal.irreversible === true) {
      if (key.ctrl && (inputText === 'c' || inputText === 'C' || inputText === '\u0003')) {
        requestOwnershipShutdown('terminal')
      } else if (key.escape) {
        setNote('Group write is already running; wait for its outcome.')
      }
      return
    }
    if (key.ctrl && (inputText === 'c' || inputText === 'C' || inputText === '\u0003')) {
      stopListening()
      return
    }
    if (modal.kind === 'password') return
    if (modal.kind === 'confirm') {
      if (key.escape) { closeGroupCommand(); return }
      if (key.upArrow || key.downArrow) { groupCommand.setState({ ...modal, selectedIndex: modal.selectedIndex === 0 ? 1 : 0 }); return }
      if (key.return) {
        if (modal.selectedIndex === 0) void groupCommand.runConfirmed(modal.request)
        else closeGroupCommand()
      }
      return
    }
    if (modal.kind === 'confirm-title') {
      if (key.escape) {
        if (modal.stage === 'title') groupCommand.setState({ ...modal, stage: 'confirm', confirmText: '', mismatch: false })
        else closeGroupCommand()
        return
      }
      if (modal.stage === 'confirm') {
        if (key.upArrow || key.downArrow) groupCommand.setState({ ...modal, selectedIndex: modal.selectedIndex === 0 ? 1 : 0 })
        else if (key.return) modal.selectedIndex === 0 ? groupCommand.setState({ ...modal, stage: 'title' }) : closeGroupCommand()
        return
      }
      if (key.return) {
        const client = clientRef.current
        if (client == null || sendTo == null) {
          groupCommand.setState({ kind: 'error', message: 'Telegram connection is not ready.' })
        } else {
          const submittedTitle = modal.confirmText
          const lookup = {}
          groupLookupGenerationRef.current = lookup
          void client.groups.getGroup(sendTo).then((fresh) => {
            if (lookup !== groupLookupGenerationRef.current || clientRef.current !== client) return
            knownGroupRef.current = fresh
            setKnownGroup(fresh)
            if (fresh.title === submittedTitle) void groupCommand.runConfirmed(modal.request, submittedTitle)
            else if ('confirmation' in modal.pending) groupCommand.setState({
              ...modal,
              pending: { ...modal.pending, confirmation: { ...modal.pending.confirmation, title: fresh.title, target: fresh.title } },
              mismatch: true,
            })
          }).catch((error) => {
            if (lookup === groupLookupGenerationRef.current && clientRef.current === client) groupCommand.setState({ kind: 'error', message: messageFromError(error) })
          })
        }
      } else if (key.backspace || key.delete) groupCommand.setState({ ...modal, confirmText: modal.confirmText.slice(0, -1), mismatch: false })
      else if (!key.ctrl && !key.meta && inputText) groupCommand.setState({ ...modal, confirmText: modal.confirmText + inputText, mismatch: false })
      return
    }
    if (modal.kind === 'select-permissions') {
      if (key.escape) { closeGroupCommand(); return }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1
        groupCommand.setState({ ...modal, selectedIndex: (modal.selectedIndex + delta + ADMIN_RIGHT_KEYS.length) % ADMIN_RIGHT_KEYS.length })
      } else if (inputText === ' ') {
        const right = ADMIN_RIGHT_KEYS[modal.selectedIndex]!
        groupCommand.setState({ ...modal, selected: modal.selected.includes(right) ? modal.selected.filter(item => item !== right) : [...modal.selected, right], warning: undefined })
      } else if (key.return) {
        if (modal.selected.length === 0) groupCommand.setState({ ...modal, warning: 'Select at least one permission.' })
        else {
          const request = Object.freeze({ ...modal.request, values: Object.freeze({ ...modal.request.values, permissions: Object.freeze([...modal.selected]) }) }) as typeof modal.request
          void (async () => {
            const result = await groupCommand.submit(`${modal.originalInput} ${modal.selected.join(',')}`, 0)
            if (result.kind === 'pending' && 'confirmation' in result.pending) groupCommand.setState({ kind: 'confirm', pending: result.pending, request, originalInput: modal.originalInput, selectedIndex: 1 })
          })()
        }
      }
      return
    }
    if (groupCommand.state.kind === 'result') {
      if (key.escape) closeGroupCommand()
      return
    }
    if (key.escape && groupCommand.state.kind === 'error') {
      closeGroupCommand()
      return
    }
    if (replyExecutionLockRef.current) {
      if (key.escape) setNote('Reply is still sending; wait for its outcome.')
      return
    }
    if (key.pageUp || key.pageDown) {
      scrollMessages(key.pageUp ? 'up' : 'down', Math.max(1, visibleMessages.length))
      return
    }
    const slashMode = input.trimStart().startsWith('/')
    if (slashMode && key.escape) {
      closeGroupCommand()
      return
    }
    if (slashMode && (key.upArrow || key.downArrow)) {
      const count = visibleListenCommandMatches(input).length
      const disabled = listenCommandMenuAvailability(input, knownGroup).map(Boolean)
      const selectedIndex = moveListenCommandSelectionEnabled(commandSelectionRef.current, key.upArrow ? -1 : 1, disabled.slice(0, count))
      commandSelectionRef.current = selectedIndex
      groupCommand.setState({ kind: 'menu', selectedIndex })
      return
    }
    if (slashMode && key.tab) {
      const selected = commandSelectionRef.current
      const failure = listenCommandMenuAvailability(input, knownGroup)[selected]
      if (failure && 'error' in failure) { setNote(failure.error.message); return }
      inputGenerationRef.current = {}
      setInput(completeListenCommand(input, selected))
      commandSelectionRef.current = 0
      groupCommand.setState({ kind: 'menu', selectedIndex: 0 })
      setFocus('input')
      return
    }
    if (key.tab) {
      if (focus === 'attachments') {
        setFocus('input')
      } else if (visibleDownloadableAttachments.length > 0 || downloadableAttachments.length > 0) {
        const focusableAttachments = visibleDownloadableAttachments.length > 0
          ? visibleDownloadableAttachments
          : downloadableAttachments
        const currentSelectedKey = selectedAttachmentKeyRef.current
        const nextSelection = focusableAttachments.find((item) => item.key === currentSelectedKey)
          ?? focusableAttachments[0]!
        setFocus('attachments')
        selectAttachment(nextSelection.key)
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
        const direction = key.upArrow ? 'up' : 'down'
        const delta = direction === 'up' ? -1 : 1
        const currentIndex = downloadableAttachments.findIndex((item) => item.key === selectedAttachmentKeyRef.current)
        const nextIndex = currentIndex + delta
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= downloadableAttachments.length) return
        const nextAttachment = downloadableAttachments[nextIndex]
        selectAttachment(nextAttachment?.key ?? null)
        const effectiveVisibleMessages = takeListenViewport(messages, messagePaneHeight, scrollOffsetRef.current)
        if (nextAttachment != null && !effectiveVisibleMessages.some((message) => message.key === nextAttachment.message.key)) {
          const messageIndex = messages.findIndex((message) => message.key === nextAttachment.message.key)
          if (messageIndex >= 0) {
            const targetOffset = messages.length - 1 - messageIndex
            scrollOffsetRef.current = targetOffset
            showScrollbar()
            setScrollState((current) => {
              if (current.offset === targetOffset) return current
              return applyScroll(
                current,
                targetOffset > current.offset ? 'up' : 'down',
                Math.max(0, messages.length - 1),
                Math.abs(targetOffset - current.offset),
              )
            })
          }
        }
        return
      }
      const currentSelectedAttachment = downloadableAttachments.find((item) => item.key === selectedAttachmentKeyRef.current)
      if (key.return && currentSelectedAttachment != null) {
        const state = downloadStates[currentSelectedAttachment.key] ?? { status: 'idle' }
        if (canManuallyDownload(state)) void downloadAttachment(currentSelectedAttachment)
      }
      return
    }
    if (key.upArrow || key.downArrow) {
      scrollMessages(key.upArrow ? 'up' : 'down')
      return
    }
    if (sending || groupCommand.state.kind === 'executing') return
    if (key.return) {
      if (slashMode) {
        const selected = commandSelectionRef.current
        const failure = listenCommandMenuAvailability(input, knownGroup)[selected]
        if (failure && 'error' in failure) { setNote(failure.error.message); return }
        const match = visibleListenCommandMatches(input)[selected]
        if (!match) { setNote('No matching command.'); return }
        const parsed = parseSelectedListenCommand(input, match)
        if (parsed.kind === 'complete') {
          inputGenerationRef.current = {}
          setInput(parsed.input)
          commandSelectionRef.current = 0
          groupCommand.setState({ kind: 'menu', selectedIndex: 0 })
          return
        }
        if (parsed.kind === 'error') {
          setNote(parsed.usage == null ? parsed.message : `${parsed.message} · usage: /${parsed.usage}`)
          return
        }
        if (parsed.kind === 'reply') {
          if (replyExecutionLockRef.current) return
          if (sendTo == null) { setNote('set --send-to before replying'); return }
          const client = clientRef.current
          if (client == null) { setNote('connection is not ready'); return }
          const access = new WriteAccessPolicy().check()
          if (!access.ok) {
            setNote(access.error.message)
            return
          }
          replyExecutionLockRef.current = true
          const ownedGeneration = inputGenerationRef.current
          const originalInput = input
          setSending(true)
          setNote('sending...')
          void executeListenReply(client, sendTo, parsed.command).then((sentMessages) => {
            if (ownedGeneration !== inputGenerationRef.current) return
            for (const sentMessage of sentMessages) acceptListenMessage(sentMessage, seenRef.current, seenOrderRef.current, (message) => {
              registerPendingAttachmentKeys(pendingAttachmentKeysRef.current, message, showMedia)
              autoDownloaderRef.current?.enqueue(message)
              albumAggregatorRef.current?.add(message)
            })
            setInput('')
            setNote(`replied to #${parsed.command.reply}`)
          }).catch((error) => {
            if (ownedGeneration === inputGenerationRef.current) {
              setInput(originalInput)
              setNote(`send failed: ${messageFromError(error)}`)
            }
          }).finally(() => {
            replyExecutionLockRef.current = false
            if (ownedGeneration === inputGenerationRef.current) setSending(false)
          })
          return
        }
        if (parsed.kind === 'sync') {
          if (sendTo == null) { setNote('set --send-to before syncing'); return }
          const client = clientRef.current
          if (client == null) { setNote('connection is not ready'); return }
          const ownedGeneration = inputGenerationRef.current
          setSending(true)
          setComposerActivity('syncing')
          setNote('syncing...')
          void syncListenChat(client, dbPath, sendTo).then((result) => {
            if (ownedGeneration !== inputGenerationRef.current) return
            if (!result.ok) {
              setNote(`sync failed: ${result.error.message}`)
              return
            }
            setInput('')
            setNote(`synced ${result.data.synced}`)
          }).catch((error) => {
            if (ownedGeneration === inputGenerationRef.current) setNote(`sync failed: ${messageFromError(error)}`)
          }).finally(() => {
            if (ownedGeneration === inputGenerationRef.current) {
              setSending(false)
              setComposerActivity(undefined)
            }
          })
          return
        }
        void groupCommand.submitParsed(parsed.request, input, selected).then((outcome) => {
          if (!outcome.applied) return
          if (outcome.kind === 'result' && outcome.result.ok) setInput('')
        })
        return
      }
      void sendMessage(input)
      return
    }
    if (key.backspace || key.delete) {
      inputGenerationRef.current = {}
      setInput((current) => current.slice(0, -1))
      return
    }
    if (key.escape || key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      return
    }
    if (!key.ctrl && !key.meta && inputText.length > 0) {
      inputGenerationRef.current = {}
      setInput((current) => {
        const next = current + inputText
        if (next.trimStart().startsWith('/')) {
          setFocus('input')
          commandSelectionRef.current = 0
          groupCommand.setState({ kind: 'menu', selectedIndex: 0 })
        }
        return next
      })
    }
  })

  useEffect(() => {
    const generation = operationControllerRef.current!.beginGeneration()
    const isActive = generation.isActive
    const lifecycleStop = new AbortController()
    lifecycleStopRef.current = lifecycleStop
    if (stopSignal.aborted) {
      exit()
      return
    }

    const stopFromSignal = () => {
      if (stoppingRef.current) return
      if (irreversibleGroupWriteRef.current) {
        requestOwnershipShutdown('external')
        return
      }
      stopListening()
    }
    const unsubscribeShutdown = shutdownRequests?.subscribe(stopFromSignal)
    if (shutdownRequests == null) stopSignal.addEventListener('abort', stopFromSignal)
    const groupQueue = createInteractiveListenRuntime(dbPath, createReplyResolver ?? createListenReplyResolver, {
      isActive,
      onGroup: (group) => {
        setScrollState((current) => applyMessageArrival(current))
        setMessageGroups((current) => [...current, group].slice(-LISTEN_HISTORY_LIMIT))
      },
      onError: (error) => {
        if (!isActive()) return
        setStatus(`listen failed: ${messageFromError(error)}`)
        onRequestStop()
        exit()
      },
    })
    const albumAggregator = new ListenAlbumAggregator({
      emit: (group) => {
        if (!isActive()) return
        groupQueue.enqueue(group)
      },
    })
    albumAggregatorRef.current = albumAggregator
    const autoDownloader = autoDownload
      ? new AutoDownloadCoordinator({
          onEvent: (event) => {
            if (!isActive()) return
            const ownership = operationControllerRef.current!.claimDownload(event.key)
            setDownloadStates((current) => applyAutoDownloadEvent(current, event, showMedia))
            if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
              ownership.release()
            }
          },
        })
      : null
    autoDownloaderRef.current = autoDownloader

    void runInteractiveAutoDownloadLifecycle({
      autoDownload,
      chats,
      persist,
      retrySeconds,
      signal: lifecycleStop.signal,
      createClient,
      createCoordinator: () => autoDownloader!,
      persistMessage,
      onCoordinator: (coordinator) => {
        if (isActive()) autoDownloaderRef.current = coordinator as AutoDownloadCoordinator | null
      },
      onClient: (client) => {
        if (!isActive()) return
        groupLookupGenerationRef.current = {}
        knownGroupRef.current = undefined
        setKnownGroup(undefined)
        clientRef.current = client
        if (client != null && sendTo != null) {
          const lookup = {}
          groupLookupGenerationRef.current = lookup
          void client.groups.getGroup(sendTo).then((group) => {
            if (isActive() && lookup === groupLookupGenerationRef.current && clientRef.current === client) { knownGroupRef.current = group; setKnownGroup(group) }
          }).catch(() => undefined)
          void resolveSendTargetLabel(client, sendTo).then((label) => {
            if (isActive() && label != null) setSendTargetLabel(label)
          })
        }
      },
      acceptMessage: (message) => {
        if (!isActive()) return false
        return acceptListenMessage(message, seenRef.current, seenOrderRef.current, () => undefined)
      },
      onBeforeEnqueue: (message) => {
        if (!isActive()) return
        registerPendingAttachmentKeys(pendingAttachmentKeysRef.current, message, showMedia)
      },
      onMessage: (message) => {
        if (!isActive()) return
        if (sendTo != null) {
          const inferred = inferSendTargetLabel(sendTo, message)
          if (inferred != null) setSendTargetLabel(inferred)
        }
        albumAggregator.add(message)
      },
      onStatus: (next) => {
        if (!isActive()) return
        setStatus(next === 'connecting'
          ? 'connecting...'
          : next === 'disconnected'
            ? `disconnected, retry in ${retrySeconds}s...`
            : next)
      },
      onError: (error) => {
        if (!isActive()) return
        if (persist) setNote(`listen failed: ${messageFromError(error)}`)
        else setStatus(`listen failed: ${messageFromError(error)}`)
      },
      flush: () => {
        if (isActive()) albumAggregator.flush()
      },
    }).finally(() => {
      if (isActive() && !stopSignal.aborted && !stoppingRef.current) {
        onRequestStop()
        exit()
      }
    })

    return () => {
      groupLookupGenerationRef.current = {}
      knownGroupRef.current = undefined
      unsubscribeShutdown?.()
      if (shutdownRequests == null) stopSignal.removeEventListener('abort', stopFromSignal)
      albumAggregator.flush()
      generation.dispose()
      albumAggregator.dispose()
      void groupQueue.close()
      if (albumAggregatorRef.current === albumAggregator) albumAggregatorRef.current = null
      lifecycleStop.abort()
      clientRef.current = null
      autoDownloader?.stop()
      void autoDownloader?.waitForActive()
      if (autoDownloaderRef.current === autoDownloader) autoDownloaderRef.current = null
      if (lifecycleStopRef.current === lifecycleStop) lifecycleStopRef.current = null
      if (shutdownGraceTimerRef.current) clearTimeout(shutdownGraceTimerRef.current)
      shutdownGraceTimerRef.current = null
    }
  }, [autoDownload, chats, createClient, createReplyResolver, dbPath, persist, retrySeconds, sendTo, showMedia, exit, stopSignal, shutdownRequests, onRequestStop])

  const sendMessage = async (text: string): Promise<void> => {
    const access = new WriteAccessPolicy().check()
    if (!access.ok) {
      setNote(access.error.message)
      return
    }

    const trimmed = text.trim()
    if (!trimmed) return
    const command = parseListenComposerInput(trimmed)
    if (command.kind === 'error') {
      setNote(command.error)
      return
    }
    if (sendTo == null) {
      setNote('set --send-to before sending')
      return
    }

    const client = clientRef.current
    if (!client) {
      setNote('connection is not ready')
      return
    }
    const isCurrent = operationControllerRef.current!.beginSend()

    setInput('')
    setSending(true)
    setNote('sending...')
    try {
      const sentMessages = command.kind === 'reply'
        ? await executeListenReply(client, sendTo, command)
        : [await client.sendMessage({
            chat: sendTo,
            message: command.content,
            linkPreview: true,
          })].flatMap(({ sent_message: message }) => message == null ? [] : [message])
      if (isCurrent()) {
        for (const sentMessage of sentMessages) acceptListenMessage(sentMessage, seenRef.current, seenOrderRef.current, (message) => {
          registerPendingAttachmentKeys(pendingAttachmentKeysRef.current, message, showMedia)
          autoDownloaderRef.current?.enqueue(message)
          albumAggregatorRef.current?.add(message)
        })
      }
      if (isCurrent()) setNote(command.kind === 'reply' ? `replied to #${command.reply}` : 'sent')
    } catch (error) {
      if (isCurrent()) setNote(`send failed: ${messageFromError(error)}`)
    } finally {
      if (isCurrent()) setSending(false)
    }
  }

  const downloadAttachment = async (item: DownloadableAttachment): Promise<void> => {
    const ownership = operationControllerRef.current!.beginDownload(item.key)
    const isCurrent = ownership.isCurrent
    await runOwnedAttachmentOperation(ownership, async () => {
      const client = clientRef.current
      if (!client) throw new Error('not connected')
      const destination = resolveAttachmentDestination({
        homeDir: homedir(),
        fileName: attachmentFileName(item.attachment),
        exists: existsSync,
      })
      mkdirSync(dirname(destination), { recursive: true })
      if (isCurrent()) setDownloadStates((current) => ({ ...current, [item.key]: { status: 'downloading', progress: 0 } }))
      await client.downloadMessageMedia({
        ...attachmentDownloadTarget(item.attachment),
        destination,
        onProgress: (downloaded, total) => {
          if (!isCurrent()) return
          const progress = attachmentDownloadProgress(downloaded, total)
          setDownloadStates((current) => ({ ...current, [item.key]: { status: 'downloading', progress } }))
        },
      })
      if (isCurrent()) setDownloadStates((current) => ({ ...current, [item.key]: { status: 'completed', path: destination } }))
    }, (error) => {
      setDownloadStates((current) => ({ ...current, [item.key]: { status: 'failed', error: messageFromError(error) } }))
    })
  }

  const stopListening = (): void => {
    if (stoppingRef.current) return
    stoppingRef.current = true
    setStatus('stopping...')
    const albumAggregator = albumAggregatorRef.current
    if (albumAggregator != null) flushListenBeforeExit(albumAggregator, exit)
    else setTimeout(exit, 0)
    onRequestStop()
    autoDownloaderRef.current?.stop()
    lifecycleStopRef.current?.abort()
  }

  useEffect(() => {
    if (groupCommand.state.kind !== 'result' && groupCommand.state.kind !== 'error') return
    if (!deferredStopRef.current && !shutdownRequestedRef.current) return
    deferredStopRef.current = false
    shutdownRequestedRef.current = false
    if (shutdownGraceTimerRef.current) clearTimeout(shutdownGraceTimerRef.current)
    shutdownGraceTimerRef.current = null
    const pending = setTimeout(stopListening, 0)
    return () => clearTimeout(pending)
  }, [groupCommand.state])

  const permissionState = groupCommand.state.kind === 'select-permissions' ? groupCommand.state : null

  return (
    <Box flexDirection="row" width={terminalWidth} height={terminalHeight} overflow="hidden">
      <Box flexDirection="column" width={contentWidth} height={terminalHeight} overflow="hidden">
        <ListenStatusArea
          status={status}
          unseenCount={scrollState.unseenCount}
          autoDownload={autoDownload}
        />
        {note ? <Text dimColor>{note}</Text> : null}
        {groupCommand.state.kind === 'result' ? <Box flexGrow={1} flexDirection="column"><GroupCommandResult state={groupCommand.state} width={contentWidth} /></Box> : <Box flexGrow={1} flexDirection="column">
        <GroupCommandResult state={groupCommand.state} width={contentWidth} />
        {groupCommand.state.kind === 'confirm' && 'confirmation' in groupCommand.state.pending ? <GroupCommandConfirm confirmation={groupCommand.state.pending.confirmation} selectedIndex={groupCommand.state.selectedIndex} width={contentWidth} /> : null}
        {groupCommand.state.kind === 'confirm-title' && 'confirmation' in groupCommand.state.pending ? groupCommand.state.stage === 'confirm'
          ? <GroupCommandConfirm confirmation={groupCommand.state.pending.confirmation} selectedIndex={groupCommand.state.selectedIndex} width={contentWidth} />
          : <Box flexDirection="column" width={contentWidth}><Text color="yellow">{truncateCell('Type the exact title to permanently delete this chat:', contentWidth)}</Text><Text>{truncateCell(groupCommand.state.pending.confirmation.title ?? '', contentWidth)}</Text><Text color="#8ecbff">{truncateCell(`› ${groupCommand.state.confirmText}`, contentWidth)}</Text>{groupCommand.state.mismatch ? <Text color="red">{truncateCell('Title does not match exactly.', contentWidth)}</Text> : null}<Text dimColor>{truncateCell('Enter verify · Esc back', contentWidth)}</Text></Box> : null}
        {groupCommand.state.kind === 'password' ? <SecureInput label="Telegram 2FA password" onSubmit={(value) => { void groupCommand.runWithOwnershipPassword(value) }} onCancel={closeGroupCommand} /> : null}
        {permissionState ? <Box flexDirection="column" width={contentWidth}><Text color="#8ecbff">{truncateCell('Administrator permissions', contentWidth)}</Text>{ADMIN_RIGHT_KEYS.map((right, index) => <Text key={right} color={index === permissionState.selectedIndex ? '#8ecbff' : undefined}>{truncateCell(`${index === permissionState.selectedIndex ? '› ' : '  '}[${permissionState.selected.includes(right) ? 'x' : ' '}] ${right}`, contentWidth)}</Text>)}{permissionState.warning ? <Text color="yellow">{truncateCell(permissionState.warning, contentWidth)}</Text> : null}<Text dimColor>{truncateCell('↑/↓ select · Space toggle · Enter continue · Esc cancel', contentWidth)}</Text></Box> : null}
        <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
          {messages.length === 0 ? <Text dimColor>Waiting for new messages...</Text> : null}
          {visibleMessages.map((message) => (
            <Box key={message.key} flexDirection="column">
              <ListenMessageHeader message={message} />
              <ListenMessageBody
                message={message}
                selectedAttachmentKey={focus === 'attachments' ? selectedAttachment?.key ?? null : null}
                attachmentStates={downloadStates}
              />
              <ListenMessageSeparator />
            </Box>
          ))}
        </Box>
        </Box>}
        {groupCommand.state.kind !== 'result' ? <Box flexDirection="column">
          {sendTo == null ? <Text dimColor>Set --send-to &lt;chat&gt; (or pass one chat to listen) before sending messages.</Text> : null}
          <Box marginTop={1} flexDirection="column" flexShrink={0}>
            {input.trimStart().startsWith('/') && groupCommand.state.kind === 'menu' ? <ListenCommandMenu input={input} selectedIndex={groupCommand.state.selectedIndex} width={contentWidth} knownGroup={knownGroup} /> : null}
            <ListenComposer
              input={input}
              sendTargetLabel={sendTo == null ? '(not selected)' : sendTargetLabel}
              terminalWidth={contentWidth}
              sending={sending}
              activity={composerActivity}
              cursorVisible={focus === 'input'}
              hint={focus === 'attachments' ? 'Wheel · ↑/↓ select · Enter download · Tab input' : 'Wheel/↑/↓/PgUp/PgDn scroll · Drag select · Ctrl+C exit'}
            />
          </Box>
        </Box> : null}
      </Box>
      <ListenScrollbar height={terminalHeight} visible={scrollbarVisible} geometry={scrollbarGeometry} />
    </Box>
  )
}

export type ListenMessageRenderContext = {
  showMedia: boolean
  previewWidth: number
  colorDepth: number
  showChatName?: boolean
  decodePreview?: typeof decodeImagePreview
  replyContext?: ReplyContext
}

type ListenMessageCacheEntry = {
  group: StoredMessageInput[]
  replyContext: ReplyContext | undefined
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

  build(groups: Array<StoredMessageInput[] | ResolvedListenGroup>, context: ListenMessageRenderContext): ListenMessage[] {
    const previewWidth = normalizedPreviewWidth(context.previewWidth)
    const nextEntries = new Map<string, ListenMessageCacheEntry>()
    const messages = groups.map((input) => {
      const group = Array.isArray(input) ? input : input.messages
      const replyContext = Array.isArray(input) ? context.replyContext : input.replyContext
      const first = group[0]
      if (first == null) throw new Error('Cannot render an empty listen message group')
      const key = Array.isArray(input) ? `${first.chat_id}:${first.msg_id}` : input.key
      const cached = this.entries.get(key)
      if (
        cached?.group === group
        && cached.replyContext === replyContext
        && cached.showMedia === context.showMedia
        && cached.previewWidth === previewWidth
        && cached.colorDepth === context.colorDepth
        && cached.decodePreview === context.decodePreview
      ) {
        nextEntries.set(key, cached)
        return cached.message
      }
      const message = toListenMessage(group, { ...context, previewWidth, replyContext })
      nextEntries.set(key, {
        group,
        replyContext,
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

export function pruneListenMessageGroups<T extends StoredMessageInput[] | ResolvedListenGroup>(
  groups: T[],
  limit = LISTEN_HISTORY_LIMIT,
): { groups: T[]; removedKeys: string[] } {
  const retainedLimit = Math.max(0, limit)
  const removeCount = Math.max(0, groups.length - retainedLimit)
  const removed = groups.slice(0, removeCount)
  return {
    groups: groups.slice(removeCount),
    removedKeys: removed.flatMap((group) => {
      const first = Array.isArray(group) ? group[0] : group.messages[0]
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
    ? { showMedia: context, previewWidth: 1, colorDepth: 1, showChatName: false }
    : context
  const { showMedia, previewWidth, colorDepth, showChatName = false, replyContext } = renderContext
  const formatted = buildListenMessage(messages, { showMedia, showChatName, replyContext })
  const decodePreview = renderContext.decodePreview ?? decodeImagePreview
  const attachments = formatted.attachments.map((attachment) => {
    if (!showMedia || attachment.preview_jpeg_base64 == null || colorDepth < 24) return attachment
    const preview = decodePreview(attachment.preview_jpeg_base64, normalizedPreviewWidth(previewWidth))
    return preview == null
      ? attachment
      : { ...attachment, previewRows: preview.rows.length, previewCells: preview.rows }
  })
  return {
    key: `${message.chat_id}:${message.msg_id}`,
    msgId: message.msg_id,
    showMedia,
    ...formatted,
    attachments,
  }
}

async function syncListenChat(
  client: TelegramClientAdapter,
  dbPath: string,
  chat: string | number,
): Promise<HandlerResult<{ synced: number; chat: string }>> {
  const service = new SyncService(client, new MessageDB(dbPath))
  try {
    const result = await service.sync({ chat: String(chat), limit: 5000, pageDelay: 1 })
    return result as HandlerResult<{ synced: number; chat: string }>
  } finally {
    service.close()
  }
}

function normalizedPreviewWidth(previewWidth: number): number {
  return Math.max(1, Math.min(24, previewWidth))
}

export function collectDownloadableAttachments(messages: ListenMessage[]): DownloadableAttachment[] {
  return messages.flatMap((message) => message.showMedia
    ? message.attachments.flatMap((attachment, index) => (
      attachment.downloadable === true
      ? [{
          key: attachmentDownloadKeyAt(message.attachments, index),
          message,
          attachment,
        }]
      : []
    ))
    : [])
}

export { attachmentDownloadTarget } from '../attachment.js'

export function flushListenBeforeExit(aggregator: Pick<ListenAlbumAggregator, 'flush'>, exit: () => void): void {
  aggregator.flush()
  setTimeout(exit, 0)
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
