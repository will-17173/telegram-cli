import React from 'react'
import { renderToString } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { GroupCommandMenu, moveGroupCommandSelection } from '../../src/presenters/ink/group-command-menu.js'

describe('GroupCommandMenu', () => {
  it('renders selected path, summary, usage and disabled alternatives', () => {
    const output = renderToString(<GroupCommandMenu input="/member ban" selectedIndex={0} width={64} />)
    expect(output).toContain('member ban')
    expect(output).toContain('Ban a member')
    expect(output).toContain('Usage:')
  })

  it('keeps every line within its display width with wide characters', () => {
    const output = renderToString(<GroupCommandMenu input="/chat title 群组群组群组" selectedIndex={0} width={24} />)
    expect(output.split('\n').every(line => stringWidth(line) <= 24)).toBe(true)
  })

  it('wraps selection in both directions', () => {
    expect(moveGroupCommandSelection(0, -1, 3)).toBe(2)
    expect(moveGroupCommandSelection(2, 1, 3)).toBe(0)
    expect(moveGroupCommandSelection(0, 1, 0)).toBe(0)
  })
})
