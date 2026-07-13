# Send Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `tg send` to send text, one attachment, or an ordered Telegram media group with an optional caption.

**Architecture:** Commander parses an optional message and repeatable file paths, while `MessageService` validates the complete request before choosing text or media delivery. The Telegram adapter exposes a typed `sendMedia` boundary; its mtcute implementation selects single versus grouped sending and constructs photo, video, or document inputs explicitly.

**Tech Stack:** TypeScript, Commander, mtcute 0.30, Node filesystem APIs, Vitest

---

## File Structure

- Modify `src/telegram/types.ts`: define the media-send adapter request and response.
- Modify `src/telegram/fake-client.ts`: record deterministic media sends for service and CLI tests.
- Modify `src/services/message-service.ts`: validate text/files and select text or media sending.
- Create `tests/fixtures/send-files.ts`: create reusable temporary readable attachment files.
- Modify `tests/services/message-service.test.ts`: cover service routing, validation, and result contracts.
- Modify `src/telegram/mtcute-client.ts`: map local paths to mtcute media and send one item or a group.
- Create `tests/telegram/mtcute-send-media.test.ts`: verify mtcute method selection, media classification, captions, replies, and result mapping.
- Modify `src/commands/telegram.ts`: parse `[message]` and repeatable `--file` options.
- Modify `tests/commands/telegram-lifecycle.test.ts`: verify command parsing and canonical output wiring.
- Modify `tests/cli/help.test.ts`: verify the documented optional message and file flag.
- Modify `README.md` and `README.zh-CN.md`: document attachment examples and constraints.

### Task 1: Add the Adapter Contract and Fake

**Files:**
- Modify: `src/telegram/types.ts`
- Modify: `src/telegram/fake-client.ts`
- Test: `tests/services/message-service.test.ts`

- [ ] **Step 1: Write the failing adapter-facing service test**

Add a test that creates two real temporary files and expresses the intended call contract:

```ts
it('sends ordered attachments with an optional caption and reply', async () => {
  const files = createSendFiles(['photo.jpg', 'clip.mp4'])
  const fake = new FakeTelegramClient()
  const service = new MessageService(fake)

  const result = await service.send({
    chat: 'TestGroup',
    message: 'Album caption',
    files,
    reply: 10,
    linkPreview: true,
  })

  expect(fake.sendMediaCalls).toEqual([{
    chat: 'TestGroup',
    files,
    caption: 'Album caption',
    reply: 10,
  }])
  expect(result).toMatchObject({
    ok: true,
    data: {
      sent: true,
      msg_id: 100,
      msg_ids: [100, 101],
      chat: 'TestGroup',
      files,
      reply_to: 10,
    },
  })
})
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `pnpm test tests/services/message-service.test.ts`

Expected: FAIL because `files` and `sendMediaCalls` are not part of the current interfaces.

- [ ] **Step 3: Add media request and response types**

Add to `src/telegram/types.ts`:

```ts
export type SendMediaOptions = {
  chat: string | number
  files: string[]
  caption?: string
  reply?: number
}

export type SendMediaResult = {
  messages: Array<{
    msg_id: number
    sent_message?: StoredMessageInput
  }>
}
```

Add this method to `TelegramClientAdapter`:

```ts
sendMedia(options: SendMediaOptions): Promise<SendMediaResult>
```

- [ ] **Step 4: Implement the deterministic fake**

Extend `FakeTelegramClientOptions` and `FakeTelegramClient`:

```ts
mediaSendFailures?: Record<string, Error>

readonly sendMediaCalls: SendMediaOptions[] = []

