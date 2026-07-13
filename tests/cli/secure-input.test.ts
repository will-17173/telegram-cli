import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  CliInterruptedError,
  createInterruptScope,
  readSecret,
  readVisibleInput,
} from '../../src/cli/secure-input.js'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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

describe('readVisibleInput', () => {
  it('forces cooked mode for visible input and restores the prior raw state', async () => {
    const input = new FakeTtyInput()
    input.isRaw = true
    const reading = readVisibleInput('Phone: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    input.write('13800138000\r')

    await expect(reading).resolves.toBe('13800138000')
    expect(input.rawModes).toEqual([false, true])
  })

  it('ignores terminal escape and control sequences', async () => {
    const input = new FakeTtyInput()
    const reading = readVisibleInput('Code: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    input.write('12\x1b[A\t34\r')

    await expect(reading).resolves.toBe('1234')
  })

  it('uses only the first line of pasted input', async () => {
    const input = new FakeTtyInput()
    const reading = readVisibleInput('Code: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    input.write('12345\n67890\n')

    await expect(reading).resolves.toBe('12345')
  })

  it('does not let a split CRLF complete the next prompt', async () => {
    const input = new FakeTtyInput()
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }
    const first = readVisibleInput('Phone: ', streams)
    input.write('one\r')
    await expect(first).resolves.toBe('one')

    const second = readVisibleInput('Code: ', streams)
    input.write('\n')
    input.write('two\r')

    await expect(second).resolves.toBe('two')
  })

  it('discards a split multiline paste before the next prompt', async () => {
    const input = new FakeTtyInput()
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }
    const first = readVisibleInput('Phone: ', streams)
    input.write('one\n')
    await expect(first).resolves.toBe('one')
    input.write('pasted-remainder\n')

    const second = readVisibleInput('Code: ', streams)
    input.write('two\n')

    await expect(second).resolves.toBe('two')
  })

  it('rejects a destroyed input without retaining ownership', async () => {
    const input = new FakeTtyInput()
    input.destroy()
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }

    await expect(readVisibleInput('Phone: ', streams)).rejects.toMatchObject({ code: 'interrupted' })
    await expect(readVisibleInput('Phone: ', streams)).rejects.toMatchObject({ code: 'interrupted' })
  })

  it('settles and releases ownership when the input closes during setup', async () => {
    const input = new FakeTtyInput()
    const resume = input.resume.bind(input)
    input.resume = () => {
      const resumed = resume()
      input.emit('close')
      return resumed
    }
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }

    const outcome = await settlesPromptly(readVisibleInput('Phone: ', streams))

    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'interrupted' } })
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('close')).toBe(0)
  })

  it('settles and cleans listeners when the input errors during setup', async () => {
    const input = new FakeTtyInput()
    const failure = new Error('input failed')
    const resume = input.resume.bind(input)
    input.resume = () => {
      const resumed = resume()
      input.emit('error', failure)
      return resumed
    }

    await expect(readVisibleInput('Phone: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })).rejects.toBe(failure)
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
  })

  it('does not miss an abort triggered while visible input resumes', async () => {
    const input = new FakeTtyInput()
    const controller = new AbortController()
    const interruption = new CliInterruptedError()
    const resume = input.resume.bind(input)
    input.resume = () => {
      const resumed = resume()
      controller.abort(interruption)
      return resumed
    }

    await expect(readVisibleInput('Phone: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
      signal: controller.signal,
    })).rejects.toBe(interruption)
    expect(input.listenerCount('data')).toBe(0)
  })

  it('settles on scoped SIGINT and releases the terminal', async () => {
    const input = new FakeTtyInput()
    const scope = createInterruptScope()
    try {
      const reading = readVisibleInput('Phone: ', {
        input: input as unknown as NodeJS.ReadStream,
        output: new PassThrough() as unknown as NodeJS.WriteStream,
        signal: scope.signal,
      })
      process.emit('SIGINT')

      await expect(reading).rejects.toMatchObject({ code: 'interrupted', exitCode: 130 })
      expect(input.listenerCount('data')).toBe(0)
    } finally {
      scope.dispose()
    }
  })

  it('rejects an unmanaged existing data listener before writing a prompt', async () => {
    const input = new FakeTtyInput()
    const existingListener = () => undefined
    input.on('data', existingListener)
    const output = new PassThrough()
    const writes: string[] = []
    output.on('data', chunk => writes.push(String(chunk)))

    await expect(readVisibleInput('Phone: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })).rejects.toMatchObject({ code: 'input_busy' })
    expect(input.listeners('data')).toEqual([existingListener])
    expect(writes).toEqual([])
  })

  it('does not misclassify a data listener injected by newListener', async () => {
    const input = new FakeTtyInput()
    const injectedListener = () => undefined
    let injected = false
    const injectListener = (event: string | symbol) => {
      if (event === 'data' && !injected) {
        injected = true
        input.on('data', injectedListener)
      }
    }
    input.on('newListener', injectListener)

    const outcome = await settlesPromptly(readVisibleInput('Phone: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }))

    input.removeListener('newListener', injectListener)
    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'input_busy' } })
    expect(input.listeners('data')).toEqual([injectedListener])
  })
})

