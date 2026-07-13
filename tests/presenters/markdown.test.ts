import { describe, expect, it } from 'vitest'
import { renderHumanMarkdown, renderMarkdownError } from '../../src/presenters/markdown.js'
import type { HumanOutput } from '../../src/commands/types.js'

describe('markdown presenter', () => {
  it('escapes table values and preserves newlines as HTML breaks', () => {
    const output: HumanOutput = {
      kind: 'summary',
      title: 'Inbox',
      fields: [{ label: 'Unread', value: '3' }],
      table: {
        columns: ['CHAT', 'LAST'],
        rows: [['Team | Ops', 'line 1\nline 2']],
      },
    }

    const rendered = renderHumanMarkdown(output)
    expect(rendered).toBe(
      '# Inbox\n\n- **Unread:** 3\n\n| CHAT | LAST |\n| --- | --- |\n| Team \\| Ops | line 1<br>line 2 |',
    )
  })

  it('renders stable markdown error blocks', () => {
    expect(renderMarkdownError('invalid_output_format', 'Use only one of --json, --yaml, or --markdown.'))
      .toBe('# Error\n\n- **Code:** `invalid_output_format`\n- **Message:** Use only one of --json, --yaml, or --markdown.')
  })

  it('renders timeline output as markdown table style', () => {
    const output: HumanOutput = {
      kind: 'timeline',
      title: 'Hourly timeline',
      rows: [
        { period: '2026-03-09T10', count: 3 },
        { period: '2026-03-09T11', count: 1 },
      ],
    }

    expect(renderHumanMarkdown(output)).toBe(
      '# Hourly timeline\n\n| PERIOD | COUNT |\n| --- | --- |\n| 2026-03-09T10 | 3 |\n| 2026-03-09T11 | 1 |',
    )
  })

  it('preserves paragraphs in text output', () => {
    expect(renderHumanMarkdown({ kind: 'text', text: 'Use `tg` | safely\r\n\r\nNext paragraph.' }))
      .toBe('Use `tg` | safely\n\nNext paragraph.')
  })
})
