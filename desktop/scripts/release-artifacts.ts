import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const formats = {
  'linux-x64': [{ directory: 'deb', extension: 'deb' }, { directory: 'appimage', extension: 'AppImage' }],
  'windows-x64': [{ directory: 'nsis', extension: 'exe' }, { directory: 'msi', extension: 'msi' }],
  'macos-arm64': [{ directory: 'dmg', extension: 'dmg' }, { directory: 'macos', extension: 'app.tar.gz' }],
} as const
export type ReleasePlatform = keyof typeof formats

export function releaseVersion(tag: string, versions: Record<string, string>): string {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Release tag must be v<major>.<minor>.<patch> with an optional prerelease suffix.')
  const version = tag.slice(1)
  for (const [name, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`${name} version ${actual} does not match tag ${tag}.`)
  }
  return version
}

export function releaseAssetNames(version: string, platform?: ReleasePlatform): string[] {
  const platforms = platform ? [platform] : Object.keys(formats) as ReleasePlatform[]
  return platforms.flatMap(name => formats[name].map(format => `telegram-cli-${version}-${name}.${format.extension}`))
}

export function collectReleaseArtifacts(bundleDirectory: string, output: string, version: string, platform: ReleasePlatform): void {
  if (!(platform in formats)) throw new Error(`Unsupported release platform: ${platform}`)
  mkdirSync(output, { recursive: true })
  for (const format of formats[platform]) {
    const directory = join(bundleDirectory, format.directory)
    const suffix = format.extension === 'app.tar.gz' ? '.app' : `.${format.extension}`
    const candidates = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(suffix)) : []
    if (candidates.length !== 1) throw new Error(`Expected one ${suffix} bundle in ${directory}, found ${candidates.length}.`)
    const source = join(directory, candidates[0])
    const destination = join(output, `telegram-cli-${version}-${platform}.${format.extension}`)
    if (format.extension === 'app.tar.gz') {
      execFileSync('tar', ['-czf', destination, '-C', dirname(source), basename(source)], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' })
    } else {
      if (!statSync(source).isFile() || statSync(source).size === 0) throw new Error(`Empty or invalid bundle: ${source}`)
      copyFileSync(source, destination)
    }
  }
}

export async function prepareRelease(directory: string, tag: string, buildCommit: string, tagCommit: string, repository: string): Promise<void> {
  const version = releaseVersion(tag, {})
  const assets = releaseAssetNames(version)
  for (const name of assets) {
    const file = join(directory, name)
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) throw new Error(`Release is incomplete: missing or empty ${name}`)
  }
  const checksums: string[] = []
  for (const name of assets) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk)
    checksums.push(`${hash.digest('hex')}  ${name}`)
  }
  writeFileSync(join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8')
  const download = `https://github.com/${repository}/releases/download/${tag}`
  const links = (platform: ReleasePlatform) => releaseAssetNames(version, platform).map(name => `[${name}](${download}/${name})`).join(' · ')
  const notes = [
    `Telegram CLI desktop ${tag}`, '',
    '| Platform | Downloads |', '| --- | --- |',
    `| Linux x64 | ${links('linux-x64')} |`,
    `| Windows x64 | ${links('windows-x64')} |`,
    `| macOS ARM64 (Apple Silicon, macOS 13.5+) | ${links('macos-arm64')} |`, '',
    'Desktop includes its own Node.js runtime. No separate Node.js or CLI installation is required.',
    'Existing CLI accounts and cached messages use the same local data directory.', '',
    'macOS uses ad-hoc signing (not notarized); allow the app in Privacy & Security when prompted. Windows installers are unsigned.', '',
    `[SHA-256 checksums](${download}/SHA256SUMS.txt)`, '',
    `Tag commit: [${tagCommit}](https://github.com/${repository}/commit/${tagCommit})`,
    `Build commit: [${buildCommit}](https://github.com/${repository}/commit/${buildCommit})`,
    ...(buildCommit === tagCommit ? [] : ['', 'This manual backfill uses the build commit above for packaging fixes; the existing release tag is unchanged.']),
    '',
  ].join('\n')
  writeFileSync(join(directory, 'release-notes.md'), notes, 'utf8')
}

