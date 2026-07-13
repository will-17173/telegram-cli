import { describe, expect, it } from 'vitest'
import stringWidth from 'string-width'
import {
  formatGridTable,
  formatTable,
  truncateCell,
} from '../../src/presenters/ink/display-width.js'

describe('truncateCell', () => {
  it('closes active ANSI SGR styles after a truncation ellipsis', () => {
    expect(truncateCell('\u001b[31mABCDEFGHIJ\u001b[0m', 4))
      .toBe('\u001b[31mABC…\u001b[0m')
  })

  it('leaves fitting ANSI SGR text and its existing reset unchanged', () => {
    const value = '\u001b[1;31mABC\u001b[0m'
    expect(truncateCell(value, 3)).toBe(value)
  })

  it('does not append a duplicate reset when styles close before truncation', () => {
    expect(truncateCell('\u001b[1;31mA\u001b[0mBCDEFG', 4))
      .toBe('\u001b[1;31mA\u001b[0mBC…')
  })

  it('truncates wide Unicode text within the display width', () => {
    expect(truncateCell('技术交流群', 7)).toBe('技术交…')
  })

  it('returns an empty cell when no display width is available', () => {
    expect(truncateCell('value', 0)).toBe('')
  })

  it('leaves values that already fit unchanged', () => {
    expect(truncateCell(42, 2)).toBe('42')
  })

  it('does not split a keycap grapheme cluster', () => {
    expect(truncateCell('1️⃣x', 2)).toBe('…')
  })

  it('does not split combining or ZWJ grapheme clusters', () => {
    expect(truncateCell('éxy', 2)).toBe('é…')
    expect(truncateCell('👩‍💻xy', 3)).toBe('👩‍💻…')
  })
})

describe('formatTable', () => {
  it('fits a Unicode-aware table within the terminal width', () => {
    const lines = formatTable(
      ['ID', 'NAME', 'TYPE'],
      [['100', '技术交流群', 'supergroup']],
      24,
    )

    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.width <= 24)).toBe(true)
    expect(lines.every((line) => line.width === stringWidth(line.text))).toBe(true)
    expect(lines[1]?.text).toContain('技术')
  })

  it('still respects very narrow terminal widths', () => {
    const lines = formatTable(['FIRST', 'SECOND', 'THIRD'], [['alpha', 'beta', 'gamma']], 1)

    expect(lines.every((line) => line.width <= 1)).toBe(true)
  })

  it('formats a million-character cell within the requested width', () => {
    const lines = formatTable(['VALUE'], [['x'.repeat(1_000_000)]], 80)

    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.width <= 80)).toBe(true)
  })
})

