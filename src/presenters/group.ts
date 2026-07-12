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

type DetailOutput = HumanOutput & { kind: 'detail' }
type TableOutput = HumanOutput & { kind: 'table' }

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
