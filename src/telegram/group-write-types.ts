import type { TelegramGroupAdminRights, TelegramGroupRestrictions } from './group-types.js'

export type GroupPeer = string | number
export type GroupUser = string | number
export type TelegramGroupWriteOperation =
  | 'addMembers' | 'kickMember' | 'banMember' | 'unbanMember' | 'muteMember' | 'unmuteMember' | 'purgeMember'
  | 'promoteAdmin' | 'demoteAdmin' | 'setAdminRank' | 'transferOwnership'
  | 'setTitle' | 'setDescription' | 'setUsername' | 'setPhoto' | 'setSlowMode' | 'setTtl'
  | 'setContentProtection' | 'setJoinRequests' | 'setJoinToSend' | 'setDefaultPermissions' | 'setStickerSet'
  | 'leaveGroup' | 'deleteGroup' | 'listInvites' | 'getInvite' | 'createInvite' | 'editInvite' | 'revokeInvite'
  | 'listInviteMembers' | 'approveJoinRequest' | 'declineJoinRequest' | 'approveAllJoinRequests' | 'declineAllJoinRequests'
  | 'listTopics' | 'createTopic' | 'editTopic' | 'setTopicClosed' | 'setTopicPinned' | 'reorderPinnedTopics'
  | 'deleteTopic' | 'setGeneralTopicHidden' | 'pinMessage' | 'unpinMessage' | 'unpinAllMessages' | 'deleteGroupMessages'
export type TelegramGroupMutationOperation = Exclude<TelegramGroupWriteOperation,
  | 'listInvites' | 'getInvite' | 'createInvite' | 'editInvite' | 'revokeInvite' | 'listInviteMembers'
  | 'listTopics' | 'createTopic' | 'editTopic'>

export type TelegramSerializable = null | boolean | number | string | readonly TelegramSerializable[] | { readonly [key: string]: TelegramSerializable }
export interface TelegramGroupWriteResult<K extends TelegramGroupMutationOperation = TelegramGroupMutationOperation> { readonly operation: K; readonly chat_id: number; readonly target_id?: number | string; readonly effective_until?: string | null; readonly details?: Readonly<Record<string, TelegramSerializable>> }
export interface TelegramGroupInviteRecord { readonly link: string; readonly title: string | null; readonly creator_id: number | null; readonly created_at: string | null; readonly expires_at: string | null; readonly usage_limit: number | null; readonly usage_count: number; readonly request_needed: boolean; readonly revoked: boolean }
export interface TelegramGroupInvitePage { readonly chat_id: number; readonly invites: readonly TelegramGroupInviteRecord[]; readonly total: number | null }
export interface TelegramGroupInviteMemberRecord { readonly user_id: number; readonly display_name: string; readonly username: string | null; readonly joined_at: string | null; readonly requested: boolean }
export interface TelegramGroupInviteMemberPage { readonly chat_id: number; readonly link: string; readonly members: readonly TelegramGroupInviteMemberRecord[]; readonly total: number | null }
export interface TelegramGroupTopicRecord { readonly id: number; readonly title: string; readonly icon_color: number | null; readonly icon_emoji_id: string | null; readonly closed: boolean; readonly pinned: boolean; readonly hidden: boolean }
export interface TelegramGroupTopicPage { readonly chat_id: number; readonly topics: readonly TelegramGroupTopicRecord[]; readonly total: number | null }
export interface TelegramGroupInviteResult { readonly chat_id: number; readonly invite: TelegramGroupInviteRecord }
export interface TelegramGroupTopicResult { readonly chat_id: number; readonly topic: TelegramGroupTopicRecord }

export interface TelegramInviteOptions { readonly title?: string; readonly expireSeconds?: number | null; readonly usageLimit?: number | null; readonly requestNeeded?: boolean }
interface ChatRequest { readonly chat: GroupPeer }
interface UserRequest extends ChatRequest { readonly user: GroupUser }
interface TimedUserRequest extends UserRequest { readonly seconds: number | null }
interface TopicRequest extends ChatRequest { readonly topicId: number }
interface MessageRequest extends ChatRequest { readonly messageId: number }

