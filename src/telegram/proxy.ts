import { proxyTransportFromUrl } from '@mtcute/node'

const INVALID_PROXY_ERROR = 'Telegram proxy configuration is invalid.'

type TelegramProxyTransport = ReturnType<typeof proxyTransportFromUrl>

interface ParsedTelegramProxy {
  proxy: string
  transport: TelegramProxyTransport
}

export type TelegramTransportOptions =
  | { transport?: never }
  | { transport: TelegramProxyTransport }

function parseTelegramProxy(raw: string | undefined): ParsedTelegramProxy {
  const proxy = raw?.trim()
  if (!proxy) {
    throw new Error(INVALID_PROXY_ERROR)
  }

  try {
    return {
      proxy,
      transport: proxyTransportFromUrl(proxy),
    }
  } catch {
    throw new Error(INVALID_PROXY_ERROR)
  }
}

export function normalizeTelegramProxy(raw: string | undefined): string {
  return parseTelegramProxy(raw).proxy
}

export function telegramTransportOptions(proxy: string | undefined): TelegramTransportOptions {
  if (proxy === undefined) {
    return {}
  }

  return { transport: parseTelegramProxy(proxy).transport }
}
