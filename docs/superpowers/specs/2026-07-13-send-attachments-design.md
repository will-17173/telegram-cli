# Send Attachments Design

## Goal

Extend the existing `send` command so it can send text, one local attachment, or multiple local attachments to a required Telegram chat. When text and attachments are supplied together, Telegram must receive one media message or media group with the text as its caption, rather than a separate text message.

## Command Contract

The command accepts these forms:

```bash
tg send <chat> "Text"
tg send <chat> --file photo.jpg --file video.mp4
tg send <chat> "Text" --file photo.jpg --file video.mp4
```

- `<chat>` remains required.
- `[message]` becomes optional.
- `--file <path>` is repeatable and preserves argument order.
- At least one non-blank message or one attachment is required.
- Existing `--reply`, `--no-preview`, `--json`, and `--yaml` options remain available.
- `--reply` applies to text messages, single-media messages, and media groups.
- `--no-preview` affects text-only messages. Telegram media captions do not use the text-message web-preview option.

## Sending Behavior

The command selects one of three adapter operations:

1. Text only uses mtcute `sendText`, preserving current behavior.
2. One attachment uses mtcute `sendMedia`.
3. Multiple attachments use mtcute `sendMediaGroup` so Telegram presents them as one album/media group.

For attachment sends, an optional message is used as the caption. For a media group, the caption is attached only to its first media item, as required by mtcute. No separate text message is sent.

Files are passed to mtcute as local paths so mtcute can infer whether each item is a photo, video, or document. Unsupported media-group combinations or Telegram-side limits are returned as normal `telegram_error` failures; the CLI does not silently split a requested group into separate messages.

## Validation and Errors

Before contacting Telegram, the service validates:

- the chat is non-blank;
- the optional reply ID is a positive integer;
- text or at least one file is present;
- every supplied path exists, resolves to a regular file, and is readable.

All paths are validated before any upload starts. If one path is invalid, the whole operation fails with `invalid_option` and nothing is sent. Error text identifies the invalid path without exposing unrelated filesystem details.

An empty or whitespace-only message is treated as absent when files are present. It is invalid when no files are present.

## Internal Boundaries

The Telegram adapter gains a media-send input containing the chat, ordered file paths, optional caption, and optional reply ID. The mtcute adapter chooses `sendMedia` or `sendMediaGroup` based on the number of files and maps every returned Telegram message into the existing stored-message representation.

`MessageService` owns input validation and chooses between text and attachment adapter calls. The Commander registration only parses the optional positional message and collects repeated `--file` values; it does not perform Telegram or filesystem work.

The fake Telegram client records media-send calls and returns deterministic message IDs so service and command tests remain independent of live Telegram.

## Result Contract

Text-only success retains the existing canonical shape, including `msg_id`:

```json
{
  "sent": true,
  "msg_id": 99,
  "chat": "TestGroup"
}
```

Attachment success reports all Telegram message IDs and the submitted file paths:

```json
{
  "sent": true,
  "msg_id": 100,
  "msg_ids": [100, 101],
  "chat": "TestGroup",
  "files": ["photo.jpg", "video.mp4"]
}
```

`msg_id` is the first returned ID, providing a convenient primary ID and preserving a consistent field for send successes. `reply_to` is included when supplied. Human-readable output renders the same canonical fields through the existing detail presenter.

## Tests

Tests cover:

- unchanged text-only behavior;
- optional positional message parsing;
- repeated `--file` parsing in order;
- one attachment with and without a caption;
- multiple attachments with the caption only on the first media item;
- reply forwarding for attachment sends;
- rejection when neither text nor files are supplied;
- rejection of missing, unreadable, and non-file paths before contacting Telegram;
- structured Telegram failures;
- stable JSON/YAML and human-readable result data;
- adapter mapping of single and grouped mtcute results.

The full Vitest suite and strict TypeScript check must pass before completion.
