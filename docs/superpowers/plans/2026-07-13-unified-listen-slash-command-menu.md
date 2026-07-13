# Unified Listen Slash Command Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every interactive `listen` slash command, beginning with `/reply` and all group-management commands, discoverable through one fuzzy-matching menu and completion flow.

**Architecture:** A unified, UI-independent listen command catalog derives group entries from `GROUP_COMMANDS` and directly defines general composer commands. A unified matcher owns ranking, six-item bounds, and completion, while a dispatcher routes canonical entries to the existing reply or group parser/executor without combining their domain logic.

**Tech Stack:** TypeScript, React, Ink, Vitest, Commander-independent command metadata

---

## Working-Tree Constraint

At plan creation time, `src/presenters/ink/listen.tsx` and `tests/presenters/ink-listen.test.tsx` contain unrelated uncommitted user changes for message-ID display and mouse-reporting behavior. Preserve those changes. Before implementation, either obtain a clean committed baseline from the user or create the isolated worktree from a commit containing those changes; never overwrite or stash them without permission.

## File Map

- Create `src/listen-commands/catalog.ts`: unified metadata, general entries, and derived group entries.
- Create `src/listen-commands/match.ts`: scoring, ranking, visible bounds, and completion.
- Create `src/listen-commands/dispatch.ts`: reply/group parse and execution routing contracts.
- Create `src/presenters/ink/listen-command-menu.tsx`: generalized menu rendering and group-only availability.
- Modify `src/services/listen-composer-command.ts`: export canonical reply usage and tokenizer-level parsing support without changing syntax.
- Modify `src/presenters/ink/listen.tsx`: replace group-only menu matching with unified menu and dispatch.
- Modify `src/presenters/ink/use-group-command.ts` only if a generalized async ownership wrapper is required; preserve confirmation state semantics.
- Remove `src/presenters/ink/group-command-menu.tsx` after all imports and tests migrate.
- Add `tests/listen-commands/catalog.test.ts`, `match.test.ts`, and `dispatch.test.ts`.
- Replace `tests/presenters/group-command-menu.test.tsx` with `tests/presenters/listen-command-menu.test.tsx`.
- Extend `tests/presenters/ink-listen.test.tsx` and `tests/services/listen-composer-command.test.ts`.

## Task 1: Unified Command Catalog

**Files:**
- Create: `src/listen-commands/catalog.ts`
- Modify: `src/services/listen-composer-command.ts`
- Test: `tests/listen-commands/catalog.test.ts`
- Modify: `tests/services/listen-composer-command.test.ts`

- [ ] **Step 1: Write failing catalog contracts**

Add tests that require one direct `reply` entry, every `GROUP_COMMANDS` entry, unique IDs/paths, general-before-group catalog order, inherited group definition identity, and identical reply usage:

```ts
expect(LISTEN_COMMANDS[0]).toMatchObject({
  id: 'reply',
  path: ['reply'],
  category: 'general',
  kind: 'reply',
})
expect(LISTEN_COMMANDS.filter(command => command.kind === 'group')).toHaveLength(GROUP_COMMANDS.length)
expect(REPLY_COMMAND_USAGE).toBe('reply <message-id> [content] [--file <path> ...]')
expect(parseListenComposerInput('/reply')).toEqual({ kind: 'error', error: `usage: /${REPLY_COMMAND_USAGE}` })
```

- [ ] **Step 2: Run the focused tests to verify missing exports**

Run: `pnpm vitest run tests/listen-commands/catalog.test.ts tests/services/listen-composer-command.test.ts`

Expected: FAIL because the unified catalog and `REPLY_COMMAND_USAGE` do not exist.

- [ ] **Step 3: Implement immutable unified metadata**

Define a discriminated union:

```ts
export type ListenCommandDefinition =
  | {
      readonly id: 'reply'
      readonly path: readonly ['reply']
      readonly category: 'general'
      readonly kind: 'reply'
      readonly summary: string
      readonly usage: typeof REPLY_COMMAND_USAGE
      readonly keywords: readonly string[]
    }
  | {
      readonly id: `group:${GroupCommandKey}`
      readonly path: GroupCommandDefinition['path']
      readonly category: 'group'
      readonly kind: 'group'
      readonly summary: string
      readonly usage: string
      readonly keywords: readonly string[]
      readonly groupDefinition: GroupCommandDefinition
    }
```

Export `REPLY_COMMAND_USAGE` from the reply parser module. Construct and deeply freeze `LISTEN_COMMANDS`; derive group entries directly from `GROUP_COMMANDS`, with keywords including the second path token so `/ban` matches `member ban`.

- [ ] **Step 4: Run catalog, reply, and type tests**

