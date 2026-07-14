import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeConfiguration } from '../../src/config/credential-store.js'
import { createApp } from '../../src/cli/app.js'

type RunResult = {
  stdout: string
  stderr: string
  code: number
}

const tempDirs: string[] = []

beforeEach(() => {
  vi.stubEnv('TG_API_ID', '')
  vi.stubEnv('TG_API_HASH', '')
  vi.stubEnv('TG_PROXY', '')
})

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

  it('saves a proxy without exposing its URL or secret', async () => {
    const dataDir = tempDir()
    const proxy = 'socks5://proxy-user:proxy-secret@127.0.0.1:1080'

    const result = await run(['config', 'set', '--proxy', proxy, '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: { configured: true, proxy_configured: true },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).toEqual({ proxy })
    expect(`${result.stdout}${result.stderr}`).not.toContain(proxy)
    expect(`${result.stdout}${result.stderr}`).not.toContain('proxy-secret')
  })

  it('updates a proxy while preserving existing credentials', async () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'config.json')
    const proxy = 'socks5://127.0.0.1:1081'
    writeFileSync(path, '{"api_id":54321,"api_hash":"existing-secret","proxy":"socks5://127.0.0.1:1080"}\n')

    const result = await run(['config', 'set', '--proxy', proxy, '--json'], dataDir)

    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      api_id: 54321,
      api_hash: 'existing-secret',
      proxy,
    })
  })

  it('updates credentials while preserving an existing proxy', async () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'config.json')
    const proxy = 'socks5://127.0.0.1:1080'
    writeFileSync(path, `{"api_id":54321,"api_hash":"existing","proxy":"${proxy}"}\n`)

    const result = await run([
      'config',
      'set',
      '--api-id',
      '12345',
      '--api-hash',
      'replacement-secret',
      '--json',
    ], dataDir)

    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      api_id: 12345,
      api_hash: 'replacement-secret',
      proxy,
    })
  })

  it('saves credentials and proxy together', async () => {
    const dataDir = tempDir()
    const proxy = 'socks5://127.0.0.1:1080'

    const result = await run([
      'config',
      'set',
      '--api-id',
      '12345',
      '--api-hash',
      'secret',
      '--proxy',
      proxy,
      '--json',
    ], dataDir)

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: { configured: true, api_id: 12345, proxy_configured: true },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).toEqual({
      api_id: 12345,
      api_hash: 'secret',
      proxy,
    })
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

  it('rejects an invocation with no configurable values', async () => {
    const dataDir = tempDir()

    const result = await run(['config', 'set', '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_config',
        message: 'Provide API credentials, a proxy, or both.',
      },
    })
    expect(existsSync(join(dataDir, 'config.json'))).toBe(false)
  })

  it.each([
    'ftp://proxy-user:proxy-secret@127.0.0.1:21',
    'not-a-proxy://proxy-secret',
  ])('rejects an invalid or unsupported proxy without writing or leaking it', async (proxy) => {
    const dataDir = tempDir()
    const path = join(dataDir, 'config.json')
    const original = '{"api_id":54321,"api_hash":"existing"}\n'
    writeFileSync(path, original)

    const result = await run(['config', 'set', '--proxy', proxy, '--json'], dataDir)

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_config',
        message: 'Telegram proxy configuration is invalid.',
      },
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain(proxy)
    expect(`${result.stdout}${result.stderr}`).not.toContain('proxy-secret')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('validates all supplied groups before writing', async () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'config.json')
    const original = '{"proxy":"socks5://127.0.0.1:1080"}\n'
    writeFileSync(path, original)

    const result = await run([
      'config',
      'set',
      '--api-id',
      '12345',
      '--proxy',
      'socks5://127.0.0.1:1081',
      '--json',
    ], dataDir)

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'invalid_config', message: 'API hash is required.' },
    })
    expect(readFileSync(path, 'utf8')).toBe(original)
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

  it('rejects JSON and YAML together before mutating a proxy', async () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'config.json')
    const original = '{"proxy":"socks5://127.0.0.1:1080"}\n'
    writeFileSync(path, original)

    const result = await run([
      'config',
      'set',
      '--proxy',
      'socks5://proxy-secret@127.0.0.1:1081',
      '--json',
      '--yaml',
    ], dataDir)

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: invalid_output_format')
    expect(result.stdout).not.toContain('proxy-secret')
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
        message: 'Failed to save Telegram configuration.',
      },
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
  })

  it('returns a generic write error without exposing a proxy', async () => {
    const parent = tempDir()
    const dataDir = join(parent, 'not-a-directory')
    const proxy = 'socks5://proxy-user:proxy-secret@127.0.0.1:1080'
    writeFileSync(dataDir, 'occupied')

    const result = await run(['config', 'set', '--proxy', proxy, '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      schema_version: '1',
      error: {
        code: 'config_write_failed',
        message: 'Failed to save Telegram configuration.',
      },
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain(proxy)
    expect(`${result.stdout}${result.stderr}`).not.toContain('proxy-secret')
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

  it.each([
    [['--proxy', 'socks5://127.0.0.1:1080'], 'Telegram proxy saved.'],
    [[
      '--api-id',
      '12345',
      '--api-hash',
      'secret',
      '--proxy',
      'socks5://127.0.0.1:1080',
    ], 'Telegram API credentials and proxy saved.'],
  ])('prints the human success message for arguments %j', async (flags, message) => {
    const result = await run(['config', 'set', ...flags], tempDir(), true)

    expect(result).toEqual({ stdout: `${message}\n`, stderr: '', code: 0 })
  })

  it('returns write-access status by default and marks no mutation', async () => {
    const dataDir = tempDir()
    writeConfiguration(join(dataDir, 'config.json'), { writeAccess: false })

    const result = await run(['config', 'write-access', '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: {
        write_access: false,
        changed: false,
      },
    })
    expect(result.code).toBe(0)
  })

  it.each([
    ['on', true],
    ['off', false],
  ])('sets write access with %s', async (action, value) => {
    const dataDir = tempDir()
    const path = join(dataDir, 'config.json')
    writeConfiguration(path, { writeAccess: false })

    const result = await run(['config', 'write-access', action, '--json'], dataDir)

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: {
        write_access: value,
        changed: true,
      },
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).write_access).toBe(value)
  })

  it('requires a valid write-access action', async () => {
    const dataDir = tempDir()

    const result = await run(['config', 'write-access', 'maybe', '--json'], dataDir)

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      schema_version: '1',
      error: {
        code: 'invalid_config',
        message: 'Action must be one of: status, on, or off.',
      },
    })
  })

  it('documents the supported write-access actions in help', async () => {
    const config = createApp().commands.find(command => command.name() === 'config')
    const writeAccess = config?.commands.find(command => command.name() === 'write-access')

    expect(writeAccess?.helpInformation()).toContain('[status|on|off]')
  })

  it('lists stored values with masked API hash and proxy credentials', async () => {
    const dataDir = tempDir()
    const apiHash = 'stored-api-hash-secret'
    const proxy = 'socks5://proxy-user:proxy-password@127.0.0.1:1080'
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      api_id: 12345,
      api_hash: apiHash,
      proxy,
    }))

    const result = await run(['config', 'list', '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: {
        api_id: 12345,
        api_hash: `${'*'.repeat(apiHash.length - 4)}${apiHash.slice(-4)}`,
        credentials_source: 'stored',
        proxy: 'socks5://***:***@127.0.0.1:1080',
        proxy_source: 'stored',
        write_access: true,
      },
    })
    expect(result).toMatchObject({ stderr: '', code: 0 })
    expect(`${result.stdout}${result.stderr}`).not.toContain(apiHash)
    expect(result.stdout).not.toContain('proxy-user')
    expect(result.stdout).not.toContain('proxy-password')
  })

  it.each([
    {
      label: 'SOCKS userinfo',
      proxy: 'socks5://proxy-user-a:proxy-password-a@127.0.0.1:1080',
      expected: 'socks5://***:***@127.0.0.1:1080',
      sentinels: ['proxy-user-a', 'proxy-password-a'],
    },
    {
      label: 'MTProxy secret',
      proxy: 'mtproxy://127.0.0.1:443?secret=mtproxy-secret-b&mode=compact',
      expected: 'mtproxy://127.0.0.1:443?secret=***&mode=compact',
      sentinels: ['mtproxy-secret-b'],
    },
    {
      label: 'Telegram proxy secret',
      proxy: 'tg://proxy?server=127.0.0.1&port=443&secret=tg-secret-c',
      expected: 'tg://proxy?server=127.0.0.1&port=443&secret=***',
      sentinels: ['tg-secret-c'],
    },
    {
      label: 'encoded userinfo',
      proxy: 'socks5://encoded%20user:encoded%2Fpassword@127.0.0.1:1080',
      expected: 'socks5://***:***@127.0.0.1:1080',
      sentinels: ['encoded%20user', 'encoded%2Fpassword'],
    },
    {
      label: 'encoded query credentials',
      proxy: 'tg://socks?server=127.0.0.1&port=1080&user=query%20user&pass=query%2Fpassword',
      expected: 'tg://socks?server=127.0.0.1&port=1080&user=***&pass=***',
      sentinels: ['query%20user', 'query%2Fpassword'],
    },
    {
      label: 'credential-free endpoint',
      proxy: 'socks5://127.0.0.1:1080?timeout=30',
      expected: 'socks5://127.0.0.1:1080?timeout=30',
      sentinels: [],
    },
    {
      label: 'malformed credential-bearing input',
      proxy: 'not a proxy?secret=malformed-secret-d&server=127.0.0.1',
      expected: '[invalid proxy URL]',
      sentinels: ['malformed-secret-d'],
    },
  ])('redacts $label without changing safe endpoint details', async ({ proxy, expected, sentinels }) => {
    const dataDir = tempDir()
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      api_id: 12345,
      api_hash: 'safe-test-api-hash',
      proxy,
    }))

    const result = await run(['config', 'list', '--json'], dataDir)
    const actual = JSON.parse(result.stdout).data.proxy

    if (actual !== expected) throw new Error('Proxy redaction output did not match the expected safe shape.')
    if (sentinels.some(sentinel => `${result.stdout}${result.stderr}`.includes(sentinel))) {
      throw new Error('Proxy redaction output contained a credential sentinel.')
    }
  })

  it('uses environment credentials and proxy instead of stored values', async () => {
    const dataDir = tempDir()
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      api_id: 11111,
      api_hash: 'stored-secret',
      proxy: 'socks5://stored-secret@127.0.0.1:1080',
    }))
    vi.stubEnv('TG_API_ID', '22222')
    vi.stubEnv('TG_API_HASH', 'environment-secret')
    vi.stubEnv('TG_PROXY', 'socks5://environment-secret@127.0.0.1:1081')

    const result = await run(['config', 'list', '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: {
        api_id: 22222,
        api_hash: `${'*'.repeat('environment-secret'.length - 4)}cret`,
        credentials_source: 'environment',
        proxy: 'socks5://***@127.0.0.1:1081',
        proxy_source: 'environment',
        write_access: true,
      },
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain('stored-secret')
    expect(result.stdout).not.toContain('environment-secret@')
  })

  it('lists default credentials and no proxy when neither is configured', async () => {
    vi.stubEnv('TG_API_ID', '')
    vi.stubEnv('TG_API_HASH', '')
    vi.stubEnv('TG_PROXY', '')

    const result = await run(['config', 'list', '--json'], tempDir())

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schema_version: '1',
      data: {
        api_id: 2040,
        api_hash: `${'*'.repeat(28)}e627`,
        credentials_source: 'default',
        proxy: null,
        proxy_source: null,
        write_access: true,
      },
    })
  })

  it.each([
    {
      environment: { TG_API_ID: '22222', TG_API_HASH: 'environment-hash', TG_PROXY: '' },
      stored: { api_id: 11111, api_hash: 'stored-hash', proxy: 'socks5://127.0.0.1:1080' },
      expected: { apiId: 22222, credentialsSource: 'environment', proxySource: 'stored' },
    },
    {
      environment: { TG_API_ID: '', TG_API_HASH: '', TG_PROXY: 'socks5://127.0.0.1:1081' },
      stored: { api_id: 11111, api_hash: 'stored-hash', proxy: 'socks5://127.0.0.1:1080' },
      expected: { apiId: 11111, credentialsSource: 'stored', proxySource: 'environment' },
    },
  ])('resolves credential and proxy sources independently: $expected', async ({ environment, stored, expected }) => {
    const dataDir = tempDir()
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(stored))
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value)

    const result = await run(['config', 'list', '--json'], dataDir)

    expect(JSON.parse(result.stdout).data).toEqual({
      api_id: expected.apiId,
      api_hash: expected.credentialsSource === 'environment'
        ? `${'*'.repeat('environment-hash'.length - 4)}hash`
        : `${'*'.repeat('stored-hash'.length - 4)}hash`,
      credentials_source: expected.credentialsSource,
      proxy: expected.proxySource === 'environment'
        ? 'socks5://127.0.0.1:1081'
        : 'socks5://127.0.0.1:1080',
      proxy_source: expected.proxySource,
      write_access: true,
    })
  })

  it('prints exact YAML configuration', async () => {
    const dataDir = tempDir()
    writeFileSync(join(dataDir, 'config.json'), '{"api_id":12345,"api_hash":"yaml-secret"}\n')
    vi.stubEnv('TG_API_ID', '')
    vi.stubEnv('TG_API_HASH', '')
    vi.stubEnv('TG_PROXY', '')

    const result = await run(['config', 'list', '--yaml'], dataDir)

    expect(result).toEqual({
      stdout: `ok: true\nschema_version: "1"\ndata:\n  api_id: 12345\n  api_hash: "${'*'.repeat('yaml-secret'.length - 4)}cret"\n  credentials_source: stored\n  proxy: null\n  proxy_source: null\n  write_access: true\n`,
      stderr: '',
      code: 0,
    })
    expect(`${result.stdout}${result.stderr}`).not.toContain('yaml-secret')
  })

  it.each([
    {
      stored: { api_id: 12345, api_hash: 'human-secret', proxy: 'socks5://127.0.0.1:1080' },
      output: `API ID               12345\nAPI hash             ${'*'.repeat('human-secret'.length - 4)}cret\nCredentials source   stored\nProxy                socks5://127.0.0.1:1080\nProxy source         stored\nWrite access         true\n`,
    },
    {
      stored: undefined,
      output: `API ID               2040\nAPI hash             ${'*'.repeat(28)}e627\nCredentials source   default\nProxy                none\nProxy source         none\nWrite access         true\n`,
    },
  ])('prints exact human configuration: $output', async ({ stored, output }) => {
    const dataDir = tempDir()
    if (stored) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(stored))
    vi.stubEnv('TG_API_ID', '')
    vi.stubEnv('TG_API_HASH', '')
    vi.stubEnv('TG_PROXY', '')

    const result = await run(['config', 'list'], dataDir, true)

    expect(result).toEqual({ stdout: output, stderr: '', code: 0 })
    expect(`${result.stdout}${result.stderr}`).not.toContain('human-secret')
  })

  it.each([
    { flags: ['--json'], format: 'json' },
    { flags: ['--yaml'], format: 'yaml' },
    { flags: [], format: 'human' },
  ])('shows the complete API hash but keeps proxy credentials masked in $format output', async ({ flags, format }) => {
    const dataDir = tempDir()
    const apiHash = 'complete-api-hash-secret'
    const proxy = 'socks5://proxy-user:proxy-secret@127.0.0.1:1080'
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      api_id: 12345,
      api_hash: apiHash,
      proxy,
    }))

    const result = await run(['config', 'list', '--show-secrets', ...flags], dataDir, format === 'human')

    expect(result).toMatchObject({ stderr: '', code: 0 })
    expect(result.stdout).toContain(apiHash)
    expect(result.stdout).toContain('socks5://***:***@127.0.0.1:1080')
    expect(result.stdout).not.toContain('proxy-user')
    expect(result.stdout).not.toContain('proxy-secret')
  })

  it('fully masks API hashes with four or fewer characters', async () => {
    vi.stubEnv('TG_API_ID', '12345')
    vi.stubEnv('TG_API_HASH', 'abc')

    const result = await run(['config', 'list', '--json'], tempDir())

    expect(JSON.parse(result.stdout).data.api_hash).toBe('***')
    expect(result.stdout).not.toContain('abc')
  })

  it('rejects JSON and YAML before reading invalid configuration', async () => {
    const dataDir = tempDir()
    const malformedSecret = 'malformed-stored-secret'
    writeFileSync(join(dataDir, 'config.json'), `{not-json:${malformedSecret}}`)
    vi.stubEnv('TG_API_ID', '12345')
    vi.stubEnv('TG_API_HASH', '')

    const result = await run(['config', 'list', '--json', '--yaml'], dataDir)

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('code: invalid_output_format')
    expect(result.stdout).toContain('message: Use only one of --json, --yaml, or --markdown.')
    expect(result.stderr).toBe('')
    expect(`${result.stdout}${result.stderr}`).not.toContain(malformedSecret)
  })

  it('returns a stable invalid_config error for partial environment credentials', async () => {
    const secret = 'partial-environment-secret'
    vi.stubEnv('TG_API_ID', '12345')
    vi.stubEnv('TG_API_HASH', '')
    vi.stubEnv('TG_PROXY', `mtproxy://127.0.0.1:443?secret=${secret}`)

    const result = await run(['config', 'list', '--json'], tempDir())

    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      schema_version: '1',
      error: {
        code: 'invalid_config',
        message: 'Telegram configuration is invalid.',
      },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
  })

  it('returns a stable invalid_config error for malformed stored configuration without leaking it', async () => {
    const dataDir = tempDir()
    const apiHash = 'malformed-api-hash-secret'
    const mtproxySecret = 'dd-malformed-mtproxy-secret'
    writeFileSync(join(dataDir, 'config.json'), `{"api_id":"bad","api_hash":"${apiHash}","proxy":"mtproxy://127.0.0.1:443?secret=${mtproxySecret}"}`)
    vi.stubEnv('TG_API_ID', '')
    vi.stubEnv('TG_API_HASH', '')
    vi.stubEnv('TG_PROXY', '')

    const result = await run(['config', 'list', '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_config',
        message: 'Telegram configuration is invalid.',
      },
    })
    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain(apiHash)
    expect(`${result.stdout}${result.stderr}`).not.toContain(mtproxySecret)
  })

  it('returns a stable invalid_config error when stored proxy resolution fails after environment credentials resolve', async () => {
    const dataDir = tempDir()
    const malformedProxySecret = 'malformed-proxy-object-secret'
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      proxy: { url: `socks5://${malformedProxySecret}@127.0.0.1:1080` },
    }))
    vi.stubEnv('TG_API_ID', '12345')
    vi.stubEnv('TG_API_HASH', 'valid-environment-hash')
    vi.stubEnv('TG_PROXY', '')

    const result = await run(['config', 'list', '--json'], dataDir)

    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      schema_version: '1',
      error: {
        code: 'invalid_config',
        message: 'Telegram configuration is invalid.',
      },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(`${result.stdout}${result.stderr}`).not.toContain(malformedProxySecret)
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
