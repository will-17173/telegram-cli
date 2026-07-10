# Command Help Descriptions Design

## Goal

Make the top-level `tg help` output explain what every command does with a concise English description.

## Design

Add a Commander `.description()` call directly after each top-level `.command()` declaration. Each description will start with an action verb and describe the command's observable purpose without repeating its options.

Keep descriptions next to command definitions so changes to command behavior and help text remain easy to review together. Preserve the existing `config` and `config set` descriptions. Do not customize Commander's help formatter or change command arguments, options, ordering, output contracts, or execution behavior.

## Testing

Extend the CLI help tests to verify that every registered top-level command has a non-empty description. Also render top-level help and assert that representative local-query, Telegram, data, and configuration descriptions appear in the generated output.

Run the complete Vitest suite and TypeScript typecheck after implementation.
