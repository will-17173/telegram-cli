import { writeFileSync } from 'node:fs'
import type { HandlerResult } from '../commands/types.js'
import { actionDetail } from '../presenters/human.js'
import { dumpStructured, successPayload } from '../presenters/structured.js'
import { MessageDB } from '../storage/message-db.js'

export class DataService {
  constructor(private readonly db = new MessageDB()) {}

  close(): void {
    this.db.close()
  }

  exportMessages(options: { chat: string; format: 'text' | 'json' | 'yaml'; output?: string; hours?: number }): HandlerResult {
    if (!['text', 'json', 'yaml'].includes(options.format)) {
      return { ok: false, error: { code: 'invalid_option', message: 'Format must be text, json, or yaml.', details: { option: 'format' } } }
    }
    if (options.hours != null && (!Number.isFinite(options.hours) || options.hours <= 0)) {
      return { ok: false, error: { code: 'invalid_option', message: 'Hours must be a positive number.', details: { option: 'hours' } } }
    }

    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId

    const messages = this.db.getRecent({ chatId: chatId.data, hours: options.hours, limit: 100000 })
    if (messages.length === 0) return { ok: false, error: { code: 'no_messages', message: `No messages found for '${options.chat}'.` } }

    const text = options.format === 'json'
      ? dumpStructured(successPayload(messages), 'json')
      : options.format === 'yaml'
        ? dumpStructured(successPayload(messages), 'yaml')
        : messages.map((msg) => `[${msg.timestamp.slice(0, 19)}] ${msg.sender_name ?? 'Unknown'}: ${msg.content ?? ''}`).join('\n')

    if (options.output) {
      try {
        writeFileSync(options.output, text, 'utf8')
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const details = fileErrorDetails(error, options.output)
        return {
          ok: false,
          error: {
            code: 'export_failed',
            message: `Failed to export messages to '${options.output}': ${reason}`,
            details,
          },
        }
      }
      const data = { exported: messages.length, output: options.output }
      return { ok: true, data, human: actionDetail('Export Complete', data) }
    }
    return { ok: true, data: messages, human: { kind: 'text', text } }
  }

  purge(options: { chat: string; yes: boolean }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    if (!options.yes) return { ok: false, error: { code: 'confirmation_required', message: 'Use --yes to confirm purge in this Node port.' } }
    const data = { deleted: this.db.deleteChat(chatId.data) }
    return { ok: true, data, human: actionDetail('Messages Deleted', data) }
  }

  private resolveChat(chat: string): HandlerResult<number> {
    const matches = this.db.findChats(chat)
    if (matches.length === 1) return { ok: true, data: matches[0].chat_id }
    if (matches.length === 0) return { ok: false, error: { code: 'chat_not_found', message: `Chat '${chat}' not found in database.` } }
    return { ok: false, error: { code: 'ambiguous_chat', message: `Chat '${chat}' is ambiguous. Matches: ${matches.map((m) => m.chat_name ?? m.chat_id).join(', ')}` } }
  }
}

function fileErrorDetails(error: unknown, output: string): { code?: string; path: string } {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return { code: (error as { code: string }).code, path: output }
  }
  return { path: output }
}
