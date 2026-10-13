# Telegram CLI Desktop

A Tauri v2 macOS application for the existing `tg` CLI capabilities. It bundles
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
 ├─ spawns sidecar: binaries/node  →  node dist-bundle/index.js web --port <p> --no-open
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

- Rust (stable, with `aarch64-apple-darwin` and/or `x86_64-apple-darwin` targets)
- Node.js >= 22.12
- pnpm
- From the repo root: `pnpm install` (installs CLI deps incl. `@vercel/ncc`)

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
pnpm --dir desktop run fetch-node   # ensures binaries/node-<triple> is present
pnpm --dir desktop run tauri:build
```

Output: `desktop/src-tauri/target/release/bundle/` containing the `.app` and
`.dmg` for the host architecture.

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

`better-sqlite3`'s native module is architecture-specific. ncc emits whatever
`.node` is in `node_modules/better-sqlite3/build/Release/`, which matches the
machine that ran `pnpm rebuild better-sqlite3`. To build for the other macOS
architecture, rebuild on (or cross-compile from) a machine of that architecture,
then run `pnpm run bundle` and `tauri:build` there.

## Known limitations

- **No code signing / notarization.** The first release is unsigned; on macOS
  Gatekeeper will block it until you right-click → Open, or run
  `xattr -dr com.apple.quarantine /path/to/Telegram CLI.app`.
- **Size.** The verified Node 24 build includes a ~120 MB runtime plus the CLI
  bundle, so the `.app` is about 150 MB.
- **No concurrent CLI + desktop use** on the same account.
- **Manual backend recovery.** Startup failures and backend exits show an
  in-app error with a Restart app action.
