import { tl, type Peer, type TelegramClient } from '@mtcute/node'

import {
  TelegramFolderError,
  type TelegramFolderAdapter,
  type TelegramFolderChat,
  type TelegramFolderChatRequest,
  type TelegramFolderChatResult,
  type TelegramFolderDetail,
  type TelegramFolderInput,
  type TelegramFolderSummary,
} from './folder-types.js'
import { isPeerNotFoundError, normalizePeerId } from './mtcute-group-helpers.js'

export type FolderPeerCategory =
  | 'contact'
  | 'non-contact'
  | 'user'
  | 'group'
  | 'supergroup'
  | 'broadcast'
  | 'channel'
  | 'bot'
  | 'contact-bot'
  | 'non-contact-bot'

export type RawFolder = tl.RawDialogFilter | tl.RawDialogFilterChatlist

export type FolderPeerModification = Partial<Pick<
  tl.RawDialogFilter,
  'pinnedPeers' | 'includePeers' | 'excludePeers'
>>

export interface FolderTransformResult {
  changed: boolean
  modification: FolderPeerModification
}

export class FolderOperationUnsupportedError extends TelegramFolderError {
  constructor() {
    super('folder_operation_unsupported', 'This folder type does not support exclusions.')
    this.name = 'FolderOperationUnsupportedError'
  }
}

export class MtcuteTelegramFolderAdapter implements TelegramFolderAdapter {
  constructor(
    private readonly client: TelegramClient,
    private readonly ensureReady: () => Promise<void>,
  ) {}

  async list(): Promise<TelegramFolderSummary[]> {
    try {
      await this.ensureReady()
      const folders = await this.fetchFolders()
      const summaries: TelegramFolderSummary[] = []
      for (const folder of folders) {
        const chats = await this.effectiveChats(folder)
        summaries.push(toSummary(folder, chats.length))
      }
      return summaries
    } catch (error) {
      throwFolderError(error)
    }
  }

  async info(input: TelegramFolderInput): Promise<TelegramFolderDetail> {
    try {
      await this.ensureReady()
      const folder = await this.resolveFolder(input)
      const [chats, includedChats, excludedChats, pinnedChats] = await Promise.all([
        this.effectiveChats(folder),
        this.mapPeers(folder.includePeers),
        this.mapPeers(folder._ === 'dialogFilter' ? folder.excludePeers : []),
        this.mapPeers(folder.pinnedPeers),
      ])
      return {
        ...toSummary(folder, chats.length),
        chats,
        rules: {
          include_contacts: folder._ === 'dialogFilter' && folder.contacts === true,
          include_non_contacts: folder._ === 'dialogFilter' && folder.nonContacts === true,
          include_groups: folder._ === 'dialogFilter' && folder.groups === true,
          include_channels: folder._ === 'dialogFilter' && folder.broadcasts === true,
          include_bots: folder._ === 'dialogFilter' && folder.bots === true,
          exclude_muted: folder._ === 'dialogFilter' && folder.excludeMuted === true,
          exclude_read: folder._ === 'dialogFilter' && folder.excludeRead === true,
          exclude_archived: folder._ === 'dialogFilter' && folder.excludeArchived === true,
        },
        included_chats: includedChats,
        excluded_chats: excludedChats,
        pinned_chats: pinnedChats,
      }
    } catch (error) {
      throwFolderError(error)
    }
  }

  async addChat(request: TelegramFolderChatRequest): Promise<TelegramFolderChatResult> {
    return await this.mutate(request, 'add')
  }

  async removeChat(request: TelegramFolderChatRequest): Promise<TelegramFolderChatResult> {
    return await this.mutate(request, 'remove')
  }

  private async mutate(
    request: TelegramFolderChatRequest,
    operation: 'add' | 'remove',
  ): Promise<TelegramFolderChatResult> {
    try {
      await this.ensureReady()
      const folder = await this.resolveFolder(request.folder)
      if (folder._ === 'dialogFilterChatlist') throw new FolderOperationUnsupportedError()
      const peer = await this.client.getPeer(normalizePeerId(request.chat))
      const inputPeer = await this.client.resolvePeer(peer)
      const transformed = operation === 'add'
        ? addPeerToFolder(folder, inputPeer)
        : removePeerFromFolder(folder, inputPeer, classifyPeer(peer))
      if (transformed.changed) {
        await this.client.editFolder({ folder, modification: transformed.modification })
      }
      return { folder_id: folder.id, chat_id: peer.id, changed: transformed.changed }
    } catch (error) {
      throwFolderError(error, request.chat)
    }
  }

