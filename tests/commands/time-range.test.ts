import { describe, expect, it } from 'vitest'
import { parseTimeRange } from '../../src/commands/time-range.js'

describe('parseTimeRange', () => {
  const now = new Date('2026-07-13T12:00:00.000Z')

  it('parses relative and offset ISO bounds once', () => {
    expect(parseTimeRange({ since: '7d', until: '2d' }, now)).toEqual({
      since: new Date('2026-07-06T12:00:00.000Z'),
      until: new Date('2026-07-11T12:00:00.000Z'),
    })
    expect(parseTimeRange({ since: '2026-07-01T08:00:00+08:00' }, now)).toEqual({
      since: new Date('2026-07-01T00:00:00.000Z'),
      until: undefined,
    })
  })

  it('rejects timezone-free and inverted ranges', () => {
    expect(() => parseTimeRange({ since: '2026-07-01T08:00:00' }, now)).toThrow('invalid_time_range')
    expect(() => parseTimeRange({ since: '1h', until: '2h' }, now)).toThrow('invalid_time_range')
  })
})
