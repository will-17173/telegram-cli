import type {
  TelegramGroupAdminRights,
  TelegramGroupAuditActor,
  TelegramGroupAuditEvent,
  TelegramGroupAuditPage,
  TelegramGroupDetails,
  TelegramGroupManagementAdapter,
  TelegramGroupMemberDetails,
  TelegramGroupMemberFilter,
  TelegramGroupMemberPage,
  TelegramGroupMemberResult,
  TelegramGroupMemberSummary,
  TelegramGroupRestrictions,
  TelegramListGroupAuditEventsRequest,
  TelegramListGroupMembersRequest,
} from './group-types.js'
import type * as W from './group-write-types.js'

export {
  TelegramGroupAdminRequiredError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
} from './group-types.js'
import {
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
} from './group-types.js'

export type FakeTelegramGroupManagementOptions = {
  group?: TelegramGroupDetails
  members?: TelegramGroupMemberDetails[]
  membersByFilter?: Partial<Record<TelegramGroupMemberFilter, TelegramGroupMemberSummary[]>>
  auditEvents?: TelegramGroupAuditEvent[]
  getGroupFailure?: Error
  listMembersFailure?: Error
  getMemberFailure?: Error
  listAuditEventsFailure?: Error
  writeResults?: { [K in W.TelegramGroupWriteOperation]?: W.GroupWriteOperationResultMap[K] }
  writeFailures?: Partial<Record<W.TelegramGroupWriteOperation, Error>>
}

export type FakeGroupWriteResult = W.GroupWriteOperationResultMap[W.TelegramGroupWriteOperation]
export type FakeGroupWriteCall = { [K in W.TelegramGroupWriteOperation]: { readonly operation: K; readonly request: W.GroupWriteOperationRequestMap[K] } }[W.TelegramGroupWriteOperation]

export class FakeTelegramGroupManagement implements TelegramGroupManagementAdapter {
  readonly getGroupCalls: Array<string | number> = []
  readonly listMembersCalls: TelegramListGroupMembersRequest[] = []
  readonly getMemberCalls: Array<{ chat: string | number; user: string | number }> = []
  readonly listAuditEventsCalls: TelegramListGroupAuditEventsRequest[] = []
  readonly writeCalls: FakeGroupWriteCall[] = []

  private readonly group: TelegramGroupDetails
  private readonly members: TelegramGroupMemberDetails[]
  private readonly membersByFilter: Partial<Record<TelegramGroupMemberFilter, TelegramGroupMemberSummary[]>>
  private readonly auditEvents: TelegramGroupAuditEvent[]
  private readonly getGroupFailure?: Error
  private readonly listMembersFailure?: Error
  private readonly getMemberFailure?: Error
  private readonly listAuditEventsFailure?: Error
  private readonly writeResults: { [K in W.TelegramGroupWriteOperation]?: W.GroupWriteOperationResultMap[K] }
  private readonly writeFailures: Partial<Record<W.TelegramGroupWriteOperation, Error>>

  constructor(options: FakeTelegramGroupManagementOptions = {}) {
    this.membersByFilter = cloneMembersByFilter(options.membersByFilter ?? {})
    this.members = mergeMemberDetails(
      (options.members ?? defaultMembers()).map(cloneMember),
      this.membersByFilter,
    )
    this.group = cloneGroup(options.group ?? {
      ...defaultGroup(),
      member_count: this.members.length,
    })
    this.auditEvents = (options.auditEvents ?? defaultAuditEvents()).map(cloneAuditEvent)
    this.getGroupFailure = options.getGroupFailure
    this.listMembersFailure = options.listMembersFailure
    this.getMemberFailure = options.getMemberFailure
    this.listAuditEventsFailure = options.listAuditEventsFailure
    this.writeResults = cloneSerializable(options.writeResults ?? {})
    this.writeFailures = { ...options.writeFailures }
  }

  async getGroup(chat: string | number): Promise<TelegramGroupDetails> {
    this.getGroupCalls.push(chat)
    if (this.getGroupFailure) throw this.getGroupFailure
    this.assertGroup(chat)
    return cloneGroup(this.group)
  }

