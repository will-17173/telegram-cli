import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dumpStructured,
  errorPayload,
  resolveOutputFormat,
  successPayload,
} from '../../src/presenters/structured.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('structured output', () => {
  it('wraps success data in schema version 1', () => {
    expect(successPayload({ total: 2 })).toEqual({
      ok: true,
      schema_version: '1',
      data: { total: 2 },
    })
  })

  it('wraps errors in schema version 1', () => {
    expect(errorPayload('chat_not_found', "Chat 'x' not found.")).toEqual({
      ok: false,
      schema_version: '1',
      error: { code: 'chat_not_found', message: "Chat 'x' not found." },
    })
  })

  it('rejects json and yaml together', () => {
    expect(() => resolveOutputFormat({ json: true, yaml: true, isTty: true })).toThrow(
      'Use only one of --json, --yaml, or --markdown.',
    )
  })

  it('uses yaml for non-tty auto output', () => {
    vi.stubEnv('OUTPUT', 'auto')
    expect(resolveOutputFormat({ isTty: false })).toBe('yaml')
  })

  it('honors OUTPUT=rich', () => {
    vi.stubEnv('OUTPUT', 'rich')
    expect(resolveOutputFormat({ isTty: false })).toBe('rich')
  })

  it('serializes yaml without sorting keys', () => {
    const text = dumpStructured(successPayload({ value: '你好' }), 'yaml')
    expect(text).toBe('ok: true\nschema_version: "1"\ndata:\n  value: 你好\n')
  })
})
