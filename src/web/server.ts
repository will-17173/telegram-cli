import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { getDataDir } from '../config/env.js'
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

export async function startWebServer(options: { port?: number; dataDir?: string; staticDir?: string } = {}): Promise<WebServerHandle> {
  const dataDir = options.dataDir ?? getDataDir()
  const staticDir = options.staticDir ?? defaultStaticDir()
  const syncTask = new SyncTaskRunner({ dataDir })
  let selectedPort = options.port ?? DEFAULT_PORT

  while (true) {
    const server = createServer(async (req, res) => {
      try {
        const request = toWebRequest(req, selectedPort)
        const url = new URL(request.url)
        const response = url.pathname.startsWith('/api/')
          ? await handleApiRequest(request, { dataDir, port: selectedPort, syncTask })
          : await serveStatic(staticDir, url.pathname) ?? new Response('Not found', { status: 404 })

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
        url: `http://${HOST}:${selectedPort}/`,
        close: () => close(server),
      }
    } catch (error) {
      await closeIfListening(server)
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && options.port == null) {
        selectedPort += 1
        continue
      }
      throw error
    }
  }
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
  return dirname(fileURLToPath(import.meta.url))
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
