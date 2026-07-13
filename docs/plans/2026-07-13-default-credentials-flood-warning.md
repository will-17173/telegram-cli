# Default Credentials Flood Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the application-wide default Telegram credentials warning with explicit flood-limit guidance.

**Architecture:** Keep warning ownership and once-per-process behavior in the existing Telegram client factory. Change only the shared warning text, its exact-output test fixture, and the English/Chinese README examples.

**Tech Stack:** TypeScript, Vitest, Markdown, pnpm

---

### Task 1: Update the global warning

**Files:**
- Modify: `src/telegram/client-factory.ts:9`
- Modify: `tests/telegram/client-factory.test.ts:16`
- Modify: `README.md:58`
- Modify: `README.zh-CN.md:58-61`

- [ ] **Step 1: Update the test expectation first**

Change the test fixture to the exact new warning:

```ts
const WARNING = 'warning: using default Telegram API credentials, which have stricter flood limits and may trigger FLOOD_WAIT during frequent or large requests. Run tg config set --api-id <id> --api-hash <hash> to configure your own.\n'
```

Retain the existing assertions that it appears once on stderr, leaves stdout empty, retries after a synchronous stderr failure, avoids reentrant duplicates, and is suppressed for stored/environment credentials.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test tests/telegram/client-factory.test.ts`

Expected: FAIL because the production constant still contains the old warning.

- [ ] **Step 3: Replace the production warning**

Set `DEFAULT_CREDENTIALS_WARNING` in `src/telegram/client-factory.ts` to the exact string asserted by the test. Do not change warning conditions or output destination.

- [ ] **Step 4: Update documentation examples**

Replace the old warning line in both README files with the exact new line. Update the adjacent Chinese explanation to mention that default credentials have stricter flood limits and large or frequent requests can trigger `FLOOD_WAIT`.

- [ ] **Step 5: Verify focused behavior**

Run: `pnpm test tests/telegram/client-factory.test.ts`

Expected: all client-factory tests pass.

- [ ] **Step 6: Verify the repository**

Run: `pnpm test && pnpm typecheck && git diff --check`

Expected: all tests pass, typecheck exits 0, and no whitespace errors are reported.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/client-factory.ts tests/telegram/client-factory.test.ts README.md README.zh-CN.md
git commit -m "fix: clarify default credentials flood warning"
```
