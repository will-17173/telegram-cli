import { accessSync, constants, statSync } from 'node:fs'
import type { HandlerResult } from '../commands/types.js'
import { actionDetail } from '../presenters/human.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import { WriteAccessPolicy } from './write-access-policy.js'

type SendOptions = {
  chat: string
  message?: string
  files: string[]
  reply?: number
  linkPreview: boolean
}

type SendResult = {
  sent: true
  msg_id: number
  msg_ids?: number[]
  chat: string
  files?: string[]
  reply_to?: number
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
  constructor(
    private readonly tg: TelegramClientAdapter,
    private readonly writePolicy: WriteAccessPolicy = new WriteAccessPolicy(),
  ) {}

  withWriteAccess<T>(): HandlerResult<T> | null {
    const check = this.writePolicy.check()
    return check.ok ? null : check
  }

  async send(options: SendOptions): Promise<HandlerResult<SendResult>> {
    const access = this.withWriteAccess<SendResult>()
    if (access) return access

    const invalid = validateSend(options)
    if (invalid) return invalid

    const message = options.message?.trim() ? options.message : undefined
    try {
      if (options.files.length === 0) {
        if (message == null) return invalidOption('Provide a message or at least one file.')
        const result = await this.tg.sendMessage({
          chat: options.chat,
          message,
          reply: options.reply,
          linkPreview: options.linkPreview,
        })
        const payload: SendResult = {
          sent: true,
          msg_id: result.msg_id,
          chat: options.chat,
        }
        if (options.reply != null) payload.reply_to = options.reply
        return { ok: true, data: payload, human: actionDetail('Message Sent', payload) }
      }

      const result = await this.tg.sendMedia({
        chat: options.chat,
        files: options.files,
        ...(message == null ? {} : { caption: message }),
        ...(options.reply == null ? {} : { reply: options.reply }),
      })
      const msgIds = result.messages.map((item) => item.msg_id)
      if (msgIds.length === 0) throw new Error('Telegram returned no sent messages.')
      const payload: SendResult = {
        sent: true,
        msg_id: msgIds[0],
        msg_ids: msgIds,
        chat: options.chat,
        files: [...options.files],
      }
      if (options.reply != null) payload.reply_to = options.reply
      return { ok: true, data: payload, human: actionDetail('Message Sent', payload) }
    } catch (error) {
      return telegramFailure(error)
    }
  }

  async edit(options: EditOptions): Promise<HandlerResult<{ edited: true; msg_id: number; chat: string }>> {
    const access = this.withWriteAccess<{ edited: true; msg_id: number; chat: string }>()
    if (access) return access

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
    const access = this.withWriteAccess<{ deleted: true; msg_ids: number[]; chat: string }>()
    if (access) return access

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
  if (options.reply != null && !isPositiveInteger(options.reply)) return invalidOption('reply must be a positive integer.')
  if (!options.message?.trim() && options.files.length === 0) {
    return invalidOption('Provide a message or at least one file.')
  }
  for (const path of options.files) {
    const invalid = validateFile(path)
    if (invalid) return invalid
  }
  return undefined
}

function validateFile(path: string): HandlerResult<never> | undefined {
  if (!path.trim()) return invalidOption('File path must be a non-empty string.')
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return invalidOption(`Path is not a file: ${path}`)
    accessSync(path, constants.R_OK)
  } catch {
    return invalidOption(`File is not readable: ${path}`)
  }
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
