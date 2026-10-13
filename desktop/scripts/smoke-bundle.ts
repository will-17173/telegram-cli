import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sidecarName } from './sidecar-platform.js'

const root = join(import.meta.dirname, '..', '..')
const tauri = join(root, 'desktop', 'src-tauri')
const triple = process.argv[2] ?? execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
const macApp = join(tauri, 'target', triple, 'release', 'bundle', 'macos', 'Telegram CLI.app')
const useMacApp = process.platform === 'darwin' && existsSync(macApp)
let sourceBundle = useMacApp ? join(macApp, 'Contents', 'Resources', 'dist-bundle') : join(tauri, 'dist-bundle')
let sourceNode = useMacApp ? join(macApp, 'Contents', 'MacOS', 'telegram-cli-node') : join(tauri, 'binaries', sidecarName(triple))

async function main(): Promise<void> {
  if (useMacApp) execFileSync('codesign', ['--verify', '--deep', '--strict', macApp], { stdio: 'inherit' })
  const temporary = mkdtempSync(join(tmpdir(), 'tg-desktop-smoke-'))
  const installed = join(temporary, 'Telegram CLI 测试')
  const bundle = join(installed, 'dist-bundle')
  const data = join(temporary, 'isolated data')
  const node = join(installed, process.platform === 'win32' ? 'node.exe' : 'node')
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: data }
  for (const name of Object.keys(env)) {
    if (name.startsWith('TG_') || name === 'DB_PATH' || name === 'NODE_OPTIONS') delete env[name]
  }
  let child: ReturnType<typeof spawn> | undefined
  let output = ''
  let closed: Promise<void> | undefined
  let exited = false
  try {
    if (process.platform === 'linux') {
      const bundles = join(tauri, 'target', triple, 'release', 'bundle')
      const deb = readdirSync(join(bundles, 'deb')).filter(name => name.endsWith('.deb'))
      const appImage = readdirSync(join(bundles, 'appimage')).filter(name => name.endsWith('.AppImage'))
      assert.equal(deb.length, 1, 'Expected one Debian package')
      assert.equal(appImage.length, 1, 'Expected one AppImage')
      const debRoot = join(temporary, 'debian')
      execFileSync('dpkg-deb', ['--extract', join(bundles, 'deb', deb[0]), debRoot])
      const image = join(bundles, 'appimage', appImage[0])
      chmodSync(image, 0o755)
      execFileSync(image, ['--appimage-extract'], {
        cwd: temporary, env: { ...env, APPIMAGE_EXTRACT_AND_RUN: undefined }, stdio: 'ignore', timeout: 30_000,
      })
      const imageRoot = join(temporary, 'squashfs-root')
      for (const packageRoot of [debRoot, imageRoot]) {
        assert.ok(!existsSync(join(packageRoot, 'usr', 'bin', 'node')), 'Desktop must not overwrite the system Node executable')
        assert.ok(existsSync(join(packageRoot, 'usr', 'bin', 'telegram-cli-node')), 'Packaged Node sidecar is missing')
      }
      const entries = readdirSync(imageRoot, { recursive: true }).map(String).filter(name => name.endsWith(join('dist-bundle', 'index.js')))
      assert.equal(entries.length, 1, 'AppImage must include one portable CLI bundle')
      sourceBundle = dirname(join(imageRoot, entries[0]))
      sourceNode = join(imageRoot, 'usr', 'bin', 'telegram-cli-node')
    }
    mkdirSync(installed, { recursive: true })
    cpSync(sourceBundle, bundle, { recursive: true })
    cpSync(sourceNode, node)
    chmodSync(node, 0o755)
    mkdirSync(join(data, 'accounts', 'smoke'), { recursive: true })
    writeFileSync(join(data, 'accounts.json'), JSON.stringify({
      version: 2, current_account: 'smoke', accounts: [{
        name: 'smoke', user_id: 100001, username: 'smoke', phone: '100001', display_name: 'Smoke fixture', auth_state: 'authenticated',
      }],
    }), 'utf8')
    const entry = join(bundle, 'index.js')
    assert.equal(execFileSync(node, [entry, '--version'], { cwd: temporary, env, encoding: 'utf8' }).trim(), version)
    const wasm = readdirSync(bundle, { recursive: true }).map(String).filter(name => name.endsWith('.wasm'))
    assert.ok(wasm.length >= 2, 'mtcute WASM assets must be bundled')
    for (const asset of wasm) {
      execFileSync(node, ['-e', 'new WebAssembly.Module(require("node:fs").readFileSync(process.argv[1]))', join(bundle, asset)], { cwd: temporary, env })
    }

    child = spawn(node, [entry, 'web', '--no-open'], { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let spawnError: Error | undefined
    child.on('error', error => { spawnError = error })
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    closed = new Promise(resolve => child!.once('close', () => { exited = true; resolve() }))
    const deadline = Date.now() + 30_000
    let base = ''
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (exited) throw new Error(`Portable backend exited before startup:\n${output}`)
      base = /http:\/\/127\.0\.0\.1:\d+\//.exec(output)?.[0] ?? ''
      if (base) break
      await delay(100)
    }
    assert.ok(base, `Portable backend did not start:\n${output}`)
    async function api(path: string, input?: unknown): Promise<any> {
      const response = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(5_000),
        ...(input === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(base).origin }, body: JSON.stringify(input) }),
      })
      const body = await response.json() as { ok: boolean; data?: unknown }
      assert.ok(response.ok && body.ok, `${path}: ${JSON.stringify(body)}`)
      return body.data
    }
    await api('api/health')
    assert.equal((await api('api/accounts')).current_account, 'smoke')
    await api('api/guard/status') // Opens the real bundled SQLite native module.
    const commands = await api('api/workspace/commands') as { id: string }[]
    assert.ok(commands.some(command => command.id === 'send'))
    const started = await api('api/workspace/tasks', { commandId: 'stats', account: 'smoke' })
    let task = started
    const taskDeadline = Date.now() + 20_000
    while (task.status === 'running' && Date.now() < taskDeadline) {
      await delay(100)
      task = await api(`api/workspace/tasks/${started.id}`)
    }
    assert.equal(task.status, 'succeeded', JSON.stringify(task))
    assert.equal(task.result.ok, true, JSON.stringify(task))
    await api('api/chats?account=smoke')
    console.log(`Portable desktop smoke passed: ${triple}, CLI ${version}, ${commands.length} commands, ${wasm.length} WASM assets, SQLite and managed subprocess`)
  } finally {
    if (child && !exited) {
      child.kill('SIGTERM')
      await Promise.race([closed, delay(5_000)])
      if (!exited) {
        child.kill('SIGKILL')
        await closed
      }
    }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
