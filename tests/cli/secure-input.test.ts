import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  CliInterruptedError,
  createInterruptScope,
  readSecret,
  readVisibleInput,
} from '../../src/cli/secure-input.js'

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

describe('createInterruptScope', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGHUP', 129],
    ['SIGTERM', 143],
  ] as const)('maps %s to its conventional exit status', (processSignal, exitCode) => {
    const scope = createInterruptScope()
    try {
      process.emit(processSignal)
      expect(scope.signal.aborted).toBe(true)
      expect(scope.signal.reason).toMatchObject({ code: 'interrupted', exitCode })
    } finally {
      scope.dispose()
    }
  })
})

describe('readSecret', () => {
  it('cannot overlap an active visible prompt on the same terminal', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    }
    const visible = readVisibleInput('Phone: ', streams)
    const secret = readSecret('Password: ', streams)
    const outcome = await Promise.race([
      secret.then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 25)),
    ])
    input.write('13800138000\r')
    await visible
    if (outcome.status === 'pending') await secret

    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'input_busy' } })
  })

  it('does not restore a managed readline listener that was already detached', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    }
    const visible = readVisibleInput('Phone: ', streams)
    input.write('13800138000\r')
    await visible
    const managedListener = input.listeners('data')[0] as ((...args: any[]) => void) | undefined
    expect(managedListener).toBeDefined()
    input.removeListener('data', managedListener!)

    const secret = readSecret('Password: ', streams)
    input.write('hunter2\r')
    await secret

    expect(input.listenerCount('data')).toBe(0)
  })

  it('rejects a concurrent read on the same terminal without mutating it', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    const writes: string[] = []
    output.on('data', chunk => writes.push(String(chunk)))

    const first = readSecret('First: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    const second = readSecret('Second: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })

    await expect(second).rejects.toMatchObject({ code: 'input_busy' })
    expect(input.rawModes).toEqual([true])
    expect(writes.join('')).toBe('First: ')

    input.write('hunter2\r')
    await expect(first).resolves.toBe('hunter2')
    expect(input.rawModes).toEqual([true, false])
    expect(writes.join('')).toBe('First: \n')
  })

  it('refuses hidden input while preserving a pre-existing data listener', async () => {
    const input = new FakeTtyInput()
    const existingListener = () => undefined
    input.on('data', existingListener)

    await expect(readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })).rejects.toMatchObject({ code: 'input_busy' })
    expect(input.listeners('data')).toEqual([existingListener])
    expect(input.rawModes).toEqual([])
  })

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

  it.each(['a\u0301', '👨‍👩‍👧‍👦'])('backspaces the final grapheme in %s', async (grapheme) => {
    const input = new FakeTtyInput()
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    input.write(`${grapheme}\x7fok\r`)

    await expect(reading).resolves.toBe('ok')
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

  it('normalizes an arbitrary abort reason to a CLI interruption', async () => {
    const input = new FakeTtyInput()
    const controller = new AbortController()
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
      signal: controller.signal,
    })
    controller.abort(new Error('internal cancellation detail'))

    await expect(reading).rejects.toBeInstanceOf(CliInterruptedError)
  })

  it('preserves interruption when restoring raw mode also fails', async () => {
    const input = new FakeTtyInput()
    const controller = new AbortController()
    const restoreFailure = new Error('raw restore failed')
    const setRawMode = input.setRawMode.bind(input)
    input.setRawMode = (mode: boolean) => {
      if (!mode) throw restoreFailure
      return setRawMode(mode)
    }
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
      signal: controller.signal,
    })
    controller.abort()

    await expect(reading).rejects.toBeInstanceOf(CliInterruptedError)
    expect(input.listenerCount('data')).toBe(0)
  })

  it('preserves invalid input when writing the cleanup newline fails', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    const cleanupFailure = new Error('newline failed')
    const write = output.write.bind(output)
    let writes = 0
    output.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
      writes += 1
      if (writes === 2) throw cleanupFailure
      return write(chunk, ...(args as Parameters<typeof write> extends [unknown, ...infer Rest] ? Rest : never))
    }) as typeof output.write

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    input.write('\r')

    await expect(reading).rejects.toMatchObject({ code: 'invalid_input' })
    expect(input.rawModes).toEqual([true, false])
  })

  it('reports the first cleanup failure when input itself succeeded', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    const restoreFailure = new Error('raw restore failed')
    const newlineFailure = new Error('newline failed')
    const setRawMode = input.setRawMode.bind(input)
    input.setRawMode = (mode: boolean) => {
      if (!mode) throw restoreFailure
      return setRawMode(mode)
    }
    const write = output.write.bind(output)
    let writes = 0
    output.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
      writes += 1
      if (writes === 2) throw newlineFailure
      return write(chunk, ...(args as Parameters<typeof write> extends [unknown, ...infer Rest] ? Rest : never))
    }) as typeof output.write

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    input.write('hunter2\r')

    await expect(reading).rejects.toBe(restoreFailure)
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

  it('rejects promptly when the input stream has already ended', async () => {
    const input = new FakeTtyInput()
    input.resume()
    input.end()
    await new Promise<void>(resolve => input.once('end', resolve))

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    const outcome = await Promise.race([
      reading.then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 25)),
    ])

    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'interrupted' } })
    expect(input.rawModes).toEqual([])
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
  })

  it('rejects a destroyed input before changing terminal state', async () => {
    const input = new FakeTtyInput()
    input.destroy()

    await expect(readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })).rejects.toMatchObject({ code: 'interrupted' })
    expect(input.rawModes).toEqual([])
  })

  it('settles and restores raw mode when the input closes during setup', async () => {
    const input = new FakeTtyInput()
    const setRawMode = input.setRawMode.bind(input)
    input.setRawMode = (mode: boolean) => {
      setRawMode(mode)
      if (mode) input.emit('close')
      return input
    }

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    const outcome = await Promise.race([
      reading.then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 25)),
    ])

    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'interrupted' } })
    expect(input.rawModes).toEqual([true, false])
    expect(input.listenerCount('close')).toBe(0)
    expect(input.listenerCount('data')).toBe(0)
  })

  it('restores terminal state when writing the prompt fails asynchronously', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    const failure = new Error('output failed')
    const preserveProcess = () => undefined
    output.on('error', preserveProcess)

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    output.emit('error', failure)

    const outcome = await Promise.race([
      reading.then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 25)),
    ])

    expect(outcome).toEqual({ status: 'rejected', error: failure })
    expect(input.rawModes).toEqual([true, false])
    expect(input.readableFlowing).toBe(false)
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
    expect(output.listeners('error')).toEqual([preserveProcess])
  })

  it('waits for a delayed prompt write error before releasing output listeners', async () => {
    const input = new FakeTtyInput()
    const failure = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(failure), 10)
      },
    })
    const observed: Error[] = []
    const preserveProcess = (error: Error) => observed.push(error)
    output.on('error', preserveProcess)

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    input.write('hunter2\r')

    await expect(reading).rejects.toBe(failure)
    expect(observed).toEqual([failure])
    expect(input.rawModes).toEqual([true, false])
    expect(output.listeners('error')).toEqual([preserveProcess])
  })
})
