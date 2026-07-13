import React from 'react'
import { renderToString } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import * as groupExecutor from '../../src/group-commands/executor.js'
import {
  ListenCommandMenu,
  listenCommandMenuAvailability,
  moveListenCommandSelectionEnabled,
} from '../../src/presenters/ink/listen-command-menu.js'
import { visibleListenCommandMatches } from '../../src/listen-commands/match.js'

describe('ListenCommandMenu', () => {
  it('uses the unified bounded matches for reply and group commands', () => {
    expect(visibleListenCommandMatches('/')).toHaveLength(6)
    expect(renderToString(<ListenCommandMenu input="/" selectedIndex={0} width={64} />)).toContain('reply')
    expect(renderToString(<ListenCommandMenu input="/rep" selectedIndex={0} width={64} />)).toContain('Reply to a message')
    expect(renderToString(<ListenCommandMenu input="/ban" selectedIndex={0} width={64} />)).toContain('member ban')
  })

  it('keeps reply enabled without evaluating group availability', () => {
    const evaluate = vi.spyOn(groupExecutor, 'evaluateGroupCommandAvailability')
    const matches = visibleListenCommandMatches('/rep')
    const availability = listenCommandMenuAvailability('/rep', undefined)
    expect(availability[matches.findIndex(match => match.definition.kind === 'reply')]).toBeUndefined()
    expect(evaluate).toHaveBeenCalledTimes(matches.filter(match => match.definition.kind === 'group').length)
    evaluate.mockRestore()
  })

  it('disables unavailable group commands and renders their reason', () => {
    const knownGroup = {
      id: 1,
      title: 'Known group',
      username: null,
      type: 'group' as const,
      member_count: 2,
      current_user_role: 'member' as const,
      current_user_rank: null,
      permissions: null,
      default_restrictions: null,
      slow_mode_seconds: null,
      message_ttl_seconds: null,
      content_protected: false,
      forum: false,
    }
    const availability = listenCommandMenuAvailability('/ban', knownGroup)
    expect(availability[0]).toMatchObject({ ok: false })
    expect(renderToString(<ListenCommandMenu input="/ban" selectedIndex={0} width={80} knownGroup={knownGroup} />))
      .toContain('disabled:')
  })

  it('renders selected usage and keeps wide-character lines within display width', () => {
    const output = renderToString(<ListenCommandMenu input="/chat title 群组群组群组" selectedIndex={0} width={24} />)
    expect(output).toContain('Usage:')
    expect(output.split('\n').every(line => stringWidth(line) <= 24)).toBe(true)
  })

  it('skips disabled choices in both directions', () => {
    expect(moveListenCommandSelectionEnabled(0, 1, [false, true, false, true])).toBe(2)
    expect(moveListenCommandSelectionEnabled(2, -1, [false, true, false, true])).toBe(0)
    expect(moveListenCommandSelectionEnabled(0, 2, [false, false, false])).toBe(2)
  })

  it('safely handles empty, all-disabled, and out-of-range selections', () => {
    expect(moveListenCommandSelectionEnabled(9, 1, [])).toBe(0)
    expect(moveListenCommandSelectionEnabled(9, 1, [true, true])).toBe(1)
    expect(moveListenCommandSelectionEnabled(9, 1, [false, true, false])).toBe(2)
  })
})
