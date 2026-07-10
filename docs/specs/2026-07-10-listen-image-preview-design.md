# Ink Listen Image Preview Design

## Goal

Show Telegram photo attachments as small color previews in the default interactive `listen` interface. The preview must use the thumbnail embedded in the incoming Telegram message and must not download the original photo.

Plain `--no-interactive` output, persisted message data, structured output, and attachment downloads remain unchanged.

## Telegram thumbnail source

For photo messages, mtcute exposes a `Photo` whose `thumbnails` may contain a `Thumbnail.THUMB_STRIP` entry backed by Telegram's `photoStrippedSize` data. That data is an abbreviated JPEG payload, not a directly displayable image or base64 string.

mtcute converts the stripped payload into complete JPEG bytes when the thumbnail's embedded `FileLocation` is read. The adapter will use this high-level representation rather than parsing `message.raw` or reconstructing the JPEG format itself. Reading this location is local and does not issue a Telegram file download.

If the message is not a photo, has no stripped thumbnail, or the embedded location cannot be resolved, the adapter will omit the preview without failing message delivery.

## Data flow

The Telegram adapter will extract the complete thumbnail JPEG bytes while converting an mtcute `Message` to the application's incoming message shape. The bytes will be encoded as base64 in a dedicated optional transient preview field.

The preview will not be inserted into `raw_json`. This avoids relying on `JSON.stringify(Uint8Array)`, keeps Telegram transport details out of presenter parsing, and makes the preview contract explicit.

The field is transient for live listening. Database persistence will continue to store the existing message fields and raw Telegram object only; thumbnail base64 will not be written to SQLite.

## Rendering

Only the Ink presenter will consume the preview field. A focused image-preview module will:

1. Decode the base64 JPEG with a pure JavaScript decoder that requires no native build tools.
2. Preserve aspect ratio while scaling the image to a small maximum terminal width.
3. Combine two vertical pixels into one `▀` character.
4. Assign the upper pixel as ANSI true-color foreground and the lower pixel as background.
5. Reset color attributes at the end of every rendered line.

The preview appears below its `📎 Photo` attachment line. Its rendered row count becomes part of the message height calculation so the existing viewport and scrollbar continue to select complete messages.

Preview dimensions will be capped to keep message arrival and terminal redraw inexpensive. The renderer may reduce the width further when the terminal content area is narrow.

## Compatibility and fallback

The first implementation deliberately avoids Kitty, iTerm2, and Sixel image protocols because their out-of-band image placement can conflict with Ink's repaint and scrolling model.

When true-color output is unavailable, decoding fails, the payload is invalid, or no stripped thumbnail exists, the interface will render the existing attachment label with no preview. A malformed thumbnail must never terminate `listen` or hide the attachment.

`--no-media` suppresses both the attachment label and its preview. `--no-interactive` retains its current text-only attachment summary.

## Boundaries

- Telegram and mtcute-specific thumbnail extraction stays in `src/telegram/`.
- JPEG decoding and ANSI pixel generation live in a presenter helper with no Telegram dependency.
- `ListenAttachment` carries only the optional preview data needed by Ink.
- The Ink component decides whether terminal capabilities and available width permit rendering.
- Services and storage do not render terminal output.

## Testing

Tests will be written before production changes and will cover:

- extracting an embedded stripped photo thumbnail through the mtcute-facing conversion path;
- omitting previews for absent, unsupported, or invalid thumbnail data;
- converting known image pixels into correctly reset ANSI half-block rows;
- rendering the preview beneath a photo attachment in Ink;
- preserving the existing attachment-only fallback;
- including preview rows in viewport height calculations;
- keeping plain listen output unchanged.

The completed change will be verified with the focused Vitest tests, the full `pnpm test` suite, and `pnpm typecheck`.
