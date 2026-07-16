import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

const LEGACY_MODULES = [
  ['raw', 'message'].join('-'),
  ['raw', 'media', 'location'].join('-'),
  ['listen', 'attachment'].join('-'),
] as const

const LEGACY_FILES = [
  ['src/services/listen', 'attachment.ts'].join('-'),
  ['src/telegram/raw', 'message.ts'].join('-'),
  ['src/telegram/raw', 'media', 'location.ts'].join('-'),
  ['tests/services/listen', 'attachment.test.ts'].join('-'),
  ['tests/telegram/raw', 'message.test.ts'].join('-'),
  ['tests/telegram/raw', 'media', 'location.test.ts'].join('-'),
] as const

describe('media boundary', () => {
  it('removes legacy raw media parser files', () => {
    for (const file of LEGACY_FILES) {
      expect(fileExists(file), `${file} should be deleted`).toBe(false)
    }
  })

  it('keeps app layers from importing legacy media parsers', () => {
    const files = [
      ...sourceFiles('src/services'),
      ...sourceFiles('src/presenters'),
      ...sourceFiles('src/web'),
      ...sourceFiles('src/commands'),
      ...sourceFiles('src/storage'),
    ]
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      return LEGACY_MODULES
        .filter((moduleName) => source.includes(moduleName))
        .map((moduleName) => `${file} -> ${moduleName}`)
    })

    expect(offenders).toEqual([])
  })

  it('keeps functional source code away from raw media extraction helpers', () => {
    const files = [
      ...sourceFiles('src'),
      ...sourceFiles('web'),
    ]
    const banned = [
      ['discover', 'Listen', 'Attachments'].join(''),
      ['extract', 'Grouped', 'Id'].join(''),
      ['extract', 'Reply', 'To', 'Message', 'Id'].join(''),
      ['extract', 'Media', 'Location'].join(''),
    ]
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      return banned
        .filter((symbol) => source.includes(symbol))
        .map((symbol) => `${file} -> ${symbol}`)
    })

    expect(offenders).toEqual([])
  })
})

function fileExists(path: string): boolean {
  try {
    statSync(join(ROOT, relative('.', path)))
    return true
  } catch {
    return false
  }
}

function sourceFiles(directory: string): string[] {
  const absolute = join(ROOT, directory)
  let entries
  try {
    entries = readdirSync(absolute, { withFileTypes: true })
  } catch {
    return []
  }

  return entries.flatMap((entry) => {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(child)
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [child] : []
  })
}
