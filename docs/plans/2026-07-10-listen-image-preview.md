# Listen Image Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Telegram's embedded stripped photo thumbnail as a compact color preview in the interactive Ink `listen` interface without downloading the original image.

**Architecture:** The mtcute adapter extracts complete JPEG bytes from `Photo.thumbnails` and attaches them to the live message as optional base64 preview data. A presenter-only decoder scales the JPEG and represents two vertical pixels with one terminal half-block; the Ink component supplies true-color foreground/background colors and includes preview rows in viewport sizing. Missing or malformed thumbnails fall back to the existing attachment line.

**Tech Stack:** TypeScript, mtcute 0.30, React 19, Ink 6, Vitest 4, `jpeg-js`

---

## File map

- Modify `package.json` and `pnpm-lock.yaml`: add the pure-JavaScript `jpeg-js` decoder.
- Modify `src/storage/message-db.ts`: define the optional transient JPEG preview contract and explicitly omit it from SQLite bindings.
- Modify `src/telegram/mtcute-client.ts`: extract mtcute's embedded stripped thumbnail without network access.
- Modify `src/presenters/listen-message.ts`: associate the preview with the matching photo attachment.
- Create `src/presenters/ink/image-preview.ts`: decode, scale, and convert JPEG pixels into terminal half-block cells.
- Modify `src/presenters/ink/listen.tsx`: render colored preview rows only in capable interactive terminals.
- Modify `src/presenters/ink/listen-scroll.ts`: count thumbnail rows when choosing complete messages for the viewport.
- Create `tests/presenters/image-preview.test.ts`: unit-test image decoding, scaling, and invalid payload fallback.
- Modify `tests/presenters/listen-message.test.ts`, `tests/presenters/ink-listen.test.tsx`, and `tests/presenters/listen-scrollbar.test.tsx`: cover preview propagation, Ink output, and viewport height.
- Create `tests/telegram/mtcute-thumbnail.test.ts`: cover extraction from mtcute-compatible photo thumbnail shapes through an exported narrow helper.

### Task 1: Add and isolate the image decoder

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/presenters/ink/image-preview.ts`
- Create: `tests/presenters/image-preview.test.ts`

- [ ] **Step 1: Add the pure-JavaScript JPEG dependency**

Run:

```bash
pnpm add jpeg-js
```

Expected: `jpeg-js` appears in `dependencies`, and the lockfile records the resolved package without native build dependencies.

- [ ] **Step 2: Write a failing decoder test**

Create a small known 2×2 JPEG fixture in the test as base64 and assert the public shape, rather than exact lossy JPEG channel values:

```ts
import { describe, expect, it } from 'vitest'
import { decodeImagePreview } from '../../src/presenters/ink/image-preview.js'