export interface TelegramAddMembersRequest extends ChatRequest { readonly users: readonly GroupUser[] }
export interface TelegramKickMemberRequest extends UserRequest {}
export interface TelegramBanMemberRequest extends TimedUserRequest {}
export interface TelegramUnbanMemberRequest extends UserRequest {}
export interface TelegramMuteMemberRequest extends TimedUserRequest { readonly permissions?: TelegramGroupRestrictions }
export interface TelegramUnmuteMemberRequest extends UserRequest {}
export interface TelegramPurgeMemberRequest extends UserRequest {}
export interface TelegramPromoteAdminRequest extends UserRequest { readonly rights: TelegramGroupAdminRights; readonly rank?: string }
export interface TelegramDemoteAdminRequest extends UserRequest {}
export interface TelegramSetAdminRankRequest extends UserRequest { readonly rank: string }
export interface TelegramTransferOwnershipRequest extends UserRequest {}
export interface TelegramSetTitleRequest extends ChatRequest { readonly title: string }
export interface TelegramSetDescriptionRequest extends ChatRequest { readonly text: string }
export interface TelegramSetUsernameRequest extends ChatRequest { readonly username: string | null }
export interface TelegramSetPhotoRequest extends ChatRequest { readonly path: string | null }
export interface TelegramSetSlowModeRequest extends ChatRequest { readonly seconds: number | null }
export interface TelegramSetTtlRequest extends ChatRequest { readonly seconds: number | null }
export interface TelegramSetContentProtectionRequest extends ChatRequest { readonly enabled: boolean }
export interface TelegramSetJoinRequestsRequest extends ChatRequest { readonly enabled: boolean }
export interface TelegramSetJoinToSendRequest extends ChatRequest { readonly enabled: boolean }
export interface TelegramSetDefaultPermissionsRequest extends ChatRequest { readonly permissions: TelegramGroupRestrictions }
export interface TelegramSetStickerSetRequest extends ChatRequest { readonly sticker: string | null }
export interface TelegramLeaveGroupRequest extends ChatRequest {}
export interface TelegramDeleteGroupRequest extends ChatRequest {}
export interface TelegramListInvitesRequest extends ChatRequest { readonly limit: number }
export interface TelegramGetInviteRequest extends ChatRequest { readonly link: string }
export interface TelegramCreateInviteRequest extends ChatRequest { readonly options: TelegramInviteOptions }
export interface TelegramEditInviteRequest extends ChatRequest { readonly link: string; readonly options: TelegramInviteOptions }
export interface TelegramRevokeInviteRequest extends ChatRequest { readonly link: string }
export interface TelegramListInviteMembersRequest extends ChatRequest { readonly link: string; readonly limit: number }
export interface TelegramApproveJoinRequestRequest extends UserRequest {}
export interface TelegramDeclineJoinRequestRequest extends UserRequest {}
export interface TelegramApproveAllJoinRequestsRequest extends ChatRequest {}
export interface TelegramDeclineAllJoinRequestsRequest extends ChatRequest {}
export interface TelegramListTopicsRequest extends ChatRequest { readonly limit: number }
export interface TelegramCreateTopicRequest extends ChatRequest { readonly title: string; readonly iconColor?: number; readonly iconEmojiId?: string }
export interface TelegramEditTopicRequest extends TopicRequest { readonly title?: string; readonly iconEmojiId?: string | null }
export interface TelegramSetTopicClosedRequest extends TopicRequest { readonly enabled: boolean }
export interface TelegramSetTopicPinnedRequest extends TopicRequest { readonly enabled: boolean }
export interface TelegramReorderPinnedTopicsRequest extends ChatRequest { readonly topicIds: readonly number[] }
export interface TelegramDeleteTopicRequest extends TopicRequest {}
export interface TelegramSetGeneralTopicHiddenRequest extends ChatRequest { readonly enabled: boolean }
export interface TelegramPinMessageRequest extends MessageRequest { readonly notify?: boolean }
export interface TelegramUnpinMessageRequest extends MessageRequest {}
export interface TelegramUnpinAllMessagesRequest extends ChatRequest {}
export interface TelegramDeleteGroupMessagesRequest extends ChatRequest { readonly messageIds: readonly number[] }

