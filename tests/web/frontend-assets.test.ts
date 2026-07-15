import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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
})
