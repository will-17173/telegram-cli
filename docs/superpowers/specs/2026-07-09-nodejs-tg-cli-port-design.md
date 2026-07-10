# Node.js tg-cli Port Design

Date: 2026-07-09

## Goal

Port the Python `tg-cli` reference implementation to a new Node.js project in the repository root at `/Volumes/T7/Code/telegram-cli`.

The first release is a 1:1 command and behavior port. The existing `tg-cli/` Python project and `mtcute/` source tree are reference-only inputs and must not be runtime dependencies. The final Node.js project must continue to work after those directories are removed.

## Decisions

- Build directly in the repository root.
- Use TypeScript, pnpm, and a packaged executable CLI with `bin: tg`.
- Use mtcute through `@mtcute/node`.
- Use React/Ink only for human-readable TTY output.
- Preserve script-friendly command behavior and structured output.
- Do not support old Python SQLite data compatibility.
- Do not migrate Telethon sessions to mtcute sessions.

## Architecture

The project will use layered boundaries:

- `src/cli`: command registration, option parsing, help text, and exit codes.
- `src/commands`: command handlers. Handlers call services and return typed command results; they do not print directly and do not use mtcute directly.
- `src/services`: application workflows for Telegram operations, sync, query, export, send, edit, delete, and listen.
- `src/storage`: SQLite schema and query API.
- `src/telegram`: mtcute adapter. This is the only layer that imports `@mtcute/node` types and APIs.
- `src/presenters`: structured output and Ink-based TTY output.
- `src/config`: environment variables, data paths, session paths, and runtime defaults.

This separation keeps command behavior testable without a real Telegram account and keeps mtcute replaceable behind a small adapter interface.

## Command Scope

The Node.js CLI will preserve these commands:

- `status`
- `whoami`
- `chats`
- `info`
- `history`
- `sync`
- `sync-all`
- `refresh`
- `listen`
- `send`
- `edit`
- `delete`
- `search`
- `recent`
- `stats`
- `top`
- `timeline`
- `today`
- `filter`
- `export`
- `purge`

The command surface should match the Python version's arguments and options wherever possible, including:

- `--json`
- `--yaml`
- `--sync-first`
- `--sync-limit`
- `--hours`
- `--limit` / `-n`
- `--chat` / `-c`
- `--sender` / `-s`
- `--regex`
- `--delay`
- `--max-chats`
- `--persist`
- `--retry-seconds`
- `--reply`
- `--no-preview`
- `--format` / `-f`
- `--output` / `-o`
- `--yes` / `-y`

## Behavioral Contract

The first implementation targets command behavior compatibility, not internal code compatibility.

Required behavior:

- `--json` and `--yaml` are mutually exclusive.
- `OUTPUT=yaml|json|rich|auto` controls default output format.
- Non-TTY stdout defaults to YAML when no explicit output mode is set.
- Structured success output uses:

  ```yaml
  ok: true
  schema_version: "1"
  data: ...
  ```

- Structured error output uses:

  ```yaml
  ok: false
  schema_version: "1"
  error:
    code: ...
    message: ...
  ```

- Query commands read from local SQLite by default.
- `--sync-first` refreshes before running the query.
- Chat resolution supports numeric IDs, exact names, and partial names.
- Missing chats return `chat_not_found` in structured mode and a non-zero exit code.
- Ambiguous chat names produce a readable diagnostic instead of choosing arbitrarily.
- `listen --persist` reconnects after disconnects using `--retry-seconds`.
- `refresh` remains the recommended high-level sync command; `sync-all` remains the lower-level primitive.

Allowed differences from the Python version:

- No compatibility with the old Python SQLite database.
- No Telethon session migration.
- mtcute authentication flow may differ from Telethon's first-login prompts.
- Internal schema may add fields.
- TTY rendering may differ visually as long as command data and meaning are preserved.

## Ink Output Boundary

Ink is used only for human-readable TTY output:

- tables
- progress spinners
- status rows
- timeline bars
- listener message rows

Ink must not be used for:

- `--json`
- `--yaml`
- non-TTY stdout structured output
- file export contents

This avoids ANSI or React rendering artifacts in machine-readable output.

## Telegram Adapter

`src/telegram/MtcuteTelegramClient` will expose a project-owned interface rather than leaking mtcute types into services.

Required adapter capabilities:

- `connect` / `start`: initialize mtcute with API credentials and local session storage.
- `getCurrentUser`: support `status` and `whoami`.
- `listChats`: return `{ id, name, type, unread }`.
- `getChatInfo`: return detailed chat metadata for `info`.
- `fetchHistory`: fetch messages for one chat with `limit`, `minId`, progress callback support, and batch persistence.
- `syncAll`: iterate dialogs and sync incrementally.
- `listen`: subscribe to new messages and expose normalized message events.
- `sendMessage`: support message sending, reply target, and link preview control.
- `editMessage`: edit a sent message.
- `deleteMessages`: delete one or more messages.

The adapter owns mtcute-specific entity resolution, raw API fallbacks, session setup, and Telegram error translation.

## Telegram Safety

The Node.js port keeps the reference tool's safety posture:

- Support `TG_API_ID` and `TG_API_HASH`.
- If no custom API credentials are set, allow Telegram Desktop public credentials but warn that custom credentials are safer.
- Keep sync delay and jitter behavior.
- Keep `--max-chats` for limited refreshes.
- Skip failed chats during bulk sync where possible.
- Avoid participant enumeration unless a command explicitly needs it.

## Storage

The Node.js version uses a new SQLite database. It does not need to read existing Python data, even if the default application data directory uses the same final product name.

Use `better-sqlite3` for simple synchronous CLI transactions.

Recommended `messages` table fields:

- `id`
- `platform`
- `chat_id`
- `chat_name`
- `msg_id`
- `sender_id`
- `sender_name`
- `content`
- `timestamp`
- `raw_json`

The uniqueness constraint remains `(platform, chat_id, msg_id)`.

Storage API:

- `findChats`
- `resolveChatId`
- `insertMessage`
- `insertBatch`
- `search`
- `searchRegex`
- `getRecent`
- `getToday`
- `getChats`
- `getLastMsgId`
- `count`
- `getLatestTimestamp`
- `deleteChat`
- `topSenders`
- `timeline`

The API mirrors the Python reference to make behavior tests easy to port.

## Configuration

Environment variables to support:

- `TG_API_ID`
- `TG_API_HASH`
- `TG_SESSION_NAME`
- `DATA_DIR`
- `DB_PATH`
- `OUTPUT`

Default data directory should use platform conventions and the final product name `tg-cli`.

Session data and SQLite data should be stored separately under the application data directory unless the user overrides paths.

## Output

`src/presenters/structured.ts` handles:

- output format resolution
- JSON serialization
- YAML serialization
- success envelope
- error envelope
- `OUTPUT` environment behavior
- non-TTY YAML default

`src/presenters/ink/*` handles:

- chat tables
- stats tables
- search and recent rows
- grouped today/filter output
- top sender table
- timeline bars
- progress and listener status

Commands return a `CommandResult` that the CLI renders through the selected presenter.

## Testing

Use Vitest.

Test layers:

1. Storage and query unit tests
   - insert fixture messages
   - verify search, regex search, recent, today, top, timeline, chat resolution, purge

2. CLI contract tests
   - command argument parsing
   - JSON/YAML envelope
   - output mode resolution
   - non-TTY YAML default
   - exit codes
   - structured errors

3. Service tests with fake Telegram adapter
   - refresh
   - sync-first
   - sync all with partial failures
   - send/edit/delete result mapping
   - listener reconnect loop behavior where practical

4. Manual mtcute smoke tests
   - `tg status`
   - `tg whoami`
   - `tg chats`
   - `tg refresh --max-chats 1`
   - `tg send`

Real Telegram account tests are not part of normal CI.

## Implementation Order

1. Scaffold TypeScript/pnpm CLI project in the repository root.
2. Implement config, structured output, and command registration.
3. Port storage schema and query behavior with tests.
4. Port local query/data commands using storage only.
5. Add Telegram adapter interface and fake adapter tests.
6. Implement mtcute adapter.
7. Port sync, refresh, history, chats, info, status, whoami, send, edit, delete, listen.
8. Add Ink TTY presenters.
9. Run contract tests and manual mtcute smoke tests.

## Acceptance Criteria

- The repository root contains the working Node.js CLI project.
- `pnpm install`, `pnpm test`, and a development command for `tg` work from the root.
- The CLI exposes the same first-release command surface as the Python reference.
- Structured output matches the shared schema version `1`.
- Local query behavior is covered by Vitest tests.
- Telegram operations are isolated behind the mtcute adapter.
- The project does not import or require files from `tg-cli/` or `mtcute/` at runtime.
