import type { HumanOutput } from '../commands/types.js'

export function renderHumanMarkdown(output: HumanOutput): string {
  switch (output.kind) {
    case 'text':
      return escapeMarkdownText(output.text)
    case 'detail': {
      const rows = output.fields.map((field) => formatField(field.label, field.value))
      return `# ${output.title}\n\n${rows.join('\n')}`
    }
    case 'summary': {
      const rows = output.fields.map((field) => formatField(field.label, field.value))
      const title = `# ${output.title}\n\n${rows.join('\n')}`
      const table = output.table == null
        ? ''
        : `\n\n${renderTable(output.table.columns, output.table.rows)}`
      return `${title}${table}`
    }
    case 'table':
      return `# ${output.title}\n\n${renderTable(output.columns, output.rows)}`
    case 'timeline':
      return `# ${output.title}\n\n${
        renderTable(
          ['PERIOD', 'COUNT'],
          output.rows.map((row) => [escapeMarkdownCell(row.period), escapeMarkdownCell(String(row.count))]),
        )
      }`
    default:
      return '# Unsupported output'
  }
}

export function renderMarkdownError(code: string, message: string): string {
  return `# Error\n\n- **Code:** ${escapeMarkdownField(code)}\n- **Message:** ${escapeMarkdownField(message)}`
}

function formatField(label: string, value: string): string {
  return `- **${escapeMarkdownField(label)}:** ${escapeMarkdownField(value)}`
}

function renderTable(columns: string[], rows: string[][]): string {
  const header = columns.map((column) => escapeMarkdownField(column)).join(' | ')
  const separator = columns.map(() => '---').join(' | ')
  const body = rows.length === 0
    ? []
    : rows.map((row) => row.map((cell) => escapeMarkdownCell(cell)).join(' | '))
  return `| ${header} |\n| ${separator} |\n${body.join('\n')}`
}

function escapeMarkdownField(value: string): string {
  return escapeMarkdown(value).replaceAll('\n', '<br>')
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdown(value).replaceAll('\n', '<br>')
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
}
