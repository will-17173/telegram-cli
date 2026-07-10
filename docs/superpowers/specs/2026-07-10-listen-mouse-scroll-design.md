# Listen Mouse Scrolling Design

## Goal

Allow users of the interactive `listen` command to inspect older messages with the mouse wheel without losing the fixed composer and attachment controls.

## Interaction

- The message pane starts at the newest messages and follows new arrivals while it remains at the bottom.
- Scrolling up moves toward older complete messages. Scrolling down moves toward newer complete messages.
- Once the user leaves the bottom, new arrivals do not move the viewport.
- While the viewport is away from the bottom, the status area shows the number of messages that arrived since the user left the live view.
- Returning to the bottom clears the new-message indicator and resumes automatic following.
- Scrolling stops at the oldest and newest available messages.

## Architecture

The Ink presenter will keep a message-based scroll offset in component state. A pure viewport helper will select the newest complete messages that fit the available line budget, starting at that offset. Message-based movement avoids rendering partial messages and makes terminal resizing deterministic.

A small terminal mouse-input helper will enable basic mouse tracking and SGR extended coordinates while the interactive listener is mounted. It will parse wheel-up and wheel-down SGR input sequences and expose only those directions to the component. Cleanup will always disable both terminal modes and remove the input listener, including normal exit and unmount paths.

The implementation will use the existing Ink stdin context instead of adding a dependency. Terminals that do not implement SGR mouse reporting will retain the current behavior; no plain-text output behavior changes.

## State and Data Flow

The component tracks:

- `scrollOffset`: number of complete messages below the current viewport; zero means live view.
- `unseenCount`: messages received while `scrollOffset` is greater than zero.

Wheel-up increases the offset within the message-list boundary. Wheel-down decreases it. Reaching zero also resets `unseenCount`. A new message at offset zero remains visible through the existing follow-latest behavior. A new message at a positive offset increments both the offset and unseen count so the same historical messages remain visible.

Attachment selection continues to operate only on attachments currently visible in the viewport. Existing input, Tab, arrow-key, Enter, Escape, and Ctrl+C handling remains unchanged.

## Failure and Cleanup Behavior

Mouse reporting is enabled only for interactive TTY sessions. Writes that enable or disable reporting use the active terminal output stream. Cleanup is idempotent so an abort, listener failure, or React unmount cannot leave mouse tracking enabled in the user's shell.

Malformed, partial, button-click, drag, and motion sequences are ignored. Ordinary keyboard input must not be consumed by the mouse parser.

## Testing

- Unit-test viewport selection at the bottom, at a historical offset, and at both boundaries.
- Unit-test scroll-state transitions, including anchoring when new messages arrive and clearing unseen messages at the bottom.
- Unit-test SGR wheel parsing and rejection of unrelated or malformed input.
- Test mouse reporting enable/disable output and idempotent cleanup.
- Run the focused presenter tests, the complete Vitest suite, and strict TypeScript validation.

## Out of Scope

- Scrollbar rendering, click selection, dragging, touch gestures, and horizontal scrolling.
- Persisting scroll position between `listen` sessions.
- Changing the non-interactive `--no-interactive` output path.