describe('formatGridTable', () => {
  it('resets truncated ANSI cell styles before padding and the next border', () => {
    const lines = formatGridTable(['VALUE'], [['\u001b[31mABCDEFGHIJ\u001b[0m']], 8)
    const row = lines.find((line) => line.kind === 'row')?.text
    expect(row).toMatch(/…\u001b\[0m\s+│$/)
    expect(row?.indexOf('\u001b[0m')).toBeLessThan(row?.lastIndexOf('│') ?? 0)
  })

  it('expands multiline cells into aligned physical grid rows without semantic separators', () => {
    const lines = formatGridTable(['ID', 'MESSAGE'], [['1', 'reply\ncontent\nmedia']], 30)
    expect(lines.map((line) => line.kind)).toEqual([
      'border', 'header', 'separator', 'row', 'row', 'row', 'border',
    ])
    const rows = lines.filter((line) => line.kind === 'row')
    expect(rows.map((line) => line.text)).toEqual([
      '│ 1  │ reply   │',
      '│    │ content │',
      '│    │ media   │',
    ])
    expect(new Set(lines.map((line) => line.width).filter(Boolean)).size).toBe(1)
  })

  it('uses rounded borders and junctions with a separator between every data row', () => {
    const lines = formatGridTable(['ID', 'NAME'], [['1', 'Ada'], ['2', 'Lin']], 30)

    expect(lines.map((line) => line.kind)).toEqual([
      'border', 'header', 'separator', 'row', 'separator', 'row', 'border',
    ])
    expect(lines[0]?.text).toMatch(/^╭─+┬─+╮$/)
    expect(lines[1]?.text).toMatch(/^│ ID +│ NAME │$/)
    expect(lines[2]?.text).toMatch(/^├─+┼─+┤$/)
    expect(lines[4]?.text).toMatch(/^├─+┼─+┤$/)
    expect(lines[6]?.text).toMatch(/^╰─+┴─+╯$/)
  })

  it('aligns CJK, emoji, and grapheme clusters with one space of cell padding', () => {
    const lines = formatGridTable(['名称', 'ICON'], [['技术群', '👩‍💻'], ['é', '1️⃣']], 24)
    const rows = lines.filter((line) => line.kind === 'header' || line.kind === 'row')

    expect(rows.every((line) => line.text.startsWith('│ ') && line.text.endsWith(' │'))).toBe(true)
    expect(new Set(lines.map((line) => line.width)).size).toBe(1)
    expect(lines.some((line) => line.text.includes('👩‍💻'))).toBe(true)
    expect(lines.some((line) => line.text.includes('1️⃣'))).toBe(true)
  })

  it('renders an empty state as one spanning bordered row', () => {
    const lines = formatGridTable(['ID', 'NAME'], [], 20, '没有结果')

    expect(lines.map((line) => line.kind)).toEqual([
      'border', 'header', 'separator', 'empty', 'border',
    ])
    expect(lines[3]?.text).toMatch(/^│ 没有结果 +│$/)
    expect(lines[4]?.text).toMatch(/^╰─+┴─+╯$/)
  })

  it('reports exact display widths and never exceeds the normalized terminal width', () => {
    for (const width of [0, 1, 2, 4, 8, 17, Number.NaN, -4]) {
      const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
      const lines = formatGridTable(['FIRST', 'SECOND'], [['alpha', '技术']], width)

      expect(lines.every((line) => line.width === stringWidth(line.text))).toBe(true)
      expect(lines.every((line) => line.width <= normalized)).toBe(true)
    }
  })

  it('has deterministic narrow-width fallbacks', () => {
    expect(formatGridTable(['NAME'], [['Alice']], 0)).toEqual([])
    expect(formatGridTable(['NAME'], [['Alice']], 1).map((line) => line.text)).toEqual(['…'])
    expect(formatGridTable(['NAME'], [['Alice']], 2).map((line) => line.text)).toEqual(['╭╮'])
    expect(formatGridTable(['NAME', 'TYPE'], [['Alice', 'user']], 4).map((line) => line.text)).toEqual([
      '╭──╮', '│A…│', '╰──╯',
    ])
    expect(formatGridTable(['NAME', 'TYPE'], [['Alice', 'user']], 8).map((line) => line.text)).toEqual([
      '╭──────╮', '│Alice │', '╰──────╯',
    ])
  })

  it('formats a million-character grid cell within the requested width', () => {
    const lines = formatGridTable(['VALUE'], [['x'.repeat(1_000_000)]], 80)

    expect(lines.map((line) => line.kind)).toEqual([
      'border', 'header', 'separator', 'row', 'border',
    ])
    expect(lines.every((line) => line.width === stringWidth(line.text) && line.width <= 80)).toBe(true)
  })

  it('measures 150,000 rows without overflowing the call stack', () => {
    const rows = Array.from({ length: 150_000 }, (_, index) => [`row-${index}`])
    const plainLines = formatTable(['VALUE'], rows, 20)
    const gridLines = formatGridTable(['VALUE'], rows, 20)

    expect(plainLines).toHaveLength(rows.length + 1)
    expect(gridLines).toHaveLength(rows.length * 2 + 3)
    expect(plainLines.every((line) => line.width <= 20)).toBe(true)
    expect(gridLines.every((line) => line.width === stringWidth(line.text) && line.width <= 20)).toBe(true)
  }, 15_000)
})
