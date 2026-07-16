# Unified Multi-Attachment Media Design

## Goal

Replace the project's separate media representations with one normalized, multi-attachment model shared by online reads, sync, history, listen, local queries, downloads, archives, and the Web UI.

The new model must:

- distinguish mtcute media types without MIME-based guessing;
- represent multiple and nested media objects in one Telegram message;
- provide stable attachment numbering for output and downloads;
- store queryable attachment metadata in SQLite;
- keep file references fresh at download time;
- expose only the new plural **attachments[]** contract;
- use a deliberate destructive data reset instead of compatibility or migration code.

This is the first of three independently delivered projects in the same release milestone. Reaction/forward/copy/message-link features and rich-text/topic/silent/scheduled sending will receive separate designs and implementation plans.

## Current Problems

The repository currently has several incompatible media paths:

- Online inbox/read/search uses high-level mtcute media and returns one **attachment**.
- Sync, history, and listen retain raw TL JSON and discard the normalized attachment.
- Listen, local presentation, Web, and downloads infer media again from raw JSON.
- Archive has a separate high-level normalizer and also assumes one attachment.
- Voice, sticker, animation, and round video can be misclassified because Telegram commonly wraps them as documents.
- Dice, live location, game, story, paid media, and todo media are not represented consistently.
- A single message cannot address more than one downloadable resource.
- Download APIs identify only a message, not a specific resource within the message.

The design removes these parallel interpretations. Raw TL remains available only as a diagnostic snapshot.

## Scope

### Included

- A single normalized message and attachment domain model.
- A fresh SQLite schema with a relational attachments table.
- All media variants exposed by the installed mtcute high-level MessageMedia union.
- Flat representation of nested media with explicit parent relationships.
- Per-message and album attachment numbering.
- Multi-attachment output and download behavior.
- Integration with online reads, sync, history, listen, local queries, export, Archive, and Web.
- An explicit destructive reset for old databases and generated archives.
- Per-attachment embedded previews without extra network requests.

### Excluded

- Compatibility with the existing SQLite schema, raw media parser, Archive manifest, or single-attachment output.
- Automatic database or Archive migration.
- Special parsing for raw-TL-only media such as Giveaway, GiveawayResults, or VideoStream.
- New local search filters by media type.
- New outgoing media types.
- Message edit/delete event synchronization.
- Reaction, forwarding, copying, message-link, and enhanced send features.

## Breaking-Change Policy

This release intentionally breaks stored-data and structured-output compatibility:

- The single **attachment** field is removed.
- All message contracts use **attachments[]**.
- Existing SQLite databases and generated Archive data must be explicitly reset.
- No old-schema reader, migration, backfill, legacy raw parser, or old-manifest reader is implemented.
- A schema mismatch fails with **data_reset_required** and does not delete data automatically.

The core application remains compatible with multiple accounts, but reset behavior is explicit and account-scoped.

## Architecture

The Telegram adapter boundary owns one normalizer:

~~~text
mtcute Message
    |
    v
normalizeTelegramMessage
    |
    +-- NormalizedMessage
    +-- Attachment[]
            |
            +-- online read/search/inbox output
            +-- sync/history/listen persistence
            +-- local query/export presentation
            +-- Archive rendering and media jobs
            +-- Web API and UI
            +-- download selection and refresh
~~~

No downstream consumer may inspect raw Telegram media or raw_json. This keeps mtcute-specific types inside src/telegram and makes the normalized model the only application-facing media contract. The adapter normalizer may perform one generic check for an otherwise-unrepresented raw media payload so it can emit **unknown**; it must not decode raw-TL fields or add constructor-specific branches.

Recommended boundaries:

- **src/telegram/media-types.ts** owns adapter-neutral media types.
- **src/telegram/mtcute-media-normalizer.ts** maps mtcute high-level objects into those types.
- **src/telegram/mtcute-message-normalizer.ts** produces the normalized message envelope.
- Storage owns relational persistence and message-plus-attachments assembly.
- Presenters consume normalized types and do not infer media.
- Download and Archive services consume attachment descriptors rather than raw messages.

Exact filenames may be adjusted to match implementation constraints, but these ownership boundaries must remain.

## Normalized Message Contract

The message retains the project's existing general fields and makes reply and album metadata explicit:

~~~ts
type NormalizedMessage = {
  platform: 'telegram'
  chat_id: number
  chat_name: string
  msg_id: number
  sender_id: number | null
  sender_name: string | null
  content: string | null
  timestamp: string
  reply_to_msg_id: number | null
  media_group_id: string | null
  raw_json: unknown
  attachments: Attachment[]
}
~~~

**raw_json** is a diagnostic snapshot. It may be exported for debugging, but it must not influence media presentation, downloads, grouping, or reply resolution.

## Attachment Contract

Attachments are a flat ordered list:

~~~ts
type Attachment = {
  attachment_index: number
  parent_attachment_index: number | null
  role: string
  kind: MediaKind
  subtype: string | null
  file_id: string | null
  unique_file_id: string | null
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  width: number | null
  height: number | null
  duration_seconds: number | null
  downloadable: boolean
  preview_jpeg_base64?: string
  metadata: Record<string, unknown>
}
~~~

Rules:

- **MediaKind** is the closed union photo, video, audio, voice, sticker, document, contact, location, live_location, venue, poll, dice, game, webpage, invoice, story, paid_media, todo, and unknown.
- **attachment_index** is one-based and unique within a Telegram message.
- **parent_attachment_index** points to another item in the same message.
- **role** explains the item's purpose, such as primary, cover, live_photo_video, paid_item, or game_media.
- **kind** is a stable lowercase application type.
- **subtype** captures variants that should not become top-level kinds, such as animation, round, and legacy_gif for video.
- Common display, identity, and query fields have dedicated columns.
- Type-specific fields belong in **metadata**.
- Metadata is built from an allowlist for each media kind and must contain only JSON-safe application values, never mtcute instances or raw TL objects.
- mtcute Long values and file identifiers are serialized as JSON-safe strings.
- A container or informational media object may be non-downloadable while its child resources are downloadable.

## Media Mapping

The normalizer derives all semantic fields from the installed mtcute high-level MessageMedia union:

- **photo**: one photo attachment; a live-photo video becomes a child with role live_photo_video.
- **video**: subtype distinguishes normal video, animation, round video, and legacy GIF.
- **audio**, **voice**, **sticker**, and **document** remain distinct high-level kinds.
- **contact**, **location**, **live_location**, **venue**, **dice**, and **todo** are structured informational attachments.
- **poll** is a container. Its general state and answers live in metadata; attached poll, answer, and solution media become children with explicit roles.
- **invoice** is a container. Its product web document and available full extended media become children. Preview-only extended media stays in metadata and the embedded preview field.
- **story** is a container. When mtcute includes the referenced story, its photo or video becomes a child; an unavailable story remains an informational reference.
- **game**, **webpage**, and **paid_media** create a container followed by their high-level child resources.
- A downloadable WebDocument is represented as **document** with subtype **web** and its URL in allowlisted metadata. A non-downloadable WebDocument remains a non-downloadable child descriptor.
- Unsupported high-level shapes produce **unknown** with safe diagnostic metadata.
- If mtcute does not expose a high-level object but the message contains a raw media payload, the generic unknown check produces **unknown** with only a safe constructor hint. Raw-TL-only types do not get special parsers.

Nested media is flattened depth first: the container receives an index before its children. Missing fields degrade only the affected attachment and never discard the complete message.

Telegram albums remain multiple messages sharing **media_group_id**. Each message has its own attachment numbering. Album-level presentation or selection flattens messages by message ID and then by message-local attachment index.

## SQLite Schema

The fresh schema has a message table and an attachment table:

~~~sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  chat_name TEXT,
  msg_id INTEGER NOT NULL,
  sender_id INTEGER,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT NOT NULL,
  reply_to_msg_id INTEGER,
  media_group_id TEXT,
  raw_json TEXT,
  UNIQUE(platform, chat_id, msg_id)
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_index INTEGER NOT NULL,
  parent_attachment_index INTEGER,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  subtype TEXT,
  file_id TEXT,
  unique_file_id TEXT,
  file_name TEXT,
  mime_type TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  downloadable INTEGER NOT NULL,
  preview_jpeg_base64 TEXT,
  metadata_json TEXT NOT NULL,
  UNIQUE(message_id, attachment_index),
  CHECK(attachment_index > 0),
  CHECK(parent_attachment_index IS NULL OR parent_attachment_index > 0),
  CHECK(downloadable IN (0, 1))
);
~~~

Indexes must support:

- ordered attachment loading by message;
- filtering attachments by kind for future use;
- lookup by unique_file_id;
- existing recent-message and chat-message access patterns.

