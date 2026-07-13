import { GROUP_COMMAND_CATALOG, GROUP_COMMANDS, type GroupCommandKey } from './catalog.js'
import { tokenizeGroupCommand, type GroupCommandToken } from './tokenize.js'
import type { GroupCommandDefinition, GroupCommandValueKind } from './types.js'

type User = string | number
export interface GroupCommandValuesByKey {
  'member add': { readonly users: readonly User[] }; 'member kick': { readonly user: User }; 'member ban': { readonly user: User }; 'member unban': { readonly user: User }; 'member mute': { readonly user: User; readonly durationSeconds?: number | null }; 'member unmute': { readonly user: User }; 'member purge': { readonly user: User }
  'admin promote': { readonly user: User; readonly permissions?: readonly string[] }; 'admin demote': { readonly user: User }; 'admin rank': { readonly user: User; readonly text: string }; 'admin transfer-owner': { readonly user: User }
  'chat title': { readonly text: string }; 'chat description': { readonly text: string }; 'chat username': { readonly username: string }; 'chat photo': { readonly path: string }; 'chat slowmode': { readonly durationSeconds: number | null }; 'chat ttl': { readonly durationSeconds: number | null }; 'chat protect': { readonly enabled: boolean }; 'chat join-requests': { readonly enabled: boolean }; 'chat join-to-send': { readonly enabled: boolean }; 'chat default-permissions': { readonly permissions: readonly string[] }; 'chat sticker-set': { readonly sticker: string }; 'chat leave': Record<never, never>; 'chat delete': Record<never, never>
  'invite list': Record<never, never>; 'invite show': { readonly invite: string }; 'invite create': { readonly title?: string; readonly expireSeconds?: number | null; readonly limit?: number; readonly requestNeeded?: boolean }; 'invite edit': { readonly invite: string; readonly title?: string; readonly expireSeconds?: number | null; readonly limit?: number; readonly requestNeeded?: boolean }; 'invite revoke': { readonly invite: string }; 'invite members': { readonly invite: string }; 'invite approve': { readonly user: User }; 'invite decline': { readonly user: User }; 'invite approve-all': Record<never, never>; 'invite decline-all': Record<never, never>
  'topic list': Record<never, never>; 'topic create': { readonly title: string }; 'topic edit': { readonly id: number; readonly title: string }; 'topic close': { readonly id: number }; 'topic reopen': { readonly id: number }; 'topic pin': { readonly id: number }; 'topic unpin': { readonly id: number }; 'topic reorder': { readonly ids: readonly number[] }; 'topic delete': { readonly id: number }; 'topic general-hidden': { readonly hidden: boolean }
  'message pin': { readonly id: number }; 'message unpin': { readonly id: number }; 'message unpin-all': Record<never, never>; 'message delete': { readonly ids: readonly number[] }
}
type AssertAllValues<T extends Record<GroupCommandKey, object>> = T
type AllValuesCovered = AssertAllValues<GroupCommandValuesByKey>

export type RequestFor<K extends GroupCommandKey> = {
  readonly key: K
  readonly definition: typeof GROUP_COMMAND_CATALOG[K]
  readonly path: typeof GROUP_COMMAND_CATALOG[K]['path']
  readonly values: GroupCommandValuesByKey[K]
  readonly source: string
}
export type ParsedGroupCommandRequest = { [K in GroupCommandKey]: RequestFor<K> }[GroupCommandKey]

export type ParseGroupCommandResult =
  | { readonly ok: true; readonly request: ParsedGroupCommandRequest }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly usage?: string } }

export interface GroupCommandMatch {
  readonly definition: GroupCommandDefinition
  readonly score: number
}

function failure(code: string, message: string, definition?: GroupCommandDefinition): ParseGroupCommandResult {
  return { ok: false, error: { code, message, ...(definition ? { usage: definition.usage } : {}) } }
}

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())
}

function valueName(name: string, kind: GroupCommandValueKind): string {
  return kind === 'duration' ? `${camelCase(name)}Seconds` : camelCase(name)
}

