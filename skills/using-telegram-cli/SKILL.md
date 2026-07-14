---
name: using-telegram-cli
description: Use when an agent needs to operate the @will-17173/telegram-cli `tg` command for Telegram accounts, chats, messages, contacts, folders, notifications, archives, listening, or group administration.
---

# Using Telegram CLI

## Overview

Use `tg` as an account-aware Telegram client and local SQLite message index. Choose commands by data source, persistence, and whether they mutate Telegram.

## Mandatory rules

- Request explicit user authorization before either enabling write access or executing any remote mutation. Authorization to enable writes is not authorization for a mutation. Several mutations have no built-in confirmation.
- Check `tg config write-access status --json` before a planned mutation. The gate covers remote mutations only; read-only Telegram calls, local SQLite/file operations, account lifecycle, and configuration remain available while it is off.
- Never provide, solicit in plain text, or automate an ownership-transfer password. `group admin transfer-owner` prompts for it securely in an interactive TTY after `--yes`; it is not suitable for non-interactive CI.
- Treat API hashes, proxy URLs, sessions, account metadata, exported messages, and databases as secrets. Never print `config list --show-secrets`, expose a credential-bearing proxy, or commit `DATA_DIR`.
- Select an account explicitly with `--account <name>` in automation. Do not change the current account merely to run one command.
- Select exactly one of `--json`, `--yaml`, or `--markdown` for finite commands. Use JSON or YAML for automation and stable `ok`/error fields; Markdown is human-facing and may omit structured failure details. Non-TTY output otherwise defaults to YAML. `listen` excludes these flags.
- Check the process exit status and structured `ok`. For automated archive partial-failure accounting, use JSON/YAML and inspect `error.code` plus `error.details.completed`, `error.details.failed`, and `error.details.warnings`; never report complete success when any chat or media failed.

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
| Authenticate/select/logout accounts | `account` | login/logout | session/registry; messages retained on logout/login |
| Unread overview or transient online reads | `inbox`, `read`, `search-online` | yes | none; `inbox` does not mark messages read |
| Discover contacts/chats/groups | `contact`, `chats`, `info`, `group list` | yes | none |
| Persist Telegram history | `history`, `sync`, `sync-all`, `refresh` | yes | writes local SQLite DB |
| Archive chats as Markdown | `archive` | yes | writes account-local archive files |
| Query/export stored messages | `search`, `recent`, `today`, `stats`, `top`, `timeline`, `filter`, `export` | no | export may write a file |
| Inspect/mutate notifications or folders | `notification`, `folder` | yes | `mute`/`unmute` and `folder chat add/remove` mutate Telegram |
| Watch incoming messages | `listen` | yes, long-running | optional attachment downloads |
| Change Telegram state | `send`, `edit`, `delete`, notification/folder/group writes | yes | real external write |

Read [references/command-reference.md](references/command-reference.md) before composing an exact command, handling automation output, managing groups, or troubleshooting authentication and flood limits.

## Operating workflow

1. Run the relevant `--help`; prefer it over memorized flags.
2. For account-dependent work, inspect `tg account list --json` and use an explicit account.
3. Route by source and persistence: `search` uses synchronized SQLite; `search-online` and transient `read` use Telegram; `history`/`sync` persist into SQLite. Do not copy `read` time flags to `history`/`sync`, which use limit/delay controls.
4. Treat `inbox` as read-only discovery; never assume it marks messages read.
5. Resolve chats with `chats --json` and folders with `folder list --json`; prefer numeric IDs after discovery because names/titles may be ambiguous.
6. Parse structured envelopes rather than terminal tables. For batch sync failures use `refresh` and inspect `data.failures`; `sync-all` omits that field.
7. Immediately before a remote write, verify the target, check write-access status, and obtain explicit authorization for that mutation.

## Common mistakes

- `pnpm dev -- ...`: remove the extra separator.
- Assuming `sync --limit 5000` backfills a new chat: first sync is capped at 500; use `history` for deeper history.
- Expecting `sync-all` to expose partial failures: use `refresh` and inspect `data.failures`.
- Using an ambiguous chat name: retry with its numeric chat ID.
- Using Markdown for archive automation: it does not preserve full partial-failure details; use JSON/YAML.
- Passing a 2FA password in arguments, environment variables, stdin automation, chat, or logs: ownership transfer accepts only its secure interactive prompt.
- Expecting `send` to appear immediately in local search: synchronize afterward.
