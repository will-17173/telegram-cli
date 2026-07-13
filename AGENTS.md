# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Node.js 22+ TypeScript Telegram CLI published as `@will-17173/telegram-cli`, with the `tg` binary. `src/index.ts` is the production entry point and `src/dev.ts` loads local development configuration before invoking it.

Keep responsibilities within the existing layers:

- `src/cli/` defines the Commander application and process-level output behavior.
- `src/commands/` implements CLI handlers and command contracts.
- `src/services/` coordinates workflows without printing directly.
- `src/storage/` owns SQLite access and chat resolution.
- `src/telegram/` isolates mtcute and Telegram-specific types behind adapters.
- `src/account/` owns account selection, presets, and per-account paths.
- `src/config/` resolves environment and persisted configuration.
- `src/group-commands/` and `src/listen-commands/` contain reusable parsing, catalogs, and dispatch logic.
- `src/presenters/` owns human-readable, JSON/YAML, and Ink output.

Tests mirror these areas under `tests/` (for example, `tests/services/sync-service.test.ts`). Shared test data belongs in `tests/fixtures/`. `dist/` is generated build output. The `tg-cli/` and `mtcute/` directories are reference sources, not runtime dependencies; never import from or modify them as part of the application implementation.

## Build, Test, and Development Commands

Use pnpm with the checked-in lockfile:

- `pnpm install` installs dependencies.
- `pnpm dev -- --help` runs the CLI directly through `tsx`; replace `--help` with a command and options.
- `pnpm test` runs the complete Vitest suite once.
- `pnpm test:watch` reruns affected tests during development.
- `pnpm typecheck` runs strict TypeScript validation without emitting files.
- `pnpm build` cleans and compiles production files into `dist/`.

Run `pnpm test && pnpm typecheck && pnpm build` before opening a pull request. Prefer a focused Vitest invocation while iterating, for example `pnpm exec vitest run tests/services/sync-service.test.ts`.

## Coding Style & Naming Conventions

Follow the established TypeScript style: two-space indentation, single quotes, no semicolons, and ESM imports. Relative imports use `.js` extensions so NodeNext resolution matches emitted JavaScript. Name files in kebab case (`message-service.ts`), types and classes in PascalCase, and functions and variables in camelCase. Keep Telegram-specific types behind `src/telegram/`, keep rendering in presenters, and avoid printing directly from service or storage code. Preserve stable JSON/YAML field names and error codes unless the change explicitly updates the public command contract.

## Testing Guidelines

Vitest runs in the Node environment and discovers `tests/**/*.test.{ts,tsx}`. Add focused tests near the matching layer and use descriptive `describe`/`it` blocks. Prefer fixtures, fake adapters, and temporary data directories over live Telegram calls. Add regression coverage for behavioral fixes. When changing command contracts, cover success, structured error output, stderr/stdout behavior, and process exit status. Ink changes should include renderer or interaction tests where practical. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

History follows Conventional Commit subjects such as `feat: add telegram adapter interface` and `fix: preflight output format conflicts`. Write commit messages in English, use an imperative summary, and keep each commit focused. Pull requests should explain the behavioral change, list verification commands, and link relevant issues. Include terminal output or screenshots when human-readable Ink rendering changes, and call out changes to structured JSON/YAML contracts.

## Security & Configuration

Never commit `.env`, Telegram credentials, proxy secrets, account session files, or generated SQLite databases. Configure local credentials with `TG_API_ID` and `TG_API_HASH`; `TG_PROXY` may also contain credentials. Use `DATA_DIR` to isolate all application data or `DB_PATH` for a database override in tests. Avoid tests that read or mutate a developer's real account data, saved configuration, or Telegram session.
