import { mkdtempSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'

import { getAccountRegistryPath, getDataDir } from '../config/env.js'
import { authenticateAccountAt, mapAuthUser, type AuthenticatedSession } from '../account/account-authenticator.js'
import { AccountStore, type AccountMeta } from '../account/account-store.js'
import { accountDbPath, accountSessionPath } from '../account/account-presets.js'
import { outputFormatConflict, type HandlerResult, type OutputFlags } from './types.js'
import { renderResult } from '../cli/output.js'
import { AccountSessionService } from '../services/account-session-service.js'
import { createInterruptScope, isCliInterruptedError, readVisibleInput } from '../cli/secure-input.js'

type AccountOperationOptions = OutputFlags
type AddAccountOptions = OutputFlags
type SwitchAccountOptions = OutputFlags
type RemoveAccountOptions = OutputFlags & {
  force?: boolean
}
type LogoutAccountOptions = OutputFlags & {
  yes?: boolean
}

type CodedError = Error & {
  code?: string
}

export function registerAccountCommands(app: Command): void {
  const account = app.command('account').description('Manage Telegram accounts')

  account.command('add')
    .description('Add and authenticate a Telegram account')
    .option('--json')
    .option('--yaml')
    .action(async (options: AddAccountOptions, command: Command) => {
      await runAccountCommand(options, async () => {
        const registered = await addAccount()
        return {
          ok: true,
          data: registered,
          human: {
            kind: 'detail',
            title: 'Account added',
            fields: [
              { label: 'Name', value: registered.account.name },
              { label: 'Current', value: String(registered.current), tone: registered.current ? 'success' : 'default' },
              { label: 'User ID', value: String(registered.account.user_id) },
            ],
          },
        }
      }, command)
    })

  account.command('list')
    .description('List registered accounts')
    .option('--json')
    .option('--yaml')
    .action(async (options: AccountOperationOptions, command: Command) => {
      await runAccountCommand(options, () => {
        const store = new AccountStore(getAccountRegistryPath())
        const registry = store.read()

        const accounts = registry.accounts.map((account) => ({
          name: account.name,
          display_name: normalizeDisplayName(account.display_name),
          username: account.username,
          phone: account.phone,
          auth_state: account.auth_state,
          current: account.name === registry.current_account,
        }))

        return {
          ok: true,
          data: {
            current_account: registry.current_account,
            accounts,
          },
          human: {
            kind: 'table',
            title: 'Accounts',
            columns: ['NAME', 'DISPLAY NAME', 'USERNAME', 'PHONE', 'CURRENT'],
            rows: accounts.map((account) => [
              account.name,
              account.display_name,
              account.username,
              account.phone,
              account.current ? 'yes' : 'no',
            ]),
            emptyText: 'No accounts found.',
          },
        }
      }, command)
    })

  account.command('current')
    .description('Show the current account')
    .option('--json')
    .option('--yaml')
    .action(async (options: AccountOperationOptions, command: Command) => {
      await runAccountCommand(options, () => {
        const store = new AccountStore(getAccountRegistryPath())
        const registry = store.read()

        if (registry.current_account === null) {
          return {
            ok: false,
            error: {
              code: 'account_required',
              message: 'No current account is set. Run tg account switch <name> or add one with tg account add.',
            },
          }
        }

        const account = store.current()
        if (!account) {
          return {
            ok: false,
            error: {
              code: 'account_not_found',
              message: `Current account "${registry.current_account}" no longer exists.`,
            },
          }
        }

        return {
          ok: true,
          data: {
            account,
            current: true,
          },
          human: {
            kind: 'detail',
            title: 'Current account',
            fields: [
              { label: 'Name', value: account.name },
              { label: 'Display name', value: normalizeDisplayName(account.display_name) },
              { label: 'Username', value: `@${account.username}` },
              { label: 'User ID', value: String(account.user_id) },
              { label: 'Phone', value: account.phone },
              { label: 'Current', value: 'yes', tone: 'success' },
            ],
          },
        }
      }, command)
    })

  account.command('switch [name]')
    .description('Set the default account')
    .option('--json')
    .option('--yaml')
    .action(async (name: string | undefined, options: SwitchAccountOptions, command: Command) => {
      await runAccountCommand(options, async () => {
        const store = new AccountStore(getAccountRegistryPath())
        const selectedName = name ?? await promptForAccount(store, options)
        if (typeof selectedName !== 'string') return selectedName

        const current = await store.withLock(() => {
          const registry = store.read()
          if (!registry.accounts.some((account) => account.name === selectedName)) {
            return {
              code: 'account_not_found' as const,
              message: `Account "${selectedName}" is not registered.`,
            }
          }

          const next = { ...registry, current_account: selectedName }
          store.write(next)
          return {
            code: null as null,
            message: '',
            current: next.current_account,
          }
        })

        if (current.code !== null) {
          return {
            ok: false,
            error: {
              code: current.code,
              message: current.message,
            },
          }
        }

        return {
          ok: true,
          data: {
            current_account: current.current,
          },
          human: {
            kind: 'detail',
            title: 'Current account updated',
            fields: [{ label: 'Current account', value: current.current }],
          },
        }
      }, command)
    })

  account.command('remove <name>')
    .description('Remove an account from local registry')
    .option('--force', 'Delete local files without interactive confirmation')
    .option('--json')
    .option('--yaml')
    .action(async (name: string, options: RemoveAccountOptions, command: Command) => {
      await runAccountCommand(options, async () => {
        if (!options.force && process.stdin.isTTY !== true) {
          return {
            ok: false,
            error: {
              code: 'account_in_use',
              message: 'Account removal requires --force in non-interactive mode.',
            },
          }
        }

        const store = new AccountStore(getAccountRegistryPath())
        const dataDir = getDataDir()

        const removed = await store.withLock(() => {
          const registry = store.read()
          const account = registry.accounts.find((item) => item.name === name)
          if (!account) {
            return {
              code: 'account_not_found' as const,
              message: `Account "${name}" is not registered.`,
            }
          }

          const accountDir = dirname(accountSessionPath(dataDir, account.name))
          const tombstone = join(dirname(accountDir), `.delete-${account.name}-${randomUUID()}`)

          try {
            renameSync(accountDir, tombstone)
          } catch (error) {
            return {
              code: 'account_in_use' as const,
              message: `Could not move account files for "${account.name}": ${errorMessage(error)}`,
            }
          }

          const remaining = registry.accounts.filter((item) => item.name !== account.name)
          const nextCurrent = registry.current_account === account.name
            ? remaining[0]?.name ?? null
            : registry.current_account
          const next = { ...registry, accounts: remaining, current_account: nextCurrent }

          try {
            store.write(next)
          } catch (error) {
            try {
              renameSync(tombstone, accountDir)
            } catch {
              return {
                code: 'account_store_error' as const,
                message: `Failed to restore files after registry update failure for "${account.name}".`,
              }
            }

            return {
              code: 'account_store_error' as const,
              message: `Failed to update registry: ${errorMessage(error)}`,
            }
          }

          return {
            code: null as null,
            message: '',
            removed: account.name,
            account,
            current_account: next.current_account,
            tombstone,
          }
        })

        if (removed.code !== null) {
          return {
            ok: false,
            error: {
              code: removed.code,
              message: removed.message,
            },
          }
        }

        try {
          rmSync(removed.tombstone, { recursive: true, force: true })
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'account_in_use',
              message: `Account was removed from registry, but local files could not be deleted: ${errorMessage(error)}`,
              details: { tombstone: removed.tombstone },
            },
          }
        }

        return {
          ok: true,
          data: {
            removed: removed.removed,
            current_account: removed.current_account,
          },
          human: {
            kind: 'detail',
            title: 'Account removed',
            fields: [
              { label: 'Removed', value: removed.removed },
              { label: 'Current', value: removed.current_account ?? 'none' },
            ],
          },
        }
      }, command)
    })

  account.command('logout [name]')
    .description('Log out a Telegram account while keeping local messages')
    .option('--yes', 'Confirm logout without prompting')
    .option('--json')
    .option('--yaml')
    .action(async (name: string | undefined, options: LogoutAccountOptions, command: Command) => {
      await runAccountCommand(options, async () => {
        const dataDir = getDataDir()
        const store = new AccountStore(getAccountRegistryPath(dataDir))
        const registry = store.read()
        const selectedName = name ?? registry.current_account
        if (selectedName === null) {
          return {
            ok: false,
            error: {
              code: 'account_required',
              message: 'No current account is set. Provide an account name or select one with tg account switch <name>.',
            },
          }
        }

        const account = registry.accounts.find((candidate) => candidate.name === selectedName)
        if (!account) {
          return {
            ok: false,
            error: {
              code: 'account_not_found',
              message: `Account "${selectedName}" is not registered.`,
            },
          }
        }

        if (!options.yes) {
          if (process.stdin.isTTY !== true) {
            return {
              ok: false,
              error: {
                code: 'confirmation_required',
                message: `Log out ${selectedName} while keeping local messages? Use --yes to confirm.`,
              },
            }
          }

          const confirmed = await confirmLogout(selectedName)
          if (!confirmed) return accountSessionResult(account, false, dataDir, 'Account logout cancelled')
        }

        const service = new AccountSessionService({ dataDir, store })
        const result = await service.logout({ name: selectedName })
        return result.ok
          ? accountSessionResult(result.data.account, result.data.changed, dataDir, 'Account logged out')
          : result
      }, command)
    })

  account.command('login <name>')
    .description('Log in to an existing Telegram account')
    .option('--json')
    .option('--yaml')
    .action(async (name: string, options: AccountOperationOptions, command: Command) => {
      await runAccountCommand(options, async () => {
        const dataDir = getDataDir()
        const store = new AccountStore(getAccountRegistryPath(dataDir))
        if (!store.get(name)) {
          return {
            ok: false,
            error: {
              code: 'account_not_found',
              message: `Account "${name}" is not registered.`,
            },
          }
        }
        if (process.stdin.isTTY !== true) {
          return {
            ok: false,
            error: {
              code: 'interaction_required',
              message: 'Account login requires an interactive terminal.',
            },
          }
        }

        const service = new AccountSessionService({ dataDir, store })
        const result = await service.login({ name })
        if (!result.ok) return result
        return {
          ...result,
          human: {
            kind: 'detail' as const,
            title: 'Account logged in',
            fields: [
              { label: 'Name', value: result.data.account.name },
              { label: 'Auth state', value: result.data.account.auth_state, tone: 'success' as const },
            ],
          },
        }
      }, command)
    })
}

