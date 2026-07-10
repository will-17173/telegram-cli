# Listen Automatic Attachment Download Design

## Goal

Add an opt-in `--auto-download` flag to `tg listen`. When enabled, every downloadable attachment from a newly received Telegram message is saved automatically while listening.

The flag works in both the default interactive interface and `--no-interactive` plain-text mode. It is independent of `--no-media`: hiding attachment summaries does not disable downloads.

## Command Contract

```text
tg listen [chats...] --auto-download
```

- Automatic downloading is disabled by default.
- The flag may be combined with `--persist`, `--no-interactive`, and `--no-media`.
- Downloads use the existing `~/Downloads/telegram-cli` directory.
- The concurrency limit is fixed at three downloads. This design does not add a concurrency or destination option.
- Without `--auto-download`, current interactive manual-download behavior remains unchanged.

## Architecture

Introduce an `AutoDownloadCoordinator` service for each automatic-download listen run. The coordinator owns task deduplication, the pending queue, concurrency control, lifecycle transitions, and result callbacks. Interactive and plain-text listeners submit messages to the same service instead of implementing their own download scheduling.

The coordinator accepts messages only after the listen command's existing `chat_id:msg_id` event deduplication. It discovers every attachment that the existing media parsing logic identifies as downloadable and creates one task for each attachment. Telegram albums are aggregated for display as they are today, but each album member is submitted independently, so every attachment in the album is downloaded.

Each task is identified by its chat ID, message ID, and attachment index. Repeated update events and reconnect delivery within one listen process do not enqueue the same task twice, while multiple downloadable attachments discovered in one message remain distinct. A task passes through `queued`, `downloading`, `completed`, `failed`, or `cancelled` states. At most three tasks may be in `downloading` state at once; completion or failure starts the next queued task.

Attachment filename selection is shared by manual and automatic downloads. Telegram-provided filenames are preferred. Attachments without a filename use the existing chat-ID/message-ID fallback and media-kind extension. Destination resolution reuses the current filename sanitization and collision suffix rules, such as `photo (2).jpg` when `photo.jpg` already exists.

## Client and Lifecycle Handling

The coordinator uses the currently connected Telegram client to execute downloads. When listening disconnects, it pauses the start of new tasks. Downloads already in progress are allowed to settle as completed or failed before that client is closed. When persistent listening reconnects, the coordinator receives the replacement client, resumes the remaining queue, and preserves its task deduplication state.

Stopping the listener prevents new tasks from being accepted and cancels tasks that have not started. It does not wait for the complete pending queue. Closing the Telegram client terminates in-progress work, and those tasks are reported as failed or cancelled as appropriate.

If a task fails or is interrupted after creating its destination, the coordinator removes the incomplete file. A cleanup error must not mask the original download error or terminate listening.

## Presentation

### Interactive mode

Existing attachment rows display automatic-download state as queued, downloading, completed, or failed. Completed rows continue to show the final path. Manual attachment selection remains available, but pressing Enter for an attachment that is queued, downloading, or completed must not enqueue a duplicate download.

### Plain-text mode

Existing message output remains unchanged. The listener prints one concise result line after each task settles:

```text
downloaded: /Users/example/Downloads/telegram-cli/photo.jpg
download failed: <chat-id>:<message-id>: <reason>
```

Plain-text mode does not print continuous progress updates, because three concurrent progress streams would make output difficult to follow.

## Error Handling

A failed attachment download is isolated to its task. The failure is presented, incomplete output is cleaned up, and later queued tasks continue. A download error never ends `listen` and never disables persistent reconnection.

An attachment classified as downloadable by the local media parser may still be rejected when the Telegram adapter resolves or transfers it. That case produces a normal failed task result. The coordinator does not retry failed downloads in this version.

## Testing

Focused tests will verify:

- CLI parsing passes automatic-download configuration to both listener modes.
- No automatic tasks are created when the flag is absent.
- No more than three downloads execute concurrently, and queue consumption continues after completion.
- Duplicate update events and reconnect delivery do not download a task twice.
- Every downloadable album member is queued.
- `--no-media` hides summaries without disabling downloads.
- Telegram filenames, fallback names, sanitization, the default directory, and collision suffixes remain correct.
- One failed task does not prevent later tasks from running.
- Incomplete files are removed after failure or interruption.
- Interactive rows show queued, downloading, completed, and failed states and suppress duplicate manual requests.
- Plain-text mode prints terminal success or failure results without continuous progress.
- Shutdown cancels tasks that have not started and does not wait for the full queue.

Final verification will run:

```text
pnpm test
pnpm typecheck
```

## Out of Scope

- Configurable download directories.
- Configurable concurrency.
- Automatic retries.
- Persisting the download queue across CLI process restarts.
- Changing message persistence or structured output contracts.
