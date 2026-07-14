import { getDataDir } from '../config/env.js'
import { validateLocalRequest } from './security.js'
import { SyncTaskRunner } from './sync-task.js'
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
          chatId: requiredPositiveIntParam(url, 'chatId'),
          q: stringParam(url, 'q'),
          since: stringParam(url, 'since'),
          until: stringParam(url, 'until'),
          limit: optionalPositiveIntParam(url, 'limit') ?? 50,
          cursor: stringParam(url, 'cursor'),
        }))
      case '/api/sync-task':
        if (request.method !== 'GET') return notFound()
        return success(context.syncTask.getState())
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

function stringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value == null || value.trim() === '' ? undefined : value
}

function requiredPositiveIntParam(url: URL, name: string): number {
  const value = parseInteger(url.searchParams.get(name))
  if (value == null || value <= 0) throw invalidRequest(`${name} must be a positive integer.`)
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

function parseInteger(raw: string | null): number | undefined {
  if (raw == null) return undefined
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function invalidRequest(message: string): ApiError {
  return { status: 400, code: 'invalid_request', message }
}

function errorResponse(error: unknown): Response {
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
