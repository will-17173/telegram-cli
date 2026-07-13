import {
  chmodSync,
  mkdirSync,
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
    ['non-positive account ID', { ...manifestFor(42), account_user_id: 0 }],
    ['created timestamp', { ...manifestFor(42), created_at: 7 }],
    ['malformed created timestamp', { ...manifestFor(42), created_at: 'yesterday' }],
    ['malformed updated timestamp', { ...manifestFor(42), updated_at: '2026-02-30T00:00:00Z' }],
    ['chat map', { ...manifestFor(42), chats: [] }],
    ['non-numeric chat key', {
      ...manifestFor(42),
      chats: { team: manifestFor(42).chats['-100123'] },
    }],
    ['zero chat key', {
      ...manifestFor(42),
      chats: { '0': manifestFor(42).chats['-100123'] },
    }],
    ['chat title', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], title: '' } },
    }],
    ['chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '../unsafe.md' } },
    }],
    ['reserved chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: 'CON' } },
    }],
    ['trailing-dot chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: 'chat.md.' } },
    }],
    ['chat file with reserved characters', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: 'team:ops.md' } },
    }],
    ['oversized chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: `${'文'.repeat(100)}.md` } },
    }],
    ['manifest reserved chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: 'archive-manifest.json' } },
    }],
    ['non-Markdown chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '-100123-team.txt' } },
    }],
    ['wrong-chat file prefix', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '-100124-team.md' } },
    }],
    ['ambiguous chat file prefix', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '-1001234-team.md' } },
    }],
    ['bare chat ID file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '-100123-.md' } },
    }],
    ['non-canonical chat file case', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '-100123-Team.md' } },
    }],
    ['non-normalized chat file', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], file: '-100123-te\u0301am.md' } },
    }],
    ['range value', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], initial_since: 12 } },
    }],
    ['malformed initial timestamp', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], initial_since: '2025-13-01T00:00:00Z' } },
    }],
    ['history flag', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], full_history: 'yes' } },
    }],
    ['message ID', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_message_id: 1.5 } },
    }],
    ['non-positive message ID', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_message_id: 0 } },
    }],
    ['message date', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_message_date: 10 } },
    }],
    ['malformed message date', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_message_date: 'soon' } },
    }],
    ['last run', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_run: null } },
    }],
    ['malformed last run', {
      ...manifestFor(42),
      chats: { '-100123': { ...manifestFor(42).chats['-100123'], last_run: '' } },
    }],
  ])('rejects an invalid %s', (_description, value) => {
    const path = join(temporaryDirectory(), 'archive-manifest.json')
    writeFileSync(path, JSON.stringify(value))

    expect(() => readArchiveManifest(path)).toThrow('archive_manifest_invalid')
  })

  it.each([
    ['exact duplicate', '-100123-team-ops.md'],
    ['portable case alias', '-100123-TEAM-OPS.md'],
    ['portable normalization alias', '-100123-te\u0301am.md'],
  ])('rejects a duplicate destination via %s', (_description, alias) => {
    const path = join(temporaryDirectory(), 'archive-manifest.json')
    const manifest = manifestFor(42)
    manifest.chats['-100124'] = {
      ...manifest.chats['-100124']!,
      file: alias,
    }
    if (_description === 'portable normalization alias') {
      manifest.chats['-100123'] = {
        ...manifest.chats['-100123']!,
        file: '-100123-t\u00e9am.md',
      }
    }
    writeFileSync(path, JSON.stringify(manifest))

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

  it('cleans up its temp file and preserves an existing target when rename fails', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'archive-manifest.json')
    mkdirSync(path)
    writeFileSync(join(path, 'sentinel'), 'keep')

    expect(() => writeArchiveManifest(path, manifestFor(42))).toThrow()

    expect(readFileSync(join(path, 'sentinel'), 'utf8')).toBe('keep')
    expect(readdirSync(directory)).toEqual(['archive-manifest.json'])
  })

  it('preserves an existing manifest when replacement validation fails', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'archive-manifest.json')
    const original = manifestFor(42)
    writeArchiveManifest(path, original)

    expect(() => writeArchiveManifest(path, {
      ...original,
      account_user_id: 0,
    })).toThrow('archive_manifest_invalid')

    expect(readArchiveManifest(path)).toEqual(original)
    expect(readdirSync(directory)).toEqual(['archive-manifest.json'])
  })
})
