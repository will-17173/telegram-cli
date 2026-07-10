# Listen Automatic Attachment Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `tg listen --auto-download` so interactive and plain-text listeners automatically save every downloadable incoming attachment with a maximum of three concurrent transfers.

**Architecture:** Move attachment discovery and filename selection into a shared listen-attachment service, then add an `AutoDownloadCoordinator` that owns deduplication, destination reservation, bounded concurrency, client pause/resume, cleanup, and state callbacks. The plain listener and Ink listener both feed deduplicated messages into the coordinator and translate its events into their existing output/state models.

**Tech Stack:** TypeScript 5.9, Node.js 22 filesystem APIs, Commander, Ink/React, mtcute adapter interface, Vitest 4, pnpm

---

## File Structure

- Create `src/services/listen-attachment.ts`: shared attachment discovery, stable attachment keys, fallback filenames, and Telegram download targets.
- Create `src/services/auto-download-coordinator.ts`: three-worker queue, lifecycle control, destination reservation, progress/result events, and partial-file cleanup.
- Create `tests/services/listen-attachment.test.ts`: attachment discovery and naming contract.
- Create `tests/services/auto-download-coordinator.test.ts`: concurrency, deduplication, failure, cleanup, pause/resume, and stop behavior.
- Modify `src/presenters/listen-message.ts`: consume shared attachment descriptions rather than owning raw-media extraction.
- Modify `src/services/attachment-download.ts`: allow destination resolution to account for in-process reserved paths.
- Modify `tests/services/attachment-download.test.ts`: cover reserved-path collision handling.
- Modify `src/commands/telegram.ts`: declare the flag and connect the coordinator to plain-text listening.
- Modify `tests/commands/telegram-listen.test.ts`: verify CLI wiring, hidden media independence, album downloads, output, and failures.
- Modify `src/presenters/ink/listen.tsx`: connect the coordinator to interactive state and retain manual download behavior.
- Modify `tests/presenters/ink-listen.test.tsx`: cover queued rendering and shared attachment helpers.
- Modify `README.md` and `README.zh-CN.md`: document `--auto-download`, location, concurrency, and compatibility with `--no-media`.

### Task 1: Extract shared listen attachment metadata

**Files:**
- Create: `src/services/listen-attachment.ts`
- Create: `tests/services/listen-attachment.test.ts`
- Modify: `src/presenters/listen-message.ts`
- Modify: `tests/presenters/listen-message.test.ts`
- Modify: `src/presenters/ink/listen.tsx`

- [ ] **Step 1: Write failing tests for discovery, keys, fallback names, and download targets**

Create `tests/services/listen-attachment.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  attachmentDownloadTarget,
  attachmentFileName,
  discoverListenAttachments,
  listenAttachmentKey,
} from '../../src/services/listen-attachment.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('listen attachment metadata', () => {
  it('discovers downloadable media even when presentation hides media', () => {
    expect(discoverListenAttachments(message()).map((item) => item.kind)).toEqual(['Photo'])
  })

  it('uses Telegram filenames and deterministic fallback extensions', () => {
    const named = discoverListenAttachments(message({ fileName: 'photo.jpg' }))[0]!
    const unnamed = discoverListenAttachments(message())[0]!

    expect(attachmentFileName(named)).toBe('photo.jpg')
    expect(attachmentFileName(unnamed)).toBe('100-42.jpg')
  })

  it('builds stable per-attachment keys and adapter targets', () => {
    const attachment = discoverListenAttachments(message())[0]!

    expect(listenAttachmentKey(attachment, 0)).toBe('100:42:0')
    expect(attachmentDownloadTarget(attachment)).toEqual({ chat: 100, msgId: 42 })
  })
})

function message(options: { fileName?: string } = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 42,
    sender_id: 1,
    sender_name: 'Alice',
    content: '',
    timestamp: '2026-07-10T07:22:00.000Z',
    raw_json: {
      _: 'message',
      media: {
        _: 'messageMediaPhoto',
        photo: options.fileName == null ? {} : { file_name: options.fileName },
      },
    },
  }
}
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `pnpm test -- tests/services/listen-attachment.test.ts`

Expected: FAIL because `src/services/listen-attachment.ts` does not exist.

- [ ] **Step 3: Create the shared attachment module and move the existing parser into it**

Create `src/services/listen-attachment.ts` with the raw JSON parsing helpers currently in `src/presenters/listen-message.ts`, plus these public contracts:

```ts
import type { StoredMessageInput } from '../storage/message-db.js'

