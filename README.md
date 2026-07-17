# Telegram CLI

[Project website](https://will-17173.github.io/telegram-cli/) · [Telegram CLI documentation](https://will-17173.github.io/telegram-cli/docs/) · [Telegram group](https://t.me/tg_cli_chat) · [简体中文 README](README.zh-CN.md)

Telegram CLI is a TypeScript command-line interface (CLI) for live Telegram data, local SQLite search, and remote management. It aims to be the most capable Telegram CLI for people and artificial intelligence (AI) agents that need dependable Telegram access from one `tg` command. Account sessions and synced messages stay on your machine.

## Why Telegram CLI stands out

Telegram CLI combines online reads, local persistence, file archives, live listeners, remote writes, group administration, account isolation, a local web UI, and structured output in one tool.

It is designed for AI agents:

- **Stable command contracts**: finite commands support JSON, YAML, Markdown, exit statuses, and stable error codes
- **Local-first data access**: synced messages stay in SQLite so agents can search and analyze Telegram history without repeated network reads
- **Explicit account control**: `--account` selects the intended session for one command
- **Write safety**: a write-access gate separates read-only automation from commands that modify Telegram
- **Agent skill support**: the `using-telegram-cli` skill teaches supported agents how to authenticate, sync, query, and avoid unsafe writes

## Read the documentation

Read the [complete Telegram CLI documentation](https://will-17173.github.io/telegram-cli/docs/) for installation, workflows, every command, automation, safety, and troubleshooting.

## Choose a Telegram workflow

Choose a workflow by the data freshness you need, where the result should go, and whether the command changes Telegram.

### Read current Telegram data

Use online commands when you need the latest server state. These commands do not add returned messages to SQLite.

```sh
tg inbox
tg read @team --since 2h
tg search-online "incident" --chat @team --json
```

You can also inspect contacts, notification settings, folders, and group details without importing messages.

### Build a searchable local history

Sync one chat or many chats into the selected account’s SQLite database. Search and analyze the stored copy without reconnecting to Telegram.

```sh
tg sync @team
tg search "release" --chat @team
tg recent --chat @team --hours 24
```

Local commands can also filter, summarize, and export stored messages.

### Browse local data in a web UI

Run a local-only management UI for stored messages:

```sh
tg web
```

The server binds to `127.0.0.1`, has no login screen, and is intended for local use only. It can browse local SQLite data and trigger read-only sync for the selected chat.

### Follow live messages and download files

The `listen` command streams new messages from one chat or many chats. It persists normalized `attachments[]`, can download incoming primary media, and can run interactive reply or group actions. `--no-media` only hides rendered media rows; persistence and `--auto-download` still use the normalized attachment data.

```sh
tg listen @team --auto-download
```

### Download historical media

Use `download` for existing messages: a single message, a specific attachment, a grouped album, an inclusive message range, one local date, or a whole chat from newest to oldest. Without `--attachment`, a single message downloads every downloadable item. `--attachment N` is one-based and message-local; for `--grouped-id`, numbering is flattened by message ID and then message-local attachment index. Each transfer refetches the fresh Telegram message and matches the stored descriptor before downloading, so stable errors include `attachment_not_found`, `attachment_not_downloadable`, `attachment_changed`, and `media_access_denied`.

Downloaded attachments are remembered in the local account database. By default, later `tg download` runs skip attachments that were already downloaded and print an `already downloaded` notice in plain output. Use `--force` to download them again and refresh the saved status.

```sh
tg download --chat @team --msg-id 814 --output ./media
tg download @channel 42 --attachment 2
tg download --chat @team --date 2026-07-15 --concurrency 2
tg download --chat @channel --grouped-id 2637798265 --output ./album-media
tg download --chat @channel --all --output ./channel-media
```

### Keep a Markdown archive

The `archive` command writes incremental Markdown and optional media files. It tracks archive progress separately from message sync; when `--download-media` saves or reuses a media file, it also records that attachment as downloaded in the local account database. Default account archives are reset by `tg data reset`; custom `--output` directories are never deleted automatically, so remove old custom archives manually or choose an empty directory after breaking upgrades.

```sh
tg archive @team --download-media
```

Later runs append new messages and retry referenced media that is still missing.

### Reset local data after breaking storage upgrades

This release uses a fresh message schema and structured output schema version 2. Old SQLite databases are intentionally not migrated. Reset local data, then re-sync or rebuild archives:

```sh
tg data reset --yes
tg data reset --all-accounts --yes
tg sync-all
```

Structured message rows expose `content`, `reply_to_msg_id`, `media_group_id`, and ordered lowercase `attachments[]`.

### Send messages and manage groups

Send text, files, or captioned media groups from the terminal. Inspect and manage group members, administrators, invites, forum topics, and messages.

```sh
tg send @team "Release is ready" --file ./report.pdf
tg group members @team --type admins
tg group member mute @team @alice 2h --yes
```

Telegram CLI also manages contacts, notification settings, and chat folders. The write-access gate covers commands that change Telegram.

### Automate across isolated accounts

Each registered account has a separate session and SQLite database. Select an account for one command without changing the default.

```sh
tg stats --account work --json
```

Finite commands support JSON, YAML, and Markdown output. Failures return nonzero exit statuses and stable error codes.

## Install

Install Node.js 22.12.0 or later, then install Telegram CLI from npm:

```sh
npm install -g @will-17173/telegram-cli
```

## Get started

Authenticate one account, list its chats, sync one chat, and search the local copy:

```sh
tg account add
tg status
tg chats
tg sync @team
tg search "release" --chat @team
```

Replace `@team` with a chat name, username, or numeric identifier (ID). Run `tg --help` or a command such as `tg sync --help` to inspect available options.

## Know where data goes

Check a command’s execution scope before you run it:

| Scope | Commands | Effect |
| --- | --- | --- |
| Online read | `inbox`, `read`, `search-online` | Queries Telegram without storing returned messages. |
| Local persistence | `history`, `sync`, `sync-all`, `refresh` | Stores fetched messages in the selected account’s SQLite database. |
| Local read | `search`, `recent`, `stats`, `export`, `web` | Reads local SQLite data without connecting to Telegram. |
| File archive | `archive` | Reads Telegram and writes Markdown or media files; `--download-media` also updates attachment download status in SQLite. |
| Remote write | `send`, `edit`, `delete`, notification, folder, and group actions | Changes Telegram messages or settings. |

Each account has a separate session and SQLite database. Add `--account work` to select an account for one command without changing the default.

Use `sync <chat>` to update a chat from the newest locally stored message. Use `history <chat>` to continue backfilling older messages from the oldest locally stored message; if the chat has no local rows yet, `history` starts from the newest Telegram messages.

## Protect remote data

Disable remote writes before read-only workflows or automation:

```sh
tg config write-access off
tg config write-access status
```

Run `tg config write-access on` when you intend to modify Telegram again. Enabling the gate does not authorize a specific write.

Keep Telegram application programming interface (API) credentials, proxy credentials, session files, SQLite databases, exports, and archives private.

## Use with coding agents

Use JSON or YAML when a script or coding agent needs structured output:

```sh
tg search "release" --account work --json
```

Failures return a nonzero exit status and a stable error code. The explicit `--account` option keeps automation on the intended account.

Install the [`using-telegram-cli` agent skill](https://skills.sh/will-17173/telegram-cli/using-telegram-cli) in a supported coding agent:

```sh
npx skills add https://github.com/will-17173/telegram-cli \
  --skill using-telegram-cli
```

The skill covers authentication, synchronization, queries, and write safety.

## Develop

Use pnpm with Node.js 22.12.0 or later:

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
pnpm build
```

## License

Licensed under [GPL-3.0-only](LICENSE).
