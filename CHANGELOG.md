# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-13

### Added

- Add read-only group commands for inspecting group details, members, individual member roles, and administrator audit events.
- Support persistent and environment-provided SOCKS, HTTP, HTTPS, and MTProxy configuration, plus a `tg config list` command for inspecting effective settings.
- Automatically download incoming attachments in interactive and plain `tg listen` modes with bounded concurrency and progress reporting.
- Send one or more local files as a Telegram media group with the repeatable `tg send --file` option and an optional caption.
- Display contact card details and sender IDs in listen output.
- Add configurable delays between history pages for `history` and `sync` commands.

### Changed

- Show chat-scoped message queries as tables with the chat name in the title.
- Paginate Telegram history requests and retry normalized flood-wait responses.
- Clarify that built-in Telegram API credentials have stricter flood limits.

### Fixed

- Keep sent messages visible in active listeners and avoid duplicate sender IDs in listen headers.
- Bound listen download resources, preserve download state across interactive updates, and clean up clients and downloads safely when listening stops or reconnects.
- Infer filenames for downloaded attachments from MIME and media types while excluding non-downloadable informational media.
- Upload local media paths correctly and validate reply message IDs as strict integers.

## [0.1.1] - 2026-07-10

### Added

- Display the chat name for each message when `tg listen` is run without a chat filter.
- Preserve the compact sender-only output when listening to a specific chat.

## [0.1.0] - 2026-07-10

### Added

- Provide Telegram CLI commands for querying, synchronizing, and listening to messages.
- Add multi-account management with account add, list, current, switch, and remove commands.
- Resolve commands against an immutable account context backed by a versioned account registry.
- Support human-readable, structured, and interactive terminal output.
- Document CLI usage and AI agent integration.

### Changed

- Run Telegram commands using the selected account context.
- Hide image previews in interactive listen mode for stable terminal rendering.

### Fixed

- Stabilize Telegram account authentication.
- Harden account registry locking and edge-case handling.
- Improve interactive image preview sizing and terminal behavior.
