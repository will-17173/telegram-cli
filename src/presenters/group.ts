import type { HumanOutput } from '../commands/types.js'
import type {
  TelegramGroupAdminRights,
  TelegramGroupAuditActor,
  TelegramGroupAuditPage,
  TelegramGroupDetails,
  TelegramGroupMemberPage,
  TelegramGroupMemberResult,
  TelegramGroupRestrictions,
} from '../telegram/group-types.js'
import type { TelegramManagedChat } from '../telegram/dialog-types.js'
import type { GroupWriteServiceResult } from '../services/group-write-service.js'
import type { TelegramGroupInviteMemberPage, TelegramGroupInvitePage, TelegramGroupInviteResult, TelegramGroupTopicPage, TelegramGroupTopicResult, TelegramGroupWriteResult } from '../telegram/group-write-types.js'

type DetailOutput = HumanOutput & { kind: 'detail' }
type TableOutput = HumanOutput & { kind: 'table' }

export function groupWriteHuman(data: GroupWriteServiceResult, chat: string | number, summary: string): HumanOutput {
  if ('invites' in data) return inviteTable(data)
  if ('members' in data && 'link' in data) return inviteMembersTable(data)
  if ('topics' in data) return topicTable(data)
  if ('invite' in data) return inviteDetail(data)
  if ('topic' in data) return topicDetail(data)
  const result = data as TelegramGroupWriteResult
  return { kind: 'summary', title: summary, fields: [
    { label: 'Chat', value: String(result.chat_id ?? chat) },
    { label: 'Operation', value: result.operation },
    { label: 'Target', value: result.target_id == null ? '-' : String(result.target_id) },
    { label: 'Effective', value: result.effective_until ?? '-' },
  ] }
}

function inviteTable(page: TelegramGroupInvitePage): TableOutput { return { kind: 'table', title: 'Group Invites', columns: ['LINK', 'TITLE', 'USES', 'EXPIRES', 'REQUEST'], rows: page.invites.map(i => [i.link, fallback(i.title), `${i.usage_count}/${i.usage_limit ?? '-'}`, fallback(i.expires_at), boolean(i.request_needed)]), emptyText: 'No invite links.' } }
function inviteMembersTable(page: TelegramGroupInviteMemberPage): TableOutput { return { kind: 'table', title: 'Invite Members', columns: ['ID', 'NAME', 'USERNAME', 'JOINED', 'REQUESTED'], rows: page.members.map(m => [String(m.user_id), m.display_name, username(m.username), fallback(m.joined_at), boolean(m.requested)]), emptyText: 'No invite members.' } }
function topicTable(page: TelegramGroupTopicPage): TableOutput { return { kind: 'table', title: 'Group Topics', columns: ['ID', 'TITLE', 'CLOSED', 'PINNED', 'HIDDEN'], rows: page.topics.map(t => [String(t.id), t.title, boolean(t.closed), boolean(t.pinned), boolean(t.hidden)]), emptyText: 'No forum topics.' } }
function inviteDetail(result: TelegramGroupInviteResult): DetailOutput { return { kind: 'detail', title: 'Group Invite', fields: [{ label: 'Chat ID', value: String(result.chat_id) }, { label: 'Link', value: result.invite.link }, { label: 'Title', value: fallback(result.invite.title) }, { label: 'Uses', value: `${result.invite.usage_count}/${result.invite.usage_limit ?? '-'}` }] } }
function topicDetail(result: TelegramGroupTopicResult): DetailOutput { return { kind: 'detail', title: 'Group Topic', fields: [{ label: 'Chat ID', value: String(result.chat_id) }, { label: 'ID', value: String(result.topic.id) }, { label: 'Title', value: result.topic.title }] } }

