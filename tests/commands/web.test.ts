import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/cli/app.js'

describe('web command', () => {
  it('registers local web management help', () => {
    const command = createApp().commands.find((candidate) => candidate.name() === 'web')

    expect(command).toBeDefined()
    expect(command?.description()).toBe('Start the local Telegram CLI web management UI')
    expect(command?.helpInformation()).toContain('--port <port>')
    expect(command?.helpInformation()).toContain('127.0.0.1')
    expect(command?.helpInformation()).toContain('no login')
    expect(command?.helpInformation()).toContain('read-only Telegram sync')
  })
})
