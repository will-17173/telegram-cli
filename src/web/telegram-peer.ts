export function telegramPeerIdFromLocalChatId(chatId: number): number {
  return chatId > 1_000_000_000 ? Number(`-100${chatId}`) : chatId
}
