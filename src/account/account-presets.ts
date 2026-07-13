import { join } from 'node:path'

import type { AccountAuthState, AccountMeta } from './account-store.js'

export type AccountContext = {
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
    account: accountCopy,
    sessionPath: accountSessionPath(dataDir, account.name),
    dbPath: accountDbPath(dataDir, account.name),
  })
}

export function accountSessionPath(dataDir: string, accountName: string): string {
  return join(dataDir, 'accounts', accountName, 'session')
}

export function accountDbPath(dataDir: string, accountName: string): string {
  return join(dataDir, 'accounts', accountName, 'messages.db')
}
