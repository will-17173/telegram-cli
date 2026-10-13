import { accessSync, constants, statSync } from 'node:fs'

import type { HandlerResult } from '../commands/types.js'
import { WriteAccessPolicy } from '../services/write-access-policy.js'
import type { StoredMessageInput } from '../storage/message-db.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import type { DesktopListenInput } from '../web/workspace-types.js'

const MAX_PENDING_SENDS = 32
const MAX_REQUEST_ID_LENGTH = 128
const MAX_CHAT_LENGTH = 512
const MAX_TEXT_LENGTH = 4_096
const MAX_PATH_LENGTH = 4_096
const MAX_FILES = 100

type SendSummary = {
  sent: true
  msg_id: number
  msg_ids?: number[]
  chat: string
  files?: string[]
  reply_to?: number
}

type PendingSend = {
  requestId: string
  input: DesktopListenInput
  answered: boolean
}

export type DesktopListenInputOptions = {
  signal: AbortSignal
  onSent?: (messages: StoredMessageInput[]) => void
}

export function attachDesktopListenInput(client: TelegramClientAdapter, options: DesktopListenInputOptions): () => void {
  if (process.env.TG_DESKTOP_IPC !== '1' || typeof process.send !== 'function' || options.signal.aborted) {
    return () => undefined
  }

  const queue: PendingSend[] = []
  const pending = new Map<string, PendingSend>()
  const writePolicy = new WriteAccessPolicy()
  let processing = false
  let stopped = false

  const emit = (message: object): void => {
    if (typeof process.send !== 'function' || !isIpcConnected()) return
    try {
      process.send(message, (error: Error | null) => {
        if (error != null) dispose('listen_disconnected', 'The desktop IPC connection is unavailable.')
      })
    } catch {
      dispose('listen_disconnected', 'The desktop IPC connection is unavailable.')
    }
  }

  const respond = (request: PendingSend, result: HandlerResult<SendSummary>): void => {
    if (request.answered) return
    request.answered = true
    emit({ type: 'tg-desktop-listen-result', requestId: request.requestId, result })
  }

  const dispose = (code = 'listen_stopping', message = 'The listener is stopping.'): void => {
    if (stopped) return
    stopped = true
    process.off('message', onMessage)
    process.off('disconnect', onDisconnect)
    options.signal.removeEventListener('abort', onAbort)
    const abandoned = [...pending.values()]
    pending.clear()
    queue.length = 0
    for (const request of abandoned) respond(request, failure(code, message))
    emit({ type: 'tg-desktop-listen-unready' })
  }

  const drain = async (): Promise<void> => {
    if (processing) return
    processing = true
    try {
      while (!stopped && queue.length > 0) {
        const request = queue.shift()!
        try {
          if (!isIpcConnected()) {
            dispose('listen_disconnected', 'The desktop IPC connection is unavailable.')
            break
          }
          const access = writePolicy.check()
          if (!access.ok) {
            respond(request, access)
            continue
          }

          const input = request.input
          const chat = parseChat(input.chat)
          const content = input.text?.trim() ? input.text : undefined
          let sentMessages: StoredMessageInput[]
          let summary: SendSummary
          if (input.files != null && input.files.length > 0) {
            const sent = await client.sendMedia({
              chat,
              files: input.files,
              ...(content === undefined ? {} : { caption: content }),
              ...(input.reply === undefined ? {} : { reply: input.reply }),
            })
            const ids = sent.messages.map((message) => message.msg_id)
            if (ids.length === 0) throw new Error('No sent messages were returned.')
            sentMessages = sent.messages.flatMap(({ sent_message }) => sent_message === undefined ? [] : [sent_message])
            summary = { sent: true, msg_id: ids[0]!, msg_ids: ids, chat: input.chat, files: [...input.files] }
          } else {
            const sent = await client.sendMessage({
              chat,
              message: content!,
              linkPreview: input.linkPreview ?? true,
              ...(input.reply === undefined ? {} : { reply: input.reply }),
            })
            sentMessages = sent.sent_message === undefined ? [] : [sent.sent_message]
            summary = { sent: true, msg_id: sent.msg_id, chat: input.chat }
          }
          if (input.reply !== undefined) summary.reply_to = input.reply

          if (stopped || options.signal.aborted || !isIpcConnected()) continue
          try {
            options.onSent?.(sentMessages)
          } catch {
            respond(request, failure('listen_save_failed', 'Message sent, but local saving failed.'))
            continue
          }
          respond(request, { ok: true, data: summary })
        } catch {
          if (!stopped) respond(request, failure('telegram_error', 'Unable to send the Telegram message.'))
        } finally {
          pending.delete(request.requestId)
        }
      }
    } finally {
      processing = false
    }
  }

  const onMessage = (value: unknown): void => {
    if (stopped || !isRecord(value) || value.type !== 'tg-desktop-listen-send') return
    if (typeof value.requestId !== 'string' || value.requestId.trim().length === 0
      || value.requestId.length > MAX_REQUEST_ID_LENGTH || /[\u0000-\u001f]/u.test(value.requestId)) return
    const requestId = value.requestId
    const invalid = validateInput(value.input)
    if (invalid != null || Object.keys(value).some((key) => !['type', 'requestId', 'input'].includes(key))) {
      emit({ type: 'tg-desktop-listen-result', requestId, result: invalid ?? failure('invalid_request', 'Unknown IPC request property.') })
      return
    }
    if (pending.has(requestId)) {
      emit({ type: 'tg-desktop-listen-result', requestId, result: failure('invalid_request', 'The request ID is already pending.') })
      return
    }
    if (pending.size >= MAX_PENDING_SENDS) {
      emit({ type: 'tg-desktop-listen-result', requestId, result: failure('listen_send_busy', 'The listener send queue is full.') })
      return
    }

    // Own a fresh copy while queued; release it when the send finishes.
    const input = value.input as DesktopListenInput
    const request: PendingSend = { requestId, input: { ...input, ...(input.files === undefined ? {} : { files: [...input.files] }) }, answered: false }
    pending.set(requestId, request)
    queue.push(request)
    void drain()
  }

  const onAbort = (): void => dispose()
  const onDisconnect = (): void => dispose('listen_disconnected', 'The desktop IPC connection is unavailable.')
  process.on('message', onMessage)
  process.on('disconnect', onDisconnect)
  options.signal.addEventListener('abort', onAbort, { once: true })
  emit({ type: 'tg-desktop-listen-ready' })
  return dispose
}

