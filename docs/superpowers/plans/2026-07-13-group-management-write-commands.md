# Group Management Write Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete, safe Telegram group-management writes to the nested `group` CLI and the `listen <chat>` slash-command composer.

**Architecture:** A UI-independent catalog and parser produce typed requests consumed by one executor and an expanded `GroupService`. Commander and Ink are thin adapters; both reach Telegram through `TelegramGroupManagementAdapter`, whose mtcute implementation prefers high-level methods and normalizes RPC failures.

**Tech Stack:** TypeScript, NodeNext ESM, Commander, React/Ink, mtcute 0.30.x, Vitest, pnpm

---

## File Map

Create focused group-management modules instead of growing the existing adapter and Ink component indefinitely:

- `src/group-commands/types.ts`: catalog, parsed request, risk, execution-context, and result types.
- `src/group-commands/catalog.ts`: immutable command metadata shared by CLI and Ink.
- `src/group-commands/tokenize.ts`: shell-like tokenizer with offsets.
- `src/group-commands/parser.ts`: exact parsing, typed arguments, fuzzy matches, and completion.
- `src/group-commands/executor.ts`: confirmation gate and dispatch to `GroupService`.
- `src/telegram/group-write-types.ts`: typed adapter requests/results for writes.
- `src/telegram/mtcute-group-members.ts`: member and administrator mtcute calls.
- `src/telegram/mtcute-group-settings.ts`: group settings and lifecycle calls.
- `src/telegram/mtcute-group-invites.ts`: invite and join-request calls.
- `src/telegram/mtcute-group-topics.ts`: forum-topic calls.
- `src/services/group-write-service.ts`: write-service error boundary and result normalization.
- `src/commands/group-write.ts`: nested Commander registration derived from the catalog.
- `src/presenters/ink/group-command-menu.tsx`: slash-command match list.
- `src/presenters/ink/group-command-confirm.tsx`: confirmation and permission-selection views.
- `src/presenters/ink/group-command-result.tsx`: command result/table overlay.
- `src/presenters/ink/use-group-command.ts`: reducer/controller for composer command state.

Modify:

- `src/telegram/group-types.ts`: compose read and write adapter contracts.
- `src/telegram/mtcute-group-management.ts`: delegate write families while retaining reads.
- `src/telegram/fake-group-management.ts`: deterministic write fake and call recording.
- `src/services/group-service.ts`: preserve the existing read API and expose the write service.
- `src/commands/group.ts`: register the shared write tree below `group`.
- `src/presenters/ink/listen.tsx`: route slash input to the command controller and render its views.
- `src/telegram/types.ts`: keep `client.groups` typed with the expanded adapter.

## Task 1: Shared Command Types And Catalog

**Files:**
- Create: `src/group-commands/types.ts`
- Create: `src/group-commands/catalog.ts`
- Test: `tests/group-commands/catalog.test.ts`

- [ ] **Step 1: Write the failing catalog contract tests**

Cover unique paths, grouped paths, required risk flags, and the exact top-level families:

```ts
import { describe, expect, it } from 'vitest'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'

describe('GROUP_COMMANDS', () => {
  it('contains unique grouped paths', () => {
    const paths = GROUP_COMMANDS.map((item) => item.path.join(' '))
    expect(new Set(paths).size).toBe(paths.length)
    expect(new Set(GROUP_COMMANDS.map((item) => item.path[0]))).toEqual(
      new Set(['member', 'admin', 'chat', 'invite', 'topic', 'message']),
    )
  })

  it('marks irreversible and moderation writes for confirmation', () => {
    const risky = GROUP_COMMANDS.filter((item) => item.risk !== 'none').map((item) => item.path.join(' '))
    expect(risky).toEqual(expect.arrayContaining([
      'member ban', 'member kick', 'member purge', 'admin transfer-owner',
      'chat leave', 'chat delete', 'invite revoke', 'invite approve-all',
      'invite decline-all', 'topic delete', 'message delete', 'message unpin-all',
    ]))
  })
})
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `pnpm vitest run tests/group-commands/catalog.test.ts`

Expected: FAIL because `src/group-commands/catalog.ts` does not exist.

- [ ] **Step 3: Add catalog types and the complete catalog**

Define these stable primitives in `types.ts`:

```ts
export type GroupCommandRisk = 'none' | 'confirm' | 'confirm-title'
export type GroupCommandValueKind = 'user' | 'users' | 'text' | 'id' | 'ids' | 'duration' | 'toggle' | 'path' | 'permissions' | 'invite'

