# Listen Auto-download Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show `Auto-download enabled` below the status line in interactive listen mode when automatic downloading is enabled.

**Architecture:** Keep the behavior inside the existing Ink presenter because `InteractiveListen` already receives the `autoDownload` flag and owns the status area. Add one conditional, dimmed `Text` element and cover both enabled and disabled rendering through the existing presenter test suite.

**Tech Stack:** TypeScript, React, Ink, Vitest

---

### Task 1: Render the auto-download reminder

**Files:**
- Modify: `src/presenters/ink/listen.tsx`
- Test: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write the failing rendering test**

Export a small status-area component and add a test that renders it in both modes:

```tsx
it('shows the auto-download reminder only when enabled', () => {
  expect(renderToString(<ListenStatusArea status="connected" unseenCount={0} autoDownload />))
    .toContain('Auto-download enabled')
  expect(renderToString(<ListenStatusArea status="connected" unseenCount={0} autoDownload={false} />))
    .not.toContain('Auto-download enabled')
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm test -- tests/presenters/ink-listen.test.tsx`

Expected: FAIL because `ListenStatusArea` is not yet exported or implemented.

- [ ] **Step 3: Implement the minimal status-area component**

Add this component beside `ListenStatus`:

```tsx
export function ListenStatusArea({ status, unseenCount, autoDownload }: {
  status: string
  unseenCount: number
  autoDownload: boolean
}): React.JSX.Element {
  return (
    <>
      <ListenStatus status={status} unseenCount={unseenCount} />
      {autoDownload ? <Text dimColor>Auto-download enabled</Text> : null}
    </>
  )
}
```

Replace the current `ListenStatus` usage in `InteractiveListen` with `ListenStatusArea`:

```tsx
<ListenStatusArea
  status={status}
  unseenCount={scrollState.unseenCount}
  autoDownload={autoDownload}
/>
```

- [ ] **Step 4: Run focused and full verification**

Run: `pnpm test -- tests/presenters/ink-listen.test.tsx`

Expected: the focused suite passes.

Run: `pnpm test && pnpm typecheck`

Expected: all Vitest tests pass and TypeScript exits without errors.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/presenters/ink/listen.tsx tests/presenters/ink-listen.test.tsx docs/plans/2026-07-13-listen-auto-download-reminder.md
git commit -m "feat: show listen auto-download reminder"
```