export type TelegramAddMembersResult = TelegramGroupWriteResult<'addMembers'>
export type TelegramKickMemberResult = TelegramGroupWriteResult<'kickMember'>
export type TelegramBanMemberResult = TelegramGroupWriteResult<'banMember'>
export type TelegramUnbanMemberResult = TelegramGroupWriteResult<'unbanMember'>
export type TelegramMuteMemberResult = TelegramGroupWriteResult<'muteMember'>
export type TelegramUnmuteMemberResult = TelegramGroupWriteResult<'unmuteMember'>
export type TelegramPurgeMemberResult = TelegramGroupWriteResult<'purgeMember'>
export type TelegramPromoteAdminResult = TelegramGroupWriteResult<'promoteAdmin'>
export type TelegramDemoteAdminResult = TelegramGroupWriteResult<'demoteAdmin'>
export type TelegramSetAdminRankResult = TelegramGroupWriteResult<'setAdminRank'>
export type TelegramTransferOwnershipResult = TelegramGroupWriteResult<'transferOwnership'>
export type TelegramSetTitleResult = TelegramGroupWriteResult<'setTitle'>
export type TelegramSetDescriptionResult = TelegramGroupWriteResult<'setDescription'>
export type TelegramSetUsernameResult = TelegramGroupWriteResult<'setUsername'>
export type TelegramSetPhotoResult = TelegramGroupWriteResult<'setPhoto'>
export type TelegramSetSlowModeResult = TelegramGroupWriteResult<'setSlowMode'>
export type TelegramSetTtlResult = TelegramGroupWriteResult<'setTtl'>
export type TelegramSetContentProtectionResult = TelegramGroupWriteResult<'setContentProtection'>
export type TelegramSetJoinRequestsResult = TelegramGroupWriteResult<'setJoinRequests'>
export type TelegramSetJoinToSendResult = TelegramGroupWriteResult<'setJoinToSend'>
export type TelegramSetDefaultPermissionsResult = TelegramGroupWriteResult<'setDefaultPermissions'>
export type TelegramSetStickerSetResult = TelegramGroupWriteResult<'setStickerSet'>
export type TelegramLeaveGroupResult = TelegramGroupWriteResult<'leaveGroup'>
export type TelegramDeleteGroupResult = TelegramGroupWriteResult<'deleteGroup'>
export type TelegramListInvitesResult = TelegramGroupInvitePage
export type TelegramGetInviteResult = TelegramGroupInviteResult
export type TelegramCreateInviteResult = TelegramGroupInviteResult
export type TelegramEditInviteResult = TelegramGroupInviteResult
export type TelegramRevokeInviteResult = TelegramGroupInviteResult
export type TelegramListInviteMembersResult = TelegramGroupInviteMemberPage
export type TelegramApproveJoinRequestResult = TelegramGroupWriteResult<'approveJoinRequest'>
export type TelegramDeclineJoinRequestResult = TelegramGroupWriteResult<'declineJoinRequest'>
export type TelegramApproveAllJoinRequestsResult = TelegramGroupWriteResult<'approveAllJoinRequests'>
export type TelegramDeclineAllJoinRequestsResult = TelegramGroupWriteResult<'declineAllJoinRequests'>
export type TelegramListTopicsResult = TelegramGroupTopicPage
export type TelegramCreateTopicResult = TelegramGroupTopicResult
export type TelegramEditTopicResult = TelegramGroupTopicResult
export type TelegramSetTopicClosedResult = TelegramGroupWriteResult<'setTopicClosed'>
export type TelegramSetTopicPinnedResult = TelegramGroupWriteResult<'setTopicPinned'>
export type TelegramReorderPinnedTopicsResult = TelegramGroupWriteResult<'reorderPinnedTopics'>
export type TelegramDeleteTopicResult = TelegramGroupWriteResult<'deleteTopic'>
export type TelegramSetGeneralTopicHiddenResult = TelegramGroupWriteResult<'setGeneralTopicHidden'>
export type TelegramPinMessageResult = TelegramGroupWriteResult<'pinMessage'>
export type TelegramUnpinMessageResult = TelegramGroupWriteResult<'unpinMessage'>
export type TelegramUnpinAllMessagesResult = TelegramGroupWriteResult<'unpinAllMessages'>
export type TelegramDeleteGroupMessagesResult = TelegramGroupWriteResult<'deleteGroupMessages'>

