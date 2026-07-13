import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { MessageDB } from '../storage/message-db.js'
import { DataService } from '../services/data-service.js'
import { outputFormatConflict, type HandlerResult } from './types.js'
import { runWithAccountContext, type AccountCommandOptions } from './account-options.js'

type DataFlags = AccountCommandOptions & {
  format?: 'text' | 'json' | 'yaml'
  output?: string
  hours?: string
  yes?: boolean
  json?: boolean
  yaml?: boolean
}

export function registerDataCommands(app: Command): void {
  app.command('export')
    .description('Export locally stored messages from a chat')
    .argument('<chat>')
    .option('-f, --format <format>', 'text, json, or yaml', 'text')
    .option('-o, --output <output>')
    .option('--hours <hours>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: DataFlags, command: Command) => {
      await renderDataResult(options, (service) => service.exportMessages({
        chat,
        format: options.format ?? 'text',
        output: options.output,
        hours: numberOption(options.hours),
      }), command)
    })

  app.command('purge')
    .description('Delete locally stored messages from a chat')
    .argument('<chat>')
    .option('-y, --yes')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: DataFlags, command: Command) => {
      await renderDataResult(options, (service) => service.purge({ chat, yes: Boolean(options.yes) }), command)
    })
}

function numberOption(value: string | undefined): number | undefined {
  return value == null ? undefined : Number(value)
}

async function renderDataResult(
  options: DataFlags,
  handler: (service: DataService) => HandlerResult,
  command?: Command,
): Promise<void> {
  const effectiveOptions = command == null ? options : mergeOptionsWithGlobals(command, options)
  const conflict = outputFormatConflict(effectiveOptions)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  await runWithAccountContext(effectiveOptions, (context) => {
    const service = new DataService(new MessageDB(context.dbPath))
    try {
      return handler(service)
    } finally {
      service.close()
    }
  })
}

function mergeOptionsWithGlobals<T extends DataFlags>(command: Command, options: T): T {
  return {
    ...command.optsWithGlobals(),
    ...options,
  }
}