export type GroupCommandArgument = {
  name: string
  kind: GroupCommandValueKind
  required: boolean
  rest?: boolean
}

export type GroupCommandDefinition = {
  path: readonly [string, string]
  summary: string
  usage: string
  risk: GroupCommandRisk
  args: readonly GroupCommandArgument[]
  capability?: 'group' | 'supergroup' | 'forum' | 'admin' | 'creator'
}
```

Populate `GROUP_COMMANDS` with every path approved in the design. Use `satisfies readonly GroupCommandDefinition[]`, freeze the exported array, give query-only paths (`invite list/show/members`, `topic list`) risk `none`, and apply the confirmation rules from the spec. Do not add flat aliases.

- [ ] **Step 4: Run the catalog test**

Run: `pnpm vitest run tests/group-commands/catalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the catalog**

```bash
git add src/group-commands/types.ts src/group-commands/catalog.ts tests/group-commands/catalog.test.ts
git commit -m "feat: add group command catalog"
```

## Task 2: Tokenizer, Parser, Fuzzy Matching, And Completion

**Files:**
- Create: `src/group-commands/tokenize.ts`
- Create: `src/group-commands/parser.ts`
- Test: `tests/group-commands/parser.test.ts`

- [ ] **Step 1: Write failing parser tests**

Test quoted text, escaped spaces, rest text, toggles, durations, numeric IDs, usernames, incomplete input, and fuzzy matching:

```ts
expect(parseGroupCommand('/member ban @alice')).toMatchObject({
  ok: true, request: { path: ['member', 'ban'], values: { user: '@alice' } },
})
expect(parseGroupCommand('/chat title "Release Room"')).toMatchObject({
  ok: true, request: { values: { text: 'Release Room' } },
})
expect(parseGroupCommand('/member mute 123456 2h')).toMatchObject({
  ok: true, request: { values: { user: 123456, durationSeconds: 7200 } },
})
expect(parseGroupCommand('/chat protect yes')).toEqual(expect.objectContaining({
  ok: false, error: expect.objectContaining({ code: 'invalid_toggle' }),
}))
expect(matchGroupCommands('/memb bn')[0]?.definition.path).toEqual(['member', 'ban'])
expect(completeGroupCommand('/mem b')).toBe('/member ban ')
```

Also assert unmatched quotes return `unterminated_quote`, an unsafe integer ID remains a decimal string, and `off` yields `null` for a duration.

- [ ] **Step 2: Run the parser tests and verify failure**

Run: `pnpm vitest run tests/group-commands/parser.test.ts`

Expected: FAIL because parser exports do not exist.

- [ ] **Step 3: Implement tokenizer and typed parser**

Export these results from `parser.ts`:

```ts
export type ParsedGroupCommandRequest = {
  definition: GroupCommandDefinition
  path: readonly [string, string]
  values: Readonly<Record<string, unknown>>
  source: string
}

export type ParseGroupCommandResult =
  | { ok: true; request: ParsedGroupCommandRequest }
  | { ok: false; error: { code: string; message: string; usage?: string } }

export function parseGroupCommand(source: string): ParseGroupCommandResult
export function matchGroupCommands(source: string): GroupCommandMatch[]
export function completeGroupCommand(source: string, selectedIndex?: number): string
```

Tokenization must retain the decoded value plus source start/end offsets. Score exact prefix matches before ordered-subsequence matches; break ties by catalog order. Parse `s/m/h/d` durations with safe-integer overflow checks, only `on/off` toggles, comma-separated permission names, `@name` or numeric users, and positive integer IDs.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run tests/group-commands/parser.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the parser**

```bash
git add src/group-commands tests/group-commands
git commit -m "feat: parse group management commands"
```

## Task 3: Typed Write Adapter And Error Contract

**Files:**
- Create: `src/telegram/group-write-types.ts`
- Modify: `src/telegram/group-types.ts`
- Modify: `src/telegram/fake-group-management.ts`
- Test: `tests/telegram/fake-group-management-write.test.ts`

- [ ] **Step 1: Write failing fake-adapter contract tests**

Exercise one request in every family and assert immutable call recording:

