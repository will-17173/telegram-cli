import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { resolveAuthenticatedAccountContext } from '../account/account-context.js'
import { getDataDir } from '../config/env.js'
import { resolveAttachmentDestination } from '../services/attachment-download.js'
import { isDataResetRequiredError, MESSAGE_DB_SCHEMA_VERSION, MessageDB } from '../storage/message-db.js'
import { selectStoredAttachment, toAttachmentLocator, AttachmentLookupError } from '../telegram/attachment-locator.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import { handleGuardApiRequest } from './guard-api.js'
import { validateLocalRequest } from './security.js'
import { SyncTaskRunner } from './sync-task.js'
import { telegramPeerIdFromLocalChatId } from './telegram-peer.js'
import { WebQueryService } from './query.js'
import type { ApiFailure, ApiSuccess } from './types.js'

export type ApiContext = {
  dataDir?: string
  port: number
  syncTask: SyncTaskRunner
}

type ApiError = {
  status: number
  code: string
  message: string
}

export async function handleApiRequest(request: Request, context: ApiContext): Promise<Response> {
  const security = validateLocalRequest(request, context.port)
  if (!security.ok) return failure(security.status, security.code, security.message)

  const url = new URL(request.url)

  try {
    const dataDir = context.dataDir ?? getDataDir()
    if (url.pathname.startsWith('/api/guard/')) {
      return await handleGuardApiRequest(request, { ...context, dataDir })
    }

    const query = new WebQueryService({ dataDir })

    switch (url.pathname) {
      case '/api/health':
        if (request.method !== 'GET') return notFound()
        return success({ status: 'ok' })
      case '/api/accounts':
        if (request.method !== 'GET') return notFound()
        return success(query.accounts())
      case '/api/chats':
        if (request.method !== 'GET') return notFound()
        return success(query.chats({
          account: stringParam(url, 'account'),
          q: stringParam(url, 'q'),
          limit: optionalPositiveIntParam(url, 'limit') ?? 100,
          offset: optionalNonNegativeIntParam(url, 'offset') ?? 0,
        }))
      case '/api/messages':
        if (request.method !== 'GET') return notFound()
        return success(query.messages({
          account: stringParam(url, 'account'),
          chatId: requiredNonZeroIntParam(url, 'chatId'),
          q: stringParam(url, 'q'),
          senderId: optionalIntParam(url, 'senderId'),
          senderName: stringParam(url, 'senderName'),
          text: stringParam(url, 'text'),
          since: stringParam(url, 'since'),
          until: stringParam(url, 'until'),
          limit: optionalPositiveIntParam(url, 'limit') ?? 50,
          offset: optionalNonNegativeIntParam(url, 'offset') ?? 0,
          cursor: stringParam(url, 'cursor'),
        }))
      case '/api/sync-task':
        if (request.method === 'POST') return await syncTaskPost(request, context)
        if (request.method !== 'GET') return notFound()
        return success(context.syncTask.getState())
      case '/api/download-media':
        if (request.method !== 'POST') return notFound()
        return await downloadMediaPost(request, { dataDir })
      default:
        return notFound()
    }
  } catch (error) {
    return errorResponse(error)
  }
}

function success<T>(data: T): Response {
  return jsonResponse(200, { ok: true, data })
}

function failure(status: number, code: string, message: string, details?: unknown): Response {
  return jsonResponse(status, { ok: false, error: { code, message, details } })
}

function notFound(): Response {
  return failure(404, 'not_found', 'API route not found.')
}

function jsonResponse<T>(status: number, body: ApiSuccess<T> | ApiFailure): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function syncTaskPost(request: Request, context: ApiContext): Promise<Response> {
  if (!isJsonRequest(request)) {
    return failure(400, 'invalid_request', 'Content-Type must include application/json.')
  }

  const body = await parseJsonBody(request)
  if (!isRecord(body)) {
    return failure(400, 'invalid_request', 'Request body must be a JSON object.')
  }

  const account = typeof body.account === 'string' ? body.account.trim() : ''
  if (account === '') {
    return failure(400, 'invalid_request', 'account must be a non-empty string.')
  }

  if (!isSafeNonZeroInteger(body.chatId)) {
    return failure(400, 'invalid_request', 'chatId must be a non-zero integer.')
  }

  let limit = 500
  if (hasOwn(body, 'limit')) {
    if (!isSafePositiveInteger(body.limit)) {
      return failure(400, 'invalid_request', 'limit must be a positive integer.')
    }
    limit = body.limit
  }

  const result = await context.syncTask.start({ account, chatId: body.chatId, limit })
  if (result.ok) return jsonResponse(200, result)

  if (result.error.code === 'sync_task_running') return jsonResponse(409, result)
  if (result.error.code === 'invalid_request' || isAccountErrorCode(result.error.code)) return jsonResponse(400, result)
  return jsonResponse(500, result)
}

