# Reply Context and Media Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show resolved reply context in `recent` and `listen`, and collapse Telegram media groups into media-aware logical messages in human-readable `recent` output.

**Architecture:** Add one shared parser for Telegram raw-message metadata and one presentation model for logical messages. Keep stored rows and structured output unchanged; build a separate cursor-paged logical window for human `recent`, resolve replies from memory then SQLite, and feed the same reply/media model to plain and Ink listen renderers.

**Tech Stack:** TypeScript, NodeNext ESM, better-sqlite3, Commander, Ink/React, Vitest, mtcute raw TL message data.

---

## File map

- Create `src/telegram/raw-message.ts`: parse object/string raw JSON and extract reply and media-group IDs.
- Create `src/presenters/logical-message.ts`: group stored rows, choose captions/replies, discover and summarize media.
- Create `src/services/reply-context.ts`: resolve reply targets and build presentation summaries.
- Modify `src/storage/message-db.ts`: add cursor-paged recent reads and batch `(chat_id, msg_id)` lookup.
- Modify `src/services/query-service.ts`: build a logical human window while preserving structured `data`.
- Modify `src/presenters/human.ts`: render logical messages with reply and media lines.
- Modify `src/presenters/listen-message.ts`: accept resolved reply context and shared media summaries.
- Modify `src/commands/telegram.ts`: open the account database for plain listen and resolve from memory before SQLite.
- Modify `src/presenters/ink/listen.tsx`: maintain bounded raw-message memory and resolve reply context for Ink rows.
- Modify `src/presenters/ink/listen-scroll.ts`: count reply and media lines in viewport calculations.
- Modify focused tests under `tests/telegram`, `tests/presenters`, `tests/storage`, `tests/services`, `tests/commands`, and `tests/cli`.

### Task 1: Shared Telegram raw-message metadata parser

**Files:**
- Create: `src/telegram/raw-message.ts`
- Create: `tests/telegram/raw-message.test.ts`
- Modify: `src/services/listen-album-aggregator.ts`
- Test: `tests/services/listen-album-aggregator.test.ts`

- [ ] **Step 1: Write failing parser tests**

```ts
import { describe, expect, it } from 'vitest'
import { extractGroupedId, extractReplyToMessageId, parseRawMessage } from '../../src/telegram/raw-message.js'

describe('Telegram raw message metadata', () => {
  it('parses object and serialized raw messages', () => {
    expect(parseRawMessage({ _: 'message', id: 1 })).toMatchObject({ id: 1 })
    expect(parseRawMessage('{"_":"message","id":2}')).toMatchObject({ id: 2 })
    expect(parseRawMessage('{bad')).toBeNull()
  })

  it.each([
    [{ replyTo: { replyToMsgId: 42 } }, 42],
    [{ reply_to: { reply_to_msg_id: 43 } }, 43],
    [JSON.stringify({ replyTo: { replyToMsgId: 44 } }), 44],
  ])('extracts reply target from %j', (raw, expected) => {
    expect(extractReplyToMessageId(raw)).toBe(expected)
  })

  it.each([
    [{ groupedId: '9001' }, '9001'],
    [{ grouped_id: 9002 }, '9002'],
    [{ groupedId: { low: 7, high: 3 } }, '7:3'],
  ])('normalizes grouped IDs from %j', (raw, expected) => {
    expect(extractGroupedId(raw)).toBe(expected)
  })

  it('treats malformed and unrelated data as absent metadata', () => {
    expect(extractReplyToMessageId(null)).toBeNull()
    expect(extractReplyToMessageId({ replyTo: { replyToMsgId: 'x' } })).toBeNull()
    expect(extractGroupedId('{bad')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the parser test and verify RED**

Run: `pnpm exec vitest run tests/telegram/raw-message.test.ts`

Expected: FAIL because `src/telegram/raw-message.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared parser**

