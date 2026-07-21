# Web and Guard UI Internationalization Design

## Goal

Add lightweight internationalization to the local web UI opened by `tg web` and the Guard console opened by `tg guard start`.

The first version supports English and Simplified Chinese. It localizes user-facing React UI text while leaving API contracts, database content, Telegram message content, account names, chat names, user-authored rule names, error codes, and raw unknown backend values unchanged.

## Scope

In scope:

- `web/src/App.tsx` UI copy for the message browser and Guard workbench.
- Download, pagination, sender blacklist, filter, tooltip, modal, status, policy, rule editor, and empty-state labels.
- Locale selection from URL, persisted preference, browser language, and fallback.
- A language switcher shared by normal web mode and Guard-only mode.
- Frontend tests for locale resolution, dictionary coverage, and unchanged behavior.

Out of scope:

- Translating CLI help or stdout messages such as `Telegram CLI web UI: ...`.
- Translating backend API error messages or structured error codes.
- Translating stored Telegram messages, rule names, chat titles, usernames, account names, or file paths.
- Adding a full i18n dependency such as i18next.
- Server-side locale routing or separate localized static builds.

## Architecture

Create `web/src/i18n.ts` as the only locale module for this feature. It exposes:

- `SUPPORTED_LOCALES`, with `en` and `zh-CN`.
- `DEFAULT_LOCALE`, set to `en`.
- `resolveInitialLocale(input)`, which chooses the initial locale from URL query, stored preference, navigator languages, then fallback.
- `normalizeLocale(value)`, which maps `zh`, `zh-CN`, and `zh-Hans` style values to `zh-CN`, maps English variants to `en`, and returns `null` for unsupported values.
- `messages`, a typed dictionary for both locales.
- `formatMessage(template, values)`, a small interpolation helper for dynamic labels.

`App.tsx` owns the active `locale` state. It reads the initial value once at startup, derives `t = messages[locale]`, and passes `t` and `locale` to the Guard workbench and local helper functions that need localized text.

React updates `document.documentElement.lang` after startup so the static `web/index.html` can remain `lang="en"` without requiring server-side HTML variants.

## Locale Selection

Locale priority:

1. URL query parameter `lang`.
2. Stored browser preference in `localStorage`.
3. Browser language list from `navigator.languages` or `navigator.language`.
4. `en`.

Valid URL examples:

- `?lang=en`
- `?lang=zh-CN`
- `?guard=1&lang=zh-CN`

Changing language through the UI:

- Updates React state immediately.
- Stores the selected locale in `localStorage`.
- Updates the current URL query parameter with `history.replaceState`.
- Preserves existing query parameters such as `guard=1`.
- Does not reload the page.

Failure handling is conservative. If local storage, URL parsing, or history updates fail, the UI still switches language for the current session when possible.

## UI Copy Model

Copy is grouped by feature area inside the dictionary:

- `shell`: brand subtitle, account picker, workspace tabs, sync pill, language switcher.
- `messages`: chat list, message stream, filters, pager, sender actions, reply snippets, attachments, downloads, and empty states.
- `guard`: runtime summary, managed groups, policy labels, rule list, rule editor, activity, and empty states.
- `common`: shared actions and status words such as refresh, loading, cancel, save, enabled, disabled, delete, unknown, and error labels.

Known semantic statuses are localized. Raw backend values that may be useful for debugging remain visible if the UI has no known mapping.

Dates use `Intl.DateTimeFormat(locale, ...)` so English and Chinese displays follow the selected locale. Numbers remain plain numeric output for now.

## Data Flow

The backend remains unchanged:

- `startWebServer` still serves the same static Vite app.
- `guardOnly: true` still redirects `/` to `?guard=1`.
- API response shapes do not gain locale fields.
- Existing guard and message endpoints continue to return the same data.

The frontend applies locale at render time only. User actions such as filtering, syncing, downloading, creating rules, toggling rules, and deleting rules keep the same API payloads.

## Error Handling

Localized UI chrome can wrap or introduce errors, but backend error messages are not translated. For example:

- Sync task errors keep the backend code and message.
- API unwrap errors continue to expose `code: message`.
- Download warnings keep backend-provided warning messages.

Fallback behavior:

- Unsupported `?lang=` values are ignored.
- Invalid stored locale values are ignored.
- Missing dictionary keys should be caught by TypeScript typing rather than runtime fallback.

## Testing

Add or update frontend tests to cover:

- `resolveInitialLocale` priority: URL, storage, navigator languages, fallback.
- Chinese aliases map to `zh-CN`; English aliases map to `en`; unsupported values return `null`.
- `guardOnlyMode('?guard=1&lang=zh-CN')` remains true.
- The i18n dictionary contains both `en` and `zh-CN` with the same typed key structure.
- The app source includes the locale selector and uses the i18n module for major UI areas.
- Existing exported helpers for pagination, sender filtering, Guard payload generation, and CSS status mapping still behave the same.

Verification commands:

```sh
pnpm exec vitest run tests/web/frontend-assets.test.ts
pnpm typecheck
pnpm build:web
```

## Acceptance Criteria

- `tg web` opens the local web UI in browser-selected English or Simplified Chinese.
- `tg guard start` opens Guard-only mode and still preserves `?guard=1` while allowing `lang`.
- Users can switch language from the top bar without reloading.
- The language selection persists across reloads in the same browser.
- Message browser and Guard workbench UI chrome are available in both supported languages.
- API behavior, stored data, CLI command behavior, and structured contracts remain unchanged.