function parseValue(kind: GroupCommandValueKind, value: string): { ok: true; value: unknown } | { ok: false; code: string; message: string } {
  if (kind === 'duration') {
    if (value === 'off') return { ok: true, value: null }
    const match = /^(\d+)([smhd])$/.exec(value)
    if (!match) return { ok: false, code: 'invalid_duration', message: `Invalid duration: ${value}` }
    const multiplier = match[2] === 's' ? 1 : match[2] === 'm' ? 60 : match[2] === 'h' ? 3600 : 86400
    const duration = Number(match[1]) * multiplier
    if (!Number.isSafeInteger(duration)) return { ok: false, code: 'invalid_duration', message: `Duration is too large: ${value}` }
    return { ok: true, value: duration }
  }
  if (kind === 'toggle') {
    if (value === 'on') return { ok: true, value: true }
    if (value === 'off') return { ok: true, value: false }
    return { ok: false, code: 'invalid_toggle', message: `Expected on or off, received: ${value}` }
  }
  if (kind === 'user') {
    if (/^@[A-Za-z0-9_]+$/.test(value)) return { ok: true, value }
    if (/^-?\d+$/.test(value)) {
      const numeric = Number(value)
      return { ok: true, value: Number.isSafeInteger(numeric) ? numeric : value }
    }
    return { ok: false, code: 'invalid_user', message: `Invalid user: ${value}` }
  }
  if (kind === 'id') {
    const numeric = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(numeric) || numeric <= 0) {
      return { ok: false, code: 'invalid_id', message: `Expected a positive safe integer, received: ${value}` }
    }
    return { ok: true, value: numeric }
  }
  if (kind === 'permissions') {
    const permissions = value.split(',')
    if (permissions.some(permission => permission.length === 0)) {
      return { ok: false, code: 'invalid_permissions', message: 'Permissions must be a comma-separated non-empty list' }
    }
    return { ok: true, value: [...new Set(permissions)] }
  }
  if (value.length === 0) return { ok: false, code: `invalid_${kind}`, message: `${kind} cannot be empty` }
  return { ok: true, value }
}

function commandTokens(source: string): { ok: true; tokens: GroupCommandToken[] } | { ok: false; result: ParseGroupCommandResult } {
  const tokenized = tokenizeGroupCommand(source)
  if (!tokenized.ok) return { ok: false, result: failure(tokenized.error.code, tokenized.error.message) }
  const tokens = [...tokenized.tokens]
  if (tokens[0]?.value.startsWith('/')) tokens[0] = { ...tokens[0], value: tokens[0].value.slice(1) }
  return { ok: true, tokens }
}

export function parseGroupCommand(source: string): ParseGroupCommandResult {
  const tokenized = commandTokens(source)
  if (!tokenized.ok) return tokenized.result
  const [first, second, ...input] = tokenized.tokens
  if (!first || !second) return failure('missing_command', 'Expected a two-part group command')
  const definition = GROUP_COMMANDS.find(command => command.path[0] === first.value && command.path[1] === second.value)
  if (!definition) return failure('unknown_command', `Unknown group command: ${first.value} ${second.value}`)

  const positional: GroupCommandToken[] = []
  const optionValues = new Map<string, string>()
  for (let index = 0; index < input.length; index++) {
    const token = input[index]
    if (!token.value.startsWith('--')) {
      positional.push(token)
      continue
    }
    const equals = token.value.indexOf('=')
    const long = equals < 0 ? token.value : token.value.slice(0, equals)
    const option = definition.options.find(candidate => candidate.long === long)
    if (!option) return failure('unknown_option', `Unknown option: ${long}`, definition)
    if (optionValues.has(option.name)) return failure('duplicate_option', `Duplicate option: ${long}`, definition)
    const raw = equals < 0 ? input[++index]?.value : token.value.slice(equals + 1)
    if (raw === undefined || (equals < 0 && raw.startsWith('--'))) {
      return failure('missing_option_value', `Missing value for option: ${long}`, definition)
    }
    optionValues.set(option.name, raw)
  }

  const values: Record<string, unknown> = {}
  let position = 0
  for (const argument of definition.args) {
    const available = positional.slice(position)
    if (available.length === 0) {
      if (argument.required) return failure('missing_argument', `Missing argument: ${argument.name}`, definition)
      continue
    }
    const isRest = 'rest' in argument && argument.rest
    const rawValues = isRest ? available.map(token => token.value) : [available[0].value]
    position += rawValues.length
    if (argument.kind === 'users' || argument.kind === 'ids') {
      const singularKind = argument.kind === 'users' ? 'user' : 'id'
      const parsedValues: unknown[] = []
      for (const raw of rawValues) {
        const parsed = parseValue(singularKind, raw)
        if (!parsed.ok) return failure(parsed.code, parsed.message, definition)
        parsedValues.push(parsed.value)
      }
      values[camelCase(argument.name)] = parsedValues
      continue
    }
    const raw = isRest ? rawValues.join(' ') : rawValues[0]
    const parsed = parseValue(argument.kind, raw)
    if (!parsed.ok) return failure(parsed.code, parsed.message, definition)
    values[valueName(argument.name, argument.kind)] = parsed.value
  }
  if (position < positional.length) return failure('unexpected_argument', `Unexpected argument: ${positional[position].value}`, definition)

  for (const option of definition.options) {
    const raw = optionValues.get(option.name)
    if (raw === undefined) {
      if ('required' in option && option.required) return failure('missing_option', `Missing option: ${option.long}`, definition)
      continue
    }
    const parsed = parseValue(option.kind, raw)
    if (!parsed.ok) return failure(parsed.code, parsed.message, definition)
    values[valueName(option.name, option.kind)] = parsed.value
  }

  const request = createParsedRequest(definition.path.join(' '), values, source)
  return request ? { ok: true, request } : failure('invalid_command', 'Parsed command values did not match the catalog.', definition)
}

