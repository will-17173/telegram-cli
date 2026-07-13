import React, { act } from 'react'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import { MAX_SECURE_INPUT_LENGTH, SecureInput } from '../../src/presenters/ink/secure-input.js'

describe('SecureInput', () => {
  it('renders bullets instead of printable characters and submits the transient value', async () => {
    const stdin = new MockStdin()
    const stdout = new PassThrough()
    const frames: string[] = []
    stdout.on('data', chunk => { frames.push(chunk.toString()) })
    const onSubmit = vi.fn()
    const app = render(<SecureInput label="Telegram 2FA password" onSubmit={onSubmit} onCancel={vi.fn()} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { stdin.write('secret') })
    await vi.waitFor(() => expect(frames.at(-1)).toContain('••••••'))
    expect(frames.join('')).not.toContain('secret')
    await act(async () => { stdin.write('\u007f') })
    await vi.waitFor(() => expect(frames.at(-1)).toContain('•••••'))
    await act(async () => { stdin.write('t') })
    await vi.waitFor(() => expect(frames.at(-1)).toContain('••••••'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('secret'))
    expect(frames.join('')).not.toContain('secret')
    app.unmount()
  })

  it('clears its local value when cancelled and never submits it', async () => {
    const stdin = new MockStdin()
    const stdout = new PassThrough()
    let rendered = ''
    stdout.on('data', chunk => { rendered += chunk.toString() })
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const app = render(<SecureInput label="Telegram 2FA password" onSubmit={onSubmit} onCancel={onCancel} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { stdin.write('secret') })
    await vi.waitFor(() => expect(rendered).toContain('••••••'))
    await act(async () => { stdin.write('\u001b') })
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(rendered).not.toContain('secret')
    app.unmount()
  })

  it('counts and removes pasted grapheme clusters instead of code points', async () => {
    const stdin = new MockStdin()
    const stdout = new PassThrough()
    const frames: string[] = []
    stdout.on('data', chunk => { frames.push(chunk.toString()) })
    const onSubmit = vi.fn()
    const app = render(<SecureInput label="Password" onSubmit={onSubmit} onCancel={vi.fn()} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { stdin.write('e\u0301👩‍👩‍👧‍👦') })
    await vi.waitFor(() => expect(frames.at(-1)).toContain('› ••'))
    expect(frames.at(-1)).not.toContain('› •••')
    await act(async () => { stdin.write('\u007f') })
    await vi.waitFor(() => expect(frames.at(-1)).toContain('› •'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('e\u0301'))
    await act(async () => { stdin.write('\r') })
    expect(onSubmit).toHaveBeenCalledOnce()
    app.unmount()
  })

  it('ignores empty Enter and clears buffered input on unmount', async () => {
    const stdin = new MockStdin()
    const onSubmit = vi.fn()
    const app = render(<SecureInput label="Password" onSubmit={onSubmit} onCancel={vi.fn()} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: new PassThrough() as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { stdin.write('\r') })
    await act(async () => { stdin.write('secret') })
    app.unmount()
    await Promise.resolve()

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('merges grapheme clusters split across terminal input events', async () => {
    const stdin = new MockStdin()
    const stdout = new PassThrough()
    const frames: string[] = []
    stdout.on('data', chunk => { frames.push(chunk.toString()) })
    const app = render(<SecureInput label="Password" onSubmit={vi.fn()} onCancel={vi.fn()} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    await act(async () => { stdin.write('e') })
    await act(async () => { stdin.write('\u0301') })
    await vi.waitFor(() => expect(frames.at(-1)).toContain('› •'))
    expect(frames.at(-1)).not.toContain('› ••')
    await act(async () => { stdin.write('👩‍') })
    await act(async () => { stdin.write('👩‍👧‍👦') })
    await vi.waitFor(() => expect(frames.at(-1)).toContain('› ••'))
    expect(frames.at(-1)).not.toContain('› •••')
    app.unmount()
  })

  it('caps huge pasted secrets', async () => {
    const stdin = new MockStdin()
    const onSubmit = vi.fn()
    const app = render(<SecureInput label="Password" onSubmit={onSubmit} onCancel={vi.fn()} />, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: new PassThrough() as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    await act(async () => { stdin.write('x'.repeat(MAX_SECURE_INPUT_LENGTH + 500)) })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(onSubmit.mock.calls[0]?.[0]).toHaveLength(MAX_SECURE_INPUT_LENGTH)
    app.unmount()
  })
})

class MockStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
