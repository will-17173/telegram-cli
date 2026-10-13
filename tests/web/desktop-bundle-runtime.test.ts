import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { preparePortableBundle } from '../../desktop/scripts/bundle-runtime.js'

describe('portable desktop bundle', () => {
  it('loads WASM and native assets from an app path with spaces and Unicode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tg-portable-bundle-'))
    const app = join(directory, 'Telegram CLI 测试.app', 'Contents', 'Resources', 'dist-bundle')
    try {
      await mkdir(join(app, 'build', 'Release'), { recursive: true })
      await writeFile(join(app, 'mtcute.wasm'), 'wasm fixture')
      await writeFile(join(app, 'build', 'Release', 'better_sqlite3.node'), 'native fixture')
      const fixture = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function __WEBPACK_EXTERNAL_createRequire() { return filename => readFileSync(filename, 'utf8') }
const __nccwpck_require__ = {}
if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = new URL('.', import.meta.url).pathname.slice(import.meta.url.match(/^file:\\/\\/\\/\\w:/) ? 1 : 0, -1) + "/";
export const wasm = readFileSync(__nccwpck_require__.ab + 'mtcute.wasm', 'utf8')
export const native = eval("require")("/missing/developer/node_modules/better-sqlite3/build/Release/better_sqlite3.node")
`
      const entry = join(app, 'index.mjs')
      await writeFile(entry, preparePortableBundle(fixture), 'utf8')
      const loaded = await import(pathToFileURL(entry).href) as { wasm: string; native: string }
      expect(loaded).toMatchObject({ wasm: 'wasm fixture', native: 'native fixture' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops the build when ncc changes its asset path format', () => {
    expect(() => preparePortableBundle('export const unrecognized = true')).toThrow('Cannot locate ncc asset base')
  })
})
