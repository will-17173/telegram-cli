import type { Command } from 'commander'

export type WebCommandOptions = {
  port?: string
}

export function registerWebCommand(app: Command): void {
  const localWebHelp = [
    '',
    'The web UI binds to 127.0.0.1 only, has no login screen, reads local account data,',
    'and can trigger read-only Telegram sync into local SQLite.',
  ].join('\n')
  const webCommand = app.command('web')
    .description('Start the local Telegram CLI web management UI')
    .option('--port <port>', 'Local port to listen on, starting from 8734 when omitted')

  const baseFormatHelp = webCommand.createHelp().formatHelp
  webCommand
    .configureHelp({
      formatHelp(command, helper) {
        return `${baseFormatHelp.call(helper, command, helper)}\n${localWebHelp}`
      },
    })
    .action(async (_options: WebCommandOptions) => {
      throw new Error('tg web server is not implemented yet')
    })
}
