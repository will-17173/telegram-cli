import { describe, expect, it, vi } from 'vitest'

import {
  NotificationService,
  parseNotificationDuration,
} from '../../src/services/notification-service.js'
import { WriteAccessPolicy } from '../../src/services/write-access-policy.js'
import {
  TelegramNotificationError,
  type TelegramNotificationAdapter,
  type TelegramNotificationState,
} from '../../src/telegram/notification-types.js'

const state: TelegramNotificationState = {
  chat_id: 42,
  chat_name: 'Team',
  explicit_muted: true,
  mute_until: '2026-07-13T20:00:00.000Z',
  effective_muted: true,
}

function adapter(overrides: Partial<TelegramNotificationAdapter> = {}): TelegramNotificationAdapter {
  return {
    get: vi.fn(async () => state),
    setMuteUntil: vi.fn(async () => state),
    ...overrides,
  }
}

describe('parseNotificationDuration', () => {
  const now = new Date('2026-07-13T12:00:00Z')

  it('parses a relative duration from the supplied time', () => {
    expect(parseNotificationDuration('8h', now)).toEqual(new Date('2026-07-13T20:00:00Z'))
  })

  it('maps forever to the Telegram permanent mute timestamp', () => {
    expect(parseNotificationDuration('forever', now)).toEqual(new Date(2147483647 * 1000))
  })

  it('accepts a relative duration ending exactly at the Telegram maximum timestamp', () => {
    const oneSecondBeforeMaximum = new Date((2147483647 - 1) * 1000)

    expect(parseNotificationDuration('1s', oneSecondBeforeMaximum)).toEqual(new Date(2147483647 * 1000))
  })

  it('rejects a relative duration ending after the Telegram maximum timestamp', () => {
    const oneSecondBeforeMaximum = new Date((2147483647 - 1) * 1000)

    expect(() => parseNotificationDuration('2s', oneSecondBeforeMaximum)).toThrow('invalid_notification_duration')
  })

  it.each(['0h', '-1h', '1.5h', '1x', '1 h', '', '999999999999999999999w'])('rejects invalid duration %j', (duration) => {
    expect(() => parseNotificationDuration(duration, now)).toThrow('invalid_notification_duration')
  })

  it('rejects a non-finite base date', () => {
    expect(() => parseNotificationDuration('1h', new Date(Number.NaN))).toThrow('invalid_notification_duration')
  })
})

describe('NotificationService', () => {
  it('returns notification info with stable canonical data and detail presentation', async () => {
    const service = new NotificationService(adapter())

    await expect(service.info('@team')).resolves.toEqual({
      ok: true,
      data: state,
      human: {
        kind: 'detail',
        title: 'Notification Settings',
        fields: [
          { label: 'Chat', value: 'Team (42)' },
          { label: 'Explicit State', value: 'Muted' },
          { label: 'Effective State', value: 'Muted' },
          { label: 'Mute Until', value: '2026-07-13T20:00:00.000Z' },
        ],
      },
    })
  })

  it('validates mute duration before checking write access or mutating', async () => {
    const notifications = adapter()
    const resolveEnabled = vi.fn(() => false)
    const service = new NotificationService(notifications, new WriteAccessPolicy(resolveEnabled))

    await expect(service.mute('@team', '0h')).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_notification_duration',
        message: 'Notification duration must be a positive integer followed by s, m, h, d, or w, or forever.',
      },
    })
    expect(resolveEnabled).not.toHaveBeenCalled()
    expect(notifications.setMuteUntil).not.toHaveBeenCalled()
  })

  it('defaults mute duration to forever and checks write access immediately before mutation', async () => {
    const calls: string[] = []
    const notifications = adapter({
      setMuteUntil: vi.fn(async (_chat, until) => {
        calls.push(`adapter:${until?.getTime()}`)
        return state
      }),
    })
    const service = new NotificationService(
      notifications,
      new WriteAccessPolicy(() => {
        calls.push('policy')
        return true
      }),
    )

    await expect(service.mute('@team')).resolves.toMatchObject({ ok: true, data: state })
    expect(calls).toEqual(['policy', `adapter:${2147483647 * 1000}`])
  })

  it('returns the unchanged disabled-policy failure without mutating', async () => {
    const notifications = adapter()
    const service = new NotificationService(notifications, new WriteAccessPolicy(() => false))

    await expect(service.mute('@team', '1h')).resolves.toEqual({
      ok: false,
      error: {
        code: 'write_access_disabled',
        message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
      },
    })
    expect(notifications.setMuteUntil).not.toHaveBeenCalled()
  })

  it('checks write access immediately before unmuting and passes null', async () => {
    const calls: string[] = []
    const notifications = adapter({
      setMuteUntil: vi.fn(async (_chat, until) => {
        calls.push(`adapter:${String(until)}`)
        return { ...state, explicit_muted: false, mute_until: null, effective_muted: false }
      }),
    })
    const service = new NotificationService(
      notifications,
      new WriteAccessPolicy(() => {
        calls.push('policy')
        return true
      }),
    )

    await expect(service.unmute('@team')).resolves.toMatchObject({ ok: true })
    expect(calls).toEqual(['policy', 'adapter:null'])
  })

  it.each([
    [new TelegramNotificationError('chat_not_found', 'unsafe @secret'), { code: 'chat_not_found', message: 'Telegram chat not found.' }],
    [new TelegramNotificationError('flood_wait', 'unsafe flood detail', 12), { code: 'flood_wait', message: 'Telegram flood wait is active.', details: { seconds: 12 } }],
    [new TelegramNotificationError('telegram_error', 'unsafe transport detail'), { code: 'telegram_error', message: 'Telegram notification request failed.' }],
  ])('maps normalized adapter errors without leaking unsafe details', async (error, expected) => {
    const service = new NotificationService(adapter({ get: vi.fn(async () => { throw error }) }))

    await expect(service.info('@secret')).resolves.toEqual({ ok: false, error: expected })
  })
})
