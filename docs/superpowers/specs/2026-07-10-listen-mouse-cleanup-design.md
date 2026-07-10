# Listen Mouse Cleanup Design

## Problem

Interactive `listen` enables terminal mouse reporting so wheel events can scroll message history. After `listen` exits, the terminal sometimes continues sending SGR mouse sequences such as `ESC[<64;77;31M`. The shell then receives those bytes and displays fragments such as `64;77;31M` in its input line.

The current React effect enables and disables mouse reporting through Ink's `useStdout().write`. Ink marks its renderer as unmounted before React effect cleanup runs, and its `writeToStdout` method ignores writes after that flag is set. Consequently, the cleanup function runs but the disable sequence never reaches the terminal.

## Scope

- Disable terminal mouse reporting before control returns to the shell.
- Cover normal exit, Ctrl+C, abort, connection failure, and rendering failure through one lifecycle boundary.
- Preserve wheel parsing and listen history scrolling.
- Avoid process-global signal or exit handlers.

## Design

Move ownership of terminal mouse reporting out of the React hook and into `renderInteractiveListen`.

`renderInteractiveListen` will enable mouse reporting directly on the real stdout stream immediately before rendering. It will await the Ink application's exit inside `try/finally`, and the `finally` block will write a comprehensive disable sequence directly to stdout. Because the write bypasses Ink's renderer, it remains effective after the Ink app has unmounted.

The React `useMouseScroll` hook will retain only one responsibility: attach and remove the Ink input-event listener that parses SGR wheel reports. Its cleanup will no longer mutate terminal-global modes.

The disable sequence will turn off SGR encoding and the common mouse tracking modes (`1000`, `1002`, and `1003`). Disabling inactive modes is safe and recovers from partially configured terminal state.

## Lifecycle

1. Confirm the interactive renderer is about to start.
2. Write the enable sequence directly to stdout.
3. Render and await Ink exit.
4. In `finally`, write the disable sequence directly to stdout.
5. Return control to Commander and then the shell.

If rendering throws before an app instance is returned, `finally` still resets the terminal. If Ink exits normally, the reset occurs after unmount but before `renderInteractiveListen` resolves.

## Testing

- Add a unit-testable mouse-reporting session helper and verify enable-before-run and disable-in-finally ordering.
- Verify the disable sequence is written when the wrapped operation rejects.
- Update listener tests to confirm attaching and detaching no longer changes terminal modes.
- Retain existing wheel parsing, multiple-event, malformed-input, and normalized-input coverage.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.
