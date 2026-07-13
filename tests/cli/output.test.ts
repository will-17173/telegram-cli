import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'

const renderInkResult = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../src/presenters/ink/render.js', () => ({ renderInkResult }))

import { renderResult } from '../../src/cli/output.js'
import type { HandlerResult } from '../../src/commands/types.js'

const originalExitCode = process.exitCode
const originalStdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

beforeEach(() => {
  vi.stubEnv('OUTPUT', '')
  renderInkResult.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (originalStdoutIsTty) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTty)
  } else {
    delete (process.stdout as Partial<NodeJS.WriteStream>).isTTY
  }
  process.exitCode = originalExitCode
})

describe('cli output rendering', () => {
  it('writes structured success envelope to stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = { ok: true, data: { total: 2 } }

    await renderResult(result, { json: true })

    expect(stdout).toHaveBeenCalledWith(
      '{\n  "ok": true,\n  "schema_version": "1",\n  "data": {\n    "total": 2\n  }\n}\n',
    )
  })

  it('serializes only canonical data for explicit json output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { total: 2 },
      human: { kind: 'text', text: 'Two human-readable results.' },
    }

    await renderResult(result, { json: true, isTty: true })

    const output = String(stdout.mock.calls[0]?.[0])
    expect(JSON.parse(output)).toEqual({ ok: true, schema_version: '1', data: { total: 2 } })
    expect(output).not.toContain('human')
    expect(output).not.toContain('Two human-readable results.')
    expect(output).not.toMatch(/\u001b\[/)
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('writes exactly one trailing newline for yaml output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = { ok: true, data: { total: 2 } }

    await renderResult(result, { yaml: true })

    expect(stdout).toHaveBeenCalledWith('ok: true\nschema_version: "1"\ndata:\n  total: 2\n')
  })

  it('serializes only canonical data for explicit yaml output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { total: 2 },
      human: { kind: 'table', title: 'Totals', columns: ['TOTAL'], rows: [['2']] },
    }

    await renderResult(result, { yaml: true, isTty: true })

    const output = String(stdout.mock.calls[0]?.[0])
    expect(YAML.parse(output)).toEqual({ ok: true, schema_version: '1', data: { total: 2 } })
    expect(output).not.toContain('Totals')
    expect(output).not.toMatch(/\u001b\[/)
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('defaults undefined stdout isTTY to non-tty yaml output', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined })
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = { ok: true, data: { total: 2 } }

    await renderResult(result, {})

    expect(stdout).toHaveBeenCalledWith('ok: true\nschema_version: "1"\ndata:\n  total: 2\n')
    expect(String(stdout.mock.calls[0]?.[0])).not.toMatch(/\u001b\[/)
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('uses yaml without ansi when isTty is explicitly false', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { total: 2 },
      human: { kind: 'table', title: 'Totals', columns: ['TOTAL'], rows: [['2']] },
    }

    await renderResult(result, { isTty: false })

    const output = String(stdout.mock.calls[0]?.[0])
    expect(YAML.parse(output)).toEqual({ ok: true, schema_version: '1', data: { total: 2 } })
    expect(output).not.toMatch(/\u001b\[/)
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it.each(['json', 'yaml', 'rich'] as const)('honors OUTPUT=%s', async (format) => {
    vi.stubEnv('OUTPUT', format)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { total: 2 },
      human: { kind: 'table', title: 'Totals', columns: ['TOTAL'], rows: [['2']] },
    }

    await renderResult(result, { isTty: format !== 'rich' })

    if (format === 'rich') {
      expect(renderInkResult).toHaveBeenCalledOnce()
      expect(stdout).not.toHaveBeenCalled()
    } else {
      expect(renderInkResult).not.toHaveBeenCalled()
      const output = String(stdout.mock.calls[0]?.[0])
      expect(format === 'json' ? JSON.parse(output) : YAML.parse(output)).toEqual({
        ok: true,
        schema_version: '1',
        data: { total: 2 },
      })
    }
  })

  it('lets explicit flags override OUTPUT', async () => {
    vi.stubEnv('OUTPUT', 'rich')
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { total: 2 },
      human: { kind: 'table', title: 'Totals', columns: ['TOTAL'], rows: [['2']] },
    }

    await renderResult(result, { json: true, isTty: true })

    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      schema_version: '1',
      data: { total: 2 },
    })
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('uses Ink only for successful rich semantic results', async () => {
    const result: HandlerResult = {
      ok: true,
      data: [{ id: 42 }],
      human: { kind: 'table', title: 'Chats', columns: ['ID'], rows: [['42']] },
    }

    await renderResult(result, { isTty: true })

    expect(renderInkResult).toHaveBeenCalledOnce()
    expect(renderInkResult).toHaveBeenCalledWith(result)
  })

  it('sets exit code for structured failure', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: false,
      error: { code: 'chat_not_found', message: "Chat 'x' not found." },
    }

    await renderResult(result, { json: true })

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      schema_version: '1',
      error: { code: 'chat_not_found', message: "Chat 'x' not found." },
    })
    expect(stderr).not.toHaveBeenCalled()
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('writes rich failure to stderr and sets exit code', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: false,
      error: { code: 'chat_not_found', message: "Chat 'x' not found." },
    }

    await renderResult(result, { isTty: true })

    expect(stderr).toHaveBeenCalledWith("Chat 'x' not found.\n")
    expect(process.exitCode).toBe(1)
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('writes rich human text without wiring commands yet', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { sent: true },
      human: { kind: 'text', text: 'Sent.' },
    }

    await renderResult(result, { isTty: true })

    expect(stdout).toHaveBeenCalledWith('Sent.\n')
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('renders markdown for successful rich output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { unread: 3 },
      human: { kind: 'summary', title: 'Inbox', fields: [{ label: 'Unread', value: '3' }] },
    }

    await renderResult(result, { markdown: true })

    expect(stdout).toHaveBeenCalledWith('# Inbox\n\n- **Unread:** 3\n')
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('writes markdown errors to stderr and sets exit code', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: false,
      error: { code: 'invalid_output_format', message: 'Use only one of --json, --yaml, or --markdown.' },
    }

    await renderResult(result, { markdown: true })

    expect(stderr).toHaveBeenCalledWith('# Error\n\n- **Code:** invalid_output_format\n- **Message:** Use only one of --json, --yaml, or --markdown.\n')
    expect(process.exitCode).toBe(1)
    expect(renderInkResult).not.toHaveBeenCalled()
  })

  it('uses OUTPUT=markdown when no explicit flag is set', async () => {
    vi.stubEnv('OUTPUT', 'markdown')
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result: HandlerResult = {
      ok: true,
      data: { unread: 3 },
      human: { kind: 'summary', title: 'Inbox', fields: [{ label: 'Unread', value: '3' }] },
    }

    await renderResult(result, { isTty: false })

    expect(stdout).toHaveBeenCalledWith('# Inbox\n\n- **Unread:** 3\n')
    expect(renderInkResult).not.toHaveBeenCalled()
  })
})
