# Download Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-attachment download completion and surface derived message download status across CLI, archive output, query output, and the web UI.

**Architecture:** Add download state to stored attachments, preserve it during message refreshes, and expose a narrow storage API for marking successful downloads. Download and archive workflows use that API; query, web, and presenters consume hydrated attachment state and derived message state.

**Tech Stack:** Node.js 22, TypeScript, better-sqlite3, Commander, React, Vitest

---

## File Map

- Keep: `src/telegram/media-types.ts` unchanged; Telegram-normalized attachments do not carry local download state.
- Modify: `src/storage/message-db.ts` to define stored attachment/message types, bump schema version, add columns, hydrate/write status, preserve status on upsert, and expose `markAttachmentDownloaded`.
- Modify: `tests/storage/message-db-schema.test.ts` and `tests/storage/message-db.test.ts` for schema and behavior coverage.
- Modify: `src/services/download-service.ts` to skip downloaded targets by default, add `force`, emit notices, and mark status after success.
- Modify: `src/commands/telegram.ts` to parse `--force`, pass `MessageDB`, and print runtime notices.
- Modify: `tests/services/download-service.test.ts` and `tests/commands/download.test.ts` for skip, force, warnings, and parser coverage.
- Modify: `src/services/archive-service.ts`, `src/services/archive-markdown.ts`, and archive tests to mark archive media and render persistent status.
- Modify: `src/services/query-service.ts`, `src/web/types.ts`, `src/web/query.ts`, `src/web/api.ts`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/styles.css`, and tests for CLI/query fields, API fields, successful web-download marking, and status icons.
- Modify: `README.md` and `README.zh-CN.md` to document default skip and `--force`.

---

### Task 1: Add Download State To Storage

**Files:**
- Modify: `src/storage/message-db.ts`
- Modify: `tests/storage/message-db-schema.test.ts`
- Modify: `tests/storage/message-db.test.ts`

- [x] **Step 1: Write failing type and storage tests**

Add tests that prove attachments hydrate with state, messages derive `downloaded`, upserts preserve state for unchanged media, changed media resets state, and the marking API updates one attachment:

```ts
it('hydrates attachment download state and derives message downloaded state', () => {
  const db = new MessageDB(dbPath())
  db.upsertMessage(message({
    attachments: [
      attachment({ attachment_index: 1, unique_file_id: 'stable-1', downloadable: true }),
      attachment({ attachment_index: 2, unique_file_id: 'stable-2', downloadable: true }),
    ],
  }))

  expect(db.markAttachmentDownloaded({
    chatId: 100,
    msgId: 1,
    attachmentIndex: 1,
    path: '/tmp/one.jpg',
    downloadedAt: '2026-07-17T10:00:00.000Z',
  })).toBe(true)
  expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1 }])[0]).toMatchObject({
    downloaded: false,
    attachments: [
      { attachment_index: 1, downloaded: true, downloaded_at: '2026-07-17T10:00:00.000Z', download_path: '/tmp/one.jpg' },
      { attachment_index: 2, downloaded: false, downloaded_at: null, download_path: null },
    ],
  })

  expect(db.markAttachmentDownloaded({
    chatId: 100,
    msgId: 1,
    attachmentIndex: 2,
    path: '/tmp/two.jpg',
    downloadedAt: '2026-07-17T10:01:00.000Z',
  })).toBe(true)
  expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1 }])[0]?.downloaded).toBe(true)
})

it('preserves download state when a refreshed attachment is the same media', () => {
  const db = new MessageDB(dbPath())
  db.upsertMessage(message({
    attachments: [attachment({ unique_file_id: 'stable-media', file_name: 'old.jpg', file_size: 10 })],
  }))
  db.markAttachmentDownloaded({
    chatId: 100,
    msgId: 1,
    attachmentIndex: 1,
    path: '/tmp/old.jpg',
    downloadedAt: '2026-07-17T10:00:00.000Z',
  })

  db.upsertMessage(message({
    attachments: [attachment({ unique_file_id: 'stable-media', file_name: 'new-name.jpg', file_size: 10 })],
  }))

  expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1 }])[0]?.attachments[0]).toMatchObject({
    file_name: 'new-name.jpg',
    downloaded: true,
    download_path: '/tmp/old.jpg',
  })
})

