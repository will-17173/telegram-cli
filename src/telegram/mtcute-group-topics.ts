import { Long, type ForumTopic, type TelegramClient } from '@mtcute/node'
import type * as W from './group-write-types.js'
import { TelegramUnsupportedGroupTypeError } from './group-types.js'
import { normalizePeerId, requireGroup, throwWriteError } from './mtcute-group-helpers.js'

export class MtcuteGroupTopics {
  constructor(private readonly client: TelegramClient, private readonly ensureReady: () => Promise<void>) {}
  private async group(chat: W.GroupPeer) { await this.ensureReady(); const id = normalizePeerId(chat); try { const group = requireGroup(await this.client.getChat(id), chat); if (group.chatType !== 'supergroup' || !group.isForum) throw new TelegramUnsupportedGroupTypeError(chat); return { id, group } } catch (e) { throwWriteError(e, chat) } }
  private result<K extends W.TelegramGroupMutationOperation>(operation: K, id: number): W.TelegramGroupWriteResult<K> { return { operation, chat_id: id } }
  async listTopics(r: W.TelegramListTopicsRequest) { const x = await this.group(r.chat); try { const rows = await this.client.getForumTopics(x.id, { limit: r.limit }); return { chat_id: x.group.id, topics: rows.map(mapTopic), total: validTotal(rows.total) } } catch (e) { throwWriteError(e, r.chat) } }
  async createTopic(r: W.TelegramCreateTopicRequest) { const x = await this.group(r.chat); try { const message = await this.client.createForumTopic({ chatId: x.id, title: r.title, icon: r.iconEmojiId == null ? r.iconColor : Long.fromString(r.iconEmojiId) }); const topic = (await this.client.getForumTopics(x.id, { limit: 100 })).find(t => t.id === message.id); if (!topic) throw new Error('Created topic was not returned by Telegram'); return { chat_id: x.group.id, topic: mapTopic(topic) } } catch (e) { throwWriteError(e, r.chat) } }
  async editTopic(r: W.TelegramEditTopicRequest) { const x = await this.group(r.chat); try { await this.client.editForumTopic({ chatId: x.id, topicId: r.topicId, title: r.title, icon: r.iconEmojiId == null ? r.iconEmojiId : Long.fromString(r.iconEmojiId) }); const topic = (await this.client.getForumTopics(x.id, { limit: 100 })).find(t => t.id === r.topicId); if (!topic) throw new Error('Edited topic was not returned by Telegram'); return { chat_id: x.group.id, topic: mapTopic(topic) } } catch (e) { throwWriteError(e, r.chat) } }
  async mutation<K extends W.TelegramGroupMutationOperation>(r: { chat: W.GroupPeer }, operation: K, fn: (id: string | number) => Promise<unknown>): Promise<W.TelegramGroupWriteResult<K>> { const x = await this.group(r.chat); try { await fn(x.id); return this.result(operation, x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  setTopicClosed(r: W.TelegramSetTopicClosedRequest) { return this.mutation(r, 'setTopicClosed', id => this.client.toggleForumTopicClosed({ chatId: id, topicId: r.topicId, closed: r.enabled })) }
  setTopicPinned(r: W.TelegramSetTopicPinnedRequest) { return this.mutation(r, 'setTopicPinned', id => this.client.toggleForumTopicPinned({ chatId: id, topicId: r.topicId, pinned: r.enabled })) }
  reorderPinnedTopics(r: W.TelegramReorderPinnedTopicsRequest) { return this.mutation(r, 'reorderPinnedTopics', id => this.client.reorderPinnedForumTopics({ chatId: id, order: [...r.topicIds], force: true })) }
  deleteTopic(r: W.TelegramDeleteTopicRequest) { return this.mutation(r, 'deleteTopic', id => this.client.deleteForumTopicHistory(id, r.topicId)) }
  setGeneralTopicHidden(r: W.TelegramSetGeneralTopicHiddenRequest) { return this.mutation(r, 'setGeneralTopicHidden', id => this.client.toggleGeneralTopicHidden({ chatId: id, hidden: r.enabled })) }
}
function mapTopic(t: ForumTopic): W.TelegramGroupTopicRecord { return { id: t.id, title: t.title, icon_color: t.iconColor, icon_emoji_id: t.iconCustomEmoji?.toString() ?? null, closed: t.isClosed, pinned: t.isPinned, hidden: Boolean((t.raw as typeof t.raw & { hidden?: boolean }).hidden) } }
function validTotal(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null }
