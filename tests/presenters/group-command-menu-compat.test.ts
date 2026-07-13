import { describe, expect, it } from 'vitest'

import {
  GroupCommandMenu,
  MAX_GROUP_COMMAND_MATCHES,
  groupCommandMenuAvailability,
  moveGroupCommandSelection,
  moveGroupCommandSelectionEnabled,
  visibleGroupCommandMatches,
} from '../../src/presenters/ink/group-command-menu.js'
import { MAX_LISTEN_COMMAND_MATCHES } from '../../src/listen-commands/match.js'
import { ListenCommandMenu, listenCommandMenuAvailability, moveListenCommandSelectionEnabled } from '../../src/presenters/ink/listen-command-menu.js'

describe('group-command-menu compatibility exports', () => {
  it('preserves the complete old public API until listen migrates', () => {
    expect(GroupCommandMenu).toBe(ListenCommandMenu)
    expect(MAX_GROUP_COMMAND_MATCHES).toBe(MAX_LISTEN_COMMAND_MATCHES)
    expect(groupCommandMenuAvailability).toBe(listenCommandMenuAvailability)
    expect(moveGroupCommandSelectionEnabled).toBe(moveListenCommandSelectionEnabled)
    expect(visibleGroupCommandMatches('/')).toHaveLength(MAX_GROUP_COMMAND_MATCHES)
    expect(moveGroupCommandSelection(0, -1, 3)).toBe(2)
    expect(moveGroupCommandSelection(2, 1, 3)).toBe(0)
    expect(moveGroupCommandSelection(0, 1, 0)).toBe(0)
  })
})
