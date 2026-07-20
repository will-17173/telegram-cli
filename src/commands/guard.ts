import { join } from 'node:path'
import type { Command } from 'commander'
import { resolveAuthenticatedAccountContext } from '../account/account-context.js'
import { getDataDir } from '../config/env.js'
import { GuardRuntime } from '../guard/runtime.js'
import { WriteAccessPolicy } from '../services/write-access-policy.js'
import { GuardDB } from '../storage/guard-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import { GuardTelegramClientCache, MtcuteGuardExecutor, MtcuteGuardListener } from '../telegram/mtcute-guard.js'
import { startWebServer } from '../web/server.js'
import type { WebServerHandle } from '../web/server.js'

export type GuardStartOptions = {
  port?: string
}

export function registerGuardCommand(app: Command): void {
  const guardCommand = app.command('guard')
    .description('Manage Telegram group automation guards')

  guardCommand.command('start')
    .description('Start the local Telegram Guard daemon')
    .option('--port <port>', 'Local port to listen on, starting from 8734 when omitted')
    .action(async (options: GuardStartOptions) => {
      const port = parsePort(options.port)
      const dataDir = getDataDir()
      const store = new GuardDB(join(dataDir, 'guard.db'))
      const writePolicy = new WriteAccessPolicy()
      const clients = new GuardTelegramClientCache((account) => {
        const context = resolveAuthenticatedAccountContext({ explicitName: account, dataDir })
        return createTelegramClient(context.sessionPath)
      })
      const runtime = new GuardRuntime({
        store,
        executor: new MtcuteGuardExecutor({
          getClient: (account) => clients.getClient(account),
        }),
        listener: new MtcuteGuardListener({
          getClient: (account) => clients.getClient(account),
          currentAccountUserId: async (account) => {
            const client = await clients.getClient(account)
            const user = await client.getCurrentUser?.()
            return user?.id ?? null
          },
        }),
        writeAccess: () => writePolicy.check().ok,
      })
      let server: WebServerHandle | undefined
      try {
        server = await startWebServer({ port, dataDir, guardOnly: true })
        await runtime.start()
      } catch (error) {
        await closeAfterStartupFailure({ server, store, clients }, error)
        throw error
      }
      process.stdout.write(`Telegram Guard: ${server.url}\n`)
      await waitForShutdown(async () => {
        await stopRuntimeCloseStoreAndServer(runtime, store, clients, server)
      })
    })
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  if (!/^\d+$/.test(raw)) throw new Error('--port must be a positive integer')
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be a positive integer')
  return port
}

async function closeAfterStartupFailure(
  resources: GuardResources,
  startupError: unknown,
): Promise<void> {
  const cleanupErrors = await cleanupGuardResources(resources)
  if (cleanupErrors.length > 0) {
    throw new AggregateError([startupError, ...cleanupErrors], 'Failed to start guard runtime and clean up resources')
  }
}

async function stopRuntimeCloseStoreAndServer(
  runtime: Pick<GuardRuntime, 'stop'>,
  store: Pick<GuardDB, 'close'>,
  clients: Pick<GuardTelegramClientCache, 'close'>,
  server: WebServerHandle,
): Promise<void> {
  const errors: unknown[] = []
  try {
    await runtime.stop()
  } catch (error) {
    errors.push(error)
  }

  errors.push(...await cleanupGuardResources({ server, store, clients }))
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Failed to stop guard runtime and clean up resources')
}

type GuardResources = {
  server?: WebServerHandle
  store: Pick<GuardDB, 'close'>
  clients: Pick<GuardTelegramClientCache, 'close'>
}

async function cleanupGuardResources(resources: GuardResources): Promise<unknown[]> {
  const errors: unknown[] = []
  try {
    await resources.clients.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    resources.store.close()
  } catch (error) {
    errors.push(error)
  }
  if (resources.server == null) return errors
  try {
    await resources.server.close()
  } catch (error) {
    errors.push(error)
  }
  return errors
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
