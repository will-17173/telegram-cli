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
    expect(await controller.submit('/member kick 7', 0)).toMatchObject({
      kind: 'pending', pending, request: { key: 'member kick', values: { user: 7 } }, input: '/member kick 7',
    })
  })

  it('snapshots mutable parsed values before confirmation', async () => {
    const pending = { ok: false as const, confirmation: { risk: 'confirm' as const, chat: 1, summary: 'Delete' } }
    const controller = createGroupCommandController({ execute: vi.fn().mockResolvedValue(pending) })
    const outcome = await controller.submit('/message delete 1 2', 0)
    expect(outcome).toMatchObject({ kind: 'pending', request: { values: { ids: [1, 2] } } })
    if (outcome.kind === 'pending') expect(Object.isFrozen((outcome.request.values as { ids: readonly number[] }).ids)).toBe(true)
  })

  it('turns rejected execution into an editable error outcome', async () => {
    const controller = createGroupCommandController({ execute: vi.fn().mockRejectedValue(new Error('lookup failed')) })
    await expect(controller.submit('/topic list', 0)).resolves.toEqual({ kind: 'error', message: 'lookup failed' })
  })
})
