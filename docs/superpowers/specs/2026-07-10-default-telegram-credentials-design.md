# Default Telegram Credentials Fallback Design

## Goal

Allow Telegram commands to work without user-supplied API credentials by falling back to the built-in Telegram API credentials, while clearly warning users that they can configure their own credentials.

## Resolution Order

Credential resolution uses one complete source in this order:

1. A complete `TG_API_ID` and `TG_API_HASH` process-environment pair.
2. A valid persisted `config.json` written by `tg config set`.
3. Built-in defaults: API ID `2040` and API hash `b18441a1ff607e10a989891a5462e627`.

The resolver must identify which source was selected so the Telegram client factory can decide whether to warn.

Exactly one environment variable remains an error: do not combine a partial environment pair with stored or default credentials. A present but malformed `config.json` also remains an error; do not hide corrupted user configuration by falling back to defaults. Only a genuinely missing configuration file triggers the default fallback.

## Warning Contract

When built-in defaults are selected, write this warning to `stderr`:

```text
warning: using default Telegram API credentials. Run tg config set --api-id <id> --api-hash <hash> to configure your own.
```

Warn at most once per process, even if more than one client is created. Do not warn for environment or persisted credentials.

The warning must never be written to `stdout`. JSON and YAML stdout must remain valid structured output; callers may independently capture the stderr warning.

## API Shape

The configuration layer returns the credentials and their source as one value, for example:

```ts
type ResolvedTelegramCredentials = TelegramCredentials & {
  source: 'environment' | 'stored' | 'default'
}
```

The credential store must distinguish a missing file from malformed/unreadable content. It may expose a dedicated missing-configuration error type or an equivalent narrow predicate; callers must not detect a missing file by comparing user-facing error strings.

`tg config set` and its safe output contract remain unchanged.

## Documentation

Update both README files so that:

- `tg config set --api-id <id> --api-hash <hash>` is optional and configures personal Telegram API credentials.
- Users are told that the CLI falls back to built-in credentials and prints a warning when no personal configuration exists.
- Development-only `.env` guidance remains in the Development section.
- The English and Simplified Chinese documents remain equivalent.

## Testing

Add or update tests for:

- environment, stored, and default source tagging;
- missing `config.json` falling back to the exact built-in credentials;
- partial environment credentials still failing;
- malformed and unreadable stored configuration still failing;
- no warning for environment or stored sources;
- exactly one stderr warning when multiple clients use defaults;
- JSON/YAML stdout remaining parseable while the warning goes to stderr;
- README wording in both languages matching the optional configuration behavior.

Run `pnpm test`, `pnpm typecheck`, and a real `tg whoami` preflight that confirms the missing-configuration error no longer occurs before Telegram authentication begins.
