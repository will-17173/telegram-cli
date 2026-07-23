# Telegram CLI Desktop

A Tauri v2 desktop shell that wraps the `tg` CLI's web UI into a native macOS
window. It bundles a portable Node.js runtime plus the CLI (compiled into a
single JS bundle with `@vercel/ncc`) as a Tauri sidecar. On launch the Rust
host spawns `node <bundle> web --port <p>`, waits for it to become healthy, and
loads the existing React web UI in the webview with the API base injected.

See `docs/specs/2026-07-23-tauri-desktop-app-design.md` for the full design.

## Architecture

```
Tauri app (Rust host)
 ├─ spawns sidecar: binaries/node  →  node dist-bundle/index.js web --port <p>
 │   (CLI bundle incl. better-sqlite3 .node + mtcute .wasm, no node_modules)
 ├─ polls http://127.0.0.1:<p>/api/health
 ├─ injects window.__TG_API_BASE__ into the webview
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
- pnpm 10
- From the repo root: `pnpm install` (installs CLI deps incl. `@vercel/ncc`)

## Develop

```sh
# one-time: fetch the portable node sidecar binary
pnpm --dir desktop run fetch-node

# run the desktop app with hot-reloading web UI
pnpm --dir desktop run tauri:dev
```

`tauri dev` builds the web UI (`dist/web`), bundles the CLI (`dist-bundle`), and
launches the app pointed at the Vite dev server on `http://localhost:5173`. The
sidecar uses the same portable `node` as in production.

## Build

```sh
pnpm --dir desktop run fetch-node   # ensures binaries/node-<triple> is present
pnpm --dir desktop run tauri:build
```

Output: `desktop/src-tauri/target/release/bundle/` containing the `.app` and
`.dmg` for the host architecture.

### Cross-architecture notes

`better-sqlite3`'s native module is architecture-specific. ncc emits whatever
`.node` is in `node_modules/better-sqlite3/build/Release/`, which matches the
machine that ran `pnpm rebuild better-sqlite3`. To build for the other macOS
architecture, rebuild on (or cross-compile from) a machine of that architecture,
then run `pnpm run bundle` and `tauri:build` there.

## Known limitations

- **No in-app login.** Use the CLI (`tg account add`) to authenticate first.
- **No code signing / notarization.** The first release is unsigned; on macOS
  Gatekeeper will block it until you right-click → Open, or run
  `xattr -dr com.apple.quarantine /path/to/Telegram CLI.app`.
- **Size.** The app embeds a full Node runtime (~40 MB) plus the CLI bundle, so
  the `.app` is ~60–90 MB.
- **No concurrent CLI + desktop use** on the same account.
- **No auto-restart** if the sidecar crashes; the webview will show errors.
