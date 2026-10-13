import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archiveNodePath, extractNodeArchive, nodeDistribution, sidecarName } from '../../desktop/scripts/sidecar-platform.js'
import { collectReleaseArtifacts, prepareRelease, releaseAssetNames, releaseVersion, verifyUploadedRelease } from '../../desktop/scripts/release-artifacts.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tg-release-'))
  directories.push(directory)
  return directory
}

describe('desktop sidecar platforms', () => {
  it.each([
    ['x86_64-unknown-linux-gnu', 'linux-x64', 'tar.gz', 'bin/node', 'node-x86_64-unknown-linux-gnu'],
    ['aarch64-apple-darwin', 'darwin-arm64', 'tar.gz', 'bin/node', 'node-aarch64-apple-darwin'],
    ['x86_64-pc-windows-msvc', 'win-x64', 'zip', 'node.exe', 'node-x86_64-pc-windows-msvc.exe'],
  ])('finds the official distribution executable for %s', (triple, plat, ext, binary, output) => {
    expect(nodeDistribution(triple)).toMatchObject({ plat, ext })
    expect(archiveNodePath('/extracted', 'v24.20.0', triple)).toBe(join('/extracted', `node-v24.20.0-${plat}`, binary))
    expect(sidecarName(triple)).toBe(output)
  })

  it('rejects unsupported native targets before downloading', () => {
    expect(() => nodeDistribution('x86_64-unknown-linux-musl')).toThrow('unsupported target triple')
  })

  it('passes Windows paths literally without interpolating PowerShell code', async () => {
    const archive = "C:\\a path 测试\\node'; $(Write-Output unexpected).zip"
    const directory = "C:\\output 测试\\with ' quotes"
    const run = vi.fn()
    await extractNodeArchive(archive, directory, 'zip', run)
    const [executable, args, options] = run.mock.calls[0]
    expect(executable).toBe('powershell.exe')
    expect(args.join(' ')).not.toContain(archive)
    expect(args.join(' ')).not.toContain(directory)
    expect(args.at(-1)).toContain('Expand-Archive -LiteralPath $env:TG_NODE_ARCHIVE')
    expect(options.env).toMatchObject({ TG_NODE_ARCHIVE: archive, TG_NODE_EXTRACT_DIR: directory })
  })

  it('extracts a real Node-shaped tar archive under a path with spaces and Unicode', async () => {
    const root = temporary()
    const source = join(root, 'source')
    const node = join(source, 'node-v24.20.0-darwin-arm64', 'bin')
    mkdirSync(node, { recursive: true })
    writeFileSync(join(node, 'node'), 'portable fixture')
    const archive = join(root, 'node.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', source, 'node-v24.20.0-darwin-arm64'])
    const output = join(root, 'app 测试 directory')
    mkdirSync(output)
    await extractNodeArchive(archive, output, 'tar.gz')
    expect(readFileSync(archiveNodePath(output, 'v24.20.0', 'aarch64-apple-darwin'), 'utf8')).toBe('portable fixture')
  })
})

describe('desktop release artifacts', () => {
  it('rejects version mismatches and unsafe tag inputs', () => {
    expect(releaseVersion('v0.9.0', { CLI: '0.9.0', Desktop: '0.9.0', Cargo: '0.9.0' })).toBe('0.9.0')
    expect(() => releaseVersion('v0.9.0', { Desktop: '0.8.0' })).toThrow('Desktop version 0.8.0 does not match')
    expect(() => releaseVersion('v0.9.0; echo unexpected', {})).toThrow('Release tag must be')
    expect(releaseVersion('v0.10.0-beta.1', { CLI: '0.10.0-beta.1' })).toBe('0.10.0-beta.1')
  })

  it('collects Linux installers with versioned, architecture-specific names', () => {
    const root = temporary()
    for (const [directory, name] of [['deb', 'Telegram CLI_0.9.0_amd64.deb'], ['appimage', 'Telegram CLI_0.9.0_amd64.AppImage']]) {
      mkdirSync(join(root, 'bundle', directory), { recursive: true })
      writeFileSync(join(root, 'bundle', directory, name), `installer ${name}`)
    }
    const output = join(root, 'assets')
    collectReleaseArtifacts(join(root, 'bundle'), output, '0.9.0', 'linux-x64')
    expect(readFileSync(join(output, 'telegram-cli-0.9.0-linux-x64.deb'), 'utf8')).toContain('installer Telegram CLI')
    expect(readFileSync(join(output, 'telegram-cli-0.9.0-linux-x64.AppImage'), 'utf8')).toContain('installer Telegram CLI')
  })

  it('refuses to publish if a platform is absent or an installer is empty', async () => {
    const root = temporary()
    for (const asset of releaseAssetNames('0.9.0', 'linux-x64')) writeFileSync(join(root, asset), 'linux fixture')
    await expect(prepareRelease(root, 'v0.9.0', 'build', 'tag', 'owner/repo')).rejects.toThrow('Release is incomplete')
    expect(existsSync(join(root, 'SHA256SUMS.txt'))).toBe(false)
    for (const asset of releaseAssetNames('0.9.0')) writeFileSync(join(root, asset), '')
    await expect(prepareRelease(root, 'v0.9.0', 'build', 'tag', 'owner/repo')).rejects.toThrow('missing or empty')
  })

  it('hashes all six installers and records the build source for a manual backfill', async () => {
    const root = temporary()
    const assets = releaseAssetNames('0.9.0')
    for (const asset of assets) writeFileSync(join(root, asset), asset, 'utf8')
    await prepareRelease(root, 'v0.9.0', 'build-commit', 'tag-commit', 'will-17173/telegram-cli')
    const hashes = readFileSync(join(root, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')
    expect(hashes).toHaveLength(6)
    for (const asset of assets) expect(hashes).toContain(`${createHash('sha256').update(asset).digest('hex')}  ${asset}`)
    const notes = readFileSync(join(root, 'release-notes.md'), 'utf8')
    expect(notes).toContain('Build commit: [build-commit]')
    expect(notes).toContain('existing release tag is unchanged')
    for (const asset of assets) expect(notes).toContain(`/releases/download/v0.9.0/${asset}`)
  })

  it('checks remote upload states, sizes and digests before making a release public', async () => {
    const root = temporary()
    const names = [...releaseAssetNames('0.9.0'), 'SHA256SUMS.txt']
    const assets = names.map(name => {
      writeFileSync(join(root, name), name, 'utf8')
      return { name, state: 'uploaded', size: Buffer.byteLength(name), digest: `sha256:${createHash('sha256').update(name).digest('hex')}` }
    })
    await expect(verifyUploadedRelease(root, '0.9.0', { draft: true, assets })).resolves.toBeUndefined()
    await expect(verifyUploadedRelease(root, '0.9.0', { draft: false, assets })).rejects.toThrow('Keep the release in draft')
    await expect(verifyUploadedRelease(root, '0.9.0', { draft: true, assets: assets.slice(1) })).rejects.toThrow('incomplete')
    await expect(verifyUploadedRelease(root, '0.9.0', { draft: true, assets: [{ ...assets[0], state: 'starter' }, ...assets.slice(1)] })).rejects.toThrow('incomplete')
    await expect(verifyUploadedRelease(root, '0.9.0', { draft: true, assets: [{ ...assets[0], digest: 'sha256:wrong' }, ...assets.slice(1)] })).rejects.toThrow('checksum mismatch')
  })
})