  async listMembers(request: TelegramListGroupMembersRequest): Promise<TelegramGroupMemberPage> {
    this.listMembersCalls.push({ ...request })
    if (this.listMembersFailure) throw this.listMembersFailure
    this.assertGroup(request.chat)

    const configuredMembers = this.membersByFilter[request.type]
    const candidates = configuredMembers == null
      ? defaultMembersForFilter(this.members, request.type)
      : configuredMembers
    const query = request.query?.toLocaleLowerCase() ?? null
    const matching = candidates.filter((member) => {
      const queryMatches = query == null
        || member.display_name.toLocaleLowerCase().includes(query)
        || member.username?.toLocaleLowerCase().includes(query) === true
      return queryMatches
    })
    const members = matching.slice(0, request.limit).map(cloneMemberSummary)
    return {
      chat_id: this.group.id,
      chat_title: this.group.title,
      filter: request.type,
      query: request.query ?? null,
      limit: request.limit,
      total: matching.length,
      members,
    }
  }

  async getMember(chat: string | number, user: string | number): Promise<TelegramGroupMemberResult> {
    this.getMemberCalls.push({ chat, user })
    if (this.getMemberFailure) throw this.getMemberFailure
    this.assertGroup(chat)
    const member = this.members.find((candidate) => peerMatches(
      user,
      candidate.id,
      [candidate.username, candidate.display_name],
    ))
    if (!member) throw new TelegramGroupMemberNotFoundError(chat, user)
    return { chat_id: this.group.id, member: cloneMember(member) }
  }

  async listAuditEvents(request: TelegramListGroupAuditEventsRequest): Promise<TelegramGroupAuditPage> {
    this.listAuditEventsCalls.push({
      ...request,
      users: request.users == null ? undefined : [...request.users],
      types: request.types == null ? undefined : [...request.types],
    })
    if (this.listAuditEventsFailure) throw this.listAuditEventsFailure
    this.assertGroup(request.chat)

    const query = request.query?.toLocaleLowerCase()
    const events = this.auditEvents.filter((event) => {
      const matchesQuery = query == null || event.summary.toLocaleLowerCase().includes(query)
      const matchesType = request.types == null || request.types.includes(event.type)
      const matchesUser = request.users == null || request.users.some((user) => actorMatches(event.actor, user))
      return matchesQuery && matchesType && matchesUser
    }).slice(0, request.limit).map(cloneAuditEvent)
    return { chat_id: this.group.id, chat_title: this.group.title, events }
  }

