import { Long, type tl } from '@mtcute/node'
import { describe, expect, it } from 'vitest'

import {
  addPeerToFolder,
  removePeerFromFolder,
} from '../../src/telegram/mtcute-folders.js'

const peer = { _: 'inputPeerUser', userId: 42, accessHash: Long.fromNumber(100) } as const
const otherPeer = { _: 'inputPeerUser', userId: 7, accessHash: Long.fromNumber(200) } as const
const channelPeer = { _: 'inputPeerChannel', channelId: 42, accessHash: Long.fromNumber(300) } as const

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

  it('reports unchanged when an equivalent peer is already included and not excluded', () => {
    const equivalentPeer = { ...peer, accessHash: Long.fromNumber(999) }

    expect(addPeerToFolder(createFolder({ includePeers: [equivalentPeer] }), peer))
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
      .toThrow(/folder_operation_unsupported/)
  })

  it('allows explicit include and pin removal from a chatlist without an exclusion', () => {
    const folder = createChatlist({ includePeers: [peer], pinnedPeers: [peer] })

    expect(removePeerFromFolder(folder, peer, 'user')).toEqual({
      changed: true,
      modification: { includePeers: [], pinnedPeers: [] },
    })
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
