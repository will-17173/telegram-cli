import { describe, expect, it, vi } from 'vitest'

import { ListenAlbumAggregator } from '../../src/services/listen-album-aggregator.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('ListenAlbumAggregator', () => {
  it('emits ordinary messages immediately', () => {
    const emit = vi.fn()
    const aggregator = new ListenAlbumAggregator({ emit })
    const input = message({ msgId: 1 })

    aggregator.add(input)

    expect(emit).toHaveBeenCalledWith([input])
  })

  it('groups messages with the same canonical media group ID', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const aggregator = new ListenAlbumAggregator({ emit })
    const second = message({ msgId: 12, mediaGroupId: '7', content: 'album caption' })
    const first = message({ msgId: 11, mediaGroupId: '7' })

    aggregator.add(second)
    aggregator.add(first)
    expect(emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)

    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]?.[0]).toEqual([first, second])
    vi.useRealTimers()
  })

  it('keeps equal grouped IDs in different chats separate', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const aggregator = new ListenAlbumAggregator({ emit })

    aggregator.add(message({ chatId: 100, msgId: 1, mediaGroupId: 'album' }))
    aggregator.add(message({ chatId: 200, msgId: 2, mediaGroupId: 'album' }))
    vi.advanceTimersByTime(300)

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls.map(([items]) => items[0].chat_id)).toEqual([100, 200])
    vi.useRealTimers()
  })

  it('flushes pending albums and cancels their timers', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const aggregator = new ListenAlbumAggregator({ emit })
    const input = message({ msgId: 4, mediaGroupId: '8' })

    aggregator.add(input)
    aggregator.flush()
    vi.runAllTimers()

    expect(emit).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith([input])
    vi.useRealTimers()
  })

  it('ignores stale raw grouped IDs when canonical media group IDs differ', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const aggregator = new ListenAlbumAggregator({ emit })
    const first = message({ msgId: 5, mediaGroupId: 'first' })
    const second = message({ msgId: 6, mediaGroupId: 'second' })
    first.raw_json = JSON.stringify({ groupedId: 'stale' })
    second.raw_json = JSON.stringify({ groupedId: 'stale' })

    aggregator.add(first)
    aggregator.add(second)
    vi.advanceTimersByTime(300)

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls.map(([items]) => items[0].msg_id)).toEqual([5, 6])
    vi.useRealTimers()
  })

  it('reports timer emit failures through onError without throwing uncaught', () => {
    vi.useFakeTimers()
    const error = new Error('timer output failed')
    const onError = vi.fn()
    const aggregator = new ListenAlbumAggregator({ emit: () => { throw error }, onError })
    aggregator.add(message({ msgId: 1, mediaGroupId: 'album' }))

    expect(() => vi.advanceTimersByTime(300)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
    vi.useRealTimers()
  })

  it('reports immediate emit failures through onError', () => {
    const error = new Error('immediate output failed')
    const onError = vi.fn()
    const aggregator = new ListenAlbumAggregator({ emit: () => { throw error }, onError })
    expect(() => aggregator.add(message({ msgId: 1 }))).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('keeps the old throwing behavior when no onError handler is provided', () => {
    const error = new Error('flush failed')
    const aggregator = new ListenAlbumAggregator({ emit: () => { throw error } })
    aggregator.add(message({ msgId: 1, mediaGroupId: 'album' }))
    expect(() => aggregator.flush()).toThrow(error)
    aggregator.dispose()
  })
})

function message(options: {
  msgId: number
  chatId?: number
  mediaGroupId?: string
  content?: string
}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: options.chatId ?? 100,
    chat_name: 'TestGroup',
    msg_id: options.msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content: options.content ?? '',
    timestamp: '2026-07-10T07:22:00.000Z',
    reply_to_msg_id: null,
    media_group_id: options.mediaGroupId ?? null,
    raw_json: null,
    attachments: [],
  }
}
