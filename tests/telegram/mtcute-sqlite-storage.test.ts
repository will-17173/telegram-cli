import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MtcuteSqliteStorage, MtcuteSqliteStorageDriver } from '../../src/telegram/mtcute-sqlite-storage.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('MtcuteSqliteStorage', () => {
  it('uses the Node 24-compatible better-sqlite3 major', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(packageJson.dependencies?.['better-sqlite3']).toMatch(/^\^13\./)
  })

  it('opens mtcute sessions through the application SQLite dependency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-cli-mtcute-storage-test-'))
    tempDirs.push(dir)
    const filename = join(dir, 'session')
    const storage = new MtcuteSqliteStorage(filename)
    const driver = storage.driver as MtcuteSqliteStorageDriver

    expect(storage.filename).toBe(filename)
    expect(driver.filename).toBe(filename)

    const db = driver._createDatabase()
    db.exec('create table check_storage (value text not null)')
    db.close()
  })
})
