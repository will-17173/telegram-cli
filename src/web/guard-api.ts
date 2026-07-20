import { join } from 'node:path'
import { resolveAuthenticatedAccountContext } from '../account/account-context.js'
import { evaluateGuardRules } from '../guard/rule-engine.js'
import { parseGuardActions, parseGuardConditions } from '../guard/schema.js'
import type { GuardGroupPolicy } from '../guard/types.js'
import type { GuardRuntimeStatus } from '../storage/guard-db.js'
import { GuardDB } from '../storage/guard-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import type { ApiContext } from './api.js'
import type { ApiFailure, ApiSuccess } from './types.js'

type ApiError = {
  status: number
  code: string
  message: string
}

type GuardValidationCode = 'invalid_rule_condition' | 'invalid_rule_action'

const RUNTIME_STATUSES = new Set<GuardRuntimeStatus>(['stopped', 'starting', 'running', 'paused', 'error'])
const GUARD_DISCOVERY_GROUP_LIMIT = 500

export async function handleGuardApiRequest(request: Request, context: ApiContext & { dataDir: string }): Promise<Response> {
  const url = new URL(request.url)
  const db = new GuardDB(join(context.dataDir, 'guard.db'))

  try {
    if (url.pathname === '/api/guard/status') {
      if (request.method !== 'GET') return notFound()
      await discoverManagedGroups(db, context)
      return success({
        runtime: db.getRuntimeState(),
        groups: { items: db.listManagedGroups() },
      })
    }

    if (url.pathname === '/api/guard/groups') {
      if (request.method === 'GET') {
        await discoverManagedGroups(db, context)
        return success({ items: db.listManagedGroups() })
      }
      if (request.method === 'POST') return await createGroup(request, db)
      return notFound()
    }

    const groupId = pathId(url.pathname, '/api/guard/groups/')
    if (groupId != null) {
      if (!groupId.ok) return invalidPathId('group id')
      if (request.method === 'PATCH') return await updateGroup(request, db, groupId.id)
      return notFound()
    }

    if (url.pathname === '/api/guard/rules') {
      if (request.method === 'GET') return listRules(url, db)
      if (request.method === 'POST') return await createRule(request, db)
      return notFound()
    }

    if (url.pathname === '/api/guard/rules/test') {
      if (request.method !== 'POST') return notFound()
      return await testRules(request, db)
    }

    const ruleId = pathId(url.pathname, '/api/guard/rules/')
    if (ruleId != null) {
      if (!ruleId.ok) return invalidPathId('rule id')
      if (request.method === 'PATCH') return await updateRule(request, db, ruleId.id)
      if (request.method === 'DELETE') return deleteRule(db, ruleId.id)
      return notFound()
    }

    if (url.pathname === '/api/guard/activity') {
      if (request.method !== 'GET') return notFound()
      return listActivity(url, db)
    }

    return notFound()
  } catch (error) {
    return errorResponse(error)
  } finally {
    db.close()
  }
}

async function discoverManagedGroups(db: GuardDB, context: ApiContext & { dataDir: string }): Promise<void> {
  let accountContext: ReturnType<typeof resolveAuthenticatedAccountContext>
  try {
    accountContext = resolveAuthenticatedAccountContext({ dataDir: context.dataDir })
  } catch {
    return
  }

  const client = await (context.createTelegramClient ?? createTelegramClient)(accountContext.sessionPath)
  try {
    const existingByChat = new Map(
      db.listManagedGroups()
        .filter((group) => group.account === accountContext.name)
        .map((group) => [group.chat_id, group]),
    )
    const groups = await client.dialogs.listGroups({
      adminOnly: true,
      limit: GUARD_DISCOVERY_GROUP_LIMIT,
    })

    for (const group of groups) {
      const existing = existingByChat.get(group.id)
      db.upsertManagedGroup({
        account: accountContext.name,
        chat_id: group.id,
        title: group.name,
        enabled: existing?.enabled ?? false,
        policy: existing?.policy ?? db.defaultPolicy(),
      })
    }
  } finally {
    await closeClient(client)
  }
}

async function closeClient(client: TelegramClientAdapter): Promise<void> {
  await client.close()
}

async function createGroup(request: Request, db: GuardDB): Promise<Response> {
  const body = await jsonObjectRequest(request)
  return success(db.upsertManagedGroup({
    account: requiredString(body, 'account'),
    chat_id: requiredSafeInteger(body, 'chat_id'),
    title: optionalNullableString(body, 'title'),
    enabled: requiredBoolean(body, 'enabled'),
    policy: policyFromBody(body.policy, db.defaultPolicy()),
  }))
}

