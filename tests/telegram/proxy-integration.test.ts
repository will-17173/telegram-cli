import { describe, expect, it } from 'vitest'

import { telegramTransportOptions } from '../../src/telegram/proxy.js'

const INVALID_PROXY_ERROR = 'Telegram proxy configuration is invalid.'

describe('telegram proxy parser contract', () => {
  it.each([
    'socks5://user:password@127.0.0.1:1080',
    'http://user:password@127.0.0.1:8080',
    'tg://proxy?server=127.0.0.1&port=443&secret=3dpBFlW2hP6Hq_WOwiNeKBY',
  ])('constructs transport options for %s', (proxy) => {
    const options = telegramTransportOptions(proxy)

    expect(options).toHaveProperty('transport')
    expect(options.transport).toBeDefined()
  })

  it.each([
    'ftp://user:private-secret@127.0.0.1:21',
    'not-a-proxy-url-private-secret',
  ])('sanitizes a real parser failure for %s', (proxy) => {
    let thrown: unknown
    try {
      telegramTransportOptions(proxy)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(new Error(INVALID_PROXY_ERROR))
    expect(String(thrown)).not.toContain(proxy)
    expect(String(thrown)).not.toContain('private-secret')
  })
})
