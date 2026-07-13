# History Flood Control Design

## Problem

Fetching 5,000 history messages requires roughly 50 `messages.getHistory` requests because Telegram typically returns at most 100 objects per page. The current adapter consumes those pages without a pause. Telegram can respond with `FLOOD_WAIT_X`, and the command currently terminates instead of waiting and continuing.

Telegram does not publish a stable request-per-second quota for this method. The server-provided wait duration is authoritative, so the client must combine proactive pacing with reactive flood-wait handling.

## CLI Contract

Add `--delay <seconds>` to `history` and `sync`, defaulting to `1`. It controls the delay between history pages within one chat. The value must be a finite, non-negative number.

Keep the existing `sync-all --delay` and `refresh --delay` meaning unchanged: it remains the delay between chats. Their per-page delay uses the new default of one second internally so the existing CLI contract is not overloaded with two meanings.

## Pagination and Pacing

Move explicit page control into the mtcute adapter:

1. Request at most 100 messages with `getHistory()`.
2. Append the returned page and report accumulated progress.
3. If another page is required, wait for `pageDelay` with random jitter of plus or minus 20 percent.
4. Continue from mtcute's returned pagination offset until the requested limit is reached or no next offset exists.

No delay is added after the final page. A zero delay disables proactive pacing.

## Flood-Wait Recovery

When the current page fails with `FLOOD_WAIT_X`:

- Wait for `X + 1` seconds before retrying the same page.
- Do not advance the pagination offset or discard earlier pages.
- Allow at most five automatic flood-wait retries for the entire history operation.
- After the fifth retry, propagate the Telegram error through the existing structured error boundary.

Only `FLOOD_WAIT_X` receives this treatment. Other Telegram and network errors retain current behavior. The adapter holds fetched rows in memory and the service writes them only after the complete operation succeeds, so retries do not create partial database state.

## API Credentials

The existing warning for default Telegram credentials remains. The flood-control behavior protects requests, but it does not remove the need for users performing large syncs to configure their own Telegram API ID and hash.

## Testing

Use fake timers and mocked mtcute pages to cover:

- Multiple pages are separated by the configured delay and no delay follows the last page.
- Jitter stays within the documented range.
- A `FLOOD_WAIT_14` response waits 15 seconds and retries the same offset.
- A successful retry returns all accumulated messages without duplication.
- The sixth flood wait is propagated.
- Invalid CLI delay values are rejected before Telegram is called.
- Existing `sync-all --delay` continues to represent inter-chat delay.

Run focused adapter and command tests, then the full Vitest suite and strict TypeScript validation.
