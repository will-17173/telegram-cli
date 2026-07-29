export const SEND_COMMAND_USAGE = 'send [content] --file <path> ...'
export const REPLY_COMMAND_USAGE = 'reply <message-id> [content] [--file <path> ...]'
export const HISTORY_COMMAND_USAGE = 'history [count]'
export const DEFAULT_HISTORY_LIMIT = 100

import type { StoredMessageInput } from '../storage/message-db.js'
import type { TelegramClientAdapter, TelegramSendTarget } from '../telegram/types.js'

export type ListenComposerCommand =
  | { kind: 'message'; content: string }
  | { kind: 'send'; content?: string; files: string[] }
  | { kind: 'reply'; reply: number; content?: string; files: string[] }
  | { kind: 'error'; error: string }

export async function executeListenComposerCommand(
  client: TelegramClientAdapter,
  chat: TelegramSendTarget,
  command: Exclude<ListenComposerCommand, { kind: 'error' }>,
): Promise<StoredMessageInput[]> {
  if (command.kind === 'reply') return executeListenReply(client, chat, command)
  if (command.kind === 'send') {
    const result = await client.sendMedia({
      chat,
      files: command.files,
      ...(command.content == null ? {} : { caption: command.content }),
    })
    return result.messages.flatMap(({ sent_message: message }) => message == null ? [] : [message])
  }

  const result = await client.sendMessage({
    chat,
    message: command.content,
    linkPreview: true,
  })
  return result.sent_message == null ? [] : [result.sent_message]
}

export async function executeListenReply(
  client: TelegramClientAdapter,
  chat: TelegramSendTarget,
  command: Extract<ListenComposerCommand, { kind: 'reply' }>,
): Promise<StoredMessageInput[]> {
  if (command.files.length > 0) {
    const result = await client.sendMedia({
      chat,
      files: command.files,
      ...(command.content == null ? {} : { caption: command.content }),
      reply: command.reply,
    })
    return result.messages.flatMap(({ sent_message: message }) => message == null ? [] : [message])
  }

  const result = await client.sendMessage({
    chat,
    message: command.content!,
    reply: command.reply,
    linkPreview: true,
  })
  return result.sent_message == null ? [] : [result.sent_message]
}

export function parseListenComposerInput(input: string): ListenComposerCommand {
  const trimmed = input.trim()
  if (/^\/send(?:\s|$)/.test(trimmed)) return parseSendCommand(trimmed)
  if (!trimmed.startsWith('/reply') || !/^\/reply(?:\s|$)/.test(trimmed)) {
    return { kind: 'message', content: trimmed }
  }

  const tokens = tokenize(trimmed)
  if (typeof tokens === 'string') return { kind: 'error', error: tokens }
  if (tokens.length < 2) {
    return { kind: 'error', error: `usage: /${REPLY_COMMAND_USAGE}` }
  }

  const reply = Number(normalizeReplyMessageIdToken(tokens[1]!))
  if (!Number.isInteger(reply) || reply <= 0) {
    return { kind: 'error', error: 'reply message ID must be a positive integer' }
  }

  const content: string[] = []
  const files: string[] = []
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token !== '--file' && token !== '-f') {
      content.push(token)
      continue
    }
    const path = tokens[index + 1]
    if (path == null || path === '--file' || path === '-f') {
      return { kind: 'error', error: '--file requires a path' }
    }
    files.push(path)
    index += 1
  }

  const message = content.join(' ')
  if (!message && files.length === 0) {
    return { kind: 'error', error: 'reply requires content or at least one file' }
  }
  return {
    kind: 'reply',
    reply,
    ...(message ? { content: message } : {}),
    files,
  }
}

function parseSendCommand(input: string): ListenComposerCommand {
  const tokens = tokenize(input)
  if (typeof tokens === 'string') return { kind: 'error', error: tokens }

  const content: string[] = []
  const files: string[] = []
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token !== '--file' && token !== '-f') {
      content.push(token)
      continue
    }
    const path = tokens[index + 1]
    if (path == null || path === '--file' || path === '-f') {
      return { kind: 'error', error: '--file requires a path' }
    }
    files.push(path)
    index += 1
  }

  if (files.length === 0) return { kind: 'error', error: 'send requires at least one file' }
  const message = content.join(' ')
  return {
    kind: 'send',
    ...(message ? { content: message } : {}),
    files,
  }
}

export function parseHistoryLimit(input: string): { ok: true; limit: number } | { ok: false; error: string } {
  const tokens = tokenize(input.trim())
  if (typeof tokens === 'string') return { ok: false, error: tokens }
  if (tokens.length > 2) return { ok: false, error: `usage: /${HISTORY_COMMAND_USAGE}` }
  const raw = tokens[1]
  if (raw == null) return { ok: true, limit: DEFAULT_HISTORY_LIMIT }
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false, error: `usage: /${HISTORY_COMMAND_USAGE}` }
  }
  return { ok: true, limit }
}

function normalizeReplyMessageIdToken(token: string): string {
  return token.startsWith('#') ? token.slice(1) : token
}

function tokenize(input: string): string[] | string {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  const push = () => {
    if (current) tokens.push(current)
    current = ''
  }

  for (const character of input) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (quote != null) {
      if (character === quote) quote = null
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      push()
    } else {
      current += character
    }
  }

  if (escaped) current += '\\'
  if (quote != null) return 'unterminated quote'
  push()
  return tokens
}
