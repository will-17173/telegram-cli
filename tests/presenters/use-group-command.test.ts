import React, { act, useEffect } from 'react'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { createGroupCommandController, useGroupCommand } from '../../src/presenters/ink/use-group-command.js'
import type { ParsedGroupCommandRequest } from '../../src/group-commands/parser.js'

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

describe('useGroupCommand ownership password flow', () => {
  it('moves confirm to password to executing to result without retaining plaintext', async () => {
    const states: string[] = []
    let resolveExecution: ((value: { ok: true; data: { operation: 'transferOwnership'; chat_id: number } }) => void) | undefined
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, confirmation: { risk: 'confirm', chat: 1, summary: 'Transfer ownership' } })
      .mockResolvedValueOnce({ ok: false, secretRequired: { kind: 'ownership_password' } })
      .mockImplementationOnce((_request, options) => new Promise((resolve) => {
        expect(options).toEqual({ confirmed: true, ownershipPassword: 'secret' })
        resolveExecution = resolve
      }))
    let command: ReturnType<typeof useGroupCommand> | undefined
    const stdout = new PassThrough()
    const app = render(React.createElement(HookHarness, { execute, onChange: (next) => {
      command = next
      const kind = next.state.kind
      if (['confirm', 'password', 'executing', 'result'].includes(kind) && states.at(-1) !== kind) states.push(kind)
    } }), { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })

    await act(async () => { await command!.submit('/admin transfer-owner 7', 0) })
    expect(command!.state.kind).toBe('confirm')
    const current = command!
    const request = (current.state as Extract<typeof current.state, { kind: 'confirm' }>).request
    await act(async () => { await command!.runConfirmed(request) })
    expect(command!.state.kind).toBe('password')
    expect(JSON.stringify(command!.state)).not.toContain('secret')

    let execution: Promise<void> | undefined
    act(() => { execution = command!.runWithOwnershipPassword('secret') })
    await vi.waitFor(() => expect(command!.state.kind).toBe('executing'))
    resolveExecution!({ ok: true, data: { operation: 'transferOwnership', chat_id: 1 } })
    await act(async () => { await execution })

    expect(states).toEqual(['confirm', 'password', 'executing', 'result'])
    expect(JSON.stringify(command!.state)).not.toContain('secret')
    app.unmount()
  })

  it('invalidates a captured password callback when Escape/cancel closes the prompt', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, confirmation: { risk: 'confirm', chat: 1, summary: 'Transfer ownership' } })
      .mockResolvedValueOnce({ ok: false, secretRequired: { kind: 'ownership_password' } })
    let command: ReturnType<typeof useGroupCommand> | undefined
    const app = render(React.createElement(HookHarness, { execute, onChange: next => { command = next } }), {
      stdout: new PassThrough() as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { await command!.submit('/admin transfer-owner 7', 0) })
    const current = command!
    const request = (current.state as Extract<typeof current.state, { kind: 'confirm' }>).request
    await act(async () => { await command!.runConfirmed(request) })
    const staleSubmit = command!.runWithOwnershipPassword
    act(() => { command!.close() })

    await act(async () => { await staleSubmit('secret') })

    expect(command!.state).toEqual({ kind: 'closed' })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(command!.state)).not.toContain('secret')
    app.unmount()
  })

  it('invalidates a captured password callback when the hook unmounts', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, confirmation: { risk: 'confirm', chat: 1, summary: 'Transfer ownership' } })
      .mockResolvedValueOnce({ ok: false, secretRequired: { kind: 'ownership_password' } })
    let command: ReturnType<typeof useGroupCommand> | undefined
    const app = render(React.createElement(HookHarness, { execute, onChange: next => { command = next } }), {
      stdout: new PassThrough() as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { await command!.submit('/admin transfer-owner 7', 0) })
    const current = command!
    const request = (current.state as Extract<typeof current.state, { kind: 'confirm' }>).request
    await act(async () => { await command!.runConfirmed(request) })
    const staleSubmit = command!.runWithOwnershipPassword
    app.unmount()

    await staleSubmit('secret')

    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('invalidates a captured password callback when an external error replaces the prompt', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, confirmation: { risk: 'confirm', chat: 1, summary: 'Transfer ownership' } })
      .mockResolvedValueOnce({ ok: false, secretRequired: { kind: 'ownership_password' } })
    let command: ReturnType<typeof useGroupCommand> | undefined
    const app = render(React.createElement(HookHarness, { execute, onChange: next => { command = next } }), {
      stdout: new PassThrough() as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { await command!.submit('/admin transfer-owner 7', 0) })
    const current = command!
    const request = (current.state as Extract<typeof current.state, { kind: 'confirm' }>).request
    await act(async () => { await command!.runConfirmed(request) })
    const staleSubmit = command!.runWithOwnershipPassword
    act(() => { command!.setState({ kind: 'error', message: 'connection closed' }) })

    await act(async () => { await staleSubmit('secret') })

    expect(command!.state).toEqual({ kind: 'error', message: 'connection closed' })
    expect(execute).toHaveBeenCalledTimes(2)
    app.unmount()
  })
})

function HookHarness({ execute, onChange }: {
  execute: (request: ParsedGroupCommandRequest, options?: { confirmed?: boolean; confirmationTitle?: string; ownershipPassword?: string }) => Promise<import('../../src/group-commands/executor.js').GroupCommandExecutionResult>
  onChange: (value: ReturnType<typeof useGroupCommand>) => void
}): null {
  const command = useGroupCommand(execute)
  useEffect(() => onChange(command), [command.state])
  return null
}
