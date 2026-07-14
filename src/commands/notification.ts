import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import {
  InvalidNotificationDurationError,
  NotificationService,
  invalidNotificationDurationFailure,
  parseNotificationDuration,
} from '../services/notification-service.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import type { AccountCommandOptions } from './account-options.js'
import { runTelegramCommand, runTelegramWriteCommand } from './telegram-runner.js'
import { outputFormatConflict, type HandlerResult } from './types.js'

type NotificationOptions = AccountCommandOptions & {
  json?: boolean
  yaml?: boolean
}

export function registerNotificationCommands(app: Command): void {
  const notification = app.command('notification')
    .description('Inspect and manage Telegram notification settings')

  notification.command('info')
    .description('Show notification settings for a Telegram chat')
    .argument('<chat>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, _options: NotificationOptions, command: Command) => {
      await runNotificationAction({
        options: optionsWithGlobals(command),
        command,
        handler: (client) => new NotificationService(client.notifications).info(chat),
      })
    })

  notification.command('mute')
    .description('Mute notifications for a Telegram chat')
    .argument('<chat>')
    .argument('[duration]', 'Duration such as 30m, 8h, 2d, or forever (default: forever)')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, duration: string | undefined, _options: NotificationOptions, command: Command) => {
      const options = optionsWithGlobals(command)
      const conflict = outputFormatConflict(options)
      if (conflict) {
        await renderResult(conflict, { yaml: true })
        return
      }
      if (!isValidDuration(duration ?? 'forever')) {
        await renderResult(invalidNotificationDurationFailure(), options)
        return
      }
      await runTelegramWriteCommand(
        options,
        (client) => new NotificationService(client.notifications).mute(chat, duration),
        command,
      )
    })

  notification.command('unmute')
    .description('Unmute notifications for a Telegram chat')
    .argument('<chat>')
    .option('--json')
    .option('--yaml')
    .action(async (chat: string, _options: NotificationOptions, command: Command) => {
      await runNotificationAction({
        options: optionsWithGlobals(command),
        command,
        write: true,
        handler: (client) => new NotificationService(client.notifications).unmute(chat),
      })
    })
}

async function runNotificationAction(input: {
  options: NotificationOptions
  command: Command
  write?: boolean
  handler: (client: TelegramClientAdapter) => Promise<HandlerResult>
}): Promise<void> {
  const conflict = outputFormatConflict(input.options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }
  const runner = input.write ? runTelegramWriteCommand : runTelegramCommand
  await runner(input.options, (client) => input.handler(client), input.command)
}

function isValidDuration(duration: string): boolean {
  try {
    parseNotificationDuration(duration)
    return true
  } catch (error) {
    if (error instanceof InvalidNotificationDurationError) return false
    throw error
  }
}

function optionsWithGlobals(command: Command): NotificationOptions {
  return command.optsWithGlobals() as NotificationOptions
}
