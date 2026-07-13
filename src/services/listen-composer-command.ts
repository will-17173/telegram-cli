export const REPLY_COMMAND_USAGE = 'reply <message-id> [content] [--file <path> ...]'

import type { StoredMessageInput } from '../storage/message-db.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

export type ListenComposerCommand =
  | { kind: 'message'; content: string }
  | { kind: 'reply'; reply: number; content?: string; files: string[] }
  | { kind: 'error'; error: string }

export async function executeListenReply(
  client: TelegramClientAdapter,
  chat: string | number,
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
  if (!trimmed.startsWith('/reply') || !/^\/reply(?:\s|$)/.test(trimmed)) {
    return { kind: 'message', content: trimmed }
  }

  const tokens = tokenize(trimmed)
  if (typeof tokens === 'string') return { kind: 'error', error: tokens }
  if (tokens.length < 2) {
    return { kind: 'error', error: `usage: /${REPLY_COMMAND_USAGE}` }
  }

  const reply = Number(tokens[1])
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