async function updateGroup(request: Request, db: GuardDB, id: number): Promise<Response> {
  const body = await jsonObjectRequest(request)
  const existing = db.managedGroupById(id)
  if (existing == null) return failure(404, 'not_found', 'Guard group not found.')

  const update = {
    ...(hasOwn(body, 'title') ? { title: optionalNullableString(body, 'title') } : {}),
    ...(hasOwn(body, 'enabled') ? { enabled: requiredBoolean(body, 'enabled') } : {}),
    ...(hasOwn(body, 'runtime_status') ? { runtime_status: requiredRuntimeStatus(body, 'runtime_status') } : {}),
    ...(hasOwn(body, 'policy') ? { policy: policyFromBody(body.policy, existing.policy) } : {}),
  }
  const updated = db.updateManagedGroup(id, update)
  return updated == null ? failure(404, 'not_found', 'Guard group not found.') : success(updated)
}

function listRules(url: URL, db: GuardDB): Response {
  return success({ items: db.listRules(requiredPositiveIntParam(url, 'group_id')) })
}

async function createRule(request: Request, db: GuardDB): Promise<Response> {
  const body = await jsonObjectRequest(request)
  const conditions = parseConditions(body.conditions)
  const actions = parseActions(body.actions)

  return success(db.createRule({
    group_id: requiredPositiveInteger(body, 'group_id'),
    name: requiredString(body, 'name'),
    enabled: requiredBoolean(body, 'enabled'),
    priority: requiredSafeInteger(body, 'priority'),
    conditions,
    actions,
  }))
}

async function updateRule(request: Request, db: GuardDB, id: number): Promise<Response> {
  const body = await jsonObjectRequest(request)
  const update = {
    ...(hasOwn(body, 'name') ? { name: requiredString(body, 'name') } : {}),
    ...(hasOwn(body, 'enabled') ? { enabled: requiredBoolean(body, 'enabled') } : {}),
    ...(hasOwn(body, 'priority') ? { priority: requiredSafeInteger(body, 'priority') } : {}),
    ...(hasOwn(body, 'conditions') ? { conditions: parseConditions(body.conditions) } : {}),
    ...(hasOwn(body, 'actions') ? { actions: parseActions(body.actions) } : {}),
  }
  const updated = db.updateRule(id, update)
  return updated == null ? failure(404, 'not_found', 'Guard rule not found.') : success(updated)
}

function deleteRule(db: GuardDB, id: number): Response {
  if (!db.deleteRule(id)) return failure(404, 'not_found', 'Guard rule not found.')
  return success({ deleted: true })
}

async function testRules(request: Request, db: GuardDB): Promise<Response> {
  const body = await jsonObjectRequest(request)
  const groupId = requiredPositiveInteger(body, 'group_id')
  const text = requiredString(body, 'text')
  const warningCount = optionalNonNegativeBodyInteger(body, 'warning_count') ?? 0
  const group = db.managedGroupById(groupId)
  if (group == null) return failure(404, 'not_found', 'Guard group not found.')

  const matches = evaluateGuardRules({
    rules: db.listRules(groupId),
    event: {
      type: 'message_created',
      account: group.account,
      group_id: group.id,
      chat_id: group.chat_id,
      chat_title: group.title,
      message_id: null,
      user: null,
      text,
      created_at: new Date().toISOString(),
      member_joined_at: null,
      current_account_user_id: null,
    },
    context: {
      warning_count: warningCount,
      recent_messages: [],
    },
  })

  return success({ matched_rule_ids: matches.map((match) => match.rule.id) })
}

function listActivity(url: URL, db: GuardDB): Response {
  return success(db.listActivity({
    group_id: optionalPositiveIntParam(url, 'group_id'),
    limit: optionalPositiveIntParam(url, 'limit'),
  }))
}

function parseConditions(input: unknown) {
  const parsed = parseGuardConditions(input)
  if (!parsed.ok) throw validationError(parsed.error.code, parsed.error.message)
  return parsed.value
}

function parseActions(input: unknown) {
  const parsed = parseGuardActions(input)
  if (!parsed.ok) throw validationError(parsed.error.code, parsed.error.message)
  return parsed.value
}

async function jsonObjectRequest(request: Request): Promise<Record<string, unknown>> {
  if (!isJsonRequest(request)) throw invalidRequest('Content-Type must include application/json.')
  const body = await parseJsonBody(request)
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.')
  return body
}

function policyFromBody(input: unknown, fallback: GuardGroupPolicy): GuardGroupPolicy {
  if (input == null) return fallback
  if (!isRecord(input)) throw invalidRequest('policy must be a JSON object.')
  return {
    allow_delete: optionalBoolean(input, 'allow_delete') ?? fallback.allow_delete,
    allow_mute: optionalBoolean(input, 'allow_mute') ?? fallback.allow_mute,
    allow_ban: optionalBoolean(input, 'allow_ban') ?? fallback.allow_ban,
    ignore_admins: optionalBoolean(input, 'ignore_admins') ?? fallback.ignore_admins,
    ignore_bots: optionalBoolean(input, 'ignore_bots') ?? fallback.ignore_bots,
    reply_cooldown_seconds: optionalNonNegativeInteger(input, 'reply_cooldown_seconds') ?? fallback.reply_cooldown_seconds,
    action_cooldown_seconds: optionalNonNegativeInteger(input, 'action_cooldown_seconds') ?? fallback.action_cooldown_seconds,
  }
}

