# Unified Listen Slash Command Menu Design

## Summary

Replace the group-management-only slash menu in interactive `listen` with one unified composer-command catalog. The first catalog version contains the existing `/reply` command and all existing group-management commands. Future composer commands can become discoverable, fuzzy-matchable, completable, and documented by registering one catalog entry rather than adding UI-specific special cases.

## Goals

- Show `/reply` in the same slash menu as group-management commands.
- Fuzzy-match, rank, render, select, and complete all interactive slash commands through one path.
- Keep each command family's existing parser and executor authoritative.
- Preserve group capability/permission disabling and confirmation behavior.
- Make future general composer commands easy to add without changing menu logic.
- Preserve ordinary message sending, attachments, replies, scrolling, and group-management behavior.

## Non-goals

- Replacing the reply parser or changing `/reply` syntax.
- Combining group-management and reply execution into one large executor.
- Exposing interactive-only commands as ordinary Commander CLI commands.
- Adding new slash commands other than registering the existing `/reply` command.

## Unified Command Model

Add a UI-independent listen command catalog. A command entry describes discovery and presentation, not command-specific parsing or Telegram execution.

Each entry contains:

- a stable command identifier;
- a path, such as `['reply']` or `['member', 'ban']`;
- category: `general` or `group`;
- summary and usage text;
- optional fuzzy-search keywords;
- command kind used for execution dispatch;
- the underlying group definition for group commands.

The general command is defined directly:

```ts
{
  id: 'reply',
  path: ['reply'],
  category: 'general',
  kind: 'reply',
  summary: 'Reply to a message',
  usage: 'reply <message-id> [content] [--file <path> ...]',
  keywords: ['respond', 'message', 'file'],
}
```

Group entries are derived from `GROUP_COMMANDS`. Their path, summary, usage, and canonical group definition are reused rather than copied. This keeps the group parser, service dispatch, help, and interactive menu synchronized.

The catalog must enforce unique IDs and unique paths. Contract tests ensure the reply usage in the catalog matches the usage emitted by the reply parser.

## Matching And Ordering

Matching operates over the unified catalog and recognizes an optional leading slash.

Ranking order is:

1. exact command-path match;
2. command-path prefix match;
3. ordered fuzzy match against command path, summary, and keywords;
4. category priority, with `general` before `group` when scores tie;
5. stable catalog order within a category.

Expected examples:

- `/` shows `reply` before group-management commands;
- `/rep` and `/rpy` match `reply`;
- `/ban` can match `member ban` through its command tokens and keywords;
- `/member b` continues to match `member ban`.

The menu shows at most six matches. Rendering, disabled-state calculation, arrow-key navigation, Tab completion, and Enter submission must consume the same bounded list. A hidden seventh result can never be selected or completed.

## Completion And Menu Interaction

The composer treats input as slash-command input only when `/` is the first non-whitespace character.

- `Up` and `Down` move through visible, enabled matches and wrap at either end.
- `Tab` completes the selected command path and preserves the leading slash and leading whitespace.
- `Enter` completes an incomplete path, displays parser usage for incomplete or invalid arguments, or executes a complete command.
- `Esc` closes the menu or error state without clearing the composer input.
- Ordinary text continues through the existing message-send path.

Completion examples:

```text
/rep  -> /reply 
/mem b -> /member ban 
```

General commands are not subject to group capability checks. Group commands retain the shared group availability evaluation and disabled reason. Keyboard navigation skips disabled group commands.

## Execution Dispatch

The unified catalog is only a discovery and routing layer. Execution remains separated by command kind.

### Reply

The selected input is parsed with the existing `parseListenComposerInput`. A valid reply is executed with `executeListenReply`, using the current listen client and selected target chat.

Supported syntax remains:

```text
/reply <message-id> <content>
/reply <message-id> <caption> --file <path>
/reply <message-id> --file <path> --file <path>
```

Parser errors retain the input and appear above the composer. Successful execution clears the input and reports `replied to #<message-id>`. Failed execution retains the command for editing.

### Group Management

Group commands continue through `parseGroupCommand`, `executeGroupCommand`, `GroupWriteService`, and the existing confirmation/capability UI. The unified layer does not duplicate group parsing, risk rules, permission selection, or mtcute calls.

### Target And Connection Safety

Both command kinds reuse `clientRef.current`; no second Telegram client is created.

- If the connection is not ready, execution fails visibly without clearing the command.
- If multiple chats are listened to without `--send-to`, reply and write commands fail with an ambiguous-target error.
- Async execution retains the existing generation and execution-lock protections, so stale results cannot clear newer input and repeated Enter cannot duplicate writes.

## Components And Boundaries

Add three focused modules:

- `src/listen-commands/catalog.ts`: unified command metadata and derived group entries.
- `src/listen-commands/match.ts`: unified ranking, bounded visible matches, and completion.
- `src/listen-commands/dispatch.ts`: routes a canonical match to reply or group parsing/execution without owning UI state.

Generalize `group-command-menu.tsx` into `listen-command-menu.tsx`. It renders unified matches and delegates group availability checks only for group entries.

The existing `useGroupCommand` state machine may be generalized or wrapped, but group confirmation and permission-selection states remain isolated from reply execution. `InteractiveListen` continues to own composer text, client lifecycle, attachment focus, and modal key priority.

## Errors And Presentation

- No match: keep the input and show no menu rows.
- Incomplete command: complete the path first or show the catalog usage.
- Reply parse error: show the reply parser's message and retain input.
- Group parse error: show the group parser's structured error and retain input.
- Execution error: enter the existing editable error state.
- Result state: group query results remain modal; reply success uses the existing transient composer note rather than creating a fake chat message.

Usage text has one source per command family. Reply catalog metadata must match reply parser usage. Group usage is inherited from `GROUP_COMMANDS`.

## Testing

### Catalog And Matching

- unique unified IDs and paths;
- reply plus every group command are present;
- `/` ranks general commands before group commands on ties;
- `/rep` and `/rpy` match and complete `reply`;
- `/ban` matches `member ban`;
- `/member b` behavior remains unchanged;
- score ties are stable;
- six-item bounds are shared by rendering and keyboard behavior;
- leading whitespace and slash are preserved during completion.

### Parsing And Dispatch

- reply metadata usage matches parser usage;
- valid text and file replies use the existing reply executor;
- reply errors retain input;
- group commands continue through the group parser/executor;
- category routing cannot send a reply through the group service or a group command through reply sending.

### Real Ink Wiring

- `/` renders both reply and group entries;
- `Up`, `Down`, `Tab`, `Enter`, and `Esc` use unified matches;
- `/reply` success clears input and failure retains it;
- group confirmation, disabled-item skipping, and permission selection do not regress;
- ordinary messages and attachment Tab behavior do not regress;
- multi-chat ambiguity and disconnected-client errors make zero Telegram writes;
- stale reply/group completions cannot overwrite newer input;
- repeated Enter cannot duplicate execution.

Final verification is:

```bash
pnpm test
pnpm typecheck
```

