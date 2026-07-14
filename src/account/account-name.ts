const PATH_SEPARATOR = /[/\\]/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

export function isSafeAccountName(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value !== '.'
    && value !== '..'
    && !PATH_SEPARATOR.test(value)
    && !CONTROL_CHARACTER.test(value)
    && value.normalize('NFC') === value
}

export function assertSafeAccountName(value: unknown): asserts value is string {
  if (!isSafeAccountName(value)) {
    throw new Error('account_store_error: invalid account name')
  }
}
