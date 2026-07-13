# Sync History Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram history requests retrieve every page up to the requested limit so `sync-all` and `history` are not silently capped at 100 messages.

**Architecture:** Keep pagination inside `MtcuteTelegramClient`, where mtcute details are isolated. Replace the one-page `getHistory()` call with `iterHistory()`, retain the existing adapter contract, and rely on the existing `history` command plus SQLite deduplication to backfill databases affected by the old behavior.

**Tech Stack:** TypeScript, mtcute, Vitest, pnpm

---

### Task 1: Add the pagination regression test

**Files:**
- Create: `tests/telegram/mtcute-history.test.ts`
- Reference: `src/telegram/mtcute-client.ts:101-110`

- [ ] **Step 1: Write the failing adapter test**

Create a mock Telegram client whose `iterHistory()` async generator yields 250 mtcute-like messages. Instantiate `MtcuteTelegramClient`, call `fetchHistory({ chat: -100123, limit: 250, minId: 7, onProgress })`, and assert that the result contains 250 rows, `iterHistory()` received `{ limit: 250, minId: 7 }`, and progress ends at 250. Mock `connect()` and `getMe()` so the wrapper readiness path succeeds. Use message-shaped objects containing the fields consumed by `toStoredMessage()`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test tests/telegram/mtcute-history.test.ts`

Expected: FAIL because the production adapter calls `getHistory()` instead of the supplied `iterHistory()`.

- [ ] **Step 3: Commit the regression test**

```bash
git add tests/telegram/mtcute-history.test.ts
git commit -m "test: cover paginated history fetching"
```

### Task 2: Consume mtcute's history iterator

**Files:**
- Modify: `src/telegram/mtcute-client.ts:101-110`
- Test: `tests/telegram/mtcute-history.test.ts`

- [ ] **Step 1: Implement the minimal pagination change**

Replace the one-page request with iterator consumption:

```ts
const rows: StoredMessageInput[] = []
for await (const message of this.client.iterHistory(normalizeChatId(options.chat), {
  limit: options.limit,
  minId: options.minId,
})) {
  rows.push(toStoredMessage(message))
  options.onProgress?.(rows.length)
}
return rows
```

- [ ] **Step 2: Run the focused test and verify GREEN**

Run: `pnpm test tests/telegram/mtcute-history.test.ts`

Expected: PASS with one test passing.

- [ ] **Step 3: Run related service tests**

Run: `pnpm test tests/services/sync-service.test.ts`

Expected: PASS; the 500-message first-sync cap and incremental `minId` behavior remain unchanged.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/telegram/mtcute-client.ts
git commit -m "fix: paginate telegram history fetching"
```

### Task 3: Verify the complete change

**Files:**
- Verify: `src/telegram/mtcute-client.ts`
- Verify: `tests/telegram/mtcute-history.test.ts`

- [ ] **Step 1: Run the complete test suite**

Run: `pnpm test`

Expected: all Vitest files and tests pass with zero failures.

- [ ] **Step 2: Run strict TypeScript validation**

Run: `pnpm typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Check formatting and scope**

Run: `git diff --check HEAD~2..HEAD && git status --short`

Expected: no whitespace errors; only intentional commits and no uncommitted implementation changes.