describe('readSecret', () => {
  it('supports sequential phone, code, password, and visible retry prompts', async () => {
    const input = new FakeTtyInput()
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    }

    const phone = readVisibleInput('Phone: ', streams)
    input.write('+8613800138000\r')
    await expect(phone).resolves.toBe('+8613800138000')

    const code = readVisibleInput('Code: ', streams)
    input.write('12345\r')
    await expect(code).resolves.toBe('12345')

    const password = readSecret('Password: ', streams)
    input.write('hunter2\r')
    await expect(password).resolves.toBe('hunter2')

    const retry = readVisibleInput('Code: ', streams)
    input.write('54321\r')
    await expect(retry).resolves.toBe('54321')
    expect(input.rawModes).toEqual([true, false])
    expect(input.listenerCount('data')).toBe(0)
  })

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

  it('caps a huge pasted secret at 4096 graphemes', async () => {
    const input = new FakeTtyInput()
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    })
    input.write(`${'x'.repeat(4096 * 32)}\r`)

    const secret = await reading
    expect(secret).toHaveLength(4096)
  })

  it.each(['e\u0301', '👩‍👩‍👧‍👦'])(
    'keeps the final %s grapheme complete at the secret cap',
    async (grapheme) => {
      const input = new FakeTtyInput()
      const reading = readSecret('Password: ', {
        input: input as unknown as NodeJS.ReadStream,
        output: new PassThrough() as unknown as NodeJS.WriteStream,
      })
      input.write(`${'x'.repeat(4095)}${grapheme}${'z'.repeat(4096)}\r`)

      const secret = await reading
      expect(Array.from(graphemeSegmenter.segment(secret))).toHaveLength(4096)
      expect(secret.endsWith(grapheme)).toBe(true)
    },
  )

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
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(output.listeners('error')).toEqual([preserveProcess])
  })

  it('contains a delayed prompt write error after releasing terminal ownership', async () => {
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

    await expect(reading).resolves.toBe('hunter2')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(observed).toEqual([failure])
    expect(input.rawModes).toEqual([true, false])
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(output.listeners('error')).toEqual([preserveProcess])
  })

  it('restores raw mode and releases ownership when output never invokes callbacks', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    output.write = ((_chunk: Uint8Array | string, _encoding?: BufferEncoding, _callback?: (error?: Error | null) => void) => true) as typeof output.write
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    }

    const first = readSecret('Password: ', streams)
    input.write('hunter2\r')
    const firstOutcome = await settlesPromptly(first)

    expect(firstOutcome).toEqual({ status: 'resolved', value: 'hunter2' })
    expect(input.rawModes).toEqual([true, false])

    const second = readSecret('Again: ', streams)
    input.write('second\r')
    await expect(second).resolves.toBe('second')
    expect(input.rawModes).toEqual([true, false, true, false])
  })

  it('guards an output error that arrives more than 100ms after input settles', async () => {
    const input = new FakeTtyInput()
    const failure = Object.assign(new Error('late broken pipe'), { code: 'EPIPE' })
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(failure), 150)
      },
    })

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    input.write('hunter2\r')

    await expect(reading).resolves.toBe('hunter2')
    expect(output.listenerCount('error')).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 180))
    expect(output.listenerCount('error')).toBe(0)
  })

  it('shares one output guard across rapid prompts with pending writes', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    output.write = ((_chunk: Uint8Array | string, _encoding?: BufferEncoding, _callback?: (error?: Error | null) => void) => true) as typeof output.write
    const streams = {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    }

    for (const value of ['one', 'two', 'three']) {
      const reading = readSecret('Password: ', streams)
      input.write(`${value}\r`)
      await expect(reading).resolves.toBe(value)
      expect(output.listenerCount('error')).toBe(1)
    }
  })

  it('releases shared listeners after an autoDestroy:false callback failure', async () => {
    const input = new FakeTtyInput()
    const failure = new Error('write failed')
    const output = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(failure), 5)
      },
    })

    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    input.write('hunter2\r')
    await expect(reading).resolves.toBe('hunter2')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(output.listenerCount('error')).toBe(0)
    expect(output.listenerCount('close')).toBe(0)
  })

  it('releases shared listeners when output closes before callbacks', async () => {
    const input = new FakeTtyInput()
    const output = new PassThrough()
    output.write = ((_chunk: Uint8Array | string, _encoding?: BufferEncoding, _callback?: (error?: Error | null) => void) => true) as typeof output.write
    const reading = readSecret('Password: ', {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    input.write('hunter2\r')
    await expect(reading).resolves.toBe('hunter2')
    expect(output.listenerCount('error')).toBe(1)

    output.emit('close')

    expect(output.listenerCount('error')).toBe(0)
    expect(output.listenerCount('close')).toBe(0)
  })
})

async function settlesPromptly<T>(promise: Promise<T>): Promise<
  { status: 'resolved'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'pending' }
> {
  return Promise.race([
    promise.then(
      value => ({ status: 'resolved' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    ),
    new Promise<{ status: 'pending' }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 25)),
  ])
}
