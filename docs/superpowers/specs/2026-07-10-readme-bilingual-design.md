# Bilingual README Design

## Goal

Create a public, English-first GitHub landing page for the Telegram CLI, with an equivalent Simplified Chinese translation. The documentation is for prospective users of a future globally published package, not for contributors setting up the repository from source.

## Files

- `README.md`: English primary README. Its first visible navigation line links to `README.zh-CN.md` using a Simplified Chinese label.
- `README.zh-CN.md`: Simplified Chinese translation with an English back-link in the same position.

## Content and Structure

Both documents use the same structure and convey the same product claims:

1. Project name and a short statement that `tg` is a Telegram CLI for authentication, chat/message operations, local synchronization, and local analysis.
2. Language navigation link.
3. Features grouped around Telegram operations, message syncing/searching, and structured output where relevant.
4. Installation containing only the future global command: `npm install -g telegram-cli`.
5. Configuration using a local `.env` file. Document `TG_API_ID` and `TG_API_HASH` as recommended Telegram API credentials; describe `DATA_DIR` and `DB_PATH` as optional paths for local data. Do not reveal, repeat, or endorse credential defaults found in the implementation.
6. A concise quick-start sequence: check authentication, list chats, sync a chat, search locally, then send a message. Use generic placeholders such as `<chat>` and `<message>`.
7. A short command overview pointing readers to `tg --help` and command-specific help instead of duplicating every option.
8. Data and privacy note: synced message data is stored locally in SQLite; session/data files and credentials must not be committed.
9. Development verification commands: `pnpm test` and `pnpm typecheck`.
10. GPL-3.0 license statement linking to `LICENSE`.

## Accuracy Rules

- Use `tg --help` for the installed CLI, and `pnpm dev --help` only if a development invocation is needed. Do not use `pnpm dev -- --help`: package-script argument forwarding makes that pass an unrecognized `--` command to Commander.
- Do not claim that the package is already published or provide source-install instructions.
- Do not include real account identifiers, tokens, session files, chat contents, screenshots, or a GitHub repository URL that has not been supplied.
- Keep user-facing language direct and concise; the Chinese version is a natural translation, not a literal word-for-word copy.

## Validation

Review both Markdown files for matching sections, working reciprocal relative links, correct license target, and commands matching CLI help. No runtime code or tests change.