async sendMedia(options: SendMediaOptions): Promise<SendMediaResult> {
  this.sendMediaCalls.push({ ...options, files: [...options.files] })
  const failure = this.mediaSendFailures[String(options.chat)]
  if (failure) throw failure
  return {
    messages: options.files.map((_, index) => ({ msg_id: 100 + index })),
  }
}
```

Import `SendMediaOptions` and `SendMediaResult` from `./types.js`, initialize `mediaSendFailures` to `{}`, and use the same resolved-chat failure lookup pattern as `sendMessage`.

- [ ] **Step 5: Run typecheck to expose the remaining service work**

Run: `pnpm typecheck`

Expected: FAIL at `MessageService.send` because its input and implementation do not yet accept `files`.

- [ ] **Step 6: Inspect the adapter-boundary diff**

Run: `git diff --check -- src/telegram/types.ts src/telegram/fake-client.ts tests/services/message-service.test.ts`

Expected: no whitespace errors. Keep these changes uncommitted until Task 3 supplies the required production adapter implementation.

### Task 2: Validate and Route Send Requests

**Files:**
- Create: `tests/fixtures/send-files.ts`
- Modify: `tests/services/message-service.test.ts`
- Modify: `src/services/message-service.ts`

- [ ] **Step 1: Create a focused temporary-file fixture**

Add `tests/fixtures/send-files.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createSendFiles(names: string[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'tg-cli-send-'))
  return names.map((name) => {
    const path = join(directory, name)
    writeFileSync(path, name)
    return path
  })
}
```

- [ ] **Step 2: Add failing routing and validation tests**

Update text-only calls to pass `files: []`, then add separate tests for:

```ts
it('allows attachments without text', async () => {
  const [file] = createSendFiles(['document.pdf'])
  const fake = new FakeTelegramClient()
  const result = await new MessageService(fake).send({
    chat: 'TestGroup', message: undefined, files: [file], linkPreview: true,
  })

  expect(result).toMatchObject({ ok: true, data: { msg_ids: [100], files: [file] } })
  expect(fake.sendMessageCalls).toHaveLength(0)
  expect(fake.sendMediaCalls[0]).toEqual({ chat: 'TestGroup', files: [file] })
})

it('rejects an empty send before contacting Telegram', async () => {
  const fake = new FakeTelegramClient()
  const result = await new MessageService(fake).send({
    chat: 'TestGroup', message: '  ', files: [], linkPreview: true,
  })

  expect(result).toEqual({
    ok: false,
    error: { code: 'invalid_option', message: 'Provide a message or at least one file.' },
  })
  expect(fake.sendMessageCalls).toHaveLength(0)
  expect(fake.sendMediaCalls).toHaveLength(0)
})

it('validates every file before sending any attachment', async () => {
  const [valid] = createSendFiles(['valid.jpg'])
  const missing = `${valid}.missing`
  const fake = new FakeTelegramClient()
  const result = await new MessageService(fake).send({
    chat: 'TestGroup', message: 'caption', files: [valid, missing], linkPreview: true,
  })

  expect(result).toEqual({
    ok: false,
    error: { code: 'invalid_option', message: `File is not readable: ${missing}` },
  })
  expect(fake.sendMediaCalls).toHaveLength(0)
})
```

Also cover a directory path, a blank `--file` value at service level, and `mediaSendFailures` mapping to `telegram_error`.

- [ ] **Step 3: Run the service tests to verify RED**

Run: `pnpm test tests/services/message-service.test.ts`

Expected: FAIL because `SendOptions` has no files and validation does not inspect paths.

- [ ] **Step 4: Implement request validation and routing**

Change the service input and result types:

```ts
type SendOptions = {
  chat: string
  message?: string
  files: string[]
  reply?: number
  linkPreview: boolean
}

type SendResult = {
  sent: true
  msg_id: number
  msg_ids?: number[]
  chat: string
  files?: string[]
  reply_to?: number
}
```

Use `statSync` and `accessSync(path, constants.R_OK)` in a small `validateFile` helper. Catch filesystem errors and return `File is not readable: ${path}`; explicitly reject `!stat.isFile()` with `Path is not a file: ${path}`. Validate every path before calling either adapter method.

Route in `send`:

```ts
const message = options.message?.trim() ? options.message : undefined
if (options.files.length === 0) {
  const result = await this.tg.sendMessage({
    chat: options.chat,
    message: message!,
    reply: options.reply,
    linkPreview: options.linkPreview,
  })
  // Preserve the existing text-only data shape.
}

const result = await this.tg.sendMedia({
  chat: options.chat,
  files: options.files,
  caption: message,
  reply: options.reply,
})
const msgIds = result.messages.map((item) => item.msg_id)
// Return msg_id: msgIds[0], msg_ids: msgIds, files: [...options.files].
```

- [ ] **Step 5: Run the focused tests to verify GREEN**

Run: `pnpm test tests/services/message-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck and confirm the known adapter gap**

Run: `pnpm typecheck`

Expected: FAIL because `MtcuteTelegramClient` does not implement `sendMedia` and the Commander caller does not yet supply `files`; no filesystem type errors.