export type ListenAttachment = {
  chatId: number
  messageId: number
  kind: string
  label: string
  fileName: string | null
  downloadable: boolean
  previewJpegBase64?: string
}

type MediaDescription = Omit<ListenAttachment, 'chatId' | 'messageId' | 'previewJpegBase64'>

const MEDIA_EXTENSIONS: Record<string, string> = {
  Photo: 'jpg',
  Video: 'mp4',
  Audio: 'mp3',
  Voice: 'ogg',
  Sticker: 'webp',
  Animation: 'mp4',
  Document: 'bin',
}

export function discoverListenAttachments(message: StoredMessageInput): ListenAttachment[] {
  let previewAssigned = false
  return extractMediaLabels(message.raw_json).map((attachment) => {
    const preview = attachment.kind === 'Photo' && !previewAssigned
      ? message.preview_jpeg_base64
      : undefined
    if (attachment.kind === 'Photo' && !previewAssigned) previewAssigned = true
    return {
      ...attachment,
      chatId: message.chat_id,
      messageId: message.msg_id,
      ...(preview == null ? {} : { previewJpegBase64: preview }),
    }
  })
}

export function listenAttachmentKey(attachment: ListenAttachment, index: number): string {
  return `${attachment.chatId}:${attachment.messageId}:${index}`
}

export function attachmentFileName(attachment: ListenAttachment): string {
  if (attachment.fileName != null) return attachment.fileName
  const extension = MEDIA_EXTENSIONS[attachment.kind] ?? 'bin'
  return `${attachment.chatId}-${attachment.messageId}.${extension}`
}

export function attachmentDownloadTarget(attachment: ListenAttachment): { chat: number; msgId: number } {
  return { chat: attachment.chatId, msgId: attachment.messageId }
}
```

Move `RawRecord`, `extractMediaLabels`, media-node collection/detection/detail helpers, JSON parsing, deduplication, `DOWNLOADABLE_MEDIA_KINDS`, and media label maps from `listen-message.ts` into this file without changing their logic.

- [ ] **Step 4: Update the presenter and Ink module to use the shared contract**

In `src/presenters/listen-message.ts`, import the shared type/discovery function and replace the inline extraction block:

```ts
import { discoverListenAttachments, type ListenAttachment as BaseListenAttachment } from '../services/listen-attachment.js'

export type ListenAttachment = BaseListenAttachment & {
  previewRows?: number
  previewCells?: PreviewCell[][]
}

const media = options.showMedia
  ? messages.flatMap((item) => discoverListenAttachments(item))
  : []
