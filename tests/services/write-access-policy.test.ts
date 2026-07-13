import { describe, expect, it } from 'vitest'
import { WriteAccessPolicy } from '../../src/services/write-access-policy.js'

describe('WriteAccessPolicy', () => {
  it('allows enabled writes', () => {
    const policy = new WriteAccessPolicy(() => true)

    expect(policy.check()).toEqual({ ok: true, data: { enabled: true } })
  })

  it('blocks disabled writes', () => {
    const policy = new WriteAccessPolicy(() => false)

    expect(policy.check()).toEqual({
      ok: false,
      error: {
        code: 'write_access_disabled',
        message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
      },
    })
  })
})
