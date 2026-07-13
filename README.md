# Telegram CLI

[简体中文](README.zh-CN.md)

A TypeScript command-line client for syncing Telegram chats, listening to live messages, searching locally stored messages, and inspecting groups from the terminal.

## Features

- Sign in to Telegram and inspect the current account or available chats.
- Manage multiple Telegram accounts with isolated sessions and message databases.
- Fetch chat history into a local SQLite database for fast, offline search.
- Sync one chat incrementally or sync many chats with a single command.
- Listen for new messages in real time, with optional attachment summaries.
- Download attachments from channels that restrict content saving.
- Search, filter, summarize, and export locally stored messages.
- Send, edit, and delete messages from the command line.
- Inspect and manage groups, members, administrators, invites, forum topics, and messages.
- Use human-readable output or structured JSON/YAML where supported.

## Built for AI agents

Telegram CLI gives AI agents a command-based interface to Telegram and locally synced messages. After a human authenticates an account with `tg account add`, an agent can run online and local commands without browser automation.

The CLI supports agent workflows through these interfaces:

- JSON and YAML output gives agents structured data instead of terminal-formatted text.
- Nonzero exit codes and structured error codes let agents detect and handle failures.
- `--account <name>` selects an explicit account without changing the current account.
- Local search and analysis commands let agents inspect synced messages without reconnecting to Telegram.

For example, an agent can search one account and parse the result as JSON:

```sh
tg search "release" --account work --json
```

## Installation

Telegram CLI requires Node.js 22 or later.

After the package is published to npm, install it globally with:

```sh
npm install -g @will-17173/telegram-cli
```

## Configuration

