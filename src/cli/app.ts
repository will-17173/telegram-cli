import { Command } from 'commander'
import { registerAccountCommands } from '../commands/account.js'
import { registerArchiveCommand } from '../commands/archive.js'
import { registerConfigCommands } from '../commands/config.js'
import { registerDataCommands } from '../commands/data.js'
import { registerDialogCommands } from '../commands/dialog.js'
import { registerContactCommands } from '../commands/contact.js'
import { registerGroupCommands } from '../commands/group.js'
import { registerQueryCommands } from '../commands/query.js'
import { registerTelegramCommands } from '../commands/telegram.js'

export function createApp(): Command {
  const app = new Command()
    .name('tg')
    .description('Telegram CLI for syncing chats, searching messages, and local analysis.')
    .option('-v, --verbose', 'Enable debug logging')
    .option('--account <account>', 'Select an account for account-dependent commands')
    .option('--markdown', 'Produce Markdown output for human-readable results')
    .version('0.3.0')

  registerQueryCommands(app)
  registerArchiveCommand(app)
  registerDataCommands(app)
  registerTelegramCommands(app)
  registerContactCommands(app)
  registerDialogCommands(app)
  registerGroupCommands(app)
  registerAccountCommands(app)
  registerConfigCommands(app)

  return app
}