describe('decodeImagePreview', () => {
  it('turns two vertical image pixels into one terminal half-block row', () => {
    const preview = decodeImagePreview(KNOWN_2_BY_2_JPEG_BASE64, 2)

    expect(preview).not.toBeNull()
    expect(preview?.width).toBe(2)
    expect(preview?.rows).toHaveLength(1)
    expect(preview?.rows[0]).toHaveLength(2)
    expect(preview?.rows[0]?.[0]).toMatchObject({ glyph: '▀' })
    expect(preview?.rows[0]?.[0]?.foreground).toMatch(/^#[0-9a-f]{6}$/)
    expect(preview?.rows[0]?.[0]?.background).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('returns null for malformed JPEG data', () => {
    expect(decodeImagePreview('not-base64-jpeg', 8)).toBeNull()
  })
})
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm test -- tests/presenters/image-preview.test.ts
```

Expected: FAIL because `src/presenters/ink/image-preview.ts` does not exist.

- [ ] **Step 4: Implement the minimal decoder and scaler**

Create these public types and function:

```ts
import jpeg from 'jpeg-js'

export type PreviewCell = {
  glyph: '▀'
  foreground: string
  background: string
}

export type DecodedImagePreview = {
  width: number
  rows: PreviewCell[][]
}

export function decodeImagePreview(base64: string, maxWidth: number): DecodedImagePreview | null
```

Implementation requirements:

- Reject empty input and `maxWidth < 1`.
- Decode with `jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: true })` inside `try/catch`.
- Scale down only, preserving aspect ratio, with nearest-neighbor source coordinates.
- Round target height to at least one pixel.
- For odd image heights, reuse the final source row as the lower pixel.
- Convert RGB triples to lowercase `#rrggbb` strings.
- Return one `PreviewCell` per target column and one row per two target pixel rows.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm test -- tests/presenters/image-preview.test.ts
```

Expected: PASS with both tests green.

- [ ] **Step 6: Commit the decoder unit**

```bash
git add package.json pnpm-lock.yaml src/presenters/ink/image-preview.ts tests/presenters/image-preview.test.ts
git commit -m "feat: decode terminal image previews"
```

### Task 2: Extract mtcute's embedded thumbnail

**Files:**
- Modify: `src/storage/message-db.ts`
- Modify: `src/telegram/mtcute-client.ts`
- Create: `tests/telegram/mtcute-thumbnail.test.ts`
- Modify: `tests/storage/message-db.test.ts`

- [ ] **Step 1: Write failing thumbnail extraction tests**

Export a narrow helper for direct testing and describe its required contract:

```ts
import { describe, expect, it } from 'vitest'
import { embeddedPhotoPreviewBase64 } from '../../src/telegram/mtcute-client.js'

describe('embeddedPhotoPreviewBase64', () => {
  it('returns complete embedded JPEG bytes as base64', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
    const media = {
      type: 'photo',
      thumbnails: [{ type: 'i', location: jpeg }],
    }

    expect(embeddedPhotoPreviewBase64(media)).toBe(Buffer.from(jpeg).toString('base64'))
  })

  it('does not use a remote thumbnail location', () => {
    const media = {
      type: 'photo',
      thumbnails: [{ type: 'i', location: { _: 'inputPhotoFileLocation' } }],
    }

    expect(embeddedPhotoPreviewBase64(media)).toBeUndefined()
  })
})
```

Add a storage regression test that inserts a message containing `preview_jpeg_base64` and confirms insertion succeeds while the fetched database row has no preview column.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm test -- tests/telegram/mtcute-thumbnail.test.ts tests/storage/message-db.test.ts
```

Expected: FAIL because the helper and preview property do not exist, or because the transient property reaches the SQLite named binding.

- [ ] **Step 3: Add the transient message field**

Extend `StoredMessageInput`:

```ts
export type StoredMessageInput = Omit<StoredMessage, 'id' | 'raw_json'> & {
  raw_json?: unknown
  preview_jpeg_base64?: string
}
```

In `insertPrepared`, omit the transient property before binding:

```ts
const { preview_jpeg_base64: _preview, ...persisted } = row
return stmt.run({
  ...persisted,
  chat_id: canonicalChatId(row.chat_id),
  raw_json: row.raw_json == null ? null : JSON.stringify(row.raw_json),
}).changes
```

- [ ] **Step 4: Implement local-only mtcute extraction**

Import `Photo` and `Thumbnail` from `@mtcute/node`. Implement:

```ts
type PhotoMediaShape = {
  type?: string
  thumbnails?: ReadonlyArray<{ type?: string; location?: unknown }>
}

export function embeddedPhotoPreviewBase64(media: unknown): string | undefined {
  if (!(media instanceof Photo) && !isPhotoMediaShape(media)) return undefined
  const thumbnail = media.thumbnails.find((item) => item.type === Thumbnail.THUMB_STRIP)
  if (!(thumbnail?.location instanceof Uint8Array)) return undefined
  return Buffer.from(thumbnail.location).toString('base64')
}
```

The structural test seam must still require `type === 'photo'`; production uses the real `Photo` and `Thumbnail` exports. Update `toStoredMessage` to set:

```ts
preview_jpeg_base64: embeddedPhotoPreviewBase64(message.media),
```

Do not call `downloadAsBuffer`, because an unexpected remote location would violate the no-network guarantee.

