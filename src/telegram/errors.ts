export function isTelegramAuthSessionError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false

  const candidate = error as { text?: unknown; message?: unknown; code?: unknown }
  const text = typeof candidate.text === 'string'
    ? candidate.text
    : undefined

  if (text === 'AUTH_KEY_UNREGISTERED') return true

  const code = typeof candidate.code === 'number' ? candidate.code : undefined
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return message.includes('AUTH_KEY_UNREGISTERED') && code === 401
}