  addMembers = (r: W.TelegramAddMembersRequest) => this.write('addMembers', r)
  kickMember = (r: W.TelegramKickMemberRequest) => this.write('kickMember', r)
  banMember = (r: W.TelegramBanMemberRequest) => this.write('banMember', r)
  unbanMember = (r: W.TelegramUnbanMemberRequest) => this.write('unbanMember', r)
  muteMember = (r: W.TelegramMuteMemberRequest) => this.write('muteMember', r)
  unmuteMember = (r: W.TelegramUnmuteMemberRequest) => this.write('unmuteMember', r)
  purgeMember = (r: W.TelegramPurgeMemberRequest) => this.write('purgeMember', r)
  promoteAdmin = (r: W.TelegramPromoteAdminRequest) => this.write('promoteAdmin', r)
  demoteAdmin = (r: W.TelegramDemoteAdminRequest) => this.write('demoteAdmin', r)
  setAdminRank = (r: W.TelegramSetAdminRankRequest) => this.write('setAdminRank', r)
  transferOwnership = (r: W.TelegramTransferOwnershipRequest) => this.write('transferOwnership', r)
  setTitle = (r: W.TelegramSetTitleRequest) => this.write('setTitle', r)
  setDescription = (r: W.TelegramSetDescriptionRequest) => this.write('setDescription', r)
  setUsername = (r: W.TelegramSetUsernameRequest) => this.write('setUsername', r)
  setPhoto = (r: W.TelegramSetPhotoRequest) => this.write('setPhoto', r)
  setSlowMode = (r: W.TelegramSetSlowModeRequest) => this.write('setSlowMode', r)
  setTtl = (r: W.TelegramSetTtlRequest) => this.write('setTtl', r)
  setContentProtection = (r: W.TelegramSetContentProtectionRequest) => this.write('setContentProtection', r)
  setJoinRequests = (r: W.TelegramSetJoinRequestsRequest) => this.write('setJoinRequests', r)
  setJoinToSend = (r: W.TelegramSetJoinToSendRequest) => this.write('setJoinToSend', r)
  setDefaultPermissions = (r: W.TelegramSetDefaultPermissionsRequest) => this.write('setDefaultPermissions', r)
  setStickerSet = (r: W.TelegramSetStickerSetRequest) => this.write('setStickerSet', r)
  leaveGroup = (r: W.TelegramLeaveGroupRequest) => this.write('leaveGroup', r)
  deleteGroup = (r: W.TelegramDeleteGroupRequest) => this.write('deleteGroup', r)
  listInvites = (r: W.TelegramListInvitesRequest) => this.invitePage('listInvites', r)
  getInvite = (r: W.TelegramGetInviteRequest) => this.inviteResult('getInvite', r)
  createInvite = (r: W.TelegramCreateInviteRequest) => this.inviteResult('createInvite', r)
  editInvite = (r: W.TelegramEditInviteRequest) => this.inviteResult('editInvite', r)
  revokeInvite = (r: W.TelegramRevokeInviteRequest) => this.inviteResult('revokeInvite', r)
  listInviteMembers = (r: W.TelegramListInviteMembersRequest) => this.inviteMemberPage('listInviteMembers', r)
  approveJoinRequest = (r: W.TelegramApproveJoinRequestRequest) => this.write('approveJoinRequest', r)
  declineJoinRequest = (r: W.TelegramDeclineJoinRequestRequest) => this.write('declineJoinRequest', r)
  approveAllJoinRequests = (r: W.TelegramApproveAllJoinRequestsRequest) => this.write('approveAllJoinRequests', r)
  declineAllJoinRequests = (r: W.TelegramDeclineAllJoinRequestsRequest) => this.write('declineAllJoinRequests', r)
  listTopics = (r: W.TelegramListTopicsRequest) => this.topicPage('listTopics', r)
  createTopic = (r: W.TelegramCreateTopicRequest) => this.topicResult('createTopic', r)
  editTopic = (r: W.TelegramEditTopicRequest) => this.topicResult('editTopic', r)
  setTopicClosed = (r: W.TelegramSetTopicClosedRequest) => this.write('setTopicClosed', r)
  setTopicPinned = (r: W.TelegramSetTopicPinnedRequest) => this.write('setTopicPinned', r)
  reorderPinnedTopics = (r: W.TelegramReorderPinnedTopicsRequest) => this.write('reorderPinnedTopics', r)
  deleteTopic = (r: W.TelegramDeleteTopicRequest) => this.write('deleteTopic', r)
  setGeneralTopicHidden = (r: W.TelegramSetGeneralTopicHiddenRequest) => this.write('setGeneralTopicHidden', r)
  pinMessage = (r: W.TelegramPinMessageRequest) => this.write('pinMessage', r)
  unpinMessage = (r: W.TelegramUnpinMessageRequest) => this.write('unpinMessage', r)
  unpinAllMessages = (r: W.TelegramUnpinAllMessagesRequest) => this.write('unpinAllMessages', r)
  deleteGroupMessages = (r: W.TelegramDeleteGroupMessagesRequest) => this.write('deleteGroupMessages', r)

  private async write(operation: W.TelegramGroupWriteOperation, request: W.GroupWriteOperationRequestMap[W.TelegramGroupWriteOperation]): Promise<W.TelegramGroupWriteResult> {
    this.recordWrite(operation, request)
    this.throwWriteFailure(operation)
    const configured = this.writeResults[operation]
    if (configured != null) return cloneSerializable(configured) as W.TelegramGroupWriteResult
    const source = request as { chat: W.GroupPeer; user?: W.GroupUser; topicId?: number; messageId?: number }
    return { operation, chat_id: numericPeer(source.chat), target_id: source.user ?? source.topicId ?? source.messageId }
  }

  private async invitePage(operation: W.TelegramGroupWriteOperation, request: W.TelegramListInvitesRequest): Promise<W.TelegramGroupInvitePage> {
    this.recordWrite(operation, request); this.throwWriteFailure(operation)
    return cloneSerializable(this.writeResults[operation] ?? { chat_id: numericPeer(request.chat), invites: [], total: 0 }) as W.TelegramGroupInvitePage
  }

  private async inviteResult(operation: 'getInvite' | 'createInvite' | 'editInvite' | 'revokeInvite', request: W.TelegramGetInviteRequest | W.TelegramCreateInviteRequest | W.TelegramEditInviteRequest | W.TelegramRevokeInviteRequest): Promise<W.TelegramGroupInviteResult> {
    this.recordWrite(operation, request); this.throwWriteFailure(operation)
    const r = request as { chat: W.GroupPeer; link?: string; options?: W.TelegramInviteOptions }
    return cloneSerializable(this.writeResults[operation] ?? { chat_id: numericPeer(r.chat), invite: defaultInvite(r.link, r.options) }) as W.TelegramGroupInviteResult
  }

  private async inviteMemberPage(operation: W.TelegramGroupWriteOperation, request: W.TelegramListInviteMembersRequest): Promise<W.TelegramGroupInviteMemberPage> {
    this.recordWrite(operation, request); this.throwWriteFailure(operation)
    return cloneSerializable(this.writeResults[operation] ?? { chat_id: numericPeer(request.chat), link: request.link, members: [], total: 0 }) as W.TelegramGroupInviteMemberPage
  }