Run: `pnpm vitest run tests/listen-commands/catalog.test.ts tests/services/listen-composer-command.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the catalog**

```bash
git add src/listen-commands/catalog.ts src/services/listen-composer-command.ts tests/listen-commands/catalog.test.ts tests/services/listen-composer-command.test.ts
git commit -m "feat: add unified listen command catalog"
```

## Task 2: Unified Fuzzy Matching And Completion

**Files:**
- Create: `src/listen-commands/match.ts`
- Test: `tests/listen-commands/match.test.ts`

- [ ] **Step 1: Write failing ranking and completion tests**

Cover exact, prefix, ordered fuzzy, category tie-breaking, stable order, keywords, leading whitespace, slash preservation, and six-item bounds:

```ts
expect(visibleListenCommandMatches('/')[0]?.definition.id).toBe('reply')
expect(visibleListenCommandMatches('/rep')[0]?.definition.id).toBe('reply')
expect(visibleListenCommandMatches('/rpy')[0]?.definition.id).toBe('reply')
expect(visibleListenCommandMatches('/ban')[0]?.definition.path).toEqual(['member', 'ban'])
expect(completeListenCommand('  /rep')).toBe('  /reply ')
expect(visibleListenCommandMatches('/')).toHaveLength(6)
```

Also assert a selected index can only address one of the returned six matches and completing an already complete command preserves its arguments.

- [ ] **Step 2: Run the test and verify missing-module failure**

Run: `pnpm vitest run tests/listen-commands/match.test.ts`

Expected: FAIL because `src/listen-commands/match.ts` does not exist.

- [ ] **Step 3: Implement one scoring and bounds pipeline**

Export:

```ts
export const MAX_LISTEN_COMMAND_MATCHES = 6
export function matchListenCommands(input: string): ListenCommandMatch[]
export function visibleListenCommandMatches(input: string): ListenCommandMatch[]
export function completeListenCommand(input: string, selectedIndex?: number): string
```

Score exact path above prefix above ordered-subsequence matches across normalized path, summary, and keywords. Use category priority only when scores tie, then stable catalog index. Completion replaces only command-path tokens and preserves leading whitespace, slash, and existing arguments.

- [ ] **Step 4: Run matching tests and typecheck**

Run: `pnpm vitest run tests/listen-commands/match.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit matching**

```bash
git add src/listen-commands/match.ts tests/listen-commands/match.test.ts
git commit -m "feat: match all listen slash commands"
```

## Task 3: Command Dispatch Without Parser Duplication

**Files:**
- Create: `src/listen-commands/dispatch.ts`
- Test: `tests/listen-commands/dispatch.test.ts`

- [ ] **Step 1: Write failing reply/group routing tests**

Test that reply input is parsed by `parseListenComposerInput`, group input by `parseGroupCommand`, incomplete paths request completion, invalid inputs return their authoritative parser errors, and neither kind invokes the other executor. Include text reply, file reply, `member ban`, and a group query.

- [ ] **Step 2: Run tests to verify missing dispatch**

Run: `pnpm vitest run tests/listen-commands/dispatch.test.ts`

Expected: FAIL because dispatch exports do not exist.

- [ ] **Step 3: Implement typed parse and execution routing**

Use a discriminated result:

```ts
export type ListenCommandParseResult =
  | { kind: 'complete'; input: string }
  | { kind: 'reply'; command: Extract<ListenComposerCommand, { kind: 'reply' }> }
  | { kind: 'group'; request: ParsedGroupCommandRequest }
  | { kind: 'error'; message: string; usage?: string }
```

`parseSelectedListenCommand(input, match)` verifies that the selected definition still matches the current command path, then delegates to the correct existing parser. `executeSelectedListenCommand` accepts injected reply and group executors so tests can assert strict routing and the Ink layer can reuse its current client and group state machine.

- [ ] **Step 4: Run dispatch and existing parser tests**

