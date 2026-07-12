import { beforeEach, describe, expect, it, vi } from 'vitest'

const proxyTransportFromUrl = vi.hoisted(() => vi.fn())

vi.mock('@mtcute/node', () => ({
  proxyTransportFromUrl,
}))

import {
  normalizeTelegramProxy,
  telegramTransportOptions,
} from '../../src/telegram/proxy.js'

const INVALID_PROXY_ERROR = 'Telegram proxy configuration is invalid.'

beforeEach(() => {
  proxyTransportFromUrl.mockReset()
})

describe('normalizeTelegramProxy', () => {
  it('trims the proxy URL and validates the normalized value', () => {
    proxyTransportFromUrl.mockReturnValue({ kind: 'proxy-transport' })

    const normalized = normalizeTelegramProxy('  socks5://localhost:1080  ')

    expect(normalized).toBe('socks5://localhost:1080')
    expect(proxyTransportFromUrl).toHaveBeenCalledOnce()
    expect(proxyTransportFromUrl).toHaveBeenCalledWith('socks5://localhost:1080')
  })

  it.each([undefined, '', '   '])('rejects an omitted or empty proxy value (%s)', (raw) => {
    expect(() => normalizeTelegramProxy(raw)).toThrowError(INVALID_PROXY_ERROR)
    expect(proxyTransportFromUrl).not.toHaveBeenCalled()
  })

  it.each([
    'ftp://user:password@example.com:21',
    'mtproxy://example.com:443?secret=super-secret-value',
  ])('sanitizes parser failures for invalid proxy %s', (raw) => {
    proxyTransportFromUrl.mockImplementation(() => {
      throw new Error(`could not parse ${raw}`)
    })

    let thrown: unknown
    try {
      normalizeTelegramProxy(raw)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(new Error(INVALID_PROXY_ERROR))
    expect(String(thrown)).not.toContain(raw)
    expect(String(thrown)).not.toContain('password')
    expect(String(thrown)).not.toContain('super-secret-value')
  })
})

describe('telegramTransportOptions', () => {
  it('returns an empty object without invoking mtcute when the proxy is omitted', () => {
    const options = telegramTransportOptions(undefined)

    expect(options).toEqual({})
    expect(proxyTransportFromUrl).not.toHaveBeenCalled()
  })

  it('trims and returns the mtcute transport without prior normalization', () => {
    const transport = { kind: 'proxy-transport' }
    proxyTransportFromUrl.mockReturnValue(transport)

    const options = telegramTransportOptions('  socks5://localhost:1080  ')

    expect(options).toEqual({ transport })
    expect(proxyTransportFromUrl).toHaveBeenCalledWith('socks5://localhost:1080')
  })

  it.each(['', '   '])('rejects an empty proxy without invoking mtcute (%j)', (proxy) => {
    expect(() => telegramTransportOptions(proxy)).toThrowError(INVALID_PROXY_ERROR)
    expect(proxyTransportFromUrl).not.toHaveBeenCalled()
  })

  it.each([
    {
      proxy: 'ftp://private-user:private-secret@example.com',
      parserError: 'unsupported protocol with private-secret',
    },
    {
      proxy: 'not-a-proxy-url-private-secret',
      parserError: 'malformed URL containing private-secret',
    },
  ])('sanitizes unsupported or malformed transport proxy $proxy', ({ proxy, parserError }) => {
    proxyTransportFromUrl.mockImplementation(() => {
      throw new Error(parserError)
    })

    let thrown: unknown
    try {
      telegramTransportOptions(proxy)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(new Error(INVALID_PROXY_ERROR))
    expect(String(thrown)).not.toContain(proxy)
    expect(String(thrown)).not.toContain(parserError)
    expect(String(thrown)).not.toContain('private-secret')
  })

  it('sanitizes transport parser failures without exposing proxy secrets', () => {
    const proxy = 'socks5://private-user:private-password@example.com:1080'
    proxyTransportFromUrl.mockImplementation(() => {
      throw new Error(`authentication failed for ${proxy}`)
    })

    let thrown: unknown
    try {
      telegramTransportOptions(proxy)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(new Error(INVALID_PROXY_ERROR))
    expect(String(thrown)).not.toContain(proxy)
    expect(String(thrown)).not.toContain('private-password')
  })
})
