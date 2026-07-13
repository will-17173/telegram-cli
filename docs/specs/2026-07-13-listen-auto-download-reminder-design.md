# Listen Auto-download Reminder Design

## Goal

Make it immediately clear when an interactive `listen` session was started with `--auto-download`.

## Design

When interactive listen rendering receives `autoDownload: true`, it displays the dimmed English text `Auto-download enabled` directly below the connection status. The reminder remains visible for the session so it is not lost when transient notes such as send or download results change.

The reminder is omitted when automatic downloading is disabled. Plain-text listen output and all connection-status behavior remain unchanged.

## Testing

Add a focused Ink rendering test that verifies the reminder is present when enabled and absent when disabled. Run the complete Vitest suite and TypeScript typecheck after implementation.
