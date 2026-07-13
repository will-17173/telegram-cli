import type { HandlerResult, HumanOutput } from '../commands/types.js'
import { TelegramNotificationError } from '../telegram/mtcute-notifications.js'
import type {
  TelegramNotificationAdapter,
  TelegramNotificationState,
} from '../telegram/notification-types.js'
import { WriteAccessPolicy } from './write-access-policy.js'

const PERMANENT_MUTE_UNTIL_SECONDS = 2_147_483_647
const INVALID_DURATION_MESSAGE = 'Notification duration must be a positive integer followed by s, m, h, d, or w, or forever.'
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000
const UNIT_MILLISECONDS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const

export class InvalidNotificationDurationError extends Error {
  constructor() {
    super('invalid_notification_duration')
    this.name = 'InvalidNotificationDurationError'
  }
}

export function parseNotificationDuration(duration: string, now = new Date()): Date {
  if (duration === 'forever') return new Date(PERMANENT_MUTE_UNTIL_SECONDS * 1_000)

  const match = /^([1-9]\d*)([smhdw])$/.exec(duration)
  if (match == null) throw new InvalidNotificationDurationError()

  const amount = Number(match[1])
  const baseMilliseconds = now.getTime()
  const unit = match[2] as keyof typeof UNIT_MILLISECONDS
  const durationMilliseconds = amount * UNIT_MILLISECONDS[unit]
  const targetMilliseconds = baseMilliseconds + durationMilliseconds
  if (
    !Number.isSafeInteger(amount)
    || !Number.isFinite(baseMilliseconds)
    || !Number.isFinite(durationMilliseconds)
    || !Number.isFinite(targetMilliseconds)
    || targetMilliseconds > MAX_DATE_MILLISECONDS
    || targetMilliseconds < -MAX_DATE_MILLISECONDS
  ) {
    throw new InvalidNotificationDurationError()
  }

  const result = new Date(targetMilliseconds)
  if (!Number.isFinite(result.getTime())) throw new InvalidNotificationDurationError()
  return result
}

export class NotificationService {
  constructor(
    private readonly notifications: TelegramNotificationAdapter,
    private readonly writePolicy: WriteAccessPolicy = new WriteAccessPolicy(),
  ) {}

  async info(chat: string | number): Promise<HandlerResult<TelegramNotificationState>> {
    try {
      return success(await this.notifications.get(chat))
    } catch (error) {
      return notificationFailure(error)
    }
  }

  async mute(
    chat: string | number,
    duration = 'forever',
  ): Promise<HandlerResult<TelegramNotificationState>> {
    let until: Date
    try {
      until = parseNotificationDuration(duration)
    } catch (error) {
      if (error instanceof InvalidNotificationDurationError) return invalidDurationFailure()
      throw error
    }

    const access = this.writePolicy.check()
    if (!access.ok) return access

    try {
      return success(await this.notifications.setMuteUntil(chat, until))
    } catch (error) {
      return notificationFailure(error)
    }
  }

  async unmute(chat: string | number): Promise<HandlerResult<TelegramNotificationState>> {
    const access = this.writePolicy.check()
    if (!access.ok) return access

    try {
      return success(await this.notifications.setMuteUntil(chat, null))
    } catch (error) {
      return notificationFailure(error)
    }
  }
}

export function invalidNotificationDurationFailure(): HandlerResult<never> {
  return invalidDurationFailure()
}

function success(state: TelegramNotificationState): HandlerResult<TelegramNotificationState> {
  return { ok: true, data: state, human: notificationDetail(state) }
}

function notificationDetail(state: TelegramNotificationState): HumanOutput {
  return {
    kind: 'detail',
    title: 'Notification Settings',
    fields: [
      { label: 'Chat', value: `${state.chat_name} (${state.chat_id})` },
      {
        label: 'Explicit State',
        value: state.explicit_muted == null ? 'Inherited' : state.explicit_muted ? 'Muted' : 'Unmuted',
      },
      { label: 'Effective State', value: state.effective_muted ? 'Muted' : 'Unmuted' },
      { label: 'Mute Until', value: state.mute_until ?? 'Not set' },
    ],
  }
}

function invalidDurationFailure(): HandlerResult<never> {
  return {
    ok: false,
    error: {
      code: 'invalid_notification_duration',
      message: INVALID_DURATION_MESSAGE,
    },
  }
}

function notificationFailure(error: unknown): HandlerResult<never> {
  if (error instanceof TelegramNotificationError) {
    if (error.code === 'chat_not_found') {
      return failure('chat_not_found', 'Telegram chat not found.')
    }
    if (error.code === 'flood_wait') {
      return failure(
        'flood_wait',
        'Telegram flood wait is active.',
        error.seconds == null ? undefined : { seconds: error.seconds },
      )
    }
  }
  return failure('telegram_error', 'Telegram notification request failed.')
}

function failure(code: string, message: string, details?: unknown): HandlerResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}
