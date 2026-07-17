import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { displayChatId, paginationWindow, senderAvatar, senderBlacklistKey, visibleMessagesForBlacklist } from '../../web/src/App.js'

describe('web frontend source', () => {
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
    expect(app).not.toContain('Delete')
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

  it('formats local supergroup identifiers as Telegram peer IDs', () => {
    expect(displayChatId(3688621340)).toBe('-1003688621340')
    expect(displayChatId(-1003688621340)).toBe('-1003688621340')
    expect(displayChatId(10)).toBe('10')
    expect(displayChatId(-123)).toBe('-123')
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