Run: `pnpm vitest run tests/listen-commands/dispatch.test.ts tests/services/listen-composer-command.test.ts tests/group-commands/parser.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit dispatch**

```bash
git add src/listen-commands/dispatch.ts tests/listen-commands/dispatch.test.ts
git commit -m "feat: dispatch unified listen commands"
```

## Task 4: Generalized Ink Command Menu

**Files:**
- Create: `src/presenters/ink/listen-command-menu.tsx`
- Delete: `src/presenters/ink/group-command-menu.tsx`
- Create: `tests/presenters/listen-command-menu.test.tsx`
- Delete: `tests/presenters/group-command-menu.test.tsx`

- [ ] **Step 1: Write failing generalized menu tests**

Render `/`, `/rep`, and `/ban`. Assert reply/general rows, group rows, selected styling, usage, wide-character truncation, group disabled reasons, reply availability in non-groups, and navigation that skips disabled entries within the same bounded six matches.

- [ ] **Step 2: Run tests and verify missing generalized component**

Run: `pnpm vitest run tests/presenters/listen-command-menu.test.tsx`

Expected: FAIL because `ListenCommandMenu` does not exist.

- [ ] **Step 3: Implement the generalized menu**

Consume `visibleListenCommandMatches`. For `kind: 'group'`, call `evaluateGroupCommandAvailability`; for `reply`, return enabled. Export one availability list and one enabled-selection movement helper used by both render and keyboard wiring. Continue using `truncateCell` and the existing Codex colors.

- [ ] **Step 4: Migrate component tests and remove the old menu**

Update imports, then delete the group-only component and test. Search for stale imports:

Run: `rg "group-command-menu|visibleGroupCommandMatches|completeGroupCommand" src/presenters tests/presenters`

Expected: no menu-layer dependency on the old group-only functions.

- [ ] **Step 5: Run menu tests and commit**

Run: `pnpm vitest run tests/presenters/listen-command-menu.test.tsx && pnpm typecheck`

Expected: PASS.

```bash
git add src/presenters/ink/listen-command-menu.tsx tests/presenters/listen-command-menu.test.tsx
git rm src/presenters/ink/group-command-menu.tsx tests/presenters/group-command-menu.test.tsx
git commit -m "feat: generalize listen command menu"
```

## Task 5: Interactive Listen Wiring

**Files:**
- Modify: `src/presenters/ink/listen.tsx`
- Modify: `src/presenters/ink/use-group-command.ts` only when required for shared async ownership
- Modify: `tests/presenters/ink-listen.test.tsx`

- [ ] **Step 1: Add failing real Ink tests for unified discovery**

Using the existing `InteractiveListen`, assert `/` shows reply and group rows, `/rep` and `/rpy` select reply, Tab completes `/reply `, `/ban` completes `/member ban `, Up/Down wrap within the visible set, and Esc retains input.

- [ ] **Step 2: Add failing reply execution and safety tests**

Exercise text and file replies through actual key input. Assert success clears input and reports `replied to #42`; parser/network failure retains input and unlocks editing; multi-chat without `--send-to` and disconnected clients make zero sends; repeated Enter makes one send; stale completion cannot clear newer input.

- [ ] **Step 3: Replace group-only matching with unified routing**

In `InteractiveListen`, compute one visible unified match list. Use it for availability, selection, Tab, Enter, and rendering. On Enter:

- incomplete path → complete input;
- reply → call the existing reply send path with the current client/chat;
- group → submit the parsed group request into the existing confirmation/execution state machine.

Do not create a new Telegram client. Keep reply success as a transient note and group query results as the existing modal.

- [ ] **Step 4: Preserve key-priority and async ownership**

Modal confirmation/result keys remain above slash-menu keys. Attachment Tab runs only outside slash mode. Use a synchronous execution lock plus generation token so repeated/stale reply and group operations cannot create duplicate side effects or mutate newer input.

- [ ] **Step 5: Run focused regressions**

Run:

```bash
pnpm vitest run \
  tests/presenters/ink-listen.test.tsx \
  tests/presenters/listen-command-menu.test.tsx \
  tests/services/listen-composer-command.test.ts \
  tests/commands/telegram-listen.test.ts
```

Expected: PASS, including existing reply context, message-ID header, native text selection, attachment, group confirmation, and scroll tests.

- [ ] **Step 6: Commit Ink wiring**

```bash
git add src/presenters/ink/listen.tsx src/presenters/ink/use-group-command.ts tests/presenters/ink-listen.test.tsx
git commit -m "feat: discover all listen slash commands"
```

## Task 6: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `tests/package.test.ts`

- [ ] **Step 1: Add a package contract for unified commands**

Assert the unified catalog contains exactly one reply command plus every group command and that the visible `/` menu can reach both categories. Keep this independent from the catalog construction by comparing against an explicit expected general command list and the existing group-key contract.

- [ ] **Step 2: Update English and Chinese documentation**

Explain that `/` discovers all composer commands, with `/reply` and group management as current categories. Document `/rep` fuzzy matching, Up/Down, Tab, Enter, Esc, and unchanged reply syntax. Remove wording that implies the menu contains only management commands.

- [ ] **Step 3: Run final checks twice**

Run:

```bash
git diff --check
pnpm test
pnpm typecheck
pnpm test
```

Expected: both full test runs pass, TypeScript exits 0, and no whitespace errors are reported.

- [ ] **Step 4: Smoke-test interactive help text**

Run: `pnpm dev listen --help`

Expected: exit 0 with no warnings; existing listen flags remain unchanged.

- [ ] **Step 5: Commit documentation and contracts**

```bash
git add README.md README.zh-CN.md tests/package.test.ts
git commit -m "docs: document unified listen commands"
```

## Completion Criteria

- `/reply` and every group command share one discovery, ranking, bounds, selection, and completion pipeline.
- `/rep`, `/rpy`, `/ban`, and `/member b` produce the specified matches.
- Reply syntax and execution remain owned by the existing reply parser/executor.
- Group parsing, capability checks, confirmation, and permissions remain owned by the group path.
- Rendering and keyboard behavior use the same six visible matches.
- Ordinary messages, reply context, message IDs, native text selection, attachments, scrolling, reconnect behavior, and group writes remain passing.
- Two consecutive full test runs and `pnpm typecheck` pass.

