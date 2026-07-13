import { Long, tl, type TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import {
  addPeerToFolder,
  FolderOperationUnsupportedError,
  MtcuteTelegramFolderAdapter,
  removePeerFromFolder,
} from '../../src/telegram/mtcute-folders.js'
import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

const peer = { _: 'inputPeerUser', userId: 42, accessHash: Long.fromNumber(100) } as const
const otherPeer = { _: 'inputPeerUser', userId: 7, accessHash: Long.fromNumber(200) } as const
const channelPeer = { _: 'inputPeerChannel', channelId: 42, accessHash: Long.fromNumber(300) } as const
const userFromMessagePeer = {
  _: 'inputPeerUserFromMessage',
  peer: channelPeer,
  msgId: 10,
  userId: 42,
} as const
const dummyUserPeer = { _: 'mtcute.dummyInputPeerMinUser', userId: 42 } as const
const channelFromMessagePeer = {
  _: 'inputPeerChannelFromMessage',
  peer,
  msgId: 11,
  channelId: 42,
} as const
const dummyChannelPeer = { _: 'mtcute.dummyInputPeerMinChannel', channelId: 42 } as const

describe('addPeerToFolder', () => {
  it('explicitly includes a peer', () => {
    const folder = createFolder()

    expect(addPeerToFolder(folder, peer)).toMatchObject({
      changed: true,
      modification: { includePeers: [peer], excludePeers: [] },
    })
  })

  it('removes an equivalent exclusion and prevents duplicate includes', () => {
    const equivalentPeer = { ...peer, accessHash: Long.fromNumber(999) }
    const folder = createFolder({
      includePeers: [equivalentPeer, otherPeer],
      excludePeers: [peer, otherPeer],
    })
    const snapshot = structuredClone(folder)

    expect(addPeerToFolder(folder, peer)).toEqual({
      changed: true,
      modification: {
        includePeers: [equivalentPeer, otherPeer],
        excludePeers: [otherPeer],
      },
    })
    expect(folder).toEqual(snapshot)
  })

  it('does not treat a different TL constructor with the same numeric ID as equivalent', () => {
    const folder = createFolder({ includePeers: [channelPeer] })

    expect(addPeerToFolder(folder, peer)).toEqual({
      changed: true,
      modification: {
        includePeers: [channelPeer, peer],
        excludePeers: [],
      },
    })
  })

  it('compares basic chat peers by chat ID', () => {
    const existingChat = { _: 'inputPeerChat', chatId: 42 } as const
    const equivalentChat = { _: 'inputPeerChat', chatId: 42 } as const

    expect(addPeerToFolder(createFolder({ includePeers: [existingChat] }), equivalentChat))
      .toEqual({ changed: false, modification: {} })
  })

  it('keeps self and empty peer identities distinct', () => {
    const self = { _: 'inputPeerSelf' } as const
    const empty = { _: 'inputPeerEmpty' } as const

    expect(addPeerToFolder(createFolder({ includePeers: [self] }), empty)).toEqual({
      changed: true,
      modification: { includePeers: [self, empty], excludePeers: [] },
    })
  })

  it('reports unchanged when an equivalent peer is already included and not excluded', () => {
    const equivalentPeer = { ...peer, accessHash: Long.fromNumber(999) }

    expect(addPeerToFolder(createFolder({ includePeers: [equivalentPeer] }), peer))
      .toEqual({ changed: false, modification: {} })
  })

  it('canonicalizes standard, from-message, and dummy user constructors', () => {
    const folder = createFolder({
      includePeers: [peer],
      excludePeers: [dummyUserPeer],
    })

    expect(addPeerToFolder(folder, userFromMessagePeer)).toEqual({
      changed: true,
      modification: { includePeers: [peer], excludePeers: [] },
    })
  })

  it('is unchanged after applying its returned modification', () => {
    const folder = createFolder({ excludePeers: [dummyUserPeer] })
    const first = addPeerToFolder(folder, userFromMessagePeer)
    const modifiedFolder = { ...folder, ...first.modification }

    expect(first.changed).toBe(true)
    expect(addPeerToFolder(modifiedFolder, peer))
      .toEqual({ changed: false, modification: {} })
  })
})

describe('removePeerFromFolder', () => {
  it('adds an exclusion when a dynamic group rule still includes a supergroup', () => {
    const folder = createFolder({ groups: true })

    expect(removePeerFromFolder(folder, peer, 'supergroup')).toMatchObject({
      changed: true,
      modification: { excludePeers: [peer] },
    })
  })

  it('reports unchanged for an ordinary user with no explicit or dynamic inclusion', () => {
    const folder = createFolder()

    expect(removePeerFromFolder(folder, peer, 'user')).toMatchObject({ changed: false })
  })

  it('removes equivalent include and pinned peers without mutating the folder', () => {
    const equivalentPeer = { ...peer, accessHash: Long.fromNumber(999) }
    const folder = createFolder({
      includePeers: [otherPeer, equivalentPeer],
      pinnedPeers: [equivalentPeer, otherPeer],
    })
    const snapshot = structuredClone(folder)

    expect(removePeerFromFolder(folder, peer, 'user')).toEqual({
      changed: true,
      modification: {
        includePeers: [otherPeer],
        pinnedPeers: [otherPeer],
      },
    })
    expect(folder).toEqual(snapshot)
  })

  it('does not duplicate an equivalent exclusion required by a dynamic rule', () => {
    const equivalentPeer = { ...peer, accessHash: Long.fromNumber(999) }
    const folder = createFolder({ groups: true, excludePeers: [otherPeer, equivalentPeer] })

    expect(removePeerFromFolder(folder, peer, 'group'))
      .toEqual({ changed: false, modification: {} })
  })

  it('canonicalizes standard, from-message, and dummy channel constructors on removal', () => {
    const folder = createFolder({
      groups: true,
      includePeers: [channelPeer],
      pinnedPeers: [channelFromMessagePeer],
    })

    expect(removePeerFromFolder(folder, dummyChannelPeer, 'supergroup')).toEqual({
      changed: true,
      modification: {
        includePeers: [],
        pinnedPeers: [],
        excludePeers: [dummyChannelPeer],
      },
    })
  })

  it('is immutable and unchanged after applying a dynamic removal modification', () => {
    const folder = createFolder({ groups: true })
    const snapshot = structuredClone(folder)
    Object.freeze(folder.includePeers)
    Object.freeze(folder.excludePeers)
    Object.freeze(folder.pinnedPeers)
    Object.freeze(folder)

    const first = removePeerFromFolder(folder, channelFromMessagePeer, 'group')
    const modifiedFolder = { ...folder, ...first.modification }

    expect(first.changed).toBe(true)
    expect(folder).toEqual(snapshot)
    expect(removePeerFromFolder(modifiedFolder, dummyChannelPeer, 'group'))
      .toEqual({ changed: false, modification: {} })
  })

  it.each([
    ['contacts', 'contact'],
    ['nonContacts', 'non-contact'],
    ['groups', 'group'],
    ['groups', 'supergroup'],
    ['broadcasts', 'broadcast'],
    ['broadcasts', 'channel'],
    ['bots', 'bot'],
  ] as const)('maps the %s dynamic rule to the %s category', (rule, category) => {
    const folder = createFolder({ [rule]: true })

    expect(removePeerFromFolder(folder, peer, category)).toMatchObject({
      changed: true,
      modification: { excludePeers: [peer] },
    })
  })

  it('does not apply unrelated dynamic rules to a category', () => {
    const folder = createFolder({
      contacts: true,
      nonContacts: true,
      groups: true,
      broadcasts: true,
      bots: true,
    })

    expect(removePeerFromFolder(folder, peer, 'user'))
      .toEqual({ changed: false, modification: {} })
  })

  it('rejects chatlist removal only when it would require an exclusion', () => {
    // Defensive coverage for a raw clone that carries a dynamic rule a
    // dialogFilterChatlist cannot persist through editFolder.
    const folder = {
      ...createChatlist({ includePeers: [peer] }),
      groups: true,
    } as tl.RawDialogFilterChatlist & Pick<tl.RawDialogFilter, 'groups'>

    expect(() => removePeerFromFolder(folder, peer, 'group'))
      .toThrow(FolderOperationUnsupportedError)
    try {
      removePeerFromFolder(folder, peer, 'group')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'folder_operation_unsupported',
        message: 'This folder type does not support exclusions.',
      })
    }
  })

  it('allows explicit include and pin removal from a chatlist without an exclusion', () => {
    const folder = createChatlist({ includePeers: [peer], pinnedPeers: [peer] })

    expect(removePeerFromFolder(folder, peer, 'user')).toEqual({
      changed: true,
      modification: { includePeers: [], pinnedPeers: [] },
    })
  })
})

