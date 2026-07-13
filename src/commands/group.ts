import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import {
  groupAuditTable,
  groupInfoDetail,
  groupMemberDetail,
  groupMembersTable,
} from '../presenters/group.js'
import {
  GroupService,
  validateGroupAuditOptions,
  validateGroupMembersOptions,
  type GroupAuditOptions,
  type GroupMembersOptions,
} from '../services/group-service.js'
import type { AccountCommandOptions } from './account-options.js'
import { runTelegramCommand } from './telegram-runner.js'
import { outputFormatConflict, type OutputFlags } from './types.js'

type GroupMembersCommandOptions = OutputFlags & {
  type?: string
  query?: string
  limit?: string
}

type GroupAuditCommandOptions = OutputFlags & {
  query?: string
  user?: string[]
  type?: string[]
  limit?: string
}

export function registerGroupCommands(app: Command): void {
  const group = app.command('group')
    .description('Inspect Telegram groups, members, and audit events')

  group.command('info')
    .description('Show Telegram group information')
    .argument('<chat>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, _localOptions: OutputFlags, command: Command) => {
      const options = optionsWithGlobals<AccountCommandOptions>(command)
      await runTelegramCommand(options, async (client) => {
        const result = await new GroupService(client.groups).info(chat)
        return result.ok ? { ...result, human: groupInfoDetail(result.data) } : result
      })
    })

  group.command('members')
    .description('List Telegram group members')
    .argument('<chat>')
    .option('--type <type>', 'Member filter')
    .option('--query <query>', 'Search member names and usernames')
    .option('--limit <limit>', 'Maximum members to return')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, _localOptions: GroupMembersCommandOptions, command: Command) => {
      const options = optionsWithGlobals<GroupMembersCommandOptions & AccountCommandOptions>(command)
      const requested: GroupMembersOptions = {
        chat,
        type: options.type,
        query: options.query,
        limit: options.limit,
      }
      if (await renderConflict(options)) return
      const validation = validateGroupMembersOptions(requested)
      if (!validation.ok) {
        await renderResult(validation, options)
        return
      }

      await runTelegramCommand(options, async (client) => {
        const result = await new GroupService(client.groups).members(validation.options)
        return result.ok ? { ...result, human: groupMembersTable(result.data) } : result
      })
    })

  group.command('member')
    .description('Show a Telegram group member')
    .argument('<chat>')
    .argument('<user>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, user: string, _localOptions: OutputFlags, command: Command) => {
      const options = optionsWithGlobals<AccountCommandOptions>(command)
      await runTelegramCommand(options, async (client) => {
        const result = await new GroupService(client.groups).member(chat, user)
        return result.ok ? { ...result, human: groupMemberDetail(result.data) } : result
      })
    })

  group.command('audit')
    .description('List Telegram group audit events')
    .argument('<chat>')
    .option('--query <query>', 'Search audit event summaries')
    .option('--user <user>', 'Filter by action author', collect)
    .option('--type <type>', 'Filter by audit event type', collect)
    .option('--limit <limit>', 'Maximum audit events to return')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, _localOptions: GroupAuditCommandOptions, command: Command) => {
      const options = optionsWithGlobals<GroupAuditCommandOptions & AccountCommandOptions>(command)
      const requested: GroupAuditOptions = {
        chat,
        query: options.query,
        users: options.user,
        types: options.type,
        limit: options.limit,
      }
      if (await renderConflict(options)) return
      const validation = validateGroupAuditOptions(requested)
      if (!validation.ok) {
        await renderResult(validation, options)
        return
      }

      await runTelegramCommand(options, async (client) => {
        const result = await new GroupService(client.groups).audit(validation.options)
        return result.ok ? { ...result, human: groupAuditTable(result.data) } : result
      })
    })
}

async function renderConflict(options: AccountCommandOptions): Promise<boolean> {
  const conflict = outputFormatConflict(options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return true
  }
  return false
}

function optionsWithGlobals<T extends AccountCommandOptions>(command: Command): T {
  return command.optsWithGlobals() as T
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value]
}
