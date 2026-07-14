# Telegram CLI

[简体中文](README.zh-CN.md)

A TypeScript command-line client for syncing Telegram chats, listening to live messages, searching locally stored messages, and inspecting groups from the terminal.

## What you can do

- Manage multiple Telegram accounts with isolated sessions and message databases.
- Sync chat history to SQLite for offline search, filtering, analysis, and export.
- Listen for new messages and download incoming attachments.
- Send, edit, and delete messages from the command line.
- Inspect and manage groups, members, administrators, invites, and forum topics.
- Use human-readable output or structured JSON and YAML in scripts and agent workflows.

## Built for AI agents

Telegram CLI gives AI agents a command-based interface to Telegram and locally synced messages. After you authenticate an account with `tg account add`, an agent can run online and local commands without browser automation.

The CLI supports agent workflows through these interfaces:

- JSON and YAML output gives agents structured data instead of terminal-formatted text.
- Nonzero exit codes and structured error codes let agents detect and handle failures.
- `--account <name>` selects an explicit account without changing the current account.
- Local search and analysis commands let agents inspect synced messages without reconnecting to Telegram.

For example, an agent can search one account and parse the result as JSON:

```sh
tg search "release" --account work --json
```

### Agent skill

Install the [`using-telegram-cli`](https://skills.sh/will-17173/telegram-cli/using-telegram-cli) skill to teach a supported AI coding agent how to authenticate accounts, synchronize and query messages, automate structured output, and guard Telegram write operations:

```sh
npx skills add https://github.com/will-17173/telegram-cli \
  --skill using-telegram-cli
```

Add `--global` to make the skill available across projects instead of installing it into the current project.

## Installation

Telegram CLI requires Node.js 22 or later.

Install the package globally from npm:

```sh
npm install -g @will-17173/telegram-cli
```

## Quick start

Authenticate an account, check its status, and list its chats:

```sh
tg account add
tg status
tg chats
```

Choose a chat name, username, or ID from `tg chats`, then sync and search its messages:

```sh
tg sync <chat>
tg search "keyword" --chat <chat>
```

You can also sync multiple chats, listen for incoming messages, or send a message:

```sh
tg sync-all --max-chats 20 --delay 1
tg listen <chat-or-id> --auto-download
tg send <chat> "Hello from tg"
```

## Read and manage Telegram online

`history`, `sync`, and `sync-all` fetch Telegram messages and persist them in the local SQLite database. By contrast, `read`, `search-online`, and `inbox` query Telegram directly and return transient results without adding them to the local message database. `inbox` only lists chats with unread messages; it does not mark any message as read.

```sh
tg inbox --markdown
tg read @team --since 7d --until 2d
tg search-online release --chat @team --json
```

Time bounds accept relative durations ending in `s`, `m`, `h`, `d`, or `w`, such as `7d`, and ISO timestamps that include a zone, such as `2026-07-13T00:00:00Z` or `2026-07-13T08:00:00+08:00`. Relative values mean that duration before the command starts; `--since` must be earlier than `--until`.

Contacts, notification settings, folders, and managed groups are also available as online commands:

```sh
tg contact info +8613800000000
tg notification mute @team 8h
tg folder chat add Work @team
tg group list --admin
```

Folder commands accept either a title or numeric folder ID. Titles are not necessarily unique: first use `tg folder list`, then prefer the returned folder ID for `folder info` and `folder chat add/remove`, especially in scripts.

## Configuration

Personal Telegram application programming interface (API) credentials are optional. To use your own, create them at [my.telegram.org](https://my.telegram.org), then save them with:

```sh
tg config set --api-id <id> --api-hash <hash>
```

If both `TG_API_ID` and `TG_API_HASH` are unset and the saved configuration file is missing, the CLI uses built-in Telegram API credentials. When a Telegram client is created, it writes this warning to stderr once per process:

```text
warning: using default Telegram API credentials, which have stricter flood limits and may trigger FLOOD_WAIT during frequent or large requests. Run tg config set --api-id <id> --api-hash <hash> to configure your own.
```

Setting only one of `TG_API_ID` or `TG_API_HASH` is an error. A malformed or unreadable saved configuration file is also an error; the CLI does not fall back to the built-in credentials in either case.

Personal credentials are stored locally as sensitive configuration. Never share them. API credentials are shared by all registered accounts, while each account keeps its own authentication session.

To persist a proxy for Telegram connections, run:

```sh
tg config set --proxy socks5://127.0.0.1:1080
```

For a one-command override, set `TG_PROXY` in the command environment:

```sh
TG_PROXY=http://127.0.0.1:8080 tg status
```

Telegram CLI supports SOCKS4, SOCKS5, HTTP, HTTPS, and MTProxy. The proxy applies to account login and every Telegram-backed command. Treat proxy URLs that contain credentials as sensitive.

To inspect the effective configuration in human-readable, JSON, or YAML format, run:

```sh
tg config list
tg config list --json
tg config list --yaml
tg config list --show-secrets
```

This reports the effective configuration rather than the raw contents of `config.json`. The API hash is masked by default; use `--show-secrets` to display it in full.

Run `tg account add` to authenticate and create a local session. Other commands never start the interactive login flow.

You can override the root directory for configuration, account sessions, and message databases:

```sh
export DATA_DIR=/path/to/tg-cli-data
```

## Send messages and attachments

`send` requires `<chat>`. Send text, one or more files, or files with a caption:

```sh
# Text only
tg send <chat> "Text only"

# Files only; repeat --file to preserve this order
tg send <chat> --file ./photo.jpg --file ./clip.mp4

# Caption and files
tg send <chat> "Group caption" --file ./photo.jpg --file ./clip.mp4
```

`--file` is repeatable. Multiple files are sent in the specified order as one Telegram media group. The message is optional only when at least one file is present. When files are present, the message becomes the group caption; the CLI does not send it as a separate text message.

Telegram determines which file combinations and group sizes it accepts. If Telegram rejects the requested combination or limit, the command returns an error and does not silently split the files into separate messages or groups.

## Archive chats as Markdown

`archive` requires a scope: pass one or more chat IDs/usernames, or use `--all` (not both). It uses the current account unless `--account <name>` is supplied, and writes by default to that account's `archive` data directory; use `--output <path>` to override it.

```sh
# Initial archive with attachments: the preceding seven days
tg archive @team --download-media

# Custom range (relative durations or ISO timestamps with zones)
tg archive @team --since 30d --until 2026-07-13T00:00:00Z

# Full available history for every chat, including attachments
tg archive --all --full --download-media
```

The first run defaults to exactly the preceding seven days. `--since` and `--until` select a custom range, while `--full` removes the lower bound and cannot be combined with `--since`. Later runs are incremental: the manifest and embedded message markers recover the highest archived message even if their cursors differ. `--rebuild` replaces each Markdown file, reusing its recorded initial range unless a new range or `--full` is given. `--download-media` stores downloadable attachments under the archive's `media/` directory and retries missing referenced media during incremental recovery.

Chat or attachment failures produce `archive_partial_failure`, preserve successful chat results, and exit with status 1. Use `--json` or `--yaml` in automation and inspect `completed`, `failed`, and `warnings`.

Archiving performs potentially large Telegram history and media requests, so it can encounter flood waits or other rate limits. Media downloads can fail independently: successfully archived messages and chats remain on disk, warnings identify failed attachments, and any partial failure still causes a nonzero exit.

## Multiple accounts

Each Telegram account has its own persisted authentication session and local message database. Add and authenticate an account interactively with:

```sh
tg account add
```

The first account you add becomes the current account. Adding another account does not switch the current account automatically. Use the account commands to inspect or change the selection:

```sh
# List registered accounts
tg account list

# Show the current account
tg account current

# Choose the default account from an interactive list
tg account switch

# Set the default account by name
tg account switch <name>

# Remove an account and its local session/data
tg account remove <name> --force
```

To end the remote session without deleting the registered account, its settings, or locally stored messages, log out explicitly. Login authenticates that same registered account again and restores its Telegram session:

```sh
tg account logout work --yes
tg account login work
```

In an interactive terminal, `tg account switch` lists registered accounts, marks the current one, and accepts its number. Pass `<name>` when scripting or using `--json`, `--yaml`, or non-interactive input.

Commands use the current account by default. Commands that support `--account` can target another registered account for one invocation without changing the current account:

```sh
tg chats --account <name>
tg sync-all --account <name>
tg search "keyword" --account <name>
```

Account names are shown by `tg account list`; they are normally derived from the Telegram username. Sessions and message databases remain isolated under each account's directory inside `DATA_DIR`.

Telegram API credentials apply to every registered account. You don't need to configure separate API credentials when adding another account.

## Group management

The `group` command supports read-only inspection and management of members, administrators, chat settings, invite links, forum topics, and messages. Use each command group's help to see its actions:

```sh
# Group details
tg group info <chat> --account alice --json

# Member list: type, name/username query, and bounded result count
tg group members <chat> --type admins --query alice --limit 50 --yaml

# One member's role, administrator rights, and restrictions
tg group member <chat> <user>

# Administrator audit log; --user and --type can be repeated
tg group audit <chat> --query invite --user <user> --type member_invited --type invite_changed --limit 100 --account alice --json

# Management examples (the chat argument comes before action arguments)
tg group member ban @team @alice --yes
tg group chat slowmode @team 30s
tg group topic --help
```

`group members` accepts exactly these seven `--type` filters: `recent`, `all`, `admins`, `banned`, `restricted`, `bots`, and `contacts`. It defaults to `recent` and 100 results; `--limit` accepts 1 through 200. Telegram can return fewer members than its reported total, so a page is not guaranteed to enumerate the whole group.

`group audit` requires group administrator rights. Its `--limit` range is 1 through 500, with a default of 100 events. Its repeatable `--user` filter selects action authors. The repeatable `--type` filter accepts these event groups:

- **Chat**: `info_changed`, `settings_changed`
- **Members**: `member_joined`, `member_left`, `member_invited`, `member_banned`, `member_unbanned`, `member_restricted`, `member_unrestricted`
- **Administrators**: `admin_promoted`, `admin_demoted`
- **Messages**: `message_deleted`, `message_edited`, `message_pinned`
- **Invites and topics**: `invite_changed`, `topic_changed`
- **Other**: `other`

Inspection and management actions use human-readable output by default; actions that expose `--json` or `--yaml` provide structured success or error output. Failures set a nonzero exit status. They use the current account unless `--account <name>` selects another registered account for that invocation.

Management actions are grouped under `member`, `admin`, `chat`, `invite`, `topic`, and `message`. Member targets must be explicit `@username` values or numeric Telegram user IDs. Durations accept `s`, `m`, `h`, and `d` suffixes, or `off` where disabling is supported. For example, `tg group member mute @team @alice 2h --yes` temporarily mutes a member, while `tg group chat slowmode @team off` disables slow mode.

Potentially destructive CLI actions refuse to connect to Telegram unless `--yes` is present. Permanently deleting a chat additionally requires `--confirm-title` with the exact current title. Interactive listen mode presents these confirmations in an Ink modal. Management requires the relevant administrator permission, and some actions require a supergroup, forum, or creator role. Ownership transfer reads the Telegram 2FA password from a secure interactive terminal prompt after confirmation. Users and agents must never automate that prompt or pass the password as a command argument, environment variable, or logged input.

Use `tg group member info <chat> <user>` as the canonical member-details route. The legacy `tg group member <chat> <user>` form remains available, but a chat name matching a reserved member action such as `ban`, `mute`, or `info` is ambiguous and requires the canonical route.

## Slash commands while listening

Interactive `tg listen` presents every supported slash command in one menu. This includes `/reply` and the complete group-management catalog; group commands use the same management grammar without repeating the selected chat:

```text
/reply <message-id> <content>
/member mute @alice 2h
```

Typing `/` opens the unified command menu, with reply first. Matching ranks exact paths, prefixes, then ordered fuzzy matches, so `/rep` and `/rpy` find `/reply`, while `/ban` finds `/member ban`. Use **Up** and **Down** to move through matches. **Tab** completes the selected command. **Enter** completes an incomplete selection or runs a complete command. **Esc** closes the menu, result, or confirmation.

Group-command availability and permission checks are unchanged: unavailable actions remain disabled, risky actions open a confirmation modal, and chat deletion also asks for the exact title. When listening to more than one chat, set an unambiguous outgoing target with `--send-to <chat>` before using group commands, for example `tg listen @team @ops --send-to @team`.

## Online and local commands

Online commands connect to Telegram and require a valid session. `read`, `search-online`, and `inbox` return transient results; `inbox` does not mark messages read. `history`, `sync`, `sync-all`, and `refresh` persist fetched messages locally. Other online commands include `status`, `whoami`, `chats`, `contact`, `notification`, `folder`, `archive`, `info`, all `group` inspection and management commands, `send`, `edit`, `delete`, and `listen`. Global online search and large archives can trigger Telegram flood waits or other rate limits.

Local commands read or modify the selected account's message database without connecting to Telegram. These include `search`, `recent`, `stats`, `top`, `timeline`, `today`, `filter`, `export`, and `purge`.

## Review recent messages

`tg recent` shows messages stored during the last 24 hours, with a default limit of 50. Filter the results by chat or sender, or change the time window and limit:

```sh
tg recent --chat <chat> --sender <sender> --hours 6 --limit 100
```

Human-readable output groups each Telegram media group into one row and summarizes its attachments. The `ID` column lists every source message ID in that row. Replies include the original message's time, sender, ID, and text when the target exists locally in the same chat. Otherwise, the output identifies the missing local message ID.

JSON and YAML output keep the stored-message structure for scripts. `recent` reads local SQLite data and does not connect to Telegram.

## Command reference

Run the built-in help for the complete, current command list:

```sh
tg --help
```

Common commands:

| Command | Purpose |
| --- | --- |
| `tg account add` | Authenticate and register another Telegram account. |
| `tg account list` | List registered accounts and show which one is current. |
| `tg account current` | Show the current account. |
| `tg account switch [name]` | Select the default account interactively or set it by name. |
| `tg account remove <name> --force` | Remove an account and its local session/data. |
| `tg account logout <name> --yes` / `tg account login <name>` | End or restore authentication while retaining the registered account and local messages. |
| `tg status` | Check whether the Telegram account is authenticated. |
| `tg whoami` | Show basic authenticated account information. |
| `tg config set --api-id <id> --api-hash <hash>` | Save Telegram API credentials for persistent use. |
| `tg config set --proxy <url>` | Save an optional proxy for account login and Telegram-backed commands. |
| `tg config list [--show-secrets]` | Show effective configuration values and sources; the proxy URL is always visible. |
| `tg config write-access [status\|on\|off]` | Inspect or gate remote Telegram mutations. |
| `tg chats` | List available chats. |
| `tg inbox` | List unread dialogs online without marking messages read. |
| `tg read <chat> [--since <time>] [--until <time>]` | Read recent Telegram messages without persisting them locally. |
| `tg search-online <query> [--chat <chat>]` | Search Telegram globally or within one chat without persisting results. |
| `tg contact list` / `tg contact info <user_or_phone>` | List contacts or resolve one by ID, username, or phone. |
| `tg notification info/mute/unmute <chat>` | Inspect or change Telegram notification settings. |
| `tg folder list/info/chat --help` | Discover folders and inspect or change their explicit chats. |
| `tg history <chat> -n <limit>` | Fetch and store full chat history (default up to 1000 messages). |
| `tg sync <chat>` | Incrementally sync new messages for one chat. |
| `tg sync-all` | Sync messages from all chats, using local last-message IDs for incremental updates. |
| `tg refresh` | Alias-like command for bulk sync with same runtime options as `sync-all`. |
| `tg listen [chat ...]` | Stream incoming messages from selected chats or all chats. |
| `tg listen --no-media` | Hide attachment summary lines while listening. |
| `tg listen <chat-or-id> --auto-download` | Automatically download incoming attachments while listening. |
| `tg search "keyword" --chat <chat>` | Search messages already stored locally. |
| `tg recent`, `tg today`, `tg stats`, `tg top`, `tg timeline` | Explore local message data. |
| `tg filter <keywords>` | Filter local messages by keyword with optional chat/hour filters. |
| `tg export <chat>` | Export local messages from a chat. |
| `tg archive <chat ...>` / `tg archive --all` | Archive selected or all chats as incremental Markdown files. |
| `tg send <chat> [message] [--file <path> ...]` | Send text, files, or a captioned media group. |
| `tg edit <chat> <msgId> <text>` | Edit a message. |
| `tg delete <chat> <msgIds...>` | Delete one or more messages. |
| `tg purge <chat> --yes` | Remove a chat's locally stored messages. |
| `tg info <chat>` | Show metadata for a Telegram chat. |
| `tg group info <chat>` | Show read-only group or supergroup details. |
| `tg group list [--admin]` | List managed groups, optionally only those you administer or own. |
| `tg group members <chat> [--type <type>] [--query <text>] [--limit <count>]` | List and filter members (default `recent`, limit 100; maximum 200). |
| `tg group member <chat> <user>` | Show one member's role, rights, and restrictions. |
| `tg group audit <chat> [--query <text>] [--user <user>] [--type <type>] [--limit <count>]` | Query the administrator audit log (default 100; maximum 500). |
| `tg group member/admin/chat/invite/topic/message --help` | Discover group management actions by family. |

All sync-like commands write to local SQLite storage. The `sync-all` and `refresh` commands process multiple chats based on locally stored message IDs.

Finite commands support explicit `--json`, `--yaml`, and `--markdown` output. Without an explicit format, output to a non-TTY remains YAML; interactive terminals use rich human-readable output. `listen` is an unbounded stream and is excluded from these finite output formats. Failed commands return a nonzero exit code, so scripts can detect errors without parsing human-readable text.

Common options:

| Option | Purpose |
| --- | --- |
| `--account <name>` | Use a registered account without changing the current account. |
| `--json` / `--yaml` / `--markdown` | Select JSON, YAML, or Markdown output for a finite command. |
| `-v`, `--verbose` | Enable debug logging. |
| `-V`, `--version` | Print the installed version. |

Use `tg <command> --help` to inspect command-specific options. For example, `listen` supports reconnection and plain-text modes, while `search` supports sender, time, regular-expression, and result-limit filters.

Stable top-level command error codes added for these capabilities include `account_logged_out`, `account_identity_mismatch`, `contact_not_found`, `invalid_notification_duration`, `folder_not_found`, `ambiguous_folder`, `folder_operation_unsupported`, `password_required`, `password_invalid`, `archive_account_mismatch`, `archive_failed`, `archive_partial_failure`, `write_access_disabled`, and `flood_wait`. Structured output exposes these codes under `error.code`, with operation-specific details where available. When an attachment fails but the archive retains partial results, the top-level code is `archive_partial_failure`, the command exits nonzero, and each media warning uses `archive_media_failed` under `error.details.warnings[].code`.

### Remote write safety

Use `tg config write-access off` to block Telegram mutations made by commands such as send, edit, delete, notification changes, folder changes, and group management. The gate affects only remote Telegram writes: local database operations, configuration changes (including turning write access back on), and Telegram read operations remain available.

### Sync and listen behavior

These rules describe how synchronization, listening, replies, and downloads affect local data and terminal output.

- `sync-all` and `refresh` are batch operations for local persistence; they are not read-only.
- `listen` prints a concise separator for each incoming message and can optionally suppress attachment summaries.
- Telegram media groups appear as one incoming message with a combined attachment summary.
- Reply output includes the original message's local context when available, or identifies the missing message ID.
- In interactive `listen`, reply with `/reply <message-id> <content>`. Add attachments with repeatable `--file <path>` options; quote paths that contain spaces.
- Contact cards show the available name and phone number in attachment summaries. They aren't downloadable attachments and are hidden by `--no-media`.
- `listen --auto-download` works in both interactive and plain-text modes, saves attachments to `~/Downloads/telegram-cli`, and runs at most three downloads concurrently.
- Downloads keep Telegram-provided filenames. Unnamed downloads use a MIME-derived extension, then the media-kind extension, then `.bin`.
- Download failures are reported without stopping the listener. `--no-media` hides attachment summaries only; downloads still run when it is combined with `--auto-download`.

## Troubleshooting

Use these steps to resolve common account, session, and API credential errors.

### No active account

If a command reports `account_required`, add an account or select an existing one:

```sh
tg account add
tg account switch <name>
```

### Session is no longer valid

If Telegram returns `AUTH_KEY_UNREGISTERED`, remove the invalid local session and authenticate again:

```sh
tg account remove <name> --force
tg account add
```

### Default API credentials warning

The built-in API credentials remain usable, but the CLI prints a warning when it creates a Telegram client. Configure personal credentials to remove the warning:

```sh
tg config set --api-id <id> --api-hash <hash>
```

Set both `TG_API_ID` and `TG_API_HASH` when using environment variables. Setting only one causes a configuration error.

## Local data and privacy

Persisted configuration, authentication sessions, and synced messages remain on your machine unless you copy or export them. The relevant files under `DATA_DIR` are:

```text
config.json
accounts.json
accounts/<name>/session
accounts/<name>/messages.db
```

Treat persisted configuration, `.env`, Telegram credentials, session files, and SQLite data as sensitive. Never share them or commit them to version control.

## Development

This project uses pnpm:

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
```

During development, expose the current checkout as a global `tg` command that runs the TypeScript source directly. From the project root:

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/tg <<EOF
#!/bin/sh
exec "$(pwd)/node_modules/.bin/tsx" "$(pwd)/src/dev.ts" "\$@"
EOF
chmod +x ~/.local/bin/tg
rehash
```

Make sure `~/.local/bin` is in `PATH`. Subsequent `tg` invocations load the latest source changes.

For local source development, create a `.env` file in the project root:

```dotenv
TG_API_ID=your_telegram_api_id
TG_API_HASH=your_telegram_api_hash
```

`pnpm dev` loads this file only for local source development. An installed `tg` does not automatically load `.env`; use `tg config set --api-id <id> --api-hash <hash>` for persistent production configuration.

## License

Licensed under [GPL-3.0](LICENSE).
