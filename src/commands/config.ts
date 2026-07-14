import type { Command } from 'commander'
import { renderResult } from '../cli/output.js'
import { validateCredentials, writeConfiguration } from '../config/credential-store.js'
import {
  getConfigPath,
  getTelegramCredentials,
  getTelegramWriteAccess,
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
  write_access: boolean
}

type ConfigWriteAccessOptions = OutputFlags

type ConfigWriteAccessData = {
  write_access: boolean
  changed: boolean
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
    .action(async (options: ConfigSetOptions, command: Command) => {
      const effectiveOptions = mergeOptionsWithGlobals(command, options)
      const conflict = outputFormatConflict(effectiveOptions)
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
        }, effectiveOptions)
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
        }, effectiveOptions)
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
        }, effectiveOptions)
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
      await renderResult(result, effectiveOptions)
    })

  config.command('list')
    .description('Show effective Telegram CLI configuration')
    .option('--show-secrets', 'Show the complete API hash')
    .option('--json')
    .option('--yaml')
    .action(async (options: ConfigListOptions, command: Command) => {
      const effectiveOptions = mergeOptionsWithGlobals(command, options)
      const conflict = outputFormatConflict(effectiveOptions)
      if (conflict) {
        await renderResult(conflict, { yaml: true })
        return
      }

      let credentials
      let proxy
      let writeAccess
      try {
        credentials = getTelegramCredentials()
        proxy = getTelegramProxyConfiguration()
        writeAccess = getTelegramWriteAccess()
      } catch {
        await renderResult({
          ok: false,
          error: {
            code: 'invalid_config',
            message: 'Telegram configuration is invalid.',
          },
        }, effectiveOptions)
        return
      }

      const data: ConfigListData = {
        api_id: credentials.apiId,
        api_hash: options.showSecrets ? credentials.apiHash : maskSecret(credentials.apiHash),
        credentials_source: credentials.source,
        proxy: proxy == null ? null : maskProxyCredentials(proxy.url),
        proxy_source: proxy?.source ?? null,
        write_access: writeAccess,
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
            `Write access         ${data.write_access}`,
          ].join('\n'),
        },
      }
      await renderResult(result, effectiveOptions)
    })

  config.command('write-access [status|on|off]')
    .description('Show or update Telegram remote write permission')
    .option('--json')
    .option('--yaml')
    .action(async (action: string | undefined, options: ConfigWriteAccessOptions, command: Command) => {
      const effectiveOptions = mergeOptionsWithGlobals(command, options)
      const conflict = outputFormatConflict(effectiveOptions)
      if (conflict) {
        await renderResult(conflict, { yaml: true })
        return
      }

      const target = action?.trim().toLowerCase() as 'status' | 'on' | 'off' | undefined
      if (target !== undefined && target !== 'status' && target !== 'on' && target !== 'off') {
        await renderResult({
          ok: false,
          error: {
            code: 'invalid_config',
            message: 'Action must be one of: status, on, or off.',
          },
        }, effectiveOptions)
        return
      }

      if (target === undefined || target === 'status') {
        try {
          const data: ConfigWriteAccessData = {
            write_access: getTelegramWriteAccess(),
            changed: false,
          }
          await renderResult({ ok: true, data }, effectiveOptions)
          return
        } catch {
          await renderResult({
            ok: false,
            error: {
              code: 'invalid_config',
              message: 'Telegram configuration is invalid.',
            },
          }, effectiveOptions)
          return
        }
      }

      const writeAccess = target === 'on'
      try {
        writeConfiguration(getConfigPath(), { writeAccess })
      } catch {
        await renderResult({
          ok: false,
          error: {
            code: 'config_write_failed',
            message: 'Failed to save Telegram configuration.',
          },
        }, effectiveOptions)
        return
      }

      const data: ConfigWriteAccessData = {
        write_access: writeAccess,
        changed: true,
      }
      const result: HandlerResult<ConfigWriteAccessData> = {
        ok: true,
        data,
        human: {
          kind: 'text',
          text: writeAccess ? 'Telegram remote writes enabled.' : 'Telegram remote writes disabled.',
        },
      }
      await renderResult(result, effectiveOptions)
    })
}

function mergeOptionsWithGlobals<T extends OutputFlags>(command: Command, options: T): T {
  return {
    ...command.optsWithGlobals(),
    ...options,
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '*'.repeat(secret.length)
  return `${'*'.repeat(secret.length - 4)}${secret.slice(-4)}`
}

function maskProxyCredentials(proxy: string): string {
  try {
    const url = new URL(proxy)
    if (url.username) url.username = '***'
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return proxy.replace(/^(\w+:\/\/)[^@/]+@/u, '$1***@')
  }
}