async function confirmLogout(name: string): Promise<boolean> {
  const interrupt = createInterruptScope()
  try {
    const answer = await readVisibleInput(`Log out ${name} while keeping local messages? [y/N]`, {
      output: process.stderr,
      signal: interrupt.signal,
    })
    return /^y(?:es)?$/i.test(answer.trim())
  } finally {
    interrupt.dispose()
  }
}

function accountSessionResult(
  account: AccountMeta,
  changed: boolean,
  dataDir: string,
  title: string,
): HandlerResult {
  const retainedDbPath = accountDbPath(dataDir, account.name)
  return {
    ok: true,
    data: {
      account,
      changed,
      retained_db_path: retainedDbPath,
    },
    human: {
      kind: 'detail',
      title,
      fields: [
        { label: 'Name', value: account.name },
        { label: 'Auth state', value: account.auth_state, tone: account.auth_state === 'logged_out' ? 'warning' : 'success' },
        { label: 'Retained messages DB', value: retainedDbPath },
      ],
    },
  }
}

async function promptForAccount(store: AccountStore, options: SwitchAccountOptions): Promise<string | HandlerResult<never>> {
  if (options.json || options.yaml || process.stdin.isTTY !== true) {
    return {
      ok: false,
      error: {
        code: 'account_required',
        message: 'Provide an account name, or run tg account switch in an interactive terminal.',
      },
    }
  }

  const registry = store.read()
  if (registry.accounts.length === 0) {
    return {
      ok: false,
      error: {
        code: 'account_not_found',
        message: 'No registered accounts found. Add one with tg account add.',
      },
    }
  }

  process.stdout.write('Select an account:\n')
  for (const [index, account] of registry.accounts.entries()) {
    const current = account.name === registry.current_account ? ' (current)' : ''
    process.stdout.write(`${index + 1}. ${account.name} — ${normalizeDisplayName(account.display_name)}${current}\n`)
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const answer = (await prompt.question('Account number: ')).trim()
      const selectedIndex = Number(answer) - 1
      const selected = Number.isInteger(selectedIndex) ? registry.accounts[selectedIndex] : undefined
      if (selected) return selected.name
      process.stdout.write(`Enter a number from 1 to ${registry.accounts.length}.\n`)
    }
  } finally {
    prompt.close()
  }
}

