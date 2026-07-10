# Telegram CLI

[简体中文](README.zh-CN.md)

A TypeScript command-line client for syncing Telegram chats, listening to live messages, searching locally stored messages, and managing Telegram tasks from the terminal.

## Features

- Sign in to Telegram and inspect the current account or available chats.
- Fetch chat history into a local SQLite database for fast, offline search.
- Sync one chat incrementally or sync many chats with a single command.
- Listen for new messages in real time, with optional attachment summaries.
- Search, filter, summarize, and export locally stored messages.
- Send, edit, and delete messages from the command line.
- Use human-readable output or structured JSON/YAML where supported.

## Installation

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

Personal credentials are stored locally as sensitive configuration. Never share them. The first command may prompt you to authenticate and create a local session.

You can optionally override local storage paths with environment variables:

```sh
export DATA_DIR=/path/to/tg-cli-data
export DB_PATH=/path/to/messages.db
```

## Quick start

```sh
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

## Command reference

Run the built-in help for the complete, current command list:

```sh
tg --help
```

Common commands:

| Command | Purpose |
| --- | --- |
| `tg status` | Check whether the Telegram account is authenticated. |
| `tg whoami` | Show basic authenticated account information. |
| `tg config set --api-id <id> --api-hash <hash>` | Save Telegram API credentials for persistent use. |
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

All sync-like commands write to local SQLite storage, while `sync-all` and `refresh` can process many chats automatically based on local high-water marks.

Many commands support `--json` or `--yaml` for structured output. Use `tg <command> --help` to see each command's options.

### Notes

- `sync-all` and `refresh` are batch operations for local persistence; they are not read-only.
- `listen` prints a concise separator for each incoming message and can optionally suppress attachment summaries.
- Capable true-color interactive terminals show embedded photo previews without downloading the original.
- If you still see Telegram synchronization warnings in the console, command output continues to work in most cases.

## Local data and privacy

Synced messages are stored in a local SQLite database. Persisted configuration, authentication sessions, and local data remain on your machine unless you explicitly copy or export them.

Treat persisted configuration, `.env`, Telegram credentials, session files, and SQLite data as sensitive. Never share them or commit them to version control.

## Development

This project uses pnpm:

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
```

For local source development, create a `.env` file in the project root:

```dotenv
TG_API_ID=your_telegram_api_id
TG_API_HASH=your_telegram_api_hash
```

`pnpm dev` loads this file only for local source development. An installed `tg` does not automatically load `.env`; use `tg config set --api-id <id> --api-hash <hash>` for persistent production configuration.

## License

Licensed under [GPL-3.0](LICENSE).