```ts
type RawRecord = Record<string, unknown>

export function parseRawMessage(value: unknown): RawRecord | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isRecord(value) ? value : null
}

export function extractReplyToMessageId(value: unknown): number | null {
  const raw = parseRawMessage(value)
  if (raw == null) return null
  const reply = isRecord(raw.replyTo) ? raw.replyTo : isRecord(raw.reply_to) ? raw.reply_to : null
  if (reply == null) return null
  const id = reply.replyToMsgId ?? reply.reply_to_msg_id
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
}

export function extractGroupedId(value: unknown): string | null {
  const raw = parseRawMessage(value)
  if (raw == null) return null
  const id = raw.groupedId ?? raw.grouped_id
  if (typeof id === 'string' || typeof id === 'number') return String(id)
  if (isRecord(id)) {
    const { low, high } = id
    if ((typeof low === 'string' || typeof low === 'number') && (typeof high === 'string' || typeof high === 'number')) {
      return `${low}:${high}`
    }
  }
  return null
}

function isRecord(value: unknown): value is RawRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
```

- [ ] **Step 4: Replace the private album parser with the shared helper**

In `src/services/listen-album-aggregator.ts`, import `extractGroupedId` from `../telegram/raw-message.js` and delete the private `extractGroupedId`, `parseRawJson`, and `isRecord` functions.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run tests/telegram/raw-message.test.ts tests/services/listen-album-aggregator.test.ts`

Expected: both suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/raw-message.ts src/services/listen-album-aggregator.ts tests/telegram/raw-message.test.ts tests/services/listen-album-aggregator.test.ts
git commit -m "feat: parse telegram reply and media group metadata"
```

### Task 2: Logical messages and media summaries

**Files:**
- Create: `src/presenters/logical-message.ts`
- Create: `tests/presenters/logical-message.test.ts`
- Modify: `src/services/listen-attachment.ts`

- [ ] **Step 1: Write failing grouping and summary tests**

```ts
import { describe, expect, it } from 'vitest'
import { groupLogicalMessages, summarizeLogicalMedia } from '../../src/presenters/logical-message.js'
import type { StoredMessage } from '../../src/storage/message-db.js'

describe('logical messages', () => {
  it('groups an album within one chat and chooses its caption and reply', () => {
    const rows = [
      message(11, 100, { groupedId: 'album', media: { _: 'messageMediaPhoto', photo: {} } }),
      message(12, 100, { groupedId: 'album', replyTo: { replyToMsgId: 5 }, media: { _: 'messageMediaPhoto', photo: {} } }, 'caption'),
    ]
    const [logical] = groupLogicalMessages(rows)
    expect(logical.messages.map((row) => row.msg_id)).toEqual([11, 12])
    expect(logical.content).toBe('caption')
    expect(logical.replyToMessageId).toBe(5)
    expect(summarizeLogicalMedia(logical)).toBe('📎 2 Photos')
  })

  it('does not merge equal grouped IDs from different chats', () => {
    const rows = [message(1, 100, { grouped_id: 'same' }), message(1, 200, { grouped_id: 'same' })]
    expect(groupLogicalMessages(rows)).toHaveLength(2)
  })

  it('summarizes mixed media and a named document', () => {
    const mixed = groupLogicalMessages([
      message(1, 100, { groupedId: 'x', media: { _: 'messageMediaPhoto', photo: {} } }),
      message(2, 100, { groupedId: 'x', media: { _: 'messageMediaDocument', document: { mime_type: 'video/mp4' } } }),
    ])[0]
    expect(summarizeLogicalMedia(mixed)).toBe('📎 1 Photo, 1 Video')

    const document = groupLogicalMessages([
      message(3, 100, { media: { _: 'messageMediaDocument', document: { file_name: 'report.pdf' } } }),
    ])[0]
    expect(summarizeLogicalMedia(document)).toBe('📎 Document: report.pdf')
  })
})

function message(msgId: number, chatId: number, raw: unknown, content: string | null = null): StoredMessage {
  return {
    id: msgId,
    platform: 'telegram',
    chat_id: chatId,
    chat_name: 'Chat',
    msg_id: msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content,
    timestamp: `2026-07-13T10:00:${String(msgId).padStart(2, '0')}.000Z`,
    raw_json: JSON.stringify(raw),
  }
}
```

