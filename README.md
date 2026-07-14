# Telegram CLI

[Project website](https://will-17173.github.io/telegram-cli/) · [Telegram CLI documentation](https://will-17173.github.io/telegram-cli/docs/) · [简体中文 README](README.zh-CN.md)

Telegram CLI is a TypeScript command-line interface (CLI) for live Telegram data, local SQLite search, and remote management. Use one `tg` command from a terminal, a script, or a coding agent. Account sessions and synced messages stay on your machine.

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

### Follow live messages and download files

The `listen` command streams new messages from one chat or many chats. It can download incoming attachments and run interactive reply or group actions.

```sh
tg listen @team --auto-download
```

### Keep a Markdown archive

The `archive` command writes incremental Markdown and optional media files. It tracks archive progress separately and does not populate SQLite.

```sh
tg archive @team --download-media
```

Later runs append new messages and retry referenced media that is still missing.

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

Install Node.js 22 or later, then install Telegram CLI from npm:

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
| Local read | `search`, `recent`, `stats`, `export` | Reads local SQLite data without connecting to Telegram. |
| File archive | `archive` | Reads Telegram and writes Markdown or media files without writing to SQLite. |
| Remote write | `send`, `edit`, `delete`, notification, folder, and group actions | Changes Telegram messages or settings. |

Each account has a separate session and SQLite database. Add `--account work` to select an account for one command without changing the default.

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

Use pnpm with Node.js 22 or later:

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
pnpm build
```

## License

Licensed under [GPL-3.0-only](LICENSE).
