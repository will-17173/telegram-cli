import stringWidth from 'string-width'

export type FormattedLine = {
  text: string
  width: number
}

export type GridLineKind = 'border' | 'header' | 'separator' | 'row' | 'empty'

export type GridLine = FormattedLine & {
  kind: GridLineKind
}

const COLUMN_GAP = '  '
const PRACTICAL_MINIMUM_WIDTH = 3
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const SGR_PATTERN = /\u001b\[([0-9;]*)m/g
const SGR_RESET = '\u001b[0m'

export function truncateCell(value: unknown, maxWidth: number): string {
  const text = String(value)
  const width = normalizeWidth(maxWidth)

  if (width === 0) return ''
  if (stringWidth(text) <= width) return text

  const contentWidth = width - stringWidth('…')
  let result = ''
  let visible = ''
  let sourceIndex = 0
  let activeSgr = false

  for (const match of text.matchAll(SGR_PATTERN)) {
    const matchIndex = match.index
    const truncated = appendVisibleText(text.slice(sourceIndex, matchIndex))
    if (truncated) return finish()
    result += match[0]
    activeSgr = sgrIsActive(match[1] ?? '', activeSgr)
    sourceIndex = matchIndex + match[0].length
  }
  appendVisibleText(text.slice(sourceIndex))
  return finish()

  function appendVisibleText(value: string): boolean {
    for (const { segment } of graphemeSegmenter.segment(value)) {
      if (stringWidth(visible + segment) > contentWidth) return true
      visible += segment
      result += segment
    }
    return false
  }

  function finish(): string {
    return `${result}…${activeSgr ? SGR_RESET : ''}`
  }
}

function sgrIsActive(parameters: string, currentlyActive: boolean): boolean {
  const codes = parameters === '' ? [0] : parameters.split(';').map(Number)
  if (codes.includes(0)) return codes.some((code) => code !== 0)
  return codes.length > 0 ? true : currentlyActive
}

export function formatTable(
  columns: string[],
  rows: string[][],
  terminalWidth: number,
): FormattedLine[] {
  if (columns.length === 0) return []

  const widthLimit = normalizeWidth(terminalWidth)
  const gapWidth = stringWidth(COLUMN_GAP) * (columns.length - 1)
  const availableWidth = Math.max(0, widthLimit - gapWidth)
  const naturalWidths = measureNaturalWidths(columns, rows)
  const widths = allocateWidths(naturalWidths, availableWidth)

  return [columns, ...rows].map((row) => {
    const unboundedText = widths
      .map((width, index) => padCell(truncateCell(row[index] ?? '', width), width))
      .join(COLUMN_GAP)
    const text = truncateCell(unboundedText, widthLimit)

    return { text, width: stringWidth(text) }
  })
}

export function formatGridTable(
  columns: string[],
  rows: string[][],
  terminalWidth: number,
  emptyText = 'No results',
): GridLine[] {
  if (columns.length === 0) return []

  const widthLimit = normalizeWidth(terminalWidth)
  const minimumGridWidth = columns.length * 4 + 1

  if (widthLimit < minimumGridWidth) {
    return formatNarrowGrid(columns, rows, widthLimit, emptyText)
  }

  const gridOverhead = columns.length * 3 + 1
  const availableWidth = widthLimit - gridOverhead
  const naturalWidths = measureNaturalWidths(columns, rows)
  const widths = allocateWidths(naturalWidths, availableWidth)
  const lines: GridLine[] = [
    gridBorder(widths, '╭', '┬', '╮', 'border'),
    gridRow(columns, widths, 'header'),
    gridBorder(widths, '├', '┼', '┤', 'separator'),
  ]

  if (rows.length === 0) {
    const innerWidth = sum(widths) + columns.length * 3 - 1
    const contentWidth = Math.max(0, innerWidth - 2)
    const content = padCell(truncateCell(emptyText, contentWidth), contentWidth)
    lines.push(makeGridLine(`│ ${content} │`, 'empty'))
  } else {
    rows.forEach((row, index) => {
      if (index > 0) lines.push(gridBorder(widths, '├', '┼', '┤', 'separator'))
      lines.push(...expandGridRow(row).map((physicalRow) => gridRow(physicalRow, widths, 'row')))
    })
  }

  lines.push(gridBorder(widths, '╰', '┴', '╯', 'border'))
  return lines
}

function formatNarrowGrid(
  columns: string[],
  rows: string[][],
  width: number,
  emptyText: string,
): GridLine[] {
  if (width === 0) return []
  if (width === 1) return [makeGridLine('…', 'empty')]
  if (width === 2) return [makeGridLine('╭╮', 'border')]

  const innerWidth = width - 2
  const source = rows.length === 0 ? emptyText : (rows[0]?.[0] ?? columns[0] ?? '')
  const content = padCell(truncateCell(source, innerWidth), innerWidth)
  return [
    makeGridLine(`╭${'─'.repeat(innerWidth)}╮`, 'border'),
    makeGridLine(`│${content}│`, rows.length === 0 ? 'empty' : 'row'),
    makeGridLine(`╰${'─'.repeat(innerWidth)}╯`, 'border'),
  ]
}

function gridBorder(
  widths: number[],
  left: string,
  junction: string,
  right: string,
  kind: 'border' | 'separator',
): GridLine {
  const text = left + widths.map((width) => '─'.repeat(width + 2)).join(junction) + right
  return makeGridLine(text, kind)
}

function gridRow(values: string[], widths: number[], kind: 'header' | 'row'): GridLine {
  const cells = widths.map((width, index) => {
    return ` ${padCell(truncateCell(values[index] ?? '', width), width)} `
  })
  return makeGridLine(`│${cells.join('│')}│`, kind)
}

function makeGridLine(text: string, kind: GridLineKind): GridLine {
  return { text, width: stringWidth(text), kind }
}

function measureNaturalWidths(columns: string[], rows: string[][]): number[] {
  const widths = columns.map((column) => stringWidth(column))

  for (const row of rows) {
    const columnCount = Math.min(row.length, widths.length)
    for (let index = 0; index < columnCount; index++) {
      for (const line of splitCell(row[index] ?? '')) {
        widths[index] = Math.max(widths[index]!, stringWidth(line))
      }
    }
  }

  return widths
}

function expandGridRow(row: string[]): string[][] {
  const cells = row.map(splitCell)
  const height = Math.max(1, ...cells.map((cell) => cell.length))
  return Array.from({ length: height }, (_, line) => cells.map((cell) => cell[line] ?? ''))
}

function splitCell(value: string): string[] {
  return value.split(/\r?\n/)
}

function allocateWidths(naturalWidths: number[], availableWidth: number): number[] {
  if (sum(naturalWidths) <= availableWidth) return naturalWidths

  const practicalMinimums = naturalWidths.map((width) => Math.min(width, PRACTICAL_MINIMUM_WIDTH))
  const widths = sum(practicalMinimums) <= availableWidth
    ? practicalMinimums
    : naturalWidths.map(() => 0)
  let remaining = availableWidth - sum(widths)
  const capacities = naturalWidths
    .map((width, index) => ({ index, capacity: width - widths[index]! }))
    .filter(({ capacity }) => capacity > 0)
    .sort((left, right) => left.capacity - right.capacity)

  while (remaining > 0 && capacities.length > 0) {
    const share = Math.floor(remaining / capacities.length)
    const smallest = capacities[0]!

    if (smallest.capacity <= share) {
      widths[smallest.index]! += smallest.capacity
      remaining -= smallest.capacity
      capacities.shift()
      continue
    }

    for (const { index } of capacities) widths[index]! += share
    remaining -= share * capacities.length
    for (let index = 0; index < remaining; index++) {
      widths[capacities[index]!.index]!++
    }
    remaining = 0
  }

  return widths
}

function padCell(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - stringWidth(value)))
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
