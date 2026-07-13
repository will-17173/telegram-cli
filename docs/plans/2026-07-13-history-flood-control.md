# History Flood Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pace Telegram history pages and automatically recover from bounded `FLOOD_WAIT_X` responses.

**Architecture:** Replace iterator-owned pagination with an adapter-local `getHistory()` loop so each page request has an explicit offset, delay, and retry boundary. Pass page delay through the adapter contract and sync service; expose it on single-chat commands while retaining the existing inter-chat meaning of `sync-all --delay`.

**Tech Stack:** TypeScript, mtcute, Commander, Vitest, pnpm

---

### Task 1: Add explicit paginated pacing

**Files:**
- Modify: `src/telegram/types.ts:22-28`
- Modify: `src/telegram/mtcute-client.ts:101-112`
- Modify: `tests/telegram/mtcute-history.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Replace the iterator mock with a `getHistory` mock returning mtcute-style paginated arrays. Add fake-timer tests proving two 100-message pages and one final 50-message page produce 250 rows, exactly two sleeps occur before later page calls, the wait duration is within `pageDelay * 800..1200` milliseconds, no sleep follows the last page, offsets are forwarded, and progress reaches 250.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test tests/telegram/mtcute-history.test.ts`

Expected: FAIL because `FetchHistoryOptions` has no `pageDelay` and production still calls `iterHistory()`.

- [ ] **Step 3: Implement explicit pagination**

Add `pageDelay?: number` to `FetchHistoryOptions`. In `fetchHistory()`, repeatedly call:

```ts
const page = await this.client.getHistory(chat, {
  limit: Math.min(100, options.limit - rows.length),
  minId: options.minId,
  offset,
})
```

Append mapped rows, report accumulated progress, stop at the requested limit or when `page.next` is absent, otherwise assign `offset = page.next` and wait `(pageDelay + jitter) * 1000` before the next call. Use `node:timers/promises` and skip the timer when `pageDelay` is zero.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test tests/telegram/mtcute-history.test.ts`

Expected: all pagination and pacing tests pass.

- [ ] **Step 5: Commit pagination pacing**

```bash
git add src/telegram/types.ts src/telegram/mtcute-client.ts tests/telegram/mtcute-history.test.ts
git commit -m "fix: pace telegram history pages"
```

### Task 2: Recover from flood waits

**Files:**
- Modify: `src/telegram/mtcute-client.ts`
- Modify: `tests/telegram/mtcute-history.test.ts`

- [ ] **Step 1: Write failing flood-wait tests**

Use `new tl.RpcError(420, 'FLOOD_WAIT_14')` and fake timers. Make the first call reject and the retry return a page; verify the same page parameters are retried after 15 seconds and rows are not duplicated. Add a test where six calls reject and verify the sixth error is propagated after five waits.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test tests/telegram/mtcute-history.test.ts`

Expected: FAIL because flood waits are propagated immediately.

- [ ] **Step 3: Implement bounded retry**

Add a page-fetch helper or inner retry loop. Detect flood waits with `tl.RpcError.is(error, 'FLOOD_WAIT_%d')`, maintain one operation-wide retry count, wait `(error.seconds + 1) * 1000`, and retry without changing `offset`. Throw the sixth flood error and immediately rethrow every non-flood error.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run: `pnpm test tests/telegram/mtcute-history.test.ts`

Expected: flood recovery and retry exhaustion tests pass.

- [ ] **Step 5: Commit flood recovery**

```bash
git add src/telegram/mtcute-client.ts tests/telegram/mtcute-history.test.ts
git commit -m "fix: retry telegram flood waits"
```

### Task 3: Expose and validate page delay

**Files:**
- Modify: `src/services/sync-service.ts:24-80`
- Modify: `src/commands/telegram.ts:29-160`
- Modify: `tests/services/sync-service.test.ts`
- Modify: `tests/commands/telegram-lifecycle.test.ts`
- Modify: `tests/cli/help.test.ts`

- [ ] **Step 1: Write failing service and command tests**

Add tests showing `history` and `sync` forward `pageDelay`, reject negative or non-finite values before fetching, and parse `--delay 2.5`. Add assertions that help lists `--delay` for `history` and `sync`, while existing refresh tests continue passing.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm test tests/services/sync-service.test.ts tests/commands/telegram-lifecycle.test.ts tests/cli/help.test.ts`

Expected: FAIL because single-chat options do not accept or validate page delay.

- [ ] **Step 3: Implement service propagation and CLI flags**

Change single-chat service options to `{ chat: string; limit: number; pageDelay: number }`, validate with a shared finite non-negative delay check, and forward `pageDelay` into `fetchHistory()`. In refresh, forward the internal `pageDelay: 1` while leaving `options.delay` for the existing inter-chat timer. Add `.option('--delay <delay>', 'Seconds between history pages', '1')` to `history` and `sync`, parse it with `Number.parseFloat`, and pass it as `pageDelay`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm test tests/services/sync-service.test.ts tests/commands/telegram-lifecycle.test.ts tests/cli/help.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit the CLI contract**

```bash
git add src/services/sync-service.ts src/commands/telegram.ts tests/services/sync-service.test.ts tests/commands/telegram-lifecycle.test.ts tests/cli/help.test.ts
git commit -m "feat: configure history page delay"
```

### Task 4: Verify the complete change

**Files:**
- Verify all modified source and test files.

- [ ] **Step 1: Run the complete test suite**

Run: `pnpm test`

Expected: all Vitest files and tests pass with zero failures.

- [ ] **Step 2: Run strict TypeScript validation**

Run: `pnpm typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Check repository state**

Run: `git diff --check HEAD~3..HEAD && git status --short`

Expected: no whitespace errors and no uncommitted implementation changes.
