import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { FolderService } from '../services/folder-service.js'
import type { TelegramFolderInput } from '../telegram/folder-types.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import type { AccountCommandOptions } from './account-options.js'
import { runTelegramCommand, runTelegramWriteCommand } from './telegram-runner.js'
import { outputFormatConflict, type HandlerResult } from './types.js'

type FolderOptions = AccountCommandOptions & {
  json?: boolean
  yaml?: boolean
}

type ParsedFolder =
  | { ok: true; data: TelegramFolderInput }
  | { ok: false; error: { code: 'invalid_folder'; message: string } }

export function registerFolderCommands(app: Command): void {
  const folder = app.command('folder')
    .description('Inspect and manage Telegram chat folders')

  folder.command('list')
    .description('List Telegram chat folders')
    .option('--json')
    .option('--yaml')
    .action(async (_options: FolderOptions, command: Command) => {
      await runFolderAction({
        options: optionsWithGlobals(command),
        command,
        handler: client => new FolderService(client.folders).list(),
      })
    })

  folder.command('info')
    .description('Show a Telegram chat folder')
    .argument('<folder>')
    .option('--json')
    .option('--yaml')
    .action(async (folderToken: string, _options: FolderOptions, command: Command) => {
      await runFolderInputAction(folderToken, command, (client, parsedFolder) => (
        new FolderService(client.folders).info(parsedFolder)
      ))
    })

  const chat = folder.command('chat')
    .description('Manage explicit chats in a Telegram folder')

  registerChatMutation(chat, 'add')
  registerChatMutation(chat, 'remove')
}

function registerChatMutation(parent: Command, operation: 'add' | 'remove'): void {
  parent.command(operation)
    .description(`${operation === 'add' ? 'Add a chat to' : 'Remove a chat from'} a Telegram folder`)
    .argument('<folder>')
    .argument('<chat>')
    .option('--json')
    .option('--yaml')
    .action(async (folderToken: string, chatToken: string, _options: FolderOptions, command: Command) => {
      await runFolderInputAction(folderToken, command, (client, parsedFolder) => {
        const service = new FolderService(client.folders)
        return operation === 'add'
          ? service.addChat(parsedFolder, chatToken)
          : service.removeChat(parsedFolder, chatToken)
      }, true)
    })
}

async function runFolderInputAction(
  folderToken: string,
  command: Command,
  handler: (client: TelegramClientAdapter, folder: TelegramFolderInput) => Promise<HandlerResult>,
  write = false,
): Promise<void> {
  const options = optionsWithGlobals(command)
  const conflict = outputFormatConflict(options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  const parsed = parseFolderInput(folderToken)
  if (!parsed.ok) {
    await renderResult(parsed, options)
    return
  }

  const runner = write ? runTelegramWriteCommand : runTelegramCommand
  await runner(options, client => handler(client, parsed.data), command)
}

async function runFolderAction(input: {
  options: FolderOptions
  command: Command
  handler: (client: TelegramClientAdapter) => Promise<HandlerResult>
}): Promise<void> {
  const conflict = outputFormatConflict(input.options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }
  await runTelegramCommand(input.options, client => input.handler(client), input.command)
}

export function parseFolderInput(token: string): ParsedFolder {
  const normalized = token.trim()
  if (normalized.length === 0) return invalidFolder()
  if (/^\d+$/.test(normalized)) {
    const value = Number(normalized)
    return Number.isSafeInteger(value) ? { ok: true, data: value } : invalidFolder()
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return invalidFolder()
  return { ok: true, data: normalized }
}

function invalidFolder(): ParsedFolder {
  return {
    ok: false,
    error: {
      code: 'invalid_folder',
      message: 'Folder must be a non-empty title or safe integer ID.',
    },
  }
}

function optionsWithGlobals(command: Command): FolderOptions {
  return command.optsWithGlobals() as FolderOptions
}