export async function verifyUploadedRelease(directory: string, version: string, release: {
  draft: boolean
  assets: { name: string; state: string; size: number; digest: string | null }[]
}): Promise<void> {
  if (!release.draft) throw new Error('Keep the release in draft until all uploaded assets are verified.')
  for (const name of [...releaseAssetNames(version), 'SHA256SUMS.txt']) {
    const file = join(directory, name)
    const assets = release.assets.filter(asset => asset.name === name)
    if (assets.length !== 1 || assets[0].state !== 'uploaded' || assets[0].size !== statSync(file).size) {
      throw new Error(`Uploaded release is incomplete or has an invalid asset: ${name}`)
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    if (assets[0].digest !== `sha256:${hash.digest('hex')}`) throw new Error(`Uploaded release checksum mismatch: ${name}`)
  }
  console.log('All six installers and the checksum file are uploaded and match their SHA-256 digests.')
}

export function reusableBuildCommit(run: {
  status: string
  path: string
  head_sha: string
  head_repository: { full_name: string } | null
}, jobs: { name: string; conclusion: string | null; steps: { name: string; conclusion: string | null }[] }[], repository: string): string {
  if (run.status !== 'completed' || run.path !== '.github/workflows/desktop-release.yml'
    || run.head_repository?.full_name !== repository || !/^[0-9a-f]{40}$/.test(run.head_sha)) {
    throw new Error('Artifact reuse requires a completed desktop release run from this repository.')
  }
  for (const platform of Object.keys(formats)) {
    const build = jobs.find(job => job.name === `Build ${platform}`)
    if (build?.conclusion !== 'success' || !build.steps.some(step => step.name === 'Smoke-test the relocated portable backend' && step.conclusion === 'success')) {
      throw new Error(`Artifact reuse requires a successful build and smoke test for ${platform}.`)
    }
  }
  return run.head_sha
}

function preflight(): void {
  const root = resolve(import.meta.dirname, '..', '..')
  const tag = process.env.RELEASE_TAG ?? ''
  const cargo = readFileSync(join(root, 'desktop/src-tauri/Cargo.toml'), 'utf8')
  const version = releaseVersion(tag, {
    CLI: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    Desktop: JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version,
    Tauri: JSON.parse(readFileSync(join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8')).version,
    Cargo: /^version = "([^"]+)"$/m.exec(cargo)?.[1] ?? '',
  })
  const tagCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  let buildCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const artifactRunId = process.env.ARTIFACT_RUN_ID ?? ''
  if (artifactRunId) {
    if (!/^[1-9]\d*$/.test(artifactRunId) || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Artifact run ID must be a positive integer supplied to a manual workflow run.')
    const repository = process.env.GITHUB_REPOSITORY ?? ''
    const github = (path: string) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))
    const run = github(`repos/${repository}/actions/runs/${artifactRunId}`)
    const jobs = github(`repos/${repository}/actions/runs/${artifactRunId}/jobs?per_page=100`).jobs
    buildCommit = reusableBuildCommit(run, jobs, repository)
    const source = (path: string) => execFileSync('git', ['show', `${buildCommit}:${path}`], { cwd: root, encoding: 'utf8' })
    releaseVersion(tag, {
      CLI: JSON.parse(source('package.json')).version,
      Desktop: JSON.parse(source('desktop/package.json')).version,
      Tauri: JSON.parse(source('desktop/src-tauri/tauri.conf.json')).version,
      Cargo: /^version = "([^"]+)"$/m.exec(source('desktop/src-tauri/Cargo.toml'))?.[1] ?? '',
    })
    console.log(`Reusing the verified native installers from run ${artifactRunId}.`)
  }
  if (process.env.GITHUB_EVENT_NAME === 'push' && tagCommit !== buildCommit) throw new Error('Tag build must check out the tagged commit.')
  console.log(`Desktop release ${tag}: build ${buildCommit}, tag ${tagCommit}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${version}\nbuild_commit=${buildCommit}\ntag_commit=${tagCommit}\nprerelease=${version.includes('-')}\nartifact_run_id=${artifactRunId}\n`, 'utf8')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  Promise.resolve().then(async () => {
    if (command === 'preflight') preflight()
    else if (command === 'collect') collectReleaseArtifacts(resolve(args[0]), resolve(args[1]), args[2], args[3] as ReleasePlatform)
    else if (command === 'prepare') await prepareRelease(resolve(args[0]), args[1], args[2], args[3], args[4])
    else if (command === 'verify') await verifyUploadedRelease(resolve(args[0]), args[1], JSON.parse(readFileSync(args[2], 'utf8')))
    else throw new Error('Use preflight, collect <bundle-dir> <output> <version> <platform>, prepare <dir> <tag> <build-commit> <tag-commit> <repository>, or verify <dir> <version> <release-json>.')
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
