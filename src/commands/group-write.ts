import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { GROUP_COMMANDS } from '../group-commands/catalog.js'
import { executeGroupCommand } from '../group-commands/executor.js'
import { parseGroupCommand } from '../group-commands/parser.js'
import { groupWriteHuman } from '../presenters/group.js'
import { GroupWriteService } from '../services/group-write-service.js'
import type { TelegramGroupDetails } from '../telegram/group-types.js'
import type { AccountCommandOptions } from './account-options.js'
import { runTelegramWriteCommand } from './telegram-runner.js'
import { outputFormatConflict, type HandlerResult, type OutputFlags } from './types.js'

type WriteOptions = AccountCommandOptions & OutputFlags & { yes?: boolean; confirmTitle?: string; [key: string]: unknown }

export function registerGroupWriteCommands(group: Command): void {
  const families = new Map<string, Command>()
  for (const definition of GROUP_COMMANDS) {
    const familyName = definition.path[0]
    let family = families.get(familyName) ?? group.commands.find(command => command.name() === familyName)
    if (!family) family = group.command(familyName).description(`${capitalize(familyName)} group management`)
    families.set(familyName, family)

    const action = family.command(definition.path[1]).description(definition.summary)
    action.argument('<chat>')
    for (const argument of definition.args) action.argument(argumentSyntax(argument.name, argument.required, 'rest' in argument && argument.rest))
    for (const option of definition.options) action.option(`${option.long} <${option.name}>`, option.summary)
    action.option('--json').option('--yaml')
    if (definition.risk !== 'none') action.option('--yes', 'Confirm this potentially destructive operation')
    if (definition.risk === 'confirm-title') action.option('--confirm-title <title>', 'Confirm the exact group title')
    action.action(async (...callbackArgs: unknown[]) => {
      const command = callbackArgs.at(-1) as Command
      const localOptions = callbackArgs.at(-2) as WriteOptions
      const positional = callbackArgs.slice(0, -2)
      await runGroupWrite(definition, positional, localOptions, command)
    })
  }
}

async function runGroupWrite(definition: typeof GROUP_COMMANDS[number], positional: unknown[], local: WriteOptions, command: Command): Promise<void> {
  const options = command.optsWithGlobals() as WriteOptions
  const conflict = outputFormatConflict(options)
  if (conflict) return renderResult(conflict, { yaml: true })
  const [chatValue, ...argumentValues] = positional
  const chat = String(chatValue)
  const tokens: string[] = [...definition.path]
  for (const value of argumentValues) {
    if (Array.isArray(value)) tokens.push(...value.map(String))
    else if (value !== undefined) tokens.push(String(value))
  }
  for (const option of definition.options) {
    const value = local[camelCase(option.name)]
    if (value !== undefined) tokens.push(option.long, String(value))
  }
  const parsed = parseGroupCommand(tokens.map(quoteToken).join(' '))
  if (!parsed.ok) return renderResult({ ok: false, error: parsed.error }, options)

  if (definition.risk !== 'none' && !options.yes) {
    return renderResult(confirmationFailure(definition.summary, definition.risk), options)
  }
  await runTelegramWriteCommand(options, async (client) => {
    let knownGroup: TelegramGroupDetails | undefined
    if (definition.risk === 'confirm-title') knownGroup = await client.groups.getGroup(chat)
    const result = await executeGroupCommand(parsed.request, {
      chat,
      groups: new GroupWriteService(client.groups),
      confirmed: options.yes === true,
      confirmationTitle: options.confirmTitle,
      knownGroup,
    })
    if ('confirmation' in result) return confirmationFailure(result.confirmation.summary, result.confirmation.risk, result.confirmation.title)
    if ('selectionRequired' in result) {
      return { ok: false, error: { code: 'permissions_required', message: `Administrator permissions must be one or more of: ${result.selectionRequired.available.join(', ')}.` } }
    }
    return result.ok ? { ...result, human: groupWriteHuman(result.data, chat, definition.summary) } : result
  })
}

function confirmationFailure(summary: string, risk: 'confirm' | 'confirm-title', title?: string): HandlerResult<never> {
  const titleHint = risk === 'confirm-title' ? ` and --confirm-title <title>${title ? ` (exact title: ${title})` : ''}` : ''
  return { ok: false, error: { code: 'confirmation_required', message: `${summary}. Use --yes${titleHint} to confirm.` } }
}
function argumentSyntax(name: string, required: boolean, rest: boolean): string { return required ? `<${name}${rest ? '...' : ''}>` : `[${name}${rest ? '...' : ''}]` }
function quoteToken(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` }
function camelCase(value: string): string { return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) }
function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1) }
