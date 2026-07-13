# Reply Context and Media Group Display Design

## Goal

Improve the human-readable message model in two related ways:

1. Show the message referenced by a Telegram reply in `recent` and both `listen` interfaces. The reply context includes the original message ID, timestamp, sender, and content.
2. Combine the records belonging to one Telegram media group into one logical message in `recent`, and summarize the media contained by that message.

Structured JSON and YAML output must retain the existing stored-message contract.

## User-visible behavior

For a reply whose target exists locally, display a compact context line before the reply content:

```text
↳ Reply to [10:20] Bob (#123): original message content
current reply content
```

For a reply whose target cannot be found in the available local sources, display:

```text
↳ Reply to message #123 (not found locally)
current reply content
```

The actual CLI copy may follow the project's existing English output style. Reply context is informational and does not recursively include the target message's own reply context.

## Scope

The feature applies to:

- `recent` human-readable output, including media-group aggregation;
- `listen --no-interactive` plain-text output;
- the interactive Ink `listen` interface.

It does not change:

- JSON or YAML output from `recent`;
- the SQLite `messages` schema;
- whether `listen` persists incoming messages;
- Telegram network access behavior.

Search, today, and filter output do not gain media-group aggregation.

## Data model

Introduce a presentation-oriented reply summary with these values:

- target message ID;
- target timestamp when resolved;
- target sender ID and display name when resolved;
- target content when resolved;
- resolution status.

The stored message type remains unchanged. Reply IDs and Telegram media-group IDs are extracted from the raw message stored in `raw_json`. The extractor must accept both persisted JSON strings and the object-valued `raw_json` used before a message is persisted. It must support mtcute's `groupedId` form and the serialized `grouped_id` form.

Malformed, absent, or unsupported raw data is treated as a non-reply rather than an error. A valid reply ID whose target is unavailable produces the not-found summary.

## Resolution architecture

Create a small shared Telegram raw-message module with these responsibilities:

1. Safely parse object-valued or string-valued raw message data.
2. Extract the replied-to message ID.
3. Extract a stable media-group ID.

Create a reply-context module that builds a reply summary from a source capable of resolving `(chat_id, msg_id)`.

Add a batch lookup operation to `MessageDB` for messages identified by chat and Telegram message ID. Lookups must include the chat ID because Telegram message IDs are not globally unique.

### `recent`

`QueryService.recent` continues returning the current row-limited stored messages as `data`. It separately obtains the logical-message window used to build `human`, extracts all reply IDs from that window, resolves their targets in one database operation, and passes the resulting summaries only to the human presenter. This avoids an N+1 query pattern and preserves structured-output compatibility.

Only `recent` receives reply-aware table rendering. Search, today, and filter output remain unchanged.

For human output, `recent` groups stored records into logical messages:

- records with the same canonical chat ID and the same Telegram media-group ID form one logical message;
- records without a media-group ID remain independent messages;
- group members are ordered by Telegram message ID;
- the first non-empty content in the group becomes the logical message content;
- timestamp and sender come from the first group member;
- the first group member containing a valid reply ID supplies the reply relationship.

The `--limit` option counts logical messages in human output. For example, an album containing four database records counts as one visible message. The database layer reads recent records in descending batches until it has enough logical messages, then reads through the boundary required to ensure the oldest selected media group is complete. The final human output is restored to chronological order.

The structured `data` remains composed of the original stored rows. JSON and YAML therefore preserve their current row-based `--limit` behavior and contract; logical limit handling applies only to the human presentation path.

### `listen`

The listener maintains a bounded in-memory cache of recently received messages, using the existing listen history limit where practical. Resolution follows this order:

1. Find the target in the current listener's in-memory messages.
2. Find the target in the active account's local message database.
3. Produce a not-found summary.

The listener does not request missing messages from Telegram and does not persist messages solely to support this feature.

Plain-text and Ink output receive the same resolved reply summary through the shared listen presentation model. For an album, use the first grouped message that contains a valid reply ID.

The listener already aggregates live media groups. It uses the same logical-message media summarizer as `recent`, without changing its timing or persistence behavior.

## Presentation

Reply context appears immediately before the current message content and is visually marked with `↳` so it is distinguishable from the message itself.

Resolved context contains:

- a locally formatted timestamp consistent with the surrounding view;
- sender display name, falling back to sender ID and then `Unknown`;
- Telegram message ID;
- original message content, using the existing no-text convention when content is absent.

The interactive listener includes reply lines in viewport height calculations so scrolling and clipping remain correct. Existing terminal wrapping and truncation behavior applies to long reply content.

## Media-group presentation

A media group is rendered as one visible message rather than one row per Telegram record. The logical message contains its caption, when present, followed by a compact attachment summary.

Media metadata reuses the existing attachment discovery logic. Summaries use English CLI copy and aggregate repeated kinds:

```text
📎 4 Photos
📎 2 Videos, 1 Photo
📎 Document: report.pdf
```

Rules:

- repeated media kinds are displayed as counts with correct singular or plural labels;
- mixed media kinds are comma-separated;
- a single document with a Telegram filename displays that filename;
- a missing caption does not produce a placeholder dash when media is present;
- media summaries and reply context can appear on the same logical message;
- long content follows the existing terminal wrapping and truncation behavior.

## Error handling

- Invalid `raw_json`: treat the message as not being a reply.
- Invalid or absent media-group data: treat the database row as an independent message.
- Missing target: show the target ID and the local-not-found label.
- Missing sender or content: use the same fallbacks already used by message presenters.
- Database lookup failure: preserve the command's existing error behavior; do not silently make a Telegram request.

## Testing

Use test-driven development and cover:

- extraction from object-valued and persisted string-valued raw JSON;
- extraction of camel-case and snake-case media-group IDs;
- malformed and non-reply raw data;
- database lookup scoped by both chat ID and message ID;
- `recent` rendering with a resolved target;
- `recent` rendering with a missing target;
- unchanged `recent` JSON and YAML data contracts;
- plain-text `listen` resolution from memory;
- plain-text `listen` resolution from the database;
- interactive Ink row construction and rendering;
- missing targets in both listen modes;
- non-reply messages retaining their existing output;
- viewport line counting when reply context is present;
- album reply selection;
- grouping equal media-group IDs within one chat;
- keeping equal media-group IDs in different chats separate;
- photo, video, mixed-media, and named-document summaries;
- selection of the first non-empty album caption;
- logical `recent --limit` counting;
- complete media groups at the oldest query boundary;
- unchanged row-based JSON and YAML output;
- combined reply context and media summaries.

Run the focused Vitest suites during development, followed by:

```bash
pnpm test
pnpm typecheck
```
