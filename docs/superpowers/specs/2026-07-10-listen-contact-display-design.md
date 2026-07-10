# Listen Contact Display Design

## Goal

Display Telegram contact cards directly in `tg listen` with the contact's name and phone number. Contact cards are structured message content, not downloadable files, so they must never offer or enter the attachment download interaction.

## Presentation

When media summaries are enabled, a contact card uses this single-line format in both interactive and plain-text listen output:

```text
👤 Contact · Zhang San · +86 13800138000
```

The display name joins the non-empty Telegram `firstName` and `lastName` fields with one space. Empty fields are omitted:

- Name and phone: `👤 Contact · Zhang San · +86 13800138000`
- Name only: `👤 Contact · Zhang San`
- Phone only: `👤 Contact · +86 13800138000`
- Neither: `👤 Contact`

The phone number is shown exactly as Telegram provides it. `--no-media` continues to hide the contact row together with other media summaries.

## Data Flow

The formatter reads `firstName`, `lastName`, and `phoneNumber` from the existing serialized `messageMediaContact` object in `raw_json`. It also accepts the equivalent snake-case field names for compatibility with stored or fixture data.

Rendering does not refetch the message, resolve the contact's Telegram user, or make any other network request. The existing database schema and structured message storage remain unchanged. The contact's `userId` and `vcard` fields are not displayed in this version.

## Download Interaction

Contact cards remain media descriptions with `downloadable: false`. Interactive rendering displays their label as an informational row without a `[Download]` action, download state, selection highlight, or generated filename.

The attachment collector must include only descriptions whose `downloadable` field is true. This makes the interaction boundary consistent for every non-downloadable media type, including contacts, polls, locations, venues, webpages, invoices, and any future informational media.

Downloadable photos, documents, videos, audio, voice messages, stickers, and animations retain their current focus, progress, completion, and failure behavior.

## Error Handling

Missing or malformed optional contact fields degrade to the fallback formats above and do not terminate listening. Because contact rows cannot start downloads, they cannot produce `Message ... was not found` or `This attachment cannot be downloaded` states.

Other media detection and download errors remain unchanged.

## Testing

Focused tests will verify:

- A contact with a full name and phone number produces the complete inline label.
- Empty first name, last name, or phone fields produce the specified fallback labels.
- Contact fields can be read from the serialized mtcute camel-case shape and compatible snake-case shape.
- A contact remains marked non-downloadable.
- Interactive contact rows contain no download action or download state.
- Contact rows are excluded from attachment focus and cannot trigger `downloadMessageMedia`.
- Existing downloadable media rows remain selectable and keep their current download action.
- Plain-text contact output uses the same inline label.
- `--no-media` continues to omit contact rows.

Final verification will run:

```text
pnpm test
pnpm typecheck
```

## Out of Scope

- Exporting `.vcf` files.
- Expanding or collapsing contact details.
- Adding the contact to an address book or Telegram contacts.
- Resolving usernames or profiles from `userId`.
- Displaying arbitrary fields embedded in `vcard`.
- Changing structured JSON or YAML output contracts.
