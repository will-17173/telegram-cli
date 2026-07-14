import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web frontend source', () => {
  it('defines the management UI shell', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8')

    expect(app).toContain('Telegram CLI')
    expect(app).toContain('Sync current chat')
    expect(app).toContain('Load earlier')
    expect(app).not.toContain('Send message')
    expect(app).not.toContain('Delete')
  })
})
