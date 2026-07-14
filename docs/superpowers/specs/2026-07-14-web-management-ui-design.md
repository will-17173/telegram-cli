# Telegram CLI v0.5.0 Web Management UI Design

**Date:** 2026-07-14
**Status:** Approved
**Target release:** 0.5.0

## Summary

Version 0.5.0 adds a local web management UI for browsing and searching messages stored in the selected account's SQLite database. The UI is launched with `tg web`, served from the CLI process, and defaults to `127.0.0.1` only.

The release focuses on local message management: account selection, chat browsing, message pagination, keyword and time filtering, lightweight chat statistics, and a manual read-only sync action for the selected chat. It does not try to become a full Telegram client.

## Goals

- Add `tg web` as the local entry point for the management UI.
- Serve a React/Vite single-page app from the CLI package.
- Reuse existing account resolution, Telegram client creation, `MessageDB`, `QueryService`, and `SyncService` logic.
- Show registered accounts, local chats, message counts, first and last message timestamps, and paged messages.
- Support filtering messages by chat, keyword, and time range.
- Allow one manual sync task for the selected chat from the web UI.
- Keep the web API small, local-only, and explicit about its security assumptions.

## Non-goals

- Sending, editing, deleting, forwarding, or reacting to Telegram messages.
- Group management, notification settings, folder settings, or any other remote Telegram mutation.
- Local purge/delete operations from the browser.
- A Telegram-like chat client UI with bubbles, media previews, reactions, typing state, or live updates.
- `sync-all`, automatic scheduled sync, background daemon behavior, task queues, task history, cancellation, retry, or log streaming.
- Remote access, LAN access, hosted deployment, login, token authentication, OAuth, or multi-user use.
- Detailed analytics charts, sender leaderboards, or timeline visualizations.

## Product Scope

The first screen is the management app itself, not a landing page. It lets a user select an account, browse local chats, inspect recent stored messages, filter them, and trigger a sync for the active chat.

The UI is intentionally closer to a database browser than a Telegram client. It optimizes for scanning stored data and confirming sync coverage. Empty states show the exact next CLI command, such as `tg account add` when there are no accounts or `tg sync <chat>` when a selected chat has no stored messages.

## Command Contract

```text
tg web
  [--port <port>]
```

- Default host: `127.0.0.1`.
- Default port: `8734`; if it is unavailable, try increasing ports until one binds successfully.
- Startup output prints the local URL.
- The command runs until interrupted.
- The command does not accept a remote host option in 0.5.0.
- The command does not require or generate a token.

The help text must state that the server is intended for local use only, has no login screen, reads local account data, and can trigger read-only Telegram sync into local SQLite.

## Architecture

### Backend

New web code lives in a focused `src/web/` area:

- `src/commands/web.ts`: registers `tg web`.
- `src/web/server.ts`: creates the HTTP server, serves static assets, and delegates `/api/*` requests.
- `src/web/api.ts`: routes API requests, validates parameters, and formats JSON responses.
- `src/web/query.ts`: provides web-shaped local read operations using `MessageDB`.
- `src/web/sync-task.ts`: owns the single in-memory sync task.
- `src/web/static.ts`: resolves the compiled frontend asset directory without allowing arbitrary file reads.

The web backend must not call Commander or parse CLI output. It calls the same services and storage classes that the CLI uses.

### Frontend

React/Vite source lives under `web/`. The compiled assets are copied into `dist/web/` during `pnpm build` and are included in the npm package through the existing `files` policy.

The frontend talks only to same-origin `/api/*` endpoints. It does not need a separate runtime server in production.

### Data Access

Read operations use short-lived read-only database access where practical. If the existing `QueryService` result shape is not enough for web pagination, add narrowly scoped `MessageDB` methods rather than forcing the web UI through human presenter data.

Required read shapes:

- account list from the account registry.
- chat list with `chat_id`, display name, message count, first message timestamp, and last message timestamp.
- message page with stable cursor or offset pagination, sender, timestamp, content, Telegram message ID, and chat metadata.

## API Contract

All API responses use one envelope:

```json
{ "ok": true, "data": {} }
```

Failures use:

```json
{ "ok": false, "error": { "code": "invalid_request", "message": "..." } }
```

Initial endpoints:

```text
GET /api/health
GET /api/accounts
GET /api/chats?account=<name>&q=<query>&limit=<n>&offset=<n>
GET /api/messages?account=<name>&chatId=<id>&q=<query>&since=<iso>&until=<iso>&limit=<n>&cursor=<cursor>
GET /api/sync-task
POST /api/sync-task
```

`POST /api/sync-task` accepts JSON:

```json
{
  "account": "work",
  "chatId": 123456,
  "limit": 500
}
```

API rules:

- `account` is required when no current account exists; otherwise it defaults to the current account.
- `chatId` must come from the local chat list.
- `limit` must be a positive integer and defaults to 500.
- Unknown routes return `not_found`.
- Invalid parameters return `invalid_request`.
- Account errors use existing account error codes where possible.
- Telegram/session failures preserve actionable messages without exposing secrets.

`POST /api/shutdown` is not part of the MVP.

## UI Design

The app uses a work-focused management layout.

- Top bar: app name, account selector, and sync task status.
- Left sidebar: chat search and chat list.
- Main panel: selected chat title, lightweight summary, filter controls, and message list.
- Mobile or narrow widths: the chat list and message panel become separate navigable views or a drawer.

Chat list rows show:

- chat display name or ID.
- stored message count.
- last message timestamp.
- first message timestamp in a secondary detail area.

Message rows show:

- timestamp.
- sender display name or sender ID.
- message content.
- Telegram message ID as secondary metadata.

The default message view shows recent messages for the selected chat. Filtering supports keyword and time range. The MVP can use a simple "Load earlier" interaction instead of infinite scroll.

The UI avoids destructive controls. It does not expose purge, delete, send, edit, group management, notification settings, or folder settings.

## Sync Task

The server keeps one in-memory task state:

```text
idle | running | done | error
```

Only one sync task can run at a time across all accounts. If a task is already running, `POST /api/sync-task` returns `sync_task_running`.

Task state includes:

- status.
- account name.
- chat ID and display name when available.
- limit.
- started timestamp.
- finished timestamp when complete.
- synced count when successful.
- error code and message when failed.

Execution:

1. Resolve an authenticated account context.
2. Create a Telegram client for that account.
3. Create `SyncService` with the account's database path.
4. Run `SyncService.sync({ chat, limit, pageDelay })`.
5. Close the Telegram client and database resources.
6. Store the result in task state.

The sync task reads Telegram history and writes local SQLite only. It does not require the remote write-access setting because it does not mutate Telegram state.

## Security Boundary

The web server is a local convenience tool, not a remotely safe admin service.

Required protections:

- Bind only to `127.0.0.1` in 0.5.0.
- Do not enable CORS.
- Reject API requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`.
- For mutating API routes, reject cross-origin browser requests when `Origin` is present and does not match the local server origin.
- Accept JSON bodies only for `POST` routes.
- Enforce a small request body limit.
- Serve only compiled static assets and API routes.
- Do not expose Telegram sessions, API hash, proxy credentials, credential files, database paths, or full raw configuration.

Because there is no token or login, the documentation must state that users must not expose the port through tunnels, reverse proxies, LAN binding, or public hosting.

## Testing

Backend tests:

- `tg web --help` includes the local-only and sync behavior.
- `GET /api/health` succeeds.
- `GET /api/accounts` reads a temporary account registry.
- `GET /api/chats` returns local chat summaries and supports name filtering.
- `GET /api/messages` returns paged messages and validates chat, keyword, time, and limit parameters.
- `POST /api/sync-task` starts a fake sync task and updates status.
- A second `POST /api/sync-task` while running returns `sync_task_running`.
- API requests with invalid Host or Origin are rejected.
- Static serving cannot read arbitrary filesystem paths.

Storage/query tests:

- Message pagination is stable across duplicate timestamps.
- Keyword and time filters combine correctly with chat filtering.
- Read-only database access does not interfere with concurrent sync writes.

Frontend/build tests:

- The Vite app builds as part of `pnpm build`.
- The production server serves the compiled app shell.
- Basic rendered app text and asset references are present.

Full verification before release:

```sh
pnpm test
pnpm typecheck
pnpm build
```

## Release Integration

`package.json` adds web build scripts while keeping the published artifact centered on `dist/`.

The release updates:

- CLI help for `tg web`.
- README and Simplified Chinese README with a short web UI section.
- Website documentation with startup, scope, and safety notes.
- Changelog under 0.5.0.

## Acceptance Criteria

- `tg web` starts a local server and prints a usable `http://127.0.0.1:<port>/` URL.
- The page loads from the packaged `dist` output.
- The user can select an account, browse chats, and inspect stored messages for a chat.
- Chat rows show message count and local time coverage.
- Message filtering by keyword and time range works.
- The user can trigger sync for the selected chat.
- Sync status changes are visible and the page refreshes local data after success.
- A concurrent sync request returns `sync_task_running`.
- No remote Telegram write operation is exposed by the web API.
- Non-local Host or cross-origin API requests are rejected.
- `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.
