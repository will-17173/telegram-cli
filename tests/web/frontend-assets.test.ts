import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  displayChatId,
  guardActivityStatusClass,
  guardGroupStatusClass,
  guardGroupStatusLabel,
  guardOnlyMode,
  guardRuleActionFromDraft,
  guardRuleConditionFromDraft,
  guardRuleRequestFromDraft,
  nextGuardGroupId,
  paginationWindow,
  senderAvatar,
  senderBlacklistKey,
  visibleMessagesForBlacklist,
} from '../../web/src/App.js'
import type { GuardGroup } from '../../web/src/api.js'
import {
  DEFAULT_LOCALE,
  formatDateForLocale,
  formatMessage,
  messages,
  normalizeLocale,
  resolveInitialLocale,
  setUrlLocale,
  SUPPORTED_LOCALES,
} from '../../web/src/i18n.js'

describe('web frontend source', () => {
  it('defines supported web UI locales with matching dictionary shape', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(SUPPORTED_LOCALES).toEqual(['en', 'zh-CN'])
    expect(Object.keys(messages)).toEqual(['en', 'zh-CN'])
    expect(Object.keys(messages['zh-CN'])).toEqual(Object.keys(messages.en))
    expect(messages.en.shell.language).toBe('Language')
    expect(messages['zh-CN'].shell.language).toBe('语言')
    expect(messages.en.guard.groupAutomation).toBe('Group automation')
    expect(messages['zh-CN'].guard.groupAutomation).toBe('群组自动化')
  })

  it('normalizes supported web UI locales', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('zh')).toBe('zh-CN')
    expect(normalizeLocale('zh-cn')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans')).toBe('zh-CN')
    expect(normalizeLocale('fr')).toBeNull()
    expect(normalizeLocale(null)).toBeNull()
  })

  it('resolves the initial web UI locale by URL, storage, navigator, then fallback', () => {
    expect(resolveInitialLocale({ search: '?lang=zh-CN', storedLocale: 'en', navigatorLanguages: ['en-US'] })).toBe('zh-CN')
    expect(resolveInitialLocale({ search: '?lang=fr', storedLocale: 'zh-CN', navigatorLanguages: ['en-US'] })).toBe('zh-CN')
    expect(resolveInitialLocale({ search: '', storedLocale: 'fr', navigatorLanguages: ['zh-Hans', 'en-US'] })).toBe('zh-CN')
    expect(resolveInitialLocale({ search: '', storedLocale: null, navigatorLanguages: ['fr-FR'] })).toBe('en')
  })

  it('formats localized messages and dates', () => {
    expect(formatMessage('{visible} of {total} shown', { visible: 2, total: 5 })).toBe('2 of 5 shown')
    expect(formatMessage('Hello {name}', { name: 'Alice' })).toBe('Hello Alice')
    expect(formatDateForLocale('2026-07-21T10:30:00.000Z', 'en')).toContain('2026')
    expect(formatDateForLocale('not-a-date', 'zh-CN')).toBe('not-a-date')
  })

  it('updates URL locale while preserving existing query parameters', () => {
    expect(setUrlLocale('http://127.0.0.1:8734/?guard=1', 'zh-CN')).toBe('http://127.0.0.1:8734/?guard=1&lang=zh-CN')
    expect(setUrlLocale('http://127.0.0.1:8734/?guard=1&lang=en', 'zh-CN')).toBe('http://127.0.0.1:8734/?guard=1&lang=zh-CN')
  })

  it('defines the management UI shell', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8')

    expect(app).toContain('Telegram CLI')
    expect(app).toContain('Sync current chat')
    expect(app).toContain('First')
    expect(app).toContain('Last')
    expect(app).toContain('Jump to')
    expect(app).toContain('Page size')
    expect(app).toContain('messagePageSize')
    expect(app).toContain('messagePageInput')
    expect(app).toContain('totalMessagePages')
    expect(app).toContain('Reset')
    expect(app).toContain('resetMessageFilters')
    expect(app).toContain('filterByMessageSender')
    expect(app).toContain('sender-filter-action')
    expect(app).toContain('Filter messages by this sender')
    expect(app).toContain('data-tooltip="Filter messages by this sender"')
    expect(app).toContain('sender-block-action')
    expect(app).toContain('Hide messages from this sender')
    expect(app).toContain('data-tooltip="Hide messages from this sender"')
    expect(app).toContain('manage-sender-blacklist')
    expect(app).toContain('Sender blacklist')
    expect(app).toContain('removeBlockedSender')
    expect(app).toContain('sender-avatar')
    expect(app).toContain('reply-snippet')
    expect(app).toContain('replyMessageIdLabel')
    expect(app).toContain('attachment-message-id')
    expect(app).toContain('Message {attachment.msg_id}')
    expect(app).toContain('messageIdLabels(message).map')
    expect(app).toContain('`Grouped ID ${message.grouped_id}`')
    expect(app).toContain('`Messages ${message.msg_ids.join')
    expect(app).toContain('syncErrorText')
    expect(app).toContain('Sync failed')
    expect(app).toContain('selected-chat-id')
    expect(app).toContain('Chat ID')
    expect(app).not.toContain('Reply to {replySenderLabel')
    expect(app).not.toContain('Message {message.reply_context.message_id}')
    expect(app).not.toContain('Send message')
    expect(app).not.toContain('Delete message')
  })

  it('constrains the chat sidebar to its own scroll area', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(css).toContain('height: calc(100vh - 68px);')
    expect(css).toContain('overflow: hidden;')
    expect(css).toContain('flex: 1 1 auto;')
    expect(css).toContain('overflow-y: auto;')
    expect(css).toContain('scrollbar-gutter: stable;')
  })

  it('keeps long chat names from overlapping sidebar metadata', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(css).toContain('grid-template-rows: minmax(0, auto) auto;')
    expect(css).toContain('-webkit-line-clamp: 2;')
    expect(css).toContain('min-height: 90px;')
    expect(css).toContain('line-height: 1.32;')
    expect(css).toContain('padding-bottom: 3px;')
    expect(css).toContain('text-overflow: ellipsis;')
  })

  it('keeps sender avatar initials legible', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(css).toContain('font-family: Inter, ui-sans-serif, system-ui')
    expect(css).toContain('font-weight: 700;')
    expect(css).toContain('letter-spacing: 0;')
  })

  it('shows tooltips for sender action icon buttons', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(css).toContain('[data-tooltip]::after')
    expect(css).toContain('[data-tooltip]:hover::after')
    expect(css).toContain('[data-tooltip]:focus-visible::after')
  })

  it('renders message and attachment download status labels', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8')
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(app).toContain('messageDownloadState')
    expect(app).toContain('attachmentDownloadState')
    expect(app).toContain('Downloaded')
    expect(app).toContain('Partially downloaded')
    expect(app).toContain('Not downloaded')
    expect(app).toContain('download-status-icon')
    expect(css).toContain('.download-status-icon')
    expect(css).toContain('.download-status-downloaded')
    expect(css).toContain('.download-status-partial')
    expect(css).toContain('.download-status-not-downloaded')
  })

  it('keeps guard workbench aligned with guard API payloads', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8')
    const api = readFileSync('web/src/api.ts', 'utf8')
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(app).toContain("getJson<{ runtime: GuardRuntimeState; groups: Page<GuardGroup> }>('/api/guard/status')")
    expect(app).toContain('ruleRequestId')
    expect(app).toContain('selectedGroupIdRef')
    expect(app).toContain('requestId === ruleRequestId.current')
    expect(app).toContain('setRules([])')
    expect(app).toContain('loadGuardRules(currentGroupId, requestId)')
    expect(app).toContain('const latestSelectedGroupId = selectedGroupIdRef.current')
    expect(app).toContain('nextGuardGroupId(statusData.groups.items, latestSelectedGroupId)')
    expect(app).toContain('currentGroupId === latestSelectedGroupId')
    expect(app).toContain('setSelectedGroupId(currentGroupId)')
    expect(app).toContain("postJson<Page<GuardGroup>>('/api/guard/groups/discover'")
    expect(app).toContain('Sync groups')
    expect(app).toContain('item.action_created_at')
    expect(app).toContain('<small>{displayChatId(group.chat_id)}</small>')
    expect(app).not.toContain('<small>{group.account} · {displayChatId(group.chat_id)}</small>')
    expect(app).toContain('Add rule')
    expect(app).toContain('patchJson<GuardRule>(`/api/guard/rules/${rule.id}`, { enabled: !rule.enabled })')
    expect(app).toContain('setRules((current) => current.map')
    expect(app).toContain('guard-rule-state guard-rule-state-on')
    expect(app).toContain('aria-pressed={rule.enabled}')
    expect(app).toContain('deleteJson<{ deleted: boolean }>(`/api/guard/rules/${rule.id}`)')
    expect(app).not.toContain('window.confirm')
    expect(app).toContain('guard-rule-delete')
    expect(app).toContain('guard-rule-modal')
    expect(app).toContain('aria-labelledby="guard-rule-modal-title"')
    expect(app).toContain('Close rule editor')
    expect(app).toContain('aria-pressed={ruleDraft.enabled}')
    expect(app).toContain('guard-rule-enabled-toggle')
    expect(app).toContain('guard-rule-toggle-track')
    expect(app).toContain('guard-rule-toggle-knob')
    expect(app).toContain('guardGroupStatusLabel(group)')
    expect(app).toContain('guardGroupStatusDetail(selectedGroup)')
    expect(app).toContain('Policy limits')
    expect(app).toContain('Delete allowed')
    expect(app).toContain('Delete blocked')
    expect(app).toContain('Admins skipped')
    expect(app).toContain('These limits only apply after an enabled rule matches.')
    expect(app).toContain('Rules are on. Restart tg guard start to begin listening.')
    expect(app).toContain('Cancel')
    expect(app).toContain("postJson<GuardRule>('/api/guard/rules'")
    expect(app).toContain('guardRuleRequestFromDraft(selectedGroupId, ruleDraft)')
    expect(app).toContain('const guardOnly = guardOnlyMode()')
    expect(app).toContain('{!guardOnly && <nav className="view-tabs"')
    expect(app).toContain('{!guardOnly && view === \'messages\' ?')
    expect(css).toContain('.guard-rule-form')
    expect(css).toContain('.guard-rule-modal')
    expect(css).toContain('.guard-rule-state')
    expect(css).toContain('.guard-rule-state-on')
    expect(css).toContain('.guard-rule-delete')
    expect(css).toContain('.policy-strip-label')
    expect(css).toContain('.guard-policy-strip small')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) auto auto;')
    expect(css).toContain('.guard-rule-enabled-toggle-on')
    expect(css).toContain('.guard-rule-enabled-toggle-on .guard-rule-toggle-knob')
    expect(css).toContain('.guard-status-pending')
    expect(css).toContain('.guard-policy-note')
    expect(css).toContain('grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);')
    expect(css).toContain('.guard-arm-toggle-on strong')
    expect(css).toContain('background: #fff7f6;')
    expect(css).toContain('background: #eefbf7;')
    expect(css).toContain('box-shadow: inset 4px 0 0 var(--danger);')
    expect(api).toContain('action_created_at: string')
    expect(api).toContain('event_created_at: string')
    expect(api).not.toMatch(/export type GuardActivityItem = \{[\s\S]*\n  created_at: string[\s\S]*\n\}/)
    expect(css).toContain('.guard-activity-executed')
    expect(css).toContain('.guard-activity-skipped')
    expect(css).toContain('.guard-activity-dry-run')
    expect(css).toContain('.guard-activity-delayed')
  })

  it('formats local supergroup identifiers as Telegram peer IDs', () => {
    expect(displayChatId(3688621340)).toBe('-1003688621340')
    expect(displayChatId(-1003688621340)).toBe('-1003688621340')
    expect(displayChatId(10)).toBe('10')
    expect(displayChatId(-123)).toBe('-123')
  })

  it('selects a valid guard group after refreshes', () => {
    const groups = [
      guardGroup(1, 'Alpha'),
      guardGroup(2, 'Beta'),
    ]

    expect(nextGuardGroupId(groups, 2)).toBe(2)
    expect(nextGuardGroupId(groups, 9)).toBe(1)
    expect(nextGuardGroupId(groups, null)).toBe(1)
    expect(nextGuardGroupId([], 2)).toBeNull()
  })

  it('maps backend guard action statuses to CSS classes', () => {
    expect(guardActivityStatusClass('executed')).toBe('guard-activity-executed')
    expect(guardActivityStatusClass('skipped')).toBe('guard-activity-skipped')
    expect(guardActivityStatusClass('dry_run')).toBe('guard-activity-dry-run')
    expect(guardActivityStatusClass('failed')).toBe('guard-activity-failed')
    expect(guardActivityStatusClass('delayed')).toBe('guard-activity-delayed')
    expect(guardActivityStatusClass('other')).toBe('guard-activity-unknown')
  })

  it('maps guard group runtime state to user-facing rule status', () => {
    expect(guardGroupStatusLabel({ enabled: false, runtime_status: 'stopped' })).toBe('Rules off')
    expect(guardGroupStatusClass({ enabled: false, runtime_status: 'stopped' })).toBe('guard-status-off')
    expect(guardGroupStatusLabel({ enabled: true, runtime_status: 'running' })).toBe('Listening')
    expect(guardGroupStatusClass({ enabled: true, runtime_status: 'running' })).toBe('guard-status-running')
    expect(guardGroupStatusLabel({ enabled: true, runtime_status: 'stopped' })).toBe('Restart needed')
    expect(guardGroupStatusClass({ enabled: true, runtime_status: 'stopped' })).toBe('guard-status-pending')
  })

  it('detects guard-only mode from the URL query', () => {
    expect(guardOnlyMode('?guard=1')).toBe(true)
    expect(guardOnlyMode('?view=guard')).toBe(false)
    expect(guardOnlyMode('')).toBe(false)
  })

  it('builds guard rule create payloads from the workbench draft', () => {
    const draft = {
      name: '  Promo links  ',
      enabled: true,
      priority: 120,
      conditionType: 'message_contains_url' as const,
      conditionText: '',
      conditionSeconds: 60,
      conditionCount: 5,
      actionType: 'delete_message' as const,
      actionText: '',
      actionSeconds: 600,
    }

    expect(guardRuleRequestFromDraft(7, draft)).toEqual({
      group_id: 7,
      name: 'Promo links',
      enabled: true,
      priority: 120,
      conditions: [{ type: 'message_contains_url' }],
      actions: [{ type: 'delete_message' }],
    })
  })

  it('builds guard rule conditions and actions that match backend schema', () => {
    const rateDraft = {
      name: '',
      enabled: true,
      priority: 100,
      conditionType: 'message_rate_exceeded' as const,
      conditionText: '',
      conditionSeconds: 30,
      conditionCount: 4,
      actionType: 'mute' as const,
      actionText: 'flood',
      actionSeconds: 300,
    }

    expect(guardRuleConditionFromDraft(rateDraft)).toEqual({
      type: 'message_rate_exceeded',
      window_seconds: 30,
      max_messages: 4,
    })
    expect(guardRuleActionFromDraft(rateDraft)).toEqual({
      type: 'mute',
      seconds: 300,
      reason: 'flood',
    })
  })

  it('builds a numbered pagination range with ellipses', () => {
    expect(paginationWindow(1, 100)).toEqual([1, 2, 3, 4, 'ellipsis-right', 100])
    expect(paginationWindow(50, 100)).toEqual([1, 'ellipsis-left', 48, 49, 50, 51, 52, 'ellipsis-right', 100])
    expect(paginationWindow(99, 100)).toEqual([1, 'ellipsis-left', 97, 98, 99, 100])
    expect(paginationWindow(3, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('builds stable sender avatars from ids and display names', () => {
    expect(senderAvatar('家有骚母狗', 7677417702)).toMatchObject({
      label: '家',
      background: expect.stringContaining('linear-gradient'),
    })
    expect(senderAvatar('Alice', 42).background).toBe(senderAvatar('Bob', 42).background)
    expect(senderAvatar('Alice', null).background).toBe(senderAvatar('Alice', null).background)
    expect(senderAvatar('Sam Smith', 100).label).toBe('SS')
    expect(senderAvatar('  sam   smith  ', 100).label).toBe('SS')
    expect(senderAvatar(' ', null).label).toBe('?')
  })

  it('filters blacklisted senders without deleting messages', () => {
    const messages = [
      { id: 1, sender_id: 7, sender_name: 'Alice' },
      { id: 2, sender_id: 8, sender_name: 'Bob' },
      { id: 3, sender_id: 7, sender_name: 'Alice Renamed' },
    ]
    const blocked = new Set([senderBlacklistKey('Alice', 7)])

    expect(visibleMessagesForBlacklist(messages, blocked).map((message) => message.id)).toEqual([2])
  })
})

function guardGroup(id: number, title: string): GuardGroup {
  return {
    id,
    account: 'work',
    chat_id: id,
    title,
    enabled: true,
    runtime_status: 'running',
    policy: {
      allow_delete: true,
      allow_mute: false,
      allow_ban: false,
      ignore_admins: true,
      ignore_bots: true,
      reply_cooldown_seconds: 30,
      action_cooldown_seconds: 5,
    },
  }
}
