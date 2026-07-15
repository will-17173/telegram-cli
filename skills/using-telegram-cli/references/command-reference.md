# Telegram CLI command reference

Use this reference for the repository's current `tg` behavior. Confirm flags against `tg <command> --help` because the CLI can evolve.

## Contents

- [Invocation and installation](#invocation-and-installation)
- [Configuration and accounts](#configuration-and-accounts)
- [Chat discovery and synchronization](#chat-discovery-and-synchronization)
- [Online reads, contacts, notifications, and folders](#online-reads-contacts-notifications-and-folders)
- [Local query and data commands](#local-query-and-data-commands)
- [Archiving](#archiving)
- [Messaging and listening](#messaging-and-listening)
- [Group operations](#group-operations)
- [Structured output](#structured-output)
- [Error codes and recovery](#error-codes-and-recovery)
- [Data and privacy](#data-and-privacy)

## Invocation and installation

Require Node.js 22 or later for both the published package and repository checkout. Follow the executable bootstrap in [../SKILL.md](../SKILL.md) before running a user-requested command. When the package is available from the configured npm registry, install it globally:

```sh
npm install -g @will-17173/telegram-cli
tg --help
```

Repository checkout (pnpm dependencies installed):

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

`TG_API_ID` and `TG_API_HASH` must be set together and override stored credentials. `TG_PROXY` overrides a stored proxy. `config list` reports the effective sources; the API ID is visible, while the API hash is masked by default. `--show-secrets` reveals only the complete API hash among credential fields: proxy usernames, passwords, and credential query parameters (`secret`, `user`, `pass`, `username`, `password`) remain `***` in every format. Safe proxy endpoint details and non-credential query parameters may remain visible; malformed proxy URLs render as `[invalid proxy URL]`.

`account add` starts authentication for a new registration. `account login` reauthenticates an existing logged-out registration. A human may need to supply a phone number, login code, and 2FA password:

```sh
tg account add
tg account list --json
tg account current --json
tg account switch <name> --json
tg account logout work --yes --json
tg account login work --json
tg account remove <name> --force --json
```

Adding `--json`/`--yaml` only structures the result; authentication still requires an interactive TTY. `account logout [name]` uses the current account when omitted and requires `--yes` in non-TTY use. Logout invalidates the Telegram session but retains the registration and messages database; login replaces the session safely and retains that database. A logged-out account can still run local SQLite queries.

If non-TTY login returns `interaction_required`, rerun `tg account login <name>` in an interactive terminal; do not pipe credentials. Session replacement is staged and rolled back where possible. If a failure includes `error.details.recovery_path` or `recovery_paths`, preserve those paths, report them securely, and do not delete or overwrite them while recovering.

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

`chats --type user` lists private dialogs, not the Telegram address book. Use `contact list` for contacts.

History and sync commands fetch from Telegram and store rows in the selected account's SQLite database:

```sh
tg history <chat> --limit 1000 --delay 1 --account work --json
tg sync <chat> --limit 5000 --delay 1 --account work --json
tg sync-all --max-chats 20 --limit 5000 --delay 1 --account work --json
tg refresh --max-chats 20 --delay 1 --account work --json
```

Use `history` for a count-bounded historical backfill. Use `sync` for incremental updates and `sync-all`/`refresh` across dialogs. These persistence commands accept limit/delay controls, not `--since` or `--until`; an identical time-bounded `read` range cannot be persisted directly. Fetch enough history, then use local query filters for the desired range. For a chat absent from the local database, `sync`, `sync-all`, and `refresh` cap the first fetch at 500 messages even if `--limit` is higher. Page/chat delays reduce request pressure; default API credentials have stricter flood limits.

`refresh` may return top-level success while individual chats failed, so inspect `data.failures`. `sync-all` intentionally projects the result to `new_messages`, `chats`, and `results` and omits failure details. Use `refresh` instead when a script must reliably identify partial failures.

## Online reads, contacts, notifications, and folders

These finite commands query Telegram and do not persist messages to SQLite:

```sh
tg inbox --limit 50 --account work --json
tg read @ops --limit 100 --since 2h --account work --json
tg read @ops --since '2026-07-14T08:00:00+08:00' --until '2026-07-14T10:00:00+08:00' --account work --yaml
tg search-online 'incident' --limit 100 --since 2h --account work --json
tg search-online 'incident' --chat @ops --until '2026-07-14T10:00:00+08:00' --account work --json
tg contact list --limit 100 --account work --json
tg contact info @alice --account work --json
tg group list --admin --limit 100 --account work --json
```

`inbox` lists unread dialogs without marking messages read. `read` is a transient server read, not a persistence command. Use `history` or `sync` when messages must enter SQLite. `search-online` searches Telegram globally unless `--chat` scopes it; local `search` never contacts Telegram. Time bounds accept positive relative durations (`2h`, meaning two hours before execution) or ISO timestamps with a zone (`2026-07-14T08:00:00+08:00` or `Z`); `--since` must be earlier than `--until`.

The `dialog` family provides alternate paths with the same behavior and flags. Prefer the shorter top-level commands in automation, but recognize both forms:

```sh
tg dialog inbox --account work --json
tg dialog read @ops --since 2h --account work --json
tg dialog search 'incident' --chat @ops --account work --json
tg dialog groups --admin --account work --json
```

Notification inspection is read-only; mute/unmute mutate Telegram:

```sh
tg notification info @ops --account work --json
tg notification mute @ops 2h --account work --json
tg notification unmute @ops --account work --json
```

Mute duration is a positive integer plus `s`, `m`, `h`, `d`, or `w`, or `forever`; omission defaults to `forever`.

Folder list/info are read-only; explicit chat membership changes mutate Telegram:

```sh
tg folder list --account work --json
tg folder info 3 --account work --json
tg folder chat add 3 @ops --account work --json
tg folder chat remove 3 @ops --account work --json
```

Folder titles may be ambiguous. Discover folders with `folder list`, then prefer the returned numeric folder ID for `info`, `chat add`, and `chat remove`.

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

## Archiving

Archive writes Markdown files but does not populate SQLite:

```sh
tg archive @ops --account work --json
tg archive @ops --since '2026-07-12T10:00:00+08:00' --until '2026-07-14T10:00:00+08:00' --download-media --account work --json
tg archive --all --full --output ./telegram-archive --account work --markdown
tg archive @ops --rebuild --account work --yaml
```

Specify one or more chats or `--all`, never both. Without a range, the first run archives the preceding seven days; `--since`/`--until` set an explicit range and `--full` requests all history (`--full` conflicts with `--since`). Later runs are incremental, resuming from the manifest and embedded Markdown message markers. `--rebuild` replaces chat files using the recorded initial range unless a new range or `--full` is supplied. `--download-media` stores attachments under `media/` and retries missing referenced downloads.

Any chat or media failure yields non-zero status, top-level `ok: false`, and `error.code: archive_partial_failure`. For automation use `--json` or `--yaml` and inspect `error.details.completed`, `error.details.failed`, and `error.details.warnings`. Treat the overall operation as failed even when some chats completed. Markdown is only a human-facing rendering and does not preserve the full `error.details`; never derive partial-failure accounting from it.

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

`listen` is long-running and does not expose JSON/YAML/Markdown flags:

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
tg group list --admin --limit 100 --account work --json
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
tg group admin transfer-owner <chat> <@username-or-user-id> --yes --account work --json
```

Commands marked risky reject execution without `--yes`. Permanent chat deletion also requires `--confirm-title '<exact title>'`. Other mutations can execute without built-in confirmation, so authorization is required regardless of CLI safeguards. Permissions and Telegram capabilities (admin, creator, supergroup, or forum) still apply.

Ownership transfer requires the current user to be the creator. After `--yes`, the CLI securely prompts for the Telegram 2FA password in an interactive TTY. Never provide or request that password in plain text, place it in command arguments/environment/stdin automation, or automate the prompt. Non-TTY ownership transfer returns an interaction error; have the human run it interactively and enter the password directly into the prompt.

## Remote write access

Check the local safety gate before planning a remote mutation:

```sh
tg config write-access status --json
tg config write-access on --json
tg config write-access off --json
```

Omitting `status` also reports the setting. Enabling the gate is a local configuration mutation, but requires explicit user authorization; it does not authorize any Telegram mutation. Obtain separate explicit authorization immediately before the specific remote write.

The gate applies to remote mutations only: `send`, `edit`, `delete`, notification `mute`/`unmute`, folder `chat add`/`chat remove`, and non-read-only group actions. It does not block Telegram reads, local SQLite queries/exports/purge, sync/history/archive persistence, account lifecycle, or configuration changes. When off, gated commands fail with `write_access_disabled` before connecting for the mutation.

## Structured output

Select exactly one output format for a finite command: `--json` or `--yaml` for a structured envelope, or `--markdown` for human-facing rendering. JSON/YAML are required for automation and stable `ok`, `data`, and `error.details` fields. Markdown failures do not preserve full structured details, so do not use Markdown for automated failure accounting.

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

Without a format flag, TTY output is human-oriented and non-TTY output defaults to YAML. `OUTPUT=json|yaml|rich` can set a default, but an explicit flag wins. Never combine any of `--json`, `--yaml`, and `--markdown`; do not parse human tables. `listen` is streaming and has no format flags. For `refresh`, do not assume `ok: true` means every chat succeeded; inspect `data.failures`.

## Error codes and recovery

Handle v0.5.0 errors by code instead of matching message text:

- Accounts: `account_logged_out`, `account_identity_mismatch`, and `interaction_required` require selecting, verifying, or interactively reauthenticating the named account.
- Contacts: `contact_not_found` means Telegram could not resolve the supplied ID, username, or phone number.
- Notifications and folders: validate mute durations after `invalid_notification_duration`; use a numeric folder ID for `folder_not_found` or `ambiguous_folder`; do not retry unsupported changes after `folder_operation_unsupported`.
- Archives: use a separate output root after `archive_account_mismatch`; report `archive_failed`; inspect completed chats, failures, and warnings after `archive_partial_failure`. Individual attachment warnings use `archive_media_failed`.
- Ownership transfer: prompt interactively again after `password_required` or `password_invalid`. For `password_too_fresh` or `session_too_fresh`, report the wait details and do not retry early.
- Safety and rate limits: request authorization before changing `write_access_disabled`; respect the reported delay after `flood_wait`.

Common recovery paths:

- `account_required`: run `tg account add` or select an existing account.
- `account_not_found`: inspect `tg account list --json` and correct `--account`.
- Logged-out registered account: local SQLite queries remain available; run `account login <name>` in an interactive TTY for Telegram access.
- `interaction_required` from account login or ownership transfer: rerun interactively; never pipe authentication or ownership secrets.
- `telegram_account_session_expired` / `AUTH_KEY_UNREGISTERED`: remove the named account with `--force`, then authenticate again.
- `FLOOD_WAIT`: stop retrying aggressively, respect the wait, keep delays, and configure personal API credentials.
- Empty local search: synchronize the correct chat and account first.

## Data and privacy

`DATA_DIR` changes the storage root. The default root is OS-specific. Important files are:

```text
config.json
accounts.json
accounts/<name>/session
accounts/<name>/messages.db
```

Sessions and SQLite messages are sensitive and must not enter version control, logs, tickets, or shared artifacts. Avoid exposing secrets through shell history, process arguments, backups, exports, or `config list --show-secrets`.
