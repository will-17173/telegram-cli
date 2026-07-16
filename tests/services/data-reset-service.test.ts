import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DataResetService } from '../../src/services/data-reset-service.js'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-data-reset-service-'))
  roots.push(root)
  return root
}

function accountRoot(root: string, account: string): string {
  return join(root, 'accounts', account)
}

function seedAccountData(root: string, account: string): Record<string, string> {
  const dir = accountRoot(root, account)
  mkdirSync(dir, { recursive: true })
  const paths = {
    db: join(dir, 'messages.db'),
    wal: join(dir, 'messages.db-wal'),
    shm: join(dir, 'messages.db-shm'),
    archive: join(dir, 'archive'),
    session: join(dir, 'session'),
    downloads: join(dir, 'downloads'),
    customArchive: join(dir, 'custom-archive'),
  }
  writeFileSync(paths.db, 'db')
  writeFileSync(paths.wal, 'wal')
  writeFileSync(paths.shm, 'shm')
  mkdirSync(paths.archive)
  writeFileSync(join(paths.archive, 'chat.md'), 'archive')
  writeFileSync(paths.session, 'session')
  mkdirSync(paths.downloads)
  writeFileSync(join(paths.downloads, 'photo.jpg'), 'download')
  mkdirSync(paths.customArchive)
  writeFileSync(join(paths.customArchive, 'chat.md'), 'custom archive')
  return paths
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DataResetService', () => {
  it('requires explicit confirmation before deleting account-scoped data', () => {
    const root = makeRoot()
    const paths = seedAccountData(root, 'work')

    const result = new DataResetService({ dataDir: root }).reset({
      accountNames: ['work'],
      confirmed: false,
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'confirmation_required',
        message: 'Pass --yes to delete local message databases and default archives.',
      },
    })
    expect(existsSync(paths.db)).toBe(true)
    expect(existsSync(paths.archive)).toBe(true)
  })

  it('removes database sidecars and the default archive for the current account only', () => {
    const root = makeRoot()
    const work = seedAccountData(root, 'work')
    const personal = seedAccountData(root, 'personal')
    writeFileSync(join(root, 'accounts.json'), 'registry')
    writeFileSync(join(root, 'config.json'), 'config')

    const result = new DataResetService({ dataDir: root }).reset({
      accountNames: ['work'],
      confirmed: true,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        accounts_reset: ['work'],
        removed_paths: expect.arrayContaining([work.db, work.wal, work.shm, work.archive]),
      },
      human: {
        kind: 'text',
        text: 'Reset local data for 1 account.',
      },
    })
    expect(result.ok && result.data.removed_paths).toHaveLength(4)
    expect(existsSync(work.db)).toBe(false)
    expect(existsSync(work.wal)).toBe(false)
    expect(existsSync(work.shm)).toBe(false)
    expect(existsSync(work.archive)).toBe(false)
    expect(existsSync(work.session)).toBe(true)
    expect(existsSync(work.downloads)).toBe(true)
    expect(existsSync(work.customArchive)).toBe(true)
    expect(existsSync(join(root, 'accounts.json'))).toBe(true)
    expect(existsSync(join(root, 'config.json'))).toBe(true)
    expect(existsSync(personal.db)).toBe(true)
  })

  it('resets all requested accounts including logged-out registry entries', () => {
    const root = makeRoot()
    const work = seedAccountData(root, 'work')
    const old = seedAccountData(root, 'old')

    const result = new DataResetService({ dataDir: root }).reset({
      accountNames: ['work', 'old'],
      confirmed: true,
    })

    expect(result).toMatchObject({
      ok: true,
      data: { accounts_reset: ['work', 'old'] },
    })
    expect(existsSync(work.db)).toBe(false)
    expect(existsSync(old.db)).toBe(false)
    expect(existsSync(work.session)).toBe(true)
    expect(existsSync(old.session)).toBe(true)
  })

  it('treats missing reset paths as an idempotent success', () => {
    const root = makeRoot()
    mkdirSync(accountRoot(root, 'work'), { recursive: true })

    const first = new DataResetService({ dataDir: root }).reset({
      accountNames: ['work'],
      confirmed: true,
    })
    const second = new DataResetService({ dataDir: root }).reset({
      accountNames: ['work'],
      confirmed: true,
    })

    expect(first).toEqual({
      ok: true,
      data: { accounts_reset: ['work'], removed_paths: [] },
      human: { kind: 'text', text: 'Reset local data for 1 account.' },
    })
    expect(second).toEqual(first)
  })

  it('unlinks a final default archive symlink without following it', () => {
    const root = makeRoot()
    const outside = makeRoot()
    const dir = accountRoot(root, 'work')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'messages.db'), 'db')
    mkdirSync(join(outside, 'archive-target'))
    writeFileSync(join(outside, 'archive-target', 'keep.md'), 'keep')
    symlinkSync(join(outside, 'archive-target'), join(dir, 'archive'), 'dir')

    const result = new DataResetService({ dataDir: root }).reset({
      accountNames: ['work'],
      confirmed: true,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(join(dir, 'archive'))).toBe(false)
    expect(existsSync(join(outside, 'archive-target', 'keep.md'))).toBe(true)
  })

  it('rejects the whole reset before deletion when an account-root ancestor symlink escapes the data root', () => {
    const root = makeRoot()
    const outside = makeRoot()
    mkdirSync(join(root, 'accounts'), { recursive: true })
    mkdirSync(join(outside, 'escaped'))
    writeFileSync(join(outside, 'escaped', 'messages.db'), 'outside')
    symlinkSync(join(outside, 'escaped'), accountRoot(root, 'work'), 'dir')

    const result = new DataResetService({ dataDir: root }).reset({
      accountNames: ['work'],
      confirmed: true,
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'data_reset_path_unsafe',
      },
    })
    expect(existsSync(join(outside, 'escaped', 'messages.db'))).toBe(true)
  })

  it('rejects unsafe account names during path containment preflight before deleting anything', () => {
    const root = makeRoot()
    const safe = seedAccountData(root, 'safe')

    const result = new DataResetService({ dataDir: root }).reset({
      accountNames: ['safe', '../evil'],
      confirmed: true,
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'data_reset_path_unsafe',
      },
    })
    expect(existsSync(safe.db)).toBe(true)
    expect(existsSync(safe.archive)).toBe(true)
  })

  it('continues after partial remove failures and reports precise failure details', () => {
    const root = makeRoot()
    const paths = seedAccountData(root, 'work')
    const removed: string[] = []

    const result = new DataResetService({
      dataDir: root,
      removePath(path) {
        if (path === paths.wal) {
          const error = new Error('permission denied') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        }
        rmSync(path, { recursive: true, force: true })
        removed.push(path)
      },
    }).reset({ accountNames: ['work'], confirmed: true })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'data_reset_partial_failure',
        message: 'Some local data could not be reset.',
        details: {
          accounts_reset: ['work'],
          removed_paths: expect.arrayContaining([paths.db, paths.shm, paths.archive]),
          failures: [{
            account: 'work',
            path: paths.wal,
            code: 'EACCES',
            message: 'permission denied',
          }],
        },
      },
    })
    expect(removed).toEqual(expect.arrayContaining([paths.db, paths.shm, paths.archive]))
    expect(existsSync(paths.db)).toBe(false)
    expect(existsSync(paths.shm)).toBe(false)
    expect(existsSync(paths.archive)).toBe(false)
    expect(existsSync(paths.wal)).toBe(true)
  })

  it('accepts a symlinked data root when targets stay inside the real data root', () => {
    const realRoot = makeRoot()
    const linkParent = makeRoot()
    const linkedRoot = join(linkParent, 'data')
    symlinkSync(realRoot, linkedRoot, 'dir')
    const paths = seedAccountData(realRoot, 'work')

    const result = new DataResetService({ dataDir: linkedRoot }).reset({
      accountNames: ['work'],
      confirmed: true,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(paths.db)).toBe(false)
    expect(realpathSync(linkedRoot)).toBe(realpathSync(realRoot))
    expect(lstatSync(linkedRoot).isSymbolicLink()).toBe(true)
  })
})
