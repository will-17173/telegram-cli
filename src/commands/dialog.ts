import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { DialogService } from '../services/dialog-service.js'
import { parseTimeRange } from './time-range.js'
import { outputFormatConflict, type HandlerResult } from './types.js'
import { runTelegramCommand } from './telegram-runner.js'
import { type AccountCommandOptions } from './account-options.js'
import type { ParsedTimeRange } from './time-range.js'

type DialogFlags = AccountCommandOptions & {
  limit?: string
  since?: string
  until?: string
  admin?: boolean
  chat?: string
  json?: boolean
  yaml?: boolean
}

export function registerDialogCommands(app: Command): void {
  registerInboxCommand(app, 'inbox')
  registerReadCommand(app, 'read')
  registerSearchCommand(app, 'search-online')

  const dialog = app.command('dialog')
    .description('Inspect Telegram dialogs, online messages, and managed groups')

  registerInboxCommand(dialog, 'inbox')
  registerReadCommand(dialog, 'read')
  registerSearchCommand(dialog, 'search')
  registerGroupsCommand(dialog)
}

function registerInboxCommand(parent: Command, name: string): void {
  parent.command(name)
    .description('List chats with unread messages')
    .option('-n, --limit <limit>', 'Max dialogs to display')
    .option('--json')
    .option('--yaml')
    .action(async (_options: DialogFlags, command: Command) => {
      const options = optionsWithGlobals<DialogFlags>(command)
      if (await renderInvalidLimit(options.limit, 500, options)) return
      await runDialogAction({
        options,
        handler: (service) => service.inbox({ limit: options.limit }),
      })
    })
}

function registerReadCommand(parent: Command, name: string): void {
  parent.command(name)
    .description('Read recent messages from a Telegram chat')
    .argument('<chat>')
    .option('-n, --limit <limit>', 'Max messages to read')
    .option('--since <since>', 'Only include messages after this time')
    .option('--until <until>', 'Only include messages before this time')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: DialogFlags, command: Command) => {
      const effectiveOptions = optionsWithGlobals<DialogFlags>(command)
      if (await renderInvalidLimit(effectiveOptions.limit, 1000, effectiveOptions)) return
      await runDialogReadResult({
        action: 'read',
        args: { chat },
        options: effectiveOptions,
      })
    })
}

function registerSearchCommand(parent: Command, name: string): void {
  parent.command(name)
    .description('Search Telegram online messages')
    .argument('<query>')
    .option('--chat <chat>', 'Limit search to one chat')
    .option('-n, --limit <limit>', 'Max messages to return')
    .option('--since <since>', 'Only include messages after this time')
    .option('--until <until>', 'Only include messages before this time')
    .option('--json')
    .option('--yaml')
    .action(async (query: string, options: DialogFlags, command: Command) => {
      const effectiveOptions = optionsWithGlobals<DialogFlags>(command)
      if (await renderInvalidLimit(effectiveOptions.limit, 1000, effectiveOptions)) return
      await runDialogReadResult({
        action: 'search',
        args: { query, chat: options.chat },
        options: effectiveOptions,
      })
    })
}

function registerGroupsCommand(parent: Command): void {
  parent.command('groups')
    .description('List Telegram managed groups')
    .option('--admin', 'Only groups where you are an admin or creator')
    .option('-n, --limit <limit>', 'Max groups to list')
    .option('--json')
    .option('--yaml')
    .action(async (_options: DialogFlags, command: Command) => {
      const effectiveOptions = optionsWithGlobals<DialogFlags>(command)
      if (await renderInvalidLimit(effectiveOptions.limit, 500, effectiveOptions)) return
      const conflict = outputFormatConflict(effectiveOptions)
      if (conflict) {
        await renderResult(conflict, { yaml: true })
        return
      }

      await runTelegramCommand(effectiveOptions, (client) => new DialogService(client.dialogs).groups({
        adminOnly: Boolean(effectiveOptions.admin),
        limit: effectiveOptions.limit,
      }), command)
    })
}

async function renderInvalidLimit(value: string | undefined, max: number, options: DialogFlags): Promise<boolean> {
  if (value == null) return false
  const text = value.trim()
  const limit = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (Number.isSafeInteger(limit) && limit >= 1 && limit <= max) return false
  await renderResult({
    ok: false,
    error: { code: 'invalid_option', message: `limit must be an integer between 1 and ${max}.` },
  }, options)
  return true
}

async function runDialogReadResult(input: {
  action: 'read' | 'search'
  args: { chat?: string; query?: string }
  options: DialogFlags
}): Promise<void> {
  const { action, args, options } = input
  const conflict = outputFormatConflict(options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  const range = parseRange(options.since, options.until)
  if (!range.ok) {
    await renderResult(range, options)
    return
  }

  await runTelegramCommand(options, (client) => {
    const service = new DialogService(client.dialogs)
    if (action === 'read') {
      if (args.chat == null) throw new Error('Missing chat argument for read.')
      return service.read({ chat: args.chat, limit: options.limit, ...range.data })
    }
    return service.search({ query: args.query ?? '', limit: options.limit, chat: options.chat, ...range.data })
  })
}

async function runDialogAction(input: {
  options: DialogFlags
  handler: (service: DialogService) => Promise<HandlerResult>
}): Promise<void> {
  const conflict = outputFormatConflict(input.options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }
  await runTelegramCommand(input.options, (client) => input.handler(new DialogService(client.dialogs)))
}

function parseRange(since: string | undefined, until: string | undefined): HandlerResult<ParsedTimeRange> {
  try {
    return { ok: true, data: parseTimeRange({ since, until }) }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'invalid_option',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function optionsWithGlobals<T extends AccountCommandOptions>(command: Command): T {
  return command.optsWithGlobals() as T
}
