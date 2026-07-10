# Production Configuration Command Design

## Goal

Replace production `.env`-based Telegram API credential setup with a persistent CLI configuration command while retaining `.env` support for local development.

## Command Contract

Production users configure both credentials with:

```bash
tg config set --api-id <id> --api-hash <hash>
```

Both flags are required for `config set`. `api-id` must be a positive integer after trimming. `api-hash` must be non-empty after trimming. Invalid or incomplete input must return the CLI's normal structured error shape and a non-zero exit status without changing the stored configuration.

On success, the command reports that Telegram API credentials were saved. It must never print the API hash in human-readable, JSON, or YAML output.

## Storage

Store production credentials in `config.json` inside the existing application data directory returned by `getDataDir()`. The default locations therefore follow the current platform rules, and `DATA_DIR` remains available as an application-data location override.

The persisted document contains only the required production credential fields:

```json
{
  "api_id": 12345,
  "api_hash": "secret-value"
}
```

Write through a temporary file in the same directory and rename it over the destination so an interrupted write cannot leave a partial configuration. Set the final file mode to `0600` where supported. Existing unrelated application data must not be changed.

## Runtime Resolution

Production runtime credential resolution follows this order:

1. `TG_API_ID` and `TG_API_HASH` already present in the process environment, for local development and explicit process-level injection.
2. The persisted `config.json` created by `tg config set`.
3. If neither complete source exists, throw a configuration error that tells the user to run `tg config set --api-id <id> --api-hash <hash>`.

Credentials must come from one complete source. Do not combine an environment API ID with a stored API hash or the reverse. Remove the embedded default API ID and hash so production never silently uses code-level credentials.

The application must stop loading `.env` inside shared production configuration code. Local development loads the repository `.env` through the `pnpm dev` script before the TypeScript entry point runs. This makes `.env` a development convenience rather than a production package behavior.

## Code Organization

- `src/config/env.ts` continues to own platform data paths and environment access, but delegates persisted credential reads to a focused configuration store.
- A new storage module owns validation, JSON parsing, atomic writes, and safe permissions for `config.json`.
- A new command module registers `config set` and returns normal `HandlerResult` values through the existing rendering layer.
- `src/cli/app.ts` registers the command group.
- `package.json` updates the development command to load `.env` explicitly; production startup does not load it.

Malformed or unreadable stored configuration must produce a clear error rather than falling back to embedded credentials. No command output or error may include the saved API hash.

## Documentation

In both `README.md` and `README.zh-CN.md`:

- The user-facing Configuration section documents only `tg config set --api-id <id> --api-hash <hash>` and links users to `my.telegram.org` for credentials.
- The Development section explains that local source development supports a project-root `.env` containing `TG_API_ID` and `TG_API_HASH`.
- Privacy guidance identifies the persisted configuration as sensitive and says it must not be committed or shared.
- English remains the primary README and both language links remain unchanged.

## Testing

Add focused tests for:

- successful atomic persistence and subsequent credential reads;
- `0600` file permissions on supported platforms;
- positive-integer API ID and non-empty API hash validation;
- rejection when either required flag is missing;
- no stored-file mutation after invalid input;
- complete environment credentials taking precedence over stored credentials;
- rejection of partial environment credentials rather than mixing sources;
- missing and malformed stored configuration errors;
- structured output never exposing the API hash;
- CLI help listing `config` and `config set`;
- English and Chinese README configuration examples matching the command contract.

Run `pnpm test` and `pnpm typecheck` after implementation.