- [ ] **Step 7: Inspect the service diff**

Run: `git diff --check -- tests/fixtures/send-files.ts tests/services/message-service.test.ts src/services/message-service.ts`

Expected: no whitespace errors. Keep this dependent change with the adapter work until Task 3 makes the feature type-safe.

### Task 3: Implement mtcute Single and Grouped Media Sending

**Files:**
- Create: `tests/telegram/mtcute-send-media.test.ts`
- Modify: `src/telegram/mtcute-client.ts`

- [ ] **Step 1: Write failing single-media adapter tests**

Create a typed fake raw client, construct `MtcuteTelegramClient`, and assert:

```ts
it.each([
  ['photo.JPG', 'photo'],
  ['clip.mp4', 'video'],
  ['archive.zip', 'document'],
])('sends %s as %s', async (file, expectedType) => {
  const sendMedia = vi.fn().mockResolvedValue(message(51))
  const telegram = adapter({ sendMedia })

  const result = await telegram.sendMedia({
    chat: 'TestGroup', files: [`/tmp/${file}`], caption: 'caption', reply: 7,
  })

  expect(sendMedia).toHaveBeenCalledWith('TestGroup', expect.objectContaining({
    type: expectedType,
    file: `/tmp/${file}`,
  }), expect.objectContaining({ caption: 'caption', replyTo: 7 }))
  expect(result.messages.map((item) => item.msg_id)).toEqual([51])
})
```

The exact factory output assertion should match mtcute's runtime object keys observed from `InputMedia.photo`, `InputMedia.video`, and `InputMedia.document`; do not mock the factories.

- [ ] **Step 2: Write a failing media-group adapter test**

```ts
it('puts a group caption only on the first media item', async () => {
  const sendMediaGroup = vi.fn().mockResolvedValue([message(61), message(62)])
  const telegram = adapter({ sendMediaGroup })

  const result = await telegram.sendMedia({
    chat: 100,
    files: ['/tmp/a.jpg', '/tmp/b.mp4'],
    caption: 'group caption',
    reply: 9,
  })

  const [, media, params] = sendMediaGroup.mock.calls[0]
  expect(media[0]).toMatchObject({ caption: 'group caption' })
  expect(media[1].caption).toBeUndefined()
  expect(params).toMatchObject({ replyTo: 9 })
  expect(result.messages.map((item) => item.msg_id)).toEqual([61, 62])
})
```

- [ ] **Step 3: Run adapter tests to verify RED**

Run: `pnpm test tests/telegram/mtcute-send-media.test.ts`

Expected: FAIL because `MtcuteTelegramClient.sendMedia` is not implemented.

- [ ] **Step 4: Implement media construction and delivery**

Import `InputMedia` from `@mtcute/node` and add extension sets:

```ts
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])

function inputMedia(path: string, caption?: string) {
  const extension = extname(path).toLocaleLowerCase()
  const params = caption == null ? undefined : { caption }
  if (PHOTO_EXTENSIONS.has(extension)) return InputMedia.photo(path, params)
  if (VIDEO_EXTENSIONS.has(extension)) return InputMedia.video(path, params)
  return InputMedia.document(path, params)
}
```

Implement the adapter method:

```ts
async sendMedia(options: SendMediaOptions): Promise<SendMediaResult> {
  await this.ensureReady()
  if (options.files.length === 1) {
    const sent = await this.client.sendMedia(
      normalizeChatId(options.chat),
      inputMedia(options.files[0]!),
      { caption: options.caption, replyTo: options.reply },
    )
    return { messages: [{ msg_id: sent.id, sent_message: toStoredMessage(sent) }] }
  }

  const media = options.files.map((file, index) => inputMedia(
    file,
    index === 0 ? options.caption : undefined,
  ))
  const sent = await this.client.sendMediaGroup(
    normalizeChatId(options.chat),
    media,
    { replyTo: options.reply },
  )
  return {
    messages: sent.map((message) => ({
      msg_id: message.id,
      sent_message: toStoredMessage(message),
    })),
  }
}
```

If mtcute's single-send type rejects the duplicated caption parameter, keep the caption in the method parameters and omit it from `inputMedia` for the single-item branch.

- [ ] **Step 5: Run adapter and service tests to verify GREEN**

