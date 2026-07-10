# Listen Transient Scrollbar Design

## Goal

Show a Codex-like transient scrollbar in interactive `listen` so users can see their position while browsing message history.

## Interaction

- A one-column scrollbar appears at the right edge whenever the mouse wheel is used.
- It remains visible while scrolling continues and hides 1.5 seconds after the latest wheel event.
- Every wheel event restarts the hide timer, including events at the oldest or newest boundary.
- The scrollbar is not shown when all messages fit in the current message viewport.
- The rightmost column remains reserved while the scrollbar is hidden so content does not shift horizontally.

## Rendering

The root Ink layout becomes a horizontal row containing the existing listener content and a one-column scrollbar gutter. The content keeps its current fixed-height behavior and uses the terminal width minus one column.

The gutter renders a vertical thumb only while transient visibility is active. Thumb height is proportional to the visible message count relative to the full message count, clamped to at least one row and at most the available message-pane height. Thumb position is derived from the scroll offset: the oldest position is at the top and live view is at the bottom.

The scrollbar represents complete-message navigation rather than terminal output lines, matching the existing message-based wheel behavior. It uses a dim neutral glyph and does not accept clicks or dragging.

## State and Lifecycle

A reusable hook owns transient visibility and its timeout. Its wheel-event callback sets visibility immediately, clears the previous timer, and schedules hiding after 1,500 milliseconds. Component unmount clears the timer.

The existing mouse-scroll callback invokes the visibility callback before applying the scroll transition. Terminal mouse reporting and cleanup remain unchanged.

## Testing

- Unit-test thumb height and top position at the newest, middle, and oldest offsets.
- Unit-test clamping and the no-scrollable-history result.
- Use fake timers to verify immediate visibility, timer restart, 1.5-second hiding, and unmount cleanup.
- Render-test that the gutter width remains reserved while its thumb is hidden.
- Run focused presenter tests, the complete Vitest suite, and TypeScript validation.

## Out of Scope

- Native terminal scrollback integration.
- Scrollbar clicking, dragging, hover behavior, or animation.
- Changes to `--no-interactive` output.
