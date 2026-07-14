# Telegram CLI

[Project website](https://will-17173.github.io/telegram-cli/) · [Telegram CLI documentation](https://will-17173.github.io/telegram-cli/docs/) · [简体中文 README](README.zh-CN.md)

Telegram CLI is a TypeScript command-line interface (CLI) for reading, syncing, searching, archiving, and managing Telegram from a terminal. It keeps account sessions and synced messages on your machine.

## Read the documentation

Read the [complete Telegram CLI documentation](https://will-17173.github.io/telegram-cli/docs/) for installation, workflows, every command, automation, safety, and troubleshooting.

## What it does

Use Telegram CLI to:

- Manage multiple accounts with isolated sessions and message databases.
- Read and search Telegram without storing the results.
- Sync messages to SQLite for local search, analysis, and export.
- Listen for new messages and download attachments.
- Archive chats as incremental Markdown files.
- Send messages and manage contacts, folders, notifications, and groups.
- Produce JSON, YAML, or Markdown output for scripts and coding agents.

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

Replace `@team` with a chat name, username, or numeric ID. Run `tg --help` or a command such as `tg sync --help` to inspect available options.

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

Keep API credentials, proxy credentials, session files, SQLite databases, exports, and archives private.

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
