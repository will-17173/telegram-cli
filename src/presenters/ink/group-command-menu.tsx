/** @deprecated Use listen-command-menu. Kept until listen.tsx migrates. */
export {
  ListenCommandMenu as GroupCommandMenu,
  listenCommandMenuAvailability as groupCommandMenuAvailability,
  moveListenCommandSelectionEnabled as moveGroupCommandSelectionEnabled,
} from './listen-command-menu.js'

export {
  MAX_LISTEN_COMMAND_MATCHES as MAX_GROUP_COMMAND_MATCHES,
  visibleListenCommandMatches as visibleGroupCommandMatches,
} from '../../listen-commands/match.js'

/** @deprecated Use enabled listen-command selection. */
export function moveGroupCommandSelection(current: number, delta: number, count: number): number {
  return count === 0 ? 0 : (current + delta + count) % count
}
