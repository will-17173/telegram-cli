import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

export async function serveStatic(staticDir: string, pathname: string): Promise<Response | null> {
  if (hasUnsafeSegment(pathname)) return null

  const root = resolve(staticDir)
  const cleanPath = pathname === '/' ? '/index.html' : pathname
  const target = resolve(join(root, normalize(cleanPath)))
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null

  const file = existingFile(target) ?? existingFile(join(root, 'index.html'))
  if (file == null) return null

  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
    headers: { 'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream' },
  })
}

function existingFile(path: string): string | undefined {
  return existsSync(path) && statSync(path).isFile() ? path : undefined
}

function hasUnsafeSegment(pathname: string): boolean {
  return pathname.split('/').some((segment) => safeDecode(segment) === '..')
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
