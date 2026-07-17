# Download Status Design

## Goal

Track whether downloadable Telegram message media has already been downloaded, so long-running channel downloads can be resumed without repeating completed work.

The status must be visible in CLI downloads, query/archive output, and the web message browser.

## Decisions

- Store download completion at attachment level.
- Derive message-level `downloaded` from attachment state.
- Treat download state as global to the account message database, not scoped to an output directory.
- Skip already downloaded attachments by default.
- Add `--force` to redownload attachments and refresh their status.
- Mark downloads performed by both `tg download` and `tg archive --download-media`.
- Show already-downloaded skips during command execution, not only in the final summary.
- Show download status icons in the web message item and attachment rows.

## Data Model

The `attachments` table gains persistent status fields:

- `downloaded INTEGER NOT NULL DEFAULT 0`
- `downloaded_at TEXT`
- `download_path TEXT`

`downloaded` is the source of truth for each attachment. `downloaded_at` stores an ISO timestamp from the successful write. `download_path` stores the local path that was written or reused.

Message-level `downloaded` is not stored. It is derived when messages are hydrated:

- Messages with no downloadable attachments have `downloaded = false`.
- Messages with one or more downloadable attachments have `downloaded = true` only when every downloadable attachment has `downloaded = true`.
- Partially downloaded messages have `downloaded = false`; callers inspect attachment state for progress.

The database schema version increases from 1 to 2. Existing old-schema databases continue to use the current reset-required behavior rather than automatic migration.

## Storage Behavior

`MessageDB` must preserve download status when syncing or upserting messages.

When an existing message is updated, attachment metadata can be refreshed from Telegram, but prior download state must be carried forward when the attachment still represents the same media. An attachment is treated as the same media when:

- both old and new attachments have the same non-null `unique_file_id`; or
- both lack `unique_file_id` and their `attachment_index`, `kind`, `role`, `file_name`, `mime_type`, and `file_size` all match.

If an attachment appears to have changed, its download state resets to not downloaded. This avoids treating an old local file as satisfying a new Telegram attachment.

Storage APIs must expose a narrow operation to mark one attachment as downloaded:

- account-local chat id
- message id
- attachment index
- path
- timestamp

The operation returns whether a row was updated so callers can warn when a download succeeded but status recording did not.

## CLI Download Behavior

`tg download` skips already downloaded attachments by default.

During target collection, the service checks the local attachment status. For each skipped attachment, it records an `already_downloaded` skip and emits a runtime notice such as:

```text
already downloaded: message 123 attachment 1
```

The structured result includes an `already_downloaded` count. Existing `skipped` remains available for total skipped work, and skip rows use reason `already_downloaded`.

`tg download --force` ignores the stored downloaded state, downloads selected attachments again, and updates `downloaded_at` and `download_path` on success.

Download failures do not clear prior successful state. Telegram permission checks and attachment matching still apply under `--force`.

## Archive Behavior

`tg archive --download-media` writes to the same attachment status store used by `tg download`.

When archive media is downloaded or an existing archive media file is reused, the corresponding attachment is marked downloaded. Archive Markdown continues to show the per-archive render status, and also includes persistent download state in each attachment line.

## Query And Structured Output

Stored messages returned by query-oriented APIs include message-level `downloaded`.

Attachments include:

- `downloaded`
- `downloaded_at`
- `download_path`

JSON/YAML output must preserve existing fields and add these fields without renaming current contracts.

## Web API And UI

`/api/messages` returns download state on `WebMessage` and `WebMessageAttachment`. Reply-context attachments include the same fields.

The React UI shows a compact status icon on each message item:

- No icon when the message has no downloadable attachments.
- Completed icon when all downloadable attachments are downloaded.
- Partial icon when some downloadable attachments are downloaded.
- Not-downloaded icon when none are downloaded.

Attachment rows show their own status. Tooltip text names the state: `Downloaded`, `Partially downloaded`, or `Not downloaded`.

After a web attachment download succeeds, the page reloads the current message page so the UI reflects persisted backend state. This keeps the frontend simple and avoids duplicating derivation logic.

## Error Handling

If the media file is downloaded successfully but the database status update fails, the download is not reported as a media failure. CLI output includes a warning. Web API returns the successful download result with a `warnings` array describing status-update failures.

Missing local messages or attachments keep the existing error semantics: `attachment_not_found`, `attachment_changed`, and `media_access_denied` continue to describe the relevant failure.

## Tests

Storage tests cover:

- schema version 2
- hydration of attachment and message download state
- preserving state on message upsert
- clearing state when attachment identity changes
- marking an attachment downloaded

Download service and command tests cover:

- default skip of already downloaded attachments
- runtime `already downloaded` notice
- structured `already_downloaded` count and skip reason
- `--force` redownload behavior
- success marking
- failure not clearing prior state

Archive tests cover:

- marking downloaded media from `--download-media`
- marking reused archive media
- Markdown output including persistent status

Web tests cover:

- `/api/messages` status fields
- `/api/download-media` marking state after success
- frontend message and attachment status icon rendering
- frontend refresh after successful download

## Non-Goals

- Automatic migration of existing v1 databases.
- Per-output-directory download state.
- File existence verification during every query.
- A separate UI for managing or clearing download history.
