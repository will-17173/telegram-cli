# Command Help Descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add concise English descriptions to every top-level command shown by `tg help`.

**Architecture:** Keep help metadata beside each Commander command registration by chaining `.description()` after `.command()`. Protect the complete command surface with a metadata assertion and verify representative generated help text without changing handlers or output contracts.

**Tech Stack:** TypeScript, Commander, Vitest, pnpm

---

### Task 1: Protect the top-level help contract

**Files:**
- Modify: `tests/cli/help.test.ts`

- [ ] **Step 1: Write the failing metadata test**

Add this test inside `describe('cli help', ...)`:

```ts
it('describes every top-level command', () => {
  const commands = createApp().commands

  expect(commands).toHaveLength(22)
  expect(commands.every((command) => command.description().trim().length > 0)).toBe(true)
})
```

- [ ] **Step 2: Write the failing rendered-help test**

Add this test inside the same `describe` block:

```ts
it('shows command purposes in top-level help', () => {
  const help = createApp().helpInformation()

  expect(help).toContain('Search locally stored messages by keyword')
  expect(help).toContain('Export locally stored messages from a chat')
  expect(help).toContain('Show Telegram authentication status')
  expect(help).toContain('Manage Telegram CLI configuration')
})
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run: `pnpm test -- tests/cli/help.test.ts`

Expected: FAIL because commands such as `search`, `export`, and `status` have empty descriptions.

- [ ] **Step 4: Commit the failing tests**

```bash
git add tests/cli/help.test.ts
git commit -m "test: cover command help descriptions"
```

### Task 2: Add query and data command descriptions

**Files:**
- Modify: `src/commands/query.ts`
- Modify: `src/commands/data.ts`

- [ ] **Step 1: Add descriptions to query commands**

Chain these descriptions immediately after their matching `.command()` calls:

```ts
.description('Search locally stored messages by keyword') // search
.description('Show recently stored messages') // recent
.description('Show local message and chat statistics') // stats
.description('Show the most active message senders') // top
.description('Show message activity over time') // timeline
.description('Show messages stored today') // today
.description('Filter locally stored messages by keywords') // filter
```

The comments above identify placement; do not add the comments to production code.

- [ ] **Step 2: Add descriptions to data commands**

Chain these descriptions immediately after their matching `.command()` calls:

```ts
.description('Export locally stored messages from a chat') // export
.description('Delete locally stored messages from a chat') // purge
```

The comments above identify placement; do not add the comments to production code.

- [ ] **Step 3: Run the focused test and confirm it still fails only for Telegram commands**

Run: `pnpm test -- tests/cli/help.test.ts`

Expected: FAIL on the all-command metadata assertion and missing Telegram description; query and data help assertions pass.

- [ ] **Step 4: Commit query and data help metadata**

```bash
git add src/commands/query.ts src/commands/data.ts
git commit -m "feat: describe local data commands"
```

### Task 3: Add Telegram command descriptions

**Files:**
- Modify: `src/commands/telegram.ts`

- [ ] **Step 1: Add descriptions to Telegram commands**

Chain these descriptions immediately after their matching `.command()` calls:

```ts
.description('Show Telegram authentication status') // status
.description('Show the authenticated Telegram account') // whoami
.description('List available Telegram chats') // chats
.description('Fetch chat history and store it locally') // history
.description('Sync new messages from a Telegram chat') // sync
.description('Sync messages from all Telegram chats') // sync-all
.description('Refresh all chats with new Telegram messages') // refresh
.description('Show information about a Telegram chat') // info
.description('Send a message to a Telegram chat') // send
.description('Edit a Telegram message') // edit
.description('Delete Telegram messages') // delete
.description('Listen for new Telegram messages') // listen
```

The comments above identify placement; do not add the comments to production code.

- [ ] **Step 2: Run the focused test and verify it passes**

Run: `pnpm test -- tests/cli/help.test.ts`

Expected: PASS with all help tests successful.

- [ ] **Step 3: Inspect the rendered help**

Run: `pnpm dev -- help`

Expected: Every entry under `Commands:` has a concise English description aligned by Commander.

- [ ] **Step 4: Commit Telegram help metadata**

```bash
git add src/commands/telegram.ts
git commit -m "feat: describe telegram commands"
```

### Task 4: Verify the complete project

**Files:**
- No file changes expected

- [ ] **Step 1: Run all tests**

Run: `pnpm test`

Expected: All Vitest test files and tests pass with zero failures.

- [ ] **Step 2: Run strict TypeScript validation**

Run: `pnpm typecheck`

Expected: Exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Check the final diff**

Run: `git diff --check`

Expected: Exit code 0 with no whitespace errors.