```

Delete only the parser helpers that moved to the service. Keep timestamp/content formatting and preview-cell presentation types in the presenter.

In `src/presenters/ink/listen.tsx`, import `attachmentDownloadTarget`, `attachmentFileName`, and `listenAttachmentKey` from the service. Remove its local `MEDIA_EXTENSIONS`, `attachmentFileName`, and `attachmentDownloadTarget`. Build collection keys with:

```ts
key: listenAttachmentKey(attachment, index),
```

- [ ] **Step 5: Run metadata and presenter regression tests**

Run: `pnpm test -- tests/services/listen-attachment.test.ts tests/presenters/listen-message.test.ts tests/presenters/ink-listen.test.tsx`

Expected: PASS with no changes to existing media labels, album association, previews, or manual targets.

- [ ] **Step 6: Commit the shared metadata extraction**

```bash
git add src/services/listen-attachment.ts src/presenters/listen-message.ts src/presenters/ink/listen.tsx tests/services/listen-attachment.test.ts tests/presenters/listen-message.test.ts tests/presenters/ink-listen.test.tsx
git commit -m "refactor(listen): share attachment metadata"
```

### Task 2: Build the bounded automatic-download coordinator

**Files:**
- Create: `src/services/auto-download-coordinator.ts`
- Create: `tests/services/auto-download-coordinator.test.ts`
- Modify: `src/services/attachment-download.ts`
- Modify: `tests/services/attachment-download.test.ts`

- [ ] **Step 1: Add a failing reserved-destination test**

Append to `tests/services/attachment-download.test.ts`:

```ts
it('skips destinations reserved by downloads in the same process', () => {
  const reserved = new Set(['/Users/test/Downloads/telegram-cli/photo.jpg'])
  const destination = resolveAttachmentDestination({
    homeDir: '/Users/test',
    fileName: 'photo.jpg',
    exists: () => false,
    reserved,
  })

  expect(destination).toBe('/Users/test/Downloads/telegram-cli/photo (2).jpg')
})
```

- [ ] **Step 2: Run the destination test and verify the type/behavior failure**

Run: `pnpm test -- tests/services/attachment-download.test.ts`

Expected: FAIL because `reserved` is not accepted and the unsuffixed path is returned.

- [ ] **Step 3: Extend destination resolution for active reservations**

Update `src/services/attachment-download.ts`:

```ts
type ResolveAttachmentDestinationOptions = {
  homeDir: string
  fileName: string
  exists: (path: string) => boolean
  reserved?: ReadonlySet<string>
}

function destinationExists(path: string, options: ResolveAttachmentDestinationOptions): boolean {
  return options.exists(path) || options.reserved?.has(path) === true
}
```

Use `destinationExists(destination, options)` in both the initial check and suffix loop.

- [ ] **Step 4: Write coordinator tests before its implementation**

Create `tests/services/auto-download-coordinator.test.ts` using deferred promises to control active jobs:

```ts
import { describe, expect, it, vi } from 'vitest'