- [ ] **Step 2: Run the logical-message test and verify RED**

Run: `pnpm exec vitest run tests/presenters/logical-message.test.ts`

Expected: FAIL because the logical-message module does not exist.

- [ ] **Step 3: Export attachment discovery for stored rows and correct MIME-kind detection**

Rename no behavior unnecessarily: keep `discoverListenAttachments` and use it from the new module. Adjust `detectMediaKind` so `messageMediaDocument` with `mime_type: video/*` reports `Video`, `audio/*` reports `Audio`, and otherwise remains `Document`; add focused cases to `tests/services/listen-attachment.test.ts` before making this change.

```ts
function documentKind(node: RawRecord): string {
  const source = mediaDetailSource(node, 'Document')
  const mime = firstString(source.mime_type, source.mimeType, source.mime)?.toLowerCase()
  if (mime?.startsWith('video/')) return 'Video'
  if (mime?.startsWith('audio/')) return 'Audio'
  if (mime?.startsWith('image/')) return 'Photo'
  return 'Document'
}
```

- [ ] **Step 4: Implement the logical-message model**

```ts
import type { StoredMessage, StoredMessageInput } from '../storage/message-db.js'
import { discoverListenAttachments } from '../services/listen-attachment.js'
import { extractGroupedId, extractReplyToMessageId } from '../telegram/raw-message.js'

export type LogicalMessage<T extends StoredMessageInput = StoredMessage> = {
  key: string
  messages: T[]
  first: T
  content: string | null
  replyToMessageId: number | null
}

export function groupLogicalMessages<T extends StoredMessageInput>(rows: T[]): LogicalMessage<T>[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const groupedId = extractGroupedId(row.raw_json)
    const key = groupedId == null ? `${row.chat_id}:message:${row.msg_id}` : `${row.chat_id}:group:${groupedId}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()].map(([key, values]) => {
    const messages = [...values].sort((a, b) => a.msg_id - b.msg_id)
    const first = messages[0]
    return {
      key,
      messages,
      first,
      content: messages.find((row) => row.content?.trim())?.content ?? null,
      replyToMessageId: messages.map((row) => extractReplyToMessageId(row.raw_json)).find((id) => id != null) ?? null,
    }
  }).sort((a, b) => a.first.timestamp.localeCompare(b.first.timestamp) || a.first.msg_id - b.first.msg_id)
}

export function summarizeLogicalMedia(message: LogicalMessage<StoredMessageInput>): string | null {
  const attachments = message.messages.flatMap(discoverListenAttachments)
  if (attachments.length === 0) return null
  if (attachments.length === 1 && attachments[0].kind === 'Document' && attachments[0].fileName != null) {
    return `📎 Document: ${attachments[0].fileName}`
  }
  const counts = new Map<string, number>()
  for (const attachment of attachments) counts.set(attachment.kind, (counts.get(attachment.kind) ?? 0) + 1)
  const labels = [...counts].map(([kind, count]) => `${count} ${count === 1 ? kind : pluralize(kind)}`)
  return `📎 ${labels.join(', ')}`
}