- [ ] **Step 5: Run extraction and storage tests and verify GREEN**

Run:

```bash
pnpm test -- tests/telegram/mtcute-thumbnail.test.ts tests/storage/message-db.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the adapter contract**

```bash
git add src/storage/message-db.ts src/telegram/mtcute-client.ts tests/telegram/mtcute-thumbnail.test.ts tests/storage/message-db.test.ts
git commit -m "feat: extract embedded Telegram previews"
```

### Task 3: Associate previews with photo attachments

**Files:**
- Modify: `src/presenters/listen-message.ts`
- Modify: `tests/presenters/listen-message.test.ts`

- [ ] **Step 1: Write failing presenter tests**

Extend the photo fixture with `preview_jpeg_base64: 'jpeg-preview'`, then assert:

```ts
expect(buildListenMessage(mediaMessage(), { showMedia: true }).media[0]).toMatchObject({
  kind: 'Photo',
  previewJpegBase64: 'jpeg-preview',
})

expect(buildListenMessage(mediaMessage(), { showMedia: false }).media).toEqual([])
```

For an album with two photo messages, give each a different preview and assert the two attachments retain their respective values in message order.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test -- tests/presenters/listen-message.test.ts
```

Expected: FAIL because `ListenAttachment` has no `previewJpegBase64`.

- [ ] **Step 3: Propagate the preview explicitly**

Add:

```ts
export type ListenAttachment = {
  // existing fields
  previewJpegBase64?: string
}
```

When mapping `extractMediaLabels(item.raw_json)`, assign `item.preview_jpeg_base64` only to the first `Photo` attachment produced for that message. Do not read binary data back from `raw_json`, and do not attach a photo preview to documents or videos.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm test -- tests/presenters/listen-message.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit preview propagation**

```bash
git add src/presenters/listen-message.ts tests/presenters/listen-message.test.ts
git commit -m "feat: attach previews to listen photos"
```

### Task 4: Render preview cells in Ink

**Files:**
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write failing Ink component tests**

Export a focused component and test it independently of terminal capability detection:

```tsx
import { ListenImagePreview } from '../../src/presenters/ink/listen.js'

it('renders upper and lower pixels as a half block', () => {
  const output = renderToString(
    <ListenImagePreview rows={[[{
      glyph: '▀',
      foreground: '#ff0000',
      background: '#0000ff',
    }]]} />,
  )

  expect(output).toContain('▀')
})
```

