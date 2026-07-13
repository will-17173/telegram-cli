import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { ContactService } from '../services/contact-service.js'
import { outputFormatConflict, type HandlerResult } from './types.js'
import { runTelegramCommand } from './telegram-runner.js'
import { type AccountCommandOptions } from './account-options.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

type ContactOptions = AccountCommandOptions & {
  json?: boolean
  yaml?: boolean
}

export function registerContactCommands(app: Command): void {
  const contact = app.command('contact')
    .description('Inspect Telegram contacts')

  contact.command('list')
    .description('List Telegram contacts')
    .option('--json')
    .option('--yaml')
    .action(async (_options: ContactOptions, command: Command) => {
      await runContactAction({
        options: optionsWithGlobals<ContactOptions>(command),
        handler: (client) => new ContactService(client.contacts).list(),
      }, command)
    })

  contact.command('info')
    .description('Show a Telegram contact by id, username, or phone')
    .argument('<user_or_phone>')
    .option('--json')
    .option('--yaml')
    .action(async (userOrPhone: string, _options: ContactOptions, command: Command) => {
      await runContactAction({
        options: optionsWithGlobals<ContactOptions>(command),
        handler: (client) => new ContactService(client.contacts).info({ userOrPhone }),
      }, command)
    })
}

async function runContactAction(
  input: {
    options: ContactOptions
    handler: (client: TelegramClientAdapter) => Promise<HandlerResult>
  },
  command: Command,
): Promise<void> {
  const conflict = outputFormatConflict(input.options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }
  await runTelegramCommand(input.options, (client) => input.handler(client), command)
}

function optionsWithGlobals<T extends AccountCommandOptions>(command: Command): T {
  return command.optsWithGlobals() as T
}
