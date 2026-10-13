// Bundles the CLI (src/index.ts) into a single JS file plus native assets using
// ncc, so the Tauri sidecar (portable node) can run `node dist-bundle/index.js
// web --port <p>` without node_modules. ncc emits better-sqlite3's .node and
// mtcute's .wasm as assets alongside the bundle.
//
// Also copies the prebuilt web UI (../../dist/web) into src-tauri/dist-web so
// Tauri can embed it as frontendDist without any "../" path (Tauri 2.x mishandles
// parent-directory segments in frontendDist/resources, encoding them as "_up_").
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { preparePortableBundle } from './bundle-runtime.js'

const ROOT = join(import.meta.dirname, '..', '..')
const SRC_TAURI = join(import.meta.dirname, '..', 'src-tauri')
const BUNDLE_OUT = join(SRC_TAURI, 'dist-bundle')
const WEB_SRC = join(ROOT, 'dist', 'web')
const WEB_OUT = join(SRC_TAURI, 'dist-web')
const NCC_BIN = createRequire(join(ROOT, 'package.json')).resolve('@vercel/ncc/dist/ncc/cli.js')

function main(): void {
  rmSync(BUNDLE_OUT, { recursive: true, force: true })

  // ncc's programmatic API misbehaves under this project's pnpm layout (dumps
  // its webpack cache bundle to stderr). Invoke the CLI through Node so it also
  // works on Windows without executing a .cmd wrapper or quoting shell paths.
  //
  // TS_NODE_PROJECT points ncc's ts-loader at tsconfig.build.json, which only
  // includes src/ (the root tsconfig.json also includes tests/, so any test
  // type error would otherwise break bundling).
  console.log('ncc bundling CLI ->', BUNDLE_OUT)
  execFileSync(
    process.execPath,
    [NCC_BIN, 'build', join(ROOT, 'src', 'index.ts'), '-o', BUNDLE_OUT, '--target', 'es2022'],
    {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.build.json' },
    },
  )

  const entry = join(BUNDLE_OUT, 'index.js')
  if (!existsSync(entry)) throw new Error(`ncc did not produce ${entry}`)
  writeFileSync(entry, preparePortableBundle(readFileSync(entry, 'utf8')), 'utf8')

  // Sanity: better-sqlite3 native module must be emitted for the web server
  // (which opens SQLite) to start.
  const expectedNode = join(BUNDLE_OUT, 'build', 'Release', 'better_sqlite3.node')
  if (!existsSync(expectedNode)) {
    throw new Error(`expected native asset missing: ${expectedNode}`)
  }

  // Copy the web UI build into src-tauri/dist-web for Tauri to embed.
  if (!existsSync(WEB_SRC)) {
    throw new Error(`web build not found at ${WEB_SRC}; run "pnpm build:web" first`)
  }
  rmSync(WEB_OUT, { recursive: true, force: true })
  cpSync(WEB_SRC, WEB_OUT, { recursive: true })

  console.log('bundle ready:', entry)
  console.log('web UI copied to:', WEB_OUT)
}

main()
