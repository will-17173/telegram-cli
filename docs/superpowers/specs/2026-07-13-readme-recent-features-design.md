# README Recent Features Update Design

## Goal

Bring both public READMEs up to date with the user-visible listen behavior added after their most recent content update. The documentation must cover inline Telegram contact cards and MIME-based filename extensions without duplicating features that are already documented.

## Source of Truth

The update is based on the behavior implemented by these recent feature branches and follow-up tests:

- `aa871d3` / `902d1f1` / `426a663`: display Telegram contact cards inline and exclude informational media from download interactions.
- `9b2d5ac` / `083841f` / `d16d169`: infer extensions for unnamed listen downloads from known MIME types.

Proxy configuration, effective configuration listing, automatic downloads, and read-only group inspection are already documented in both READMEs and are not rewritten.

## Files and Placement

Update both files with equivalent meaning:

- `README.md`
- `README.zh-CN.md`

Add concise coverage in two existing locations:

1. The top-level feature list, where users scan available capabilities.
2. `Sync and listen behavior` / `同步与监听行为`, where download and media rules are already explained.

Do not add a new section. Do not change Quick start, Configuration, or the command-reference table because the recent commits added behavior rather than commands or options.

## Contact Card Documentation

The feature list states that Telegram contact cards are displayed inline with their name and phone number when available.

The listen-behavior section makes these rules explicit:

- A contact card is informational message content, not a file attachment.
- With media summaries enabled, `listen` displays the contact name and phone number inline when Telegram provides them.
- Contact cards do not show a manual download action and are not added to the automatic-download queue.
- Existing `--no-media` behavior hides contact rows together with other media summaries.

The documentation does not promise contact expansion, `.vcf` export, address-book integration, username resolution, or display of arbitrary vCard fields.

## MIME Extension Documentation

The feature list states that unnamed downloads receive useful extensions from recognized MIME types.

The listen-behavior section documents filename precedence:

1. Preserve a Telegram-provided filename when present.
2. Otherwise infer the extension from a recognized MIME type.
3. Otherwise fall back to the known media-kind extension.
4. Use `.bin` when no more specific extension is known.

Document the currently recognized file types: PDF, JPEG, PNG, GIF, WebP, MP3, Ogg, MP4, and WebM. Do not imply arbitrary MIME-to-extension inference beyond this explicit mapping.

## Bilingual Parity and Style

The English and Chinese text must communicate the same behavior and limitations while reading naturally in each language. Reuse the existing terminology for `listen`, media summaries, automatic downloads, filenames, and MIME types. Keep additions concise and avoid changelog-style commit references in the public README text.

## Verification

- Compare both diffs to ensure every new English statement has an equivalent Chinese statement.
- Confirm the public text does not claim unsupported contact actions or MIME mappings.
- Run `git diff --check` for Markdown whitespace errors.
- Run `pnpm test` and `pnpm typecheck` as the repository's final verification commands.

## Out of Scope

- Source-code or test changes.
- New commands, options, examples, or screenshots.
- A full release changelog.
- Rewriting existing proxy, group-management, account, or automatic-download documentation.
