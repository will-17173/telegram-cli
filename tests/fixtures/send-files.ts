import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryDirectories: string[] = []

export function createSendFiles(names: string[]): string[] {
  const directory = createSendDirectory()
  return names.map((name) => {
    const path = join(directory, name)
    writeFileSync(path, name)
    return path
  })
}

export function createSendDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tg-cli-send-'))
  temporaryDirectories.push(directory)
  return directory
}

export function makeUnreadable(path: string): boolean {
  chmodSync(path, 0o000)
  try {
    accessSync(path, constants.R_OK)
    return false
  } catch {
    return true
  }
}

export function cleanupSendFiles(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}
