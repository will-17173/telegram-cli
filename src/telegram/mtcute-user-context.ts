import type { Chat, TelegramClient, tl } from '@mtcute/node'

const USER_CONTEXT_HISTORY_LIMIT = 1000
const USER_CONTEXT_HISTORY_CHUNK_SIZE = 100

export async function findUserPeerFromChatHistory(
  client: TelegramClient,
  chat: Chat,
  userId: number,
): Promise<tl.TypeInputPeer | null> {
  for await (const message of client.iterHistory(chat.inputPeer, {
    limit: USER_CONTEXT_HISTORY_LIMIT,
    chunkSize: USER_CONTEXT_HISTORY_CHUNK_SIZE,
  })) {
    const sender = message.sender
    if (sender.type !== 'user' || sender.id !== userId) continue
    return {
      _: 'inputPeerUserFromMessage',
      peer: chat.inputPeer,
      msgId: message.id,
      userId,
    }
  }
  return null
}
