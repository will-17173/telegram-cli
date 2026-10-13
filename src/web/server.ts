import { existsSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { getDataDir } from '../config/env.js'
import { AccountReservations } from './account-reservations.js'
import { RequestClients } from './request-clients.js'
import { DesktopAuthManager } from './auth-manager.js'
import { DesktopTaskRunner } from './command-tasks.js'
import { DesktopGuardManager } from './guard-manager.js'
import { handleApiRequest } from './api.js'
import { serveStatic } from './static.js'
import { SyncTaskRunner } from './sync-task.js'

const DEFAULT_PORT = 8734
const HOST = '127.0.0.1'

export type WebServerHandle = {
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

export async function startWebServer(options: { port?: number; dataDir?: string; staticDir?: string; guardOnly?: boolean; allowedOrigins?: readonly string[] } = {}): Promise<WebServerHandle> {
  const dataDir = options.dataDir ?? getDataDir()
  const staticDir = options.staticDir ?? defaultStaticDir()
  const syncTask = new SyncTaskRunner({ dataDir })
  const accountReservations = new AccountReservations()
  const requestClients = new RequestClients()
  let closing = false
  let taskRunner: DesktopTaskRunner | undefined
  const guardManager: DesktopGuardManager | undefined = options.guardOnly ? undefined : new DesktopGuardManager({
    dataDir,
    isAccountBusy: (account): boolean => authManager.hasActiveSession() || accountReservations.isBusy(account)
      || taskRunner?.list().some((task) => task.status === 'running' && task.account === account) === true
      || (syncTask.getState().status === 'running'),
  })
  const authManager: DesktopAuthManager = new DesktopAuthManager({
    dataDir,
    isBusy: (): boolean => accountReservations.isBusy() || syncTask.getState().status === 'running'
      || guardManager?.isAccountBusy() === true || taskRunner?.list().some((task) => task.status === 'running') === true,
  })
  taskRunner = new DesktopTaskRunner({
    dataDir,
    isAccountBusy: (account) => {
      const sync = syncTask.getState()
      return authManager.hasActiveSession() || guardManager?.isAccountBusy(account) === true
        || accountReservations.isBusy(account)
        || (sync.status === 'running' && (account == null || sync.account === account))
    },
  })
  const allowedOrigins = options.allowedOrigins ?? desktopDevelopmentOrigins()
  let selectedPort = options.port ?? DEFAULT_PORT

  while (true) {
    const server = createServer(async (req, res) => {
      try {
        const request = toWebRequest(req, selectedPort)
        const url = new URL(request.url)
        const response = closing
          ? new Response(JSON.stringify({ ok: false, error: { code: 'workspace_closing', message: 'The workspace is closing.' } }), { status: 503, headers: { 'content-type': 'application/json' } })
          : guardOnlyRedirect(url, options.guardOnly === true)
          ?? (url.pathname.startsWith('/api/')
          ? await handleApiRequest(request, { dataDir, port: selectedPort, syncTask,
            taskRunner: options.guardOnly ? undefined : taskRunner, authManager: options.guardOnly ? undefined : authManager,
            guardManager, accountReservations, requestClients, allowedOrigins })
          : await serveStatic(staticDir, url.pathname) ?? new Response('Not found', { status: 404 }))

        await writeResponse(res, response, req.method === 'HEAD')
      } catch {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Internal server error')
      }
    })

    try {
      await listen(server, selectedPort)
      selectedPort = serverPort(server)
      return {
        host: HOST,
        port: selectedPort,
        url: `http://${HOST}:${selectedPort}/${options.guardOnly === true ? '?guard=1' : ''}`,
        close: async () => {
          closing = true
          const closedServer = close(server)
          const results = await Promise.allSettled([taskRunner!.close(), authManager.close(), guardManager?.close(), syncTask.close(), requestClients.close()])
          await closedServer
          const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
          if (errors.length > 0) throw new AggregateError(errors, 'Unable to close all web workspace resources.')
        },
      }
    } catch (error) {
      await closeIfListening(server)
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && options.port == null) {
        selectedPort += 1
        continue
      }
      await Promise.allSettled([taskRunner.close(), authManager.close(), guardManager?.close(), syncTask.close(), requestClients.close()])
      throw error
    }
  }
}

function desktopDevelopmentOrigins(): string[] {
  const origin = process.env.TG_DESKTOP_DEV_ORIGIN
  return origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173' ? [origin] : []
}

function guardOnlyRedirect(url: URL, guardOnly: boolean): Response | null {
  if (!guardOnly || url.pathname !== '/' || url.searchParams.get('guard') === '1') return null
  const next = new URL(url)
  next.searchParams.set('guard', '1')
  return Response.redirect(next, 302)
}

function toWebRequest(req: IncomingMessage, port: number): Request {
  const method = req.method ?? 'GET'
  const host = req.headers.host ?? `${HOST}:${port}`
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: headersInit(req.headers),
  }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    init.duplex = 'half'
  }
  return new Request(`http://${host}${req.url ?? '/'}`, init)
}

function headersInit(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result.set(key, value)
    } else if (Array.isArray(value)) {
      for (const item of value) result.append(key, item)
    }
  }
  return result
}

async function writeResponse(res: ServerResponse, response: Response, headOnly: boolean): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (headOnly) {
    await response.body?.cancel()
    res.end()
    return
  }
  if (response.body == null) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    res.write(chunk.value)
  }
  res.end()
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function serverPort(server: Server): number {
  const address = server.address()
  if (typeof address === 'object' && address != null) return address.port
  throw new Error('Web server did not expose a listening port.')
}

export function defaultStaticDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  if (moduleDir.endsWith('/src/web')) return resolve(moduleDir, '../../dist/web')
  const colocatedIndex = resolve(moduleDir, 'index.html')
  if (existsSync(colocatedIndex)) return moduleDir
  return resolve(moduleDir, '../../dist/web')
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error == null ? resolve() : reject(error))
  })
}

async function closeIfListening(server: Server): Promise<void> {
  if (!server.listening) return
  await close(server)
}
