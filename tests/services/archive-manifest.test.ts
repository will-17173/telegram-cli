import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readArchiveManifest,
  validateArchiveAccount,
  writeArchiveManifest,
} from '../../src/services/archive-manifest.js'
import type { ArchiveManifest } from '../../src/services/archive-types.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-cli-archive-'))
  temporaryDirectories.push(directory)
  return directory
}

function manifestFor(userId: number): ArchiveManifest {
  return {
    schema_version: 1,
    account_name: 'main',
    account_user_id: userId,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    chats: {
      '-100123': {
        title: 'Team / Ops',
        file: '-100123-team-ops.md',
        initial_since: '2025-01-01T00:00:00.000Z',
        initial_until: null,
        full_history: false,
        last_message_id: 42,
        last_message_date: '2025-02-01T00:00:00.000Z',
        last_run: '2026-07-02T00:00:00.000Z',
      },
      '-100124': {
        title: 'Full history',
        file: '-100124-full-history.md',
        initial_since: null,
        initial_until: null,
        full_history: true,
        last_message_id: null,
        last_message_date: null,
        last_run: '2026-07-02T00:00:00.000Z',
      },
    },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('archive manifest', () => {
  it('returns null when the manifest does not exist', () => {
    const missingPath = join(temporaryDirectory(), 'archive-manifest.json')

    expect(readArchiveManifest(missingPath)).toBeNull()
  })

  it('rejects malformed JSON', () => {
    const path = join(temporaryDirectory(), 'archive-manifest.json')
    writeFileSync(path, '{not-json')

    expect(() => readArchiveManifest(path)).toThrow('archive_manifest_invalid')
  })

  it('rejects unsupported schema versions', () => {
    const path = join(temporaryDirectory(), 'archive-manifest.json')
    writeFileSync(path, JSON.stringify({ ...manifestFor(42), schema_version: 2 }))

    expect(() => readArchiveManifest(path)).toThrow('archive_schema_unsupported')
  })

  it.each([
    ['root value', null],
    ['account name', { ...manifestFor(42), account_name: '' }],
    ['account ID', { ...manifestFor(42), account_user_id: 42.5 }],
    ['created timestamp', { ...manifestFor(42), created_at: 7 }],
    ['chat map', { ...manifestFor(42), chats: [] }],
    ['chat title', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], title: '' } },
    }],
    ['chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '../unsafe.md' } },
    }],
    ['range value', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], initial_since: 12 } },
    }],
    ['history flag', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], full_history: 'yes' } },
    }],
    ['message ID', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_message_id: 1.5 } },
    }],
    ['message date', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_message_date: 10 } },
    }],
    ['last run', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_run: null } },
    }],
  ])('rejects an invalid %s', (_description, value) => {
    const path = join(temporaryDirectory(), 'archive-manifest.json')
    writeFileSync(path, JSON.stringify(value))

    expect(() => readArchiveManifest(path)).toThrow('archive_manifest_invalid')
  })

  it('rejects an account ID mismatch but permits account renames', () => {
    const manifest = manifestFor(42)

    expect(() => validateArchiveAccount(manifest, { userId: 99, name: 'other' }))
      .toThrow('archive_account_mismatch')
    expect(() => validateArchiveAccount(manifest, { userId: 42, name: 'renamed' }))
      .not.toThrow()
  })

  it('writes atomically with private permissions and preserves initial options', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'archive-manifest.json')
    const manifest = manifestFor(42)

    writeArchiveManifest(path, manifest)

    expect(readArchiveManifest(path)).toEqual(manifest)
    expect(readArchiveManifest(path)?.chats['-100123']).toMatchObject({
      initial_since: '2025-01-01T00:00:00.000Z',
      initial_until: null,
      full_history: false,
    })
    expect(readArchiveManifest(path)?.chats['-100124']).toMatchObject({
      initial_since: null,
      initial_until: null,
      full_history: true,
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toEqual(['archive-manifest.json'])
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(manifest, null, 2)}\n`)
  })

  it('replaces a permissive existing manifest with private permissions', () => {
    const path = join(temporaryDirectory(), 'archive-manifest.json')
    writeFileSync(path, '{}')
    chmodSync(path, 0o644)

    writeArchiveManifest(path, manifestFor(42))

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
