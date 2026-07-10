# Listen Album Aggregation Design

## Problem

Telegram represents a media album as several messages. Each message owns one media item and the album members share a `groupedId`. The current `listen` path renders every update immediately, so an album is shown as several one-attachment messages. The current code already maps `message.text`—including a media caption—to `content`, but it lacks explicit regression coverage for text plus media.

## Scope

- Group incoming album members into one displayed listen message.
- Preserve the first non-empty caption in the album.
- Keep every attachment downloadable through the Telegram message ID that owns it.
- Apply identical grouping semantics to plain and interactive listen output.
- Preserve immediate output for messages without a grouped ID.
- Add regression tests for text plus a single attachment and captioned multi-image albums.

This change does not alter history synchronization, database persistence, or Telegram sending behavior.

## Design

Introduce a small listen-specific album aggregator between `TelegramClientAdapter.listen` and the presenters. It accepts individual `StoredMessageInput` values and emits display groups.

Messages without an album identifier are emitted immediately. Messages with the same chat and Telegram grouped ID are buffered together. A short inactivity timer of 300 milliseconds closes the group, which accommodates separate update delivery without adding noticeable latency. Stopping or disconnecting flushes all pending groups so the last album is not lost.

An emitted display group contains its original message members rather than manufacturing a fake Telegram message. Presentation code derives the sender and timestamp from the first member, selects the first non-empty `content` as the caption, and extracts one attachment from each member. Each attachment carries its owning chat ID and message ID for downloading.

The deduplication key remains the original `chat_id:msg_id` before aggregation. Album identity uses `chat_id` plus the raw message's `groupedId`; this prevents cross-chat collisions. If a grouped ID cannot be read, the message follows the ordinary immediate path.

## Output Behavior

Plain output renders one header, the caption when present, all attachment labels, and one separator for an album. Interactive output creates one visible row with all attachment lines. Selecting an attachment downloads using that attachment's original message ID.

Messages containing one attachment and caption continue to render both lines. Media-only messages omit the `(no text)` placeholder as before.

## Error and Lifecycle Handling

The aggregator owns its timers and exposes a flush operation. Listen completion, abort, disconnect, and component cleanup clear timers and flush or dispose pending state as appropriate. User callbacks remain synchronous from the caller's perspective; timer callbacks only emit already-received messages and do not perform Telegram operations.

## Testing

- Unit-test grouped-ID extraction against realistic raw Telegram message shapes.
- Unit-test immediate emission for ordinary messages.
- Unit-test two album members producing one group with two independently addressed attachments.
- Unit-test first non-empty caption selection.
- Unit-test flushing a pending album during shutdown.
- Add presenter regression coverage for text plus one attachment.
- Exercise both plain and Ink listen integration paths where practical.

Run `pnpm test`, `pnpm typecheck`, and `pnpm build` for final verification.