import { AutoDownloadCoordinator, type AutoDownloadEvent } from '../../src/services/auto-download-coordinator.js'
import type { DownloadMessageMediaOptions, TelegramClientAdapter } from '../../src/telegram/types.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('AutoDownloadCoordinator', () => {
  it('runs at most three tasks and starts the next after one settles', async () => {
    const deferred = Array.from({ length: 4 }, () => promiseWithResolvers<void>())
    const download = vi.fn((options: DownloadMessageMediaOptions) => deferred[options.msgId - 1]!.promise)
    const coordinator = createCoordinator(download)

    coordinator.setClient(client(download))
    for (let id = 1; id <= 4; id += 1) coordinator.enqueue(message(id))
    await tick()

    expect(download.mock.calls.map(([options]) => options.msgId)).toEqual([1, 2, 3])
    deferred[0]!.resolve()
    await tick()
    expect(download.mock.calls.map(([options]) => options.msgId)).toEqual([1, 2, 3, 4])
  })

  it('deduplicates repeated messages and continues after failure', async () => {
    const events: AutoDownloadEvent[] = []
    const download = vi.fn(async (options: DownloadMessageMediaOptions) => {
      if (options.msgId === 1) throw new Error('network failed')
    })
    const remove = vi.fn()
    const coordinator = createCoordinator(download, { events, remove })

    coordinator.setClient(client(download))
    coordinator.enqueue(message(1))
    coordinator.enqueue(message(1))
    coordinator.enqueue(message(2))
    await coordinator.waitForIdle()

    expect(download).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledWith('/home/test/Downloads/telegram-cli/100-1.jpg')
    expect(events.some((event) => event.status === 'failed' && event.key === '100:1:0')).toBe(true)
    expect(events.some((event) => event.status === 'completed' && event.key === '100:2:0')).toBe(true)
  })

  it('pauses queued work without a client, resumes it, and cancels it on stop', async () => {
    const download = vi.fn(async () => undefined)
    const coordinator = createCoordinator(download)
    coordinator.enqueue(message(1))
    await tick()
    expect(download).not.toHaveBeenCalled()

    coordinator.setClient(client(download))
    await coordinator.waitForIdle()
    expect(download).toHaveBeenCalledOnce()

    coordinator.setClient(null)
    coordinator.enqueue(message(2))
    coordinator.stop()
    coordinator.setClient(client(download))
    await tick()
    expect(download).toHaveBeenCalledOnce()
  })

  it('waits for active work without waiting for the paused queue', async () => {
    const first = promiseWithResolvers<void>()
    const download = vi.fn((options: DownloadMessageMediaOptions) => {
      return options.msgId === 1 ? first.promise : Promise.resolve()
    })
    const coordinator = createCoordinator(download, { concurrency: 1 })
    coordinator.setClient(client(download))
    coordinator.enqueue(message(1))
    coordinator.enqueue(message(2))
    await tick()

    coordinator.setClient(null)
    const activeSettled = vi.fn()
    void coordinator.waitForActive().then(activeSettled)
    await tick()
    expect(activeSettled).not.toHaveBeenCalled()

    first.resolve()
    await tick()
    expect(activeSettled).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledOnce()
  })
})
```

Complete the file with typed helpers `client`, `message`, `tick`, `promiseWithResolvers`, and `createCoordinator`. `createCoordinator` must inject `/home/test`, `exists: () => false`, `mkdir: vi.fn()`, optional `remove`, and collect `onEvent` callbacks, so tests never touch the real filesystem.

- [ ] **Step 5: Run coordinator tests and verify the module is missing**

Run: `pnpm test -- tests/services/auto-download-coordinator.test.ts tests/services/attachment-download.test.ts`

Expected: attachment destination tests PASS; coordinator tests FAIL because the coordinator module does not exist.

- [ ] **Step 6: Implement the coordinator public contract**

Create `src/services/auto-download-coordinator.ts` with these types and methods:

```ts
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import type { StoredMessageInput } from '../storage/message-db.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import { resolveAttachmentDestination } from './attachment-download.js'
import {
  attachmentDownloadTarget,
  attachmentFileName,
  discoverListenAttachments,
  listenAttachmentKey,
} from './listen-attachment.js'

export type AutoDownloadEvent =
  | { key: string; status: 'queued' }
  | { key: string; status: 'downloading'; progress: number | null }
  | { key: string; status: 'completed'; path: string }
  | { key: string; status: 'failed'; error: string }
  | { key: string; status: 'cancelled' }

type AutoDownloadCoordinatorOptions = {
  concurrency?: number
  homeDir?: string
  exists?: (path: string) => boolean
  mkdir?: (path: string) => void
  remove?: (path: string) => void
  onEvent?: (event: AutoDownloadEvent) => void
}

export class AutoDownloadCoordinator {
  // Store the current client, FIFO pending tasks, seen keys, reserved paths,
  // active count, stopped flag, and idle promise resolvers.

  constructor(private readonly options: AutoDownloadCoordinatorOptions = {}) {}

  setClient(client: TelegramClientAdapter | null): void {
    // null pauses new starts; a non-null client calls pump().
  }

  enqueue(message: StoredMessageInput): void {
    // Ignore calls after stop. Discover only attachments with downloadable=true,
    // assign chat:message:index keys, deduplicate, emit queued, and call pump().
  }

  stop(): void {
    // Mark stopped, emit cancelled for every pending task, clear the queue,
    // and settle idle waiters when active work reaches zero.
  }

  waitForIdle(): Promise<void> {
    // Resolve immediately when pending and active are both empty; otherwise
    // register a resolver completed by settleIdle().
  }

