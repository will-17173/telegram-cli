import type { Command } from 'commander'
import { startWebServer } from '../web/server.js'

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
    .action(async (options: WebCommandOptions) => {
      const port = parsePort(options.port)
      const server = await startWebServer({ port })
      process.stdout.write(`Telegram CLI web UI: ${server.url}\n`)
      await waitForShutdown(server.close)
    })
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  if (!/^\d+$/.test(raw)) throw new Error('--port must be a positive integer')
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be a positive integer')
  return port
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = async () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      try {
        await close()
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
