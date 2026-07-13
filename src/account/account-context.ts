import { getAccountRegistryPath, getDataDir } from '../config/env.js'
import { AccountStore } from './account-store.js'
import type { AccountContext } from './account-presets.js'
import { toAccountContext } from './account-presets.js'

export type AccountResolutionInput = {
  explicitName?: string
  dataDir?: string
}

export function resolveAccountContext(input: AccountResolutionInput = {}): AccountContext {
  const dataDir = input.dataDir?.trim() ? input.dataDir.trim() : getDataDir()
  const store = new AccountStore(getAccountRegistryPath(dataDir))
  const registry = store.read()
  const name = explicitOrCurrent(input.explicitName, registry.current_account)

  if (!name) {
    throw new Error('account_required: no active account found')
  }

  const account = store.get(name)
  if (!account) {
    throw new Error(`account_not_found: account "${name}"`)
  }

  return toAccountContext(dataDir, account)
}

export function resolveAuthenticatedAccountContext(input: AccountResolutionInput = {}): AccountContext {
  const context = resolveAccountContext(input)
  if (context.authState === 'logged_out') {
    throw new Error(`account_logged_out: account "${context.name}" is logged out`)
  }

  return context
}

function explicitOrCurrent(explicitName: string | undefined, currentAccount: string | null): string | undefined {
  const explicit = explicitName?.trim()
  return explicit ? explicit : currentAccount ?? undefined
}