  private async topicPage(operation: W.TelegramGroupWriteOperation, request: W.TelegramListTopicsRequest): Promise<W.TelegramGroupTopicPage> {
    this.recordWrite(operation, request); this.throwWriteFailure(operation)
    return cloneSerializable(this.writeResults[operation] ?? { chat_id: numericPeer(request.chat), topics: [], total: 0 }) as W.TelegramGroupTopicPage
  }

  private async topicResult(operation: 'createTopic' | 'editTopic', request: W.TelegramCreateTopicRequest | W.TelegramEditTopicRequest): Promise<W.TelegramGroupTopicResult> {
    this.recordWrite(operation, request); this.throwWriteFailure(operation)
    const r = request as { chat: W.GroupPeer; topicId?: number; title?: string }
    return cloneSerializable(this.writeResults[operation] ?? { chat_id: numericPeer(r.chat), topic: { id: r.topicId ?? 1, title: r.title ?? 'Topic', icon_color: null, icon_emoji_id: null, closed: false, pinned: false, hidden: false } }) as W.TelegramGroupTopicResult
  }

  private recordWrite<K extends W.TelegramGroupWriteOperation>(operation: K, request: W.GroupWriteOperationRequestMap[K]): void {
    this.writeCalls.push({ operation, request: cloneSerializable(request) } as FakeGroupWriteCall)
  }

  private throwWriteFailure(operation: W.TelegramGroupWriteOperation): void {
    const failure = this.writeFailures[operation]
    if (failure) throw failure
  }

  private assertGroup(chat: string | number): void {
    if (!peerMatches(chat, this.group.id, [this.group.title, this.group.username])) {
      throw new TelegramGroupNotFoundError(chat)
    }
  }
}

function matchesMemberFilter(
  member: TelegramGroupMemberDetails,
  filter: TelegramListGroupMembersRequest['type'],
): boolean {
  if (filter === 'admins') return member.status === 'creator' || member.status === 'admin'
  if (filter === 'banned') return member.status === 'banned'
  if (filter === 'restricted') return member.status === 'restricted'
  return true
}

function defaultMembersForFilter(
  members: TelegramGroupMemberDetails[],
  filter: TelegramGroupMemberFilter,
): TelegramGroupMemberSummary[] {
  if (filter === 'bots' || filter === 'contacts') return []
  return members.filter((member) => matchesMemberFilter(member, filter)).map(toSummary)
}

function cloneMembersByFilter(
  membersByFilter: Partial<Record<TelegramGroupMemberFilter, TelegramGroupMemberSummary[]>>,
): Partial<Record<TelegramGroupMemberFilter, TelegramGroupMemberSummary[]>> {
  const cloned: Partial<Record<TelegramGroupMemberFilter, TelegramGroupMemberSummary[]>> = {}
  for (const filter of Object.keys(membersByFilter) as TelegramGroupMemberFilter[]) {
    cloned[filter] = membersByFilter[filter]?.map(cloneMemberSummary)
  }
  return cloned
}

function mergeMemberDetails(
  explicitMembers: TelegramGroupMemberDetails[],
  membersByFilter: Partial<Record<TelegramGroupMemberFilter, TelegramGroupMemberSummary[]>>,
): TelegramGroupMemberDetails[] {
  const merged = explicitMembers.map(cloneMember)
  const memberIds = new Set(merged.map((member) => member.id))
  for (const members of Object.values(membersByFilter)) {
    for (const member of members ?? []) {
      if (memberIds.has(member.id)) continue
      merged.push({
        ...cloneMemberSummary(member),
        admin_rights: null,
        restrictions: null,
      })
      memberIds.add(member.id)
    }
  }
  return merged
}

function defaultGroup(): TelegramGroupDetails {
  return {
    id: 100,
    title: 'TestGroup',
    username: 'testgroup',
    type: 'supergroup',
    member_count: 4,
    current_user_role: 'admin',
    current_user_rank: 'Moderator',
    permissions: adminRights(),
    default_restrictions: restrictions(),
    slow_mode_seconds: null,
    message_ttl_seconds: null,
    content_protected: false,
    forum: false,
  }
}

