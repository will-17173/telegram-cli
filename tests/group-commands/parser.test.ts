import { describe, expect, it } from 'vitest'

import {
  completeGroupCommand,
  matchGroupCommands,
  parseGroupCommand
} from '../../src/group-commands/parser.js'
import { tokenizeGroupCommand } from '../../src/group-commands/tokenize.js'

describe('tokenizeGroupCommand', () => {
  it('decodes quotes and escapes while retaining source offsets', () => {
    const result = tokenizeGroupCommand('  chat title "Release Room" next\\ value')

    expect(result).toEqual({
      ok: true,
      tokens: [
        { value: 'chat', start: 2, end: 6 },
        { value: 'title', start: 7, end: 12 },
        { value: 'Release Room', start: 13, end: 27 },
        { value: 'next value', start: 28, end: 39 }
      ]
    })
  })

  it('returns a structured unterminated quote error', () => {
    expect(tokenizeGroupCommand('/chat title "oops')).toMatchObject({
      ok: false,
      error: { code: 'unterminated_quote' }
    })
  })

  it('treats backslashes literally inside single quotes', () => {
    expect(tokenizeGroupCommand("chat title 'a\\b'")).toMatchObject({
      ok: true,
      tokens: [{ value: 'chat' }, { value: 'title' }, { value: 'a\\b' }]
    })
  })
})

describe('parseGroupCommand', () => {
  it('parses a member ban with a username', () => {
    const result = parseGroupCommand('/member ban @alice')
    expect(result).toMatchObject({ ok: true, request: { path: ['member', 'ban'], values: { user: '@alice' } } })
  })

  it.each([
    ['/chat title "Release Room"', 'Release Room'],
    ['/chat title Release Room', 'Release Room']
  ])('parses title text from %s', (source, text) => {
    expect(parseGroupCommand(source)).toMatchObject({ ok: true, request: { values: { text } } })
  })

  it('parses single-quoted text', () => {
    expect(parseGroupCommand("/chat title 'Release Room'")).toMatchObject({ ok: true, request: { values: { text: 'Release Room' } } })
  })

  it('normalizes numeric users and durations', () => {
    expect(parseGroupCommand('/member mute 42 2h')).toMatchObject({
      ok: true,
      request: { values: { user: 42, durationSeconds: 7200 } }
    })
  })

  it('preserves unsafe numeric users as strings', () => {
    expect(parseGroupCommand('/member ban 9007199254740992')).toMatchObject({
      ok: true,
      request: { values: { user: '9007199254740992' } }
    })
  })

  it('normalizes off duration to null', () => {
    expect(parseGroupCommand('/chat slowmode off')).toMatchObject({ ok: true, request: { values: { durationSeconds: null } } })
  })

  it.each([
    ['1s', 1],
    ['2m', 120],
    ['3h', 10800],
    ['4d', 345600]
  ])('parses duration unit %s', (duration, durationSeconds) => {
    expect(parseGroupCommand(`/chat slowmode ${duration}`)).toMatchObject({ ok: true, request: { values: { durationSeconds } } })
  })

  it('rejects duration overflow', () => {
    expect(parseGroupCommand('/chat slowmode 9007199254740991d')).toMatchObject({ ok: false, error: { code: 'invalid_duration' } })
  })

  it('accepts only positive safe ids', () => {
    expect(parseGroupCommand('/message pin 9007199254740991')).toMatchObject({ ok: true, request: { values: { id: 9007199254740991 } } })
    expect(parseGroupCommand('/message pin 9007199254740992')).toMatchObject({ ok: false, error: { code: 'invalid_id' } })
    expect(parseGroupCommand('/message pin 0')).toMatchObject({ ok: false, error: { code: 'invalid_id' } })
  })

  it('parses rest user and id lists', () => {
    expect(parseGroupCommand('/member add @alice 42 9007199254740992')).toMatchObject({
      ok: true,
      request: { values: { users: ['@alice', 42, '9007199254740992'] } }
    })
    expect(parseGroupCommand('/topic reorder 1 2 3')).toMatchObject({ ok: true, request: { values: { ids: [1, 2, 3] } } })
  })

  it('returns usage when a positional argument is missing', () => {
    expect(parseGroupCommand('/member ban')).toMatchObject({
      ok: false,
      error: { code: 'missing_argument', usage: 'group member ban <user>' }
    })
  })

  it.each([
    ['/chat title ""', 'invalid_text'],
    ['/chat photo ""', 'invalid_path'],
    ['/invite show ""', 'invalid_invite']
  ])('rejects empty non-empty string values for %s', (source, code) => {
    expect(parseGroupCommand(source)).toMatchObject({ ok: false, error: { code } })
  })

  it('rejects invalid toggles with usage', () => {
    expect(parseGroupCommand('/chat protect yes')).toMatchObject({
      ok: false,
      error: { code: 'invalid_toggle', usage: 'group chat protect <enabled>' }
    })
  })

  it('parses permissions as a unique non-empty list', () => {
    expect(parseGroupCommand('/chat default-permissions send,media,send')).toMatchObject({
      ok: true,
      request: { values: { permissions: ['send', 'media'] } }
    })
    expect(parseGroupCommand('/chat default-permissions send,,media')).toMatchObject({ ok: false, error: { code: 'invalid_permissions' } })
  })

  it('parses create and edit options in both GNU forms', () => {
    expect(parseGroupCommand('/invite create --title "VIP Room" --expire=1d --limit 5 --request-needed=on')).toMatchObject({
      ok: true,
      request: { values: { title: 'VIP Room', expireSeconds: 86400, limit: 5, requestNeeded: true } }
    })
    expect(parseGroupCommand('/invite edit abc --title=new')).toMatchObject({
      ok: true,
      request: { values: { invite: 'abc', title: 'new' } }
    })
  })

  it.each([
    ['/invite create --wat x', 'unknown_option'],
    ['/invite create --title a --title b', 'duplicate_option'],
    ['/invite create --title', 'missing_option_value']
  ])('returns stable option errors for %s', (source, code) => {
    expect(parseGroupCommand(source)).toMatchObject({ ok: false, error: { code } })
  })

  it('distinguishes empty option values from missing option values', () => {
    expect(parseGroupCommand('/invite create --title ""')).toMatchObject({ ok: false, error: { code: 'invalid_text' } })
    expect(parseGroupCommand('/invite create --title=')).toMatchObject({ ok: false, error: { code: 'invalid_text' } })
    expect(parseGroupCommand('/invite create --title')).toMatchObject({ ok: false, error: { code: 'missing_option_value' } })
  })

  it('rejects extra positional arguments', () => {
    expect(parseGroupCommand('/member ban @alice extra')).toMatchObject({ ok: false, error: { code: 'unexpected_argument' } })
  })
})

