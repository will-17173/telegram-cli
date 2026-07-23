import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJson, postJson, patchJson, deleteJson } from '../../web/src/api.js'

// Tests that the API base URL injected by the Tauri desktop shell is prefixed
// onto requests, and that standalone `tg web` mode falls back to relative paths.

interface FetchCall {
  url: string
  init?: RequestInit
}

function captureFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : input.toString(), init })
    return new Response(JSON.stringify({ ok: true, data: { status: 'ok' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const originalWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  // Clear any injected desktop base between tests.
  delete (globalThis as { __TG_API_BASE__?: string }).__TG_API_BASE__
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window
  } else {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

describe('api base URL injection', () => {
  it('uses relative path when no desktop base is set (standalone tg web)', async () => {
    const { calls, restore } = captureFetch()
    try {
      await getJson('/api/health')
      expect(calls[0]!.url).toBe('/api/health')
    } finally {
      restore()
    }
  })

  it('prefixes the desktop base when window.__TG_API_BASE__ is set', async () => {
    ;(globalThis as unknown as { window: unknown }).window = globalThis
    ;(globalThis as { __TG_API_BASE__?: string }).__TG_API_BASE__ = 'http://127.0.0.1:9999'

    const { calls, restore } = captureFetch()
    try {
      await getJson('/api/health')
      await postJson('/api/sync-task', { limit: 10 })
      await patchJson('/api/guard/rules/1', { enabled: true })
      await deleteJson('/api/guard/rules/1')

      expect(calls[0]!.url).toBe('http://127.0.0.1:9999/api/health')
      expect(calls[1]!.url).toBe('http://127.0.0.1:9999/api/sync-task')
      expect(calls[2]!.url).toBe('http://127.0.0.1:9999/api/guard/rules/1')
      expect(calls[3]!.url).toBe('http://127.0.0.1:9999/api/guard/rules/1')
    } finally {
      restore()
    }
  })
})
