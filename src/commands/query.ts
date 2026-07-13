import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { MessageDB } from '../storage/message-db.js'
import { QueryService } from '../services/query-service.js'
import { outputFormatConflict, type HandlerResult } from './types.js'
import { runWithAccountContext, type AccountCommandOptions } from './account-options.js'

type QueryFlags = AccountCommandOptions & {
  chat?: string
  sender?: string
  hours?: string
  regex?: boolean
  limit?: string
  by?: 'day' | 'hour'
  json?: boolean
  yaml?: boolean
}

export function registerQueryCommands(app: Command): void {
  app.command('search')
    .description('Search locally stored messages by keyword')
    .argument('<keyword>')
    .option('-c, --chat <chat>')
    .option('-s, --sender <sender>')
    .option('--hours <hours>')
    .option('--regex')
    .option('-n, --limit <limit>', 'Max results', '50')
    .option('--json')
    .option('--yaml')
    .action(async (keyword: string, options: QueryFlags, command: Command) => {
      await renderQueryResult(options, (service) => service.search({
        keyword,
        chat: options.chat,
        sender: options.sender,
        hours: numberOption(options.hours),
        regex: Boolean(options.regex),
        limit: numberOption(options.limit),
      }), command)
    })

  app.command('recent')
    .description('Show recently stored messages')
    .option('-c, --chat <chat>')
    .option('-s, --sender <sender>')
    .option('--hours <hours>', 'Only show last N hours', '24')
    .option('-n, --limit <limit>', 'Max messages', '50')
    .option('--json')
    .option('--yaml')
    .action(async (options: QueryFlags, command: Command) => {
      await renderQueryResult(options, (service) => service.recent({
        chat: options.chat,
        sender: options.sender,
        hours: numberOption(options.hours),
        limit: numberOption(options.limit),
      }), command)
    })

  app.command('stats')
    .description('Show local message and chat statistics')
    .option('--json')
    .option('--yaml')
    .action(async (options: QueryFlags, command: Command) => renderQueryResult(options, (service) => service.stats(), command))

  app.command('top')
    .description('Show the most active message senders')
    .option('-c, --chat <chat>')
    .option('--hours <hours>')
    .option('-n, --limit <limit>', 'Top N senders', '20')
    .option('--json')
    .option('--yaml')
    .action(async (options: QueryFlags, command: Command) => {
      await renderQueryResult(options, (service) => service.top({
        chat: options.chat,
        hours: numberOption(options.hours),
        limit: numberOption(options.limit),
      }), command)
    })

  app.command('timeline')
    .description('Show message activity over time')
    .option('-c, --chat <chat>')
    .option('--hours <hours>')
    .option('--by <granularity>', 'day or hour', 'day')
    .option('--json')
    .option('--yaml')
    .action(async (options: QueryFlags, command: Command) => {
      await renderQueryResult(options, (service) => service.timeline({
        chat: options.chat,
        hours: numberOption(options.hours),
        granularity: options.by,
      }), command)
    })

  app.command('today')
    .description('Show messages stored today')
    .option('-c, --chat <chat>')
    .option('--json')
    .option('--yaml')
    .action(async (options: QueryFlags, command: Command) => renderQueryResult(options, (service) => service.today({ chat: options.chat }), command))

  app.command('filter')
    .description('Filter locally stored messages by keywords')
    .argument('<keywords>')
    .option('-c, --chat <chat>')
    .option('--hours <hours>')
    .option('--json')
    .option('--yaml')
    .action(async (keywords: string, options: QueryFlags, command: Command) => {
      await renderQueryResult(options, (service) => service.filter({
        keywords,
        chat: options.chat,
        hours: numberOption(options.hours),
      }), command)
    })
}

function numberOption(value: string | undefined): number | undefined {
  return value == null ? undefined : Number(value)
}

async function renderQueryResult(
  options: QueryFlags,
  handler: (service: QueryService) => HandlerResult,
  command?: Command,
): Promise<void> {
  const effectiveOptions = command == null ? options : mergeOptionsWithGlobals(command, options)
  const conflict = outputFormatConflict(effectiveOptions)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  await runWithAccountContext(effectiveOptions, (context) => {
    const service = new QueryService(new MessageDB(context.dbPath))
    try {
      return handler(service)
    } finally {
      service.close()
    }
  })
}

function mergeOptionsWithGlobals<T extends QueryFlags>(command: Command, options: T): T {
  return {
    ...command.optsWithGlobals(),
    ...options,
  }
}
