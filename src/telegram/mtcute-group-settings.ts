import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TelegramClient } from '@mtcute/node'
import type * as W from './group-write-types.js'
import { normalizePeerId, requireGroup, throwWriteError } from './mtcute-group-helpers.js'
import { TelegramUnsupportedGroupTypeError } from './group-types.js'

export class MtcuteGroupSettings {
  constructor(private readonly client: TelegramClient, private readonly ensureReady: () => Promise<void>, private readonly home = homedir) {}
  private async group(chat: W.GroupPeer) { await this.ensureReady(); const id = normalizePeerId(chat); try { return { id, group: requireGroup(await this.client.getChat(id), chat) } } catch (e) { throwWriteError(e, chat) } }
  private async supergroup(chat: W.GroupPeer) { const x = await this.group(chat); if (x.group.chatType !== 'supergroup') throw new TelegramUnsupportedGroupTypeError(chat); return x }
  private result<K extends W.TelegramGroupMutationOperation>(operation: K, chatId: number): W.TelegramGroupWriteResult<K> { return { operation, chat_id: chatId } }
  async setTitle(r: W.TelegramSetTitleRequest) { const x = await this.group(r.chat); try { await this.client.setChatTitle(x.id, r.title); return this.result('setTitle', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setDescription(r: W.TelegramSetDescriptionRequest) { const x = await this.group(r.chat); try { await this.client.setChatDescription(x.id, r.text); return this.result('setDescription', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setUsername(r: W.TelegramSetUsernameRequest) { const x = await this.supergroup(r.chat); try { await this.client.setChatUsername(x.id, r.username); return this.result('setUsername', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setPhoto(r: W.TelegramSetPhotoRequest) { const x = await this.group(r.chat); try { if (r.path == null) await this.client.deleteChatPhoto(x.id); else await this.client.setChatPhoto({ chatId: x.id, type: 'photo', media: r.path.startsWith('~/') ? join(this.home(), r.path.slice(2)) : r.path }); return this.result('setPhoto', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setSlowMode(r: W.TelegramSetSlowModeRequest) { const x = await this.supergroup(r.chat); try { await this.client.setSlowMode(x.id, r.seconds ?? 0); return this.result('setSlowMode', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setTtl(r: W.TelegramSetTtlRequest) { const x = await this.group(r.chat); try { await this.client.setChatTtl(x.id, r.seconds ?? 0); return this.result('setTtl', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setContentProtection(r: W.TelegramSetContentProtectionRequest) { const x = await this.group(r.chat); try { await this.client.toggleContentProtection(x.id, r.enabled); return this.result('setContentProtection', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setJoinRequests(r: W.TelegramSetJoinRequestsRequest) { const x = await this.supergroup(r.chat); try { await this.client.toggleJoinRequests(x.id, r.enabled); return this.result('setJoinRequests', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setJoinToSend(r: W.TelegramSetJoinToSendRequest) { const x = await this.supergroup(r.chat); try { await this.client.toggleJoinToSend(x.id, r.enabled); return this.result('setJoinToSend', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setDefaultPermissions(r: W.TelegramSetDefaultPermissionsRequest) { const x = await this.group(r.chat); const p = r.permissions; try { await this.client.setChatDefaultPermissions(x.id, { viewMessages: p.view_messages, sendMessages: p.send_messages, sendMedia: p.send_media, sendStickers: p.send_stickers, sendGifs: p.send_gifs, sendGames: p.send_games, sendInline: p.send_inline, embedLinks: p.embed_links, sendPolls: p.send_polls, changeInfo: p.change_info, inviteUsers: p.invite_users, pinMessages: p.pin_messages, manageTopics: p.manage_topics }); return this.result('setDefaultPermissions', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async setStickerSet(r: W.TelegramSetStickerSetRequest) { const x = await this.supergroup(r.chat); try { await this.client.setChatStickerSet(x.id, r.sticker ?? { _: 'inputStickerSetEmpty' }); return this.result('setStickerSet', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async leaveGroup(r: W.TelegramLeaveGroupRequest) { const x = await this.group(r.chat); try { await this.client.leaveChat(x.id); return this.result('leaveGroup', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async deleteGroup(r: W.TelegramDeleteGroupRequest) { const x = await this.group(r.chat); try { await (x.group.chatType === 'group' ? this.client.deleteGroup(x.id) : this.client.deleteSupergroup(x.id)); return this.result('deleteGroup', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async pinMessage(r: W.TelegramPinMessageRequest) { const x = await this.group(r.chat); try { await this.client.pinMessage({ chatId: x.id, message: r.messageId, notify: r.notify }); return this.result('pinMessage', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async unpinMessage(r: W.TelegramUnpinMessageRequest) { const x = await this.group(r.chat); try { await this.client.unpinMessage({ chatId: x.id, message: r.messageId }); return this.result('unpinMessage', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async unpinAllMessages(r: W.TelegramUnpinAllMessagesRequest) { const x = await this.group(r.chat); try { await this.client.unpinAllMessages(x.id); return this.result('unpinAllMessages', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
  async deleteGroupMessages(r: W.TelegramDeleteGroupMessagesRequest) { const x = await this.group(r.chat); try { await this.client.deleteMessagesById(x.id, [...r.messageIds]); return this.result('deleteGroupMessages', x.group.id) } catch (e) { throwWriteError(e, r.chat) } }
}
