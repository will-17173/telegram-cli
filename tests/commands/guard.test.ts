import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/cli/app.js'

const startWebServer = vi.hoisted(() => vi.fn(async () => ({
  host: '127.0.0.1',
  port: 8734,
  url: 'http://127.0.0.1:8734/',
  close: vi.fn(async () => undefined),
})))

const runtimeMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
}))

vi.mock('../../src/web/server.js', () => ({
  startWebServer,
}))

vi.mock('../../src/guard/runtime.js', () => ({
  GuardRuntime: vi.fn(function GuardRuntime(options) {
    runtimeMocks.constructor(options)
    return {
      start: runtimeMocks.start,
      stop: runtimeMocks.stop,
    }
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  startWebServer.mockReset()
  startWebServer.mockImplementation(async () => ({
    host: '127.0.0.1',
    port: 8734,
    url: 'http://127.0.0.1:8734/',
    close: vi.fn(async () => undefined),
  }))
  runtimeMocks.constructor.mockClear()
  runtimeMocks.start.mockReset()
  runtimeMocks.start.mockImplementation(async () => undefined)
  runtimeMocks.stop.mockReset()
  runtimeMocks.stop.mockImplementation(async () => undefined)
})

describe('guard command', () => {
  it('registers guard start help', () => {
    const command = createApp().commands.find((candidate) => candidate.name() === 'guard')
    const start = command?.commands.find((candidate) => candidate.name() === 'start')
    const help = start?.helpInformation() ?? ''

    expect(command).toBeDefined()
    expect(command?.description()).toBe('Manage Telegram group automation guards')
    expect(start).toBeDefined()
    expect(start?.description()).toContain('Start the local Telegram Guard daemon')
    expect(help).toContain('--port <port>')
  })

  it('starts the guard runtime and closes it on SIGTERM', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const close = vi.fn(async () => undefined)
    startWebServer.mockResolvedValueOnce({
      host: '127.0.0.1',
      port: 9001,
      url: 'http://127.0.0.1:9001/',
      close,
    })
    const app = createApp()

    const running = app.parseAsync(['node', 'tg', 'guard', 'start', '--port', '9001'])
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Telegram Guard: http://127.0.0.1:9001/\n'))
    process.emit('SIGTERM')
    await running

    expect(startWebServer).toHaveBeenCalledWith({ port: 9001 })
    expect(runtimeMocks.constructor).toHaveBeenCalledOnce()
    const options = runtimeMocks.constructor.mock.calls[0]?.[0]
    expect(options.writeAccess()).toBe(false)
    expect(await options.store.listEnabledGroups()).toEqual([])
    await expect(options.executor.deleteMessage({ chat: 1, messageId: 2 })).resolves.toBeUndefined()
    expect(runtimeMocks.start).toHaveBeenCalledOnce()
    expect(runtimeMocks.stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(runtimeMocks.stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0])
  })

  it('closes the web server when runtime startup fails', async () => {
    const close = vi.fn(async () => undefined)
    const error = new Error('runtime failed')
    runtimeMocks.start.mockRejectedValueOnce(error)
    startWebServer.mockResolvedValueOnce({
      host: '127.0.0.1',
      port: 9002,
      url: 'http://127.0.0.1:9002/',
      close,
    })
    const app = createApp()

    await expect(app.parseAsync(['node', 'tg', 'guard', 'start', '--port', '9002']))
      .rejects.toThrow(error)

    expect(runtimeMocks.start).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(runtimeMocks.stop).not.toHaveBeenCalled()
  })

  it('closes the web server when runtime shutdown fails', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const close = vi.fn(async () => undefined)
    const error = new Error('runtime stop failed')
    runtimeMocks.stop.mockRejectedValueOnce(error)
    startWebServer.mockResolvedValueOnce({
      host: '127.0.0.1',
      port: 9003,
      url: 'http://127.0.0.1:9003/',
      close,
    })
    const app = createApp()

    const running = app.parseAsync(['node', 'tg', 'guard', 'start', '--port', '9003'])
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Telegram Guard: http://127.0.0.1:9003/\n'))
    process.emit('SIGTERM')
    await expect(running).rejects.toThrow(error)

    expect(runtimeMocks.stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(runtimeMocks.stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0])
  })

  it('rejects invalid guard ports', async () => {
    const app = createApp()

    await expect(app.parseAsync(['node', 'tg', 'guard', 'start', '--port', 'abc']))
      .rejects.toThrow('--port must be a positive integer')
    await expect(app.parseAsync(['node', 'tg', 'guard', 'start', '--port', '0']))
      .rejects.toThrow('--port must be a positive integer')
    await expect(app.parseAsync(['node', 'tg', 'guard', 'start', '--port', '70000']))
      .rejects.toThrow('--port must be a positive integer')
    expect(startWebServer).not.toHaveBeenCalled()
    expect(runtimeMocks.constructor).not.toHaveBeenCalled()
  })
})