it('clears download state when refreshed attachment identity changes', () => {
  const db = new MessageDB(dbPath())
  db.upsertMessage(message({
    attachments: [attachment({ unique_file_id: 'old-media', file_name: 'old.jpg', file_size: 10 })],
  }))
  db.markAttachmentDownloaded({
    chatId: 100,
    msgId: 1,
    attachmentIndex: 1,
    path: '/tmp/old.jpg',
    downloadedAt: '2026-07-17T10:00:00.000Z',
  })

  db.upsertMessage(message({
    attachments: [attachment({ unique_file_id: 'new-media', file_name: 'new.jpg', file_size: 11 })],
  }))

  expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1 }])[0]?.attachments[0]).toMatchObject({
    downloaded: false,
    downloaded_at: null,
    download_path: null,
  })
})

it('returns false when marking a missing attachment downloaded', () => {
  const db = new MessageDB(dbPath())
  expect(db.markAttachmentDownloaded({
    chatId: 100,
    msgId: 999,
    attachmentIndex: 1,
    path: '/tmp/missing.jpg',
    downloadedAt: '2026-07-17T10:00:00.000Z',
  })).toBe(false)
})
```

In `tests/storage/message-db-schema.test.ts`, update schema expectations to require version 2 and columns `downloaded`, `downloaded_at`, and `download_path`.

- [x] **Step 2: Run focused tests and verify failure**

Run: `pnpm exec vitest run tests/storage/message-db-schema.test.ts tests/storage/message-db.test.ts`

Expected: FAIL because `downloaded`, `downloaded_at`, `download_path`, derived message `downloaded`, and `markAttachmentDownloaded` do not exist yet.

- [x] **Step 3: Implement storage-only types and schema**

Leave `src/telegram/media-types.ts` unchanged. In `src/storage/message-db.ts`, add storage-only types:

```ts
export type StoredAttachment = Attachment & {
  downloaded: boolean
  downloaded_at: string | null
  download_path: string | null
}

export type StoredMessage = Omit<NormalizedMessage, 'raw_json' | 'attachments'> & {
  id: number
  downloaded: boolean
  raw_json: string | null
  attachments: StoredAttachment[]
}
```

In `src/storage/message-db.ts`, set `MESSAGE_DB_SCHEMA_VERSION = 2`, add columns to `CANONICAL_ATTACHMENTS_TABLE_SQL`, `REQUIRED_ATTACHMENT_COLUMNS`, `AttachmentRow`, select lists, insert SQL, validation fields, and `attachmentWriteRow`.

- [x] **Step 4: Implement status preservation and marking**

Before deleting attachments in `upsertBatch`, load prior rows for the message id. Merge status into incoming attachments with:

```ts
function mergeDownloadState(next: Attachment, previous: StoredAttachment | undefined): StoredAttachment {
  if (previous == null || !sameAttachmentMedia(previous, next)) return {
    ...next,
    downloaded: false,
    downloaded_at: null,
    download_path: null,
  }
  return {
    ...next,
    downloaded: previous.downloaded,
    downloaded_at: previous.downloaded_at,
    download_path: previous.download_path,
  }
}

function sameAttachmentMedia(previous: StoredAttachment, next: Attachment): boolean {
  if (previous.unique_file_id != null || next.unique_file_id != null) {
    return previous.unique_file_id != null && previous.unique_file_id === next.unique_file_id
  }
  return previous.attachment_index === next.attachment_index
    && previous.kind === next.kind
    && previous.role === next.role
    && previous.file_name === next.file_name
    && previous.mime_type === next.mime_type
    && previous.file_size === next.file_size
}