  private async fetchFolders(): Promise<RawFolder[]> {
    const response = await this.client.getFolders()
    return response.filters.filter((folder): folder is RawFolder => folder._ !== 'dialogFilterDefault')
  }

  private async resolveFolder(input: TelegramFolderInput): Promise<RawFolder> {
    const folders = await this.fetchFolders()
    const matches = typeof input === 'number'
      ? folders.filter((folder) => folder.id === input)
      : folders.filter((folder) => normalizeFolderTitle(folder.title.text) === normalizeFolderTitle(input))
    if (matches.length === 0) {
      throw new TelegramFolderError('folder_not_found', 'Telegram folder not found.')
    }
    if (matches.length > 1) {
      throw new TelegramFolderError(
        'ambiguous_folder',
        'Telegram folder title is ambiguous.',
        { candidate_ids: matches.map((folder) => folder.id) },
      )
    }
    return matches[0]!
  }

  private async effectiveChats(folder: RawFolder): Promise<TelegramFolderChat[]> {
    const chats: TelegramFolderChat[] = []
    // mtcute accepts every TypeDialogFilter at runtime, while 0.30.3 narrows
    // this public option to RawDialogFilter only.
    for await (const dialog of this.client.iterDialogs({ folder: folder as tl.RawDialogFilter })) {
      chats.push({ chat_id: dialog.peer.id, chat_name: dialog.peer.displayName })
    }
    return chats
  }

  private async mapPeers(peers: readonly tl.TypeInputPeer[]): Promise<TelegramFolderChat[]> {
    return await Promise.all(peers.map(async (peer) => {
      const resolved = await this.client.getPeer(peer)
      return { chat_id: resolved.id, chat_name: resolved.displayName }
    }))
  }
}

export function createFoldersAdapter(
  client: TelegramClient,
  ensureReady: () => Promise<void>,
): TelegramFolderAdapter {
  const adapter = new MtcuteTelegramFolderAdapter(client, ensureReady)
  return {
    list: adapter.list.bind(adapter),
    info: adapter.info.bind(adapter),
    addChat: adapter.addChat.bind(adapter),
    removeChat: adapter.removeChat.bind(adapter),
  }
}

export function addPeerToFolder(
  folder: RawFolder,
  peer: tl.TypeInputPeer,
): FolderTransformResult {
  const includePeers = keepOneEquivalentPeer(folder.includePeers, peer)
  const hasIncludedPeer = includePeers.some((candidate) => peersAreEquivalent(candidate, peer))
  if (!hasIncludedPeer) includePeers.push(peer)

  if (folder._ === 'dialogFilterChatlist') {
    if (samePeerList(includePeers, folder.includePeers)) {
      return unchangedResult()
    }
    return { changed: true, modification: { includePeers } }
  }

  const excludePeers = folder.excludePeers.filter(
    (candidate) => !peersAreEquivalent(candidate, peer),
  )
  if (
    samePeerList(includePeers, folder.includePeers)
    && samePeerList(excludePeers, folder.excludePeers)
  ) {
    return unchangedResult()
  }

  return {
    changed: true,
    modification: { includePeers, excludePeers },
  }
}

export function removePeerFromFolder(
  folder: RawFolder,
  peer: tl.TypeInputPeer,
  category: FolderPeerCategory,
): FolderTransformResult {
  const includePeers = folder.includePeers.filter(
    (candidate) => !peersAreEquivalent(candidate, peer),
  )
  const pinnedPeers = folder.pinnedPeers.filter(
    (candidate) => !peersAreEquivalent(candidate, peer),
  )
  const includeChanged = !samePeerList(includePeers, folder.includePeers)
  const pinsChanged = !samePeerList(pinnedPeers, folder.pinnedPeers)
  const dynamicallyIncluded = categoryIsIncluded(folder, category)

  if (folder._ === 'dialogFilterChatlist') {
    if (dynamicallyIncluded) {
      throw new FolderOperationUnsupportedError()
    }
    if (!includeChanged && !pinsChanged) return unchangedResult()

    return {
      changed: true,
      modification: {
        ...(includeChanged ? { includePeers } : {}),
        ...(pinsChanged ? { pinnedPeers } : {}),
      },
    }
  }

  const alreadyExcluded = folder.excludePeers.some(
    (candidate) => peersAreEquivalent(candidate, peer),
  )
  const exclusionRequired = dynamicallyIncluded && !alreadyExcluded
  if (!includeChanged && !pinsChanged && !exclusionRequired) return unchangedResult()

  return {
    changed: true,
    modification: {
      ...(includeChanged ? { includePeers } : {}),
      ...(pinsChanged ? { pinnedPeers } : {}),
      ...(exclusionRequired ? { excludePeers: [...folder.excludePeers, peer] } : {}),
    },
  }
}