function pluralize(kind: string): string {
  return kind.endsWith('s') ? kind : `${kind}s`
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run tests/presenters/logical-message.test.ts tests/services/listen-attachment.test.ts`

Expected: all grouping, caption, media-kind, and summary cases PASS.

- [ ] **Step 6: Commit**

```bash
git add src/presenters/logical-message.ts src/services/listen-attachment.ts tests/presenters/logical-message.test.ts tests/services/listen-attachment.test.ts
git commit -m "feat: group and summarize logical media messages"
```

### Task 3: Database paging and reply-target lookup

**Files:**
- Modify: `src/storage/message-db.ts`
- Modify: `tests/storage/message-db.test.ts`

- [ ] **Step 1: Write failing database tests**

Add tests that create rows in two chats with the same Telegram message ID and assert chat-scoped batch lookup, then page through equal timestamps without duplicates:

```ts
it('looks up reply targets by chat and Telegram message ID', () => {
  const store = db()
  store.insertBatch([
    message({ chat_id: 100, msg_id: 7, content: 'chat 100' }),
    message({ chat_id: 200, msg_id: 7, content: 'chat 200' }),
  ])
  const found = store.getMessagesByKeys([{ chatId: 200, msgId: 7 }, { chatId: 100, msgId: 7 }])
  expect(found.map((row) => row.content)).toEqual(['chat 200', 'chat 100'])
  store.close()
})

it('pages recent rows with a stable timestamp and id cursor', () => {
  const store = db()
  store.insertBatch([1, 2, 3].map((msg_id) => message({ msg_id, timestamp: '2026-07-13T10:00:00.000Z' })))
  const first = store.getRecentPage({ limit: 2 })
  const second = store.getRecentPage({ limit: 2, before: { timestamp: first[1].timestamp, id: first[1].id } })
  expect([...first, ...second].map((row) => row.msg_id)).toEqual([3, 2, 1])
  store.close()
})
```

- [ ] **Step 2: Run the storage tests and verify RED**

Run: `pnpm exec vitest run tests/storage/message-db.test.ts`

Expected: FAIL because `getMessagesByKeys` and `getRecentPage` do not exist.

- [ ] **Step 3: Add typed cursor and lookup APIs**

```ts
export type RecentPageOptions = SearchOptions & {
  before?: { timestamp: string; id: number }
}

getRecentPage(options: RecentPageOptions = {}): StoredMessage[] {
  const params: unknown[] = []
  const conditions = ['1=1']
  this.addFilters(conditions, params, options)
  if (options.before != null) {
    conditions.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
    params.push(options.before.timestamp, options.before.timestamp, options.before.id)
  }
  return this.db.prepare(`
    SELECT * FROM messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(...params, options.limit ?? 100) as StoredMessage[]
}
```

Implement `getMessagesByKeys` with one statement per key inside a read transaction, preserving requested order and avoiding dynamic SQL:

```ts
getMessagesByKeys(keys: Array<{ chatId: number; msgId: number }>): StoredMessage[] {
  const stmt = this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND msg_id = ? LIMIT 1')
  const read = this.db.transaction((items: Array<{ chatId: number; msgId: number }>) => items
    .map(({ chatId, msgId }) => stmt.get(canonicalChatId(chatId), msgId) as StoredMessage | undefined)
    .filter((row): row is StoredMessage => row != null))
  return read(keys)
}
```

- [ ] **Step 4: Run storage tests and verify GREEN**

Run: `pnpm exec vitest run tests/storage/message-db.test.ts`

Expected: the full storage suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/message-db.ts tests/storage/message-db.test.ts
git commit -m "feat: add recent paging and reply lookup"
```

### Task 4: Reply summaries and human `recent` integration

**Files:**
- Create: `src/services/reply-context.ts`
- Create: `tests/services/reply-context.test.ts`
- Modify: `src/services/query-service.ts`
- Modify: `src/presenters/human.ts`
- Modify: `tests/services/query-service.test.ts`
- Modify: `tests/presenters/human.test.ts`
- Modify: `tests/cli/contract.test.ts`

- [ ] **Step 1: Write failing reply-summary tests**

```ts
import { describe, expect, it } from 'vitest'
import { buildReplyContext } from '../../src/services/reply-context.js'

describe('reply context', () => {
  it('builds resolved and missing summaries', () => {
    expect(buildReplyContext(7, {
      id: 1, platform: 'telegram', chat_id: 100, chat_name: 'Chat', msg_id: 7,
      sender_id: 9, sender_name: 'Bob', content: 'original', timestamp: '2026-07-13T10:20:00.000Z', raw_json: null,
    })).toMatchObject({ messageId: 7, resolved: true, senderName: 'Bob', content: 'original' })
    expect(buildReplyContext(8, undefined)).toEqual({ messageId: 8, resolved: false })
  })
})
```

- [ ] **Step 2: Write failing `recent` service and presenter tests**

Seed an original message, a two-photo reply album, and ordinary messages. Assert:

```ts
expect(result.data).toHaveLength(4) // unchanged stored rows
expect(result.human).toMatchObject({
  kind: 'table',
  rows: expect.arrayContaining([
    expect.arrayContaining([expect.stringContaining('↳ Reply to [10:20] Bob (#7): original')]),
  ]),
})
```

Add a missing-target case expecting `↳ Reply to message #99 (not found locally)`. Add a limit case with an album of four rows plus two ordinary messages and assert `recent({ limit: 2 })` produces two human rows while structured `data` still contains two stored rows.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm exec vitest run tests/services/reply-context.test.ts tests/services/query-service.test.ts tests/presenters/human.test.ts`

Expected: FAIL because reply summaries and logical recent rendering are not implemented.

- [ ] **Step 4: Implement reply summary types and formatting data**

```ts
import type { StoredMessage } from '../storage/message-db.js'

export type ReplyContext =
  | { messageId: number; resolved: false }
  | { messageId: number; resolved: true; timestamp: string; senderId: number | null; senderName: string | null; content: string | null }

export function buildReplyContext(messageId: number, target: StoredMessage | undefined): ReplyContext {
  if (target == null) return { messageId, resolved: false }
  return {
    messageId,
    resolved: true,
    timestamp: target.timestamp,
    senderId: target.sender_id,
    senderName: target.sender_name,
    content: target.content,
  }
}
```

Extend `LogicalMessage` with optional `replyContext?: ReplyContext`, keeping the grouping module independent from the database.

- [ ] **Step 5: Implement cursor-paged logical-window loading**

Add a private `recentLogicalMessages` method in `QueryService`. Read pages of `Math.max(limit * 2, 100)`, prepend/group accumulated rows, and continue until at least `limit + 1` logical groups exist or the database returns no more rows. The extra logical group proves the oldest selected group boundary is complete. Slice the newest `limit` groups and restore chronological order.

```ts
private recentLogicalMessages(options: SearchOptions): LogicalMessage<StoredMessage>[] {
  const target = options.limit ?? 50
  const pageSize = Math.max(target * 2, 100)
  const rows: StoredMessage[] = []
  let before: { timestamp: string; id: number } | undefined
  while (true) {
    const page = this.db.getRecentPage({ ...options, limit: pageSize, before })
    rows.push(...page)
    const groups = groupLogicalMessages(rows)
    if (page.length < pageSize || groups.length > target) return groups.slice(-target)
    const last = page[page.length - 1]
    before = { timestamp: last.timestamp, id: last.id }
  }
}
```

Before finalizing this method, add a regression case where the page boundary lands inside an album and ensure all members appear in its media summary.

- [ ] **Step 6: Batch-resolve reply targets and render logical rows**

In `QueryService.recent`, retain the existing `data = this.db.getRecent(...)`. Separately load logical messages, deduplicate reply lookup keys, call `getMessagesByKeys`, index results by `${chat_id}:${msg_id}`, attach `buildReplyContext(...)`, and call a new `logicalMessageTable(...)` presenter.

The presenter builds one row per logical message. Its message cell joins non-null lines in this order:

```ts
[
  formatReplyContext(message.replyContext),
  message.content,
  summarizeLogicalMedia(message),
].filter((line): line is string => line != null && line !== '').join('\n') || '—'
```

Use existing timestamp display behavior for the row and a small local-time helper for reply timestamps. Sender fallback order is name, ID, `Unknown`; missing reply content uses `(no text)`.

- [ ] **Step 7: Verify structured CLI contracts remain row-based**

Add CLI tests for `recent --json --limit 2` and `recent --yaml --limit 2` using a four-row album. Assert each structured payload contains exactly two raw stored rows and no `replyContext`, `messages`, or media-summary fields.

Run: `pnpm exec vitest run tests/services/reply-context.test.ts tests/services/query-service.test.ts tests/presenters/human.test.ts tests/cli/contract.test.ts`

Expected: all focused suites PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/reply-context.ts src/services/query-service.ts src/presenters/human.ts tests/services/reply-context.test.ts tests/services/query-service.test.ts tests/presenters/human.test.ts tests/cli/contract.test.ts
git commit -m "feat: show replies and media groups in recent"
```

### Task 5: Plain-text `listen` reply resolution

**Files:**
- Modify: `src/presenters/listen-message.ts`
- Modify: `src/commands/telegram.ts`
- Modify: `tests/presenters/listen-message.test.ts`
- Modify: `tests/commands/telegram-listen.test.ts`

- [ ] **Step 1: Write failing plain-listen presenter tests**

Extend `ListenMessageFormatOptions` usage in tests with `replyContext` and assert resolved and missing output:

```ts
expect(formatListenLine(replyMessage, {
  replyContext: {
    messageId: 7,
    resolved: true,
    timestamp: '2026-07-13T10:20:00.000Z',
    senderId: 2,
    senderName: 'Bob',
    content: 'original',
  },
})).toContain('↳ Reply to [10:20] Bob (#7): original')

expect(formatListenLine(replyMessage, {
  replyContext: { messageId: 99, resolved: false },
})).toContain('↳ Reply to message #99 (not found locally)')
```

Add an album test expecting one `📎 2 Photos` line instead of two separate `📎 Photo` lines.

- [ ] **Step 2: Run presenter tests and verify RED**

Run: `pnpm exec vitest run tests/presenters/listen-message.test.ts`

Expected: FAIL because listen rows have no reply context or aggregated media summary.

- [ ] **Step 3: Extend the shared listen row**

Add `replyContext?: ReplyContext` and `mediaSummary: string | null` to `ListenMessageRow`. Build a logical message from the input group, use its caption, call `summarizeLogicalMedia`, and include formatted reply context before content in `formatListenLine`.

```ts
type ListenMessageFormatOptions = {
  showMedia?: boolean
  showChatName?: boolean
  replyContext?: ReplyContext
}
```

Keep `media` as the full attachment list for download behavior; `mediaSummary` changes only the visible summary.

- [ ] **Step 4: Write failing command-level memory/database precedence tests**

In `tests/commands/telegram-listen.test.ts`, emit an original message followed by a reply and assert the reply resolves from listener memory. In a second test, seed the active account database with the target before running listen and emit only the reply. Assert the same full context is displayed. Add a third test with no target and assert the local-not-found line.

- [ ] **Step 5: Run command tests and verify RED**

Run: `pnpm exec vitest run tests/commands/telegram-listen.test.ts`

Expected: FAIL because the command does not retain or query reply targets.

- [ ] **Step 6: Add a bounded plain-listen resolver**

Inside the account context, open `new MessageDB(context.dbPath)`. Maintain a `Map<string, StoredMessageInput>` and FIFO keys capped at 500. For each emitted logical group:

1. extract the first reply ID;
2. look up `${chat_id}:${replyId}` in memory;
3. otherwise call `db.getMessagesByKeys([{ chatId, msgId: replyId }])`;
4. build `ReplyContext`;
5. format the line;
6. add every group member to memory after rendering.

Close the database in the account callback's `finally`. Do not insert listener messages into SQLite and do not call Telegram for targets.

- [ ] **Step 7: Run plain-listen tests and verify GREEN**

Run: `pnpm exec vitest run tests/presenters/listen-message.test.ts tests/commands/telegram-listen.test.ts`

Expected: resolved-memory, resolved-database, missing-target, album summary, and existing listen cases PASS.

- [ ] **Step 8: Commit**

```bash
git add src/presenters/listen-message.ts src/commands/telegram.ts tests/presenters/listen-message.test.ts tests/commands/telegram-listen.test.ts
git commit -m "feat: show reply context in plain listen output"
```

### Task 6: Interactive Ink `listen` integration and scrolling

**Files:**
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `src/presenters/ink/listen-scroll.ts`
- Modify: `tests/presenters/ink-listen.test.tsx`
- Modify: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write failing Ink rendering tests**

Build a `ListenMessage` with resolved reply context and media summary. Render the message component and assert these lines are present in order:

```text
↳ Reply to [10:20] Bob (#7): original
current reply
📎 2 Photos
```

Add the unresolved target case. Assert attachment download rows still exist separately when media is enabled.

- [ ] **Step 2: Write failing viewport-height tests**

Add a message with `replyContext` and `mediaSummary` to the viewport cases in `tests/presenters/ink-listen.test.tsx`; choose a viewport that previously fit the message but now must exclude it. This proves reply and summary lines affect `messageLines`.

- [ ] **Step 3: Run Ink tests and verify RED**

Run: `pnpm exec vitest run tests/presenters/ink-listen.test.tsx`

Expected: FAIL because Ink does not render or count reply/media summary lines.

- [ ] **Step 4: Render reply and media summary in Ink**

In the message body component, render `formatReplyContext(message.replyContext)` before content and render `message.mediaSummary` after content. Preserve existing attachment action rows so users can still select and download each album item.

Update `messageLines`:

```ts
function messageLines(message: ListenMessageRow): number {
  return 2
    + (message.replyContext == null ? 0 : 1)
    + (message.content == null ? 0 : 1)
    + (message.mediaSummary == null ? 0 : 1)
    + message.media.reduce((sum, item) => sum + 1 + (item.previewRows ?? 0), 0)
}
```

- [ ] **Step 5: Add interactive memory-first/database-second resolution**

Pass `dbPath` into `renderInteractiveListen` from the account context. In the Ink runtime, keep a bounded map of the raw messages already accepted into history. When the album aggregator emits a group, resolve the first reply ID from memory and then a lazily opened `MessageDB`. Attach the result when calling `buildListenMessage`. Close the database during runtime cleanup.

Reuse a shared resolver helper extracted from Task 5 if plain and Ink code would otherwise duplicate the same precedence and cache logic. The helper API should be:

```ts
export type ListenReplyResolver = {
  resolve(messages: StoredMessageInput[]): ReplyContext | undefined
  remember(messages: StoredMessageInput[]): void
  close(): void
}

export function createListenReplyResolver(dbPath: string, limit = 500): ListenReplyResolver
```

- [ ] **Step 6: Run interactive tests and verify GREEN**

Run: `pnpm exec vitest run tests/presenters/ink-listen.test.tsx tests/presenters/listen-message.test.ts tests/commands/telegram-listen.test.ts`

Expected: all listen suites PASS with correct rendering, resolution precedence, downloads, and viewport behavior.

- [ ] **Step 7: Commit**

```bash
git add src/presenters/ink/listen.tsx src/presenters/ink/listen-scroll.ts src/services/listen-reply-resolver.ts tests/presenters/ink-listen.test.tsx tests/presenters/listen-message.test.ts tests/commands/telegram-listen.test.ts
git commit -m "feat: show reply context in interactive listen"
```

### Task 7: Full verification and contract audit

**Files:**
- Modify only if verification exposes a feature-specific regression.

- [ ] **Step 1: Run all focused feature suites**

Run:

```bash
pnpm exec vitest run \
  tests/telegram/raw-message.test.ts \
  tests/services/listen-album-aggregator.test.ts \
  tests/services/listen-attachment.test.ts \
  tests/presenters/logical-message.test.ts \
  tests/storage/message-db.test.ts \
  tests/services/reply-context.test.ts \
  tests/services/query-service.test.ts \
  tests/presenters/human.test.ts \
  tests/presenters/listen-message.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/commands/telegram-listen.test.ts \
  tests/cli/contract.test.ts
```

Expected: all listed suites PASS with no warnings or unhandled errors.

- [ ] **Step 2: Run the complete test suite**

Run: `pnpm test`

Expected: all Vitest suites PASS.

- [ ] **Step 3: Run strict TypeScript validation**

Run: `pnpm typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Inspect the final diff and contracts**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~6..HEAD
```

Confirm that no schema migration, credential/session/database file, or structured stored-message field was added. Confirm `recent`, plain listen, and Ink listen tests cover missing targets without network calls.

- [ ] **Step 5: Commit verification-only fixes if needed**

If verification required code changes, first add a regression test that reproduces the failure, rerun it to observe RED, make the minimal fix, rerun focused and full verification, then commit only those files:

```bash
git add src tests
git commit -m "fix: preserve message display contracts"
```

If no files changed, do not create an empty commit.