SQLite foreign keys must be enabled. Parent relationships are validated as same-message, earlier-index references before insertion.

## Persistence Semantics

Writing a message and its attachments is atomic:

1. UPSERT the message row by platform, chat_id, and msg_id.
2. Delete the row's prior attachments.
3. Insert the complete normalized attachment list in order.
4. Commit only when all rows succeed.

Repeating sync, history, listen delivery, or a reconnect therefore replaces rather than duplicates attachments. A database failure rolls back the entire message.

Batch sync uses a fetched page as the transaction boundary while preserving per-message normalization isolation. A malformed media object becomes unknown; a persistence failure aborts and reports the current page.

Storage read methods assemble each message with its ordered attachments. Services and presenters must not issue their own attachment JOINs.

## Explicit Data Reset

The new database stores a fixed schema version. A nonexistent database or an empty newly created database initializes the current schema. An existing database with a different or missing application schema version returns:

~~~text
data_reset_required:
Run tg data reset --yes before using this version.
~~~

Commands:

~~~text
tg data reset --yes
tg data reset --all-accounts --yes
~~~

Default reset affects only the selected/current account. **--all-accounts** expands the operation to every account.

Reset deletes:

- the selected account's SQLite database and WAL/SHM files;
- generated Archive manifests;
- generated Archive Markdown;
- Archive-managed media directories.

Reset preserves:

- Telegram sessions and login state;
- API credentials and account configuration;
- ordinary files under the user's Telegram CLI download directory.

Reset is local-only and does not connect to Telegram. It recreates an empty schema or allows the next database open to do so. The user explicitly runs sync-all, history, or archive afterward to rebuild content.

Reset resolves account paths without opening MessageDB, because an old database is expected to fail the schema guard. The operation is idempotent when managed data is already absent.

Only the default per-account Archive directory is managed by reset. A custom Archive **--output** may point anywhere on disk and is never deleted implicitly; if it contains an unsupported old manifest, Archive fails and instructs the user to remove or choose a clean custom output explicitly.

The reset implementation must resolve and validate every managed path before deletion. It must refuse paths outside the configured data root and report partial filesystem failures precisely.

## Embedded Previews

Preview data moves from the message row to the attachment row.

- Each attachment may have its own **preview_jpeg_base64**.
- Only previews already embedded in the Telegram message are used.
- Sync, history, and listen do not make thumbnail network requests.
- Missing previews use a type icon or text placeholder.
- A preview extraction error affects only that attachment.

## Download Semantics

Single-message commands become:

~~~text
tg download <chat> <msg-id>
tg download <chat> <msg-id> --attachment <number>
~~~

Without **--attachment**, every downloadable attachment in the message is selected. With it, exactly that one-based item is selected.

Download flow:

1. Load the stored attachment descriptor.
2. Refetch the Telegram message to obtain current file references.
3. Normalize the fresh message through the same normalizer.
4. Match by unique_file_id first.
5. If no unique ID exists, require attachment_index, kind, role, and every available file fingerprint field (file name, MIME type, size, dimensions, and duration) to agree.
6. Refuse an ambiguous or changed match with **attachment_changed**.
7. Download to a temporary file and atomically rename it on success.

The database never persists mtcute FileLocation as a durable credential.

Additional rules:

- Selecting a container or informational item returns **attachment_not_downloadable**.
- Album selection orders messages by message ID and attachments by local index, then exposes album-level numbering from one through N.
- Range, date, and all-chat downloads process only downloadable items.
- Results enumerate skipped items with message ID, attachment index, kind, and reason.
- Telegram file names are preferred.
- Fallback names use chat ID, message ID, attachment index, and an inferred safe extension.
- Existing collision handling, bounded concurrency, flood-wait behavior, partial failure reporting, and temporary-file cleanup remain.

The Telegram download adapter accepts a specific attachment locator rather than only chat ID and message ID.

## Listen Behavior

Listen displays every attachment in order. Child items are visually indented beneath their parent container.

Automatic-download task identity becomes:

~~~text
chat_id:msg_id:attachment_index
~~~

Only downloadable items enter the queue. Album aggregation combines the already-normalized attachment lists of its member messages.

**--no-media** hides attachment presentation but does not disable persistence or automatic downloading.

## Local Queries and Export

Every returned message includes **attachments[]** and never includes **attachment**.

Reply context uses **reply_to_msg_id** from the normalized message row. Album grouping uses **media_group_id**. Media summaries use attachment kind, subtype, and role rather than raw JSON.

