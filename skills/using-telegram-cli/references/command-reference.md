# Telegram CLI command reference

Use this reference for the repository's current `tg` behavior. Confirm flags against `tg <command> --help` because the CLI can evolve.

## Contents

- [Invocation and installation](#invocation-and-installation)
- [Configuration and accounts](#configuration-and-accounts)
- [Chat discovery and synchronization](#chat-discovery-and-synchronization)
- [Local query and data commands](#local-query-and-data-commands)
- [Messaging and listening](#messaging-and-listening)
- [Group operations](#group-operations)
- [Structured output](#structured-output)
- [Data, privacy, and recovery](#data-privacy-and-recovery)

## Invocation and installation

When the package is available from the configured npm registry, install it globally:

```sh
npm install -g @will-17173/telegram-cli
tg --help
```

Repository checkout (Node.js 22+, pnpm dependencies installed):

```sh
pnpm install
pnpm dev --help
pnpm dev search --help
```

Do not use `pnpm dev -- <args>` in this repository. The extra separator reaches Commander as an argument.

## Configuration and accounts

Personal API credentials are recommended for lower flood pressure but optional because the CLI has restricted built-in defaults:

```sh
tg config set --api-id <id> --api-hash '<hash>'
tg config set --proxy socks5://127.0.0.1:1080
tg config list --json
```

`TG_API_ID` and `TG_API_HASH` must be set together and override stored credentials. `TG_PROXY` overrides a stored proxy. A proxy URL can contain credentials or an MTProxy secret. `config list` masks the API hash by default but returns the complete proxy URL.

Only `account add` starts interactive Telegram authentication. A human may need to supply a phone number, login code, and 2FA password:

```sh
tg account add
tg account list --json
tg account current --json
tg account switch <name> --json
tg account remove <name> --force --json
```

Adding `--json` to `account add` only structures the final result; it does not make authentication non-interactive or guarantee prompt-free stdout.

The first account becomes current. Later additions do not change current. Prefer a per-command selection in automation:

```sh
tg whoami --account work --json
tg chats --account work --json
```

## Chat discovery and synchronization

These commands connect to Telegram:

```sh
tg status --account work --json
tg whoami --account work --json
tg chats --account work --json
tg chats --type channel --account work --json
tg info <chat> --account work --json
```

Use chat names, usernames, or numeric IDs. Prefer the ID returned by `chats --json` in scripts. Valid chat types are `user`, `group`, `supergroup`, `channel`, and `unknown`.

`chats --type user` lists private dialogs, not the Telegram address book; no contact-list or contact-sync command exists. If the user needs the complete Telegram contact list, state that this CLI cannot provide it. Do not substitute dialogs for contacts or expand to another API/tool without user direction.

History and sync commands fetch from Telegram and store rows in the selected account's SQLite database:

```sh
tg history <chat> --limit 1000 --delay 1 --account work --json
tg sync <chat> --limit 5000 --delay 1 --account work --json
tg sync-all --max-chats 20 --limit 5000 --delay 1 --account work --json
tg refresh --max-chats 20 --delay 1 --account work --json
```

Use `history` for an explicit historical backfill. Use `sync` for incremental updates and `sync-all`/`refresh` across dialogs. For a chat absent from the local database, `sync`, `sync-all`, and `refresh` cap the first fetch at 500 messages even if `--limit` is higher. Page/chat delays reduce request pressure; default API credentials have stricter flood limits.

`refresh` may return top-level success while individual chats failed, so inspect `data.failures`. `sync-all` intentionally projects the result to `new_messages`, `chats`, and `results` and omits failure details. Use `refresh` instead when a script must reliably identify partial failures.

## Local query and data commands

These commands use only the selected account's local SQLite database and do not connect to Telegram:

```sh
tg search 'release' --chat <chat> --sender <sender> --hours 168 --limit 100 --account work --json
tg search 'error|failed' --regex --account work --json
tg recent --chat <chat> --hours 24 --limit 50 --account work --json
tg today --chat <chat> --account work --json
tg stats --account work --json
tg top --chat <chat> --hours 168 --limit 20 --account work --json
tg timeline --chat <chat> --hours 168 --by hour --account work --json
tg filter 'release urgent' --chat <chat> --hours 24 --account work --json
```

Synchronize first when freshness matters. `chat_not_found` means the target is not in that local database. `ambiguous_chat` means a name matched multiple stored chats; use a numeric ID.

Export reads local data and may write a file. `--format` controls exported content; `--json` controls the command result envelope:

```sh
tg export <chat> --format json --output ./messages.json --hours 24 --account work --json
```

Local deletion requires confirmation and does not delete Telegram messages:

```sh
tg purge <chat> --yes --account work --json
```

## Messaging and listening

The following are real Telegram writes and require explicit user authorization:

```sh
tg send <chat> 'Hello' --account work --json
tg send <chat> 'Caption' --file ./photo.jpg --file ./clip.mp4 --account work --json
tg send <chat> 'Reply' --reply <message-id> --no-preview --account work --json
tg edit <chat> <message-id> 'Updated text' --account work --json
tg delete <chat> <message-id> [more-ids...] --account work --json
```

`send` has no confirmation prompt. Repeated files are sent in order as one Telegram media group, with the optional message as its caption. Telegram validates allowed combinations. Sending does not insert a row into the local database; sync afterward before local search.

`listen` is long-running and does not expose JSON/YAML flags:

```sh
tg listen <chat> --persist --retry-seconds 5 --account work
tg listen <chat> --no-interactive --no-media --account work
tg listen <chat> --no-interactive --auto-download --account work
```

Without chat arguments it listens globally. In an interactive TTY it uses Ink; `--no-interactive` emits plain text. `--auto-download` stores attachments under `~/Downloads/telegram-cli`, including when `--no-media` hides their summaries. For multiple chats, use `--send-to <chat>` before interactive replies or group actions.

## Group operations

Read-only inspection:

```sh
tg group info <chat> --account work --json
tg group members <chat> --type admins --query alice --limit 50 --account work --json
tg group member info <chat> <@username-or-user-id> --account work --json
tg group audit <chat> --user <user> --type member_invited --limit 100 --account work --json
```

Prefer `group member info`; the legacy `group member <chat> <user>` is ambiguous when a chat name equals a reserved action. Member write targets must be `@username` or a numeric user ID.

Discover exact group mutation syntax with nested help:

```sh
tg group --help
tg group member --help
tg group invite create --help
```

Families and actions:

- `member`: add, kick, ban, unban, mute, unmute, purge
- `admin`: promote, demote, rank, transfer-owner
- `chat`: title, description, username, photo, slowmode, ttl, protect, join-requests, join-to-send, default-permissions, sticker-set, leave, delete
- `invite`: list, show, create, edit, revoke, members, approve, decline, approve-all, decline-all
- `topic`: list, create, edit, close, reopen, pin, unpin, reorder, delete, general-hidden
- `message`: pin, unpin, unpin-all, delete

The concrete write syntax places the chat immediately after the action:

```sh
tg group member mute <chat> <user> 2h --yes --account work --json
tg group chat slowmode <chat> 30s --account work --json
```

Commands marked risky reject execution without `--yes`. Permanent chat deletion also requires `--confirm-title '<exact title>'`. Other mutations can execute without built-in confirmation, so authorization is required regardless of CLI safeguards. Permissions and Telegram capabilities (admin, creator, supergroup, or forum) still apply.

## Structured output

Use one explicit format for finite automation commands:

```json
{
  "ok": true,
  "schema_version": "1",
  "data": {}
}
```

Failures use non-zero exit status and:

```json
{
  "ok": false,
  "schema_version": "1",
  "error": {
    "code": "chat_not_found",
    "message": "..."
  }
}
```

Without a format flag, TTY output is human-oriented and non-TTY output defaults to YAML. `OUTPUT=json|yaml|rich` can set a default, but explicit `--json`/`--yaml` wins. Do not parse human tables. For `refresh`, do not assume `ok: true` means every chat succeeded; inspect `data.failures`.

## Data, privacy, and recovery

`DATA_DIR` changes the storage root. The default root is OS-specific. Important files are:

```text
config.json
accounts.json
accounts/<name>/session
accounts/<name>/messages.db
```

Sessions and SQLite messages are sensitive and must not enter version control, logs, tickets, or shared artifacts. Avoid exposing secrets through shell history, process arguments, backups, exports, or `config list --show-secrets`.

Common recovery paths:

- `account_required`: run `tg account add` or select an existing account.
- `account_not_found`: inspect `tg account list --json` and correct `--account`.
- `telegram_account_session_expired` / `AUTH_KEY_UNREGISTERED`: remove the named account with `--force`, then authenticate again.
- `FLOOD_WAIT`: stop retrying aggressively, respect the wait, keep delays, and configure personal API credentials.
- Empty local search: synchronize the correct chat and account first.