Configuring personal Telegram API credentials is optional. To use your own, create them at [my.telegram.org](https://my.telegram.org), then save them with:

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

Supported proxy forms are `socks4://`, `socks5://`, `http://`, and `https://` proxy URLs, plus MTProxy links in the forms `tg://proxy?...` and `https://t.me/proxy?...`. A non-empty `TG_PROXY` value, after trimming surrounding whitespace, overrides the persisted proxy. If `TG_PROXY` is empty or unset, the CLI falls back to the stored proxy; if neither is configured, it connects directly.

The selected proxy applies to account login and every Telegram-backed command, not only the command used in the example. Proxy URLs can contain usernames and passwords or MTProxy secrets, so treat them as sensitive. CLI output does not print the configured proxy URL. A credential-bearing proxy URL entered literally on a command line may remain in shell history or be visible through process inspection. Provide `TG_PROXY` through an appropriately protected environment or secret-loading mechanism, or otherwise avoid placing literal secrets in shared shell histories and scripts.

To inspect the effective configuration in human-readable, JSON, or YAML format, run:

```sh
tg config list
tg config list --json
tg config list --yaml
tg config list --show-secrets
```

This reports the effective configuration rather than the raw contents of `config.json`. API credentials are resolved from environment variables first, then stored configuration, then the built-in default. The proxy is resolved independently from `TG_PROXY` first, then stored configuration, then remains absent when neither is configured.

The output reports exactly five fields: the effective API ID, API hash, credential source, proxy URL, and proxy source. The API hash is masked by default; use `--show-secrets` to display it in full. The proxy URL is always printed in full and may contain credentials or an MTProxy secret, so avoid writing `config list` output to logs or sharing it. `tg config list` does not create a Telegram client or make a network connection.

Run `tg account add` to authenticate and create a local session. Other commands never start the interactive login flow.

You can override the root directory for configuration, account sessions, and message databases:

```sh
export DATA_DIR=/path/to/tg-cli-data
```

## Quick start

```sh
# Add and authenticate the first account
tg account add

# Check authentication status
tg status

# List chats, then use a chat name, username, or ID where `<chat>` appears
tg chats

# Save a chat's history locally
tg sync <chat>

# Search the locally synced messages
tg search "keyword" --chat <chat>

# Sync across all chats
tg sync-all --max-chats 20 --delay 1

# Listen for new messages and automatically download incoming attachments
tg listen <chat-or-id> --auto-download

# Use plain output, download attachments, and hide their message summaries
tg listen <chat-or-id> --no-interactive --auto-download --no-media

# Send a message
tg send <chat> "Hello from tg"
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

# Set the default account used by commands
tg account switch <name>

# Remove an account and its local session/data
tg account remove <name> --force
```

Commands use the current account by default. Commands that support `--account` can target another registered account for one invocation without changing the current account:

```sh
tg chats --account <name>
tg sync-all --account <name>
tg search "keyword" --account <name>
```

Account names are shown by `tg account list`; they are normally derived from the Telegram username. Sessions and message databases remain isolated under each account's directory inside `DATA_DIR`.

Telegram API credentials apply to every registered account. You don't need to configure separate API credentials when adding another account.

## Group management

The `group` command keeps read-only inspection alongside management families for members, administrators, chat settings, invite links, forum topics, and messages. Use family help to see the current actions:

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

`group audit` requires group administrator rights. Its `--limit` range is 1 through 500, with a default of 100 events. Its repeatable `--user` filter selects action authors. The repeatable `--type` filter accepts exactly these 17 stable grouped event types: `info_changed`, `settings_changed`, `member_joined`, `member_left`, `member_invited`, `member_banned`, `member_unbanned`, `member_restricted`, `member_unrestricted`, `admin_promoted`, `admin_demoted`, `message_deleted`, `message_edited`, `message_pinned`, `invite_changed`, `topic_changed`, and `other`.

Inspection and management actions use human-readable output by default; actions that expose `--json` or `--yaml` provide structured success or error output. Failures set a nonzero exit status. They use the current account unless `--account <name>` selects another registered account for that invocation.

Management actions are grouped under `member`, `admin`, `chat`, `invite`, `topic`, and `message`. Member targets must be explicit `@username` values or numeric Telegram user IDs. Durations accept `s`, `m`, `h`, and `d` suffixes, or `off` where disabling is supported. For example, `tg group member mute @team @alice 2h --yes` temporarily mutes a member, while `tg group chat slowmode @team off` disables slow mode.

Potentially destructive CLI actions refuse to connect to Telegram unless `--yes` is present. Permanently deleting a chat additionally requires `--confirm-title` with the exact current title. Interactive listen mode presents these confirmations in an Ink modal. Management requires the relevant administrator permission, and some actions require a supergroup, forum, or creator role. Ownership transfer currently reports `password_required` when Telegram requires a password; this release does not accept a password for that action.

Use `tg group member info <chat> <user>` as the canonical member-details route. The legacy `tg group member <chat> <user>` form remains available, but a chat name matching a reserved member action such as `ban`, `mute`, or `info` is ambiguous and requires the canonical route.

## Slash commands while listening

Interactive `tg listen` presents every supported slash command in one menu. This includes `/reply` and the complete group-management catalog; group commands use the same management grammar without repeating the selected chat:

```text
/reply <message-id> <content>
/member mute @alice 2h
```

Typing `/` opens the unified command menu, with reply first. Matching ranks exact paths, prefixes, then ordered fuzzy matches, so `/rep` and `/rpy` find `/reply`, while `/ban` finds `/member ban`. Use Up/Down to move through matches. Tab completes the selected command; Enter also completes an incomplete selection, or runs a complete command. Esc closes the menu, result, or confirmation.

Group-command availability and permission checks are unchanged: unavailable actions remain disabled, risky actions open a confirmation modal, and chat deletion also asks for the exact title. When listening to more than one chat, set an unambiguous outgoing target with `--send-to <chat>` before using group commands, for example `tg listen @team @ops --send-to @team`.

## Online and local commands

Online commands connect to Telegram and require a valid session. These include `status`, `whoami`, `chats`, `history`, `sync`, `sync-all`, `refresh`, `info`, all `group` inspection and management families, `send`, `edit`, `delete`, and `listen`.

Local commands read or modify the selected account's message database without connecting to Telegram. These include `search`, `recent`, `stats`, `top`, `timeline`, `today`, `filter`, `export`, and `purge`.

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
| `tg account switch <name>` | Set the default account used by commands. |
| `tg account remove <name> --force` | Remove an account and its local session/data. |
| `tg status` | Check whether the Telegram account is authenticated. |
| `tg whoami` | Show basic authenticated account information. |
| `tg config set --api-id <id> --api-hash <hash>` | Save Telegram API credentials for persistent use. |
| `tg config set --proxy <url>` | Save an optional proxy for account login and Telegram-backed commands. |
| `tg config list [--show-secrets]` | Show effective configuration values and sources; the proxy URL is always visible. |
| `tg chats` | List available chats. |
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
| `tg send <chat> [message] [--file <path> ...]` | Send text, files, or a captioned media group. |
| `tg edit <chat> <msgId> <text>` | Edit a message. |
| `tg delete <chat> <msgIds...>` | Delete one or more messages. |
| `tg purge <chat> --yes` | Remove a chat's locally stored messages. |
| `tg info <chat>` | Show metadata for a Telegram chat. |
| `tg group info <chat>` | Show read-only group or supergroup details. |
| `tg group members <chat> [--type <type>] [--query <text>] [--limit <count>]` | List and filter members (default `recent`, limit 100; maximum 200). |
| `tg group member <chat> <user>` | Show one member's role, rights, and restrictions. |
| `tg group audit <chat> [--query <text>] [--user <user>] [--type <type>] [--limit <count>]` | Query the administrator audit log (default 100; maximum 500). |
| `tg group member/admin/chat/invite/topic/message --help` | Discover group management actions by family. |

All sync-like commands write to local SQLite storage. The `sync-all` and `refresh` commands process multiple chats based on locally stored message IDs.

Many commands support `--json` or `--yaml` for structured output. Failed commands return a nonzero exit code, so scripts can detect errors without parsing human-readable text.

Common options:

| Option | Purpose |
| --- | --- |
| `--account <name>` | Use a registered account without changing the current account. |
| `--json` / `--yaml` | Emit structured output when the command supports it. |
| `-v`, `--verbose` | Enable debug logging. |
| `-V`, `--version` | Print the installed version. |

Use `tg <command> --help` to inspect command-specific options. For example, `listen` supports reconnection and plain-text modes, while `search` supports sender, time, regular-expression, and result-limit filters.

### Sync and listen behavior

- `sync-all` and `refresh` are batch operations for local persistence; they are not read-only.
- `listen` prints a concise separator for each incoming message and can optionally suppress attachment summaries.
- In interactive `listen`, reply with `/reply <message-id> <content>`. Add attachments with repeatable `--file <path>` options; quote paths that contain spaces.
- Contact cards show the available name and phone number in attachment summaries. They aren't downloadable attachments and are hidden by `--no-media`.
- `listen --auto-download` works in both interactive and plain-text modes, saves attachments to `~/Downloads/telegram-cli`, and runs at most three downloads concurrently.
- Downloads keep Telegram-provided filenames. Unnamed downloads use a MIME-derived extension, then the media-kind extension, then `.bin`.
- Download failures are reported without stopping the listener. `--no-media` hides attachment summaries only; downloads still run when it is combined with `--auto-download`.

## Troubleshooting

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

The `config.json` file may contain an optional `proxy` setting in addition to API credentials. CLI success and error output does not print the stored proxy URL, but you must still protect `config.json`, the environment, and shell history because proxy URLs can contain credentials or MTProxy secrets.

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
