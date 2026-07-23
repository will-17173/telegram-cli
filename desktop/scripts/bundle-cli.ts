// Bundles the CLI (src/index.ts) into a single JS file plus native assets using
// ncc, so the Tauri sidecar (portable node) can run `node dist-bundle/index.js
// web --port <p>` without node_modules. ncc emits better-sqlite3's .node and
// mtcute's .wasm as assets alongside the bundle.
//
// Also copies the prebuilt web UI (../../dist/web) into src-tauri/dist-web so
// Tauri can embed it as frontendDist without any "../" path (Tauri 2.x mishandles
// parent-directory segments in frontendDist/resources, encoding them as "_up_").
import { execSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SRC_TAURI = join(import.meta.dirname, '..', 'src-tauri')
const BUNDLE_OUT = join(SRC_TAURI, 'dist-bundle')
const WEB_SRC = join(ROOT, 'dist', 'web')
const WEB_OUT = join(SRC_TAURI, 'dist-web')
const NCC_BIN = join(ROOT, 'node_modules', '.bin', 'ncc')

function main(): void {
  rmSync(BUNDLE_OUT, { recursive: true, force: true })

  // ncc's programmatic API misbehaves under this project's pnpm layout (dumps
  // its webpack cache bundle to stderr). The CLI form is reliable, so shell
  // out to it.
  //
  // TS_NODE_PROJECT points ncc's ts-loader at tsconfig.build.json, which only
  // includes src/ (the root tsconfig.json also includes tests/, so any test
  // type error would otherwise break bundling).
  console.log('ncc bundling CLI ->', BUNDLE_OUT)
  execSync(
    `"${NCC_BIN}" build "${join(ROOT, 'src', 'index.ts')}" -o "${BUNDLE_OUT}" --target es2022`,
    {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.build.json' },
    },
  )

  const entry = join(BUNDLE_OUT, 'index.js')
  if (!existsSync(entry)) throw new Error(`ncc did not produce ${entry}`)

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