```ts
await fake.banMember({ chat: -1001, user: '@alice' })
await fake.setSlowMode({ chat: -1001, seconds: 30 })
await fake.createInvite({ chat: -1001, title: 'Team', requestNeeded: true })
await fake.createTopic({ chat: -1001, title: 'Release' })
expect(fake.writeCalls).toEqual([
  { operation: 'banMember', request: { chat: -1001, user: '@alice' } },
  { operation: 'setSlowMode', request: { chat: -1001, seconds: 30 } },
  expect.objectContaining({ operation: 'createInvite' }),
  expect.objectContaining({ operation: 'createTopic' }),
])
```

- [ ] **Step 2: Run the fake test and verify failure**

Run: `pnpm vitest run tests/telegram/fake-group-management-write.test.ts`

Expected: FAIL because write methods are absent.

- [ ] **Step 3: Define explicit request/result unions**

In `group-write-types.ts`, define `GroupPeer = string | number`, `GroupUser = string | number`, permission keys matching `TelegramGroupAdminRights` and `TelegramGroupRestrictions`, request types for every catalog operation, and stable results:

```ts
export type TelegramGroupWriteResult = {
  operation: string
  chat_id: number
  target_id?: number
  effective_until?: string | null
  details?: Readonly<Record<string, string | number | boolean | null>>
}

export interface TelegramGroupWriteAdapter {
  addMembers(request: AddMembersRequest): Promise<TelegramGroupWriteResult>
  banMember(request: MemberRequest): Promise<TelegramGroupWriteResult>
  // Declare every remaining catalog operation with a named request type.
}
```

Compose `TelegramGroupManagementAdapter` from the existing read contract and `TelegramGroupWriteAdapter`. Add errors for unsupported group type, missing permission, flood wait (with seconds), and password required.

- [ ] **Step 4: Implement every fake method with shared recording**

Use one `record(operation, request)` helper that clones request arrays/objects before appending to `writeCalls`, resolves a configured result, and throws configured failures. Return deterministic chat and target IDs.

- [ ] **Step 5: Run fake, existing group tests, and typecheck**

Run: `pnpm vitest run tests/telegram/fake-group-management-write.test.ts tests/telegram/mtcute-group-management.test.ts tests/services/group-service.test.ts && pnpm typecheck`

Expected: PASS; read behavior remains unchanged.

- [ ] **Step 6: Commit the adapter contract**

```bash
git add src/telegram/group-write-types.ts src/telegram/group-types.ts src/telegram/fake-group-management.ts tests/telegram/fake-group-management-write.test.ts
git commit -m "feat: define group write adapter"
```

## Task 4: Member And Administrator mtcute Writes

**Files:**
- Create: `src/telegram/mtcute-group-members.ts`
- Modify: `src/telegram/mtcute-group-management.ts`
- Test: `tests/telegram/mtcute-group-members.test.ts`

- [ ] **Step 1: Verify installed mtcute signatures**

Run the skill lookup script for `addChatMembers`, `kickChatMember`, `banChatMember`, `unbanChatMember`, `restrictChatMember`, `unrestrictChatMember`, `deleteUserHistory`, `editAdminRights`, `editChatMemberRank`, and `transferChatOwnership`.

Expected: each method is present in installed `@mtcute/core` declarations. Record exact option property names in the test fixtures before writing implementation.

- [ ] **Step 2: Write failing mapping tests**

Use a typed mock client and assert each adapter method calls the corresponding high-level method once. Include indefinite mute, timed mute, explicit promotion rights, demotion with all rights false, custom rank, and ownership transfer. Assert `ensureReady` runs first and normalized peers preserve unsafe numeric IDs as strings.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm vitest run tests/telegram/mtcute-group-members.test.ts`

Expected: FAIL because `MtcuteGroupMembers` does not exist.

- [ ] **Step 4: Implement member/admin delegation**

Resolve the chat and target with existing normalization helpers, require a group, map snake-case public rights to mtcute camel-case rights, and convert duration seconds to an absolute `Date` only at the adapter boundary. Return `TelegramGroupWriteResult` after successful calls. Keep permission selection outside this adapter.

- [ ] **Step 5: Normalize member-write RPC errors**

Map peer/member not found, admin-required, rights-forbidden, `FLOOD_WAIT_%d`, and session-password-needed RPC errors into the typed errors from Task 3. Re-throw unknown errors unchanged.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run tests/telegram/mtcute-group-members.test.ts tests/telegram/mtcute-group-management.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add src/telegram/mtcute-group-members.ts src/telegram/mtcute-group-management.ts tests/telegram/mtcute-group-members.test.ts
git commit -m "feat: manage group members and admins"
```

