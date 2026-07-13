import { tokenizeGroupCommand, type GroupCommandToken } from '../group-commands/tokenize.js'
import { LISTEN_COMMANDS, type ListenCommandDefinition } from './catalog.js'

export const MAX_LISTEN_COMMAND_MATCHES = 6

export interface ListenCommandMatch {
  readonly definition: ListenCommandDefinition
  readonly score: number
}

interface ParsedQuery {
  readonly tokens: readonly GroupCommandToken[]
  readonly query: readonly string[]
  readonly argumentBoundary: boolean
}

function isSubsequence(query: string, target: string): boolean {
  let index = 0
  for (const character of target) if (character === query[index]) index++
  return index === query.length
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function score(definition: ListenCommandDefinition, query: readonly string[]): number {
  if (query.length === 0) return 1
  const normalizedQuery = query.map(normalize)
  if (normalizedQuery.some(part => part.length === 0)) return 0
  const path = definition.path.map(part => part.toLowerCase())
  const exact = query.length === path.length && query.every((part, index) => part === path[index])
  if (exact) return 3
  const prefix = query.length <= path.length && query.every((part, index) => path[index]?.startsWith(part))
  if (prefix) return 2

  const joinedQuery = normalizedQuery.join('')
  const fields = [
    path.join(''),
    definition.summary,
    ...definition.keywords,
    definition.keywords.join(''),
  ].map(normalize)
  const tokenwisePath = query.length <= path.length
    && normalizedQuery.every((part, index) => isSubsequence(part, normalize(path[index] ?? '')))
  return tokenwisePath || fields.some(field => isSubsequence(joinedQuery, field)) ? 1 : 0
}

function rawTokens(input: string): readonly GroupCommandToken[] | undefined {
  const tokenized = tokenizeGroupCommand(input)
  if (!tokenized.ok) return undefined
  const tokens = [...tokenized.tokens]
  const first = tokens[0]
  if (first?.value.startsWith('/')) tokens[0] = { ...first, value: first.value.slice(1) }
  return tokens
}

function anyMatch(query: readonly string[]): boolean {
  return LISTEN_COMMANDS.some(definition => score(definition, query) > 0)
}

function isArgumentShapedToken(input: string, token: GroupCommandToken | undefined): boolean {
  if (!token) return false
  const raw = input.slice(token.start, token.end)
  return /^[@#]/.test(raw) || /^--/.test(raw) || /^-?\d/.test(raw) || /^["']/.test(raw)
}

function parseQuery(input: string): ParsedQuery | undefined {
  const tokens = rawTokens(input)
  if (!tokens) return undefined
  if (tokens.length === 0) return { tokens, query: [], argumentBoundary: false }
  const values = tokens.map(token => token.value.toLowerCase())
  if (values[0] === '') return { tokens, query: [], argumentBoundary: false }

  // A listen command has at most two path components. Treat a second token as
  // command text only when it can identify a command; otherwise it is an arg.
  const two = values.slice(0, 2)
  const secondIsArgument = isArgumentShapedToken(input, tokens[1])
  const secondIsCommand = tokens.length > 1 && !secondIsArgument && anyMatch(two)
  const query = secondIsCommand ? two : values.slice(0, 1)
  const argumentBoundary = tokens.length > 1 && !secondIsCommand
    && LISTEN_COMMANDS.some(definition => definition.path.length > 1 && definition.path[0] === values[0])
  return { tokens, query, argumentBoundary }
}

export function matchListenCommands(input: string): readonly ListenCommandMatch[] {
  const parsed = parseQuery(input)
  if (!parsed) return []
  return LISTEN_COMMANDS
    .map((definition, catalogIndex) => ({ definition, score: score(definition, parsed.query), catalogIndex }))
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score
      || (left.definition.category === 'general' ? 0 : 1) - (right.definition.category === 'general' ? 0 : 1)
      || left.catalogIndex - right.catalogIndex)
    .map(({ definition, score }) => ({ definition, score }))
}

export function visibleListenCommandMatches(input: string): readonly ListenCommandMatch[] {
  return matchListenCommands(input).slice(0, MAX_LISTEN_COMMAND_MATCHES)
}

export function completeListenCommand(input: string, selectedIndex = 0): string {
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) return input
  const match = visibleListenCommandMatches(input)[selectedIndex]
  const parsed = parseQuery(input)
  if (!match || !parsed) return input
  if (parsed.argumentBoundary) return input

  const commandTokens = parsed.tokens.slice(0, match.definition.path.length)
  const isComplete = commandTokens.length === match.definition.path.length
    && commandTokens.every((token, index) => token.value.toLowerCase() === match.definition.path[index])
  if (isComplete) return input

  const first = parsed.tokens[0]
  const leading = input.slice(0, first?.start ?? input.length)
  const slash = input.trimStart().startsWith('/') ? '/' : ''
  const command = `${leading}${slash}${match.definition.path.join(' ')}`
  const replacedCount = parsed.query.length || (parsed.tokens[0]?.value === '' ? 1 : 0)
  const remainderToken = parsed.tokens[replacedCount]
  return remainderToken ? `${command} ${input.slice(remainderToken.start)}` : `${command} `
}