Add an integration assertion that a photo attachment with preview data renders the existing download line followed by a preview row when `colorDepth={24}` is passed to a small exported attachment-with-preview component. Assert `colorDepth={8}` retains the attachment line and omits `▀`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test -- tests/presenters/ink-listen.test.tsx
```

Expected: FAIL because `ListenImagePreview` and the preview-aware attachment component do not exist.

- [ ] **Step 3: Implement preview-aware Ink components**

Implement `ListenImagePreview` with nested Ink `<Text>` nodes:

```tsx
export function ListenImagePreview({ rows }: { rows: PreviewCell[][] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex}>
          {'  '}
          {row.map((cell, columnIndex) => (
            <Text key={columnIndex} color={cell.foreground} backgroundColor={cell.background}>
              {cell.glyph}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}
```

Create a preview-aware attachment component that:

- always renders `ListenAttachmentLine`;
- calls `decodeImagePreview` only when `colorDepth >= 24` and preview data exists;
- caps image width at `Math.max(1, Math.min(24, contentWidth - 2))`;
- renders no preview when decoding returns `null`;
- memoizes decoding by base64 and width with `useMemo`.

In `InteractiveListen`, obtain color depth with `stdout?.getColorDepth?.() ?? 1` and replace the direct attachment line with the preview-aware component. This keeps terminal detection in Ink and leaves plain output untouched.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm test -- tests/presenters/ink-listen.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Ink rendering**

```bash
git add src/presenters/ink/listen.tsx tests/presenters/ink-listen.test.tsx
git commit -m "feat: render image previews in Ink listen"
```

### Task 5: Make viewport sizing preview-aware

**Files:**
- Modify: `src/presenters/ink/image-preview.ts`
- Modify: `src/presenters/listen-message.ts`
- Modify: `src/presenters/ink/listen-scroll.ts`
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `tests/presenters/ink-listen.test.tsx`
- Modify: `tests/presenters/listen-scrollbar.test.tsx`

- [ ] **Step 1: Write a failing viewport regression test**

Add an optional `previewRows` count to the test message and prove a preview-bearing message consumes its full height:

```ts
const withPreview = {
  ...message('photo', 2),
  media: [{
    chatId: 1,
    messageId: 1,
    kind: 'Photo',
    label: '📎 Photo',
    fileName: null,
    downloadable: true,
    previewRows: 3,
  }],
}

expect(takeListenViewport([message('old', 2), withPreview], 6, 0))
  .toEqual([withPreview])
```

Expected height is two structural rows plus one attachment row plus three preview rows.

- [ ] **Step 2: Run the viewport tests and verify RED**

Run:

```bash
pnpm test -- tests/presenters/ink-listen.test.tsx tests/presenters/listen-scrollbar.test.tsx
```

Expected: FAIL because viewport sizing ignores preview rows.

- [ ] **Step 3: Calculate preview dimensions once**

Avoid decoding the same JPEG separately for sizing and rendering. During `toListenMessage`, accept rendering context `{ showMedia, previewWidth, colorDepth }`, decode each eligible preview once, and store both `previewRows` and the decoded `previewCells` on the transient `ListenAttachment` view model. Keep `buildListenMessage` defaults preview-free so plain formatting remains unchanged.

Update `messageLines` to use:

```ts
return 2
  + (message.content == null ? 0 : 1)
  + message.media.reduce((lines, item) => lines + 1 + (item.previewRows ?? 0), 0)
```

Update the Ink attachment component to consume `previewCells` rather than decoding again. Recalculate message view models when terminal content width or color depth changes so resize behavior remains correct.

- [ ] **Step 4: Run the viewport and Ink tests and verify GREEN**

Run:

```bash
pnpm test -- tests/presenters/ink-listen.test.tsx tests/presenters/listen-scrollbar.test.tsx
```

Expected: PASS, including complete-message viewport selection.

- [ ] **Step 5: Confirm plain output remains text-only**

Run:

```bash
pnpm test -- tests/commands/telegram-listen.test.ts
```

Expected: PASS with existing `📎 Photo` output and no block-pixel rows.

- [ ] **Step 6: Commit viewport integration**

```bash
git add src/presenters/ink/image-preview.ts src/presenters/listen-message.ts src/presenters/ink/listen-scroll.ts src/presenters/ink/listen.tsx tests/presenters/ink-listen.test.tsx tests/presenters/listen-scrollbar.test.tsx
git commit -m "fix: account for listen preview height"
```

### Task 6: Full verification and documentation check

**Files:**
- Modify if necessary: `README.md`
- Modify if necessary: `README.zh-CN.md`

- [ ] **Step 1: Review CLI documentation scope**

The feature adds no flag and changes only capable interactive terminals. If the current listen documentation describes attachment display, add one sentence stating that embedded photo previews appear in true-color interactive terminals without downloading the original. Preserve the user's unrelated README edits and stage only the lines belonging to this feature.

- [ ] **Step 2: Run formatting and diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended feature files plus the user's pre-existing unrelated changes are present.

- [ ] **Step 3: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all Vitest files and tests pass with zero failures.

- [ ] **Step 4: Run strict TypeScript validation**

Run:

```bash
pnpm typecheck
```

Expected: exit code 0 and no diagnostics.

- [ ] **Step 5: Build the distributable CLI**

Run:

```bash
pnpm build
```

Expected: exit code 0 and generated `dist` output includes the preview presenter.

- [ ] **Step 6: Commit final documentation or cleanup, if any**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: describe listen image previews"
```

Skip this commit when no feature-specific documentation change is necessary. Do not stage unrelated existing README hunks.
