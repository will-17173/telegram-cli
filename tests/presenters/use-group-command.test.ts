import { describe, expect, it, vi } from 'vitest'
import { createGroupCommandController } from '../../src/presenters/ink/use-group-command.js'

describe('group command controller', () => {
  it('completes an incomplete command before execution', async () => {
    const execute = vi.fn()
    const controller = createGroupCommandController({ execute })
    expect(await controller.submit('/mem b', 0)).toEqual({ kind: 'complete', input: '/member ban ' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns readable parse errors without execution', async () => {
    const execute = vi.fn()
    const controller = createGroupCommandController({ execute })
    const result = await controller.submit('/member ban', 0)
    expect(result).toMatchObject({ kind: 'error', usage: 'group member ban <user>' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('executes complete commands and preserves pending executor results', async () => {
    const pending = { ok: false as const, confirmation: { risk: 'confirm' as const, chat: 1, summary: 'Kick' } }
    const controller = createGroupCommandController({ execute: vi.fn().mockResolvedValue(pending) })
    expect(await controller.submit('/member kick 7', 0)).toEqual({ kind: 'pending', pending })
  })
})
