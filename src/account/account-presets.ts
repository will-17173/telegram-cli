import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { AccountAuthState, AccountMeta } from './account-store.js'
import { assertSafeAccountName } from './account-name.js'

export type AccountContext = {
  name: string
  authState: AccountAuthState
  account: {
    name: string
    user_id: number
    username: string
    phone: string
    display_name: string
    auth_state: AccountAuthState
  }
  sessionPath: string
  dbPath: string
}

export function toAccountContext(dataDir: string, account: AccountMeta): AccountContext {
  const accountCopy = Object.freeze({
    name: account.name,
    user_id: account.user_id,
    username: account.username,
    phone: account.phone,
    display_name: account.display_name,
    auth_state: account.auth_state,
  })

  return Object.freeze({
    name: account.name,
    authState: account.auth_state,
    account: accountCopy,
    sessionPath: accountSessionPath(dataDir, account.name),
    dbPath: accountDbPath(dataDir, account.name),
  })
}

export function accountSessionPath(dataDir: string, accountName: string): string {
  return join(accountRootPath(dataDir, accountName), 'session')
}

export function accountDbPath(dataDir: string, accountName: string): string {
  return join(accountRootPath(dataDir, accountName), 'messages.db')
}

export function accountArchivePath(dataDir: string, accountName: string): string {
  return join(accountRootPath(dataDir, accountName), 'archive')
}

export function accountRootPath(dataDir: string, accountName: string): string {
  assertSafeAccountName(accountName)
  const accountsRoot = resolve(dataDir, 'accounts')
  const root = resolve(accountsRoot, accountName)
  const contained = relative(accountsRoot, root)
  if (contained.length === 0
    || contained === '..'
    || contained.startsWith(`..${sep}`)
    || isAbsolute(contained)) {
    throw new Error('account_store_error: invalid account name')
  }
  return root
}
