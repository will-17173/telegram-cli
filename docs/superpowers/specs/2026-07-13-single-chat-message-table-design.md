# Single-Chat Message Table Design

## Goal

Make human-readable message tables easier to scan when a command targets one chat. Show the resolved chat name once in the table title instead of repeating it in every row.

## Scope

Apply the single-chat layout to the four message-list commands that accept `--chat`:

- `search`
- `recent`
- `today`
- `filter`

This change affects human-readable output only. JSON and YAML data retain their current fields and values.

## Human-Readable Output Contract

When `--chat` is present and resolves to one local chat:

- Prefix the existing view title with the resolved chat name in brackets.
- Use the columns `TIME`, `SENDER`, and `MESSAGE`.
- Omit the repeated chat name from every row.

For example, `tg recent --chat -1002476222533` renders the title `[Daily Chat] Recent Messages` and a three-column table.

Use the command-specific base titles without other changes:

- `[chat name] Search Results`
- `[chat name] Recent Messages`
- `[chat name] Today`
- `[chat name] Filtered Messages`

If the stored chat name is null or empty, use the canonical chat ID inside the brackets.

When `--chat` is absent, preserve the current title, `TIME | CHAT | SENDER | MESSAGE` columns, and row content because the result may contain multiple chats.

## Chat Resolution and Presentation

Extend the query service's existing chat-resolution result to retain both the canonical chat ID and its stored display name. Pass the display label to the message-table presenter only for an explicit single-chat query.

The presenter remains responsible for table shape. With a chat label it builds the prefixed title and three-column rows; without a chat label it produces the existing four-column table. Because the label comes from chat resolution rather than the first result row, an empty result still has the correct title, and an ID-based query still displays the stored chat name.

## Errors and Compatibility

Keep existing validation and chat-resolution errors unchanged:

- An unknown chat returns `chat_not_found`.
- A partial name matching multiple chats returns `ambiguous_chat`.
- Invalid limits, hours, or regular expressions retain their current errors.

Do not change database queries, ordering, message data, empty-state text, structured output, or aggregate views such as `stats`, `top`, and `timeline`.

## Testing

Add regression coverage for:

- `messageTable` with and without a single-chat label.
- All four scoped query-service methods with `--chat` semantics.
- Chat ID input resolving to a stored chat name.
- Empty single-chat results retaining the resolved title.
- A missing stored name falling back to the canonical chat ID.
- Unfiltered multi-chat output retaining the `CHAT` column.
- JSON and YAML contracts remaining unchanged.

Run focused presenter, service, and CLI contract tests, followed by `pnpm test` and `pnpm typecheck`.

## Out of Scope

- Changing structured message rows.
- Removing the `CHAT` column from unfiltered results.
- Changing titles for non-message views.
- Adding new CLI options or configuration.
