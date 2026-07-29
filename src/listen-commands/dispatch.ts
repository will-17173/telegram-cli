import { parseGroupCommand, type ParsedGroupCommandRequest } from '../group-commands/parser.js'
import {
  parseListenComposerInput,
  parseHistoryLimit,
  REPLY_COMMAND_USAGE,
  SEND_COMMAND_USAGE,
  type ListenComposerCommand,
} from '../services/listen-composer-command.js'
import { LISTEN_COMMANDS } from './catalog.js'
import {
  completeListenCommand,
  visibleListenCommandMatches,
  type ListenCommandMatch,
} from './match.js'

type ReplyCommand = Extract<ListenComposerCommand, { kind: 'reply' }>
type SendCommand = Extract<ListenComposerCommand, { kind: 'send' }>

export type ListenCommandParseResult =
  | { readonly kind: 'complete'; readonly input: string }
  | { readonly kind: 'send'; readonly command: SendCommand }
  | { readonly kind: 'reply'; readonly command: ReplyCommand }
  | { readonly kind: 'sync' }
  | { readonly kind: 'history'; readonly limit: number }
  | { readonly kind: 'group'; readonly request: ParsedGroupCommandRequest }
  | { readonly kind: 'error'; readonly message: string; readonly usage?: string }

export type ExecutableListenCommand = Extract<ListenCommandParseResult, { kind: 'send' | 'reply' | 'sync' | 'history' | 'group' }>

export function parseSelectedListenCommand(
  input: string,
  selected: ListenCommandMatch,
): ListenCommandParseResult {
  if (!LISTEN_COMMANDS.includes(selected.definition)) {
    return { kind: 'error', message: 'Selected command is not canonical' }
  }

  const matches = visibleListenCommandMatches(input)
  const selectedIndex = matches.findIndex(match => match.definition === selected.definition)
  if (selectedIndex < 0) {
    return { kind: 'error', message: 'Selected command no longer matches the input' }
  }

  const completed = completeListenCommand(input, selectedIndex)
  if (completed !== input) return { kind: 'complete', input: completed }

  if (selected.definition.kind === 'reply') {
    const parsed = parseListenComposerInput(input)
    if (parsed.kind === 'error') {
      return { kind: 'error', message: parsed.error, usage: REPLY_COMMAND_USAGE }
    }
    if (parsed.kind !== 'reply') {
      return { kind: 'error', message: 'Selected reply command does not match the input' }
    }
    return { kind: 'reply', command: parsed }
  }

  if (selected.definition.kind === 'send') {
    const parsed = parseListenComposerInput(input)
    if (parsed.kind === 'error') {
      return { kind: 'error', message: parsed.error, usage: SEND_COMMAND_USAGE }
    }
    if (parsed.kind !== 'send') {
      return { kind: 'error', message: 'Selected send command does not match the input' }
    }
    return { kind: 'send', command: parsed }
  }

  if (selected.definition.kind === 'sync') return { kind: 'sync' }

  if (selected.definition.kind === 'history') {
    const parsed = parseHistoryLimit(input)
    if (!parsed.ok) return { kind: 'error', message: parsed.error }
    return { kind: 'history', limit: parsed.limit }
  }

  const parsed = parseGroupCommand(input)
  if (!parsed.ok) {
    return {
      kind: 'error',
      message: parsed.error.message,
      ...(parsed.error.usage == null ? {} : { usage: parsed.error.usage }),
    }
  }
  if (parsed.request.key !== selected.definition.groupKey) {
    return { kind: 'error', message: 'Selected group command does not match the input' }
  }
  return { kind: 'group', request: parsed.request }
}

export async function executeSelectedListenCommand<RSend, RReply, RSync, RHistory, RGroup>(
  selected: ExecutableListenCommand,
  executors: {
    readonly executeSend: (command: SendCommand) => Promise<RSend>
    readonly executeReply: (command: ReplyCommand) => Promise<RReply>
    readonly executeSync: () => Promise<RSync>
    readonly executeHistory: (limit: number) => Promise<RHistory>
    readonly executeGroup: (request: ParsedGroupCommandRequest) => Promise<RGroup>
  },
): Promise<{ readonly kind: 'send'; readonly result: RSend } | { readonly kind: 'reply'; readonly result: RReply } | { readonly kind: 'sync'; readonly result: RSync } | { readonly kind: 'history'; readonly result: RHistory } | { readonly kind: 'group'; readonly result: RGroup }> {
  if (selected.kind === 'send') {
    return { kind: 'send', result: await executors.executeSend(selected.command) }
  }
  if (selected.kind === 'reply') {
    return { kind: 'reply', result: await executors.executeReply(selected.command) }
  }
  if (selected.kind === 'sync') {
    return { kind: 'sync', result: await executors.executeSync() }
  }
  if (selected.kind === 'history') {
    return { kind: 'history', result: await executors.executeHistory(selected.limit) }
  }
  return { kind: 'group', result: await executors.executeGroup(selected.request) }
}
