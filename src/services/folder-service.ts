import type { HandlerResult, HumanOutput } from '../commands/types.js'
import {
  TelegramFolderError,
  type TelegramFolderAdapter,
  type TelegramFolderChatResult,
  type TelegramFolderDetail,
  type TelegramFolderInput,
  type TelegramFolderRules,
  type TelegramFolderSummary,
} from '../telegram/folder-types.js'
import { WriteAccessPolicy } from './write-access-policy.js'

const INVALID_FOLDER_MESSAGE = 'Folder must be a non-empty title or safe integer ID.'
const INVALID_CHAT_MESSAGE = 'Chat must be a non-empty reference or safe integer ID.'

export class FolderService {
  constructor(
    private readonly folders: TelegramFolderAdapter,
    private readonly writePolicy: WriteAccessPolicy = new WriteAccessPolicy(),
  ) {}

  async list(): Promise<HandlerResult<{ folders: TelegramFolderSummary[] }>> {
    try {
      const folders = await this.folders.list()
      return {
        ok: true,
        data: { folders },
        human: folderTable(folders),
      }
    } catch (error) {
      return folderFailure(error)
    }
  }

  async info(folder: TelegramFolderInput): Promise<HandlerResult<TelegramFolderDetail>> {
    const validFolder = validateFolder(folder)
    if (!validFolder.ok) return validFolder

    try {
      const detail = await this.folders.info(validFolder.data)
      return {
        ok: true,
        data: detail,
        human: folderDetail(detail),
      }
    } catch (error) {
      return folderFailure(error)
    }
  }

  async addChat(folder: TelegramFolderInput, chat: string | number): Promise<HandlerResult<TelegramFolderChatResult>> {
    return this.changeChat('add', folder, chat)
  }

  async removeChat(folder: TelegramFolderInput, chat: string | number): Promise<HandlerResult<TelegramFolderChatResult>> {
    return this.changeChat('remove', folder, chat)
  }

  private async changeChat(
    operation: 'add' | 'remove',
    folder: TelegramFolderInput,
    chat: string | number,
  ): Promise<HandlerResult<TelegramFolderChatResult>> {
    const validFolder = validateFolder(folder)
    if (!validFolder.ok) return validFolder
    const validChat = validateChat(chat)
    if (!validChat.ok) return validChat

    const access = this.writePolicy.check()
    if (!access.ok) return access

    try {
      const result = await this.folders[operation === 'add' ? 'addChat' : 'removeChat']({
        folder: validFolder.data,
        chat: validChat.data,
      })
      return {
        ok: true,
        data: result,
        human: mutationDetail(operation, result),
      }
    } catch (error) {
      return folderFailure(error)
    }
  }
}

function validateFolder(folder: TelegramFolderInput): HandlerResult<TelegramFolderInput> {
  if (typeof folder === 'number') {
    return Number.isSafeInteger(folder) && folder >= 0
      ? { ok: true, data: folder }
      : failure('invalid_folder', INVALID_FOLDER_MESSAGE)
  }
  const normalized = folder.trim()
  return normalized.length > 0
    ? { ok: true, data: normalized }
    : failure('invalid_folder', INVALID_FOLDER_MESSAGE)
}

function validateChat(chat: string | number): HandlerResult<string | number> {
  if (typeof chat === 'number') {
    return Number.isSafeInteger(chat)
      ? { ok: true, data: chat }
      : failure('invalid_chat', INVALID_CHAT_MESSAGE)
  }
  const normalized = chat.trim()
  return normalized.length > 0
    ? { ok: true, data: normalized }
    : failure('invalid_chat', INVALID_CHAT_MESSAGE)
}

function folderTable(folders: TelegramFolderSummary[]): HumanOutput {
  return {
    kind: 'table',
    title: 'Telegram Folders',
    columns: ['ID', 'Folder', 'Icon', 'Color', 'Chats'],
    rows: folders.map(folder => [
      String(folder.folder_id),
      folder.folder_name,
      folder.emoticon ?? '',
      folder.color == null ? '' : String(folder.color),
      String(folder.chat_count),
    ]),
    emptyText: 'No Telegram folders found.',
  }
}

function folderDetail(folder: TelegramFolderDetail): HumanOutput {
  return {
    kind: 'summary',
    title: `Telegram Folder: ${folder.folder_name}`,
    fields: [
      { label: 'ID', value: String(folder.folder_id) },
      { label: 'Icon', value: folder.emoticon ?? 'Not set' },
      { label: 'Color', value: folder.color == null ? 'Not set' : String(folder.color) },
      { label: 'Chats', value: String(folder.chat_count) },
      { label: 'Rules', value: formatRules(folder.rules) },
      { label: 'Included', value: String(folder.included_chats.length) },
      { label: 'Excluded', value: String(folder.excluded_chats.length) },
      { label: 'Pinned', value: String(folder.pinned_chats.length) },
    ],
    table: {
      columns: ['Chat ID', 'Chat'],
      rows: folder.chats.map(chat => [String(chat.chat_id), chat.chat_name]),
      emptyText: 'No chats match this folder.',
    },
  }
}

function formatRules(rules: TelegramFolderRules): string {
  const enabled = [
    [rules.include_contacts, 'Contacts'],
    [rules.include_non_contacts, 'Non-contacts'],
    [rules.include_groups, 'Groups'],
    [rules.include_channels, 'Channels'],
    [rules.include_bots, 'Bots'],
    [rules.exclude_muted, 'Exclude muted'],
    [rules.exclude_read, 'Exclude read'],
    [rules.exclude_archived, 'Exclude archived'],
  ] as const
  const labels = enabled.filter(([value]) => value).map(([, label]) => label)
  return labels.length === 0 ? 'None' : labels.join(', ')
}

function mutationDetail(operation: 'add' | 'remove', result: TelegramFolderChatResult): HumanOutput {
  const change = operation === 'add'
    ? result.changed ? 'Added' : 'Already present'
    : result.changed ? 'Removed' : 'Already absent'
  return {
    kind: 'detail',
    title: operation === 'add' ? 'Folder Chat Added' : 'Folder Chat Removed',
    fields: [
      { label: 'Folder ID', value: String(result.folder_id) },
      { label: 'Chat ID', value: String(result.chat_id) },
      { label: 'Change', value: change },
    ],
  }
}

function folderFailure(error: unknown): HandlerResult<never> {
  if (error instanceof TelegramFolderError) {
    switch (error.code) {
      case 'folder_not_found':
        return failure('folder_not_found', 'Telegram folder not found.')
      case 'ambiguous_folder': {
        const candidateIds = Array.isArray(error.candidate_ids)
          ? error.candidate_ids.filter(candidate => Number.isSafeInteger(candidate))
          : []
        return failure(
          'ambiguous_folder',
          'Telegram folder title is ambiguous.',
          candidateIds.length === 0 ? undefined : { candidate_ids: candidateIds },
        )
      }
      case 'chat_not_found':
        return failure('chat_not_found', 'Telegram chat not found.')
      case 'folder_operation_unsupported':
        return failure('folder_operation_unsupported', 'This Telegram folder cannot be modified.')
      case 'flood_wait':
        return failure(
          'flood_wait',
          'Telegram flood wait is active.',
          Number.isSafeInteger(error.seconds) && (error.seconds ?? -1) >= 0
            ? { seconds: error.seconds }
            : undefined,
        )
      case 'telegram_error':
        break
    }
  }
  return failure('telegram_error', 'Telegram folder request failed.')
}

function failure(code: string, message: string, details?: unknown): HandlerResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}