  waitForActive(): Promise<void> {
    // Resolve immediately when active is zero; otherwise register a resolver
    // completed whenever the last in-progress transfer settles. Pending tasks
    // are intentionally ignored so a disconnected client can be replaced.
  }
}
```

Implement `pump()` as a loop that starts tasks while a client exists, the coordinator is not stopped, `active < (options.concurrency ?? 3)`, and the queue is non-empty. Resolve a destination with `exists` plus the coordinator's reserved set before starting the async transfer. Add the destination to reservations before the transfer; always remove the reservation in `finally`. Maintain separate resolver sets for `waitForActive()` and `waitForIdle()`: settle active resolvers whenever `active === 0`, and settle idle resolvers only when both `active === 0` and the pending queue is empty.

Implement each transfer with this behavior:

```ts
this.emit({ key: task.key, status: 'downloading', progress: 0 })
try {
  this.mkdir(dirname(destination))
  await client.downloadMessageMedia({
    ...attachmentDownloadTarget(task.attachment),
    destination,
    onProgress: (downloaded, total) => this.emit({
      key: task.key,
      status: 'downloading',
      progress: Number.isFinite(total) && total > 0
        ? Math.round(downloaded / total * 100)
        : null,
    }),
  })
  this.emit({ key: task.key, status: 'completed', path: destination })
} catch (error) {
  try {
    this.remove(destination)
  } catch {}
  this.emit({ key: task.key, status: 'failed', error: messageFromError(error) })
} finally {
  this.reserved.delete(destination)
  this.active -= 1
  this.pump()
  this.settleIdle()
}
```

Default dependencies are `homedir()`, `existsSync`, `path => mkdirSync(path, { recursive: true })`, and `path => rmSync(path, { force: true })`.

- [ ] **Step 7: Run coordinator tests and typecheck**

Run: `pnpm test -- tests/services/auto-download-coordinator.test.ts tests/services/attachment-download.test.ts && pnpm typecheck`

Expected: PASS; TypeScript reports no errors.

- [ ] **Step 8: Commit the coordinator**

```bash
git add src/services/auto-download-coordinator.ts src/services/attachment-download.ts tests/services/auto-download-coordinator.test.ts tests/services/attachment-download.test.ts
git commit -m "feat(listen): add automatic download queue"
```

### Task 3: Wire automatic downloads into plain-text listen

**Files:**
- Modify: `src/commands/telegram.ts`
- Modify: `tests/commands/telegram-listen.test.ts`

- [ ] **Step 1: Extend the command fake and write failing CLI tests**

Add `downloadMessageMedia` to the hoisted client in `tests/commands/telegram-listen.test.ts`:

```ts
downloadMessageMedia: vi.fn(async () => undefined),
```

Mock the home directory at the top of the test so integration tests never create files under the developer's real home:

```ts
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => process.env.DATA_DIR ?? actual.homedir() }
})
```

Clear the fake download method in `beforeEach`. Add tests:

```ts
it('passes auto-download into interactive mode', async () => {
  // Set stdin/stdout isTTY=true using the existing descriptor pattern.
  await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--auto-download'])
  expect(renderInteractiveListen).toHaveBeenCalledWith(expect.objectContaining({ autoDownload: true }))
})

it('auto-downloads in plain mode even when media summaries are hidden', async () => {
  const writes: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'listen', '--no-interactive', '--no-media', '--auto-download',
    ])
  } finally {
    write.mockRestore()
  }

  expect(client.downloadMessageMedia).toHaveBeenCalledOnce()
  expect(client.downloadMessageMedia).toHaveBeenCalledWith(expect.objectContaining({ chat: 100, msgId: 1 }))
  expect(writes.join('')).not.toContain('📎 Photo')
  expect(writes.join('')).toContain('downloaded:')
})

it('prints a failure and completes listening when one download fails', async () => {
  client.downloadMessageMedia.mockRejectedValueOnce(new Error('network failed'))
  const writes: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'listen', '--auto-download'])
  } finally {
    write.mockRestore()
  }
  expect(writes.join('')).toContain('download failed: 100:1: network failed')
  expect(writes.join('')).toContain('listening completed')
})
```

Also add an album test that emits message IDs 11 and 12 and expects two calls with those IDs. Because attachment jobs are submitted before display aggregation, no fake-timer delay is required for downloading.

- [ ] **Step 2: Run the command tests and verify the option is unknown**

Run: `pnpm test -- tests/commands/telegram-listen.test.ts`

Expected: FAIL because `--auto-download` is unknown and no downloads occur.

- [ ] **Step 3: Add the flag and plain-mode coordinator wiring**

Update `ListenOptions` and the command declaration in `src/commands/telegram.ts`:

```ts
type ListenOptions = MachineOptions & {
  autoDownload?: boolean
  persist?: boolean
  retrySeconds?: string
  sendTo?: string
  media?: boolean
  interactive?: boolean
}