describe('MtcuteTelegramFolderAdapter', () => {
  it('lists custom folders, excluding Telegram default', async () => {
    const client = mockClient({ getFolders: vi.fn().mockResolvedValue(folderResponse([
      { _: 'dialogFilterDefault' },
      createFolder({ id: 2, emoticon: '💼', color: 3 }),
    ])) })

    await expect(new MtcuteTelegramFolderAdapter(client, vi.fn()).list()).resolves.toEqual([
      expect.objectContaining({ folder_id: 2, folder_name: 'Work', emoticon: '💼', color: 3 }),
    ])
  })

  it('returns effective chats and raw rule membership metadata', async () => {
    const included = { _: 'inputPeerChannel', channelId: 100, accessHash: Long.fromNumber(1) } as const
    const excluded = { _: 'inputPeerUser', userId: 20, accessHash: Long.fromNumber(2) } as const
    const folder = createFolder({
      id: 2,
      groups: true,
      includePeers: [included],
      excludePeers: [excluded],
      pinnedPeers: [included],
    })
    const client = mockClient({
      getFolders: vi.fn().mockResolvedValue(folderResponse([folder])),
      iterDialogs: vi.fn(() => asyncItems([
        { peer: peerShape(100, 'Team', 'chat', 'supergroup') },
        { peer: peerShape(101, 'Friends', 'chat', 'group') },
      ])),
      getPeer: vi.fn(async (input: tl.TypeInputPeer) => (
        input._ === 'inputPeerUser'
          ? peerShape(20, 'Muted Person', 'user')
          : peerShape(100, 'Team', 'chat', 'supergroup')
      )),
    })

    await expect(new MtcuteTelegramFolderAdapter(client, vi.fn()).info(2)).resolves.toMatchObject({
      folder_id: 2,
      chats: [
        { chat_id: 100, chat_name: 'Team' },
        { chat_id: 101, chat_name: 'Friends' },
      ],
      included_chats: [{ chat_id: 100, chat_name: 'Team' }],
      excluded_chats: [{ chat_id: 20, chat_name: 'Muted Person' }],
      pinned_chats: [{ chat_id: 100, chat_name: 'Team' }],
      rules: { include_groups: true },
    })
    expect(client.iterDialogs).toHaveBeenCalledWith({ folder })
  })

  it('normalizes trimmed case-insensitive titles and reports duplicate matches safely', async () => {
    const client = mockClient({ getFolders: vi.fn().mockResolvedValue(folderResponse([
      createFolder({ id: 2, title: title('Work') }),
      createFolder({ id: 3, title: title(' work ') }),
    ])) })

    const error = await new MtcuteTelegramFolderAdapter(client, vi.fn()).info(' WORK ')
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'ambiguous_folder', candidate_ids: [2, 3] })
    expect(JSON.stringify(error)).not.toContain('accessHash')
  })

  it('resolves numeric folder IDs exactly and rejects missing folders', async () => {
    const work = createFolder({ id: 2, title: title('3') })
    const numericTitle = createFolder({ id: 3, title: title('Elsewhere') })
    const client = mockClient({
      getFolders: vi.fn().mockResolvedValue(folderResponse([work, numericTitle])),
      iterDialogs: vi.fn(() => asyncItems([])),
      getPeer: vi.fn(),
    })
    const adapter = new MtcuteTelegramFolderAdapter(client, vi.fn())

    await expect(adapter.info(3)).resolves.toMatchObject({ folder_id: 3, folder_name: 'Elsewhere' })
    await expect(adapter.info(99)).rejects.toMatchObject({ code: 'folder_not_found' })
    await expect(adapter.info('missing')).rejects.toMatchObject({ code: 'folder_not_found' })
  })

  it('adds a resolved peer with the exact high-level editFolder shape', async () => {
    const folder = createFolder({ id: 2 })
    const resolvedPeer = peerShape(100, 'Team', 'chat', 'supergroup', channelPeer)
    const client = mockClient({
      getFolders: vi.fn().mockResolvedValue(folderResponse([folder])),
      getPeer: vi.fn().mockResolvedValue(resolvedPeer),
      resolvePeer: vi.fn().mockResolvedValue(channelPeer),
      editFolder: vi.fn().mockResolvedValue(folder),
    })

    await expect(new MtcuteTelegramFolderAdapter(client, vi.fn()).addChat({ folder: 2, chat: '@team' }))
      .resolves.toEqual({ folder_id: 2, chat_id: 100, changed: true })
    expect(client.editFolder).toHaveBeenCalledWith({
      folder,
      modification: expect.objectContaining({ includePeers: [channelPeer] }),
    })
  })

  it('keeps add and remove idempotent and applies dynamic-rule exclusions', async () => {
    const included = createFolder({ id: 2, includePeers: [channelPeer] })
    const dynamic = createFolder({ id: 3, groups: true, excludePeers: [channelPeer] })
    const resolvedPeer = peerShape(100, 'Team', 'chat', 'supergroup', channelPeer)
    const client = mockClient({
      getFolders: vi.fn()
        .mockResolvedValueOnce(folderResponse([included]))
        .mockResolvedValueOnce(folderResponse([dynamic]))
        .mockResolvedValueOnce(folderResponse([createFolder({ id: 3, groups: true })])),
      getPeer: vi.fn().mockResolvedValue(resolvedPeer),
      resolvePeer: vi.fn().mockResolvedValue(channelPeer),
      editFolder: vi.fn().mockResolvedValue(dynamic),
    })
    const adapter = new MtcuteTelegramFolderAdapter(client, vi.fn())

    await expect(adapter.addChat({ folder: 2, chat: '@team' })).resolves.toMatchObject({ changed: false })
    await expect(adapter.removeChat({ folder: 3, chat: '@team' })).resolves.toMatchObject({ changed: false })
    expect(client.editFolder).not.toHaveBeenCalled()

    await expect(adapter.removeChat({ folder: 3, chat: '@team' })).resolves.toMatchObject({ changed: true })
    expect(client.editFolder).toHaveBeenCalledWith(expect.objectContaining({
      modification: { excludePeers: [channelPeer] },
    }))
  })

  it('rejects unresolved chats and unsupported chatlist mutations', async () => {
    const client = mockClient({
      getFolders: vi.fn()
        .mockResolvedValueOnce(folderResponse([createFolder({ id: 2 })]))
        .mockResolvedValueOnce(folderResponse([createChatlist({ id: 4 })])),
      getPeer: vi.fn().mockRejectedValue(new Error('PEER_ID_INVALID accessHash=SECRET')),
    })
    const adapter = new MtcuteTelegramFolderAdapter(client, vi.fn())

    const missing = await adapter.addChat({ folder: 2, chat: '@missing' }).catch((error: unknown) => error)
    expect(missing).toMatchObject({ code: 'chat_not_found' })
    expect((missing as Error).message).not.toContain('SECRET')
    await expect(adapter.addChat({ folder: 4, chat: '@team' }))
      .rejects.toMatchObject({ code: 'folder_operation_unsupported' })
  })

  it('normalizes flood waits, RPC failures, and readiness failures without raw leakage', async () => {
    const floodClient = mockClient({ getFolders: vi.fn().mockRejectedValue(new tl.RpcError(420, 'FLOOD_WAIT_9')) })
    const rpcClient = mockClient({ getFolders: vi.fn().mockRejectedValue(new tl.RpcError(400, 'FILTER_ID_INVALID')) })
    const marker = 'RAW_SESSION_SECRET'
    const readiness = vi.fn().mockRejectedValue(new Error(`connect failed: ${marker}`))

    await expect(new MtcuteTelegramFolderAdapter(floodClient, vi.fn()).list())
      .rejects.toMatchObject({ code: 'flood_wait', seconds: 9 })
    await expect(new MtcuteTelegramFolderAdapter(rpcClient, vi.fn()).list())
      .rejects.toMatchObject({ code: 'telegram_error' })
    const error = await new MtcuteTelegramFolderAdapter(mockClient(), readiness).list()
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'telegram_error' })
    expect((error as Error).message).not.toContain(marker)
  })

  it('calls readiness and is wired into MtcuteTelegramClient', async () => {
    const ensureReady = vi.fn()
    const client = mockClient({ getFolders: vi.fn().mockResolvedValue(folderResponse([createFolder({ id: 2 })])) })
    await new MtcuteTelegramFolderAdapter(client, ensureReady).list()
    expect(ensureReady).toHaveBeenCalledOnce()

    const wiredClient = mockClient({
      connect: vi.fn(),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getFolders: vi.fn().mockResolvedValue(folderResponse([createFolder({ id: 2 })])),
    })
    await expect(new MtcuteTelegramClient(wiredClient).folders.list())
      .resolves.toEqual([expect.objectContaining({ folder_id: 2 })])
    expect(wiredClient.connect).toHaveBeenCalledOnce()
  })
})

