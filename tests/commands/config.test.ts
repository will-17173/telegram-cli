import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/cli/app.js'

type RunResult = {
  stdout: string
  stderr: string
  code: number
}

const tempDirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true })
  tempDirs.length = 0
})

describe('config command', () => {
  it('saves a validated credential pair and returns JSON without the hash', async () => {
    const dataDir = tempDir()
    const secret = 'never-print-this-secret'

    const result = await run([
      'config',
      'set',
      '--api-id',
      '12345',
      '--api-hash',
      secret,
      '--json',
    ], dataDir)

    expect(result).toEqual({
      stdout: '{\n  "ok": true,\n  "schema_version": "1",\n  "data": {\n    "configured": true,\n    "api_id": 12345\n  }\n}\n',
      stderr: '',
      code: 0,
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).toEqual({
      api_id: 12345,
      api_hash: secret,
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
  })

  it.each([
    [['--api-hash', 'secret'], 'API ID must be a positive integer.'],
    [['--api-id', '12345'], 'API hash is required.'],
    [['--api-id', 'invalid', '--api-hash', 'secret'], 'API ID must be a positive integer.'],
    [['--api-id', '12345', '--api-hash', '   '], 'API hash is required.'],
  ])('returns invalid_config without writing for arguments %j', async (flags, message) => {
    const dataDir = tempDir()

    const result = await run(['config', 'set', ...flags, '--json'], dataDir)

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', message },
    })
    expect(result.stderr).toBe('')
    expect(existsSync(join(dataDir, 'config.json'))).toBe(false)
  })

  it('rejects JSON and YAML together before mutating credentials', async () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'config.json')
    const original = '{"api_id":54321,"api_hash":"existing"}\n'
    writeFileSync(path, original)

    const result = await run([
      'config',
      'set',
      '--api-id',
      '12345',
      '--api-hash',
      'replacement-secret',
      '--json',
      '--yaml',
    ], dataDir)

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: invalid_output_format')
    expect(result.stdout).not.toContain('replacement-secret')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('returns a generic config_write_failed error without exposing the secret', async () => {
    const parent = tempDir()
    const dataDir = join(parent, 'not-a-directory')
    const secret = 'filesystem-secret'
    writeFileSync(dataDir, 'occupied')

    const result = await run([
      'config',
      'set',
      '--api-id',
      '12345',
      '--api-hash',
      secret,
      '--json',
    ], dataDir)

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      schema_version: '1',
      error: {
        code: 'config_write_failed',
        message: 'Failed to save Telegram API credentials.',
      },
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
  })

  it('prints the human success message', async () => {
    const result = await run([
      'config',
      'set',
      '--api-id',
      '12345',
      '--api-hash',
      'secret',
    ], tempDir(), true)

    expect(result).toEqual({
      stdout: 'Telegram API credentials saved.\n',
      stderr: '',
      code: 0,
    })
  })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-config-command-'))
  tempDirs.push(dir)
  return dir
}

async function run(args: string[], dataDir: string, isTty = false): Promise<RunResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalStdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

  vi.stubEnv('DATA_DIR', dataDir)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTty })
  process.exitCode = 0

  try {
    await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
  } catch (error) {
    if (typeof error === 'object' && error && 'exitCode' in error) {
      process.exitCode = Number((error as { exitCode: number }).exitCode)
    } else {
      throw error
    }
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    if (originalStdoutIsTty) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTty)
    } else {
      delete (process.stdout as Partial<NodeJS.WriteStream>).isTTY
    }
  }

  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    code: Number(process.exitCode ?? 0),
  }
}