## Task 5: Settings, Invites, Topics, Messages, And Lifecycle

**Files:**
- Create: `src/telegram/mtcute-group-settings.ts`
- Create: `src/telegram/mtcute-group-invites.ts`
- Create: `src/telegram/mtcute-group-topics.ts`
- Modify: `src/telegram/mtcute-group-management.ts`
- Test: `tests/telegram/mtcute-group-settings.test.ts`
- Test: `tests/telegram/mtcute-group-invites.test.ts`
- Test: `tests/telegram/mtcute-group-topics.test.ts`

- [ ] **Step 1: Verify every installed mtcute signature**

Use `get-method.js` for all methods listed in the design's adapter section. For any missing method, use `get-constructor.js --with-references <tl-method>` and document the exact raw request and return type in that family test. Do not guess option names.

- [ ] **Step 2: Write failing settings tests**

Cover title, description, username off, photo set/delete, slow mode, TTL, content protection, join requests, join-to-send, default permissions, sticker set, leave, group deletion, supergroup deletion, pin/unpin/unpin-all, and message deletion. Assert legacy group/supergroup routing and `~` path expansion before file upload.

- [ ] **Step 3: Implement settings and lifecycle delegation**

Use high-level methods, fetch the group once when routing depends on group type, and never include a local photo path in returned details. Delete a legacy group with `deleteGroup` and a supergroup with `deleteSupergroup`.

- [ ] **Step 4: Write failing invite tests**

Cover list/show/create/edit/revoke/members plus approve/decline one and all. Assert expiry dates, usage limits, request-needed, and title map exactly; verify returned invite data is normalized to plain serializable objects.

- [ ] **Step 5: Implement invite and request delegation**

Use mtcute invite-link and join-request high-level methods. Where mtcute exposes an async iterator, consume only the validated limit. Return stable invite records containing link, title, creator, expiry, usage, request-needed, revoked, and permanent fields when available.

- [ ] **Step 6: Write failing topic tests**

Cover list/create/edit/close/reopen/pin/unpin/reorder/delete/general-hidden. Assert topic IDs are positive integers and deletion calls the history-deletion method.

- [ ] **Step 7: Implement topic delegation and normalized errors**

Require a supergroup forum before mutation, map result topics to serializable records, handle any returned raw updates through `client.handleClientUpdate`, and apply the common RPC mapping from Task 4.

- [ ] **Step 8: Run all adapter tests and commit**

Run: `pnpm vitest run tests/telegram/mtcute-group-*.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add src/telegram/mtcute-group-settings.ts src/telegram/mtcute-group-invites.ts src/telegram/mtcute-group-topics.ts src/telegram/mtcute-group-management.ts tests/telegram/mtcute-group-settings.test.ts tests/telegram/mtcute-group-invites.test.ts tests/telegram/mtcute-group-topics.test.ts
git commit -m "feat: add complete group write adapter"
```

## Task 6: Write Service And Shared Executor

**Files:**
- Create: `src/services/group-write-service.ts`
- Create: `src/group-commands/executor.ts`
- Modify: `src/services/group-service.ts`
- Test: `tests/services/group-write-service.test.ts`
- Test: `tests/group-commands/executor.test.ts`

- [ ] **Step 1: Write failing service dispatch/error tests**

Table-test every catalog path against the expected fake-adapter method. Assert typed adapter errors map to stable codes: `group_not_found`, `member_not_found`, `admin_required`, `permission_missing`, `unsupported_group`, `flood_wait`, `password_required`, and `telegram_error`.

- [ ] **Step 2: Implement `GroupWriteService.execute`**

Use an exhaustive switch on `request.path.join(' ')`, build named adapter requests from parsed values, and return `HandlerResult<TelegramGroupWriteResult | query-result>`. Add an `assertNever` default so adding a catalog path without service dispatch fails typecheck.

- [ ] **Step 3: Write failing confirmation-gate tests**

