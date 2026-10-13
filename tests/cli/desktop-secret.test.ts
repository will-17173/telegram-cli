import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readOwnershipPassword, type DesktopSecretTransport } from '../../src/cli/desktop-secret.js'
import { CliInterruptedError } from '../../src/cli/secure-input.js'

class FakeTransport extends EventEmitter implements DesktopSecretTransport {
  enabled = true
  connected = true
  disconnectCount = 0
  send = vi.fn((_request: Parameters<DesktopSecretTransport['send']>[0], callback: (error: Error | null) => void) => { callback(null) })

  disconnect(): void {
    this.disconnectCount++
    this.connected = false
    this.emit('disconnect')
  }
}

afterEach(() => { vi.useRealTimers() })

describe('desktop ownership password transport', () => {
  it('falls back to the existing terminal secret input when desktop IPC is not enabled', async () => {
    const transport = new FakeTransport()
    transport.enabled = false
    const controller = new AbortController()
    const readTerminalSecret = vi.fn().mockResolvedValue('terminal-password')
    expect(await readOwnershipPassword({ transport, signal: controller.signal, readTerminalSecret })).toBe('terminal-password')
    expect(readTerminalSecret).toHaveBeenCalledWith('Telegram 2FA password: ', { signal: controller.signal })
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.listenerCount('message')).toBe(0)
    expect(transport.disconnectCount).toBe(0)
  })

  it('accepts one matching response, preserves password whitespace, and removes listeners', async () => {
    const transport = new FakeTransport()
    const readTerminalSecret = vi.fn()
    const password = readOwnershipPassword({ transport, readTerminalSecret })
    expect(transport.send).toHaveBeenCalledWith({ type: 'tg-desktop-secret-request', name: 'ownershipPassword' }, expect.any(Function))
    transport.emit('message', { type: 'unrelated', name: 'ownershipPassword', value: 'wrong' })
    transport.emit('message', { type: 'tg-desktop-secret-response', name: 'other', value: 'wrong' })
    expect(transport.connected).toBe(true)
    transport.emit('message', { type: 'tg-desktop-secret-response', name: 'ownershipPassword', value: '  secret  ' })
    expect(await password).toBe('  secret  ')
    expect(transport.listenerCount('message')).toBe(0)
    expect(transport.listenerCount('disconnect')).toBe(0)
    expect(transport.disconnectCount).toBe(1)
    expect(readTerminalSecret).not.toHaveBeenCalled()
  })

  it('rejects disconnected channels and cleans up when the parent disconnects', async () => {
    const disconnected = new FakeTransport()
    disconnected.connected = false
    await expect(readOwnershipPassword({ transport: disconnected })).rejects.toMatchObject({ code: 'interaction_required' })
    expect(disconnected.send).not.toHaveBeenCalled()
    const transport = new FakeTransport()
    const password = readOwnershipPassword({ transport })
    transport.emit('disconnect')
    await expect(password).rejects.toMatchObject({ code: 'interaction_required' })
    expect(transport.listenerCount('message')).toBe(0)
    expect(transport.listenerCount('disconnect')).toBe(0)
  })

  it('rejects empty or invalid password responses without retaining response data', async () => {
    for (const value of ['', 123, null]) {
      const transport = new FakeTransport()
      const password = readOwnershipPassword({ transport })
      transport.emit('message', { type: 'tg-desktop-secret-response', name: 'ownershipPassword', value })
      await expect(password).rejects.toMatchObject({ code: 'invalid_input' })
      expect(transport.listenerCount('message')).toBe(0)
    }
  })

  it('handles pre-aborted requests and removes IPC listeners after later aborts', async () => {
    const transport = new FakeTransport()
    const controller = new AbortController()
    const password = readOwnershipPassword({ transport, signal: controller.signal })
    controller.abort(new CliInterruptedError('SIGTERM'))
    await expect(password).rejects.toMatchObject({ code: 'interrupted', exitCode: 143 })
    expect(transport.listenerCount('message')).toBe(0)
    expect(transport.listenerCount('disconnect')).toBe(0)
    const preAborted = new FakeTransport()
    await expect(readOwnershipPassword({ transport: preAborted, signal: controller.signal })).rejects.toMatchObject({ code: 'interrupted' })
    expect(preAborted.send).not.toHaveBeenCalled()
  })

  it('uses a ten-second timeout and removes listeners on expiry', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const password = readOwnershipPassword({ transport })
    const rejected = expect(password).rejects.toMatchObject({ code: 'interaction_required' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(transport.connected).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(transport.listenerCount('message')).toBe(0)
    expect(transport.listenerCount('disconnect')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles send callback errors and thrown send failures', async () => {
    for (const thrown of [false, true]) {
      const transport = new FakeTransport()
      transport.send.mockImplementation((_request, callback) => {
        if (thrown) throw new Error('send failed')
        callback(new Error('send failed'))
      })
      await expect(readOwnershipPassword({ transport })).rejects.toMatchObject({ code: 'interaction_required' })
      expect(transport.listenerCount('message')).toBe(0)
      expect(transport.listenerCount('disconnect')).toBe(0)
    }
  })
})
