# Repository Guidelines

## Project Structure & Module Organization

This repository contains a TypeScript Telegram CLI. `src/index.ts` is the executable entry point. Keep responsibilities within the existing layers: `src/cli/` registers commands and output behavior, `src/commands/` implements command handlers, `src/services/` coordinates workflows, `src/storage/` owns SQLite access, and `src/telegram/` isolates mtcute integration. Configuration belongs in `src/config/`; machine-readable and Ink-based output live in `src/presenters/`.

Tests mirror these areas under `tests/` (for example, `tests/services/sync-service.test.ts`). Shared test data belongs in `tests/fixtures/`. The `tg-cli/` and `mtcute/` directories are reference sources, not runtime dependencies; do not import from them.

## Build, Test, and Development Commands

Use pnpm with the checked-in lockfile:

- `pnpm install` installs dependencies.
- `pnpm dev -- --help` runs the CLI directly through `tsx`; replace `--help` with a command and options.
- `pnpm test` runs the complete Vitest suite once.
- `pnpm test:watch` reruns affected tests during development.
- `pnpm typecheck` runs strict TypeScript validation without emitting files.

Run `pnpm test && pnpm typecheck` before opening a pull request.

## Coding Style & Naming Conventions

Follow the established TypeScript style: two-space indentation, single quotes, no semicolons, and ESM imports. Relative imports use `.js` extensions so NodeNext resolution matches emitted JavaScript. Name files in kebab case (`message-service.ts`), types and classes in PascalCase, and functions and variables in camelCase. Keep Telegram-specific types behind `src/telegram/` and avoid printing directly from service or storage code.

## Testing Guidelines

Vitest runs in the Node environment and discovers `tests/**/*.test.ts`. Add focused tests near the matching layer and use descriptive `describe`/`it` blocks. Prefer fixtures and fake clients over live Telegram calls. Cover success, structured error output, and CLI exit behavior when changing command contracts. No numeric coverage threshold is configured; protect relevant behavior with regression tests.

## Commit & Pull Request Guidelines

History follows Conventional Commit-style subjects such as `feat: add telegram adapter interface` and `fix: preflight output format conflicts`. Use an imperative, scoped summary and keep each commit focused. Pull requests should explain the behavioral change, list verification commands, and link relevant issues. Include terminal output or screenshots when human-readable Ink rendering changes, and call out changes to structured JSON/YAML contracts.

## Security & Configuration

Never commit `.env`, Telegram credentials, session files, or generated SQLite databases. Configure local credentials with `TG_API_ID` and `TG_API_HASH`; use `DATA_DIR` or `DB_PATH` when test data must be isolated.