function makeRequest<K extends GroupCommandKey>(key: K, values: GroupCommandValuesByKey[K], source: string): RequestFor<K> {
  const definition = GROUP_COMMAND_CATALOG[key]
  return { key, definition, path: definition.path, values, source }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function has<T, N extends string>(value: unknown, name: N, guard: (item: unknown) => item is T): value is Record<N, T> { return isRecord(value) && guard(value[name]) }
const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isUser = (value: unknown): value is User => isString(value) || isNumber(value)
const isUsers = (value: unknown): value is readonly User[] => Array.isArray(value) && value.every(isUser)
const isNumbers = (value: unknown): value is readonly number[] => Array.isArray(value) && value.every(isNumber)
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isString)
const isDuration = (value: unknown): value is number | null => value === null || isNumber(value)
function empty(value: unknown): value is Record<never, never> { return isRecord(value) && Object.keys(value).length === 0 }
function userValue(value: unknown): value is { readonly user: User } { return has(value, 'user', isUser) }
function idValue(value: unknown): value is { readonly id: number } { return has(value, 'id', isNumber) }
function stringValue<N extends string>(value: unknown, name: N): value is Record<N, string> { return has(value, name, isString) }
function inviteOptions(value: unknown): value is GroupCommandValuesByKey['invite create'] {
  if (!isRecord(value)) return false
  return (value.title === undefined || isString(value.title)) && (value.expireSeconds === undefined || isDuration(value.expireSeconds)) && (value.limit === undefined || isNumber(value.limit)) && (value.requestNeeded === undefined || isBoolean(value.requestNeeded))
}
function muteValue(value: unknown): value is GroupCommandValuesByKey['member mute'] { return isRecord(value) && isUser(value.user) && (value.durationSeconds === undefined || isDuration(value.durationSeconds)) }
function promoteValue(value: unknown): value is GroupCommandValuesByKey['admin promote'] { return isRecord(value) && isUser(value.user) && (value.permissions === undefined || isStrings(value.permissions)) }

