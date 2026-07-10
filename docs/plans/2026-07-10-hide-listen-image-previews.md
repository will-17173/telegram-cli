# Hide Listen Image Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide embedded photo previews from the default interactive `listen` experience while preserving all preview infrastructure for later improvement.

**Architecture:** A private default-off feature constant controls the preview capability passed from `InteractiveListen` into the existing message view cache. The lower-level `toListenMessage` opt-in context remains unchanged and tested, while the default interactive composition supplies an ineligible color depth so it never decodes or reserves preview rows.

**Tech Stack:** TypeScript, React 19, Ink 6, Vitest 4

---

### Task 1: Disable previews in the default interactive path

**Files:**
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write the failing default-path regression test**

Add a small exported policy helper used by `InteractiveListen`, then test its composition with the existing view-model builder:

```ts
const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
const colorDepth = interactiveListenPreviewColorDepth(24)
const row = toListenMessage(
  [{ ...storedPhoto(99, ''), preview_jpeg_base64: twoByTwoJpeg }],
  { showMedia: true, previewWidth: 24, colorDepth, decodePreview },
)

expect(colorDepth).toBe(1)
expect(decodePreview).not.toHaveBeenCalled()
expect(row.media[0]?.previewRows).toBeUndefined()
expect(row.media[0]?.previewCells).toBeUndefined()
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run tests/presenters/ink-listen.test.tsx
```

Expected: FAIL because `interactiveListenPreviewColorDepth` does not exist and the current interactive path forwards true-color capability.

- [ ] **Step 3: Add the default-off internal policy**

Add the private feature constant and narrow test seam:

```ts
const LISTEN_IMAGE_PREVIEWS_ENABLED = false

export function interactiveListenPreviewColorDepth(terminalColorDepth: number): number {
  return LISTEN_IMAGE_PREVIEWS_ENABLED ? terminalColorDepth : 1
}
```

In `InteractiveListen`, keep the terminal metric for the rest of the UI but pass the policy result into `ListenMessageViewCache.build`:

```ts
const previewColorDepth = interactiveListenPreviewColorDepth(terminalMetrics.colorDepth)
```

Use `previewColorDepth` in the cache context and dependencies. Do not change the lower-level `toListenMessage` capability checks, decoder, renderer, mtcute adapter, storage, resize hook, or cache implementation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/presenters/ink-listen.test.tsx
```

Expected: PASS; default-policy regression proves no decode/cells, while explicit lower-level true-color tests still pass.

- [ ] **Step 5: Run plain listen regression tests**

Run:

```bash
pnpm exec vitest run tests/commands/telegram-listen.test.ts
```

Expected: PASS with existing text-only attachment output unchanged.

- [ ] **Step 6: Commit the behavior change**

```bash
git add src/presenters/ink/listen.tsx tests/presenters/ink-listen.test.tsx
git commit -m "fix: hide interactive listen image previews"
```

### Task 2: Remove the active-preview documentation claim

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Remove only the two preview claims**

Delete these lines and leave the surrounding listen/download documentation unchanged:

```text
Capable true-color interactive terminals show embedded photo previews without downloading the original.
支持真彩色的交互式终端会直接显示内嵌照片预览，无需下载原图。
```

- [ ] **Step 2: Verify documentation diff hygiene**

Run:

```bash
git diff --check
git diff -- README.md README.zh-CN.md
```

Expected: no whitespace errors and exactly one deletion from each README.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: remove listen image preview claim"
```

### Task 3: Full verification

**Files:**
- Verify only; no planned production changes.

- [ ] **Step 1: Run the complete test suite**

```bash
pnpm test
```

Expected: all Vitest tests pass with zero failures.

- [ ] **Step 2: Run strict TypeScript validation**

```bash
pnpm typecheck
```

Expected: exit code 0 with no diagnostics.

- [ ] **Step 3: Build the distributable CLI**

```bash
pnpm build
```

Expected: exit code 0.

- [ ] **Step 4: Verify the final worktree**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no uncommitted feature changes.
