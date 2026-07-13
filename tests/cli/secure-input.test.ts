import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { CliInterruptedError, readSecret } from '../../src/cli/secure-input.js'

class FakeTtyInput extends PassThrough {
  isTTY = true
  isRaw = false
  rawModes: boolean[] = []

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    this.rawModes.push(mode)
    return this
  }
}

describe('readSecret', () => {
  it('reads edited input without echo and restores raw mode and listeners', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    const writes: string[] = []
    output.on('data', chunk => writes.push(String(chunk)))

    const reading = readSecret('2FA password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    input.write('secrex')
    input.write('\x7f')
    input.write('t\r')

    await expect(reading).resolves.toBe('secret')
    expect(writes.join('')).toBe('2FA password: \n')
    expect(input.rawModes).toEqual([true, false])
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
  })

  it('requires a TTY before writing a prompt', async () => {
    const input = new FakeTtyInput()
    input.isTTY = false
    const output = new PassThrough()
    const writes: string[] = []
    output.on('data', chunk => writes.push(String(chunk)))

    await expect(readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })).rejects.toMatchObject({ code: 'interaction_required' })
    expect(writes).toEqual([])
    expect(input.rawModes).toEqual([])
  })

  it('rejects empty input and restores the original raw state', async () => {
    const input = new FakeTtyInput()
    input.isRaw = true
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    input.write('\r')

    await expect(reading).rejects.toMatchObject({ code: 'invalid_input' })
    expect(input.rawModes).toEqual([true, true])
  })

  it('settles promptly on Ctrl-C without retaining raw mode or listeners', async () => {
    const input = new FakeTtyInput()
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    input.write('\x03')

    await expect(reading).rejects.toBeInstanceOf(CliInterruptedError)
    expect(input.rawModes).toEqual([true, false])
    expect(input.listenerCount('data')).toBe(0)
  })

  it('restores terminal state when an external signal aborts input', async () => {
    const input = new FakeTtyInput()
    const controller = new AbortController()
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
      signal: controller.signal,
    })
    controller.abort(new CliInterruptedError())

    await expect(reading).rejects.toBeInstanceOf(CliInterruptedError)
    expect(input.rawModes).toEqual([true, false])
    expect(input.listenerCount('data')).toBe(0)
  })

  it('does not miss an abort triggered while raw mode is being enabled', async () => {
    const input = new FakeTtyInput()
    const controller = new AbortController()
    const interruption = new CliInterruptedError()
    const setRawMode = input.setRawMode.bind(input)
    input.setRawMode = (mode: boolean) => {
      setRawMode(mode)
      if (mode) controller.abort(interruption)
      return input
    }

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
      signal: controller.signal,
    })
    const outcome = await Promise.race([
      reading.then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 25)),
    ])

    expect(outcome).toEqual({ status: 'rejected', error: interruption })
    expect(input.rawModes).toEqual([true, false])
    expect(input.readableFlowing).toBe(false)
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
  })
})
