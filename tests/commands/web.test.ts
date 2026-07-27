import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/cli/app.js'
import { browserOpenCommand } from '../../src/commands/web.js'

const startWebServer = vi.hoisted(() => vi.fn(async () => ({
  host: '127.0.0.1',
  port: 8734,
  url: 'http://127.0.0.1:8734/',
  close: vi.fn(async () => undefined),
})))
const spawn = vi.hoisted(() => vi.fn(() => ({
  on: vi.fn(),
  unref: vi.fn(),
})))

vi.mock('node:child_process', () => ({
  spawn,
}))

vi.mock('../../src/web/server.js', () => ({
  startWebServer,
}))

afterEach(() => {
  vi.restoreAllMocks()
  startWebServer.mockClear()
  spawn.mockClear()
})

describe('web command', () => {
  it('registers local web management help', () => {
    const command = createApp().commands.find((candidate) => candidate.name() === 'web')
    const help = command?.helpInformation() ?? ''

    expect(command).toBeDefined()
    expect(command?.description()).toBe('Start the local Telegram CLI web management UI')
    expect(help).toContain('--port <port>')
    expect(help).toContain('--no-open')
    expect(help).toContain('127.0.0.1')
    expect(help).toContain('no login')
    expect(help).toContain('read-only Telegram sync')
  })

  it('starts the web server and closes it on SIGINT', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const close = vi.fn(async () => undefined)
    startWebServer.mockResolvedValueOnce({
      host: '127.0.0.1',
      port: 9000,
      url: 'http://127.0.0.1:9000/',
      close,
    })
    const app = createApp()

    const running = app.parseAsync(['node', 'tg', 'web', '--port', '9000'])
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Telegram CLI web UI: http://127.0.0.1:9000/\n'))
    process.emit('SIGINT')
    await running

    expect(startWebServer).toHaveBeenCalledWith({ port: 9000 })
    const command = browserOpenCommand('http://127.0.0.1:9000/', process.platform)
    if (command == null) expect(spawn).not.toHaveBeenCalled()
    else {
      expect(spawn).toHaveBeenCalledWith(command.file, command.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    }
    expect(close).toHaveBeenCalledOnce()
  })

  it('can skip opening the browser', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const close = vi.fn(async () => undefined)
    startWebServer.mockResolvedValueOnce({
      host: '127.0.0.1',
      port: 9000,
      url: 'http://127.0.0.1:9000/',
      close,
    })
    const app = createApp()

    const running = app.parseAsync(['node', 'tg', 'web', '--port', '9000', '--no-open'])
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Telegram CLI web UI: http://127.0.0.1:9000/\n'))
    process.emit('SIGINT')
    await running

    expect(spawn).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects invalid web ports', async () => {
    const app = createApp()

    await expect(app.parseAsync(['node', 'tg', 'web', '--port', 'abc']))
      .rejects.toThrow('--port must be a positive integer')
    await expect(app.parseAsync(['node', 'tg', 'web', '--port', '70000']))
      .rejects.toThrow('--port must be a positive integer')
    expect(startWebServer).not.toHaveBeenCalled()
  })

  it('builds platform-specific browser opener commands', () => {
    expect(browserOpenCommand('http://127.0.0.1:8734/', 'win32')).toEqual({
      file: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:8734/'],
    })
    expect(browserOpenCommand('http://127.0.0.1:8734/', 'darwin')).toEqual({
      file: 'open',
      args: ['http://127.0.0.1:8734/'],
    })
    expect(browserOpenCommand('http://127.0.0.1:8734/', 'linux')).toEqual({
      file: 'xdg-open',
      args: ['http://127.0.0.1:8734/'],
    })
    expect(browserOpenCommand('http://127.0.0.1:8734/', 'freebsd')).toBeNull()
  })
})
