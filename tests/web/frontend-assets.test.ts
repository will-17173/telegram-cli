import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { displayChatId } from '../../web/src/App.js'

describe('web frontend source', () => {
  it('defines the management UI shell', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8')

    expect(app).toContain('Telegram CLI')
    expect(app).toContain('Sync current chat')
    expect(app).toContain('Load earlier')
    expect(app).toContain('reply-snippet')
    expect(app).toContain('replyMessageIdLabel')
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

  it('formats local supergroup identifiers as Telegram peer IDs', () => {
    expect(displayChatId(3688621340)).toBe('-1003688621340')
    expect(displayChatId(-1003688621340)).toBe('-1003688621340')
    expect(displayChatId(10)).toBe('10')
    expect(displayChatId(-123)).toBe('-123')
  })
})
