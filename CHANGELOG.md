# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
