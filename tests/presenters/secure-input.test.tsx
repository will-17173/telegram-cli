import React, { act } from 'react'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import { SecureInput } from '../../src/presenters/ink/secure-input.js'

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
})

class MockStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
