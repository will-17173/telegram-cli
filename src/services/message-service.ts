import type { HandlerResult } from '../commands/types.js'
import { actionDetail } from '../presenters/human.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

type SendOptions = {
  chat: string
  message: string
  reply?: number
  linkPreview: boolean
}

type EditOptions = {
  chat: string
  msgId: number
  text: string
  linkPreview: boolean
}

type DeleteOptions = {
  chat: string
  msgIds: number[]
}

export class MessageService {
  constructor(private readonly tg: TelegramClientAdapter) {}

  async send(options: SendOptions): Promise<HandlerResult<{ sent: true; msg_id: number; chat: string; reply_to?: number }>> {
    const invalid = validateSend(options)
    if (invalid) return invalid

    try {
      const result = await this.tg.sendMessage(options)
      const payload: { sent: true; msg_id: number; chat: string; reply_to?: number } = {
        sent: true,
        msg_id: result.msg_id,
        chat: options.chat,
      }
      if (options.reply != null) payload.reply_to = options.reply
      return { ok: true, data: payload, human: actionDetail('Message Sent', payload) }
    } catch (error) {
      return telegramFailure(error)
    }
  }

  async edit(options: EditOptions): Promise<HandlerResult<{ edited: true; msg_id: number; chat: string }>> {
    const invalid = validateEdit(options)
    if (invalid) return invalid

    try {
      await this.tg.editMessage({ chat: options.chat, msgId: options.msgId, text: options.text, linkPreview: options.linkPreview })
      const data = { edited: true as const, msg_id: options.msgId, chat: options.chat }
      return { ok: true, data, human: actionDetail('Message Edited', data) }
    } catch (error) {
      return telegramFailure(error)
    }
  }

  async delete(options: DeleteOptions): Promise<HandlerResult<{ deleted: true; msg_ids: number[]; chat: string }>> {
    const invalid = validateDelete(options)
    if (invalid) return invalid

    try {
      await this.tg.deleteMessages({ chat: options.chat, msgIds: options.msgIds })
      const data = { deleted: true as const, msg_ids: options.msgIds, chat: options.chat }
      return { ok: true, data, human: actionDetail('Messages Deleted', data) }
    } catch (error) {
      return telegramFailure(error)
    }
  }
}

function validateSend(options: SendOptions): HandlerResult<never> | undefined {
  if (!options.chat.trim()) return invalidOption('chat must be a non-empty string.')
  if (!options.message.trim()) return invalidOption('message must not be empty.')
  if (options.reply != null && !isPositiveInteger(options.reply)) return invalidOption('reply must be a positive integer.')
  return undefined
}

function validateEdit(options: EditOptions): HandlerResult<never> | undefined {
  if (!options.chat.trim()) return invalidOption('chat must be a non-empty string.')
  if (!isPositiveInteger(options.msgId)) return invalidOption('msg_id must be a positive integer.')
  if (!options.text.trim()) return invalidOption('text must not be empty.')
  return undefined
}

function validateDelete(options: DeleteOptions): HandlerResult<never> | undefined {
  if (!options.chat.trim()) return invalidOption('chat must be a non-empty string.')
  if (!Array.isArray(options.msgIds) || options.msgIds.length === 0) {
    return invalidOption('msg_ids must be a non-empty array.')
  }
  if (!options.msgIds.every(isPositiveInteger)) return invalidOption('All msg_ids must be positive integers.')
  return undefined
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function invalidOption(message: string): HandlerResult<never> {
  return { ok: false, error: { code: 'invalid_option', message } }
}

function telegramFailure(error: unknown): HandlerResult<never> {
  const details = errorDetails(error)
  return {
    ok: false,
    error: details == null
      ? { code: 'telegram_error', message: errorMessage(error) }
      : { code: 'telegram_error', message: errorMessage(error), details },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorDetails(error: unknown): unknown {
  return error instanceof Error ? { name: error.name } : undefined
}
