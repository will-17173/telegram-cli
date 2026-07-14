---
name: using-telegram-cli
description: Use when an agent needs to operate the @will-17173/telegram-cli `tg` command for Telegram account authentication, chat synchronization, local message search or export, live listening, message delivery, or group inspection and administration.
---

# Using Telegram CLI

## Overview

Use `tg` as an account-aware Telegram client and local SQLite message index. Keep network reads, local reads, and externally visible writes distinct.

## Mandatory rules

- Require explicit user authorization before `send`, `edit`, `delete`, or any group mutation. These affect real Telegram state; several have no built-in confirmation.
- Treat API hashes, proxy URLs, sessions, account metadata, exported messages, and databases as secrets. Never print `config list --show-secrets`, expose a credential-bearing proxy, or commit `DATA_DIR`.
- Select an account explicitly with `--account <name>` in automation. Do not change the current account merely to run one command.
- Use `--json` for finite scripted commands. Check the process exit status and top-level `ok`. Use `refresh` and inspect `data.failures` when automation must detect per-chat sync failures; `sync-all` omits that field.
- Never combine `--json` and `--yaml`.
- Do not claim that chats are contacts. This CLI has no contact-list or contact-sync command.

## Resolve the executable

Prefer an installed `tg` and inspect live help:

```sh
command -v tg
tg --version
tg --help
tg <command> --help
```

Inside this repository, use `pnpm dev <args>` after dependencies are installed, for example `pnpm dev search --help`. Do **not** insert an extra `--`; `pnpm dev -- search ...` passes that token to the CLI and can fail.

## Choose the operation

| Need | Command family | Network | Side effect |
| --- | --- | --- | --- |
| Authenticate/select accounts | `account` | login only | local session/registry |
| Discover chats or fetch messages | `chats`, `info`, `history`, `sync`, `sync-all`, `refresh` | yes | writes local DB when syncing |
| Archive chats as Markdown | `archive` | yes | writes account-local archive files |
| Query/export stored messages | `search`, `recent`, `today`, `stats`, `top`, `timeline`, `filter`, `export` | no | export may write a file |
| Watch incoming messages | `listen` | yes, long-running | optional attachment downloads |
| Change Telegram content | `send`, `edit`, `delete`, group writes | yes | real external write |

Read [references/command-reference.md](references/command-reference.md) before composing an exact command, handling automation output, managing groups, or troubleshooting authentication and flood limits.

## Operating workflow

1. Run the relevant `--help`; prefer it over memorized flags.
2. For account-dependent work, inspect `tg account list --json` and use an explicit account.
3. Resolve targets with `tg chats --account <name> --json`; prefer numeric chat IDs in automation.
4. Use `history` for a deliberate backfill or `sync`/`sync-all` for incremental updates.
5. Query only after synchronization. `search`, `recent`, and analytics never query Telegram directly.
6. Parse the structured envelope rather than terminal tables. For batch failure visibility, use `refresh` and report non-empty `data.failures`.
7. Reconfirm the target and requested content immediately before an authorized external write.

## Archive workflow

`tg archive` requires one or more chats or `--all`; do not combine them. It uses the selected/current account and defaults to that account's `archive` data directory. An initial run covers the preceding seven days unless `--since`/`--until` define a custom range or `--full` requests all available history. Subsequent runs are incremental and recover their cursor from both the manifest and embedded Markdown message markers. `--rebuild` replaces chat files using the recorded initial range unless a new range or `--full` is supplied. `--download-media` saves attachments under `media/` and recovers missing referenced downloads.

For automation, prefer `--account <name> --json`. A partial chat or media failure returns `archive_partial_failure`, includes `completed`, `failed`, and `warnings`, and exits with status 1.

## Common mistakes

- `pnpm dev -- ...`: remove the extra separator.
- Empty/stale local results: run `sync` first.
- Assuming `sync --limit 5000` backfills a new chat: first sync is capped at 500; use `history` for deeper history.
- Expecting `sync-all` to expose partial failures: use `refresh` and inspect `data.failures`.
- Using an ambiguous chat name: retry with its numeric chat ID.
- Expecting `send` to appear immediately in local search: synchronize afterward.