function deriveMessageDownloaded(attachments: StoredAttachment[]): boolean {
  const downloadable = attachments.filter((attachment) => attachment.downloadable)
  return downloadable.length > 0 && downloadable.every((attachment) => attachment.downloaded)
}
```

Add a public method:

```ts
markAttachmentDownloaded(input: {
  chatId: number
  msgId: number
  attachmentIndex: number
  path: string
  downloadedAt: string
}): boolean {
  const result = this.db.prepare(`
    UPDATE attachments
    SET downloaded = 1,
      downloaded_at = @downloadedAt,
      download_path = @path
    WHERE attachment_index = @attachmentIndex
      AND message_id = (
        SELECT id FROM messages
        WHERE platform = 'telegram' AND chat_id = @chatId AND msg_id = @msgId
      )
  `).run({
    chatId: canonicalChatId(input.chatId),
    msgId: input.msgId,
    attachmentIndex: input.attachmentIndex,
    path: input.path,
    downloadedAt: input.downloadedAt,
  })
  return result.changes === 1
}
```

In `hydrateMessages`, set `downloaded: deriveMessageDownloaded(attachments)` on each message object.

- [x] **Step 5: Run focused storage tests**

Run: `pnpm exec vitest run tests/storage/message-db-schema.test.ts tests/storage/message-db.test.ts`

Expected: PASS.

- [x] **Step 6: Commit storage foundation**

```bash
git add src/storage/message-db.ts tests/storage/message-db-schema.test.ts tests/storage/message-db.test.ts docs/plans/2026-07-17-download-status.md
git commit -m "feat: persist attachment download status"
```

---

### Task 2: Add Default Skip And Force To `tg download`

**Files:**
- Modify: `src/services/download-service.ts`
- Modify: `src/commands/telegram.ts`
- Modify: `tests/services/download-service.test.ts`
- Modify: `tests/commands/download.test.ts`

- [x] **Step 1: Write failing service tests**

Add a fake status store to `tests/services/download-service.test.ts`:

```ts
type DownloadStatusStore = {
  isAttachmentDownloaded(input: { chatId: number; msgId: number; attachmentIndex: number }): boolean
  markAttachmentDownloaded(input: { chatId: number; msgId: number; attachmentIndex: number; path: string; downloadedAt: string }): boolean
}

function statusStore(downloaded = new Set<string>()): DownloadStatusStore & { marked: unknown[] } {
  const marked: unknown[] = []
  return {
    marked,
    isAttachmentDownloaded: ({ chatId, msgId, attachmentIndex }) => downloaded.has(`${chatId}:${msgId}:${attachmentIndex}`),
    markAttachmentDownloaded: (input) => {
      marked.push(input)
      downloaded.add(`${input.chatId}:${input.msgId}:${input.attachmentIndex}`)
      return true
    },
  }
}
```

Add tests:

```ts
it('skips already downloaded attachments by default and emits a notice', async () => {
  const output = outputDirectory()
  const source = sourceFor([[message(42)]])
  const notices: string[] = []
  const store = statusStore(new Set(['-100:42:1']))

  const result = await new DownloadService(source, {
    downloadStatusStore: store,
    onNotice: (notice) => notices.push(notice),
  }).download({ chat: '@channel', messageId: 42, output })

  expect(result).toMatchObject({
    ok: true,
    data: {
      requested: 0,
      downloaded: 0,
      skipped: 1,
      already_downloaded: 1,
      skips: [{ msg_id: 42, attachment_index: 1, reason: 'already_downloaded' }],
    },
  })
  expect(notices).toEqual(['already downloaded: message 42 attachment 1'])
  expect(source.downloadMedia).not.toHaveBeenCalled()
})

