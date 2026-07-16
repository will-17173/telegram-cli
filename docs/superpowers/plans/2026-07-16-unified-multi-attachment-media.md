# Unified Multi-Attachment Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every single-attachment or raw-media path with one normalized `attachments[]` message model, a fresh relational SQLite schema, explicit destructive reset, safe per-attachment downloads, and matching Archive/Web/listen behavior.

**Architecture:** `src/telegram` performs the only mtcute-to-domain conversion and temporarily retains fresh `FileLocation` values only while downloading. Storage atomically upserts messages plus ordered attachments and hydrates the complete aggregate for every reader. Presenters, services, Archive, and Web consume the normalized aggregate and never inspect `raw_json`. Old databases, Archive v1 data, singular output, raw parsers, and migration paths are deleted rather than supported.

**Tech Stack:** Node.js 22+, TypeScript 5.9, mtcute 0.30.3, better-sqlite3 12, Commander 14, React 19, Ink 6, Vite 8, Vitest 4, pnpm

---

## Fixed implementation decisions

- This plan covers only unified media recognition. Reaction/forward/copy/message-link and rich-text/topic/silent/scheduled-send work remain separate projects.
- The final tree contains no database migration, legacy schema reader, Archive upgrader, singular `attachment` response, or raw media parser.
- SQLite uses `PRAGMA user_version = 1`; Archive uses manifest `schema_version: 2`; the shared JSON/YAML envelope uses string `schema_version: '2'`. These are independent version domains.
- The Archive root manifest remains an account/chat cursor file. It does not duplicate all archived messages; `ArchiveMessage` and Markdown blocks carry `attachments[]`.
- CLI downloads prefer a valid local descriptor but retain online fallback for a message/range/date/all-chat operation. Web downloads always reload the descriptor from SQLite.
- `raw_json` remains exportable diagnostic data. No grouping, reply, media, download, Archive, or Web behavior may parse it.
- Listen persists an accepted message before displaying, grouping, or auto-downloading it. `--no-media` changes display only.
- Do not add temporary legacy fields or runtime translation shims. It is acceptable for an intermediate working tree to fail type-checking during the atomic contract cutover; finish the named task before committing.

## File map

### Create

- `src/telegram/media-types.ts`: adapter-neutral media/message domain types.
- `src/telegram/mtcute-media-normalizer.ts`: exhaustive high-level mtcute media traversal and transient download-location map.
- `src/telegram/attachment-locator.ts`: stable locator projection and fresh-descriptor matcher.
- `src/presenters/attachment.ts`: labels, summaries, source-message wrappers, and parent depth.
- `src/services/data-reset-service.ts`: path-safe destructive reset without opening SQLite.
- `tests/telegram/media-types.test.ts`
- `tests/telegram/mtcute-media-normalizer.test.ts`
- `tests/telegram/mtcute-message-normalizer.test.ts`
- `tests/telegram/attachment-locator.test.ts`
- `tests/storage/message-db-schema.test.ts`
- `tests/presenters/attachment.test.ts`
- `tests/services/data-reset-service.test.ts`
- `tests/commands/data.test.ts`
- `tests/architecture/media-boundary.test.ts`

### Core files to modify

- `src/telegram/mtcute-message-normalizer.ts`
- `src/telegram/dialog-types.ts`
- `src/telegram/types.ts`
- `src/telegram/mtcute-client.ts`
- `src/telegram/mtcute-dialogs.ts`
- `src/telegram/fake-client.ts`
- `src/storage/message-db.ts`
- `src/account/account-presets.ts`
- `src/commands/data.ts`
- `src/commands/query.ts`
- `src/commands/telegram.ts`
- `src/commands/telegram-runner.ts`
- `src/services/sync-service.ts`
- `src/services/data-service.ts`

### Consumer files to modify

- `src/presenters/human.ts`
- `src/presenters/logical-message.ts`
- `src/presenters/listen-message.ts`
- `src/presenters/ink/listen.tsx`
- `src/presenters/ink/listen-scroll.ts`
- `src/services/reply-context.ts`
- `src/services/listen-reply-resolver.ts`
- `src/services/listen-album-aggregator.ts`
- `src/services/auto-download-coordinator.ts`
- `src/services/attachment-download.ts`
- `src/services/query-service.ts`
- `src/services/download-service.ts`

### Archive files to modify

- `src/telegram/archive-types.ts`
- `src/telegram/mtcute-archive.ts`
- `src/services/archive-types.ts`
- `src/services/archive-manifest.ts`
- `src/services/archive-layout.ts`
- `src/services/archive-markdown.ts`
- `src/services/archive-service.ts`
- `src/commands/archive.ts`

### Web files to modify

- `src/web/types.ts`
- `src/web/query.ts`
- `src/web/api.ts`
- `src/web/server.ts`
- `src/web/sync-task.ts`
- `web/src/api.ts`
- `web/src/App.tsx`
- `web/src/styles.css`

### Delete after all consumers have moved

- `src/services/listen-attachment.ts`
- `src/telegram/raw-message.ts`
- `src/telegram/raw-media-location.ts`
- `tests/services/listen-attachment.test.ts`
- `tests/telegram/raw-message.test.ts`
- `tests/telegram/raw-media-location.test.ts`

### Delete when embedded previews move into attachment normalization

- `tests/telegram/mtcute-thumbnail.test.ts`

### Documentation and contract files to modify

- `src/presenters/structured.ts`
- `README.md`
- `README.zh-CN.md`
- `site/index.html`
- `site/docs/index.html`
- `site/zh-CN/index.html`
- `site/zh-CN/docs/index.html`
- All affected tests under `tests/commands`, `tests/services`, `tests/storage`, `tests/telegram`, `tests/presenters`, `tests/web`, and `tests/cli`.

## Task 1: Define the canonical media and message contract

**Files:**

- Create: `src/telegram/media-types.ts`
- Create: `tests/telegram/media-types.test.ts`
- Modify: `tests/fixtures/messages.ts`

- [ ] **Step 1: Write the failing contract test**

Create `tests/telegram/media-types.test.ts` and assert the exact closed kind list, one-based fixture index, null parent, JSON-safe metadata, and plural message field:

```ts
import { describe, expect, it } from 'vitest'
import { MEDIA_KINDS } from '../../src/telegram/media-types.js'
import { attachment, message } from '../fixtures/messages.js'

describe('canonical media contract', () => {
  it('publishes the closed lowercase media kind set', () => {
    expect(MEDIA_KINDS).toEqual([
      'photo', 'video', 'audio', 'voice', 'sticker', 'document',
      'contact', 'location', 'live_location', 'venue', 'poll',
      'dice', 'game', 'webpage', 'invoice', 'story',
      'paid_media', 'todo', 'unknown',
    ])
  })

  it('builds messages with plural ordered attachments', () => {
    const value = message({ attachments: [attachment({ kind: 'photo' })] })
    expect(value.attachments[0]).toMatchObject({
      attachment_index: 1,
      parent_attachment_index: null,
      role: 'primary',
      kind: 'photo',
    })
    expect(value).not.toHaveProperty('attachment')
  })
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
pnpm exec vitest run tests/telegram/media-types.test.ts
```

Expected: FAIL because `media-types.ts` and the `attachment` fixture do not exist.

- [ ] **Step 3: Add the canonical types**

Create `src/telegram/media-types.ts` with this exact public shape:

```ts
export const MEDIA_KINDS = [
  'photo',
  'video',
  'audio',
  'voice',
  'sticker',
  'document',
  'contact',
  'location',
  'live_location',
  'venue',
  'poll',
  'dice',
  'game',
  'webpage',
  'invoice',
  'story',
  'paid_media',
  'todo',
  'unknown',
] as const

export type MediaKind = typeof MEDIA_KINDS[number]

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type Attachment = {
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
  metadata: Record<string, JsonValue>
}

export type NormalizedMessage = {
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
```

- [ ] **Step 4: Centralize complete test fixtures**

In `tests/fixtures/messages.ts`, export builders whose defaults include every required field:

```ts
export function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    attachment_index: 1,
    parent_attachment_index: null,
    role: 'primary',
    kind: 'document',
    subtype: null,
    file_id: null,
    unique_file_id: null,
    file_name: null,
    mime_type: null,
    file_size: null,
    width: null,
    height: null,
    duration_seconds: null,
    downloadable: false,
    metadata: {},
    ...overrides,
  }
}

export function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 1,
    sender_id: 10,
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-03-09T10:00:00.000Z',
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [],
    ...overrides,
  }
}
```

Retain `fixtureMessages()`, but implement it through the complete `message()` builder. Do not add legacy single-attachment defaults.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/telegram/media-types.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the canonical contract**

```bash
git add src/telegram/media-types.ts tests/telegram/media-types.test.ts tests/fixtures/messages.ts
git commit -m "feat: define normalized Telegram media contract"
```

## Task 2: Normalize leaf and informational mtcute media

**Files:**

- Create: `src/telegram/mtcute-media-normalizer.ts`
- Create: `tests/telegram/mtcute-media-normalizer.test.ts`
- Delete: `tests/telegram/mtcute-thumbnail.test.ts`

- [ ] **Step 1: Write failing leaf-media tests**

Use structural mtcute-compatible fixtures so tests do not need a live Telegram session. Cover photo, four video subtypes, audio, voice, sticker, document, contact, location, live location, venue, dice, and todo. Include assertions that voice/audio/sticker/video are selected by `media.type`, not MIME guessing, and that a stripped preview is read only from `Uint8Array`.

The public result asserted by the tests is:

```ts
expect(normalizeMtcuteMedia({
  media: photoFixture,
  rawMedia: undefined,
})).toMatchObject({
  attachments: [{
    attachment_index: 1,
    parent_attachment_index: null,
    role: 'primary',
    kind: 'photo',
    subtype: null,
    downloadable: true,
  }],
})
```

- [ ] **Step 2: Run the normalizer test and verify RED**

Run:

```bash
pnpm exec vitest run tests/telegram/mtcute-media-normalizer.test.ts
```

Expected: FAIL because the normalizer module does not exist.

- [ ] **Step 3: Add the exhaustive public seam and discriminator sentinel**

Create the following exports:

```ts
import type {
  FileLocation,
  MessageMedia,
  MessageMediaType,
} from '@mtcute/node'
import type { Attachment } from './media-types.js'

export type MtcuteMediaNormalization = {
  attachments: Attachment[]
  locations: ReadonlyMap<number, FileLocation>
}

export function normalizeMtcuteMedia(input: {
  media: MessageMedia
  rawMedia?: unknown
}): MtcuteMediaNormalization

const SUPPORTED_MTCUTE_MEDIA_TYPES = {
  photo: true,
  dice: true,
  contact: true,
  audio: true,
  voice: true,
  sticker: true,
  document: true,
  video: true,
  location: true,
  live_location: true,
  game: true,
  webpage: true,
  venue: true,
  poll: true,
  invoice: true,
  story: true,
  paid: true,
  todo: true,
} satisfies Record<MessageMediaType, true>
```

Reference `SUPPORTED_MTCUTE_MEDIA_TYPES` from the dispatcher so it is not dead code. A future mtcute union member must fail compilation.

- [ ] **Step 4: Implement the one-based builder and leaf mappings**

The builder must allocate the descriptor before registering its location and must validate that every parent index is smaller than its child. Use safe getters for `fileId` and `uniqueFileId`; getter failure yields `null`, not message loss.

Apply these exact subtype rules:

- video: `round` before `legacy_gif`, `legacy_gif` before `animation`, otherwise `normal`;
- sticker: `static | animated | video` from `sourceType`;
- WebDocument, when reached later: `document` with subtype `web`.

Use only allowlisted JSON-safe metadata. At minimum preserve:

- photo: spoiler and TTL;
- video: spoiler, TTL, codec, video start, and video timestamp;
- audio: performer and title;
- voice: TTL and waveform;
- sticker: emoji, sticker/source type, premium/valid flags, custom emoji ID, mask position;
- contact: first/last name, phone number, and user ID from high-level getters only;
- location/live location/venue: coordinates and the high-level accuracy/period/heading/provider fields;
- dice: emoji and value;
- todo: title, append/complete flags, and item completion summaries.

Convert mtcute `Long` values with `.toString()`. Never call `Number(long)`.

- [ ] **Step 5: Extract embedded previews without network access**

Only encode a thumbnail when:

```ts
thumbnail.location instanceof Uint8Array
```

mtcute 0.30.3's high-level `Thumbnail` constructor has already expanded `photoStrippedSize` with its internal `strippedPhotoToJpg()` helper before exposing `location`. Therefore encode the exposed bytes once with `Buffer.from(thumbnail.location).toString('base64')`; do not run a second JPEG reconstruction. A TL location, function/thunk, or throwing getter is ignored. Do not call any download API.

Move every case from `tests/telegram/mtcute-thumbnail.test.ts` into the attachment-normalizer suite, then delete that old test because it imports the removed message-level `embeddedPhotoPreviewBase64()` helper. The focused test must assert decoded bytes begin with JPEG SOI `ff d8` and end with EOI `ff d9`, proving `preview_jpeg_base64` contains a complete JPEG rather than raw stripped bytes. Preserve the throwing getter, remote location, malformed entry, and non-photo/document-derived coverage at the new boundary.

Apply this helper independently to every high-level attachment that exposes thumbnails (photo and document-derived video/audio/voice/sticker/document) and to extended-media preview children/containers. Never assign one message-level preview to a different attachment.

- [ ] **Step 6: Run leaf-media tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/telegram/mtcute-media-normalizer.test.ts
```

Expected: PASS for all leaf and informational cases.

- [ ] **Step 7: Commit leaf normalization**

```bash
git add src/telegram/mtcute-media-normalizer.ts tests/telegram/mtcute-media-normalizer.test.ts tests/telegram/mtcute-thumbnail.test.ts
git commit -m "feat: normalize Telegram media descriptors"
```

## Task 3: Normalize nested and container media

**Files:**

- Modify: `src/telegram/mtcute-media-normalizer.ts`
- Modify: `tests/telegram/mtcute-media-normalizer.test.ts`

- [ ] **Step 1: Add failing nested-media cases**

Add fixtures for Live Photo, video cover, game, webpage, poll, invoice preview/full states, story available/unavailable states, paid previews/full media, raw-only media, repeated unique file IDs, and a child getter that throws.

Assert exact depth-first roles:

| Container/source | Child order | Child role |
| --- | --- | --- |
| photo | live video | `live_photo_video` |
| video | cover | `cover` |
| game | photo, animation | `game_media` |
| webpage | photo, document | `webpage_media` |
| poll | attached, answers, solution | `poll_attached_media`, `poll_answer_media`, `poll_solution_media` |
| invoice | product WebDocument, full extended | `invoice_product_media`, `invoice_extended_media` |
| story | story media | `story_media` |
| paid | previews, full items | `paid_preview`, `paid_item` |

For poll answer children, assert `metadata.poll_answer_index` is zero-based and stable.

- [ ] **Step 2: Run nested tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/telegram/mtcute-media-normalizer.test.ts
```

Expected: FAIL because only leaf media is implemented.

- [ ] **Step 3: Add recursive container traversal**

Containers receive `role: 'primary'`, their descriptor is appended before children, and the resulting flat indices are never deduplicated by file ID. A nested container recursively uses its assigned parent.

Guard these mtcute 0.30.3 traps explicitly:

- `PaidMedia.type` is `paid`, but domain kind is `paid_media`;
- `PaidMedia.medias` may contain `null`;
- determine paid visibility from `previews.length` and `medias.length`, not mtcute 0.30.3's unreliable `isPaid` getter;
- `Invoice.extendedMediaPreview` and `extendedMedia` throw outside their matching state;
- `PollAnswer.media` and `Poll.solutionMedia` may throw when peers are unavailable;
- unavailable story content is still a non-downloadable `story` descriptor;
- WebDocument always maps to `kind: 'document'`, `subtype: 'web'`, null file IDs/name, its high-level URL in metadata, and high-level MIME/size fields; only `isDownloadable === true` registers its transient `FileLocation`.

If an expected nested getter throws, append an `unknown` child at that semantic position with metadata `{ getter: '<name>' }`. Do not discard the container or its other children.

- [ ] **Step 4: Apply the exact container metadata allowlists**

Use these snake_case projections and no raw TL fields:

| Kind | Metadata |
| --- | --- |
| `game` | `id` as decimal string, `title`, `description`, `short_name` |
| `webpage` | `id` as decimal string, `url`, `display_url`, `preview_type`, `site_name`, `title`, `description`, `author`, `embed_url`, `embed_type`, `embed_width`, `embed_height`, `display_size`, `manual`, `safe` |
| `poll` | `id` as decimal string, `question`, `voters`, `is_closed`, `is_public`, `is_quiz`, `is_multiple`, `is_creator`, `can_add_answers`, `is_revoting_disabled`, `shuffle_answers`, `hide_results_until_close`, `has_unread_votes` (from mtcute's misspelled `hasUnreaVotes` getter), `is_subscribers_only`, `countries`, `can_view_stats`, `solution`, and `answers` |
| `poll.answers[]` | `answer_index`, `text`, `data_base64`, `voters`, `chosen`, `correct` |
| `invoice` | `title`, `description`, `receipt_message_id`, `currency`, `amount` as decimal string, `start_param`, `shipping_address_requested`, `test`, `extended_media_state`; preview state also adds `preview_width`, `preview_height`, and `preview_duration_seconds` |
| `story` | `peer_id`, `peer_name`, `story_id`, `is_mention`, `available`; when available also `story_date`, `story_expire_date`, and `caption` |
| `paid_media` | `price` as decimal string, `preview_count`, `item_count` |
| `todo` | `title`, `others_can_append`, `others_can_complete`, and `items` |
| `todo.items[]` | `id`, `text`, `is_completed`, `completed_by_id`, `completed_by_name`, `completed_date` |

Project Dates to ISO strings, `TextWithEntities` through its high-level `.text` field, `Uint8Array` to base64, unavailable scalar values to explicit null, and unavailable lists to empty arrays. Do not serialize message entities in this media project; rich text belongs to the later rich-text project. A scalar getter failure yields null; a list getter failure yields an empty list. `getter_errors: string[]` is the only common diagnostic metadata field and contains only the names of failed high-level getters.

- [ ] **Step 5: Add preview-only descriptors**

Invoice preview state stays on the invoice container as width/height/duration metadata plus optional embedded preview. Paid previews are separate non-downloadable children:

```ts
{
  role: 'paid_preview',
  kind: 'paid_media',
  subtype: 'preview',
  downloadable: false,
}
```

- [ ] **Step 6: Add generic unknown behavior**

When high-level media is `null` and `rawMedia` exists, emit one `unknown` attachment whose metadata contains only a string constructor hint from `rawMedia._`. Do not branch on Giveaway, GiveawayResults, VideoStream, or any other raw constructor. With no high-level or raw media, return empty arrays/maps.

- [ ] **Step 7: Run the full normalizer matrix**

Run:

```bash
pnpm exec vitest run tests/telegram/mtcute-media-normalizer.test.ts
```

Expected: PASS. The `satisfies Record<MessageMediaType, true>` sentinel is checked by the full TypeScript run after the atomic consumer cutover.

- [ ] **Step 8: Commit nested normalization**

```bash
git add src/telegram/mtcute-media-normalizer.ts tests/telegram/mtcute-media-normalizer.test.ts
git commit -m "feat: normalize nested Telegram media"
```

## Task 4: Normalize the message envelope and online readers

**Files:**

- Modify: `src/telegram/mtcute-message-normalizer.ts`
- Create: `tests/telegram/mtcute-message-normalizer.test.ts`
- Modify: `src/telegram/dialog-types.ts`
- Modify: `src/telegram/mtcute-dialogs.ts`
- Modify: `src/telegram/types.ts`
- Modify: `src/telegram/mtcute-client.ts`
- Modify: `src/telegram/fake-client.ts`
- Create: `src/presenters/attachment.ts`
- Modify: `src/presenters/human.ts`
- Modify: `tests/telegram/mtcute-dialogs.test.ts`
- Modify: `tests/telegram/mtcute-send-media.test.ts`
- Modify: `tests/telegram/fake-client-online-reading.test.ts`
- Modify: `tests/services/dialog-service.test.ts`
- Modify: `tests/presenters/human.test.ts`

- [ ] **Step 1: Write failing message-envelope tests**

Assert the complete normalized object, empty text to null, explicit reply/group fields, plural attachments, diagnostic raw snapshot, and absence of `text`, `attachment`, and message-level preview:

```ts
const normalized = normalizeMtcuteMessage(messageFixture)
expect(normalized).toMatchObject({
  platform: 'telegram',
  chat_id: -100123,
  chat_name: 'General',
  msg_id: 42,
  content: 'caption',
  reply_to_msg_id: 7,
  media_group_id: 'album-id',
})
expect(normalized.attachments).toHaveLength(2)
expect(normalized).not.toHaveProperty('text')
expect(normalized).not.toHaveProperty('attachment')
expect(normalized).not.toHaveProperty('preview_jpeg_base64')
```

- [ ] **Step 2: Run the message test and verify RED**

Run:

```bash
pnpm exec vitest run tests/telegram/mtcute-message-normalizer.test.ts
```

Expected: FAIL because the old normalizer returns the online single-attachment contract.

- [ ] **Step 3: Replace the old normalizer with the single entry point**

Export only:

```ts
export function normalizeMtcuteMessage(message: Message): NormalizedMessage
```

Populate `chat_name` from the non-empty high-level display name or the literal `Unknown`, `reply_to_msg_id` from `message.replyToMessage?.id`, `media_group_id` from `message.groupedIdUnique`, and `raw_json` from a JSON-safe diagnostic projection of `message.raw`. Pass only this generic raw-media value to the media normalizer:

```ts
const rawMedia =
  message.raw?._ === 'message'
    ? message.raw.media
    : undefined
```

Delete `normalizeAttachment()` and `toOnlineMessage()`. Strip transient locations before returning the message.

- [ ] **Step 4: Remove the Telegram-to-storage reverse dependency**

In `src/telegram/types.ts`, import `NormalizedMessage` from `media-types.ts`, not `StoredMessageInput` from storage. Use it for `fetchHistory`, listen callbacks, and optional sent-message results.

In `mtcute-client.ts`, route history, listen, sent-message, and thumbnail behavior through `normalizeMtcuteMessage()`. Remove the message-level `embeddedPhotoPreviewBase64()` field and the private single-media conversion.

- [ ] **Step 5: Switch online dialog contracts**

Define:

```ts
export type OnlineMessage = NormalizedMessage
```

Make inbox/read/search call `normalizeMtcuteMessage()`. Update fake-client cloning to clone `attachments` and every `metadata` object so callers cannot mutate fixtures.

- [ ] **Step 6: Add adapter-neutral labels and plural summaries**

Start `src/presenters/attachment.ts` with lowercase-kind labels and a plural summary that accepts `Attachment[]`. Human online tables must read `content` and show every attachment kind/subtype; remove `summarizeOnlineAttachment()`.

- [ ] **Step 7: Run online/message tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  tests/telegram/mtcute-message-normalizer.test.ts \
  tests/telegram/mtcute-dialogs.test.ts \
  tests/telegram/mtcute-send-media.test.ts \
  tests/telegram/fake-client-online-reading.test.ts \
  tests/services/dialog-service.test.ts \
  tests/presenters/human.test.ts
```

Expected: PASS; all asserted message objects contain `content` and `attachments[]` only. In `mtcute-send-media.test.ts`, replace the legacy `storedMessage()` expectation (including message-level `preview_jpeg_base64`) with the complete `NormalizedMessage` returned by the shared normalizer, including `reply_to_msg_id`, `media_group_id`, and an empty `attachments` array for the text-only fixture.

- [ ] **Step 8: Commit the normalized message boundary**

```bash
git add \
  src/telegram/mtcute-message-normalizer.ts \
  src/telegram/dialog-types.ts \
  src/telegram/mtcute-dialogs.ts \
  src/telegram/types.ts \
  src/telegram/mtcute-client.ts \
  src/telegram/fake-client.ts \
  src/presenters/attachment.ts \
  src/presenters/human.ts \
  tests/telegram/mtcute-message-normalizer.test.ts \
  tests/telegram/mtcute-dialogs.test.ts \
  tests/telegram/mtcute-send-media.test.ts \
  tests/telegram/fake-client-online-reading.test.ts \
  tests/services/dialog-service.test.ts \
  tests/presenters/human.test.ts
git commit -m "feat: unify Telegram message normalization"
```

Stage only files changed by this task; do not accidentally include reference-source directories.

## Task 5: Replace SQLite initialization with a fresh-schema guard

**Files:**

- Modify: `src/storage/message-db.ts`
- Create: `tests/storage/message-db-schema.test.ts`

- [ ] **Step 1: Add failing schema-guard tests**

Cover:

- nonexistent and zero-table version-0 databases initialize;
- old `messages` schema with version 0 throws and remains byte/schema unchanged;
- wrong nonzero version throws;
- current version with a missing required table throws;
- sync and async readonly snapshots reject old data and remove their snapshot directories;
- current schema exposes the required indexes and foreign keys.

Assert a typed error:

```ts
expect(() => new MessageDB(oldPath)).toThrowError(
  expect.objectContaining({
    code: 'data_reset_required',
    actualVersion: 0,
  }),
)
```

- [ ] **Step 2: Run storage tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/storage/message-db-schema.test.ts
```

Expected: FAIL because the current constructor silently creates/alters the old table.

- [ ] **Step 3: Add the typed schema error**

Export:

```ts
export const MESSAGE_DB_SCHEMA_VERSION = 1

export class DataResetRequiredError extends Error {
  readonly code = 'data_reset_required'

  constructor(
    readonly path: string,
    readonly actualVersion: number | null,
  ) {
    super('Run `tg data reset --yes` before using this version.')
    this.name = 'DataResetRequiredError'
  }
}

export function isDataResetRequiredError(
  error: unknown,
): error is DataResetRequiredError {
  return error instanceof DataResetRequiredError
}
```

- [ ] **Step 4: Guard before mutating connection pragmas**

After opening, read `PRAGMA user_version` and user tables before `journal_mode=WAL` or any DDL. Initialize only when version is 0 and no user table exists. Otherwise require version 1 plus both application tables. Validate the required column names/nullability/primary-key shape with `PRAGMA table_info`, the message foreign key with `PRAGMA foreign_key_list`, and required indexes with `PRAGMA index_list`; a stamped but malformed schema is still `data_reset_required`. Close before throwing.

Enable `PRAGMA foreign_keys = ON` on every writable and snapshot connection. Validate readonly snapshots after copying and before returning.

- [ ] **Step 5: Create the fresh schema transaction**

Use this schema without ALTER or migration branches:

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  chat_name TEXT NOT NULL,
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

CREATE INDEX idx_messages_chat_ts ON messages(chat_id, timestamp);
CREATE INDEX idx_messages_recent ON messages(timestamp DESC, id DESC);
CREATE INDEX idx_messages_chat_recent ON messages(chat_id, timestamp DESC, id DESC);
CREATE INDEX idx_messages_content ON messages(content);
CREATE INDEX idx_messages_sender ON messages(sender_name);
CREATE INDEX idx_attachments_message_order ON attachments(message_id, attachment_index);
CREATE INDEX idx_attachments_kind ON attachments(kind);
CREATE INDEX idx_attachments_unique_file_id
  ON attachments(unique_file_id)
  WHERE unique_file_id IS NOT NULL;
PRAGMA user_version = 1;
```

Delete `ensurePreviewColumn()`, the message preview column, and any raw grouped-ID import.

- [ ] **Step 6: Run schema tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/storage/message-db-schema.test.ts
```

Expected: PASS, including writable, sync-readonly, and async-readonly guard cases.

- [ ] **Step 7: Commit the destructive schema boundary**

```bash
git add src/storage/message-db.ts tests/storage/message-db-schema.test.ts
git commit -m "feat: require fresh relational message schema"
```

## Task 6: Add atomic message/attachment UPSERT and hydration

**Files:**

- Modify: `src/storage/message-db.ts`
- Modify: `tests/storage/message-db.test.ts`
- Modify: `tests/storage/message-db-readonly.test.ts`
- Modify: `tests/fixtures/messages.ts`

- [ ] **Step 1: Replace old insert expectations with failing UPSERT tests**

Cover first insert, duplicate update, stable message primary key, full attachment replacement, ordered hydration, metadata/preview round trip, parent validation, batch rollback, cascade delete, multi-message hydration, regex search, grouped lookup by column, and a result set larger than SQLite's bind-variable limit.

Assert:

```ts
expect(db.upsertBatch([first, replacement])).toEqual({
  inserted: 1,
  updated: 1,
  total: 2,
})
expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1 }])[0].attachments)
  .toEqual(replacement.attachments)
```

- [ ] **Step 2: Run storage tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/storage/message-db-schema.test.ts \
  tests/storage/message-db.test.ts \
  tests/storage/message-db-readonly.test.ts
```

Expected: FAIL because `upsertBatch` and attachment hydration do not exist.

- [ ] **Step 3: Replace storage types and public write API**

Use:

```ts
export type StoredMessageInput = NormalizedMessage

export type StoredMessage = Omit<NormalizedMessage, 'raw_json'> & {
  id: number
  raw_json: string | null
}

export type MessageWriteSummary = {
  inserted: number
  updated: number
  total: number
}

upsertMessage(input: StoredMessageInput): 'inserted' | 'updated'
upsertBatch(inputs: StoredMessageInput[]): MessageWriteSummary
```

Delete `insertMessage` and `insertBatch`; do not leave wrappers.

- [ ] **Step 4: Validate the aggregate before writing**

Require indices `1..N` in array order, unique indices, parent references to an existing earlier item, closed media kinds, finite numeric values, and JSON-safe metadata. Reject bigint, undefined metadata values, cycles, NaN, and Infinity before starting SQL writes.

- [ ] **Step 5: Implement one transaction per batch**

Within one outer transaction:

1. `INSERT ... ON CONFLICT DO NOTHING` to distinguish inserted from existing;
2. on conflict, ordinary `UPDATE` without replacing the row;
3. select the stable message row ID;
4. delete its prior attachments;
5. insert the complete validated list in index order.

Never use `INSERT OR REPLACE`. Any row failure rolls back all messages in the page.

- [ ] **Step 6: Hydrate every message-returning method**

Route `search`, `searchRegex`, `getRecent`, `getRecentPage`, `getMessagesPage`, `getMessagesByKeys`, `getToday`, and `findMessagesByGroupedId` through one private batch hydrator. Load attachment rows in chunks of at most 500 message IDs, parse `metadata_json`, sort by index, and omit `preview_jpeg_base64` when SQL returns null.

Replace grouped lookup with:

```sql
WHERE platform = 'telegram'
  AND chat_id = ?
  AND media_group_id = ?
ORDER BY msg_id ASC
```

- [ ] **Step 7: Run storage tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  tests/storage/message-db-schema.test.ts \
  tests/storage/message-db.test.ts \
  tests/storage/message-db-readonly.test.ts
```

Expected: PASS, including rollback, cascade, and chunked hydration.

- [ ] **Step 8: Commit relational persistence**

```bash
git add src/storage/message-db.ts tests/storage/message-db.test.ts tests/storage/message-db-readonly.test.ts tests/fixtures/messages.ts
git commit -m "feat: persist normalized message attachments"
```

## Task 7: Add explicit account-scoped data reset and schema-error boundaries

**Files:**

- Create: `src/services/data-reset-service.ts`
- Create: `tests/services/data-reset-service.test.ts`
- Create: `tests/commands/data.test.ts`
- Modify: `src/account/account-presets.ts`
- Modify: `src/commands/data.ts`
- Modify: `src/commands/query.ts`
- Modify: `src/commands/telegram-runner.ts`
- Modify: `src/commands/archive.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/sync-task.ts`
- Modify: `tests/cli/help.test.ts`
- Modify: `tests/commands/telegram-error-boundary.test.ts`
- Modify: `tests/web/api.test.ts`
- Modify: `tests/web/sync-task.test.ts`

- [ ] **Step 1: Write failing reset-service tests**

Test current account, all accounts including logged-out entries, confirmation gate, DB/WAL/SHM/default Archive deletion, preservation of session/config/registry/downloads/custom Archive, idempotence, a symlinked final Archive path, an account-root ancestor symlink escaping the data root, path containment preflight, and injected partial removal failure.

- [ ] **Step 2: Write failing command tests**

Assert:

```text
tg data reset --yes
tg data reset --all-accounts --yes
```

Also assert missing `--yes` returns `confirmation_required`, and `--all-accounts` plus global `--account` returns `invalid_option` without deleting anything.

- [ ] **Step 3: Run reset tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/services/data-reset-service.test.ts tests/commands/data.test.ts
```

Expected: FAIL because the service and nested command do not exist.

- [ ] **Step 4: Export the single source of account-managed paths**

In `account-presets.ts`, export containment-checked helpers:

```ts
export function accountRootPath(dataDir: string, accountName: string): string
export function accountArchivePath(dataDir: string, accountName: string): string
```

Make `accountSessionPath`, `accountDbPath`, Archive's default output, and reset use these helpers.

- [ ] **Step 5: Implement reset without constructing MessageDB**

Use this service contract:

```ts
export type DataResetResult = {
  accounts_reset: string[]
  removed_paths: string[]
}

export type DataResetFailure = {
  account: string
  path: string
  code: string | null
  message: string
}

export class DataResetService {
  constructor(input: {
    dataDir: string
    removePath?: (path: string) => void
  })

  reset(input: {
    accountNames: string[]
    confirmed: boolean
  }): HandlerResult<DataResetResult>
}
```

Precompute and validate all `messages.db`, `messages.db-wal`, `messages.db-shm`, and default `archive` paths inside the configured data root before deleting the first target. Resolve the real data root, walk every existing ancestor from the data root to each target with `lstat/realpath`, and reject the whole reset before deletion if an ancestor symlink escapes that root. A final target that is itself a symlink is unlinked rather than followed. Missing paths are successful no-ops. Continue after independent filesystem failures only after global preflight succeeds, and return `data_reset_partial_failure` with precise failure details.

- [ ] **Step 6: Register the nested command separately from export/purge**

Keep existing top-level `export` and `purge`. Add `data reset` with `--yes`, `--all-accounts`, `--json`, and `--yaml`. Current-account reset may use a logged-out account and must not authenticate or connect to Telegram. All-account reset reads `AccountStore.list()` directly.

Do not route reset through the helper that opens `DataService(new MessageDB(...))`.

- [ ] **Step 7: Map reset-required errors at every boundary**

When `isDataResetRequiredError(error)` is true, render:

```ts
{
  ok: false,
  error: {
    code: 'data_reset_required',
    message: 'Run `tg data reset --yes` before using this version.',
    details: {
      path: error.path,
      expected: MESSAGE_DB_SCHEMA_VERSION,
      actual: error.actualVersion,
    },
  },
}
```

Apply it before generic Telegram/database handling in query, data/export/purge, sync/history, Web API (HTTP 409), and Web sync-task boundaries. Archive v1 in a custom output remains `archive_schema_unsupported` and tells the user to remove that custom output or select an empty directory.

- [ ] **Step 8: Run reset and error-boundary tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  tests/services/data-reset-service.test.ts \
  tests/commands/data.test.ts \
  tests/cli/help.test.ts
pnpm exec vitest run \
  tests/commands/telegram-error-boundary.test.ts \
  tests/web/api.test.ts \
  tests/web/sync-task.test.ts \
  -t "data_reset_required"
```

Expected: PASS; reset tests confirm no Telegram factory and no MessageDB construction, and the focused boundary cases preserve the typed reset code. Task 8 runs the complete sync-related files after replacing the removed insert API.

- [ ] **Step 9: Commit reset and typed boundaries**

```bash
git add \
  src/account/account-presets.ts \
  src/services/data-reset-service.ts \
  src/commands/data.ts \
  src/commands/query.ts \
  src/commands/telegram-runner.ts \
  src/commands/archive.ts \
  src/web/api.ts \
  src/web/sync-task.ts \
  tests/services/data-reset-service.test.ts \
  tests/commands/data.test.ts \
  tests/commands/telegram-error-boundary.test.ts \
  tests/web/api.test.ts \
  tests/web/sync-task.test.ts \
  tests/cli/help.test.ts
git commit -m "feat: add explicit local data reset"
```

## Task 8: Persist sync pages and all listen messages

**Files:**

- Modify: `src/telegram/types.ts`
- Modify: `src/telegram/mtcute-client.ts`
- Modify: `src/telegram/fake-client.ts`
- Modify: `src/services/sync-service.ts`
- Modify: `src/commands/telegram.ts`
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `tests/telegram/mtcute-history.test.ts`
- Modify: `tests/services/sync-service.test.ts`
- Modify: `tests/commands/telegram-lifecycle.test.ts`
- Modify: `tests/commands/telegram-listen.test.ts`
- Modify: `tests/presenters/ink-listen.test.tsx`
- Modify: `tests/web/sync-task.test.ts`

- [ ] **Step 1: Write failing page-transaction tests**

Add `onPage` expectations to mtcute history tests. In SyncService tests, simulate page 1 success and page 2 invalid attachment metadata; assert page 1 remains committed, page 2 is entirely rolled back, and the failure is local rather than `telegram_error`.

- [ ] **Step 2: Write failing listen-persistence tests**

For both plain and interactive listen, assert a received multi-attachment message is in SQLite before output/auto-download callbacks run. Cover `--no-media`, non-persistent listen, reconnect duplicate replacement, write failure abort, old-schema `data_reset_required`, and DB close.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/telegram/mtcute-history.test.ts \
  tests/services/sync-service.test.ts \
  tests/commands/telegram-listen.test.ts \
  tests/presenters/ink-listen.test.tsx
```

Expected: FAIL because history writes only after the complete fetch and listen does not write.

- [ ] **Step 4: Add the history-page callback**

Extend:

```ts
export type FetchHistoryOptions = {
  chat: string | number
  limit: number
  minId?: number
  maxId?: number
  offset?: { id: number; date: number }
  pageDelay?: number
  onProgress?: (count: number) => void
  onPage?: (page: NormalizedMessage[]) => void
}
```

For each Telegram page, normalize the entire page first, invoke `onPage(page)`, then update progress/return accumulation. A thrown callback stops the fetch. Fake clients and every test mock that returns history must invoke `options.onPage?.(rows)`.

- [ ] **Step 5: Persist each sync page**

Pass `onPage: page => db.upsertBatch(page)` from history/sync/refresh. Accumulate only `summary.inserted` into existing public `stored`, `synced`, `new_messages`, and per-chat result counts; do not call updates “new messages.” Remove all `insertBatch` calls.

- [ ] **Step 6: Persist before listen side effects**

Open one writable `MessageDB` for the listen lifetime. For every Telegram delivery, synchronously call `db.upsertMessage(message)` first. Only after the UPSERT succeeds may the seen-message set suppress duplicate display, album aggregation, and auto-download side effects. This lets a reconnect replace changed attachment rows without displaying the same message twice.

Pass the same `persistMessage` callback into the interactive runtime and call it before its side-effect deduplication and before `onMessage`/enqueue. Capture a thrown write, abort the listener, close client/DB, and surface `data_reset_required` unchanged or another local database error. Never leave an event-emitter rejection unhandled.

- [ ] **Step 7: Run sync/listen tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  tests/telegram/mtcute-history.test.ts \
  tests/services/sync-service.test.ts \
  tests/commands/telegram-lifecycle.test.ts \
  tests/commands/telegram-listen.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/web/sync-task.test.ts
```

Expected: PASS; no test observes display/download before persistence.

- [ ] **Step 8: Commit page and listen persistence**

```bash
git add \
  src/telegram/types.ts \
  src/telegram/mtcute-client.ts \
  src/telegram/fake-client.ts \
  src/services/sync-service.ts \
  src/commands/telegram.ts \
  src/presenters/ink/listen.tsx \
  tests/telegram/mtcute-history.test.ts \
  tests/services/sync-service.test.ts \
  tests/commands/telegram-lifecycle.test.ts \
  tests/commands/telegram-listen.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/web/sync-task.test.ts
git commit -m "feat: persist normalized sync and listen messages"
```

## Task 9: Switch logical messages, reply context, listen, and local presenters

**Files:**

- Modify: `src/presenters/attachment.ts`
- Create: `tests/presenters/attachment.test.ts`
- Modify: `src/presenters/logical-message.ts`
- Modify: `src/presenters/listen-message.ts`
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `src/presenters/ink/listen-scroll.ts`
- Modify: `src/services/reply-context.ts`
- Modify: `src/services/listen-reply-resolver.ts`
- Modify: `src/services/listen-album-aggregator.ts`
- Modify: `src/services/query-service.ts`
- Modify: `src/services/data-service.ts`
- Modify: `src/presenters/human.ts`
- Modify: matching tests under `tests/presenters` and `tests/services`

- [ ] **Step 1: Write failing attachment-presentation tests**

Assert source message IDs, stable keys, lowercase safe labels, per-attachment preview, and nested depth:

```ts
const rows = presentMessageAttachments(message({
  msg_id: 42,
  attachments: [
    attachment({ attachment_index: 1, kind: 'game' }),
    attachment({
      attachment_index: 2,
      parent_attachment_index: 1,
      role: 'game_media',
      kind: 'photo',
    }),
  ],
}))

expect(rows.map((row) => ({
  key: row.key,
  depth: row.depth,
  kind: row.kind,
}))).toEqual([
  { key: '100:42:1', depth: 0, kind: 'game' },
  { key: '100:42:2', depth: 1, kind: 'photo' },
])
```

- [ ] **Step 2: Rewrite consumer tests before implementation**

Update logical-message, listen-message, Ink, reply-context, reply-resolver, album-aggregator, query-service, data-service, and human tests to populate explicit `reply_to_msg_id`, `media_group_id`, and `attachments`. Remove raw media fixtures from those cases.

Assert resolved reply context contains `attachments[]`, an album combines member messages in message-ID order, and `--no-media` hides only the rendered list.

Use `rg -n "StoredMessageInput|NormalizedMessage" tests` to update every remaining manual fixture with `reply_to_msg_id: null`, `media_group_id: null`, and `attachments: []`. Use the central builders where possible; do not weaken required fields to make stale fixtures compile.

- [ ] **Step 3: Run consumer tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/presenters/attachment.test.ts \
  tests/presenters/logical-message.test.ts \
  tests/presenters/listen-message.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/services/reply-context.test.ts \
  tests/services/listen-reply-resolver.test.ts \
  tests/services/listen-album-aggregator.test.ts \
  tests/services/query-service.test.ts \
  tests/services/data-service.test.ts \
  tests/presenters/human.test.ts
```

Expected: FAIL because consumers still parse `raw_json` or discover the old media shape.

- [ ] **Step 4: Complete the attachment presenter**

Use this adapter-neutral internal view:

```ts
export type PresentedAttachment = Attachment & {
  chatId: number
  messageId: number
  key: string
  depth: number
  label: string
}

export function presentMessageAttachments(
  message: NormalizedMessage,
): PresentedAttachment[]

export function attachmentSummary(
  attachments: Attachment[],
): string | null
```

Compute depth only through earlier parent indices. A missing/cyclic parent is a programmer/storage error and must throw rather than silently inventing layout. Labels use known lowercase kinds, optional subtype, role, filename, MIME, and humanized size; unknown stays a safe “Unknown media” label.

- [ ] **Step 5: Remove raw grouping and reply extraction**

In `logical-message.ts`, build the key from `media_group_id` and the reply context from `reply_to_msg_id`. Summaries flatten each member's canonical attachments.

In `listen-album-aggregator.ts`, use `message.media_group_id` directly. In reply resolver/query service, pass hydrated messages without a raw conversion.

- [ ] **Step 6: Rename listen's internal media collection**

Use:

```ts
export type ListenMessageRow = {
  time: string
  chatId: number
  sender: string
  senderId: number | null
  chatName?: string
  content: string | null
  attachments: PresentedAttachment[]
  attachmentSummary: string | null
  replyContext?: ReplyContext
}
```

Render every item in index order and indent children in Ink. Continue counting preview rows in viewport height. Plain output must include chat name followed by `(chat_id)` when listening to all chats and must preserve the existing sender/message header behavior.

- [ ] **Step 7: Extend reply context with canonical attachments**

Resolved context contains:

```ts
{
  messageId: number
  resolved: true
  timestamp: string
  senderId: number | null
  senderName: string | null
  content: string | null
  attachments: Attachment[]
}
```

When content is empty, human context uses `attachmentSummary()`; structured consumers receive the full array.

Text export appends the same attachment summary beneath each message. JSON/YAML export returns the fully hydrated attachments without presenter-only fields.

- [ ] **Step 8: Run consumer tests and verify GREEN**

Run the command from Step 3.

Expected: PASS; tests no longer need a raw media object for any behavior.

- [ ] **Step 9: Commit canonical consumers**

```bash
git add \
  src/presenters/attachment.ts \
  src/presenters/logical-message.ts \
  src/presenters/listen-message.ts \
  src/presenters/ink/listen.tsx \
  src/presenters/ink/listen-scroll.ts \
  src/presenters/human.ts \
  src/services/reply-context.ts \
  src/services/listen-reply-resolver.ts \
  src/services/listen-album-aggregator.ts \
  src/services/query-service.ts \
  src/services/data-service.ts \
  tests/presenters/attachment.test.ts \
  tests/presenters/logical-message.test.ts \
  tests/presenters/listen-message.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/presenters/listen-scrollbar.test.tsx \
  tests/presenters/human.test.ts \
  tests/services/reply-context.test.ts \
  tests/services/listen-reply-resolver.test.ts \
  tests/services/listen-album-aggregator.test.ts \
  tests/services/query-service.test.ts \
  tests/services/data-service.test.ts
git commit -m "refactor: consume normalized message attachments"
```

Do not stage unrelated service files; verify the staged list with `git diff --cached --name-only`.

## Task 10: Match a stored attachment to fresh mtcute media

**Files:**

- Create: `src/telegram/attachment-locator.ts`
- Create: `tests/telegram/attachment-locator.test.ts`

- [ ] **Step 1: Write failing pure matcher tests**

Cover unique-ID success, duplicate unique-ID ambiguity, no unique ID with exact fingerprint, changed index/kind/role/name/MIME/size/dimensions/duration, missing index, and selected non-downloadable item.

- [ ] **Step 2: Run matcher tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/telegram/attachment-locator.test.ts
```

Expected: FAIL because the locator module does not exist.

- [ ] **Step 3: Implement the public locator projection**

Create:

```ts
export type AttachmentLocator = Pick<
  Attachment,
  | 'attachment_index'
  | 'unique_file_id'
  | 'kind'
  | 'role'
  | 'file_name'
  | 'mime_type'
  | 'file_size'
  | 'width'
  | 'height'
  | 'duration_seconds'
>

export type AttachmentLookupCode =
  | 'attachment_not_found'
  | 'attachment_not_downloadable'
  | 'attachment_changed'

export class AttachmentLookupError extends Error {
  constructor(
    readonly code: AttachmentLookupCode,
    message: string,
  ) {
    super(message)
    this.name = 'AttachmentLookupError'
  }
}

export function toAttachmentLocator(
  attachment: Attachment,
): AttachmentLocator

export function selectStoredAttachment(
  attachments: Attachment[],
  attachmentIndex: number,
): Attachment

export function matchFreshAttachment(
  locator: AttachmentLocator,
  fresh: Attachment[],
): Attachment
```

`selectStoredAttachment()` returns `attachment_not_found` for a missing user-selected index and `attachment_not_downloadable` for a known non-downloadable item. After selection, if `unique_file_id` exists, exactly one fresh item must share it. Otherwise select the same one-based index and require kind, role, file name, MIME type, size, dimensions, and duration to be strictly equal, including null-versus-value changes. Zero or multiple safe fresh matches are `attachment_changed`.

- [ ] **Step 4: Define the shared transfer request without changing adapters yet**

Export this request beside `AttachmentLocator` in `attachment-locator.ts`:

```ts
export type DownloadMessageMediaOptions = {
  chat: string | number
  msgId: number
  attachment: AttachmentLocator
  destination: string
  onProgress?: (downloaded: number, total: number) => void
}
```

Do not change either adapter interface in this task: doing so would break its callers across later tasks. Task 11 switches both adapters and every caller in one atomic checkpoint. Keeping this request beside the locator lets both adapter interfaces import it without a `types.ts`/`archive-types.ts` cycle.

- [ ] **Step 5: Run pure locator tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/telegram/attachment-locator.test.ts
```

Expected: PASS, including changed/ambiguous attachment rejection.

- [ ] **Step 6: Commit the pure locator boundary**

```bash
git add \
  src/telegram/attachment-locator.ts \
  tests/telegram/attachment-locator.test.ts
git commit -m "feat: define safe attachment locators"
```

## Task 11: Cut downloads, Archive, and Web to multi-attachment media atomically

Phases A-E below are one implementation task and one commit. Do not pause, hand off, or commit between the phases: Phase A changes both download adapters and the Web download request before Phase C finishes Archive consumers and Phases D-E finish the matching Web response/client contract. This single checkpoint avoids compatibility fields while ensuring every commit on the branch remains buildable and the Web download UI never targets a mismatched backend.

### Phase A: Download all selected attachments in CLI and listen

**Files:**

- Modify: `src/services/attachment-download.ts`
- Modify: `src/services/download-service.ts`
- Modify: `src/services/auto-download-coordinator.ts`
- Modify: `src/telegram/types.ts`
- Modify: `src/telegram/archive-types.ts`
- Modify: `src/telegram/mtcute-client.ts`
- Modify: `src/telegram/mtcute-archive.ts`
- Modify: `src/telegram/fake-client.ts`
- Modify: `src/web/api.ts`
- Modify: `src/commands/telegram.ts`
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `tests/services/attachment-download.test.ts`
- Modify: `tests/services/download-service.test.ts`
- Modify: `tests/services/auto-download-coordinator.test.ts`
- Modify: `tests/telegram/mtcute-download.test.ts`
- Modify: `tests/telegram/mtcute-archive.test.ts`
- Modify: `tests/telegram/fake-client-download.test.ts`
- Modify: `tests/commands/telegram-listen.test.ts`
- Modify: `tests/commands/download.test.ts`
- Modify: `tests/presenters/ink-listen.test.tsx`
- Modify: `tests/web/api.test.ts`

- [ ] **Step 1: Rewrite service tests for multi-attachment selection**

Cover:

- one message without `--attachment` downloads all downloadable children;
- message-local explicit selection;
- selected container/informational errors;
- album order by message ID then local index, with one album-level index across all items;
- range/date/all skips non-downloadable items with details;
- fallback names, collisions, concurrency, flood wait, temp cleanup, and partial failure.
- manual Ink transfer failure leaves no final file and removes its `.part` file.
- core and Archive adapters always refetch and reject changed/ambiguous descriptors;
- Archive history pages return complete `NormalizedMessage` values; Archive download refetches and locator-matches one exact fresh attachment while retaining `O_NOFOLLOW` staging.
- Web reloads the selected descriptor from SQLite and never trusts request filename/path fields.

Use this public result:

```ts
export type DownloadResult = {
  chat: string | number
  output: string
  requested: number
  downloaded: number
  skipped: number
  failed: number
  flood_waits: number
  files: Array<{
    chat_id: number
    msg_id: number
    selection_index: number
    attachment_index: number
    kind: MediaKind
    path: string
  }>
  skips: Array<{
    msg_id: number
    selection_index: number
    attachment_index: number
    kind: MediaKind
    reason: string
  }>
  failures: Array<{
    msg_id: number
    selection_index: number
    attachment_index: number
    kind: MediaKind
    code:
      | 'attachment_changed'
      | 'media_access_denied'
      | 'download_partial_failure'
    error: string
  }>
}
```

- [ ] **Step 2: Run download tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/services/attachment-download.test.ts \
  tests/services/download-service.test.ts \
  tests/services/auto-download-coordinator.test.ts \
  tests/telegram/mtcute-download.test.ts \
  tests/telegram/mtcute-archive.test.ts \
  tests/telegram/fake-client-download.test.ts \
  tests/commands/telegram-listen.test.ts \
  tests/commands/download.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/web/api.test.ts
```

Expected: FAIL because callers omit locators, collection assumes one attachment per message, result fields use `attachment`, and both adapters still expose their old download contracts.

- [ ] **Step 3: Switch both adapter boundaries and always refetch**

Reuse the `DownloadMessageMediaOptions` exported beside `AttachmentLocator` in Task 10. Import and re-export it from `src/telegram/types.ts`, and import it directly into `src/telegram/archive-types.ts`; its message property is exactly `msgId`. Delete `location?: unknown`, message-only signatures, and the `messageId` alias.

In `src/telegram/archive-types.ts`, define:

```ts
export type ArchiveMessage = NormalizedMessage
```

Make both adapters download through the same sequence: `getMessages`, canonical normalization plus transient locations, `matchFreshAttachment()`, exact matched `FileLocation`, then transfer. Delete the core listened-media location cache and reverse its cache test so even a just-listened attachment is refetched. Map content protection, permissions, paid access, and unavailable references to `media_access_denied`; never expose or reuse a stale raw location.

Make `TelegramArchiveAdapter.downloadMedia()` accept `DownloadMessageMediaOptions`. Make `MtcuteArchive.iterHistoryPages()` call `normalizeMtcuteMessage()`. Delete `toArchiveMessage()`, `normalizeArchiveAttachment()`, and `downloadableLocation()`, while preserving the Archive no-follow stream path.

Update `FakeTelegramClient`'s core and Archive download call records, failure keys, and byte fixtures for `msgId + AttachmentLocator`; clone canonical attachments and their metadata. It is expected that `archive-markdown.ts` and `archive-service.ts` do not typecheck until Phase C; do not commit this intermediate tree.

- [ ] **Step 4: Include attachment index in every generated filename**

Fallback names must be:

```text
<chat-id>-<msg-id>-<attachment-index>.<safe-extension>
```

Preserve Telegram filename when safe, but collision handling remains server/service controlled. Extension inference uses kind/subtype/MIME; no filename is derived from `raw_json`.

Centralize the existing collision-safe staging workflow in `attachment-download.ts` so DownloadService, listen/manual download, auto-download, and Web can all: reserve a unique sibling `.part` path with exclusive creation; transfer only into that path; atomically publish without overwriting a racing user file; and remove the part on success, cancellation, or failure.

- [ ] **Step 5: Replace target collection**

For a single message, flatten all its attachments; without a flag select downloadable items and record other items in `skips`. With a flag, address the exact local index and return the stable not-found/not-downloadable error.

For an album, sort member messages by `msg_id`, sort each list by `attachment_index`, flatten all items, and assign album indices `1..N`. Keep the descriptor's message-local index in the adapter locator.

Expose that flattened number as `selection_index` in files, skips, and failures. For a single message it equals `attachment_index`; the adapter always receives the message-local `attachment_index`.

For range/date/all, traverse online normalized messages and select every downloadable item. CLI may use a valid hydrated local message/album first; if a single message is absent locally, fall back to the online history path. An old local DB must surface `data_reset_required`, not be ignored.

Classify every failed target: preserve `attachment_changed` and `media_access_denied`; classify any other transfer exception as `download_partial_failure`. If an explicit `--attachment` selects exactly one target, no file succeeds, and the adapter returns `attachment_changed` or `media_access_denied`, return that stable code directly at the top level. For multiple targets, mixed outcomes, or an unclassified transfer failure, return `download_partial_failure` with complete counts, files, skips, and coded failures while preserving every successful file.

- [ ] **Step 6: Pass locators into every transfer**

DownloadService, manual Ink actions, and auto-download must call the adapter with `toAttachmentLocator(attachment)` and give it only the reserved temporary path. The final path is published only after the adapter resolves. Auto-download key is exactly the three colon-separated values `chat_id`, `msg_id`, and one-based `attachment_index`.

In the Web API, accept only authoritative identifiers in each item: `chat_id`, `msg_id`, and `attachment_index`; ignore unknown keys and never read a browser-provided filename or destination. Resolve the selected account, open its MessageDB readonly, batch-load the requested messages scoped by `chat_id + msg_id`, call `selectStoredAttachment()`, choose the filename/destination server-side, and pass the locator plus reserved temporary path to the core adapter. Return HTTP 409 for `data_reset_required`; preserve `attachment_not_found`, `attachment_not_downloadable`, `attachment_changed`, and `media_access_denied`; use a coded partial result for mixed batches. A child lookup is always scoped to its source message, so repeated local indices in an album cannot cross-match.

Only downloadable items enter the queue. Preserve persistence behavior even when `showMedia` is false.

- [ ] **Step 7: Remove grouped raw conversion from the command**

Delete `toDownloadArchiveMessage()` and old raw discovery imports. Hydrate grouped messages directly with `findMessagesByGroupedId()`. Rename `download_attachment_not_found` to `attachment_not_found`.

- [ ] **Step 8: Run Phase A tests and verify GREEN**

Run the command from Step 2.

Expected: PASS; every file/failure/skip identifies `attachment_index` and `kind`, failures carry stable codes, explicit single-item change/access errors remain top-level, and Web request metadata cannot control a local path.

- [ ] **Step 9: Continue directly to Phase B without committing**

Keep every Phase A change in the working tree. Do not run full typecheck yet; the singular Archive consumers are removed in Phase C.

### Phase B: Cut the Archive manifest and layout to v2

**Files:**

- Modify: `src/services/archive-types.ts`
- Modify: `src/services/archive-manifest.ts`
- Modify: `src/services/archive-layout.ts`
- Modify: `src/commands/archive.ts`
- Modify: `tests/services/archive-manifest.test.ts`
- Modify: `tests/services/archive-layout.test.ts`
- Modify: `tests/commands/archive.test.ts`

- [ ] **Step 1: Write failing Archive v2 foundation tests**

Assert manifest version 2 is accepted, version 1 is rejected as `archive_schema_unsupported`, and a managed filename contains both message and attachment indices.

- [ ] **Step 2: Run foundation tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/services/archive-manifest.test.ts \
  tests/services/archive-layout.test.ts \
  tests/commands/archive.test.ts
```

Expected: FAIL because the manifest and managed filename still use v1.

- [ ] **Step 3: Advance only the Archive manifest version**

Set:

```ts
export type ArchiveManifest = {
  schema_version: 2
  account_name: string
  account_user_id: number
  created_at: string
  updated_at: string
  chats: Record<string, ArchiveChatState>
}
```

The chat state stays cursor/account metadata only. Do not add a message inventory. The parser accepts exactly version 2; version 1 is unsupported and has no upgrader.

- [ ] **Step 4: Add attachment index to Archive layout**

Replace the signature with:

```ts
export function archiveMediaFile(
  chatId: number,
  messageId: number,
  attachmentIndex: number,
  filename: string,
): string
```

Use `<messageId>-<attachmentIndex>-<safe-name>` and include both numeric prefixes in the UTF-8 byte budget and reserved-name checks.

- [ ] **Step 5: Improve custom-output error guidance**

For an unsupported manifest under explicit `--output`, return the original stable error plus guidance to delete that directory manually or choose a clean path. Never add it to `data reset` targets.

- [ ] **Step 6: Run Archive foundation tests and verify GREEN**

Run the command from Step 2.

Expected: PASS; v1 is rejected and managed filenames include the attachment index.

- [ ] **Step 7: Continue directly to Phase C without committing**

Keep the v2 foundation changes together with Phase A. The Archive adapter and its consumers are still one uncommitted cutover.

### Phase C: Render, recover, and download every Archive attachment

**Files:**

- Modify: `src/services/archive-markdown.ts`
- Modify: `src/services/archive-service.ts`
- Modify: `tests/services/archive-markdown.test.ts`
- Modify: `tests/services/archive-service.test.ts`
- Modify: `tests/commands/archive.test.ts`

- [ ] **Step 1: Write failing multi-attachment Markdown tests**

Cover container plus children, informational summaries, downloaded/reused/not-requested/not-downloadable/failed states, per-item preview-independent metadata, and child indentation.

Define the renderer input:

```ts
export type ArchiveAttachmentRenderState = {
  attachment: Attachment
  status:
    | 'downloaded'
    | 'reused'
    | 'not_downloadable'
    | 'not_requested'
    | 'failed'
  path?: string
}

export function renderArchiveMessage(
  message: ArchiveMessage,
  states: ArchiveAttachmentRenderState[],
): string
```

- [ ] **Step 2: Write failing recovery and service tests**

Assert recovery identifies `messageId + attachmentIndex + path`, only accepts v2 filename lines, redownloads an individually missing file, keeps successful siblings when one transfer fails, and reports warnings with attachment index/kind.

- [ ] **Step 3: Run Archive behavior tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/telegram/mtcute-archive.test.ts \
  tests/services/archive-markdown.test.ts \
  tests/services/archive-service.test.ts \
  tests/commands/archive.test.ts
```

Expected: FAIL because Markdown/service accept one path per message and still consume the removed singular Archive fields.

- [ ] **Step 4: Render all attachment states**

For each message, emit one ordered attachment line. Include index, lowercase kind, subtype/role, concise allowlisted metadata, and local link/status. Indent children one level per parent depth. Content uses `message.content`, never `text`.

The recovery parser accepts only paths created by:

```ts
archiveMediaFile(chatId, messageId, attachmentIndex, safeName)
```

Delete old `<messageId>-<name>` recognition rather than supporting both.

- [ ] **Step 5: Download each Archive item independently**

Build a state for every attachment. With `--media`, call `source.downloadMedia` for each downloadable descriptor. One media failure produces a failed state and warning but does not discard message metadata or successful sibling files. Authentication/session failure remains fatal.

Recovery, temporary ownership, no-follow checks, rollback, and warning details must all carry `attachment_index`.

If any chat or attachment failed, keep the existing `archive_partial_failure` aggregate and include successful chat/message work plus per-attachment warnings in its details.

- [ ] **Step 6: Run Archive behavior tests and verify GREEN**

Run the command from Step 3.

Expected: PASS, including partial failure and exact-index recovery.

- [ ] **Step 7: Typecheck the Archive cutover, then continue to Phase D**

Run:

```bash
pnpm typecheck
```

Expected: PASS. A type failure here means an old Archive consumer still sees the new boundary and must be fixed before proceeding. Do not stage or commit; the Web server and client still need the matching response/request cutover.

### Phase D: Serve canonical attachments through Web queries

**Files:**

- Modify: `src/web/types.ts`
- Modify: `src/web/query.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/sync-task.ts`
- Modify: `tests/web/query.test.ts`
- Modify: `tests/web/server.test.ts`
- Modify: `tests/web/sync-task.test.ts`

- [ ] **Step 1: Rewrite Web query fixtures without raw media**

Seed only canonical `attachments`, `reply_to_msg_id`, and `media_group_id`. Cover multi-item messages, parent links, album aggregation, reply attachments, and preview preservation.

Use:

```ts
export type WebMessageAttachment = Attachment & {
  chat_id: number
  msg_id: number
}
```

Do not include server-generated `key`, `label`, or forced filename in this response type.

- [ ] **Step 2: Write Web query and schema-boundary tests**

Cover two album messages that both have local attachment index 1, reply attachments from a different source message, parent/child depth data, preserved per-item preview, and an old account database surfaced as HTTP 409 `data_reset_required` by query/sync entry points. No fixture may depend on `raw_json` to discover media.

- [ ] **Step 3: Run Web backend tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/web/query.test.ts \
  tests/web/server.test.ts \
  tests/web/sync-task.test.ts
```

Expected: FAIL because query still reparses raw data and exposes its parallel attachment shape.

- [ ] **Step 4: Flatten hydrated attachments for Web**

Use `media_group_id` for grouping and attach each descriptor's source `chat_id/msg_id`. Reply context receives its target's hydrated `attachments[]`. Delete `extractPreviewJpegBase64()`, raw imports, old label generation, and MIME guessing.

- [ ] **Step 5: Propagate fresh-schema failures through Web read paths**

Open the selected account's MessageDB through the same schema guard used by CLI commands. Query and sync handlers map `data_reset_required` to HTTP 409 with the stable structured error; they do not create, migrate, or partially read an old database. Keep the authoritative download endpoint from Task 11 unchanged and covered by `tests/web/api.test.ts` in the full suite.

- [ ] **Step 6: Run Web backend tests and verify GREEN**

Run the command from Step 3.

Expected: PASS; Web reads only hydrated canonical attachments, preserves source-message identity, and returns HTTP 409 for an old schema.

- [ ] **Step 7: Continue directly to Phase E without committing**

Keep the canonical Web response changes with Phases A-D. The installed Web client still sends the old filename-based request until Phase E, so this is not a valid commit boundary.

### Phase E: Render nested attachments in the Web client

**Files:**

- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `tests/web/frontend-assets.test.ts`

- [ ] **Step 1: Add failing frontend contract assertions**

Export small pure helpers and test:

```ts
export function attachmentKey(
  attachment: MessageAttachment,
): string

export function attachmentDepth(
  attachment: MessageAttachment,
  attachments: MessageAttachment[],
): number
```

Assert download payloads contain account/chat/message/index only, children have depth, unknown has a safe label, and non-downloadable rows have no Download button. Include an album where two source messages both have local indices 1 and 2; a child may resolve a parent only within the same `chat_id + msg_id`.

- [ ] **Step 2: Run frontend tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/web/frontend-assets.test.ts
```

Expected: FAIL because API types still contain `key/label/file_name` request fields and rows are flat.

- [ ] **Step 3: Mirror the complete snake_case API type**

In `web/src/api.ts`, mirror every `Attachment` field plus `chat_id/msg_id`. Keep metadata typed as JSON data. Change the request to:

```ts
{
  account: string
  attachments: Array<{
    chat_id: number
    msg_id: number
    attachment_index: number
  }>
}
```

- [ ] **Step 4: Derive view-only fields in React**

Sort each source message by `attachment_index`, derive key/depth/label in the client, display embedded previews, indent children, and show subtype/role/file metadata. Parent lookup must match `chat_id`, `msg_id`, and `parent_attachment_index` together; never resolve a parent from another album member that reused the same local index. Render a download action only when `downloadable === true`; do not render a disabled action for containers.

Apply the same component to reply-context attachments. Use a one-column hierarchical list at narrow and wide widths so parent/child relationships remain visible.

- [ ] **Step 5: Run frontend tests, Web type-check, and Web build**

Run:

```bash
pnpm exec vitest run tests/web/frontend-assets.test.ts
pnpm exec tsc -p web/tsconfig.json
pnpm build:web
```

Expected: all commands PASS and Vite emits the production Web assets.

- [ ] **Step 6: Verify and commit the complete A-E cutover**

Run the complete type-check again now that the Web server and client agree:

```bash
pnpm typecheck
```

Expected: PASS for both the root and Web TypeScript projects.

```bash
git add \
  src/services/attachment-download.ts \
  src/services/download-service.ts \
  src/services/auto-download-coordinator.ts \
  src/telegram/types.ts \
  src/telegram/archive-types.ts \
  src/telegram/mtcute-client.ts \
  src/telegram/mtcute-archive.ts \
  src/telegram/fake-client.ts \
  src/web/api.ts \
  src/commands/telegram.ts \
  src/presenters/ink/listen.tsx \
  src/services/archive-types.ts \
  src/services/archive-manifest.ts \
  src/services/archive-layout.ts \
  src/commands/archive.ts \
  src/services/archive-markdown.ts \
  src/services/archive-service.ts \
  src/web/types.ts \
  src/web/query.ts \
  src/web/server.ts \
  src/web/sync-task.ts \
  web/src/api.ts \
  web/src/App.tsx \
  web/src/styles.css \
  tests/services/attachment-download.test.ts \
  tests/services/download-service.test.ts \
  tests/services/auto-download-coordinator.test.ts \
  tests/telegram/mtcute-download.test.ts \
  tests/telegram/fake-client-download.test.ts \
  tests/commands/telegram-listen.test.ts \
  tests/commands/download.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/web/api.test.ts \
  tests/telegram/mtcute-archive.test.ts \
  tests/services/archive-manifest.test.ts \
  tests/services/archive-layout.test.ts \
  tests/services/archive-markdown.test.ts \
  tests/services/archive-service.test.ts \
  tests/commands/archive.test.ts \
  tests/web/query.test.ts \
  tests/web/server.test.ts \
  tests/web/sync-task.test.ts \
  tests/web/frontend-assets.test.ts
git commit -m "feat: cut media consumers to normalized attachments"
```

## Task 12: Delete legacy media paths and advance public contracts

**Files:**

- Delete: `src/services/listen-attachment.ts`
- Delete: `src/telegram/raw-message.ts`
- Delete: `src/telegram/raw-media-location.ts`
- Delete: their three test files
- Create: `tests/architecture/media-boundary.test.ts`
- Modify: `src/presenters/structured.ts`
- Modify: all structured-output expectations
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `site/index.html`
- Modify: `site/docs/index.html`
- Modify: `site/zh-CN/index.html`
- Modify: `site/zh-CN/docs/index.html`
- Modify: `tests/cli/contract.test.ts`
- Modify: `tests/site/pages-site.test.ts`

- [ ] **Step 1: Add the failing architecture boundary test**

Recursively inspect TypeScript source under `src/services`, `src/presenters`, `src/web`, `src/commands`, and `src/storage`. Fail if a file imports `raw-message`, `raw-media-location`, or `listen-attachment`.

Also add a recursive contract helper:

```ts
function expectNoSingularAttachmentKey(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoSingularAttachmentKey(item)
    return
  }
  if (value == null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toBe('attachment')
    expectNoSingularAttachmentKey(child)
  }
}
```

Use it on online, local query/export, download, Archive result, and Web response fixtures.

- [ ] **Step 2: Run boundary/contract tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  tests/architecture/media-boundary.test.ts \
  tests/cli/contract.test.ts \
  tests/presenters/structured.test.ts
```

Expected: FAIL while legacy imports/files or schema-version-1 expectations remain.

- [ ] **Step 3: Delete legacy parser code and tests**

Remove the six named files. Fix imports by using normalized fields; do not copy any parser into a new filename.

Verify:

```bash
rg -n "raw-message|raw-media-location|listen-attachment|discoverListenAttachments|extractGroupedId|extractReplyToMessageId" src tests
```

Expected: no matches.

- [ ] **Step 4: Advance the structured envelope to version 2**

Set:

```ts
const SCHEMA_VERSION = '2'
```

Update every exact JSON/YAML expectation in tests and site documentation. This is a global output-envelope bump because message objects changed from `text/attachment` or raw-only media to `content/attachments`.

- [ ] **Step 5: Strengthen message/export contract tests**

JSON and YAML must include complete ordered `attachments[]`, lowercase kind, reply/group fields, and per-item preview/metadata. Data export uses the hydrated aggregate. No structured message output may contain `text`, singular `attachment`, Title Case media kinds, or message-level preview.

- [ ] **Step 6: Update English, Chinese, and site documentation**

Document:

- `tg data reset --yes` and `--all-accounts`;
- required reset/re-sync after this breaking upgrade;
- custom Archive outputs require manual cleanup;
- no `--attachment` downloads all downloadable items in one message;
- `--attachment N` is message-local, but album numbering is flattened by message ID/local index;
- `attachments[]` and lowercase kinds;
- listen persistence and `--no-media` behavior;
- safe fresh-refetch matching and the key stable errors.

Include at least:

```bash
tg data reset --yes
tg sync-all
tg download @channel 42 --attachment 2
```

- [ ] **Step 7: Run boundary, contract, and site tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  tests/architecture/media-boundary.test.ts \
  tests/cli/contract.test.ts \
  tests/presenters/structured.test.ts \
  tests/services/data-service.test.ts \
  tests/site/pages-site.test.ts
```

Expected: PASS; recursive checks find no singular key.

- [ ] **Step 8: Commit the clean cutover**

```bash
git add -A -- \
  src/services/listen-attachment.ts \
  src/telegram/raw-message.ts \
  src/telegram/raw-media-location.ts \
  tests/services/listen-attachment.test.ts \
  tests/telegram/raw-message.test.ts \
  tests/telegram/raw-media-location.test.ts
git add \
  src/presenters/structured.ts \
  tests/architecture/media-boundary.test.ts \
  tests/cli/contract.test.ts \
  tests/cli/output.test.ts \
  tests/cli/v040-capability-matrix.test.ts \
  tests/commands/archive.test.ts \
  tests/commands/config.test.ts \
  tests/commands/telegram-error-boundary.test.ts \
  tests/presenters/structured.test.ts \
  tests/services/data-service.test.ts \
  tests/site/pages-site.test.ts \
  README.md \
  README.zh-CN.md \
  site/index.html \
  site/docs/index.html \
  site/zh-CN/index.html \
  site/zh-CN/docs/index.html
git commit -m "feat: remove legacy media contracts"
```

Review `git diff --cached --stat` before committing so historical design documents and unrelated user files are not staged.

## Task 13: Complete integration verification

**Files:**

- Modify only files required by failures found in this task.

- [ ] **Step 1: Run static residue scans**

Run:

```bash
rg -n "\battachment\s*:" src web tests \
  --glob '*.ts' \
  --glob '*.tsx'
rg -n "kind:\s*'(Photo|Video|Audio|Voice|Sticker|Document|Animation)'" src web tests
rg -n "extractGroupedId|extractReplyToMessageId|discoverListenAttachments|raw-media-location" src web tests
rg -n "schema_version:\s*['\"]1['\"]|schema_version:\s*1" src web README.md README.zh-CN.md site
```

Expected:

- the first command finds only legitimate TypeScript type/property names such as function parameters or Commander option fixtures, never a serialized singular message key;
- the second and third commands have no matches;
- the fourth has no shared-output/Archive v1 matches in production code or public documentation. Tests are intentionally excluded because Phase B must retain explicit version-1 rejection fixtures for `archive_schema_unsupported`. SQLite `user_version = 1` is also intentionally outside this scan.

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all Vitest files PASS.

- [ ] **Step 3: Run both TypeScript projects**

Run:

```bash
pnpm typecheck
```

Expected: root and Web TypeScript checks PASS with no ignored errors.

- [ ] **Step 4: Build production CLI and Web assets**

Run:

```bash
pnpm build
```

Expected: Vite and `tsc -p tsconfig.build.json` complete successfully and `dist/index.js` is emitted.

- [ ] **Step 5: Check patch hygiene and the final data boundary**

Run:

```bash
git diff --check
git status --short
```

Then inspect `rg -n "raw_json" src`. Every remaining use must be one of:

- mtcute diagnostic snapshot creation;
- SQLite serialization/hydration;
- explicit diagnostic export/structured output.

Any functional branch based on `raw_json` must be removed and retested.

- [ ] **Step 6: Review success criteria against the approved design**

Confirm all of the following in the final diff:

- all 18 mtcute high-level discriminators are exhaustively mapped;
- nested attachments are depth-first and one-based;
- every SQLite reader hydrates ordered attachments;
- old DB and Archive data are rejected, never migrated or auto-deleted;
- reset preserves sessions/config/downloads/custom Archive;
- listen writes before side effects;
- all transfers refetch and match a precise attachment;
- Archive and Web support every attachment and partial failures;
- no public singular field or Title Case kind remains.

- [ ] **Step 7: Commit only verification fixes, if any**

If Steps 1–6 required changes, inspect `git diff --name-only`, stage each file fixed during verification by its exact path, verify `git diff --cached --name-only`, then run:

```bash
git commit -m "fix: complete unified media integration"
```

If no files changed, do not create an empty commit.
