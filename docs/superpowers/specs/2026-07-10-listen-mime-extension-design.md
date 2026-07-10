# Listen MIME Extension Design

## Problem

Telegram documents without a supplied filename currently use the generic `.bin` fallback even when their metadata contains a known MIME type such as `video/mp4`.

## Design

Carry the MIME type discovered from Telegram's raw message metadata on `ListenAttachment`. When no Telegram filename is available, `attachmentFileName` will first map a known MIME type to an extension, then fall back to the existing media-kind extension and finally `.bin`.

The initial mapping will cover common attachment MIME types while keeping unknown values safe. An explicit Telegram filename always remains authoritative.

## Testing

Add a regression test proving that a filename-less `messageMediaDocument` with `video/mp4` metadata produces an `.mp4` download filename. Retain coverage for explicit filenames and unknown document MIME types falling back to `.bin`. Run the full Vitest suite and strict TypeScript validation.