async function downloadMediaPost(request: Request, context: { dataDir: string }): Promise<Response> {
  if (!isJsonRequest(request)) {
    return failure(400, 'invalid_request', 'Content-Type must include application/json.')
  }

  const body = await parseJsonBody(request)
  if (!isRecord(body)) return failure(400, 'invalid_request', 'Request body must be a JSON object.')

  const account = typeof body.account === 'string' ? body.account.trim() : ''
  if (account === '') return failure(400, 'invalid_request', 'account must be a non-empty string.')
  if (!Array.isArray(body.attachments) || body.attachments.length === 0) {
    return failure(400, 'invalid_request', 'attachments must be a non-empty array.')
  }

  try {
    const attachments = body.attachments.map(parseDownloadAttachment)
    const reserved = new Set<string>()
    const clientContext = resolveAuthenticatedAccountContext({ explicitName: account, dataDir: context.dataDir })
    const db = new MessageDB(clientContext.dbPath)
    const client = createTelegramClient(clientContext.sessionPath)
    const results = []
    const warnings: Array<{
      code: 'download_status_update_failed'
      message: string
      chat_id: number
      msg_id: number
      attachment_index: number
    }> = []
    try {
      for (const attachment of attachments) {
        const [message] = db.getMessagesByKeys([{ chatId: attachment.chatId, msgId: attachment.msgId }])
        if (message == null) {
          throw new AttachmentLookupError(
            'attachment_not_found',
            `Message ${attachment.msgId} was not found`,
          )
        }
        const stored = selectStoredAttachment(message.attachments, attachment.attachmentIndex)
        const destination = resolveAttachmentDestination({
          homeDir: homedir(),
          fileName: webDownloadFileName(attachment, stored),
          exists: existsSync,
          reserved,
        })
        reserved.add(destination)
        mkdirSync(dirname(destination), { recursive: true })
        await client.downloadMessageMedia({
          chat: telegramPeerIdFromLocalChatId(attachment.chatId),
          msgId: attachment.msgId,
          attachment: toAttachmentLocator(stored),
          destination,
        })
        const marked = db.markAttachmentDownloaded({
          chatId: attachment.chatId,
          msgId: attachment.msgId,
          attachmentIndex: attachment.attachmentIndex,
          path: destination,
          downloadedAt: new Date().toISOString(),
        })
        if (!marked) {
          warnings.push({
            code: 'download_status_update_failed',
            message: `Downloaded media but could not update local status for message ${attachment.msgId} attachment ${attachment.attachmentIndex}.`,
            chat_id: attachment.chatId,
            msg_id: attachment.msgId,
            attachment_index: attachment.attachmentIndex,
          })
        }
        results.push({
          chat_id: attachment.chatId,
          msg_id: attachment.msgId,
          attachment_index: attachment.attachmentIndex,
          kind: stored.kind,
          file_name: stored.file_name,
          path: destination,
        })
      }
    } finally {
      db.close()
      await client.close()
    }
    return success({ downloaded: results, warnings })
  } catch (error) {
    const message = errorMessage(error)
    if (isDataResetRequiredError(error)) return failure(409, 'data_reset_required', message)
    if (error instanceof AttachmentLookupError) return failure(400, error.code, message)
    if (isKnownValidationMessage(message)) return failure(400, 'invalid_request', message)
    return failure(500, 'download_failed', message)
  }
}

