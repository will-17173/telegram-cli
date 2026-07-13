import { authenticateAccountAt } from '../../src/account/account-authenticator.js'
import { CliInterruptedError, createInterruptScope, readSecret } from '../../src/cli/secure-input.js'

const mode = process.argv[2]

try {
  if (mode === 'secret') {
    const value = await readSecret('2FA password: ')
    process.stdout.write(`secret-length:${value.length}\n`)
  } else if (mode === 'stubborn-hup' || mode === 'stubborn-term') {
    createInterruptScope()
    const signal = mode === 'stubborn-hup' ? 'SIGHUP' : 'SIGTERM'
    setTimeout(() => process.kill(process.pid, signal), 25)
    setInterval(() => undefined, 1_000)
    await new Promise(() => undefined)
  } else if (mode === 'signal-hup' || mode === 'signal-term') {
    const interrupt = createInterruptScope()
    try {
      const signal = mode === 'signal-hup' ? 'SIGHUP' : 'SIGTERM'
      setTimeout(() => process.kill(process.pid, signal), 25)
      await readSecret('2FA password: ', { signal: interrupt.signal })
    } finally {
      interrupt.dispose()
    }
  } else {
    await authenticateAccountAt('/tmp/tg-secure-input-pty-session', () => ({
      start: async (options) => {
        await dynamic(options.phone)
        if (mode === 'auth-phone') return
        await dynamic(options.code)
        if (mode === 'auth-code') return
        await dynamic(options.password)
      },
      getMe: async () => ({ id: 42, username: 'alice' }),
      destroy: async () => undefined,
    }))
  }
} catch (error) {
  if (error instanceof CliInterruptedError) {
    process.exitCode = error.exitCode
  } else {
    throw error
  }
}

async function dynamic(value: unknown): Promise<unknown> {
  if (typeof value !== 'function') throw new Error('missing authentication callback')
  return value()
}
