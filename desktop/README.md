# Telegram CLI Desktop

A Tauri v2 application for Linux x64, Windows x64, and macOS ARM64 that includes
the existing `tg` CLI capabilities. It bundles
a portable Node.js runtime plus the CLI as a sidecar. Accounts, sessions,
configuration, cached messages, downloads, and archives use the same data
directory as the CLI.

The app has four pages: Messages, Operations, Accounts, and Guard. Operations
contains 103 searchable command forms generated from the CLI command tree,
including all group administration, contacts, folders, notifications, local
analysis, sync, repair, export, download, and archive operations. Parameters,
defaults, repeatable values, and confirmations follow the CLI definitions.

Use Accounts to add an account or sign in again with a phone number, login code,
and optional Telegram 2FA password. Switch the default account, log out, and
remove an account here or in Operations. Settings are available under the
Settings category, including API credentials, proxy, and remote write access.

Long operations run as managed tasks with progress logs, results, history, and
Stop controls. A live listener can send text, attachments, and replies through
its existing connection. JSON, YAML, and Markdown results can be copied or saved
with native dialogs. Ownership transfer uses a masked 2FA field and a private
process channel; the password is not placed in command arguments or history.

Guard includes Start, Stop, and Reload rules controls. Stop waits for active
actions to finish before releasing account sessions. Account operations share
reservations so a second client cannot open a session already used by a task,
sync, download, or Guard.

See `docs/specs/2026-07-23-tauri-desktop-app-design.md` for the full design.

## Architecture

```
Tauri app (Rust host)
 ├─ spawns sidecar: binaries/telegram-cli-node → dist-bundle/index.js web --port <p> --no-open
 │   (CLI bundle incl. better-sqlite3 .node + mtcute .wasm, no node_modules)
 ├─ polls http://127.0.0.1:<p>/api/health
 ├─ injects the API address before the frontend loads; waits for backend readiness
 └─ webview loads ../../dist/web  (the CLI's built React UI)
```

The desktop app **shares the CLI's data directory** (`~/Library/Application
Support/tg-cli/` on macOS): accounts you logged in via `tg account add` and
messages you synced via `tg sync` are visible immediately. Do not run the CLI
and the desktop app against the same account at the same time — SQLite and the
session file do not support concurrent access.

## Prerequisites

- Rust stable for your native platform
- Node.js >= 22.12
- pnpm
- From the repo root: `pnpm install` (installs CLI deps incl. `@vercel/ncc`)
- `pnpm --dir desktop install` (installs the Tauri CLI and packaging tools)
- Platform build tools listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Develop

```sh
# fetch a portable Node matching the build runtime
pnpm --dir desktop run fetch-node

# run the desktop app with hot-reloading web UI
pnpm desktop:dev
```

`tauri dev` prepares the Node runtime, builds the web UI (`dist/web`), bundles the CLI (`dist-bundle`), and
launches the app pointed at the Vite dev server on `http://localhost:5173`. The
sidecar uses the same portable `node` as in production.

## Build

```sh
pnpm --dir desktop run fetch-node   # ensures binaries/telegram-cli-node-<triple> is present
pnpm --dir desktop run tauri:build
```

Output: `desktop/src-tauri/target/release/bundle/` containing the native host's
installers. Use `--bundles deb,appimage` on Linux, `--bundles nsis,msi` on Windows,
or `--bundles app,dmg` on macOS to select formats. When `--target <triple>` is
specified, output is under `target/<triple>/release/bundle/`.

If the host's disk image service cannot create a DMG, build the app directly:
`pnpm --dir desktop run tauri:build --bundles app`. The macOS 27 host used for
verification fails both legacy HFS+ images and a minimal APFS image fixture
(`diskutil` error 156), so only the `.app` was generated there.

The build hooks prepare the sidecar automatically. Its Node version defaults
to the version running the build, and cached binaries are checked before use.
`NODE_VERSION` can select another release with the same Node ABI. This keeps
the bundled SQLite native module compatible with the portable runtime.

## Verify

```sh
pnpm test
pnpm typecheck
pnpm build
/Users/huang/.venv/bin/python tests/web/desktop-browser-smoke.py
```

The browser smoke test uses the system Python Playwright and installed Google
Chrome. It creates isolated local fixtures and mocks Telegram mutations while
checking forms, results, listener replies, login, cancellation, and layout.

### Cross-architecture notes

SQLite native modules and the portable Node runtime must match the Rust target.
Build on a native runner for each operating system and architecture. The
sidecar preparation rejects cross-architecture builds rather than packaging
the host's incompatible SQLite module.

## GitHub Releases

Pushing a `v*` tag runs [Release desktop apps](../.github/workflows/desktop-release.yml).
The tag must match the versions in the root package, desktop package, Cargo,
and Tauri configuration. Three native jobs generate:

| Platform | Runner | Release assets |
| --- | --- | --- |
| Linux x64 | Ubuntu 22.04 | `.AppImage`, `.deb` |
| Windows x64 | Windows Server 2022 | NSIS `.exe`, `.msi` |
| macOS ARM64 | macOS 15 ARM64 | `.dmg`, `.app.tar.gz` |

All jobs use Node 24 and run an isolated portable backend smoke test that
checks bundled SQLite, WASM assets, account queries, and a managed CLI task.
macOS also verifies the packaged app's signature. Installers are published
only after all three jobs pass; the release includes `SHA256SUMS.txt`.
The release stays in draft while uploading, including on reruns. Uploaded
asset states, sizes, and SHA-256 digests must match before it becomes public.

The bundled runtime is named `telegram-cli-node`, so Debian installations do
not overwrite `/usr/bin/node`. Linux verification extracts both installers,
checks their runtime paths, and runs the backend from the packaged AppImage.
Each installer contains only its own platform's SQLite prebuild; foreign
architectures and musl binaries are removed before Linux dependency scanning.

The workflow uses GitHub's built-in token; no npm token, `.env`, Telegram API
credentials, or account sessions are required.

Linux AppImage builds use `NO_STRIP=true` because linuxdeploy's bundled strip
can reject modern ELF sections in system libraries. Use the same environment
variable if a local AppImage build reports unsupported ELF sections while stripping.

To backfill an existing tag, select the source branch in Actions → Release
desktop apps → Run workflow and enter its `release_tag`, or run:

```sh
gh workflow run desktop-release.yml --ref main -f release_tag=v0.9.0
```

A manual run builds the selected workflow ref, validates its application
versions against the existing tag, and records both commits in the release
notes. It does not move the tag. A tag push builds the tagged commit itself.

If only publishing fails after all three builds pass, enter that run's ID in
the optional `artifact_run_id` input to reuse its verified installers. The
workflow checks the repository, source versions, all three build jobs, and
their smoke-test results before downloading the artifacts. Release notes
continue to record the commit that produced the binaries.

## Known limitations

- **Signing.** macOS uses ad-hoc signing without Apple notarization; allow the
  downloaded app in Privacy & Security when prompted. Windows installers are
  unsigned. The Node 24 runtime requires macOS 13.5 or later.
- **Size.** The verified Node 24 build includes a ~120 MB runtime plus the CLI
  bundle, so the `.app` is about 150 MB.
- **No concurrent CLI + desktop use** on the same account.
- **Manual backend recovery.** Startup failures and backend exits show an
  in-app error with a Restart app action.
