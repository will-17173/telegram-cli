import type { StoredMessageInput } from '../../src/storage/message-db.js'
import type { Attachment, NormalizedMessage } from '../../src/telegram/media-types.js'

type MessageFixture = StoredMessageInput & Omit<NormalizedMessage, 'platform' | 'chat_name' | 'raw_json'> & {
  platform: string
  chat_name: string | null
  raw_json: unknown
}

export function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    attachment_index: 1,
    parent_attachment_index: null,
    role: 'primary',
    kind: 'document',
    subtype: null,
    downloadable: true,
    file_id: null,
    unique_file_id: null,
    file_name: null,
    mime_type: null,
    file_size: null,
    width: null,
    height: null,
    duration_seconds: null,
    thumbnail_file_id: null,
    thumbnail_unique_file_id: null,
    thumbnail_width: null,
    thumbnail_height: null,
    emoji: null,
    title: null,
    performer: null,
    latitude: null,
    longitude: null,
    address: null,
    phone_number: null,
    url: null,
    preview_jpeg_base64: null,
    metadata: {},
    ...overrides,
  }
}

export function message(overrides: Partial<MessageFixture> = {}): MessageFixture {
  const date = new Date('2026-03-09T10:00:00.000Z').toISOString()
  const base: MessageFixture = {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    message_id: 1,
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    date,
    text: 'Message about Web3 and TypeScript',
    content: 'Message about Web3 and TypeScript',
    timestamp: date,
    grouped_id: null,
    reply_to_message_id: null,
    raw_json: null,
    attachments: [],
  }
  return { ...base, ...overrides }
}

export function fixtureMessages(): StoredMessageInput[] {
  return [
    message({ msg_id: 1, sender_name: 'Alice', content: 'Message 1: Web3 remote role', timestamp: '2026-03-09T10:00:00.000Z' }),
    message({ msg_id: 2, sender_name: 'Bob', content: 'Message 2: Python and Rust', timestamp: '2026-03-09T11:00:00.000Z' }),
    message({ msg_id: 3, chat_id: 200, chat_name: 'OtherGroup', sender_name: 'Alice', content: 'Message 3: Golang', timestamp: '2026-03-08T10:00:00.000Z' }),
  ]
}
