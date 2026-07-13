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
      throw new Error(
        'folder_operation_unsupported: chatlist folders cannot represent exclusions',
      )
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
  if (left._ !== right._) return false

  return peerNumericId(left) === peerNumericId(right)
}

function peerNumericId(peer: tl.TypeInputPeer): number | null {
  switch (peer._) {
    case 'inputPeerChat':
      return peer.chatId
    case 'inputPeerUser':
    case 'inputPeerUserFromMessage':
    case 'mtcute.dummyInputPeerMinUser':
      return peer.userId
    case 'inputPeerChannel':
    case 'inputPeerChannelFromMessage':
    case 'mtcute.dummyInputPeerMinChannel':
      return peer.channelId
    case 'inputPeerEmpty':
    case 'inputPeerSelf':
      return null
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
