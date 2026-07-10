import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MissingCredentialsError,
  readCredentials,
  validateCredentials,
  writeCredentials,
} from '../../src/config/credential-store.js'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
  tempDirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-credential-store-test-'))
  tempDirs.push(dir)
  return dir
}

describe('credential store', () => {
  it('writes and reads normalized credentials', () => {
    const path = join(tempDir(), 'nested', 'config.json')
    const credentials = validateCredentials({ apiId: ' 12345 ', apiHash: ' secret ' })

    writeCredentials(path, credentials)

    expect(readCredentials(path)).toEqual({ apiId: 12345, apiHash: 'secret' })
  })

  it('persists the documented JSON shape with a trailing newline', () => {
    const path = join(tempDir(), 'config.json')

    writeCredentials(path, { apiId: 12345, apiHash: 'secret' })

    const contents = readFileSync(path, 'utf8')
    expect(JSON.parse(contents)).toEqual({ api_id: 12345, api_hash: 'secret' })
    expect(contents.endsWith('\n')).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('sets the credential file mode to 0600', () => {
    const path = join(tempDir(), 'config.json')

    writeCredentials(path, { apiId: 12345, apiHash: 'secret' })

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it.each([
    undefined,
    '',
    '0',
    '-1',
    '1.5',
    '123abc',
    0,
    -1,
    1.5,
  ])('rejects invalid API ID %j', (apiId) => {
    expect(() => validateCredentials({ apiId, apiHash: 'secret' })).toThrow(
      'API ID must be a positive integer.',
    )
  })

  it.each([undefined, '', '   '])('rejects missing API hash %j', (apiHash) => {
    expect(() => validateCredentials({ apiId: '12345', apiHash })).toThrow(
      'API hash is required.',
    )
  })

  it('throws MissingCredentialsError when the file is missing', () => {
    const path = join(tempDir(), 'missing.json')

    expect(() => readCredentials(path)).toThrow(MissingCredentialsError)
    expect(() => readCredentials(path)).toThrow(
      'Telegram API credentials are not configured. Run tg config set --api-id <id> --api-hash <hash>.',
    )
  })

  it.each([
    '{not json',
    'null',
    '[]',
    '{}',
    '{"api_id":0,"api_hash":"secret"}',
    '{"api_id":12345,"api_hash":"   "}',
  ])('rejects malformed stored configuration: %s', (contents) => {
    const path = join(tempDir(), 'config.json')
    writeFileSync(path, contents)

    try {
      readCredentials(path)
      expect.unreachable('expected malformed configuration to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(MissingCredentialsError)
      expect((error as Error).message).toBe('Stored Telegram API configuration is invalid.')
    }
  })

  it('does not classify an unreadable configuration path as missing', () => {
    const path = join(tempDir(), 'config.json')
    mkdirSync(path)

    try {
      readCredentials(path)
      expect.unreachable('expected unreadable configuration to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(MissingCredentialsError)
      expect((error as Error).message).toBe('Stored Telegram API configuration is invalid.')
    }
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'reports an unreadable credential file as invalid',
    () => {
      const path = join(tempDir(), 'config.json')
      writeFileSync(path, '{}')
      chmodSync(path, 0o000)

      expect(() => readCredentials(path)).toThrow(
        'Stored Telegram API configuration is invalid.',
      )
    },
  )

  it('does not mutate an existing file when validation fails', () => {
    const path = join(tempDir(), 'config.json')
    const original = '{"api_id":54321,"api_hash":"existing"}\n'
    writeFileSync(path, original)

    expect(() => writeCredentials(path, { apiId: 0, apiHash: 'replacement' })).toThrow(
      'API ID must be a positive integer.',
    )

    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('removes the temporary file when replacement fails', () => {
    const dir = tempDir()
    const path = join(dir, 'config.json')
    mkdirSync(path)

    expect(() => writeCredentials(path, { apiId: 12345, apiHash: 'secret' })).toThrow()

    expect(existsSync(path)).toBe(true)
    expect(readdirSync(dir)).toEqual([basename(path)])
  })
})
