import { parseGroupCommand, type ParsedGroupCommandRequest } from '../group-commands/parser.js'
import {
  parseListenComposerInput,
  REPLY_COMMAND_USAGE,
  type ListenComposerCommand,
} from '../services/listen-composer-command.js'
import { LISTEN_COMMANDS } from './catalog.js'
import {
  completeListenCommand,
  visibleListenCommandMatches,
  type ListenCommandMatch,
} from './match.js'

type ReplyCommand = Extract<ListenComposerCommand, { kind: 'reply' }>

export type ListenCommandDispatchResult =
  | { readonly kind: 'complete'; readonly input: string }
  | { readonly kind: 'reply'; readonly command: ReplyCommand }
  | { readonly kind: 'group'; readonly request: ParsedGroupCommandRequest }
  | { readonly kind: 'error'; readonly message: string; readonly usage?: string }

export interface ListenCommandExecutionOutcome {
  readonly status: string
}

export interface ListenCommandExecutors {
  readonly executeReply: (command: ReplyCommand) => Promise<ListenCommandExecutionOutcome>
  readonly executeGroup: (request: ParsedGroupCommandRequest) => Promise<ListenCommandExecutionOutcome>
}

export function dispatchListenCommand(
  input: string,
  selected: ListenCommandMatch,
): ListenCommandDispatchResult {
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

export function executeSelectedListenCommand(
  selected: ListenCommandDispatchResult,
  executors: ListenCommandExecutors,
): Promise<ListenCommandExecutionOutcome> {
  if (selected.kind === 'reply') return executors.executeReply(selected.command)
  if (selected.kind === 'group') return executors.executeGroup(selected.request)
  return Promise.reject(new Error(`Cannot execute listen command result: ${selected.kind}`))
}
