// Downloads an official Node.js binary for the current platform's target triple
// and places it at src-tauri/binaries/node-<triple>, the naming Tauri's
// externalBin sidecar mechanism expects.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { archiveNodePath, extractNodeArchive, nodeDistribution, sidecarName } from './sidecar-platform.js'

// Native SQLite assets are built with this runtime; use the same ABI in Tauri.
const NODE_VERSION = process.env.NODE_VERSION ?? process.version
const BINARIES_DIR = join(import.meta.dirname, '..', 'src-tauri', 'binaries')

function targetTriple(): string {
  const host = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
  const requested = process.env.TAURI_ENV_TARGET_TRIPLE ?? host
  if (requested !== host) throw new Error(`Build on a native ${requested} runner; SQLite assets are compiled for ${host}.`)
  return host
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} for ${url}`)
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(dest))
}

async function main(): Promise<void> {
  if (!/^v\d+\.\d+\.\d+$/.test(NODE_VERSION)) throw new Error('NODE_VERSION must be a release version such as v24.20.0')
  const triple = targetTriple()
  const { plat, ext, platform, arch } = nodeDistribution(triple)
  if (process.platform !== platform || process.arch !== arch) throw new Error(`Node and Rust must both target ${triple}.`)
  const outPath = join(BINARIES_DIR, sidecarName(triple))

  mkdirSync(BINARIES_DIR, { recursive: true })
  if (existsSync(outPath) && statSync(outPath).size > 0) {
    try {
      const installed = nodeInfo(outPath)
      if (installed.version === NODE_VERSION && installed.abi === process.versions.modules) {
        console.log(`sidecar Node ${installed.version} ready: ${outPath}`)
        return
      }
      console.log(`replacing sidecar Node ${installed.version} with ${NODE_VERSION}`)
    } catch {
      console.log('replacing unreadable sidecar Node binary')
    }
  }

  const archiveName = `node-${NODE_VERSION}-${plat}.${ext}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`
  console.log(`fetching ${url}`)
  const temp = mkdtempSync(join(tmpdir(), 'tg-node-'))
  try {
    const tmpArchive = join(temp, archiveName)
    const extractDir = join(temp, 'extracted')
    mkdirSync(extractDir)
    await download(url, tmpArchive)
    await extractNodeArchive(tmpArchive, extractDir, ext)

    const nodeBin = archiveNodePath(extractDir, NODE_VERSION, triple)
    if (!existsSync(nodeBin)) throw new Error(`node binary not found in archive: ${nodeBin}`)
    const downloaded = nodeInfo(nodeBin)
    if (downloaded.version !== NODE_VERSION || downloaded.abi !== process.versions.modules) {
      throw new Error(`Sidecar Node ${downloaded.version} ABI ${downloaded.abi} does not match requested ${NODE_VERSION} / build ABI ${process.versions.modules}. Build and bundle with the same Node version.`)
    }
    // The OS temp dir may be on a different filesystem from the project.
    copyFileSync(nodeBin, outPath)
    chmodSync(outPath, 0o755)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  console.log(`sidecar node ready: ${outPath}`)
}

function nodeInfo(path: string): { version: string; abi: string } {
  return JSON.parse(execFileSync(path, ['-p', 'JSON.stringify({ version: process.version, abi: process.versions.modules })'], { encoding: 'utf8' }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
