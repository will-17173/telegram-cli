import { join } from 'node:path'
import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { MessageDB } from '../storage/message-db.js'
import { DataService } from '../services/data-service.js'
import { DataResetService } from '../services/data-reset-service.js'
import { AccountStore } from '../account/account-store.js'
import { getAccountRegistryPath, getDataDir } from '../config/env.js'
import { accountFailureFromError } from './account-options.js'
import { dataResetRequiredFailure, outputFormatConflict, type HandlerResult } from './types.js'
import { runWithAccountContext, type AccountCommandOptions } from './account-options.js'

type DataFlags = AccountCommandOptions & {
  format?: 'text' | 'json' | 'yaml'
  output?: string
  hours?: string
  yes?: boolean
  json?: boolean
  yaml?: boolean
  allAccounts?: boolean
}

export function registerDataCommands(app: Command): void {
  const data = app.command('data')
    .description('Manage local account data')

  data.command('reset')
    .description('Delete local message databases and default archives')
    .option('-y, --yes')
    .option('--all-accounts')
    .option('--json')
    .option('--yaml')
    .action(async (options: DataFlags, command: Command) => {
      await renderDataReset(options, command)
    })

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
    try {
      const service = new DataService(new MessageDB(context.dbPath))
      try {
        return handler(service)
      } finally {
        service.close()
      }
    } catch (error) {
      return dataResetRequiredFailure(error) ?? {
        ok: false,
        error: {
          code: 'data_error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  })
}

async function renderDataReset(options: DataFlags, command: Command): Promise<void> {
  const effectiveOptions = mergeOptionsWithGlobals(command, options)
  const conflict = outputFormatConflict(effectiveOptions)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  if (effectiveOptions.allAccounts === true && effectiveOptions.account != null) {
    await renderResult({
      ok: false,
      error: {
        code: 'invalid_option',
        message: '--all-accounts cannot be combined with --account.',
      },
    }, effectiveOptions)
    return
  }

  const dataDir = getDataDir()
  let accountNames: string[]
  if (effectiveOptions.allAccounts === true) {
    try {
      accountNames = new AccountStore(getAccountRegistryPath(dataDir)).list().map((account) => account.name)
    } catch (error) {
      await renderResult(accountFailureFromError(error), effectiveOptions)
      return
    }
  } else {
    let context
    try {
      const store = new AccountStore(join(dataDir, 'accounts.json'))
      const registry = store.read()
      const name = effectiveOptions.account?.trim() || registry.current_account
      if (!name) throw new Error('account_required: no active account found')
      const account = store.get(name)
      if (!account) throw new Error(`account_not_found: account "${name}"`)
      context = account
    } catch (error) {
      await renderResult(accountFailureFromError(error), effectiveOptions)
      return
    }
    accountNames = [context.name]
  }

  await renderResult(new DataResetService({ dataDir }).reset({
    accountNames,
    confirmed: effectiveOptions.yes === true,
  }), effectiveOptions)
}

function mergeOptionsWithGlobals<T extends DataFlags>(command: Command, options: T): T {
  return {
    ...command.optsWithGlobals(),
    ...options,
  }
}
