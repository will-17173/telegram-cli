# Rich Terminal Output Design

Date: 2026-07-10

## Goal

Replace raw JSON-like default output with readable React/Ink views when stdout is an interactive terminal. Preserve stable JSON/YAML for scripts, pipes, and redirected output.

## Output Contract

- Interactive TTY with no explicit format uses Ink.
- `--json` and `--yaml` always produce plain structured output.
- Non-TTY stdout defaults to structured YAML.
- `OUTPUT=json|yaml|rich` remains authoritative.
- Errors remain concise, go to stderr in rich mode, and set a non-zero exit code.

## Command Views

- `chats`: compact `ID / NAME / TYPE / UNREAD` table.
- `whoami`, `status`, `info`: key-value detail panels.
- `search`, `recent`, `today`, `filter`: message tables with `TIME / CHAT / SENDER / MESSAGE`.
- `stats`: summary panel followed by a per-chat table.
- `top`: ranked sender table.
- `timeline`: period labels with proportional horizontal bars.
- `history`, `sync`: compact result panels.
- `refresh`, `sync-all`: summary panel plus per-chat results, including failures.
- `send`, `edit`, `delete`, `purge`: compact confirmation panels.
- `export`: summary when writing a file; preserve direct text export content.
- `listen`: retain streaming behavior and leave richer live presentation to a separate change.

## Architecture

Extend `HumanOutput` with semantic view models for detail panels, summaries, tables, message lists, and timelines. Services and command handlers describe the data and labels; `src/presenters/ink/` owns layout, color, spacing, truncation, and terminal-width behavior. Structured presenters continue using only `result.data`, so rich rendering cannot alter JSON/YAML contracts.

Split Ink rendering into focused components rather than growing one switch-heavy file. Shared table utilities will calculate terminal display width correctly for CJK and other wide Unicode characters, allocate columns for the current terminal width, and truncate long cells with an ellipsis. Table width calculations include cell padding, column separators, and outer borders. Narrow terminals must remain readable instead of wrapping columns unpredictably.

## Visual Language

Use a mixed style: full Unicode grid tables for lists and small bordered panels for identity, status, statistics, and action results. Tables use rounded outer corners, vertical column separators, a header separator, and horizontal separators between every data row. Each cell has one column of horizontal padding. Apply color sparingly to headings, success states, unread counts, and failures. Output must remain understandable without color. Empty tables retain their border and header and show a clear empty-state row.

## Testing

Add presenter tests for every semantic view, terminal width changes, grid junctions, CJK alignment, truncation, empty data, and missing optional fields. Assert that every rendered grid line, including borders and padding, stays within the configured terminal width. Add output-routing tests proving TTY defaults to Ink while explicit JSON/YAML and non-TTY output remain byte-stable structured data. Add representative command tests for `chats`, `whoami`, message lists, statistics, synchronization results, and action confirmations.
