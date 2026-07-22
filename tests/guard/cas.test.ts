import { describe, expect, it, vi } from 'vitest'
import { CasApiChecker } from '../../src/guard/cas.js'

describe('CasApiChecker', () => {
  it('returns not banned when CAS reports no record', async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: false, description: 'Record not found.' }))
    const checker = new CasApiChecker({ fetch })

    await expect(checker.check(7705286146)).resolves.toEqual({ banned: false })
    expect(fetch).toHaveBeenCalledWith(new URL('https://api.cas.chat/check?user_id=7705286146'))
  })

  it('returns ban metadata when CAS reports a record', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      ok: true,
      result: {
        offenses: 9,
        messages: ['spam'],
        time_added: '2020-06-14T03:32:28.000Z',
      },
    }))
    const checker = new CasApiChecker({ fetch })

    await expect(checker.check(123)).resolves.toEqual({
      banned: true,
      offenses: 9,
      messages: ['spam'],
      time_added: '2020-06-14T03:32:28.000Z',
    })
  })

  it('throws on unexpected CAS failures', async () => {
    const checker = new CasApiChecker({
      fetch: vi.fn(async () => jsonResponse({ ok: false, description: 'rate limited' })),
    })

    await expect(checker.check(123)).rejects.toThrow('rate limited')
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