```ts
expect(await executeGroupCommand(request, contextWithoutConfirmation)).toMatchObject({
  ok: false, confirmation: { risk: 'confirm', chat: '@team', target: '@alice' },
})
expect(adapter.writeCalls).toHaveLength(0)
expect(await executeGroupCommand(request, { ...context, confirmed: true })).toMatchObject({ ok: true })
```

Also test `confirm-title`, multi-chat ambiguity, disconnected client, capability rejection, and cache invalidation after settings/admin writes.

- [ ] **Step 4: Implement the shared executor**

Define execution context with `chat`, `groups`, `confirmed`, optional `confirmationTitle`, known group details, and `invalidateGroup`. Return confirmation as data instead of prompting. Require exact group title for `confirm-title`. Let UI adapters decide how authorization is collected.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/services/group-write-service.test.ts tests/group-commands/executor.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add src/services/group-write-service.ts src/services/group-service.ts src/group-commands/executor.ts tests/services/group-write-service.test.ts tests/group-commands/executor.test.ts
git commit -m "feat: execute group management writes"
```

## Task 7: Nested Commander Write Commands

**Files:**
- Create: `src/commands/group-write.ts`
- Modify: `src/commands/group.ts`
- Modify: `src/presenters/group.ts`
- Test: `tests/commands/group-write.test.ts`
- Modify: `tests/cli/help.test.ts`

- [ ] **Step 1: Write failing CLI tree and safety tests**

Parse representative commands from every family with a fake client. Assert the target chat is injected, results render in human/JSON/YAML forms, risky commands refuse without `--yes`, risky commands execute with `--yes`, and `/chat delete` additionally requires `--confirm-title <exact-title>`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run tests/commands/group-write.test.ts tests/cli/help.test.ts`

Expected: FAIL because nested write commands are not registered.

- [ ] **Step 3: Register nested commands from catalog metadata**

Create the six family commands once, then register every second-level command with catalog summary/usage. Accept `<chat>` first for ordinary CLI, expose catalog arguments as Commander arguments/options, add `--yes`, `--confirm-title`, `--json`, and `--yaml`, and call the shared parser/executor rather than reproducing validation.

- [ ] **Step 4: Add stable result presenters**

Render action summaries with chat, operation, target, and effective values. Render invite/topic queries as tables. Never print directly from services or adapters.

- [ ] **Step 5: Run CLI tests, full command contracts, and commit**

Run: `pnpm vitest run tests/commands/group-write.test.ts tests/commands/group.test.ts tests/cli/help.test.ts tests/cli/contract.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add src/commands/group-write.ts src/commands/group.ts src/presenters/group.ts tests/commands/group-write.test.ts tests/cli/help.test.ts
git commit -m "feat: add group management CLI commands"
```

## Task 8: Ink Slash Menu And Command Controller

**Files:**
- Create: `src/presenters/ink/group-command-menu.tsx`
- Create: `src/presenters/ink/group-command-result.tsx`
- Create: `src/presenters/ink/use-group-command.ts`
- Modify: `src/presenters/ink/listen.tsx`
- Test: `tests/presenters/group-command-menu.test.tsx`
- Modify: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write failing pure menu rendering tests**

Render matches and assert selected, disabled, summary, and usage states. Keep menu width bounded by the composer width and truncate descriptions without splitting wide characters.

- [ ] **Step 2: Write failing listen keyboard tests**

Simulate `/`, fuzzy text, Up/Down wraparound, Tab completion, Enter completion, missing-argument usage, Esc close, and ordinary text send. Assert slash commands never call `sendMessage` and reuse `client.groups` from the active listener.

- [ ] **Step 3: Implement the command state reducer/hook**

Use explicit modes:

```ts
type GroupCommandUiState =
  | { mode: 'closed' }
  | { mode: 'menu'; selected: number }
  | { mode: 'executing'; request: ParsedGroupCommandRequest }
  | { mode: 'result'; result: GroupCommandExecutionResult }
  | { mode: 'error'; message: string }
```

Keep input text owned by `InteractiveListen`; the controller receives it and returns key-handling decisions. Do not intercept attachment-focus keys unless the composer has slash-command focus.

- [ ] **Step 4: Integrate menu, completion, execution, and result views**

Route input whose first non-whitespace character is `/` to the controller. Lock editing while executing. Clear on success; retain input on failure. Display invite/topic/member list results above the composer and return to chat with Esc. If multiple chats are listened to and `sendTo` is absent, disable execution with an explicit message.