.option('--auto-download', 'Download incoming attachments automatically')
```

Import `AutoDownloadCoordinator`. Compute `const autoDownload = Boolean(options.autoDownload)` and pass it to `renderInteractiveListen`.

For plain mode, create one coordinator outside the reconnect loop only when enabled:

```ts
const autoDownloader = autoDownload
  ? new AutoDownloadCoordinator({
      onEvent: (event) => {
        if (event.status === 'completed') process.stdout.write(`downloaded: ${event.path}\n`)
        if (event.status === 'failed') {
          const [chatId, messageId] = event.key.split(':')
          process.stdout.write(`download failed: ${chatId}:${messageId}: ${event.error}\n`)
        }
      },
    })
  : null
```

After the existing message dedupe succeeds, call `autoDownloader?.enqueue(message)` before `albumAggregator.add(message)`. At the start of each reconnect iteration call `autoDownloader?.setClient(client)`.

Handle the client result explicitly before closing it:

```ts
if (controller.signal.aborted) {
  autoDownloader?.stop()
} else if (retry) {
  autoDownloader?.setClient(null)
  await autoDownloader?.waitForActive()
} else {
  await autoDownloader?.waitForIdle()
  autoDownloader?.setClient(null)
}
await client.close().catch(() => undefined)
```

Thus a disconnect preserves pending work for the replacement client, a normal listener completion finishes attachments already received, and `Ctrl+C` cancels queued work without draining it. Call `autoDownloader?.stop()` again in the command's outer cleanup; `stop()` must be idempotent.

Do not gate enqueueing on `showMedia`; that preserves `--no-media` independence.

- [ ] **Step 4: Run command tests**

Run: `pnpm test -- tests/commands/telegram-listen.test.ts`

Expected: PASS, including existing output deduplication and reconnect tests.

- [ ] **Step 5: Commit plain-mode integration**

```bash
git add src/commands/telegram.ts tests/commands/telegram-listen.test.ts
git commit -m "feat(listen): auto-download in plain mode"
```

### Task 4: Wire the coordinator into interactive listen

**Files:**
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write failing queued-state and automatic-event tests**

Extend `AttachmentDownloadState` expectations in `tests/presenters/ink-listen.test.tsx`:

```tsx
it('shows an automatic download waiting in the queue', () => {
  const output = renderToString(
    <ListenAttachmentLine label="📎 Photo" selected={false} state={{ status: 'queued' }} />,
  )
  expect(output).toContain('Queued')
})
```

Export a pure state reducer from the Ink module and test it:

```ts
it('maps coordinator events onto attachment display state', () => {
  const queued = applyAutoDownloadEvent({}, { key: '100:1:0', status: 'queued' })
  const completed = applyAutoDownloadEvent(queued, {
    key: '100:1:0',
    status: 'completed',
    path: '/tmp/photo.jpg',
  })

  expect(queued['100:1:0']).toEqual({ status: 'queued' })
  expect(completed['100:1:0']).toEqual({ status: 'completed', path: '/tmp/photo.jpg' })
})
```

- [ ] **Step 2: Run the Ink tests and verify queued state is unsupported**

Run: `pnpm test -- tests/presenters/ink-listen.test.tsx`

Expected: FAIL because `queued` and `applyAutoDownloadEvent` do not exist.

- [ ] **Step 3: Add interactive state mapping**

Update the state union and attachment line:

```ts
export type AttachmentDownloadState =
  | { status: 'idle' }
  | { status: 'queued' }
  | { status: 'downloading'; progress: number | null }
  | { status: 'completed'; path: string }
  | { status: 'failed'; error: string }