Run: `pnpm test tests/telegram/mtcute-send-media.test.ts tests/services/message-service.test.ts`

Expected: both test files PASS. The known Commander caller type error remains deferred to Task 4.

- [ ] **Step 6: Commit the complete service and adapter slice**

```bash
git add src/telegram/types.ts src/telegram/fake-client.ts src/services/message-service.ts src/telegram/mtcute-client.ts tests/fixtures/send-files.ts tests/services/message-service.test.ts tests/telegram/mtcute-send-media.test.ts
git commit -m "feat: send telegram media groups"
```

### Task 4: Expose Repeatable Files in the CLI

**Files:**
- Modify: `src/commands/telegram.ts`
- Modify: `tests/commands/telegram-lifecycle.test.ts`
- Modify: `tests/cli/help.test.ts`

- [ ] **Step 1: Add failing command parsing tests**

Add tests that run Commander with text plus two files and with files only:

```ts
it('forwards an optional message and repeated files to send', async () => {
  const files = createSendFiles(['photo.jpg', 'video.mp4'])
  await createApp().exitOverride().parseAsync([
    'node', 'tg', 'send', 'General', 'caption',
    '--file', files[0]!, '--file', files[1]!, '--json',
  ])

  expect(client.sendMedia).toHaveBeenCalledWith({
    chat: 'General', files, caption: 'caption', reply: undefined,
  })
})

it('allows send with files and no positional message', async () => {
  const [file] = createSendFiles(['photo.jpg'])
  await createApp().exitOverride().parseAsync([
    'node', 'tg', 'send', 'General', '--file', file!, '--json',
  ])

  expect(client.sendMedia).toHaveBeenCalledWith({
    chat: 'General', files: [file], caption: undefined, reply: undefined,
  })
})
```

Add a help assertion for `[message]` and `--file <path>`.

- [ ] **Step 2: Run command tests to verify RED**

Run: `pnpm test tests/commands/telegram-lifecycle.test.ts tests/cli/help.test.ts`

Expected: FAIL because `<message>` is required and `--file` is unknown.

- [ ] **Step 3: Implement optional message and repeatable option parsing**

Extend `SendFlags`:

```ts
type SendFlags = MachineOptions & {
  reply?: string
  preview: boolean
  file: string[]
}
```

Add a collector near the command helpers:

```ts
function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}
```

Change the command registration:

```ts
.argument('[message]')
.option('-f, --file <path>', 'Attachment path; repeat for multiple files', collect, [])
.action(async (chat: string, message: string | undefined, options: SendFlags) => {
  const reply = options.reply == null ? undefined : Number.parseInt(options.reply, 10)
  await renderMessageResult(options, 'Message sent', (service) => service.send({
    chat,
    message,
    files: options.file,
    reply,
    linkPreview: options.preview,
  }))
})
```

- [ ] **Step 4: Run command tests and typecheck to verify GREEN**

Run: `pnpm test tests/commands/telegram-lifecycle.test.ts tests/cli/help.test.ts && pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the CLI contract**

```bash
git add src/commands/telegram.ts tests/commands/telegram-lifecycle.test.ts tests/cli/help.test.ts
git commit -m "feat: add repeatable send file option"
```

### Task 5: Document and Verify the Feature

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add matching English and Chinese usage examples**

Document these commands in both READMEs:

```bash
tg send <chat> "Text only"
tg send <chat> --file ./photo.jpg --file ./video.mp4
tg send <chat> "Album caption" --file ./photo.jpg --file ./video.mp4
```

State that `--file` is repeatable, text is optional when files are present, and multiple files are sent as one Telegram media group.

- [ ] **Step 2: Run focused feature tests**

Run:

```bash
pnpm test tests/services/message-service.test.ts tests/telegram/mtcute-send-media.test.ts tests/commands/telegram-lifecycle.test.ts tests/cli/help.test.ts
```

Expected: all listed test files PASS.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
pnpm test && pnpm typecheck && pnpm build
```

Expected: Vitest reports zero failed tests, TypeScript exits 0, and the production build exits 0.

- [ ] **Step 4: Inspect the final diff and CLI help**

Run:

```bash
git diff --check
pnpm dev -- send TestGroup --help
```

Expected: no whitespace errors; help shows `<chat> [message]` and repeatable `--file <path>` without requiring a message.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: document attachment sending"
```
