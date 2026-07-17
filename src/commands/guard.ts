import { join } from 'node:path'
import type { Command } from 'commander'
import { getDataDir } from '../config/env.js'
import { GuardRuntime } from '../guard/runtime.js'
import { WriteAccessPolicy } from '../services/write-access-policy.js'
import { GuardDB } from '../storage/guard-db.js'
import { startWebServer } from '../web/server.js'
import type { GuardActionExecutor } from '../guard/action-queue.js'
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
      const runtime = new GuardRuntime({
        store,
        executor: createNoopExecutor(),
        writeAccess: () => writePolicy.check().ok,
      })
      let server: WebServerHandle | undefined
      try {
        server = await startWebServer({ port, dataDir })
        await runtime.start()
      } catch (error) {
        await closeAfterStartupFailure({ server, store }, error)
        throw error
      }
      process.stdout.write(`Telegram Guard: ${server.url}\n`)
      await waitForShutdown(async () => {
        await stopRuntimeCloseStoreAndServer(runtime, store, server)
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

function createNoopExecutor(): GuardActionExecutor {
  return {
    deleteMessage: async () => undefined,
    muteMember: async () => undefined,
    banMember: async () => undefined,
    reply: async () => undefined,
    sendMessage: async () => undefined,
  }
}

async function closeAfterStartupFailure(
  resources: { server?: WebServerHandle; store: Pick<GuardDB, 'close'> },
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
  server: WebServerHandle,
): Promise<void> {
  const errors: unknown[] = []
  try {
    await runtime.stop()
  } catch (error) {
    errors.push(error)
  }

  errors.push(...await cleanupGuardResources({ server, store }))
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Failed to stop guard runtime and clean up resources')
}

async function cleanupGuardResources(resources: { server?: WebServerHandle; store: Pick<GuardDB, 'close'> }): Promise<unknown[]> {
  const errors: unknown[] = []
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
