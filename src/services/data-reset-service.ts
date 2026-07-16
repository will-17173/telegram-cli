import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { accountArchivePath, accountDbPath } from '../account/account-presets.js'
import type { HandlerResult } from '../commands/types.js'

export type DataResetResult = {
  accounts_reset: string[]
  removed_paths: string[]
}

export type DataResetFailure = {
  account: string
  path: string
  code: string | null
  message: string
}

type ResetTarget = {
  account: string
  path: string
}

export class DataResetService {
  private readonly dataDir: string
  private readonly removePath: (path: string) => void

  constructor(input: { dataDir: string; removePath?: (path: string) => void }) {
    this.dataDir = resolve(input.dataDir)
    this.removePath = input.removePath ?? ((path) => rmSync(path, { recursive: true, force: true }))
  }

  reset(input: { accountNames: string[]; confirmed: boolean }): HandlerResult<DataResetResult> {
    if (!input.confirmed) {
      return {
        ok: false,
        error: {
          code: 'confirmation_required',
          message: 'Pass --yes to delete local message databases and default archives.',
        },
      }
    }

    const preflight = this.preflight(input.accountNames)
    if (!preflight.ok) return preflight

    const removedPaths: string[] = []
    const failures: DataResetFailure[] = []
    for (const target of preflight.data.targets) {
      if (lstatIfExists(target.path) == null) continue
      try {
        this.removePath(target.path)
        removedPaths.push(target.path)
      } catch (error) {
        failures.push({
          account: target.account,
          path: target.path,
          code: errorCode(error),
          message: errorMessage(error),
        })
      }
    }

    if (failures.length > 0) {
      return {
        ok: false,
        error: {
          code: 'data_reset_partial_failure',
          message: 'Some local data could not be reset.',
          details: {
            accounts_reset: preflight.data.accountNames,
            removed_paths: removedPaths,
            failures,
          },
        },
      }
    }

    return {
      ok: true,
      data: {
        accounts_reset: preflight.data.accountNames,
        removed_paths: removedPaths,
      },
      human: {
        kind: 'text',
        text: `Reset local data for ${preflight.data.accountNames.length} ${preflight.data.accountNames.length === 1 ? 'account' : 'accounts'}.`,
      },
    }
  }

  private preflight(accountNames: string[]): HandlerResult<{ accountNames: string[]; targets: ResetTarget[] }> {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      const realDataDir = realpathSync(this.dataDir)
      const targets = accountNames.flatMap((account) => resetTargets(this.dataDir, account))

      for (const target of targets) {
        assertContained(this.dataDir, target.path)
        assertExistingAncestorsStayInsideRoot(this.dataDir, realDataDir, target.path)
      }

      return {
        ok: true,
        data: { accountNames, targets },
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'data_reset_path_unsafe',
          message: errorMessage(error),
        },
      }
    }
  }
}

function resetTargets(dataDir: string, account: string): ResetTarget[] {
  const db = accountDbPath(dataDir, account)
  return [
    { account, path: db },
    { account, path: `${db}-wal` },
    { account, path: `${db}-shm` },
    { account, path: accountArchivePath(dataDir, account) },
  ]
}

function assertContained(root: string, target: string): void {
  const relation = relative(root, target)
  if (relation.length === 0 || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`reset path escapes data root: ${target}`)
  }
}

function assertExistingAncestorsStayInsideRoot(configuredRoot: string, realRoot: string, target: string): void {
  const relation = relative(configuredRoot, target)
  const parts = relation.split(sep).filter(Boolean)
  let current = configuredRoot
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part)
    const stat = lstatIfExists(current)
    if (stat == null) continue
    if (!stat.isSymbolicLink()) continue
    const real = realpathSync(current)
    if (!isRealPathInside(realRoot, real)) {
      throw new Error(`reset path ancestor escapes data root: ${current}`)
    }
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function isRealPathInside(root: string, path: string): boolean {
  const relation = relative(root, path)
  return relation.length === 0 || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
