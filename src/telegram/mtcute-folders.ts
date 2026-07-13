import { type tl } from '@mtcute/node'

export type FolderPeerCategory =
  | 'contact'
  | 'non-contact'
  | 'user'
  | 'group'
  | 'supergroup'
  | 'broadcast'
  | 'channel'
  | 'bot'

export type RawFolder = tl.RawDialogFilter | tl.RawDialogFilterChatlist

export type FolderPeerModification = Partial<Pick<
  tl.RawDialogFilter,
  'pinnedPeers' | 'includePeers' | 'excludePeers'
>>

export interface FolderTransformResult {
  changed: boolean
  modification: FolderPeerModification
}

export class FolderOperationUnsupportedError extends Error {
  readonly code = 'folder_operation_unsupported'

  constructor() {
    super('This folder type does not support exclusions.')
    this.name = 'FolderOperationUnsupportedError'
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

function categoryIsIncluded(
  folder: RawFolder,
  category: FolderPeerCategory,
): boolean {
  switch (category) {
    case 'contact':
      return 'contacts' in folder && folder.contacts === true
    case 'non-contact':
      return 'nonContacts' in folder && folder.nonContacts === true
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