export function groupInfoDetail(group: TelegramGroupDetails): DetailOutput {
  return {
    kind: 'detail',
    title: 'Group Info',
    fields: [
      { label: 'ID', value: String(group.id) },
      { label: 'Title', value: fallback(group.title) },
      { label: 'Username', value: username(group.username) },
      { label: 'Type', value: group.type },
      { label: 'Members', value: optionalNumber(group.member_count) },
      { label: 'Your status', value: fallback(group.current_user_role) },
      { label: 'Your rank', value: fallback(group.current_user_rank) },
      { label: 'Admin rights', value: summarizeFlags(group.permissions) },
      { label: 'Default restrictions', value: summarizeFlags(group.default_restrictions) },
      { label: 'Slow mode', value: seconds(group.slow_mode_seconds) },
      { label: 'Message TTL', value: seconds(group.message_ttl_seconds) },
      { label: 'Content protected', value: boolean(group.content_protected) },
      { label: 'Forum', value: boolean(group.forum) },
    ],
  }
}

export function groupMembersTable(page: TelegramGroupMemberPage): TableOutput {
  return {
    kind: 'table',
    title: 'Group Members',
    columns: ['ID', 'NAME', 'USERNAME', 'STATUS', 'RANK', 'UNTIL'],
    rows: page.members.map((member) => [
      String(member.id),
      fallback(member.display_name),
      username(member.username),
      member.status,
      fallback(member.rank),
      fallback(member.restricted_until),
    ]),
    emptyText: 'No matching group members.',
  }
}

export function groupMemberDetail(result: TelegramGroupMemberResult): DetailOutput {
  const member = result.member
  return {
    kind: 'detail',
    title: 'Group Member',
    fields: [
      { label: 'Chat ID', value: String(result.chat_id) },
      { label: 'ID', value: String(member.id) },
      { label: 'Name', value: fallback(member.display_name) },
      { label: 'Username', value: username(member.username) },
      { label: 'Status', value: member.status },
      { label: 'Rank', value: fallback(member.rank) },
      { label: 'Joined', value: fallback(member.joined_at) },
      { label: 'Until', value: fallback(member.restricted_until) },
      { label: 'Admin rights', value: summarizeFlags(member.admin_rights) },
      { label: 'Restrictions', value: summarizeFlags(member.restrictions) },
    ],
  }
}

export function groupAuditTable(page: TelegramGroupAuditPage): TableOutput {
  return {
    kind: 'table',
    title: 'Group Audit Log',
    columns: ['DATE', 'TYPE', 'ACTOR', 'TARGET', 'SUMMARY'],
    rows: page.events.map((event) => [
      event.date,
      event.type,
      actor(event.actor),
      actor(event.target),
      fallback(event.summary),
    ]),
    emptyText: 'No matching audit events.',
  }
}

export function managedGroupTable(groups: TelegramManagedChat[]): TableOutput {
  return {
    kind: 'table',
    title: 'Managed Groups',
    columns: ['ID', 'NAME', 'TYPE', 'USERNAME', 'ADMIN', 'CREATOR'],
    rows: groups.map((group) => [
      String(group.id),
      group.name,
      group.type,
      group.username == null ? '-' : username(group.username),
      boolean(group.is_admin),
      boolean(group.is_creator),
    ]),
    emptyText: 'No managed groups.',
  }
}

function summarizeFlags(flags: TelegramGroupAdminRights | TelegramGroupRestrictions | null): string {
  if (flags == null) return '-'
  const enabled = Object.entries(flags)
    .filter(([, value]) => value)
    .map(([name]) => name.replaceAll('_', ' '))
  return enabled.length === 0 ? 'None' : enabled.join(', ')
}

function actor(value: TelegramGroupAuditActor | null): string {
  if (value == null) return '-'
  return value.username ? username(value.username) : fallback(value.display_name)
}

function username(value: string | null): string {
  if (!value) return '-'
  return value.startsWith('@') ? value : `@${value}`
}

function fallback(value: string | null): string {
  return value == null || value === '' ? '-' : value
}

function optionalNumber(value: number | null): string {
  return value == null ? '-' : String(value)
}

function seconds(value: number | null): string {
  if (value == null) return '-'
  if (value === 0) return 'Off'
  return `${value} ${value === 1 ? 'second' : 'seconds'}`
}

function boolean(value: boolean): string {
  return value ? 'Yes' : 'No'
}
