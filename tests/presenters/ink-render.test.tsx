import React from 'react'
import { PassThrough } from 'node:stream'
import { renderToString } from 'ink'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerResult } from '../../src/commands/types.js'
import { InkRenderer, renderInkResult } from '../../src/presenters/ink/render.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function renderResult(result: HandlerResult, columns = 80): string {
  return renderToString(<InkRenderer result={result} terminalWidth={columns} />, { columns })
}

describe('InkRenderer', () => {
  it('renders a bordered table with display-width aligned Chinese cells', () => {
    const output = renderResult({
      ok: true,
      data: {},
      human: {
        kind: 'table',
        title: 'Chats',
        columns: ['Name', 'Type'],
        rows: [['开发群', 'group'], ['General', 'chat']],
      },
    })

    const lines = output.split('\n')
    expect(lines).toEqual([
      'Chats',
      '╭─────────┬───────╮',
      '│ Name    │ Type  │',
      '├─────────┼───────┤',
      '│ 开发群  │ group │',
      '├─────────┼───────┤',
      '│ General │ chat  │',
      '╰─────────┴───────╯',
    ])
    const tableRows = [lines[2]!, lines[4]!, lines[6]!]
    const secondColumnOffsets = tableRows.map((line, index) => {
      const value = ['Type', 'group', 'chat'][index]!
      return stringWidth(line.slice(0, line.indexOf(value)))
    })
    expect(secondColumnOffsets).toEqual([12, 12, 12])
    expect(lines.every((line) => stringWidth(line) <= 80)).toBe(true)
  })

  it('renders an aligned detail panel including CJK labels', () => {
    const output = renderResult({
      ok: true,
      data: {},
      human: {
        kind: 'detail',
        title: 'Chat details',
        fields: [
          { label: '名称', value: '开发群', tone: 'success' },
          { label: 'Status', value: 'active' },
        ],
      },
    })

    expect(output).toContain('╭')
    expect(output).toContain('Chat details')
    const fieldLines = output.split('\n').filter((line) => line.includes(':'))
    expect(fieldLines.map((line) => stringWidth(line.slice(0, line.indexOf(':'))))).toEqual([8, 8])
  })

  it('keeps the table title and shows a clear empty state', () => {
    const output = renderResult({
      ok: true,
      data: {},
      human: { kind: 'table', title: 'Chats', columns: ['Name'], rows: [], emptyText: 'No chats found.' },
    })

    expect(output.split('\n')).toEqual([
      'Chats',
      '╭──────╮',
      '│ Name │',
      '├──────┤',
      '│ No … │',
      '╰──────╯',
    ])
  })

  it('renders a summary detail and optional table without repeating its title', () => {
    const output = renderResult({
      ok: true,
      data: {},
      human: {
        kind: 'summary',
        title: 'Sync result',
        fields: [{ label: 'Imported', value: '2' }],
        table: { columns: ['Chat', 'Count'], rows: [['开发群', '2']] },
      },
    })

    expect(output.match(/Sync result/g)).toHaveLength(1)
    expect(output).toContain('Imported')
    expect(output).toContain('╭────────┬───────╮')
    expect(output).toContain('│ 开发群 │ 2     │')
    expect(output).toContain('╰────────┴───────╯')
  })

  it.each([0, 1, 2, 8, 17])('keeps every table line within %i columns', (columns) => {
    const output = renderResult({
      ok: true,
      data: {},
      human: {
        kind: 'table',
        title: 'A very long title',
        columns: ['FIRST', 'SECOND'],
        rows: [['a very long value', '技术群']],
      },
    }, columns)

    expect(output.split('\n').every((line) => stringWidth(line) <= columns)).toBe(true)
  })

  it('renders proportional timeline bars and preserves zero counts', () => {
    const output = renderResult({
      ok: true,
      data: {},
      human: {
        kind: 'timeline',
        title: 'Activity',
        rows: [{ period: 'Mon', count: 4 }, { period: 'Tue', count: 0 }],
      },
    }, 40)

    expect(output).toContain('Activity')
    expect(output).toMatch(/Mon\s+█+\s+4/)
    expect(output).toMatch(/Tue\s+0/)
  })

  it('renders a clear empty timeline state', () => {
    const output = renderResult({
      ok: true,
      data: {},
      human: { kind: 'timeline', title: 'Activity', rows: [] },
    })

    expect(output).toContain('Activity')
    expect(output).toContain('No activity found.')
  })

  it('keeps long timeline rows within the terminal width', () => {
    const output = renderResult({
      ok: true,
      data: {},
      human: {
        kind: 'timeline',
        title: 'Activity',
        rows: [{ period: 'a-very-long-reporting-period', count: 12 }],
      },
    }, 24)

    expect(output.split('\n').every((line) => stringWidth(line) <= 24)).toBe(true)
  })

  it.each([0, 1, 2, 8])('keeps every timeline line within %i columns', (columns) => {
    const output = renderResult({
      ok: true,
      data: {},
      human: {
        kind: 'timeline',
        title: 'Very long activity title',
        rows: [
          { period: 'very-long-period', count: Number.MAX_SAFE_INTEGER },
          { period: '零', count: 0 },
        ],
      },
    }, columns)

    expect(output.split('\n').every((line) => stringWidth(line) <= columns)).toBe(true)
  })

  it('uses a custom narrow TTY width when rendering a table lifecycle', async () => {
    const chunks: string[] = []
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    Object.assign(stdout, { isTTY: true, columns: 18, rows: 24 })
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    await renderInkResult({
      ok: true,
      data: {},
      human: {
        kind: 'table',
        title: 'Chats',
        columns: ['LONG FIRST COLUMN', 'SECOND'],
        rows: [['a long value', '技术群'], ['another value', 'chat']],
      },
    }, { stdout })

    const plainOutput = chunks.join('').replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
    const lines = plainOutput.split('\n').filter(Boolean)
    expect(lines.some((line) => /^╭─+┬─+╮$/.test(line))).toBe(true)
    expect(lines.some((line) => /^├─+┼─+┤$/.test(line))).toBe(true)
    expect(lines.some((line) => /^╰─+┴─+╯$/.test(line))).toBe(true)
    expect(lines.every((line) => stringWidth(line) <= stdout.columns)).toBe(true)
  })

  it('leaves subsequent terminal output on the next line without a blank line', async () => {
    const chunks: string[] = []
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    Object.assign(stdout, { isTTY: true, columns: 40, rows: 24 })
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    await renderInkResult(
      { ok: true, data: {}, human: { kind: 'text', text: 'Sent.' } },
      { stdout },
    )
    stdout.write('MARKER')

    const plainOutput = chunks.join('').replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
    expect(plainOutput).toContain('Sent.\nMARKER')
    expect(plainOutput).not.toContain('Sent.\n\nMARKER')
  })

  it('preserves text and data fallback rendering', () => {
    expect(renderResult({ ok: true, data: {}, human: { kind: 'text', text: 'Sent.' } })).toBe('Sent.')
    expect(renderResult({ ok: true, data: { total: 2 } })).toContain('"total": 2')
  })
})
