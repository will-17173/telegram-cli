import { GROUP_COMMANDS } from './catalog.js'
import { tokenizeGroupCommand, type GroupCommandToken } from './tokenize.js'
import type { GroupCommandDefinition, GroupCommandValueKind } from './types.js'

export interface ParsedGroupCommandRequest {
  readonly definition: GroupCommandDefinition
  readonly path: readonly [string, string]
  readonly values: Readonly<Record<string, unknown>>
  readonly source: string
}

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
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd']
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
    if (raw === undefined || raw === '' || (equals < 0 && raw.startsWith('--'))) {
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
    const rawValues = argument.rest ? available.map(token => token.value) : [available[0].value]
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
    const raw = argument.rest ? rawValues.join(' ') : rawValues[0]
    const parsed = parseValue(argument.kind, raw)
    if (!parsed.ok) return failure(parsed.code, parsed.message, definition)
    values[valueName(argument.name, argument.kind)] = parsed.value
  }
  if (position < positional.length) return failure('unexpected_argument', `Unexpected argument: ${positional[position].value}`, definition)

  for (const option of definition.options) {
    const raw = optionValues.get(option.name)
    if (raw === undefined) {
      if (option.required) return failure('missing_option', `Missing option: ${option.long}`, definition)
      continue
    }
    const parsed = parseValue(option.kind, raw)
    if (!parsed.ok) return failure(parsed.code, parsed.message, definition)
    values[valueName(option.name, option.kind)] = parsed.value
  }

  return { ok: true, request: { definition, path: definition.path, values, source } }
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
  return GROUP_COMMANDS.map((definition, catalogIndex) => {
    const path = definition.path.join(' ')
    const joinedQuery = query.join(' ')
    const exactParts = query.every((part, index) => definition.path[index]?.startsWith(part))
    const fuzzyParts = query.every((part, index) => isSubsequence(part, definition.path[index] ?? ''))
    const summaryMatch = joinedQuery.length > 0 && isSubsequence(joinedQuery.replace(/\s/g, ''), definition.summary.toLowerCase().replace(/\s/g, ''))
    if (!exactParts && !fuzzyParts && !summaryMatch) return undefined
    return { definition, score: exactParts ? 3000 - path.length : fuzzyParts ? 2000 - path.length : 1000 - catalogIndex }
  }).filter((match): match is GroupCommandMatch => Boolean(match)).sort((left, right) => right.score - left.score)
}

export function completeGroupCommand(source: string, selectedIndex = 0): string {
  const tokenized = commandTokens(source)
  if (!tokenized.ok) return source
  const matches = matchGroupCommands(source)
  const match = matches[selectedIndex]
  if (!match) return source
  const tokens = tokenized.tokens
  if (tokens.length >= 2 && tokens[0].value === match.definition.path[0] && tokens[1].value === match.definition.path[1]) return source
  const slash = source.trimStart().startsWith('/') ? '/' : ''
  const command = `${slash}${match.definition.path.join(' ')}`
  if (tokens.length <= 2) return `${command} `
  const remainder = source.slice(tokens[2].start)
  return `${command} ${remainder}`
}