- [ ] **Step 5: Run Ink regressions and commit**

Run: `pnpm vitest run tests/presenters/group-command-menu.test.tsx tests/presenters/ink-listen.test.tsx tests/commands/telegram-listen.test.ts && pnpm typecheck`

Expected: PASS, including existing send/download/scroll/reconnect tests.

```bash
git add src/presenters/ink/group-command-menu.tsx src/presenters/ink/group-command-result.tsx src/presenters/ink/use-group-command.ts src/presenters/ink/listen.tsx tests/presenters/group-command-menu.test.tsx tests/presenters/ink-listen.test.tsx
git commit -m "feat: add listen slash command menu"
```

## Task 9: Ink Confirmation, Permission Selection, And Capability State

**Files:**
- Create: `src/presenters/ink/group-command-confirm.tsx`
- Modify: `src/presenters/ink/use-group-command.ts`
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Write failing confirmation tests**

Cover Confirm/Cancel arrow selection, Esc cancellation, immutable pending request, exact-title second stage for group deletion, and no adapter call before confirmation. Assert the view names chat, target, duration, and side effect.

- [ ] **Step 2: Write failing permission/capability tests**

Assert `/admin promote @alice` without rights opens a permission selector, explicit rights skip it, group/forum/admin/creator requirements disable commands with reasons, and successful settings/admin operations refresh cached group info.

- [ ] **Step 3: Extend the state machine**

Add `confirm`, `confirm-title`, and `select-permissions` modes containing the immutable parsed request. Confirmed execution must call the same executor with `confirmed: true`; title confirmation must pass the typed title separately rather than modifying source input.

- [ ] **Step 4: Render confirmation and permission views**

Use Up/Down and Enter for Confirm/Cancel, Space for permission toggles, Enter to accept selected rights, and Esc to return to editable command input. Default promotion rights are all unselected.

- [ ] **Step 5: Run Ink tests and commit**

Run: `pnpm vitest run tests/presenters/ink-listen.test.tsx tests/presenters/group-command-menu.test.tsx && pnpm typecheck`

Expected: PASS.

```bash
git add src/presenters/ink/group-command-confirm.tsx src/presenters/ink/use-group-command.ts src/presenters/ink/listen.tsx tests/presenters/ink-listen.test.tsx
git commit -m "feat: confirm interactive group writes"
```

## Task 10: Final Contracts, Documentation, And Verification

**Files:**
- Modify: `README.md`
- Modify: `tests/package.test.ts`
- Modify: any focused test file only when final verification exposes a real regression

- [ ] **Step 1: Add package-level and catalog coverage assertions**

Assert every catalog command is present in `tg group --help` through its family help, every adapter operation has an executor dispatch, and every `confirm`/`confirm-title` entry is refused by CLI without authorization.

- [ ] **Step 2: Document both command surfaces**

Add concise README sections showing:

```bash
tg group member ban @team @alice --yes
tg group chat slowmode @team 30s
tg listen @team
# then type: /member mute @alice 2h
```

Document `/` discovery, fuzzy completion keys, explicit user targeting, confirmation behavior, multi-chat targeting, duration syntax, and the requirement for Telegram administrator rights.

- [ ] **Step 3: Run formatting-independent checks**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Run the complete suite**

Run: `pnpm test && pnpm typecheck`

Expected: all Vitest suites pass and TypeScript exits with code 0.

- [ ] **Step 5: Manually smoke-test help and fake-mode interaction**

Run:

```bash
pnpm dev -- group --help
pnpm dev -- group member --help
pnpm dev -- group topic --help
```

Expected: nested commands, arguments, confirmation options, and output flags are discoverable with no startup warnings.

- [ ] **Step 6: Commit documentation and final contracts**

```bash
git add README.md tests/package.test.ts tests src
git commit -m "docs: document group management commands"
```

## Completion Criteria

- Every approved command path is represented exactly once in the shared catalog.
- CLI and Ink use the shared parser and executor, not parallel validation implementations.
- All writes use the existing `listen` client or the ordinary CLI-managed client lifecycle.
- Risky writes cannot execute without the designed authorization.
- Known unsupported capabilities are explained before execution; Telegram RPC errors remain safely normalized.
- Existing message send, attachment, scroll, resize, reconnect, and exit behavior remains covered and passing.
- `pnpm test && pnpm typecheck` succeeds from a clean checkout.

