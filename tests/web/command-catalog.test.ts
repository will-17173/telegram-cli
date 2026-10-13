import { Argument, Command, Option } from 'commander'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/cli/app.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'
import { getDesktopCommandDefinitions, getDesktopCommands } from '../../src/web/command-catalog.js'

describe('desktop command catalog', () => {
  it('covers every business action in the registered Commander tree', () => {
    const expected: string[] = []
    const excluded = new Set(['web', 'guard start', 'account add', 'account login'])
    const visit = (command: Command, parent: string[]) => {
      const path = [...parent, command.name()]
      const id = path.join(' ')
      if (excluded.has(id)) return
      if (typeof (command as Command & { _actionHandler?: unknown })._actionHandler === 'function') expected.push(id)
      for (const child of command.commands) visit(child, path)
    }
    for (const command of createApp().commands) visit(command, [])

    const commands = getDesktopCommands()
    expect(commands.map(command => command.id)).toEqual(expected)
    expect(new Set(commands.map(command => command.id)).size).toBe(commands.length)
    expect(commands.length).toBeGreaterThan(100)
    for (const definition of GROUP_COMMANDS) {
      expect(commands.find(command => command.id === `group ${definition.path.join(' ')}`)).toMatchObject({
        category: 'groups',
        destructive: definition.risk !== 'none',
        requiresAccount: true,
      })
    }
    expect(commands.some(command => command.id === 'group member')).toBe(true)
    expect(commands.some(command => command.id === 'group member info')).toBe(true)
  })

  it('retains business formats, alias flags, confirmation title, defaults, and repetitions', () => {
    const commands = new Map(getDesktopCommands().map(command => [command.id, command]))
    expect(commands.get('export')?.options).toContainEqual(expect.objectContaining({ name: 'format', flag: '--format', defaultValue: 'text' }))
    expect(commands.get('download')?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'msgId', flag: '--msg-id' }),
      expect.objectContaining({ name: 'msg_id', flag: '--msg_id' }),
      expect.objectContaining({ name: 'grouped_id', flag: '--grouped_id' }),
      expect.objectContaining({ name: 'ext', repeatable: true, defaultValue: [] }),
    ]))
    expect(commands.get('group chat delete')?.options).toContainEqual(expect.objectContaining({ name: 'confirmTitle', flag: '--confirm-title' }))
    expect(commands.get('group admin transfer-owner')?.options).toContainEqual({ name: 'ownershipPassword', description: 'Telegram 2FA password', required: true, variadic: false, kind: 'string' })
    expect(commands.get('send')?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'file', repeatable: true, defaultValue: [] }),
      expect.objectContaining({ name: 'preview', kind: 'boolean', negated: true, defaultValue: true }),
    ]))
    expect(commands.get('delete')?.arguments).toContainEqual(expect.objectContaining({ name: 'msgIds', required: true, variadic: true }))
    expect(commands.get('group audit')?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'user', repeatable: true }),
      expect.objectContaining({ name: 'type', repeatable: true }),
    ]))
    expect(commands.get('listen')).toMatchObject({ longRunning: true })
    expect(commands.get('listen')?.options).toContainEqual(expect.objectContaining({ name: 'interactive', kind: 'boolean', negated: true, defaultValue: true }))
  })

  it('omits only CLI output and launcher controls from form options', () => {
    for (const command of getDesktopCommands()) {
      for (const field of command.options) expect(['json', 'yaml', 'markdown', 'verbose', 'account', 'version', 'help']).not.toContain(field.name)
    }
    expect(getDesktopCommands().filter(command => command.category === 'messages').map(command => command.id)).toEqual([
      'search', 'recent', 'stats', 'top', 'timeline', 'today', 'filter',
    ])
    expect(getDesktopCommands().find(command => command.id === 'config set')).toMatchObject({ category: 'settings', requiresAccount: false })
    expect(getDesktopCommands().find(command => command.id === 'account list')).toMatchObject({ category: 'accounts', requiresAccount: false })
  })

  it('extracts required options, variadic options, choices, and argument defaults', () => {
    const app = new Command()
    app.command('config').command('example')
      .addArgument(new Argument('[mode]').choices(['on', 'off']).default('on'))
      .addOption(new Option('--tags <tags...>').choices(['one', 'two']))
      .requiredOption('--required <value>', 'Required option')
      .option('-p, --path <path>', 'A path', '/tmp/default')
      .action(() => {})

    const [definition] = getDesktopCommandDefinitions(app)
    expect(definition.command.arguments).toEqual([expect.objectContaining({ name: 'mode', defaultValue: 'on', choices: ['on', 'off'] })])
    expect(definition.command.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tags', variadic: true, repeatable: true, choices: ['one', 'two'] }),
      expect.objectContaining({ name: 'required', required: true }),
      expect.objectContaining({ name: 'path', defaultValue: '/tmp/default', flag: '--path' }),
    ]))
  })

  it('returns independent arrays so callers cannot change execution metadata', () => {
    const commands = getDesktopCommands()
    const send = commands.find(command => command.id === 'send')!
    send.path[0] = 'web'
    send.options.length = 0
    const next = getDesktopCommands().find(command => command.id === 'send')!
    expect(next.path).toEqual(['send'])
    expect(next.options.length).toBeGreaterThan(0)
  })
})