it('redownloads already downloaded attachments with force', async () => {
  const output = outputDirectory()
  const source = sourceFor([[message(42)]])
  const store = statusStore(new Set(['-100:42:1']))

  const result = await new DownloadService(source, { downloadStatusStore: store }).download({
    chat: '@channel',
    messageId: 42,
    output,
    force: true,
  })

  expect(result).toMatchObject({ ok: true, data: { requested: 1, downloaded: 1, already_downloaded: 0 } })
  expect(source.downloadMedia).toHaveBeenCalledTimes(1)
  expect(store.marked).toHaveLength(1)
})
```

- [x] **Step 2: Run service tests and verify failure**

Run: `pnpm exec vitest run tests/services/download-service.test.ts`

Expected: FAIL because `force`, `downloadStatusStore`, `already_downloaded`, and runtime notices are not implemented.

- [x] **Step 3: Implement service options and skip logic**

In `src/services/download-service.ts`, extend input and result types:

```ts
export type DownloadInput = {
  chat: string | number
  messageId?: number
  groupedId?: string
  groupedMessages?: ArchiveMessage[]
  attachment?: number
  fromId?: number
  toId?: number
  since?: Date
  until?: Date
  all?: boolean
  force?: boolean
  output: string
  concurrency?: number
}

export type DownloadWarning = {
  msg_id: number
  attachment_index: number
  code: 'download_status_update_failed'
  message: string
}

