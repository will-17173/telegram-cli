export function canonicalChatId(chatId: number): number {
  if (chatId < 0) {
    const digits = String(Math.abs(chatId))
    if (digits.startsWith('100') && digits.length > 3) return Number.parseInt(digits.slice(3), 10)
  }
  return chatId
}
