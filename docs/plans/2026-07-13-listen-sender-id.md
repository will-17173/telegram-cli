# Listen Sender ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display a sender's Telegram ID in parentheses after their name in interactive listen message headers.

**Architecture:** Extend the existing presentation-only `ListenMessageRow` with a nullable `senderId`, populated by `buildListenMessage`. Add a pure interactive header formatter in the Ink presenter and use it at the current header render site, leaving `formatListenLine` unchanged.

**Tech Stack:** TypeScript, React, Ink, Vitest

---

### Task 1: Carry sender IDs into listen presentation rows

**Files:**
- Modify: `src/presenters/listen-message.ts`
- Test: `tests/presenters/listen-message.test.ts`

- [ ] **Step 1: Write failing row-mapping tests**

Add assertions showing that `buildListenMessage` preserves a numeric sender ID and returns `null` when the source ID is absent:

```ts
expect(buildListenMessage(mediaMessage()).senderId).toBe(1)
expect(buildListenMessage({ ...mediaMessage(), sender_id: null }).senderId).toBeNull()
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test -- tests/presenters/listen-message.test.ts`

Expected: FAIL because `ListenMessageRow` does not yet expose `senderId`.

- [ ] **Step 3: Add the presentation field and mapping**

Update the row type and builder:

```ts
export type ListenMessageRow = {
  time: string
  sender: string
  senderId: number | null
  chatName?: string
  content: string | null
  media: ListenAttachment[]
}
```

```ts
return {
  time: formatListenTimestamp(message.timestamp),
  sender: message.sender_name ?? (message.sender_id == null ? 'Unknown' : String(message.sender_id)),
  senderId: message.sender_id,
  // existing fields unchanged
}
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm test -- tests/presenters/listen-message.test.ts`

Expected: all tests in the file pass.

- [ ] **Step 5: Commit the row mapping**

```bash
git add src/presenters/listen-message.ts tests/presenters/listen-message.test.ts
git commit -m "feat: preserve sender id in listen rows"
```

### Task 2: Render sender IDs in interactive headers

**Files:**
- Modify: `src/presenters/ink/listen.tsx`
- Test: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write failing formatter tests**

Export and test a pure formatter for single-chat, multi-chat, and missing-ID rows:

```ts
expect(formatInteractiveListenSender({ sender: 'Alice', senderId: 123 }))
  .toBe('Alice (123)')
expect(formatInteractiveListenSender({ sender: 'Alice', senderId: 123, chatName: 'News' }))
  .toBe('News | Alice (123)')
expect(formatInteractiveListenSender({ sender: 'Alice', senderId: null }))
  .toBe('Alice')
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test -- tests/presenters/ink-listen.test.tsx`

Expected: FAIL because `formatInteractiveListenSender` is not implemented.

- [ ] **Step 3: Implement and use the formatter**

Add the pure helper:

```ts
export function formatInteractiveListenSender(
  message: Pick<ListenMessageRow, 'sender' | 'senderId' | 'chatName'>,
): string {
  const sender = message.senderId == null ? message.sender : `${message.sender} (${message.senderId})`
  return message.chatName == null ? sender : `${message.chatName} | ${sender}`
}
```

Replace the current inline sender expression in the interactive header:

```tsx
<Text dimColor wrap="truncate-end">[{message.time}] {formatInteractiveListenSender(message)}</Text>
```

Update test-only `ListenMessageRow` fixtures with `senderId: null` so their existing behavior remains explicit.

- [ ] **Step 4: Run focused and full verification**

Run: `pnpm test -- tests/presenters/ink-listen.test.tsx tests/presenters/listen-message.test.ts`

Expected: both focused test files pass.

Run: `pnpm test && pnpm typecheck`

Expected: all Vitest tests pass and TypeScript exits without errors.

- [ ] **Step 5: Commit the interactive rendering**

```bash
git add src/presenters/ink/listen.tsx tests/presenters/ink-listen.test.tsx docs/plans/2026-07-13-listen-sender-id.md
git commit -m "feat: show sender id in listen headers"
```
