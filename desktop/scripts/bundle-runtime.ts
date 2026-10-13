import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function retainNativeSqlitePrebuild(bundleDirectory: string, platform = process.platform, arch = process.arch): void {
  const directory = join(bundleDirectory, 'prebuilds')
  const nativeName = `${platform}-${arch}.node`
  if (!existsSync(join(directory, nativeName))) throw new Error(`Missing native SQLite prebuild: ${nativeName}`)
  // linuxdeploy scans every ELF under usr/lib. Foreign musl/ARM assets would
  // introduce dependencies that the native GNU desktop application never uses.
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.node') && name !== nativeName) rmSync(join(directory, name))
  }
}

export function preparePortableBundle(source: string): string {
  const assetBase = /__nccwpck_require__\.ab = new URL\('\.', import\.meta\.url\)\.pathname[^\n]+/g
  if (source.match(assetBase)?.length !== 1) {
    throw new Error('Cannot locate ncc asset base; review the portable bundle transformation.')
  }
  const nativeBinding = /eval\("require"\)\("(?:[^"\\]|\\.)*better_sqlite3\.node"\)/g
  const portable = source
    .replace(assetBase, "__nccwpck_require__.ab = __tg_bundle_file_url_to_path(new URL('.', import.meta.url));")
    .replace(nativeBinding, '__WEBPACK_EXTERNAL_createRequire(import.meta.url)(__nccwpck_require__.ab + "build/Release/better_sqlite3.node")')
  // ncc emits URL.pathname for assets, which leaves spaces and Unicode encoded.
  // Native fs/require calls need a filesystem path, including inside an .app.
  const importLine = "import { fileURLToPath as __tg_bundle_file_url_to_path } from 'node:url'\n"
  return portable.startsWith('#!')
    ? portable.replace(/^(#![^\n]+\n)/, `$1${importLine}`)
    : importLine + portable
}
