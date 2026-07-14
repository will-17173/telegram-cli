import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultStaticDir, startWebServer } from '../../src/web/server.js'
import { serveStatic } from '../../src/web/static.js'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-web-server-'))
  roots.push(root)
  const distWeb = join(root, 'dist-web')
  mkdirSync(join(distWeb, 'assets'), { recursive: true })
  writeFileSync(join(distWeb, 'index.html'), '<!doctype html><div id="root">app</div>')
  writeFileSync(join(distWeb, 'assets', 'app.js'), 'console.log("app")')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('startWebServer', () => {
  it('defaults static assets to the web module directory', () => {
    expect(defaultStaticDir().endsWith('/src/web')).toBe(true)
    expect(defaultStaticDir().endsWith('/src/web/web')).toBe(false)
  })

  it('serves health and the app shell on localhost', async () => {
    const root = makeRoot()
    const server = await startWebServer({ port: 0, dataDir: root, staticDir: join(root, 'dist-web') })
    try {
      expect(server.host).toBe('127.0.0.1')
      const health = await fetch(`${server.url}api/health`)
      await expect(health.json()).resolves.toEqual({ ok: true, data: { status: 'ok' } })

      const app = await fetch(server.url)
      expect(app.headers.get('content-type')).toContain('text/html')
      expect(await app.text()).toContain('<div id="root">app</div>')
    } finally {
      await server.close()
    }
  })

  it('serves assets without allowing path traversal outside the static directory', async () => {
    const root = makeRoot()
    await expect(serveStatic(join(root, 'dist-web'), '/../secret.txt')).resolves.toBeNull()

    const server = await startWebServer({ port: 0, dataDir: root, staticDir: join(root, 'dist-web') })
    try {
      const asset = await fetch(`${server.url}assets/app.js`)
      expect(asset.headers.get('content-type')).toContain('text/javascript')
      expect(await asset.text()).toBe('console.log("app")')

      const traversal = await fetch(`${server.url}../secret.txt`)
      expect(await traversal.text()).not.toContain('secret')
    } finally {
      await server.close()
    }
  })
})