function defaultMembers(): TelegramGroupMemberDetails[] {
  return [
    member(1, 'Alice Admin', 'alice', 'creator', 'Owner', adminRights()),
    member(2, 'Test User', 'test', 'admin', 'Moderator', adminRights()),
    member(3, 'Bob Member', 'bob', 'member', null, null),
    {
      ...member(4, 'Restricted User', null, 'restricted', null, null),
      restricted_until: '2026-12-31T23:59:59.000Z',
      restrictions: restrictions({ send_messages: true }),
    },
  ]
}

function defaultAuditEvents(): TelegramGroupAuditEvent[] {
  return [{
    id: 'audit-1',
    date: '2026-03-09T10:00:00.000Z',
    type: 'info_changed',
    actor: { id: 1, display_name: 'Alice Admin', username: 'alice' },
    target: null,
    summary: 'Alice Admin changed the group title to TestGroup',
  }]
}

function member(
  id: number,
  displayName: string,
  username: string | null,
  status: TelegramGroupMemberDetails['status'],
  rank: string | null,
  rights: TelegramGroupAdminRights | null,
): TelegramGroupMemberDetails {
  return {
    id,
    display_name: displayName,
    username,
    status,
    rank,
    joined_at: '2026-03-01T10:00:00.000Z',
    restricted_until: null,
    admin_rights: rights,
    restrictions: null,
  }
}

function adminRights(): TelegramGroupAdminRights {
  return {
    change_info: true,
    delete_messages: true,
    ban_users: true,
    invite_users: true,
    pin_messages: true,
    add_admins: false,
    manage_call: true,
    anonymous: false,
    manage_topics: true,
  }
}

function restrictions(overrides: Partial<TelegramGroupRestrictions> = {}): TelegramGroupRestrictions {
  return {
    view_messages: false,
    send_messages: false,
    send_media: false,
    send_stickers: false,
    send_gifs: false,
    send_games: false,
    send_inline: false,
    embed_links: false,
    send_polls: false,
    change_info: false,
    invite_users: false,
    pin_messages: false,
    manage_topics: false,
    ...overrides,
  }
}

function actorMatches(actor: TelegramGroupAuditActor | null, user: string | number): boolean {
  if (actor == null) return false
  return peerMatches(user, actor.id, [actor.username, actor.display_name])
}

function peerMatches(
  reference: string | number,
  numericId: number,
  names: Array<string | null>,
): boolean {
  const canonical = canonicalPeerReference(reference)
  return canonical.numeric_id === numericId
    || names.some((name) => name?.toLocaleLowerCase() === canonical.text)
}

function canonicalPeerReference(reference: string | number): { numeric_id: number | null; text: string } {
  const text = String(reference).trim().replace(/^@/, '').toLocaleLowerCase()
  const numeric = /^[-+]?\d+$/.test(text) ? Number(text) : Number.NaN
  return {
    numeric_id: Number.isSafeInteger(numeric) ? numeric : null,
    text,
  }
}

function numericPeer(peer: W.GroupPeer): number {
  return typeof peer === 'number' ? peer : 100
}

function defaultInvite(link?: string, options?: W.TelegramInviteOptions): W.TelegramGroupInviteRecord {
  return {
    link: link ?? 'https://t.me/+fake-invite',
    title: options?.title ?? null,
    creator_id: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    usage_limit: options?.usageLimit ?? null,
    usage_count: 0,
    request_needed: options?.requestNeeded ?? false,
    revoked: false,
  }
}

function cloneSerializable<T>(value: T): T {
  return structuredClone(value)
}

function cloneGroup(group: TelegramGroupDetails): TelegramGroupDetails {
  return {
    ...group,
    permissions: group.permissions == null ? null : { ...group.permissions },
    default_restrictions: group.default_restrictions == null ? null : { ...group.default_restrictions },
  }
}

function toSummary(memberDetails: TelegramGroupMemberDetails): TelegramGroupMemberSummary {
  const { admin_rights: _adminRights, restrictions: _restrictions, ...member } = memberDetails
  return cloneMemberSummary(member)
}

function cloneMemberSummary(member: TelegramGroupMemberSummary): TelegramGroupMemberSummary {
  return { ...member }
}

function cloneMember(memberDetails: TelegramGroupMemberDetails): TelegramGroupMemberDetails {
  return {
    ...memberDetails,
    admin_rights: memberDetails.admin_rights == null ? null : { ...memberDetails.admin_rights },
    restrictions: memberDetails.restrictions == null ? null : { ...memberDetails.restrictions },
  }
}

function cloneAuditEvent(event: TelegramGroupAuditEvent): TelegramGroupAuditEvent {
  return {
    ...event,
    actor: event.actor == null ? null : { ...event.actor },
    target: event.target == null ? null : { ...event.target },
  }
}
