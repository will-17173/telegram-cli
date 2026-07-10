# Multi-Account Support Design

## Summary

Add first-class support for multiple Telegram accounts. Every account remains authenticated in its own mtcute session and stores messages in its own SQLite database. One account is persisted as the default, while `--account <name>` can select another account for any account-dependent command without changing that default.

The project has not been released, so this change does not migrate or preserve the existing single-account session and database layout.

## Goals

- Keep multiple Telegram accounts authenticated locally at the same time.
- Persist one account as the default for subsequent commands.
- Allow every account-dependent command to override the default with `--account <name>`.
- Isolate each account's mtcute session and SQLite database.
- Allow separate CLI processes to operate different accounts concurrently.
- Provide commands to add, inspect, switch, and remove accounts.
- Preserve the existing structured JSON/YAML result conventions and human-readable output style.

## Non-Goals

- Hot-switch an already running command such as `listen`.
- Run one command against multiple accounts at once.
- Use different API ID/API Hash credentials for individual accounts.
- Revoke other Telegram sessions or devices when removing a local account.
- Migrate the existing `TG_SESSION_NAME` session or shared `messages.db`.
- Retain `TG_SESSION_NAME` or `DB_PATH` as account-selection mechanisms.

## Storage Layout

Global Telegram API credentials remain in `config.json`. Account metadata and the selected default account live in a separate registry:

```text
<data-dir>/
  config.json
  accounts.json
  accounts/
    alice/
      session/
      messages.db
    bob/
      session/
      messages.db
```

`accounts.json` uses a versioned document:

```json
{
  "version": 1,
  "current_account": "alice",
  "accounts": [
    {
      "name": "alice",
      "user_id": 123456,
      "username": "alice",
      "phone": "+8613800000000",
      "display_name": "Alice"
    }
  ]
}
```

The account name is a stable local identifier and directory name. All registry and account files are created with permissions that restrict access to the current user.

## Components

### AccountStore

`AccountStore` owns the versioned account registry. It lists accounts, reads the current account, adds account metadata, changes the current account, and removes an account record. It does not create Telegram clients or open SQLite databases.

Registry mutations use a short-lived lock. After acquiring the lock, the store rereads the latest document before applying a change and writes the result through a temporary file and atomic rename. Lock acquisition has a timeout and can recover a demonstrably stale lock.

Malformed or unreadable registry data is an error. The store does not silently reconstruct the registry by scanning directories because doing so could conceal data loss or select the wrong default account.

### AccountResolver

`AccountResolver` resolves exactly one immutable `AccountContext` at command startup. Resolution order is:

1. An explicit `--account <name>` value.
2. The persisted `current_account`.
3. An `account_required` error when neither exists.

The context contains account metadata, the mtcute session path, and the SQLite database path. Client, database, and service factories receive this resolved context or its explicit paths; lower layers never reread the current account. Therefore a later `account switch` cannot affect a command that is already running.

### Account Commands

Add an `account` command group:

```text
tg account add
tg account list
tg account current
tg account switch <name>
tg account remove <name>
```

`account list` and `account current` support human, JSON, and YAML output. The list shows the local account name, display name, username, phone number, and which account is current.

### Existing Factories and Services

The Telegram client factory uses the account context's session path while continuing to use the global API credentials. Database-backed commands use the account context's database path. Services retain their existing responsibility boundaries and receive account-scoped dependencies rather than discovering paths themselves.

## Adding an Account

`tg account add` performs the following flow:

1. Create a uniquely named temporary account directory under the data directory.
2. Start an mtcute client using the temporary session and the global API credentials.
3. Let mtcute conduct its normal interactive Telegram authentication.
4. Fetch the authenticated user with `getMe()`.
5. Reject the operation with `account_already_exists` if that Telegram user ID is already registered.
6. Generate a local account name.
7. Move the authenticated session into the final account directory.
8. Add the metadata to the registry under its mutation lock.
9. Make the account current only if it is the first registered account.

The generated name uses the first available source:

1. Lowercase Telegram username.
2. Phone number with non-digit characters removed.
3. `user-<telegram-user-id>`.

Names are normalized to safe directory identifiers. If the preferred name belongs to a different Telegram user, append `-<telegram-user-id>`. The Telegram user ID is the authoritative duplicate identity; aliases and phone numbers are not.

