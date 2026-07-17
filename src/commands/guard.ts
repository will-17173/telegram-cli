import type { Command } from 'commander'
import { GuardRuntime } from '../guard/runtime.js'
import { startWebServer } from '../web/server.js'
import type { GuardActionExecutor } from '../guard/action-queue.js'
import type {
  GuardActionRecordInput,
  GuardEventRecord,
  GuardEventRecordInput,
  GuardManagedGroupPatch,
  GuardRuntimeStore,
} from '../guard/runtime.js'
import type { GuardManagedGroup } from '../guard/types.js'

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
      const runtime = new GuardRuntime({
        store: createNoopStore(),
        executor: createNoopExecutor(),
        writeAccess: () => false,
      })
      const server = await startWebServer({ port })
      await runtime.start()
      process.stdout.write(`Telegram Guard: ${server.url}\n`)
      await waitForShutdown(async () => {
        await runtime.stop()
        await server.close()
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

function createNoopStore(): GuardRuntimeStore {
  return {
    listEnabledGroups: () => [],
    listRules: () => [],
    getWarningCount: () => 0,
    getRecentMessages: () => [],
    recordEvent: (input: GuardEventRecordInput): GuardEventRecord => ({ ...input, id: 0 }),
    recordAction: (_input: GuardActionRecordInput) => undefined,
    incrementWarning: () => 0,
    updateManagedGroup: (_id: number, _patch: GuardManagedGroupPatch): GuardManagedGroup | null => null,
    setRuntimeState: () => undefined,
  }
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
