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
}

export class FakeTelegramGroupManagement implements TelegramGroupManagementAdapter {
  readonly getGroupCalls: Array<string | number> = []
  readonly listMembersCalls: TelegramListGroupMembersRequest[] = []
  readonly getMemberCalls: Array<{ chat: string | number; user: string | number }> = []
  readonly listAuditEventsCalls: TelegramListGroupAuditEventsRequest[] = []

  private readonly group: TelegramGroupDetails
  private readonly members: TelegramGroupMemberDetails[]
  private readonly membersByFilter: Partial<Record<TelegramGroupMemberFilter, TelegramGroupMemberSummary[]>>
  private readonly auditEvents: TelegramGroupAuditEvent[]
  private readonly getGroupFailure?: Error
  private readonly listMembersFailure?: Error
  private readonly getMemberFailure?: Error
  private readonly listAuditEventsFailure?: Error

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
