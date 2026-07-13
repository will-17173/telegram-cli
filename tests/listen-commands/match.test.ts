import { describe, expect, it } from 'vitest'

import {
  MAX_LISTEN_COMMAND_MATCHES,
  completeListenCommand,
  matchListenCommands,
  visibleListenCommandMatches,
} from '../../src/listen-commands/match.js'

const ids = (input: string) => matchListenCommands(input).map(match => match.definition.id)

describe('listen command matching', () => {
  it('returns reply first for an empty slash query and keeps all results available', () => {
    expect(MAX_LISTEN_COMMAND_MATCHES).toBe(6)
    expect(ids('/')[0]).toBe('reply')
    expect(matchListenCommands('/').length).toBeGreaterThan(MAX_LISTEN_COMMAND_MATCHES)
    expect(visibleListenCommandMatches('/')).toEqual(matchListenCommands('/').slice(0, 6))
  })

  it.each(['/reply', '/reply 42 hi'])('prefers an exact command path for %s', (input) => {
    expect(ids(input)[0]).toBe('reply')
  })

  it('ranks path prefixes ahead of fuzzy matches', () => {
    expect(ids('/rep')[0]).toBe('reply')
    expect(ids('/member b')[0]).toBe('group:member ban')
  })

  it('supports ordered fuzzy matches across paths, summaries, and keywords', () => {
    expect(ids('/rpy')[0]).toBe('reply')
    expect(ids('/r!p')[0]).toBe('reply')
    expect(ids('/ban')[0]).toBe('group:member ban')
    expect(ids('/remove admin')[0]).toBe('group:admin demote')
  })

  it.each(['/@', '/!!!', '/你好'])('does not match non-empty queries that normalize to empty: %s', (input) => {
    expect(matchListenCommands(input)).toEqual([])
    expect(completeListenCommand(input)).toBe(input)
  })

  it('does not treat arguments as command path query tokens', () => {
    expect(ids('/member ban @user')[0]).toBe('group:member ban')
    expect(ids('/reply 42 hi')[0]).toBe('reply')
  })

  it('breaks score ties by general category, then stable catalog order', () => {
    expect(ids('/')[0]).toBe('reply')
    expect(ids('/member').slice(0, 3)).toEqual([
      'group:member add',
      'group:member kick',
      'group:member ban',
    ])
  })

  it('returns a stable empty result for irrelevant wide input', () => {
    expect(matchListenCommands('/zzzzzz totally irrelevant words here')).toEqual([])
    expect(matchListenCommands('/zzzzzz totally irrelevant words here')).toEqual([])
  })
})

describe('listen command completion', () => {
  it('preserves leading whitespace and slash', () => {
    expect(completeListenCommand('  /rep')).toBe('  /reply ')
  })

  it('completes an incomplete two-part path', () => {
    expect(completeListenCommand('/mem b')).toBe('/member ban ')
  })

  it('preserves existing arguments and does not duplicate complete paths', () => {
    expect(completeListenCommand('/reply 42 hi')).toBe('/reply 42 hi')
    expect(completeListenCommand('/member ban @user')).toBe('/member ban @user')
  })

  it.each(['/member @', '/member !!!', '/member 你好'])('treats an unmatched second token as an argument boundary: %s', (input) => {
    expect(ids(input).slice(0, 3)).toEqual([
      'group:member add',
      'group:member kick',
      'group:member ban',
    ])
    expect(completeListenCommand(input)).toBe(input)
  })

  it.each([
    '/member @ban',
    '/member @add',
    '/member @kick',
    '/member #ban',
    '/member 123',
    '/member --ban',
    '/member "ban"',
    "/member 'add'",
  ])('never interprets an argument-shaped second token as a subcommand: %s', (input) => {
    expect(ids(input).slice(0, 3)).toEqual([
      'group:member add',
      'group:member kick',
      'group:member ban',
    ])
    expect(completeListenCommand(input)).toBe(input)
  })

  it('still treats an ordinary second token as a subcommand', () => {
    expect(ids('/member ban')[0]).toBe('group:member ban')
    expect(completeListenCommand('/member ban')).toBe('/member ban')
  })

  it('preserves reply arguments', () => {
    expect(ids('/reply @x')[0]).toBe('reply')
    expect(completeListenCommand('/reply @x')).toBe('/reply @x')
  })

  it('only selects among the six visible matches and safely keeps invalid selections unchanged', () => {
    const visible = visibleListenCommandMatches('/')
    expect(visible).toHaveLength(6)
    expect(completeListenCommand('/', 5)).toBe(`/${visible[5]!.definition.path.join(' ')} `)
    expect(completeListenCommand('/', 6)).toBe('/')
    expect(completeListenCommand('/', -1)).toBe('/')
  })

  it('keeps the original input when nothing matches', () => {
    expect(completeListenCommand('/zzzzzz')).toBe('/zzzzzz')
  })
})