function normalizeFolderTitle(title: string): string {
  return title.trim().toLowerCase()
}

function toSummary(folder: RawFolder, chatCount: number): TelegramFolderSummary {
  return {
    folder_id: folder.id,
    folder_name: folder.title.text,
    emoticon: folder.emoticon ?? null,
    color: folder.color ?? null,
    chat_count: chatCount,
  }
}

function classifyPeer(peer: Peer): FolderPeerCategory {
  if (peer.type === 'user') {
    if (peer.isBot) return peer.isContact ? 'contact-bot' : 'non-contact-bot'
    return peer.isContact ? 'contact' : 'non-contact'
  }
  switch (peer.chatType) {
    case 'group':
      return 'group'
    case 'channel':
      return 'broadcast'
    case 'supergroup':
    case 'gigagroup':
    case 'monoforum':
      return 'supergroup'
  }
}

function throwFolderError(error: unknown, chat?: string | number): never {
  if (error instanceof TelegramFolderError) throw error
  const floodSeconds = readFloodSeconds(error)
  if (floodSeconds != null) {
    throw new TelegramFolderError(
      'flood_wait',
      `Telegram flood wait: ${floodSeconds} seconds`,
      { seconds: floodSeconds },
    )
  }
  if (chat != null && isPeerNotFoundError(error)) {
    throw new TelegramFolderError('chat_not_found', `Telegram chat not found: ${String(chat)}`)
  }
  throw new TelegramFolderError('telegram_error', 'Telegram folder request failed.')
}

function readFloodSeconds(error: unknown): number | null {
  if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) return error.seconds
  if (!tl.RpcError.is(error)) return null
  const match = /^FLOOD_WAIT_(\d+)$/.exec(error.text)
  return match == null ? null : Number(match[1])
}

function categoryIsIncluded(
  folder: RawFolder,
  category: FolderPeerCategory,
): boolean {
  switch (category) {
    case 'contact':
      return 'contacts' in folder && folder.contacts === true
    case 'non-contact':
      return 'nonContacts' in folder && folder.nonContacts === true
    case 'contact-bot':
      return ('contacts' in folder && folder.contacts === true)
        || ('bots' in folder && folder.bots === true)
    case 'non-contact-bot':
      return ('nonContacts' in folder && folder.nonContacts === true)
        || ('bots' in folder && folder.bots === true)
    case 'group':
    case 'supergroup':
      return 'groups' in folder && folder.groups === true
    case 'broadcast':
    case 'channel':
      return 'broadcasts' in folder && folder.broadcasts === true
    case 'bot':
      return 'bots' in folder && folder.bots === true
    case 'user':
      return false
  }
}

function peersAreEquivalent(
  left: tl.TypeInputPeer,
  right: tl.TypeInputPeer,
): boolean {
  const leftIdentity = peerIdentity(left)
  const rightIdentity = peerIdentity(right)

  return leftIdentity.kind === rightIdentity.kind
    && leftIdentity.id === rightIdentity.id
}

interface PeerIdentity {
  kind: 'user' | 'channel' | 'chat' | 'self' | 'empty'
  id: number | null
}

function peerIdentity(peer: tl.TypeInputPeer): PeerIdentity {
  switch (peer._) {
    case 'inputPeerChat':
      return { kind: 'chat', id: peer.chatId }
    case 'inputPeerUser':
    case 'inputPeerUserFromMessage':
    case 'mtcute.dummyInputPeerMinUser':
      return { kind: 'user', id: peer.userId }
    case 'inputPeerChannel':
    case 'inputPeerChannelFromMessage':
    case 'mtcute.dummyInputPeerMinChannel':
      return { kind: 'channel', id: peer.channelId }
    case 'inputPeerEmpty':
      return { kind: 'empty', id: null }
    case 'inputPeerSelf':
      return { kind: 'self', id: null }
  }
}

function keepOneEquivalentPeer(
  peers: readonly tl.TypeInputPeer[],
  target: tl.TypeInputPeer,
): tl.TypeInputPeer[] {
  let found = false
  return peers.filter((candidate) => {
    if (!peersAreEquivalent(candidate, target)) return true
    if (found) return false
    found = true
    return true
  })
}

function samePeerList(
  left: readonly tl.TypeInputPeer[],
  right: readonly tl.TypeInputPeer[],
): boolean {
  return left.length === right.length
    && left.every((peer, index) => peersAreEquivalent(peer, right[index]))
}

function unchangedResult(): FolderTransformResult {
  return { changed: false, modification: {} }
}
