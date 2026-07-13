import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { GroupCommandConfirm } from '../../src/presenters/ink/group-command-confirm.js'

describe('GroupCommandConfirm', () => {
  it('renders the frozen action context and selects Cancel by default', () => {
    const output = renderToString(<GroupCommandConfirm confirmation={{
      risk: 'confirm', chat: 100, target: '7', summary: 'Ban member',
      details: { durationSeconds: 3600, permissions: ['ban_users'] },
    }} selectedIndex={1} width={60} />)
    expect(output).toContain('Ban member')
    expect(output).toContain('Chat: 100')
    expect(output).toContain('Target: 7')
    expect(output).toContain('durationSeconds: 3600')
    expect(output).toContain('permissions: ban_users')
    expect(output).toContain('› Cancel')
  })
})
