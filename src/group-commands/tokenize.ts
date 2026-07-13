export interface GroupCommandToken {
  readonly value: string
  readonly start: number
  readonly end: number
}

export type TokenizeGroupCommandResult =
  | { readonly ok: true; readonly tokens: readonly GroupCommandToken[] }
  | { readonly ok: false; readonly error: { readonly code: 'unterminated_quote'; readonly message: string; readonly offset: number } }

export function tokenizeGroupCommand(source: string): TokenizeGroupCommandResult {
  const tokens: GroupCommandToken[] = []
  let index = 0

  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index++
    if (index >= source.length) break

    const start = index
    let value = ''
    let quote: '"' | "'" | undefined
    let quoteOffset = -1

    while (index < source.length) {
      const character = source[index]
      if (!quote && /\s/.test(character)) break
      if (character === '\\' && quote !== "'") {
        if (index + 1 < source.length) {
          value += source[index + 1]
          index += 2
        } else {
          value += character
          index++
        }
        continue
      }
      if (character === '"' || character === "'") {
        if (!quote) {
          quote = character
          quoteOffset = index
          index++
          continue
        }
        if (quote === character) {
          quote = undefined
          index++
          continue
        }
      }
      value += character
      index++
    }

    if (quote) {
      return { ok: false, error: { code: 'unterminated_quote', message: `Unterminated ${quote} quote`, offset: quoteOffset } }
    }
    tokens.push({ value, start, end: index })
  }

  return { ok: true, tokens }
}
