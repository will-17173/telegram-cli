import { CommanderError } from 'commander'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/cli/app.js'

describe('web command', () => {
  it('registers local web management help', () => {
    const command = createApp().commands.find((candidate) => candidate.name() === 'web')
    const help = command?.helpInformation() ?? ''

    expect(command).toBeDefined()
    expect(command?.description()).toBe('Start the local Telegram CLI web management UI')
    expect(help).toContain('--port <port>')
    expect(help).toContain('127.0.0.1')
    expect(help).toContain('no login')
    expect(help).toContain('read-only Telegram sync')
  })

  it('reports the unimplemented server through Commander', async () => {
    const app = createApp()
      .configureOutput({ writeErr: () => undefined })
      .exitOverride()

    let error: unknown
    try {
      await app.parseAsync(['node', 'tg', 'web'])
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(CommanderError)
    expect(error?.constructor).toBe(CommanderError)
    expect(error).toMatchObject({
      code: 'commander.error',
      exitCode: 1,
      message: expect.stringContaining('tg web server is not implemented yet'),
    })
  })
})