function pathId(pathname: string, prefix: string): { ok: true; id: number } | { ok: false } | undefined {
  if (!pathname.startsWith(prefix)) return undefined
  const raw = pathname.slice(prefix.length)
  if (!/^\d+$/.test(raw)) return { ok: false }
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? { ok: true, id } : { ok: false }
}

function requiredPositiveIntParam(url: URL, name: string): number {
  const value = optionalPositiveIntParam(url, name)
  if (value == null) throw invalidRequest(`${name} must be a positive integer.`)
  return value
}

function optionalPositiveIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw == null || raw.trim() === '') return undefined
  const value = parseInteger(raw)
  if (value == null || value <= 0) throw invalidRequest(`${name} must be a positive integer.`)
  return value
}

function parseInteger(raw: string): number | undefined {
  if (!/^-?\d+$/.test(raw.trim())) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest(`${name} must be a non-empty string.`)
  }
  return value.trim()
}

function optionalNullableString(body: Record<string, unknown>, name: string): string | null | undefined {
  if (!hasOwn(body, name)) return undefined
  const value = body[name]
  if (value == null) return null
  if (typeof value !== 'string') throw invalidRequest(`${name} must be a string or null.`)
  return value.trim() === '' ? null : value.trim()
}

function requiredBoolean(body: Record<string, unknown>, name: string): boolean {
  const value = body[name]
  if (typeof value !== 'boolean') throw invalidRequest(`${name} must be a boolean.`)
  return value
}

function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  if (!hasOwn(body, name)) return undefined
  const value = body[name]
  if (typeof value !== 'boolean') throw invalidRequest(`policy.${name} must be a boolean.`)
  return value
}

function requiredRuntimeStatus(body: Record<string, unknown>, name: string): GuardRuntimeStatus {
  const value = body[name]
  if (typeof value !== 'string' || !RUNTIME_STATUSES.has(value as GuardRuntimeStatus)) {
    throw invalidRequest(`${name} must be a valid runtime status.`)
  }
  return value as GuardRuntimeStatus
}

function requiredSafeInteger(body: Record<string, unknown>, name: string): number {
  const value = body[name]
  if (!isSafeInteger(value)) throw invalidRequest(`${name} must be an integer.`)
  return value
}

function requiredPositiveInteger(body: Record<string, unknown>, name: string): number {
  const value = requiredSafeInteger(body, name)
  if (value <= 0) throw invalidRequest(`${name} must be a positive integer.`)
  return value
}

function optionalNonNegativeInteger(body: Record<string, unknown>, name: string): number | undefined {
  if (!hasOwn(body, name)) return undefined
  const value = body[name]
  if (!isSafeInteger(value) || value < 0) throw invalidRequest(`policy.${name} must be a non-negative integer.`)
  return value
}

function optionalNonNegativeBodyInteger(body: Record<string, unknown>, name: string): number | undefined {
  if (!hasOwn(body, name)) return undefined
  const value = body[name]
  if (!isSafeInteger(value) || value < 0) throw invalidRequest(`${name} must be a non-negative integer.`)
  return value
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
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

function success<T>(data: T): Response {
  return jsonResponse(200, { ok: true, data })
}

function failure(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, error: { code, message } })
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

function invalidRequest(message: string): ApiError {
  return { status: 400, code: 'invalid_request', message }
}

function invalidPathId(label: string): Response {
  return failure(400, 'invalid_request', `${label} must be a positive integer.`)
}

function validationError(code: GuardValidationCode, message: string): ApiError {
  return { status: 400, code, message }
}

function errorResponse(error: unknown): Response {
  if (isApiError(error)) return failure(error.status, error.code, error.message)

  const message = error instanceof Error ? error.message : String(error)
  const validationCode = guardValidationCode(message)
  if (validationCode != null) return failure(400, validationCode, message)
  if (isKnownValidationMessage(message)) return failure(400, 'invalid_request', message)
  return failure(500, 'internal_error', 'Internal guard web API error.')
}

function guardValidationCode(message: string): GuardValidationCode | undefined {
  if (message.startsWith('condition ')) return 'invalid_rule_condition'
  if (message === 'conditions must be an array.') return 'invalid_rule_condition'
  if (message.startsWith('action ')) return 'invalid_rule_action'
  if (message === 'actions must be an array.') return 'invalid_rule_action'
  return undefined
}

function isKnownValidationMessage(message: string): boolean {
  return message.includes('FOREIGN KEY constraint failed')
    || message.includes('UNIQUE constraint failed')
    || message.includes('CHECK constraint failed')
}

function isApiError(error: unknown): error is ApiError {
  return typeof error === 'object'
    && error !== null
    && (error as { status?: unknown }).status === 400
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
