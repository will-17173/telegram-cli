# Reply Context Display Design

## Goal

Show the message referenced by a Telegram reply in the human-readable output of `recent` and in both `listen` interfaces. The reply context includes the original message ID, timestamp, sender, and content.

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

- `recent` human-readable output;
- `listen --no-interactive` plain-text output;
- the interactive Ink `listen` interface.

It does not change:

- JSON or YAML output from `recent`;
- the SQLite `messages` schema;
- whether `listen` persists incoming messages;
- Telegram network access behavior.

## Data model

Introduce a presentation-oriented reply summary with these values:

- target message ID;
- target timestamp when resolved;
- target sender ID and display name when resolved;
- target content when resolved;
- resolution status.

The stored message type remains unchanged. Reply IDs are extracted from the Telegram raw message stored in `raw_json`. The extractor must accept both persisted JSON strings and the object-valued `raw_json` used before a message is persisted.

Malformed, absent, or unsupported raw data is treated as a non-reply rather than an error. A valid reply ID whose target is unavailable produces the not-found summary.

## Resolution architecture

Create a small shared reply-context module with two responsibilities:

1. Extract the replied-to message ID from Telegram raw message data.
2. Build a reply summary from a source capable of resolving `(chat_id, msg_id)`.

Add a batch lookup operation to `MessageDB` for messages identified by chat and Telegram message ID. Lookups must include the chat ID because Telegram message IDs are not globally unique.

### `recent`

`QueryService.recent` continues returning the unchanged stored messages as `data`. It extracts all reply IDs, resolves their targets in one database operation, and passes the resulting summaries only to the human presenter. This avoids an N+1 query pattern and preserves structured-output compatibility.

Only `recent` receives reply-aware table rendering. Search, today, and filter output remain unchanged.

### `listen`

The listener maintains a bounded in-memory cache of recently received messages, using the existing listen history limit where practical. Resolution follows this order:

1. Find the target in the current listener's in-memory messages.
2. Find the target in the active account's local message database.
3. Produce a not-found summary.

The listener does not request missing messages from Telegram and does not persist messages solely to support this feature.

Plain-text and Ink output receive the same resolved reply summary through the shared listen presentation model. For an album, use the first grouped message that contains a valid reply ID.

## Presentation

Reply context appears immediately before the current message content and is visually marked with `↳` so it is distinguishable from the message itself.

Resolved context contains:

- a locally formatted timestamp consistent with the surrounding view;
- sender display name, falling back to sender ID and then `Unknown`;
- Telegram message ID;
- original message content, using the existing no-text convention when content is absent.

The interactive listener includes reply lines in viewport height calculations so scrolling and clipping remain correct. Existing terminal wrapping and truncation behavior applies to long reply content.

## Error handling

- Invalid `raw_json`: treat the message as not being a reply.
- Missing target: show the target ID and the local-not-found label.
- Missing sender or content: use the same fallbacks already used by message presenters.
- Database lookup failure: preserve the command's existing error behavior; do not silently make a Telegram request.

## Testing

Use test-driven development and cover:

- extraction from object-valued and persisted string-valued raw JSON;
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
- album reply selection.

Run the focused Vitest suites during development, followed by:

```bash
pnpm test
pnpm typecheck
```

