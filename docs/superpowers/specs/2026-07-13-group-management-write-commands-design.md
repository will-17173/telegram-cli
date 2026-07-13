# Group Management Write Commands Design

## Summary

Add complete Telegram group-management write operations to both the ordinary `group` CLI and the interactive `listen <chat>` composer. Both surfaces share one command catalog, parser, validation layer, executor, service API, and result contract. The `listen` composer opens a Codex-style command menu when the first non-whitespace character is `/`.

The implementation uses mtcute high-level `TelegramClient` methods wherever possible. Raw TL calls are allowed only where mtcute has no suitable high-level method.

## Goals

- Cover member, administrator, group setting, invite, join-request, forum-topic, and message-management writes.
- Provide the same command hierarchy and behavior in Commander and interactive `listen`.
- Reuse the client already connected by `listen`; do not create a second Telegram connection for interactive commands.
- Provide fuzzy command discovery, completion, precise validation, safe confirmation, and structured results.
- Preserve existing message sending, attachment downloading, scrolling, reconnection, and non-interactive output behavior.

## Non-goals

- Selecting a member by replying to a message. Member targets are explicit usernames or numeric Telegram IDs.
- Collecting or storing the Telegram two-step-verification password required by some ownership transfers.
- Automatically retrying Telegram write operations after `FLOOD_WAIT`.
- Treating command results as Telegram chat messages.

## Command Hierarchy

In `listen <chat>`, every command acts on the current chat. If several chats are being listened to, a management command is disabled unless `--send-to <chat>` identifies one target. Ordinary CLI commands receive `<chat>` explicitly.

### Members

```text
/member add <user...>
/member kick <user>
/member ban <user>
/member unban <user>
/member mute <user> [duration]
/member unmute <user>
/member purge <user>
```

`<user>` accepts `@username` or a numeric Telegram ID. `mute` restricts sending messages and media, either indefinitely or until the supplied duration expires.

### Administrators

```text
/admin promote <user> [rights...]
/admin demote <user>
/admin rank <user> <title>
/admin transfer-owner <user>
```

If `promote` has no rights arguments, the interactive surface opens a permission-selection confirmation view. The non-interactive CLI reports the available rights and requires an explicit selection instead of silently granting every right.

### Group Settings

```text
/chat title <text>
/chat description <text>
/chat username <username|off>
/chat photo <path|off>
/chat slowmode <duration|off>
/chat ttl <duration|off>
/chat protect <on|off>
/chat join-requests <on|off>
/chat join-to-send <on|off>
/chat default-permissions <permissions...>
/chat sticker-set <name|off>
/chat leave
/chat delete
```

### Invites And Join Requests

```text
/invite list
/invite show <link>
/invite create [options...]
/invite edit <link> [options...]
/invite revoke <link>
/invite members <link>
/invite approve <user>
/invite decline <user>
/invite approve-all
/invite decline-all
```

Invite creation and editing options expose the capabilities supported by mtcute, including expiry, usage limits, join requests, and title where applicable.

### Forum Topics

```text
/topic list
/topic create <title>
/topic edit <topic-id> <title>
/topic close <topic-id>
/topic reopen <topic-id>
/topic pin <topic-id>
/topic unpin <topic-id>
/topic reorder <topic-id...>
/topic delete <topic-id>
/topic general-hidden <on|off>
```

### Message Management

```text
/message pin <message-id>
/message unpin <message-id>
/message unpin-all
/message delete <message-id...>
```

### Argument Conventions

- Durations accept values such as `30s`, `10m`, `2h`, and `7d`; `off` disables a timed setting.
- Boolean settings consistently accept `on` and `off`.
- Quoted strings and escaped characters follow shell-like rules. For title and description arguments, the remaining input may also be consumed as one string.
- Photo paths support spaces and home-directory (`~`) expansion.
- Ordinary CLI paths mirror interactive paths, for example `tg group member ban <chat> @alice` and `tg group topic create <chat> "Announcements"`.

## Shared Architecture

### Command Catalog

A UI-independent group command catalog defines:

- command path;
- summary and usage;
- positional arguments and options;
- risk level;
- group/account capability requirements;
- parser and validator selection;
- executor identifier;
- result presentation metadata.

The catalog must not import Commander, Ink, React, or mtcute. Command paths must be unique. Both user interfaces derive discovery and help data from it.

### Parser And Completion

A shared parser provides:

- shell-like tokenization with quotes and escapes;
- exact command matching;
- fuzzy matching for the interactive menu;
- command-path completion;
- typed parsing for users, IDs, durations, booleans, permissions, paths, and lists;
- structured missing-argument and invalid-argument errors.

Parsing produces a typed command request. Telegram calls never receive unvalidated raw token arrays.

### Services And Telegram Adapter

Extend `GroupService` and `TelegramGroupManagementAdapter` with explicit typed request and result objects for each operation family. `MtcuteGroupManagement` maps these types to mtcute calls.

The preferred mtcute high-level methods include:

- members: `addChatMembers`, `kickChatMember`, `banChatMember`, `unbanChatMember`, `restrictChatMember`, `unrestrictChatMember`, and `deleteUserHistory`;
- administrators: `editAdminRights`, `editChatMemberRank`, and `transferChatOwnership`;
- settings: `setChatTitle`, `setChatDescription`, `setChatUsername`, `setChatPhoto`, `deleteChatPhoto`, `setSlowMode`, `setChatTtl`, `toggleContentProtection`, `toggleJoinRequests`, `toggleJoinToSend`, `setChatDefaultPermissions`, and `setChatStickerSet`;
- invites and requests: invite-link creation/editing/revocation/listing and join-request approval/decline methods;
- topics: forum-topic creation/editing/listing/closing/pinning/reordering/deletion and general-topic visibility methods;
- messages: `pinMessage`, `unpinMessage`, `unpinAllMessages`, and existing message deletion support;
- lifecycle: `leaveChat`, `deleteGroup`, and `deleteSupergroup`.

Exact signatures must be verified against the installed mtcute version before implementation. Raw TL is used only for a catalog operation that lacks a high-level method.

### Shared Executor

The executor accepts a parsed request, target chat, group adapter, and confirmation authorization. It:

1. validates the target and known capabilities;
2. decides whether confirmation is required;
3. calls `GroupService`;
4. maps failures to stable command error codes;
5. returns a structured result suitable for CLI or Ink presentation;
6. invalidates cached group information after writes that can change capabilities or settings.

## Interactive Listen Experience

Typing `/` as the first non-whitespace character opens a panel above the composer. Ordinary text continues through the current message-send path.

The panel shows matching command paths and summaries. Matching is fuzzy across both fields. Keyboard behavior is:

- `Up` and `Down`: move through matches, wrapping at either end;
- `Tab`: complete the selected command and retain composer focus;
- `Enter`: complete an incomplete command, report missing arguments, or execute a complete command;
- `Esc`: close the confirmation or command panel without clearing input.

While a command executes, the composer is locked and the note area shows a specific progress message. Success clears the command and shows a transient result. Failure preserves the command so the user can edit and retry.

Multi-row query results such as invite lists and forum topics use the existing Ink table/detail presentation style in an overlay-like result view. `Esc` returns to the chat stream.

Commands unavailable for the known group type or current account permissions remain discoverable but appear dimmed with the reason. Server-side permission checks remain authoritative.

## Confirmation And Safety

The interactive surface presents `Confirm` and `Cancel` choices operated by arrow keys and Enter. Confirmation content names the chat, target, duration, and side effects. The confirmation stores an immutable parsed request, so later input changes cannot alter the pending action.

Confirmation is required for at least:

- ban, kick, member-history purge, and administrator changes;
- ownership transfer;
- group leave and deletion;
- invite revocation and bulk join-request decisions;
- topic-history deletion;
- message deletion and bulk unpinning.

Group deletion uses a second confirmation step requiring the exact group title. Ownership-transfer password handling is outside this feature; an RPC response requiring a password becomes a specific actionable error.

For the ordinary CLI, risky operations require `--yes`. In non-TTY execution they fail safely without it. The CLI does not open the Ink confirmation UI.

`FLOOD_WAIT` reports the retry interval and never automatically repeats a write operation. Local photo paths are not included in persistent logs or audit summaries.

## Errors And Results

Normalize errors into stable categories, including:

- group or member not found;
- administrator privileges required;
- specific permission missing;
- unsupported group or account type;
- invalid argument or incompatible options;
- connection not ready;
- flood wait with duration;
- two-step-verification/password required;
- Telegram RPC failure.

Human output is concise and actionable. JSON and YAML retain stable structured fields. Successful writes return the updated entity where practical, otherwise an action summary containing chat, target, operation, and effective settings.

The interactive client is never duplicated. If it is disconnected, a command waits for the existing reconnection lifecycle when appropriate or reports that the connection is not ready.

## Testing

### Parser And Catalog

- quotes, escapes, remaining-text arguments, usernames, IDs, lists, paths, durations, booleans, and permissions;
- fuzzy matching, ordering, completion, missing arguments, and invalid arguments;
- unique catalog paths and required risk markings;
- Commander and Ink compatibility with every catalog entry.

### Service And Adapter

- success behavior for every operation family;
- exact high-level mtcute method and argument mapping;
- legacy group versus supergroup/forum behavior;
- normalized RPC, permission, flood-wait, and not-found errors;
- raw update handling for any operation that must use TL directly.

### Commander

- full nested command tree and help;
- validation, `--yes`, JSON/YAML contracts, and exit codes;
- safe refusal of risky non-interactive operations without authorization.

### Ink

- opening the menu with `/`, fuzzy filtering, selection, completion, execution, and escape behavior;
- confirmation and cancellation, immutable pending requests, and double confirmation for group deletion;
- disabled capabilities, disconnection, and ambiguous multi-chat targeting;
- progress, success, error, and multi-row result views;
- regression coverage for ordinary message sending, attachments, scrolling, resizing, reconnection, and exit.

Final verification is `pnpm test && pnpm typecheck`.

## Delivery Sequence

1. Add the shared catalog, parser, typed requests, and catalog/parser tests.
2. Extend the adapter and service with complete write operations and tests.
3. Register the ordinary `group` CLI tree and structured outputs.
4. Add the `listen` command menu, completion, results, and executor integration.
5. Add confirmations, capability-aware presentation, full regression tests, and final verification.