Authentication failure or cancellation removes the temporary directory and does not change the registry. If finalization fails, the command reports an error and preserves enough state to avoid registering an unusable account.

## Switching and Selecting Accounts

`tg account switch <name>` validates that the account exists, then atomically updates `current_account`. It affects only commands started afterward.

`--account <name>` is a global option accepted in either position:

```text
tg --account alice chats
tg chats --account alice
```

Both forms resolve `alice` for that invocation without modifying `current_account`. The option applies to every command that reads or writes account data, including:

- Telegram status, identity, chats, messages, and listening commands.
- History, synchronization, refresh, and attachment downloads.
- Local queries and data import/export commands.

Account-management and global configuration commands do not resolve an account. Supplying the global option to them has no behavioral effect.

This model supports concurrent operation through separate processes:

```text
tg listen --account alice
tg sync-all --account bob
```

Each process fixes its account context at startup and accesses different session and database paths.

## Removing an Account

`tg account remove <name>` deletes only the local account session and local message database. It does not revoke Telegram authorization on other devices or sessions.

Interactive use requires confirmation. `--force` permits explicit non-interactive removal. Under the registry mutation lock, removal first renames the account directory to a temporary tombstone, then updates the registry. If the registry update fails, it renames the directory back before returning an error. After a successful registry update, it deletes the tombstone. If final deletion fails, the account remains removed from selection but the command reports the residual path so it can be cleaned up safely; no live registry entry points at a missing directory.

When removing the current account:

- If accounts remain, the first remaining account in registry order becomes current and the result reports that choice.
- If no accounts remain, `current_account` becomes null.

The implementation does not attempt cross-process discovery before deletion. If an open session or database prevents safe deletion, the command returns `account_in_use` and retains the registry entry.

## Configuration Changes

- `TG_API_ID` and `TG_API_HASH` retain their existing global override behavior.
- `config.json` remains the persistent global API credential store.
- `DATA_DIR` continues to select the root application data directory.
- `TG_SESSION_NAME` is removed because account selection replaces it.
- `DB_PATH` is removed because a global database override violates account isolation.

There is no compatibility or migration path for the former single session and shared database because the application has not yet been released.

## Errors and Output Contracts

Account operations use these structured error codes:

- `account_required`: no explicit account and no current account exist.
- `account_not_found`: the requested account name is not registered.
- `account_already_exists`: the authenticated Telegram user is already registered.
- `account_login_failed`: authentication failed or did not complete.
- `account_in_use`: local account files could not be safely removed because they are in use.
- `account_store_error`: registry parsing, permissions, locking, or persistence failed.

Human-readable errors include an actionable next step, such as `tg account add` or `tg account list`. JSON and YAML continue to use the existing `{ ok, data/error }` result contract. Commands return nonzero exit status on failure.

## Testing Strategy

### Account storage

- Read and write a valid versioned registry.
- Apply restrictive file permissions.
- Reject malformed, unknown-version, and unreadable registries.
- Serialize mutations with the registry lock.
- Reread state under lock to prevent lost updates.
- Recover stale locks and report lock timeouts.
- Preserve the previous document when an atomic write fails.

### Account lifecycle

- Generate names from username, phone, and user ID in priority order.
- Normalize unsafe names and resolve collisions with the Telegram user ID.
- Detect duplicate Telegram user IDs.
- Make the first account current without switching on later additions.
- Switch to an existing account and reject an unknown one.
- Remove non-current, current, and final accounts.
- Preserve registry state when login or directory removal fails.

### Command integration

- Accept `--account` before and after the subcommand.
- Prefer an explicit account over the persisted current account.
- Return `account_required` and `account_not_found` consistently.
- Give two accounts distinct session and database paths.
- Verify online, synchronization, query, import/export, and attachment commands use the selected context.
- Verify a running command retains its initial context after a default-account switch.
- Exercise two account-scoped clients and databases concurrently.
- Cover account help text, human output, JSON/YAML output, and CLI exit behavior.

## Success Criteria

The feature is complete when a user can interactively add two Telegram accounts, see both remain authenticated, choose either as the persisted default, override the default on every account-dependent command, run commands for both accounts in separate processes, and remove either account without affecting the other's session or database.