export type DownloadStatusStore = {
  isAttachmentDownloaded(input: { chatId: number; msgId: number; attachmentIndex: number }): boolean
  markAttachmentDownloaded(input: { chatId: number; msgId: number; attachmentIndex: number; path: string; downloadedAt: string }): boolean
}
```

Add `already_downloaded: number` and `warnings: DownloadWarning[]` to `DownloadResult`. Add dependencies:

```ts
type DownloadDependencies = {
  sleep?: (milliseconds: number) => Promise<void>
  exists?: (path: string) => boolean
  uuid?: () => string
  now?: () => Date
  onNotice?: (message: string) => void
  downloadStatusStore?: DownloadStatusStore
}
```

During target selection, before reserving a destination, skip when `input.force !== true` and the store reports downloaded:

```ts
if (this.downloadStatusStore?.isAttachmentDownloaded({
  chatId: message.chat_id,
  msgId: message.msg_id,
  attachmentIndex: attachment.attachment_index,
}) === true && input.force !== true) {
  this.lastSkips.push(skipFor(message, attachment, selectionIndex, 'already_downloaded'))
  this.lastAlreadyDownloaded += 1
  this.onNotice(`already downloaded: message ${message.msg_id} attachment ${attachment.attachment_index}`)
  continue
}
```

After a successful rename, mark status:

```ts
const marked = this.downloadStatusStore?.markAttachmentDownloaded({
  chatId: target.message.chat_id,
  msgId: target.message.msg_id,
  attachmentIndex: target.attachment.attachment_index,
  path: target.destination,
  downloadedAt: this.now().toISOString(),
})
if (marked === false) {
  result.warnings.push({
    msg_id: target.message.msg_id,
    attachment_index: target.attachment.attachment_index,
    code: 'download_status_update_failed',
    message: `Downloaded media but could not update local status for message ${target.message.msg_id} attachment ${target.attachment.attachment_index}.`,
  })
}
```

- [x] **Step 4: Add command parser tests**

In `tests/commands/download.test.ts`, add a test that runs `tg download @channel 42 --force --json` and asserts the fake download client was called even when the local attachment is marked downloaded. Add a stderr/stdout test for plain output that expects `already downloaded: message 42 attachment 1`.

- [x] **Step 5: Wire command options**

In `src/commands/telegram.ts`, add:

```ts
.option('--force', 'Redownload media even when local status says it was already downloaded')
```

Include `force?: boolean` in `DownloadFlags`, set `force: options.force === true` in `buildDownloadInput`, open `const downloadDb = new MessageDB(context.dbPath)` in the download action, and pass:

```ts
return new DownloadService(client.archive, {
  downloadStatusStore: downloadDb,
  onNotice: (message) => {
    if (!effectiveOutputIsStructured(options)) process.stderr.write(`${message}\n`)
  },
}).download({
  ...input.data,
  ...(groupedMessages.length === 0 ? {} : { groupedMessages }),
})
```

Add `effectiveOutputIsStructured(options)` locally:

```ts
function effectiveOutputIsStructured(options: { json?: boolean; yaml?: boolean }): boolean {
  return options.json === true || options.yaml === true
}
```

Ensure `downloadDb.close()` runs in `finally`.

- [x] **Step 6: Run focused download tests**

Run: `pnpm exec vitest run tests/services/download-service.test.ts tests/commands/download.test.ts`

Expected: PASS.

- [x] **Step 7: Commit download behavior**

```bash
git add src/services/download-service.ts src/commands/telegram.ts tests/services/download-service.test.ts tests/commands/download.test.ts docs/plans/2026-07-17-download-status.md
git commit -m "feat: skip previously downloaded media"
```

---

### Task 3: Mark Archive Downloads And Render Persistent Status

**Files:**
- Modify: `src/services/archive-service.ts`
- Modify: `src/services/archive-markdown.ts`
- Modify: `src/commands/archive.ts`
- Modify: `tests/services/archive-service.test.ts`
- Modify: `tests/services/archive-markdown.test.ts`
- Modify: `tests/commands/archive.test.ts`

- [x] **Step 1: Write failing archive tests**

In `tests/services/archive-service.test.ts`, add a status store fake with `markAttachmentDownloaded`. Add tests for downloaded and reused media:

```ts
it('marks archive media downloaded after a successful media download', async () => {
  const marked: unknown[] = []
  const service = new ArchiveService(source, {
    downloadStatusStore: {
      markAttachmentDownloaded: (input) => {
        marked.push(input)
        return true
      },
    },
    now: () => new Date('2026-07-17T10:00:00.000Z'),
  })

  const result = await service.archive({
    account: { userId: 1, name: 'work' },
    chats: ['@team'],
    all: false,
    output,
    media: true,
    full: true,
    now: new Date('2026-07-17T10:00:00.000Z'),
  })

  expect(result.ok).toBe(true)
  expect(marked).toContainEqual(expect.objectContaining({
    chatId: 100,
    msgId: 42,
    attachmentIndex: 1,
    downloadedAt: '2026-07-17T10:00:00.000Z',
  }))
})
```

In `tests/services/archive-markdown.test.ts`, assert attachment lines include persistent status:

```ts
expect(renderArchiveMessage(message({
  attachments: [attachment({ downloaded: true, downloaded_at: '2026-07-17T10:00:00.000Z', download_path: '/tmp/a.jpg' })],
}))).toContain('downloaded: yes')
```

- [x] **Step 2: Run archive tests and verify failure**

Run: `pnpm exec vitest run tests/services/archive-service.test.ts tests/services/archive-markdown.test.ts`

Expected: FAIL because archive does not accept a status store and Markdown does not include persistent status.

- [x] **Step 3: Implement archive status marking**

In `src/services/archive-service.ts`, add dependencies:

```ts
type ArchiveDependencies = {
  downloadStatusStore?: {
    markAttachmentDownloaded(input: { chatId: number; msgId: number; attachmentIndex: number; path: string; downloadedAt: string }): boolean
  }
  now?: () => Date
}
```

After media download or reuse succeeds, call:

```ts
this.dependencies.downloadStatusStore?.markAttachmentDownloaded({
  chatId: message.chat_id,
  msgId: message.msg_id,
  attachmentIndex: attachment.attachment_index,
  path: absolutePath,
  downloadedAt: this.dependencies.now().toISOString(),
})
```

If marking returns false, add an archive warning with code `download_status_update_failed` and a message naming the message and attachment.

- [x] **Step 4: Render persistent Markdown status**

In `src/services/archive-markdown.ts`, extend `renderAttachmentLine` so the line ends with persistent status:

```ts
return `Attachment #${safeInteger(attachment.attachment_index, 'attachment_index')}: ${label}; type: ${escapeMarkdownSingleLine(attachment.kind)}; role: ${escapeMarkdownSingleLine(attachment.role)}; size: ${size}; status: ${status}; downloadable: ${attachment.downloadable ? 'yes' : 'no'}; downloaded: ${attachment.downloaded ? 'yes' : 'no'}`
```

Update `ARCHIVE_MEDIA_LINE` regex to accept the new `; downloaded: yes|no` suffix.

- [x] **Step 5: Run focused archive tests**

Run: `pnpm exec vitest run tests/services/archive-service.test.ts tests/services/archive-markdown.test.ts`

Expected: PASS.

- [x] **Step 6: Commit archive integration**

```bash
git add src/services/archive-service.ts src/services/archive-markdown.ts src/commands/archive.ts tests/services/archive-service.test.ts tests/services/archive-markdown.test.ts tests/commands/archive.test.ts docs/plans/2026-07-17-download-status.md
git commit -m "feat: record archive media download status"
```

---

### Task 4: Expose Status Through Query And Web API

**Files:**
- Modify: `src/web/types.ts`
- Modify: `src/web/query.ts`
- Modify: `src/web/api.ts`
- Modify: `tests/services/query-service.test.ts`
- Modify: `tests/web/query.test.ts`
- Modify: `tests/web/api.test.ts`

- [x] **Step 1: Write failing query and WebQuery tests**

In `tests/services/query-service.test.ts`, add a test proving structured query data includes the derived message state and attachment state:

```ts
it('returns download status in query data', () => {
  const db = new MessageDB(dbPath)
  db.upsertBatch([message({
    chat_id: 10,
    chat_name: 'General',
    msg_id: 10,
    content: 'downloadable photo',
    attachments: [attachment({ unique_file_id: 'photo-10', downloadable: true })],
  })])
  db.markAttachmentDownloaded({
    chatId: 10,
    msgId: 10,
    attachmentIndex: 1,
    path: '/tmp/photo-10.jpg',
    downloadedAt: '2026-07-17T10:00:00.000Z',
  })

  const result = new QueryService(db).search({ keyword: 'photo' })

  expect(result).toMatchObject({
    ok: true,
    data: [{
      downloaded: true,
      attachments: [{
        downloaded: true,
        downloaded_at: '2026-07-17T10:00:00.000Z',
        download_path: '/tmp/photo-10.jpg',
      }],
    }],
  })
})
```

In `tests/web/query.test.ts`, seed a downloadable attachment, mark it downloaded, and assert `/messages` shape:

```ts
it('returns message and attachment download status', () => {
  const dbPath = join(root, 'accounts', 'work', 'messages.db')
  const db = new MessageDB(dbPath)
  db.upsertBatch([message({
    chat_id: 10,
    msg_id: 10,
    attachments: [attachment({ unique_file_id: 'photo-10', downloadable: true })],
  })])
  db.markAttachmentDownloaded({
    chatId: 10,
    msgId: 10,
    attachmentIndex: 1,
    path: '/tmp/photo-10.jpg',
    downloadedAt: '2026-07-17T10:00:00.000Z',
  })
  db.close()

  const page = service.messages({ account: 'work', chatId: 10 })

  expect(page.items[0]).toMatchObject({
    downloaded: true,
    attachments: [{
      downloaded: true,
      downloaded_at: '2026-07-17T10:00:00.000Z',
      download_path: '/tmp/photo-10.jpg',
    }],
  })
})
```

In `tests/web/api.test.ts`, update the download-media test to reopen `MessageDB` after the POST and assert the attachment is marked downloaded. Assert the JSON response has `warnings: []`.

- [x] **Step 2: Run query and web backend tests and verify failure**

Run: `pnpm exec vitest run tests/services/query-service.test.ts tests/web/query.test.ts tests/web/api.test.ts`

Expected: FAIL because stored query data does not expose `downloaded`, web types do not include `downloaded`, and `/api/download-media` opens the database readonly.

- [x] **Step 3: Preserve query-service structured data**

Presenter-specific transformations must not strip storage fields. In `src/services/query-service.ts`, keep `StoredMessage` as the returned data for search/recent/today/filter. If TypeScript complains about `StoredMessage` fields, update local type annotations so `data` remains the hydrated storage rows with `downloaded` and attachment status fields intact.

- [x] **Step 4: Add web response fields**

In `src/web/types.ts`, add:

```ts
downloaded: boolean
```

to `WebMessage`, and add:

```ts
downloaded: boolean
downloaded_at: string | null
download_path: string | null
```

to `WebMessageAttachment`.

In `src/web/query.ts`, map stored message and attachment state into these fields for main messages and reply contexts.

- [x] **Step 5: Mark web downloads**

In `src/web/api.ts`, open `MessageDB` writable in `downloadMediaPost`:

```ts
const db = new MessageDB(clientContext.dbPath)
const warnings: Array<{ code: string; message: string; chat_id: number; msg_id: number; attachment_index: number }> = []
```

After each successful `client.downloadMessageMedia`, call:

```ts
const marked = db.markAttachmentDownloaded({
  chatId: attachment.chatId,
  msgId: attachment.msgId,
  attachmentIndex: attachment.attachmentIndex,
  path: destination,
  downloadedAt: new Date().toISOString(),
})
if (!marked) {
  warnings.push({
    code: 'download_status_update_failed',
    message: `Downloaded media but could not update local status for message ${attachment.msgId} attachment ${attachment.attachmentIndex}.`,
    chat_id: attachment.chatId,
    msg_id: attachment.msgId,
    attachment_index: attachment.attachmentIndex,
  })
}
```

Return:

```ts
return success({ downloaded: results, warnings })
```

- [x] **Step 6: Run query and web backend tests**

Run: `pnpm exec vitest run tests/services/query-service.test.ts tests/web/query.test.ts tests/web/api.test.ts`

Expected: PASS.

- [x] **Step 7: Commit API exposure**

```bash
git add src/web/types.ts src/web/query.ts src/web/api.ts tests/services/query-service.test.ts tests/web/query.test.ts tests/web/api.test.ts docs/plans/2026-07-17-download-status.md
git commit -m "feat: expose download status in web api"
```

---

### Task 5: Show Download Status In Web UI

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `tests/web/frontend-assets.test.ts`

- [ ] **Step 1: Write failing frontend tests**

In `tests/web/frontend-assets.test.ts`, add source-level checks for the expected rendering helpers and labels:

```ts
it('renders message and attachment download status labels', () => {
  const app = readFileSync(join(root, 'web/src/App.tsx'), 'utf8')
  expect(app).toContain('messageDownloadState')
  expect(app).toContain('attachmentDownloadState')
  expect(app).toContain('Downloaded')
  expect(app).toContain('Partially downloaded')
  expect(app).toContain('Not downloaded')
  expect(app).toContain('download-status-icon')
})
```

- [ ] **Step 2: Run frontend asset tests and verify failure**

Run: `pnpm exec vitest run tests/web/frontend-assets.test.ts`

Expected: FAIL because status helpers and class names do not exist.

- [ ] **Step 3: Update frontend API types**

In `web/src/api.ts`, add `downloaded: boolean` to `MessageRow`, and add download fields to `MessageAttachment`:

```ts
downloaded: boolean
downloaded_at: string | null
download_path: string | null
```

- [ ] **Step 4: Add UI helpers and render icons**

In `web/src/App.tsx`, add:

```tsx
type DownloadVisualState = 'none' | 'downloaded' | 'partial' | 'not-downloaded'