export function applyAutoDownloadEvent(
  current: Record<string, AttachmentDownloadState>,
  event: AutoDownloadEvent,
): Record<string, AttachmentDownloadState> {
  if (event.status === 'cancelled') return current
  return { ...current, [event.key]: event }
}
```

Render `queued` as `Queued` between idle and downloading branches.

- [ ] **Step 4: Connect one coordinator to the interactive listener lifecycle**

Add `autoDownload: boolean` to `ListenRuntimeOptions` and destructure it in `InteractiveListen`. Add a coordinator ref initialized only when enabled:

```ts
const autoDownloaderRef = useRef<AutoDownloadCoordinator | null>(null)
if (autoDownload && autoDownloaderRef.current == null) {
  autoDownloaderRef.current = new AutoDownloadCoordinator({
    onEvent: (event) => setDownloadStates((current) => applyAutoDownloadEvent(current, event)),
  })
}
```

In the listen loop, call `autoDownloaderRef.current?.setClient(client)` after client creation. After event deduplication and before album aggregation, call `autoDownloaderRef.current?.enqueue(message)`. Use the same three-way lifecycle as plain mode: on disconnect, set the client to `null` and await `waitForActive()`; on a normal stop result, await `waitForIdle()` before clearing the client; on abort, call `stop()` and close immediately. In effect cleanup and `stopListening`, call the idempotent `stop()` and clear the client.

Change manual `downloadAttachment` to return immediately when its current state is `queued`, `downloading`, or `completed`:

```ts
const existing = downloadStates[item.key]
if (existing != null && existing.status !== 'idle' && existing.status !== 'failed') return
```

Keep manual downloads available when automatic mode is off and allow a user to retry a failed task manually.

- [ ] **Step 5: Run interactive tests and command wiring tests**

Run: `pnpm test -- tests/presenters/ink-listen.test.tsx tests/commands/telegram-listen.test.ts`

Expected: PASS. Existing manual download rendering, selection, previews, scrolling, and shutdown tests remain green.

- [ ] **Step 6: Commit interactive integration**

```bash
git add src/presenters/ink/listen.tsx tests/presenters/ink-listen.test.tsx
git commit -m "feat(listen): auto-download in interactive mode"
```

### Task 5: Document and verify the complete feature

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Update English usage documentation**

Add the option near the existing listen examples in `README.md`:

```text
tg listen <chat-or-id> --auto-download
tg listen --no-interactive --auto-download --no-media
```

State that downloads go to `~/Downloads/telegram-cli`, at most three run concurrently, failures are reported without ending the listener, and `--no-media` hides summaries but does not disable automatic downloads.

- [ ] **Step 2: Update Chinese usage documentation**

Add equivalent examples and behavior to `README.zh-CN.md`:

```text
tg listen <聊天名称或ID> --auto-download
tg listen --no-interactive --auto-download --no-media
```

Describe the fixed save directory, concurrency of three, non-fatal failures, and independence from `--no-media`.

- [ ] **Step 3: Run the focused feature suite**

Run:

```bash
pnpm test -- \
  tests/services/listen-attachment.test.ts \
  tests/services/attachment-download.test.ts \
  tests/services/auto-download-coordinator.test.ts \
  tests/presenters/listen-message.test.ts \
  tests/presenters/ink-listen.test.tsx \
  tests/commands/telegram-listen.test.ts
```

Expected: all listed Vitest files PASS.

- [ ] **Step 4: Run full repository verification**

Run: `pnpm test && pnpm typecheck`

Expected: the complete Vitest suite passes and TypeScript exits with code 0.

- [ ] **Step 5: Inspect help output**

Run: `pnpm dev -- listen --help`

Expected: output contains `--auto-download` with the description `Download incoming attachments automatically` and retains all existing listen options.

- [ ] **Step 6: Review the final diff for scope and secrets**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the files listed by this plan are modified or newly created; no `.env`, session, SQLite, credential, or downloaded attachment files appear.

- [ ] **Step 7: Commit documentation and verification state**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: describe listen automatic downloads"
```