export interface GroupWriteOperationRequestMap {
  addMembers: TelegramAddMembersRequest; kickMember: TelegramKickMemberRequest; banMember: TelegramBanMemberRequest; unbanMember: TelegramUnbanMemberRequest; muteMember: TelegramMuteMemberRequest; unmuteMember: TelegramUnmuteMemberRequest; purgeMember: TelegramPurgeMemberRequest
  promoteAdmin: TelegramPromoteAdminRequest; demoteAdmin: TelegramDemoteAdminRequest; setAdminRank: TelegramSetAdminRankRequest; transferOwnership: TelegramTransferOwnershipRequest
  setTitle: TelegramSetTitleRequest; setDescription: TelegramSetDescriptionRequest; setUsername: TelegramSetUsernameRequest; setPhoto: TelegramSetPhotoRequest; setSlowMode: TelegramSetSlowModeRequest; setTtl: TelegramSetTtlRequest; setContentProtection: TelegramSetContentProtectionRequest; setJoinRequests: TelegramSetJoinRequestsRequest; setJoinToSend: TelegramSetJoinToSendRequest; setDefaultPermissions: TelegramSetDefaultPermissionsRequest; setStickerSet: TelegramSetStickerSetRequest; leaveGroup: TelegramLeaveGroupRequest; deleteGroup: TelegramDeleteGroupRequest
  listInvites: TelegramListInvitesRequest; getInvite: TelegramGetInviteRequest; createInvite: TelegramCreateInviteRequest; editInvite: TelegramEditInviteRequest; revokeInvite: TelegramRevokeInviteRequest; listInviteMembers: TelegramListInviteMembersRequest; approveJoinRequest: TelegramApproveJoinRequestRequest; declineJoinRequest: TelegramDeclineJoinRequestRequest; approveAllJoinRequests: TelegramApproveAllJoinRequestsRequest; declineAllJoinRequests: TelegramDeclineAllJoinRequestsRequest
  listTopics: TelegramListTopicsRequest; createTopic: TelegramCreateTopicRequest; editTopic: TelegramEditTopicRequest; setTopicClosed: TelegramSetTopicClosedRequest; setTopicPinned: TelegramSetTopicPinnedRequest; reorderPinnedTopics: TelegramReorderPinnedTopicsRequest; deleteTopic: TelegramDeleteTopicRequest; setGeneralTopicHidden: TelegramSetGeneralTopicHiddenRequest
  pinMessage: TelegramPinMessageRequest; unpinMessage: TelegramUnpinMessageRequest; unpinAllMessages: TelegramUnpinAllMessagesRequest; deleteGroupMessages: TelegramDeleteGroupMessagesRequest
}

