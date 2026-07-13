# Listen Sender ID Design

## Goal

Make the sender's Telegram ID visible beside their name in the interactive `listen` interface.

## Design

The listen presentation row carries the source message's nullable `sender_id` separately from its existing sender display name. The interactive header renders the sender as `Name (ID)` when the ID is available. In multi-chat mode, the full header remains `[time] Chat Name | Name (ID)`.

When `sender_id` is absent, the header remains unchanged and does not render empty parentheses. Message content, attachments, and plain-text or structured output contracts remain unchanged.

## Testing

Add focused presenter tests for a named sender with an ID and for the missing-ID fallback. Verify the interactive header formatter in both single-chat and multi-chat forms, then run the complete Vitest suite and TypeScript typecheck.
