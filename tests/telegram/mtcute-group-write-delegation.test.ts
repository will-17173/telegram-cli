import type { TelegramClient } from '@mtcute/node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MtcuteGroupManagement } from '../../src/telegram/mtcute-group-management.js'
import { MtcuteGroupSettings } from '../../src/telegram/mtcute-group-settings.js'
import { MtcuteGroupInvites } from '../../src/telegram/mtcute-group-invites.js'
import { MtcuteGroupTopics } from '../../src/telegram/mtcute-group-topics.js'

const settings = [
  ['setTitle', { chat: 1, title: 'x' }], ['setDescription', { chat: 1, text: 'x' }],
  ['setUsername', { chat: 1, username: null }], ['setPhoto', { chat: 1, path: null }],
  ['setSlowMode', { chat: 1, seconds: null }], ['setTtl', { chat: 1, seconds: null }],
  ['setContentProtection', { chat: 1, enabled: true }], ['setJoinRequests', { chat: 1, enabled: true }],
  ['setJoinToSend', { chat: 1, enabled: true }], ['setDefaultPermissions', { chat: 1, permissions: {} }],
  ['setStickerSet', { chat: 1, sticker: null }], ['leaveGroup', { chat: 1 }], ['deleteGroup', { chat: 1 }],
  ['pinMessage', { chat: 1, messageId: 2 }], ['unpinMessage', { chat: 1, messageId: 2 }],
  ['unpinAllMessages', { chat: 1 }], ['deleteGroupMessages', { chat: 1, messageIds: [2] }],
] as const
const invites = [
  ['listInvites', { chat: 1, limit: 1 }], ['getInvite', { chat: 1, link: 'x' }],
  ['createInvite', { chat: 1, options: {} }], ['editInvite', { chat: 1, link: 'x', options: {} }],
  ['revokeInvite', { chat: 1, link: 'x' }], ['listInviteMembers', { chat: 1, link: 'x', limit: 1 }],
  ['approveJoinRequest', { chat: 1, user: 2 }], ['declineJoinRequest', { chat: 1, user: 2 }],
  ['approveAllJoinRequests', { chat: 1 }], ['declineAllJoinRequests', { chat: 1 }],
] as const
const topics = [
  ['listTopics', { chat: 1, limit: 1 }], ['createTopic', { chat: 1, title: 'x' }],
  ['editTopic', { chat: 1, topicId: 2 }], ['setTopicClosed', { chat: 1, topicId: 2, enabled: true }],
  ['setTopicPinned', { chat: 1, topicId: 2, enabled: true }], ['reorderPinnedTopics', { chat: 1, topicIds: [2] }],
  ['deleteTopic', { chat: 1, topicId: 2 }], ['setGeneralTopicHidden', { chat: 1, enabled: true }],
] as const

describe('MtcuteGroupManagement write delegation', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each(settings)('delegates settings method %s', async (method, request) => assertDelegate(MtcuteGroupSettings, method, request))
  it.each(invites)('delegates invite method %s', async (method, request) => assertDelegate(MtcuteGroupInvites, method, request))
  it.each(topics)('delegates topic method %s', async (method, request) => assertDelegate(MtcuteGroupTopics, method, request))
})

async function assertDelegate(klass: { prototype: object }, method: string, request: object) {
  const expected = { delegated: method }
  const prototype = klass.prototype as Record<string, (...args: unknown[]) => Promise<unknown>>
  const delegated = vi.spyOn(prototype, method).mockResolvedValue(expected)
  const management = new MtcuteGroupManagement({} as TelegramClient, vi.fn())
  const result = await Reflect.apply(Reflect.get(management, method) as (...args: unknown[]) => unknown, management, [request])
  expect(delegated).toHaveBeenCalledWith(request)
  expect(result).toBe(expected)
}
