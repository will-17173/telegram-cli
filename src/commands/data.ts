import type { Command } from 'commander'
import { outputFormatConflict, type HandlerResult } from './types.js'
import { renderResult } from '../cli/output.js'
import { DataService } from '../services/data-service.js'

type DataFlags = {
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
    .action(async (chat: string, options: DataFlags) => {
      await renderDataResult(options, (service) => service.exportMessages({
        chat,
        format: options.format ?? 'text',
        output: options.output,
        hours: numberOption(options.hours),
      }))
    })

  app.command('purge')
    .description('Delete locally stored messages from a chat')
    .argument('<chat>')
    .option('-y, --yes')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, options: DataFlags) => {
      await renderDataResult(options, (service) => service.purge({ chat, yes: Boolean(options.yes) }))
    })
}

function numberOption(value: string | undefined): number | undefined {
  return value == null ? undefined : Number(value)
}

async function renderDataResult(options: DataFlags, handler: (service: DataService) => HandlerResult): Promise<void> {
  const conflict = outputFormatConflict(options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  const service = new DataService()
  try {
    await renderResult(handler(service), options)
  } finally {
    service.close()
  }
}