function validateInput(input: unknown): HandlerResult<never> | null {
  if (!isRecord(input)) return failure('invalid_request', 'input must be an object.')
  if (Object.keys(input).some((key) => !['chat', 'text', 'files', 'reply', 'linkPreview'].includes(key))) {
    return failure('invalid_request', 'Unknown listener input property.')
  }
  if (typeof input.chat !== 'string' || input.chat.trim().length === 0 || input.chat.length > MAX_CHAT_LENGTH
    || /[\u0000-\u001f]/u.test(input.chat)) {
    return failure('invalid_request', 'chat must be a non-empty string of at most 512 characters.')
  }
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > MAX_TEXT_LENGTH)) {
    return failure('invalid_request', 'text must be a string of at most 4096 characters.')
  }
  if (input.reply !== undefined && (typeof input.reply !== 'number' || !Number.isSafeInteger(input.reply) || input.reply <= 0)) {
    return failure('invalid_request', 'reply must be a positive integer.')
  }
  if (input.linkPreview !== undefined && typeof input.linkPreview !== 'boolean') {
    return failure('invalid_request', 'linkPreview must be a boolean.')
  }
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > MAX_FILES)) {
    return failure('invalid_request', 'files must be an array of at most 100 file paths.')
  }
  const files: unknown[] = Array.isArray(input.files) ? input.files : []
  if (!(typeof input.text === 'string' && input.text.trim()) && files.length === 0) {
    return failure('invalid_request', 'Provide text or at least one file.')
  }
  for (const path of files) {
    if (typeof path !== 'string' || path.trim().length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\0')) {
      return failure('invalid_request', 'Each file path must be a non-empty string of at most 4096 characters.')
    }
    try {
      if (!statSync(path).isFile()) return failure('invalid_request', 'Each media path must refer to a readable file.')
      accessSync(path, constants.R_OK)
    } catch {
      return failure('invalid_request', 'Each media path must refer to a readable file.')
    }
  }
  return null
}

function parseChat(chat: string): string | number {
  const trimmed = chat.trim()
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && String(parsed) === trimmed ? parsed : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIpcConnected(): boolean {
  return typeof process.send === 'function' && process.connected !== false
}

function failure(code: string, message: string): HandlerResult<never> {
  return { ok: false, error: { code, message } }
}
