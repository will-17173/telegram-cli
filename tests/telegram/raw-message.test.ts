import { describe, expect, it } from 'vitest'

import {
  extractGroupedId,
  extractReplyToMessageId,
  parseRawMessage,
} from '../../src/telegram/raw-message.js'

describe('parseRawMessage', () => {
  it('returns raw message objects unchanged', () => {
    const raw = { _: 'message', id: 42 }

    expect(parseRawMessage(raw)).toBe(raw)
  })

  it('parses serialized raw message objects', () => {
    expect(parseRawMessage('{"_":"message","id":42}')).toEqual({ _: 'message', id: 42 })
  })

  it.each([
    ['malformed JSON', '{'],
    ['serialized null', 'null'],
    ['serialized array', '[]'],
    ['null', null],
    ['array', []],
  ])('returns null for %s', (_label, value) => {
    expect(parseRawMessage(value)).toBeNull()
  })
})

describe('extractReplyToMessageId', () => {
  it('extracts camel-case reply metadata from an object', () => {
    expect(extractReplyToMessageId({ replyTo: { replyToMsgId: 17 } })).toBe(17)
  })

  it('extracts snake-case reply metadata from a serialized object', () => {
    expect(extractReplyToMessageId('{"reply_to":{"reply_to_msg_id":18}}')).toBe(18)
  })

  it.each([
    ['a string ID', { replyTo: { replyToMsgId: '17' } }],
    ['zero', { replyTo: { replyToMsgId: 0 } }],
    ['a negative ID', { reply_to: { reply_to_msg_id: -1 } }],
    ['a fractional ID', { replyTo: { replyToMsgId: 1.5 } }],
    ['unrelated metadata', { replyTo: { forumTopic: true } }],
    ['malformed JSON', '{'],
  ])('returns null for %s', (_label, value) => {
    expect(extractReplyToMessageId(value)).toBeNull()
  })
})

describe('extractGroupedId', () => {
  it.each([
    ['camel-case string', { groupedId: '922337203685477580' }, '922337203685477580'],
    ['snake-case number', { grouped_id: 42 }, '42'],
    ['camel-case long object', { groupedId: { low: 7, high: 0 } }, '7:0'],
    ['snake-case long object with string parts', { grouped_id: { low: '7', high: '9' } }, '7:9'],
  ])('extracts a %s grouped ID', (_label, value, expected) => {
    expect(extractGroupedId(value)).toBe(expected)
  })

  it('extracts grouped IDs from serialized messages', () => {
    expect(extractGroupedId('{"grouped_id":{"low":"12","high":3}}')).toBe('12:3')
  })

  it.each([
    ['an incomplete long object', { groupedId: { low: 7 } }],
    ['invalid long parts', { grouped_id: { low: true, high: 0 } }],
    ['unrelated metadata', { id: 42 }],
    ['malformed JSON', '{'],
    ['an array', []],
  ])('returns null for %s', (_label, value) => {
    expect(extractGroupedId(value)).toBeNull()
  })
})
