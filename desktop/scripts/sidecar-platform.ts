import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar'

type NodeDistribution = {
  platform: NodeJS.Platform
  arch: string
  plat: string
  ext: 'tar.gz' | 'zip'
}

const distributions: Record<string, NodeDistribution> = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64', plat: 'darwin-arm64', ext: 'tar.gz' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64', plat: 'darwin-x64', ext: 'tar.gz' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64', plat: 'linux-arm64', ext: 'tar.gz' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64', plat: 'linux-x64', ext: 'tar.gz' },
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64', plat: 'win-x64', ext: 'zip' },
}

export function nodeDistribution(triple: string): NodeDistribution {
  const distribution = distributions[triple]
  if (!distribution) throw new Error(`unsupported target triple: ${triple}`)
  return distribution
}

export function sidecarName(triple: string): string {
  return `node-${triple}${nodeDistribution(triple).platform === 'win32' ? '.exe' : ''}`
}

export function archiveNodePath(directory: string, version: string, triple: string): string {
  const { plat, platform } = nodeDistribution(triple)
  const root = join(directory, `node-${version}-${plat}`)
  return platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node')
}

type RunExtraction = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: 'inherit' }) => unknown

export async function extractNodeArchive(
  archive: string,
  directory: string,
  extension: 'tar.gz' | 'zip',
  run: RunExtraction = (command, args, options) => execFileSync(command, args, options),
): Promise<void> {
  if (extension === 'tar.gz') {
    await pipeline(createReadStream(archive), createGunzip(), extract({ cwd: directory }))
    return
  }

  // Paths travel as environment values, never as interpolated PowerShell code.
  run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:TG_NODE_ARCHIVE -DestinationPath $env:TG_NODE_EXTRACT_DIR -Force",
  ], {
    stdio: 'inherit',
    env: { ...process.env, TG_NODE_ARCHIVE: archive, TG_NODE_EXTRACT_DIR: directory },
  })
}