function attachmentDownloadState(attachment: MessageAttachment): DownloadVisualState {
  if (!attachment.downloadable) return 'none'
  return attachment.downloaded ? 'downloaded' : 'not-downloaded'
}

function messageDownloadState(message: MessageRow): DownloadVisualState {
  const downloadable = message.attachments.filter((attachment) => attachment.downloadable)
  if (downloadable.length === 0) return 'none'
  const downloaded = downloadable.filter((attachment) => attachment.downloaded).length
  if (downloaded === downloadable.length) return 'downloaded'
  if (downloaded > 0) return 'partial'
  return 'not-downloaded'
}

function downloadStateLabel(state: DownloadVisualState): string {
  if (state === 'downloaded') return 'Downloaded'
  if (state === 'partial') return 'Partially downloaded'
  if (state === 'not-downloaded') return 'Not downloaded'
  return ''
}

function DownloadStatusIcon({ state }: { state: DownloadVisualState }) {
  if (state === 'none') return null
  return (
    <span
      className={`download-status-icon download-status-${state}`}
      title={downloadStateLabel(state)}
      data-tooltip={downloadStateLabel(state)}
      aria-label={downloadStateLabel(state)}
    />
  )
}
```

Render `<DownloadStatusIcon state={messageDownloadState(message)} />` in the message meta row, and `<DownloadStatusIcon state={attachmentDownloadState(attachment)} />` in each attachment row.

Update `downloadAttachments` result type:

```ts
const result = await postJson<{
  downloaded: Array<{ path: string }>
  warnings: Array<{ code: string; message: string }>
}>('/api/download-media', { ... })
```

After success, keep the existing `await loadMessages(messagePage)` refresh and display warning text when `result.warnings.length > 0`.

- [ ] **Step 5: Add CSS**

In `web/src/styles.css`, add:

```css
.download-status-icon {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 999px;
  display: inline-block;
  border: 1px solid rgba(15, 23, 42, 0.22);
  flex: 0 0 auto;
}