function createFolder(
  overrides: Partial<tl.RawDialogFilter> = {},
): tl.RawDialogFilter {
  return {
    _: 'dialogFilter',
    id: 1,
    title: { _: 'textWithEntities', text: 'Work', entities: [] },
    pinnedPeers: [],
    includePeers: [],
    excludePeers: [],
    ...overrides,
  }
}

function createChatlist(
  overrides: Partial<tl.RawDialogFilterChatlist> = {},
): tl.RawDialogFilterChatlist {
  return {
    _: 'dialogFilterChatlist',
    id: 2,
    title: { _: 'textWithEntities', text: 'Shared', entities: [] },
    pinnedPeers: [],
    includePeers: [],
    ...overrides,
  }
}

function title(text: string): tl.RawTextWithEntities {
  return { _: 'textWithEntities', text, entities: [] }
}

function folderResponse(filters: tl.TypeDialogFilter[]): tl.messages.RawDialogFilters {
  return { _: 'messages.dialogFilters', filters }
}

function peerShape(
  id: number,
  displayName: string,
  type: 'user' | 'chat',
  chatType?: 'group' | 'supergroup' | 'channel',
  inputPeer: tl.TypeInputPeer = peer,
) {
  return {
    id,
    displayName,
    type,
    chatType,
    isContact: false,
    isBot: false,
    inputPeer,
  }
}

async function* asyncItems<T>(items: T[]): AsyncGenerator<T> {
  yield* items
}

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    getFolders: vi.fn(),
    iterDialogs: vi.fn(() => asyncItems([])),
    getPeer: vi.fn(),
    resolvePeer: vi.fn(),
    editFolder: vi.fn(),
    ...overrides,
  } as unknown as TelegramClient & {
    getFolders: ReturnType<typeof vi.fn>
    iterDialogs: ReturnType<typeof vi.fn>
    getPeer: ReturnType<typeof vi.fn>
    resolvePeer: ReturnType<typeof vi.fn>
    editFolder: ReturnType<typeof vi.fn>
    connect: ReturnType<typeof vi.fn>
  }
}
