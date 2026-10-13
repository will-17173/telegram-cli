import type { Argument, Command, Option } from 'commander'
import { createApp } from '../cli/app.js'
import type { DesktopCategory, DesktopCommand, DesktopField } from './workspace-types.js'

export type DesktopCommandDefinition = {
  command: DesktopCommand
  cli: Command
}

const excludedCommands = new Set(['web', 'guard start', 'account add', 'account login'])
const outputOptions = new Set(['json', 'yaml', 'markdown', 'verbose', 'account', 'version', 'help'])
const localMessageCommands = new Set(['search', 'recent', 'stats', 'top', 'timeline', 'today', 'filter'])
const dataCommands = new Set(['archive', 'export', 'purge', 'data'])
const destructiveCommands = new Set(['delete', 'purge', 'data reset', 'account remove', 'account logout'])
const longRunningCommands = new Set(['listen', 'archive', 'sync', 'history', 'repair', 'sync-all', 'refresh', 'download'])

let definitions: DesktopCommandDefinition[] | undefined

export function getDesktopCommands(): DesktopCommand[] {
  return getDesktopCommandDefinitions().map(({ command }) => copyCommand(command))
}

export function getDesktopCommandDefinitions(app?: Command): DesktopCommandDefinition[] {
  if (app != null) return collectCommands(app)
  definitions ??= collectCommands(createApp())
  return definitions
}

function collectCommands(app: Command): DesktopCommandDefinition[] {
  const commands: DesktopCommandDefinition[] = []
  const visit = (cli: Command, parentPath: string[]) => {
    const path = [...parentPath, cli.name()]
    const id = path.join(' ')
    if (excludedCommands.has(id)) return

    // A command can have its own action and also contain subcommands (group member).
    if (hasAction(cli)) {
      const category = categoryFor(path)
      const options = collectOptions(cli)
      if (id === 'group admin transfer-owner') {
        options.push({ name: 'ownershipPassword', description: 'Telegram 2FA password', required: true, variadic: false, kind: 'string' })
      }
      commands.push({
        cli,
        command: {
          id,
          path,
          category,
          description: cli.description(),
          arguments: cli.registeredArguments.map(argumentField),
          options,
          requiresAccount: category !== 'accounts' && category !== 'settings',
          destructive: destructiveCommands.has(id) || options.some(option => option.name === 'yes'),
          longRunning: longRunningCommands.has(id),
        },
      })
    }
    for (const child of cli.commands) visit(child, path)
  }
  for (const cli of app.commands) visit(cli, [])
  return commands
}

function hasAction(command: Command): boolean {
  return typeof (command as Command & { _actionHandler?: unknown })._actionHandler === 'function'
}

function categoryFor(path: string[]): DesktopCategory {
  const [name] = path
  if (localMessageCommands.has(name)) return 'messages'
  if (name === 'group' || path.join(' ') === 'dialog groups') return 'groups'
  if (name === 'contact') return 'contacts'
  if (name === 'folder') return 'folders'
  if (name === 'notification') return 'notifications'
  if (name === 'account') return 'accounts'
  if (name === 'config') return 'settings'
  if (dataCommands.has(name)) return 'data'
  return 'telegram'
}

function collectOptions(command: Command): DesktopField[] {
  const options: Option[] = []
  const names = new Set<string>()
  for (let current: Command | null = command; current != null; current = current.parent) {
    for (const option of current.options) {
      const name = option.attributeName()
      if (names.has(name) || outputOptions.has(name)) continue
      names.add(name)
      options.push(option)
    }
  }
  return options.map(option => optionField(option, command))
}

function argumentField(argument: Argument): DesktopField {
  return {
    name: argument.name(),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
    kind: 'string',
    ...defaultField(argument.defaultValue),
    ...(argument.argChoices == null ? {} : { choices: [...argument.argChoices] }),
  }
}

function optionField(option: Option, command: Command): DesktopField {
  const boolean = option.isBoolean() || option.negate
  const repeatable = option.variadic
    || Array.isArray(option.defaultValue)
    || option.parseArg?.name.startsWith('collect') === true
    || /repeatable|repeated/i.test(option.description)
  const effectiveDefault = command.getOptionValue(option.attributeName()) ?? option.defaultValue
  return {
    name: option.attributeName(),
    description: option.description,
    required: option.mandatory,
    variadic: option.variadic,
    kind: boolean ? 'boolean' : 'string',
    flag: option.long ?? option.short,
    ...(option.negate ? { negated: true } : {}),
    ...(repeatable ? { repeatable: true } : {}),
    ...defaultField(effectiveDefault ?? (option.negate ? true : undefined)),
    ...(option.argChoices == null ? {} : { choices: [...option.argChoices] }),
  }
}

function defaultField(value: unknown): Pick<DesktopField, 'defaultValue'> {
  if (typeof value === 'string' || typeof value === 'boolean') return { defaultValue: value }
  if (typeof value === 'number') return { defaultValue: String(value) }
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return { defaultValue: [...value] }
  return {}
}

function copyCommand(command: DesktopCommand): DesktopCommand {
  const copyField = (field: DesktopField): DesktopField => ({
    ...field,
    ...(Array.isArray(field.defaultValue) ? { defaultValue: [...field.defaultValue] } : {}),
    ...(field.choices == null ? {} : { choices: [...field.choices] }),
  })
  return { ...command, path: [...command.path], arguments: command.arguments.map(copyField), options: command.options.map(copyField) }
}
