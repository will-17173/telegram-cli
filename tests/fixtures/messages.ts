import type { StoredMessageInput } from '../../src/storage/message-db.js'

export function message(overrides: Partial<StoredMessageInput> = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: 'Message about Web3 and TypeScript',
    timestamp: new Date('2026-03-09T10:00:00.000Z').toISOString(),
    raw_json: null,
    ...overrides,
  }
}

export function fixtureMessages(): StoredMessageInput[] {
  return [
    message({ msg_id: 1, sender_name: 'Alice', content: 'Message 1: Web3 remote role', timestamp: '2026-03-09T10:00:00.000Z' }),
    message({ msg_id: 2, sender_name: 'Bob', content: 'Message 2: Python and Rust', timestamp: '2026-03-09T11:00:00.000Z' }),
    message({ msg_id: 3, chat_id: 200, chat_name: 'OtherGroup', sender_name: 'Alice', content: 'Message 3: Golang', timestamp: '2026-03-08T10:00:00.000Z' }),
  ]
}
