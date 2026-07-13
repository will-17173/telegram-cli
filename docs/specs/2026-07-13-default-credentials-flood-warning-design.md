# Default Credentials Flood Warning Design

## Goal

Make the existing default Telegram API credentials warning explicitly communicate the increased flood-limit risk across the entire application.

## Behavior

Replace the current warning with one global line:

```text
warning: using default Telegram API credentials, which have stricter flood limits and may trigger FLOOD_WAIT during frequent or large requests. Run tg config set --api-id <id> --api-hash <hash> to configure your own.
```

The warning remains in the Telegram client factory, so every command that creates a Telegram client receives the same behavior. It is not specific to `history`, `sync`, or any other command.

The warning is emitted once for each client creation when built-in credentials are selected. It is not emitted when credentials come from stored configuration or environment variables.

## Output Contract

Continue writing the warning to stderr. Machine-readable JSON and YAML output on stdout must remain unchanged and parseable.

## Documentation and Testing

Update the client-factory tests to assert the exact new warning and retain coverage that custom credentials suppress it. Update the English and Chinese README examples so their displayed output matches the application.

No new command flag, configuration field, or history-specific warning is introduced.