describe('matching and completion', () => {
  it('ranks ordered subsequence fuzzy matches in catalog order', () => {
    expect(matchGroupCommands('/memb bn')[0]?.definition.path).toEqual(['member', 'ban'])
  })

  it('uses catalog order to break equal-rank ties', () => {
    expect(matchGroupCommands('/c').slice(0, 3).map(match => match.definition.path)).toEqual([
      ['chat', 'title'],
      ['chat', 'description'],
      ['chat', 'username']
    ])
  })

  it('ranks exact prefixes ahead of ordered subsequences', () => {
    const matches = matchGroupCommands('/memb b')
    expect(matches[0]?.definition.path).toEqual(['member', 'ban'])
    expect(matches.findIndex(match => match.definition.path[1] === 'ban')).toBeLessThan(
      matches.findIndex(match => match.definition.path[1] === 'unban')
    )
  })

  it('keeps a complete command matched after arguments begin', () => {
    expect(matchGroupCommands('/member ban @alice')[0]?.definition.path).toEqual(['member', 'ban'])
  })

  it('completes the selected command while preserving slash and arguments', () => {
    expect(completeGroupCommand('/mem b')).toBe('/member ban ')
    expect(completeGroupCommand('/member ban @alice')).toBe('/member ban @alice')
    expect(completeGroupCommand('/zzz')).toBe('/zzz')
  })

  it('preserves leading whitespace when completing slash and CLI commands', () => {
    expect(completeGroupCommand('  /mem b')).toBe('  /member ban ')
    expect(completeGroupCommand('\tmem b')).toBe('\tmember ban ')
  })

  it('does not alter tokenizer source offsets while completing commands', () => {
    expect(tokenizeGroupCommand('  /mem b')).toMatchObject({
      ok: true,
      tokens: [{ value: '/mem', start: 2, end: 6 }, { value: 'b', start: 7, end: 8 }]
    })
  })
})