export interface GroupWriteOperationResultMap {
  addMembers: TelegramAddMembersResult; kickMember: TelegramKickMemberResult; banMember: TelegramBanMemberResult; unbanMember: TelegramUnbanMemberResult; muteMember: TelegramMuteMemberResult; unmuteMember: TelegramUnmuteMemberResult; purgeMember: TelegramPurgeMemberResult
  promoteAdmin: TelegramPromoteAdminResult; demoteAdmin: TelegramDemoteAdminResult; setAdminRank: TelegramSetAdminRankResult; transferOwnership: TelegramTransferOwnershipResult
  setTitle: TelegramSetTitleResult; setDescription: TelegramSetDescriptionResult; setUsername: TelegramSetUsernameResult; setPhoto: TelegramSetPhotoResult; setSlowMode: TelegramSetSlowModeResult; setTtl: TelegramSetTtlResult; setContentProtection: TelegramSetContentProtectionResult; setJoinRequests: TelegramSetJoinRequestsResult; setJoinToSend: TelegramSetJoinToSendResult; setDefaultPermissions: TelegramSetDefaultPermissionsResult; setStickerSet: TelegramSetStickerSetResult; leaveGroup: TelegramLeaveGroupResult; deleteGroup: TelegramDeleteGroupResult
  listInvites: TelegramListInvitesResult; getInvite: TelegramGetInviteResult; createInvite: TelegramCreateInviteResult; editInvite: TelegramEditInviteResult; revokeInvite: TelegramRevokeInviteResult; listInviteMembers: TelegramListInviteMembersResult; approveJoinRequest: TelegramApproveJoinRequestResult; declineJoinRequest: TelegramDeclineJoinRequestResult; approveAllJoinRequests: TelegramApproveAllJoinRequestsResult; declineAllJoinRequests: TelegramDeclineAllJoinRequestsResult
  listTopics: TelegramListTopicsResult; createTopic: TelegramCreateTopicResult; editTopic: TelegramEditTopicResult; setTopicClosed: TelegramSetTopicClosedResult; setTopicPinned: TelegramSetTopicPinnedResult; reorderPinnedTopics: TelegramReorderPinnedTopicsResult; deleteTopic: TelegramDeleteTopicResult; setGeneralTopicHidden: TelegramSetGeneralTopicHiddenResult
  pinMessage: TelegramPinMessageResult; unpinMessage: TelegramUnpinMessageResult; unpinAllMessages: TelegramUnpinAllMessagesResult; deleteGroupMessages: TelegramDeleteGroupMessagesResult
}

export type GroupWriteConfiguration = { [K in TelegramGroupWriteOperation]?: GroupWriteOperationResultMap[K] }

