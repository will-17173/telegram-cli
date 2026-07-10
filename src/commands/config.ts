import type { Command } from 'commander'
import { renderResult } from '../cli/output.js'
import { validateCredentials, writeCredentials } from '../config/credential-store.js'
import { getConfigPath } from '../config/env.js'
import { outputFormatConflict, type HandlerResult, type OutputFlags } from './types.js'

type ConfigSetOptions = OutputFlags & {
  apiId?: string
  apiHash?: string
}

export function registerConfigCommands(app: Command): void {
  const config = app.command('config').description('Manage Telegram CLI configuration')

  config.command('set')
    .description('Save Telegram API credentials')
    .option('--api-id <id>', 'Telegram API ID')
    .option('--api-hash <hash>', 'Telegram API hash')
    .option('--json')
    .option('--yaml')
    .action(async (options: ConfigSetOptions) => {
      const conflict = outputFormatConflict(options)
      if (conflict) {
        await renderResult(conflict, { yaml: true })
        return
      }

      let credentials
      try {
        credentials = validateCredentials({
          apiId: options.apiId,
          apiHash: options.apiHash,
        })
      } catch (error) {
        await renderResult({
          ok: false,
          error: {
            code: 'invalid_config',
            message: error instanceof Error ? error.message : 'Telegram API configuration is invalid.',
          },
        }, options)
        return
      }

      try {
        writeCredentials(getConfigPath(), credentials)
      } catch {
        await renderResult({
          ok: false,
          error: {
            code: 'config_write_failed',
            message: 'Failed to save Telegram API credentials.',
          },
        }, options)
        return
      }

      const result: HandlerResult<{ configured: true; api_id: number }> = {
        ok: true,
        data: {
          configured: true,
          api_id: credentials.apiId,
        },
        human: {
          kind: 'text',
          text: 'Telegram API credentials saved.',
        },
      }
      await renderResult(result, options)
    })
}
