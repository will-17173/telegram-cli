import { dirname, join } from 'node:path'
import type { Command } from 'commander'

import { renderResult } from '../cli/output.js'
import { ArchiveService } from '../services/archive-service.js'
import type { ArchiveCommandResult } from '../services/archive-types.js'
import type { AccountContext } from '../account/account-presets.js'
import type { AccountCommandOptions } from './account-options.js'
import { parseTimeRange, type ParsedTimeRange } from './time-range.js'
import { isTelegramAuthSessionError } from '../telegram/errors.js'
import { runTelegramCommand } from './telegram-runner.js'
import {
  outputFormatConflict,
  type HandlerResult,
} from './types.js'

type ArchiveOptions = AccountCommandOptions & {
  all?: boolean
  output?: string
  since?: string
  until?: string
  full?: boolean
  rebuild?: boolean
  downloadMedia?: boolean
}

export function registerArchiveCommand(app: Command): void {
  app.command('archive')
    .description('Archive Telegram chats as Markdown files')
    .argument('[chats...]', 'Chats to archive by id or username')
    .option('--all', 'Archive all available chats')
    .option('--output <path>', 'Archive directory (default: account data directory)')
    .option('--since <since>', 'Only archive messages after this time')
    .option('--until <until>', 'Only archive messages before this time')
    .option('--full', 'Archive full history instead of the default recent range')
    .option('--rebuild', 'Rebuild existing chat archive files')
    .option('--download-media', 'Download message attachments into the archive')
    .option('--json')
    .option('--yaml')
    .option('--markdown')
    .action(async (chats: string[], options: ArchiveOptions, command: Command) => {
      const effectiveOptions = optionsWithGlobals(command, options)
      const validated = validateArchiveOptions(chats, effectiveOptions)
      if (!validated.ok) {
        await renderResult(validated, outputFormatConflict(effectiveOptions) ? { yaml: true } : effectiveOptions)
        return
      }

      await runTelegramCommand(effectiveOptions, async (client, context) => {
        try {
          const result = await new ArchiveService(client.archive).archive({
            account: {
              userId: context.account.user_id,
              name: context.account.name,
            },
            chats,
            all: effectiveOptions.all === true,
            output: effectiveOptions.output ?? defaultArchiveOutput(context),
            range: validated.data.range,
            full: effectiveOptions.full,
            rebuild: effectiveOptions.rebuild,
            media: effectiveOptions.downloadMedia,
            now: validated.data.now,
          })
          return result.ok ? { ...result, human: archiveSummary(result.data) } : result
        } catch (error) {
          if (isTelegramAuthSessionError(error)) throw error
          return archiveFailure(error)
        }
      }, command)
    })
}

type ValidatedArchiveOptions = {
  range?: ParsedTimeRange
  now: Date
}

function validateArchiveOptions(
  chats: string[],
  options: ArchiveOptions,
): HandlerResult<ValidatedArchiveOptions> {
  const conflict = outputFormatConflict(options)
  if (conflict != null) return conflict
  if (options.all !== true && chats.length === 0) {
    return archiveOptionFailure('archive_scope_required', 'Select one or more chats or use --all.')
  }
  if (options.all === true && chats.length > 0) {
    return archiveOptionFailure('archive_scope_conflict', 'Chat arguments cannot be combined with --all.')
  }
  if (options.full === true && options.since != null) {
    return archiveOptionFailure('archive_full_range_conflict', '--full cannot be combined with --since.')
  }

  const now = new Date()
  try {
    const parsed = parseTimeRange({ since: options.since, until: options.until }, now)
    const implicitSince = options.full === true
      || (options.rebuild === true && options.since == null && options.until == null)
      ? undefined
      : parsed.since ?? new Date(now.getTime() - 7 * 86_400_000)
    if (implicitSince != null && parsed.until != null
      && implicitSince.getTime() >= parsed.until.getTime()) {
      throw new Error('invalid range')
    }
    return {
      ok: true,
      data: {
        range: options.since == null && options.until == null ? undefined : parsed,
        now,
      },
    }
  } catch {
    return archiveOptionFailure(
      'archive_invalid_time_range',
      'Use positive relative durations or ISO timestamps with zones; --since must be earlier than --until.',
    )
  }
}

function archiveOptionFailure(code: string, guidance: string): HandlerResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: guidance,
    },
  }
}

function archiveFailure(error: unknown): HandlerResult<never> {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : ''
  const messages: Record<string, string> = {
    archive_account_mismatch: 'Archive belongs to a different Telegram account.',
    archive_manifest_invalid: 'Archive manifest is invalid.',
    archive_schema_unsupported: 'Archive manifest schema is not supported.',
  }
  const message = messages[code]
  return message == null
    ? {
      ok: false,
      error: {
        code: 'archive_failed',
        message: 'Archive could not be completed.',
      },
    }
    : { ok: false, error: { code, message } }
}

function defaultArchiveOutput(context: AccountContext): string {
  return join(dirname(context.dbPath), 'archive')
}

function archiveSummary(result: ArchiveCommandResult) {
  return {
    kind: 'summary' as const,
    title: 'Archive',
    fields: [
      { label: 'Manifest', value: result.manifest },
      { label: 'Warnings', value: String(result.warnings.length) },
    ],
    table: {
      columns: ['CHAT', 'FILE', 'NEW MESSAGES', 'DOWNLOADED MEDIA', 'WARNINGS'],
      rows: result.completed.map((chat) => [
        chat.title,
        chat.file,
        String(chat.messages_archived),
        String(chat.media_archived),
        result.warnings
          .filter((warning) => warning.chat_id === chat.chat_id)
          .map((warning) => warning.message)
          .join('; ') || '—',
      ]),
      emptyText: 'No chats archived.',
    },
  }
}

function optionsWithGlobals(command: Command, options: ArchiveOptions): ArchiveOptions {
  return {
    ...command.optsWithGlobals(),
    ...options,
  }
}