This project does not add media-type search flags, although the schema includes an index that permits a later feature to do so efficiently.

## Archive

Archive supports only the new format and assumes old generated data has been removed by explicit reset.

- Manifest messages contain **attachments[]**.
- Markdown lists every attachment beneath its message.
- Informational items render a concise summary.
- Containers render their metadata and child relationships.
- Downloadable items render a local link when available and a status otherwise.
- Managed filenames include message ID and attachment index.
- Successful metadata remains available when some media downloads fail.

There is no legacy manifest reader, format upgrader, automatic rebuild, or old Markdown parser.

## Web API and UI

Message pages, reply contexts, and download results use the same **attachments[]** structure.

The UI:

- displays attachments in index order;
- indents children using parent_attachment_index;
- uses embedded previews where available;
- shows download actions only for downloadable items;
- shows safe labels for unknown media.

Web download requests identify account, chat, message, and attachment index. The server reloads authoritative metadata from SQLite and chooses the filename and destination. The browser cannot supply an arbitrary destination path or trusted filename.

## Structured Output

JSON and YAML use stable snake_case fields:

~~~json
{
  "chat_id": -100123,
  "msg_id": 42,
  "content": "caption",
  "attachments": [
    {
      "attachment_index": 1,
      "parent_attachment_index": null,
      "role": "primary",
      "kind": "paid_media",
      "subtype": null,
      "file_id": null,
      "unique_file_id": null,
      "file_name": null,
      "mime_type": null,
      "file_size": null,
      "width": null,
      "height": null,
      "duration_seconds": null,
      "downloadable": false,
      "metadata": {}
    }
  ]
}
~~~

The single **attachment** field and Title Case media kinds are removed.

## Error Handling

Stable errors include:

- **data_reset_required**: stored schema is not current.
- **attachment_not_found**: the selected index does not exist.
- **attachment_not_downloadable**: the selected item is informational or a container.
- **attachment_changed**: fresh Telegram media cannot be matched safely.
- **media_access_denied**: permissions, content protection, or paid access prevents transfer.
- **download_partial_failure**: one or more selected downloads failed.
- **archive_partial_failure**: archive metadata completed but one or more media transfers failed.

A malformed optional media field degrades to null or unknown. Database, schema, and message-envelope failures remain visible and are not converted into unknown media.

## Testing

### Normalizer

- Every mtcute high-level MessageMedia kind.
- Video subtype distinctions.
- Live Photo child video.
- Paid media, game, and webpage containers with children.
- Poll answer/solution media, invoice web/extended media, and available story media.
- Deep-first ordering, stable one-based indices, parent links, and roles.
- File and Long values converted to safe strings.
- Missing optional fields.
- Unknown high-level and raw-only media.
- Multiple independent attachments in one message.

### Storage

- Fresh schema and schema-version validation.
- Message UPSERT with full attachment replacement.
- Transaction rollback.
- Ordered hydration of messages and attachments.
- Parent-index validation.
- Cascade deletion.
- Multi-message page writes.

### Reset

- Current-account and all-account scopes.
- Required **--yes** gate.
- Deletion of managed SQLite and Archive files.
- Preservation of sessions, configuration, and ordinary downloads.
- Preservation and explicit rejection guidance for custom Archive output directories.
- Data-root path containment.
- Precise partial-failure output.

### Download

- One selected attachment and all attachments in a message.
- Non-downloadable containers and informational objects.
- Album-level numbering.
- Range, date, and all-chat selection.
- Fresh-message matching by unique ID.
- Changed and ambiguous media.
- Safe fallback names and collisions.
- Partial failures, flood waits, concurrency, and temporary cleanup.

### Consumers

- Listen rows and auto-download task identity.
- Local query, reply context, album grouping, and export.
- Online inbox/read/search output.
- New Archive manifest and Markdown.
- Web message and download APIs.
- Web nested attachment rendering.
- Contract assertions that **attachment** is absent everywhere.
- Assertions that no functional media path depends on raw_json.

Final verification:

~~~text
pnpm test
pnpm typecheck
pnpm build
~~~

## Success Criteria

The project is complete when:

- all supported mtcute high-level media flows through one normalizer;
- every application surface uses the same ordered attachments array;
- a Telegram message can expose and download multiple nested resources safely;
- no consumer parses raw media;
- old data is rejected until an explicit reset;
- old attachment and Archive contracts have been removed;
- all tests, type checks, and production builds pass.
