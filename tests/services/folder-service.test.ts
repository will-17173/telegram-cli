import { describe, expect, it, vi } from 'vitest'

import { FolderService } from '../../src/services/folder-service.js'
import { WriteAccessPolicy } from '../../src/services/write-access-policy.js'
import {
  TelegramFolderError,
  type TelegramFolderAdapter,
  type TelegramFolderDetail,
} from '../../src/telegram/folder-types.js'

const detail: TelegramFolderDetail = {
  folder_id: 2,
  folder_name: 'Work',
  emoticon: '💼',
  color: 3,
  chat_count: 2,
  rules: {
    include_contacts: true,
    include_non_contacts: false,
    include_groups: true,
    include_channels: false,
    include_bots: false,
    exclude_muted: true,
    exclude_read: false,
    exclude_archived: true,
  },
  chats: [
    { chat_id: 42, chat_name: 'Team' },
    { chat_id: 43, chat_name: 'Planning' },
  ],
  included_chats: [{ chat_id: 42, chat_name: 'Team' }],
  excluded_chats: [{ chat_id: 99, chat_name: 'Muted' }],
  pinned_chats: [{ chat_id: 43, chat_name: 'Planning' }],
}

function adapter(overrides: Partial<TelegramFolderAdapter> = {}): TelegramFolderAdapter {
  return {
    list: vi.fn(async () => [{
      folder_id: 2,
      folder_name: 'Work',
      emoticon: '💼',
      color: 3,
      chat_count: 2,
    }]),
    info: vi.fn(async () => detail),
    addChat: vi.fn(async () => ({ folder_id: 2, chat_id: 42, changed: true })),
    removeChat: vi.fn(async () => ({ folder_id: 2, chat_id: 42, changed: false })),
    ...overrides,
  }
}

describe('FolderService', () => {
  it('lists folders with stable data and a human table', async () => {
    expect(await new FolderService(adapter()).list()).toEqual({
      ok: true,
      data: { folders: [expect.objectContaining({ folder_id: 2, folder_name: 'Work' })] },
      human: {
        kind: 'table',
        title: 'Telegram Folders',
        columns: ['ID', 'Folder', 'Icon', 'Color', 'Chats'],
        rows: [['2', 'Work', '💼', '3', '2']],
        emptyText: 'No Telegram folders found.',
      },
    })
  })

  it('shows folder rules and effective chats in the human summary', async () => {
    expect(await new FolderService(adapter()).info('Work')).toEqual({
      ok: true,
      data: detail,
      human: {
        kind: 'summary',
        title: 'Telegram Folder: Work',
        fields: expect.arrayContaining([
          { label: 'ID', value: '2' },
          { label: 'Rules', value: 'Contacts, Groups, Exclude muted, Exclude archived' },
          { label: 'Included', value: '1' },
          { label: 'Excluded', value: '1' },
          { label: 'Pinned', value: '1' },
        ]),
        table: {
          columns: ['Chat ID', 'Chat'],
          rows: [['42', 'Team'], ['43', 'Planning']],
          emptyText: 'No chats match this folder.',
        },
      },
    })
  })

  it.each([
    ['addChat', 'addChat', { folder: '', chat: '@team' }, 'invalid_folder', 'Folder must be a non-empty title or safe integer ID.'],
    ['removeChat', 'removeChat', { folder: 'Work', chat: '   ' }, 'invalid_chat', 'Chat must be a non-empty reference or safe integer ID.'],
  ] as const)('validates %s input before policy and adapter mutation', async (method, adapterMethod, request, code, message) => {
    const folders = adapter()
    const policy = vi.fn(() => true)

    await expect(new FolderService(folders, new WriteAccessPolicy(policy))[method](request.folder, request.chat))
      .resolves.toEqual({ ok: false, error: { code, message } })
    expect(policy).not.toHaveBeenCalled()
    expect(folders[adapterMethod]).not.toHaveBeenCalled()
  })

  it.each(['addChat', 'removeChat'] as const)('returns the unchanged policy failure before %s mutation', async (method) => {
    const folders = adapter()
    const service = new FolderService(folders, new WriteAccessPolicy(() => false))

    await expect(service[method]('Work', '@team')).resolves.toEqual({
      ok: false,
      error: {
        code: 'write_access_disabled',
        message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
      },
    })
    expect(folders[method]).not.toHaveBeenCalled()
  })

  it('checks policy immediately before add and presents changed true', async () => {
    const calls: string[] = []
    const folders = adapter({
      addChat: vi.fn(async (request) => {
        calls.push(`adapter:${request.folder}:${request.chat}`)
        return { folder_id: 2, chat_id: 42, changed: true }
      }),
    })
    const service = new FolderService(folders, new WriteAccessPolicy(() => {
      calls.push('policy')
      return true
    }))

    await expect(service.addChat('Work', '@team')).resolves.toMatchObject({
      ok: true,
      data: { folder_id: 2, chat_id: 42, changed: true },
      human: { kind: 'detail', fields: expect.arrayContaining([{ label: 'Change', value: 'Added' }]) },
    })
    expect(calls).toEqual(['policy', 'adapter:Work:@team'])
  })

  it('preserves and visibly presents idempotent changed false', async () => {
    await expect(new FolderService(adapter()).removeChat('Work', '@team')).resolves.toMatchObject({
      ok: true,
      data: { folder_id: 2, chat_id: 42, changed: false },
      human: { kind: 'detail', fields: expect.arrayContaining([{ label: 'Change', value: 'Already absent' }]) },
    })
  })

  it.each([
    [new TelegramFolderError('folder_not_found', 'unsafe Work'), { code: 'folder_not_found', message: 'Telegram folder not found.' }],
    [new TelegramFolderError('ambiguous_folder', 'unsafe candidates', { candidate_ids: [2, 7] }), { code: 'ambiguous_folder', message: 'Telegram folder title is ambiguous.', details: { candidate_ids: [2, 7] } }],
    [new TelegramFolderError('chat_not_found', 'unsafe @secret'), { code: 'chat_not_found', message: 'Telegram chat not found.' }],
    [new TelegramFolderError('folder_operation_unsupported', 'unsafe raw object'), { code: 'folder_operation_unsupported', message: 'This Telegram folder cannot be modified.' }],
    [new TelegramFolderError('flood_wait', 'unsafe flood detail', { seconds: 12 }), { code: 'flood_wait', message: 'Telegram flood wait is active.', details: { seconds: 12 } }],
    [new TelegramFolderError('telegram_error', 'unsafe transport detail'), { code: 'telegram_error', message: 'Telegram folder request failed.' }],
  ])('maps neutral adapter errors without leaking unsafe details', async (error, expected) => {
    const service = new FolderService(adapter({ info: vi.fn(async () => { throw error }) }))

    await expect(service.info('Work')).resolves.toEqual({ ok: false, error: expected })
  })
})
