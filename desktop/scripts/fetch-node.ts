// Downloads an official Node.js binary for the current platform's target triple
// and places it at src-tauri/binaries/node-<triple>, the naming Tauri's
// externalBin sidecar mechanism expects.
import { execSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar'

const NODE_VERSION = process.env.NODE_VERSION ?? 'v22.12.0'
const BINARIES_DIR = join(import.meta.dirname, '..', 'src-tauri', 'binaries')

function targetTriple(): string {
  return execSync('rustc --print host-tuple').toString().trim()
}

// rustc target triple -> nodejs.org distribution platform suffix
function nodePlatform(triple: string): { plat: string; ext: 'tar.gz' | 'zip' } {
  if (triple.startsWith('aarch64-apple-darwin')) return { plat: 'darwin-arm64', ext: 'tar.gz' }
  if (triple.startsWith('x86_64-apple-darwin')) return { plat: 'darwin-x64', ext: 'tar.gz' }
  if (triple.startsWith('aarch64-unknown-linux-gnu')) return { plat: 'linux-arm64', ext: 'tar.gz' }
  if (triple.startsWith('x86_64-unknown-linux-gnu')) return { plat: 'linux-x64', ext: 'tar.gz' }
  if (triple.startsWith('x86_64-pc-windows-msvc')) return { plat: 'win-x64', ext: 'zip' }
  throw new Error(`unsupported target triple: ${triple}`)
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} for ${url}`)
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(dest))
}

async function main(): Promise<void> {
  const triple = targetTriple()
  const { plat, ext } = nodePlatform(triple)
  const binName = `node-${triple}${process.platform === 'win32' ? '.exe' : ''}`
  const outPath = join(BINARIES_DIR, binName)

  mkdirSync(BINARIES_DIR, { recursive: true })
  if (existsSync(outPath) && statSync(outPath).size > 0) {
    console.log(`sidecar node already present: ${outPath}`)
    return
  }

  const archiveName = `node-${NODE_VERSION}-${plat}.${ext}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`
  console.log(`fetching ${url}`)
  const tmpArchive = join(tmpdir(), archiveName)
  await download(url, tmpArchive)

  const extractDir = join(tmpdir(), `node-extract-${process.pid}`)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })

  if (ext === 'tar.gz') {
    await pipeline(createReadStream(tmpArchive), createGunzip(), extract({ cwd: extractDir }))
  } else {
    throw new Error('zip extraction not yet implemented for this platform')
  }

  const extractedRoot = join(extractDir, `node-${NODE_VERSION}-${plat}`)
  const nodeBin = join(extractedRoot, 'bin', 'node')
  if (!existsSync(nodeBin)) throw new Error(`node binary not found in archive: ${nodeBin}`)
  // copyFileSync (not renameSync) because the OS temp dir may be on a different
  // filesystem than the project (EXDEV on cross-device rename).
  copyFileSync(nodeBin, outPath)
  chmodSync(outPath, 0o755)
  rmSync(extractDir, { recursive: true, force: true })
  rmSync(tmpArchive, { force: true })
  console.log(`sidecar node ready: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