function parseDownloadAttachment(value: unknown): { chatId: number; msgId: number; attachmentIndex: number } {
  if (!isRecord(value)) throw invalidRequest('Each attachment must be a JSON object.')
  if (!isSafeNonZeroInteger(value.chat_id)) throw invalidRequest('attachment.chat_id must be a non-zero integer.')
  if (!isSafePositiveInteger(value.msg_id)) throw invalidRequest('attachment.msg_id must be a positive integer.')
  if (!isSafePositiveInteger(value.attachment_index)) {
    throw invalidRequest('attachment.attachment_index must be a positive integer.')
  }
  return { chatId: value.chat_id, msgId: value.msg_id, attachmentIndex: value.attachment_index }
}

function webDownloadFileName(
  target: { chatId: number; msgId: number; attachmentIndex: number },
  attachment: { file_name: string | null; mime_type: string | null; kind: string },
): string {
  const raw = attachment.file_name?.trim()
  if (raw) return raw
  return `${target.chatId}-${target.msgId}-${target.attachmentIndex}.${webDownloadExtension(attachment)}`
}

function webDownloadExtension(attachment: { mime_type: string | null; kind: string }): string {
  const mimeExtension = attachment.mime_type == null
    ? undefined
    : WEB_DOWNLOAD_MIME_EXTENSIONS[attachment.mime_type.toLowerCase()]
  if (mimeExtension != null) return mimeExtension
  return WEB_DOWNLOAD_KIND_EXTENSIONS[attachment.kind] ?? 'bin'
}

const WEB_DOWNLOAD_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
}

const WEB_DOWNLOAD_KIND_EXTENSIONS: Record<string, string> = {
  photo: 'jpg',
  video: 'mp4',
  audio: 'mp3',
  voice: 'ogg',
  sticker: 'webp',
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get('content-type')?.toLowerCase().includes('application/json') ?? false
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isSafeNonZeroInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0
}

function isAccountErrorCode(code: string): boolean {
  return code === 'account_required'
    || code === 'account_not_found'
    || code === 'account_logged_out'
    || code === 'account_session_missing'
}

function stringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value == null || value.trim() === '' ? undefined : value
}

function requiredNonZeroIntParam(url: URL, name: string): number {
  const value = parseInteger(url.searchParams.get(name))
  if (value == null || value === 0) throw invalidRequest(`${name} must be a non-zero integer.`)
  return value
}

function optionalPositiveIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw == null || raw.trim() === '') return undefined
  const value = parseInteger(raw)
  if (value == null || value <= 0) throw invalidRequest(`${name} must be a positive integer.`)
  return value
}

function optionalNonNegativeIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw == null || raw.trim() === '') return undefined
  const value = parseInteger(raw)
  if (value == null || value < 0) throw invalidRequest(`${name} must be a non-negative integer.`)
  return value
}

function optionalIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw == null || raw.trim() === '') return undefined
  const value = parseInteger(raw)
  if (value == null) throw invalidRequest(`${name} must be an integer.`)
  return value
}

function parseInteger(raw: string | null): number | undefined {
  if (raw == null) return undefined
  const value = raw.trim()
  if (!/^-?\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function invalidRequest(message: string): ApiError {
  return { status: 400, code: 'invalid_request', message }
}

function errorResponse(error: unknown): Response {
  if (isDataResetRequiredError(error)) {
    return failure(409, 'data_reset_required', 'Run `tg data reset --yes` before using this version.', {
      path: error.path,
      expected: MESSAGE_DB_SCHEMA_VERSION,
      actual: error.actualVersion,
    })
  }

  if (isApiError(error)) return failure(error.status, error.code, error.message)

  const message = errorMessage(error)
  if (isKnownValidationMessage(message)) return failure(400, 'invalid_request', message)

  return failure(500, 'internal_error', 'Internal web API error.')
}

function isApiError(error: unknown): error is ApiError {
  return typeof error === 'object'
    && error !== null
    && (error as { status?: unknown }).status === 400
    && (error as { code?: unknown }).code === 'invalid_request'
    && typeof (error as { message?: unknown }).message === 'string'
}

function isKnownValidationMessage(message: string): boolean {
  return message === 'invalid_cursor'
    || message.includes('must be a positive integer')
    || message.startsWith('account_required:')
    || message.startsWith('account_not_found:')
    || message.startsWith('account_logged_out:')
    || message.startsWith('account_session_missing:')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
