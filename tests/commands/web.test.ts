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
})