.download-status-downloaded {
  background: #0f9f6e;
  border-color: #0f9f6e;
}

.download-status-partial {
  background: linear-gradient(90deg, #0f9f6e 0 50%, #f5a524 50% 100%);
  border-color: #b7791f;
}

.download-status-not-downloaded {
  background: #fff;
  border-color: #94a3b8;
}
```

- [ ] **Step 6: Run frontend tests**

Run: `pnpm exec vitest run tests/web/frontend-assets.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit frontend status**

```bash
git add web/src/api.ts web/src/App.tsx web/src/styles.css tests/web/frontend-assets.test.ts docs/plans/2026-07-17-download-status.md
git commit -m "feat: show download status in web messages"
```

---

### Task 6: Documentation And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/plans/2026-07-17-download-status.md`

- [ ] **Step 1: Update README download docs**

In `README.md`, update the download paragraph to include:

```md
Downloaded attachments are remembered in the local account database. By default, later `tg download` runs skip attachments that were already downloaded and print an `already downloaded` notice in plain output. Use `--force` to download them again and refresh the saved status.
```

In `README.zh-CN.md`, add the matching Chinese text:

```md
已下载的附件会记录在当前账号的本地数据库中。后续运行 `tg download` 时默认跳过已经下载过的附件，并在普通输出中提示 `already downloaded`。如果需要重新下载并刷新状态，使用 `--force`。
```

- [ ] **Step 2: Run full verification**

Run: `pnpm test`

Expected: all Vitest suites pass.

Run: `pnpm typecheck`

Expected: TypeScript exits successfully.

Run: `pnpm build`

Expected: production build completes successfully.

- [ ] **Step 3: Commit docs and verification marker**

```bash
git add README.md README.zh-CN.md docs/plans/2026-07-17-download-status.md
git commit -m "docs: document download status behavior"
```

---

## Self-Review Notes

- Spec coverage: storage state, derived message state, default skip, `--force`, runtime notice, archive marking, query/web fields, web icons, warnings, and docs are all covered by tasks.
- Placeholder scan: no `TBD`, `TODO`, or unspecified test steps remain.
- Type consistency: the plan consistently uses `downloaded`, `downloaded_at`, `download_path`, `already_downloaded`, `warnings`, `force`, and `markAttachmentDownloaded`.
