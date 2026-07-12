# Telegram CLI

[简体中文](README.zh-CN.md)

A TypeScript command-line client for syncing Telegram chats, listening to live messages, searching locally stored messages, and managing Telegram tasks from the terminal.

## Features

- Sign in to Telegram and inspect the current account or available chats.
- Manage multiple Telegram accounts with isolated sessions and message databases.
- Fetch chat history into a local SQLite database for fast, offline search.
- Sync one chat incrementally or sync many chats with a single command.
- Listen for new messages in real time, with optional attachment summaries.
- Download attachments from channels that restrict content saving.
- Search, filter, summarize, and export locally stored messages.
- Send, edit, and delete messages from the command line.
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
warning: using default Telegram API credentials. Run tg config set --api-id <id> --api-hash <hash> to configure your own.
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

# Listen for new messages from one or more chats
tg listen <chat-or-id> [another-chat ...] --no-media

# Send a message
tg send <chat> "Hello from tg"
```

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

## Online and local commands

Online commands connect to Telegram and require a valid session. These include `status`, `whoami`, `chats`, `history`, `sync`, `sync-all`, `refresh`, `info`, `send`, `edit`, `delete`, and `listen`.

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
| `tg search "keyword" --chat <chat>` | Search messages already stored locally. |
| `tg recent`, `tg today`, `tg stats`, `tg top`, `tg timeline` | Explore local message data. |
| `tg filter <keywords>` | Filter local messages by keyword with optional chat/hour filters. |
| `tg export <chat>` | Export local messages from a chat. |
| `tg send <chat> "Hello from tg"` | Send a message. |
| `tg edit <chat> <msgId> <text>` | Edit a message. |
| `tg delete <chat> <msgIds...>` | Delete one or more messages. |
| `tg purge <chat> --yes` | Remove a chat's locally stored messages. |
| `tg info <chat>` | Show metadata for a Telegram chat. |

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