export interface TelegramGroupWriteAdapter {
  addMembers(r: TelegramAddMembersRequest): Promise<TelegramAddMembersResult>; kickMember(r: TelegramKickMemberRequest): Promise<TelegramKickMemberResult>; banMember(r: TelegramBanMemberRequest): Promise<TelegramBanMemberResult>; unbanMember(r: TelegramUnbanMemberRequest): Promise<TelegramUnbanMemberResult>; muteMember(r: TelegramMuteMemberRequest): Promise<TelegramMuteMemberResult>; unmuteMember(r: TelegramUnmuteMemberRequest): Promise<TelegramUnmuteMemberResult>; purgeMember(r: TelegramPurgeMemberRequest): Promise<TelegramPurgeMemberResult>
  promoteAdmin(r: TelegramPromoteAdminRequest): Promise<TelegramPromoteAdminResult>; demoteAdmin(r: TelegramDemoteAdminRequest): Promise<TelegramDemoteAdminResult>; setAdminRank(r: TelegramSetAdminRankRequest): Promise<TelegramSetAdminRankResult>; transferOwnership(r: TelegramTransferOwnershipRequest): Promise<TelegramTransferOwnershipResult>
  setTitle(r: TelegramSetTitleRequest): Promise<TelegramSetTitleResult>; setDescription(r: TelegramSetDescriptionRequest): Promise<TelegramSetDescriptionResult>; setUsername(r: TelegramSetUsernameRequest): Promise<TelegramSetUsernameResult>; setPhoto(r: TelegramSetPhotoRequest): Promise<TelegramSetPhotoResult>; setSlowMode(r: TelegramSetSlowModeRequest): Promise<TelegramSetSlowModeResult>; setTtl(r: TelegramSetTtlRequest): Promise<TelegramSetTtlResult>; setContentProtection(r: TelegramSetContentProtectionRequest): Promise<TelegramSetContentProtectionResult>; setJoinRequests(r: TelegramSetJoinRequestsRequest): Promise<TelegramSetJoinRequestsResult>; setJoinToSend(r: TelegramSetJoinToSendRequest): Promise<TelegramSetJoinToSendResult>; setDefaultPermissions(r: TelegramSetDefaultPermissionsRequest): Promise<TelegramSetDefaultPermissionsResult>; setStickerSet(r: TelegramSetStickerSetRequest): Promise<TelegramSetStickerSetResult>; leaveGroup(r: TelegramLeaveGroupRequest): Promise<TelegramLeaveGroupResult>; deleteGroup(r: TelegramDeleteGroupRequest): Promise<TelegramDeleteGroupResult>
  listInvites(r: TelegramListInvitesRequest): Promise<TelegramListInvitesResult>; getInvite(r: TelegramGetInviteRequest): Promise<TelegramGetInviteResult>; createInvite(r: TelegramCreateInviteRequest): Promise<TelegramCreateInviteResult>; editInvite(r: TelegramEditInviteRequest): Promise<TelegramEditInviteResult>; revokeInvite(r: TelegramRevokeInviteRequest): Promise<TelegramRevokeInviteResult>; listInviteMembers(r: TelegramListInviteMembersRequest): Promise<TelegramListInviteMembersResult>; approveJoinRequest(r: TelegramApproveJoinRequestRequest): Promise<TelegramApproveJoinRequestResult>; declineJoinRequest(r: TelegramDeclineJoinRequestRequest): Promise<TelegramDeclineJoinRequestResult>; approveAllJoinRequests(r: TelegramApproveAllJoinRequestsRequest): Promise<TelegramApproveAllJoinRequestsResult>; declineAllJoinRequests(r: TelegramDeclineAllJoinRequestsRequest): Promise<TelegramDeclineAllJoinRequestsResult>
  listTopics(r: TelegramListTopicsRequest): Promise<TelegramListTopicsResult>; createTopic(r: TelegramCreateTopicRequest): Promise<TelegramCreateTopicResult>; editTopic(r: TelegramEditTopicRequest): Promise<TelegramEditTopicResult>; setTopicClosed(r: TelegramSetTopicClosedRequest): Promise<TelegramSetTopicClosedResult>; setTopicPinned(r: TelegramSetTopicPinnedRequest): Promise<TelegramSetTopicPinnedResult>; reorderPinnedTopics(r: TelegramReorderPinnedTopicsRequest): Promise<TelegramReorderPinnedTopicsResult>; deleteTopic(r: TelegramDeleteTopicRequest): Promise<TelegramDeleteTopicResult>; setGeneralTopicHidden(r: TelegramSetGeneralTopicHiddenRequest): Promise<TelegramSetGeneralTopicHiddenResult>
  pinMessage(r: TelegramPinMessageRequest): Promise<TelegramPinMessageResult>; unpinMessage(r: TelegramUnpinMessageRequest): Promise<TelegramUnpinMessageResult>; unpinAllMessages(r: TelegramUnpinAllMessagesRequest): Promise<TelegramUnpinAllMessagesResult>; deleteGroupMessages(r: TelegramDeleteGroupMessagesRequest): Promise<TelegramDeleteGroupMessagesResult>
}
