# Sync History Pagination Design

## Problem

`sync-all` accepts a per-chat limit greater than 100, but the mtcute adapter calls `getHistory()` only once. Telegram returns history in pages of about 100 messages, so the adapter stores only the first page. The database then records the newest message ID and later incremental syncs request only messages newer than that ID, leaving older messages unsynchronized.

## Design

Change the mtcute adapter's `fetchHistory()` implementation to consume `iterHistory()` with the requested `limit` and `minId`. The iterator owns Telegram pagination and continues fetching pages until it reaches the requested limit or history is exhausted. Convert each yielded mtcute message to the existing storage input type and report progress as rows accumulate.

Keep `sync` and `sync-all` incremental behavior unchanged. A new chat remains subject to the existing first-sync cap of 500 messages, while subsequent runs request messages newer than the greatest locally stored message ID. This avoids repeatedly scanning old history during routine synchronization.

For databases affected by the old behavior, the existing `history <chat> --limit <count>` command is the backfill path. It fetches history without `minId`; SQLite's existing unique constraint and `INSERT OR IGNORE` behavior prevent duplicate rows. Users can run it once with a sufficiently large limit, then continue using `sync-all` normally.

## Error Handling

Pagination failures continue through the existing adapter and service error boundaries. A failed history request does not report partial rows as successfully stored because the adapter returns only after iteration completes.

## Testing

Add an adapter regression test with a fake mtcute iterator yielding more than 100 messages. Verify that:

- `fetchHistory()` consumes every yielded message up to the requested limit.
- The requested `limit` and `minId` are forwarded to `iterHistory()`.
- Progress reports the accumulated message count.

Retain service tests for the 500-message first-sync cap and database deduplication behavior. Run the focused regression test, the complete Vitest suite, and strict TypeScript validation.

## Scope

No new CLI command or persistent backward-pagination cursor is introduced. Automatic historical backfill during every `sync-all` run is intentionally excluded to keep normal incremental synchronization bounded.
