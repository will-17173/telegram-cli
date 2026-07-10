import { Command } from 'commander'
import { registerConfigCommands } from '../commands/config.js'
import { registerDataCommands } from '../commands/data.js'
import { registerQueryCommands } from '../commands/query.js'
import { registerTelegramCommands } from '../commands/telegram.js'

export function createApp(): Command {
  const app = new Command()
    .name('tg')
    .description('Telegram CLI for syncing chats, searching messages, and local analysis.')
    .option('-v, --verbose', 'Enable debug logging')
    .version('0.1.0')

  registerQueryCommands(app)
  registerDataCommands(app)
  registerTelegramCommands(app)
  registerConfigCommands(app)

  return app
}
