import type { Command } from 'commander'
import { renderResult } from '../cli/output.js'
import { validateCredentials, writeConfiguration } from '../config/credential-store.js'
import {
  getConfigPath,
  getTelegramCredentials,
  getTelegramProxyConfiguration,
  type CredentialSource,
  type ProxySource,
} from '../config/env.js'
import { normalizeTelegramProxy } from '../telegram/proxy.js'
import { outputFormatConflict, type HandlerResult, type OutputFlags } from './types.js'

type ConfigSetOptions = OutputFlags & {
  apiId?: string
  apiHash?: string
  proxy?: string
}

type ConfigSetData = {
  configured: true
  api_id?: number
  proxy_configured?: true
}

type ConfigListOptions = OutputFlags & {
  showSecrets?: boolean
}

type ConfigListData = {
  api_id: number
  api_hash: string
  credentials_source: CredentialSource
  proxy: string | null
  proxy_source: ProxySource | null
}

export function registerConfigCommands(app: Command): void {
  const config = app.command('config').description('Manage Telegram CLI configuration')

  config.command('set')
    .description('Save Telegram API credentials and proxy settings')
    .option('--api-id <id>', 'Telegram API ID')
    .option('--api-hash <hash>', 'Telegram API hash')
    .option('--proxy <url>', 'Telegram proxy URL')
    .option('--json')
    .option('--yaml')
    .action(async (options: ConfigSetOptions) => {
      const conflict = outputFormatConflict(options)
      if (conflict) {
        await renderResult(conflict, { yaml: true })
        return
      }

      const credentialsSupplied = options.apiId !== undefined || options.apiHash !== undefined
      const proxySupplied = options.proxy !== undefined

      if (!credentialsSupplied && !proxySupplied) {
        await renderResult({
          ok: false,
          error: {
            code: 'invalid_config',
            message: 'Provide API credentials, a proxy, or both.',
          },
        }, options)
        return
      }

      let credentials
      let proxy
      try {
        if (credentialsSupplied) {
          credentials = validateCredentials({
            apiId: options.apiId,
            apiHash: options.apiHash,
          })
        }
        if (proxySupplied) proxy = normalizeTelegramProxy(options.proxy)
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
        writeConfiguration(getConfigPath(), {
          ...(credentials ? { credentials } : {}),
          ...(proxy ? { proxy } : {}),
        })
      } catch {
        await renderResult({
          ok: false,
          error: {
            code: 'config_write_failed',
            message: 'Failed to save Telegram configuration.',
          },
        }, options)
        return
      }

      const data: ConfigSetData = {
        configured: true,
        ...(credentials ? { api_id: credentials.apiId } : {}),
        ...(proxy ? { proxy_configured: true as const } : {}),
      }
      const result: HandlerResult<ConfigSetData> = {
        ok: true,
        data,
        human: {
          kind: 'text',
          text: credentials && proxy
            ? 'Telegram API credentials and proxy saved.'
            : credentials
              ? 'Telegram API credentials saved.'
              : 'Telegram proxy saved.',
        },
      }
      await renderResult(result, options)
    })

  config.command('list')
    .description('Show effective Telegram CLI configuration')
    .option('--show-secrets', 'Show the complete API hash')
    .option('--json')
    .option('--yaml')
    .action(async (options: ConfigListOptions) => {
      const conflict = outputFormatConflict(options)
      if (conflict) {
        await renderResult(conflict, { yaml: true })
        return
      }

      let credentials
      let proxy
      try {
        credentials = getTelegramCredentials()
        proxy = getTelegramProxyConfiguration()
      } catch {
        await renderResult({
          ok: false,
          error: {
            code: 'invalid_config',
            message: 'Telegram configuration is invalid.',
          },
        }, options)
        return
      }

      const data: ConfigListData = {
        api_id: credentials.apiId,
        api_hash: options.showSecrets ? credentials.apiHash : maskSecret(credentials.apiHash),
        credentials_source: credentials.source,
        proxy: proxy?.url ?? null,
        proxy_source: proxy?.source ?? null,
      }
      const result: HandlerResult<ConfigListData> = {
        ok: true,
        data,
        human: {
          kind: 'text',
          text: [
            `API ID               ${data.api_id}`,
            `API hash             ${data.api_hash}`,
            `Credentials source   ${data.credentials_source}`,
            `Proxy                ${data.proxy ?? 'none'}`,
            `Proxy source         ${data.proxy_source ?? 'none'}`,
          ].join('\n'),
        },
      }
      await renderResult(result, options)
    })
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '*'.repeat(secret.length)
  return `${'*'.repeat(secret.length - 4)}${secret.slice(-4)}`
}
