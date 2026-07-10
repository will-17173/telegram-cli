import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/cli/app.js'

describe('cli help', () => {
  it('registers the tg command surface', () => {
    const app = createApp()
    const names = app.commands.map((command) => command.name()).sort()

    expect(names).toEqual([
      'chats',
      'config',
      'delete',
      'edit',
      'export',
      'filter',
      'history',
      'info',
      'listen',
      'purge',
      'recent',
      'refresh',
      'search',
      'send',
      'stats',
      'status',
      'sync',
      'sync-all',
      'timeline',
      'today',
      'top',
      'whoami',
    ])
  })

  it('registers config set with ordinary credential options', () => {
    const config = createApp().commands.find((command) => command.name() === 'config')
    const set = config?.commands.find((command) => command.name() === 'set')

    expect(set).toBeDefined()
    expect(set?.options.map((option) => option.long)).toEqual([
      '--api-id',
      '--api-hash',
      '--json',
      '--yaml',
    ])
    expect(set?.options.every((option) => !option.mandatory)).toBe(true)
  })

  it('describes every top-level command', () => {
    const commands = createApp().commands

    expect(commands).toHaveLength(22)
    expect(commands.every((command) => command.description().trim().length > 0)).toBe(true)
  })

  it('shows command purposes in top-level help', () => {
    const help = createApp().helpInformation()

    expect(help).toContain('Search locally stored messages by')
    expect(help).toContain('Export locally stored messages from a')
    expect(help).toContain('Show Telegram authentication status')
    expect(help).toContain('Manage Telegram CLI configuration')
  })
})