type SyncableResult = HandlerResult | Promise<HandlerResult>

async function runAccountCommand(
  options: AccountOperationOptions,
  handler: () => SyncableResult,
  command?: Command,
): Promise<void> {
  const effectiveOptions = command == null ? options : mergeOptionsWithGlobals(command, options)
  const conflict = outputFormatConflict(effectiveOptions)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  try {
    const result = await handler()
    await renderResult(result, effectiveOptions)
  } catch (error) {
    if (isCliInterruptedError(error)) {
      await renderResult({ ok: false, error: { code: error.code, message: error.message } }, effectiveOptions)
      process.exitCode = error.exitCode
      return
    }
    await renderResult(unwrapFailure(error, 'account_store_error'), effectiveOptions)
  }
}

function mergeOptionsWithGlobals<T extends AccountOperationOptions>(command: Command, options: T): T {
  return {
    ...command.optsWithGlobals(),
    ...options,
  }
}

async function addAccount(): Promise<{
  account: AccountMeta
  current: boolean
}> {
  const dataDir = getDataDir()
  const store = new AccountStore(getAccountRegistryPath(dataDir))
  const temporaryAccountDir = mkdtempSync(join(dataDir, 'tmp-account-'))
  const temporarySessionPath = join(temporaryAccountDir, 'session')

  let auth: AuthenticatedSession | undefined

  try {
    auth = await authenticateAccountAt(temporarySessionPath)
    const mapped = mapAuthUser(auth.user)
    await auth.close()
    auth = undefined

    const registration = await store.withLock(() => {
      const registry = store.read()
      if (registry.accounts.some((account) => account.user_id === mapped.user_id)) {
        return {
          code: 'account_already_exists',
          message: `Account ${mapped.user_id} is already registered.`,
          account: null,
          current: false,
        } as const
      }

      let name = mapped.name
      const collision = registry.accounts.find((account) => account.name === name)
      if (collision != null && collision.user_id !== mapped.user_id) {
        name = `${name}-${mapped.user_id}`
      }

      const account: AccountMeta = {
        ...mapped,
        auth_state: 'authenticated',
        name,
      }
      const accounts = registry.accounts.concat([account])
      const currentAccount = registry.current_account ?? account.name
      store.write({ ...registry, accounts, current_account: currentAccount })

      return {
        code: null,
        message: '',
        account,
        current: currentAccount === account.name,
      } as const
    })

    if (registration.code !== null) {
      throwCodeError(registration.code, registration.message)
    }

    const finalSessionPath = accountSessionPath(dataDir, registration.account.name)
    try {
      moveSession(temporarySessionPath, finalSessionPath)
    } catch (error) {
      await rollbackRegistration(store, registration.account.name)
      throwCodeError('account_store_error', `Failed to move session file: ${errorMessage(error)}`)
    }

    return {
      account: registration.account,
      current: registration.current,
    }
  } finally {
    if (auth) {
      await auth.close()
    }
    rmSync(temporaryAccountDir, { recursive: true, force: true })
  }
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim().replace(/\s+/g, ' ')
  const words = normalized.split(' ')

  for (let len = 1; len * 2 <= words.length; len += 1) {
    if (words.length !== len * 2) continue
    const first = words.slice(0, len).join(' ')
    const second = words.slice(len).join(' ')
    if (first === second) return first
  }

  return normalized
}

async function rollbackRegistration(store: AccountStore, name: string): Promise<void> {
  await store.withLock(() => {
    const registry = store.read()
    const accounts = registry.accounts.filter((account) => account.name !== name)
    if (accounts.length === registry.accounts.length) return
    const current_account = registry.current_account === name
      ? accounts[0]?.name ?? null
      : registry.current_account
    store.write({ ...registry, accounts, current_account })
  })
}

function moveSession(source: string, destination: string): void {
  if (!existsSync(source)) {
    throwCodeError('account_store_error', `Missing temporary session file: ${source}`)
  }

  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination)) {
    rmSync(destination, { force: true })
  }
  renameSync(source, destination)
}

function unwrapFailure(error: unknown, fallbackCode: string): HandlerResult<never> {
  const message = errorMessage(error)
  const coded = error as CodedError
  const code = typeof coded.code === 'string' && coded.code.length > 0
    ? coded.code
    : fallbackCode

  return {
    ok: false,
    error: {
      code,
      message,
    },
  }
}

function throwCodeError(code: string, message: string): never {
  const error = new Error(message) as CodedError
  error.code = code
  throw error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
