import type { ListenMessageRow } from '../listen-message.js'

export type ListenScrollState = {
  offset: number
  unseenCount: number
}

function messageLines(message: ListenMessageRow): number {
  return 2
    + (message.replyContext == null ? 0 : 1)
    + (message.content == null ? 0 : 1)
    + (message.mediaSummary == null ? 0 : 1)
    + message.media.reduce(
    (lines, attachment) => lines + 1 + (attachment.previewRows ?? 0),
    0,
  )
}

export function takeListenViewport<T extends ListenMessageRow>(
  messages: T[],
  maxLines: number,
  offset: number,
): T[] {
  const visible: T[] = []
  let usedLines = 0
  const lastIndex = Math.max(-1, messages.length - 1 - Math.max(0, offset))

  for (let index = lastIndex; index >= 0; index -= 1) {
    const message = messages[index]
    if (message == null) continue
    const lineCount = messageLines(message)
    if (usedLines + lineCount > maxLines) {
      if (visible.length === 0) visible.unshift(message)
      break
    }
    visible.unshift(message)
    usedLines += lineCount
  }

  return visible
}

export function applyScroll(
  state: ListenScrollState,
  direction: 'up' | 'down',
  maxOffset: number,
  amount = 1,
): ListenScrollState {
  const step = Math.max(1, Math.floor(amount))
  const offset = direction === 'up'
    ? Math.min(maxOffset, state.offset + step)
    : Math.max(0, state.offset - step)
  return {
    offset,
    unseenCount: offset === 0 ? 0 : state.unseenCount,
  }
}

export function applyMessageArrival(state: ListenScrollState): ListenScrollState {
  return state.offset === 0
    ? state
    : { offset: state.offset + 1, unseenCount: state.unseenCount + 1 }
}