function createParsedRequest(key: string, values: unknown, source: string): ParsedGroupCommandRequest | undefined {
  switch (key) {
    case 'member add': return has(values, 'users', isUsers) ? makeRequest(key, values, source) : undefined
    case 'member kick': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'member ban': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'member unban': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'member unmute': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'member purge': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'member mute': return muteValue(values) ? makeRequest(key, values, source) : undefined
    case 'admin promote': return promoteValue(values) ? makeRequest(key, values, source) : undefined
    case 'admin demote': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'admin transfer-owner': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'invite approve': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'invite decline': return userValue(values) ? makeRequest(key, values, source) : undefined
    case 'admin rank': return userValue(values) && has(values, 'text', isString) ? makeRequest(key, values, source) : undefined
    case 'chat title': return stringValue(values, 'text') ? makeRequest(key, values, source) : undefined
    case 'chat description': return stringValue(values, 'text') ? makeRequest(key, values, source) : undefined
    case 'chat username': return stringValue(values, 'username') ? makeRequest(key, values, source) : undefined
    case 'chat photo': return stringValue(values, 'path') ? makeRequest(key, values, source) : undefined
    case 'chat slowmode': return has(values, 'durationSeconds', isDuration) ? makeRequest(key, values, source) : undefined
    case 'chat ttl': return has(values, 'durationSeconds', isDuration) ? makeRequest(key, values, source) : undefined
    case 'chat protect': return has(values, 'enabled', isBoolean) ? makeRequest(key, values, source) : undefined
    case 'chat join-requests': return has(values, 'enabled', isBoolean) ? makeRequest(key, values, source) : undefined
    case 'chat join-to-send': return has(values, 'enabled', isBoolean) ? makeRequest(key, values, source) : undefined
    case 'chat default-permissions': return has(values, 'permissions', isStrings) ? makeRequest(key, values, source) : undefined
    case 'chat sticker-set': return has(values, 'sticker', isString) ? makeRequest(key, values, source) : undefined
    case 'chat leave': return empty(values) ? makeRequest(key, values, source) : undefined
    case 'chat delete': return empty(values) ? makeRequest(key, values, source) : undefined
    case 'invite list': return empty(values) ? makeRequest(key, values, source) : undefined
    case 'invite approve-all': return empty(values) ? makeRequest(key, values, source) : undefined
    case 'invite decline-all': return empty(values) ? makeRequest(key, values, source) : undefined
    case 'topic list': return empty(values) ? makeRequest(key, values, source) : undefined
    case 'message unpin-all': return empty(values) ? makeRequest(key, values, source) : undefined
    case 'invite show': return stringValue(values, 'invite') ? makeRequest(key, values, source) : undefined
    case 'invite revoke': return stringValue(values, 'invite') ? makeRequest(key, values, source) : undefined
    case 'invite members': return stringValue(values, 'invite') ? makeRequest(key, values, source) : undefined
    case 'invite create': return inviteOptions(values) ? makeRequest(key, values, source) : undefined
    case 'invite edit': return stringValue(values, 'invite') && inviteOptions(values) ? makeRequest(key, values, source) : undefined
    case 'topic create': return stringValue(values, 'title') ? makeRequest(key, values, source) : undefined
    case 'topic edit': return idValue(values) && has(values, 'title', isString) ? makeRequest(key, values, source) : undefined
    case 'topic close': return idValue(values) ? makeRequest(key, values, source) : undefined
    case 'topic reopen': return idValue(values) ? makeRequest(key, values, source) : undefined
    case 'topic pin': return idValue(values) ? makeRequest(key, values, source) : undefined
    case 'topic unpin': return idValue(values) ? makeRequest(key, values, source) : undefined
    case 'topic delete': return idValue(values) ? makeRequest(key, values, source) : undefined
    case 'message pin': return idValue(values) ? makeRequest(key, values, source) : undefined
    case 'message unpin': return idValue(values) ? makeRequest(key, values, source) : undefined
    case 'topic reorder': return has(values, 'ids', isNumbers) ? makeRequest(key, values, source) : undefined
    case 'message delete': return has(values, 'ids', isNumbers) ? makeRequest(key, values, source) : undefined
    case 'topic general-hidden': return has(values, 'hidden', isBoolean) ? makeRequest(key, values, source) : undefined
  }
}

function isSubsequence(query: string, target: string): boolean {
  let index = 0
  for (const character of target) if (character === query[index]) index++
  return index === query.length
}

export function matchGroupCommands(source: string): readonly GroupCommandMatch[] {
  const tokenized = commandTokens(source)
  if (!tokenized.ok) return []
  const query = tokenized.tokens.slice(0, 2).map(token => token.value.toLowerCase())
  const matches: Array<GroupCommandMatch & { catalogIndex: number }> = []
  GROUP_COMMANDS.forEach((definition, catalogIndex) => {
    const joinedQuery = query.join(' ')
    const exactParts = query.every((part, index) => definition.path[index]?.startsWith(part))
    const fuzzyParts = query.every((part, index) => isSubsequence(part, definition.path[index] ?? ''))
    const summaryMatch = joinedQuery.length > 0 && isSubsequence(joinedQuery.replace(/\s/g, ''), definition.summary.toLowerCase().replace(/\s/g, ''))
    if (!exactParts && !fuzzyParts && !summaryMatch) return
    matches.push({ definition, score: exactParts ? 3 : fuzzyParts ? 2 : 1, catalogIndex })
  })
  return matches
    .sort((left, right) => right.score - left.score || left.catalogIndex - right.catalogIndex)
    .map(({ definition, score }) => ({ definition, score }))
}

export function completeGroupCommand(source: string, selectedIndex = 0): string {
  const tokenized = commandTokens(source)
  if (!tokenized.ok) return source
  const matches = matchGroupCommands(source)
  const match = matches[selectedIndex]
  if (!match) return source
  const tokens = tokenized.tokens
  if (tokens.length >= 2 && tokens[0].value === match.definition.path[0] && tokens[1].value === match.definition.path[1]) return source
  const leadingWhitespace = source.slice(0, tokens[0]?.start ?? 0)
  const slash = source.trimStart().startsWith('/') ? '/' : ''
  const command = `${leadingWhitespace}${slash}${match.definition.path.join(' ')}`
  if (tokens.length <= 2) return `${command} `
  const remainder = source.slice(tokens[2].start)
  return `${command} ${remainder}`
}
