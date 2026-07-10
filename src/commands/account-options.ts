import { getDataDir } from '../config/env.js'
import { resolveAccountContext } from '../account/account-context.js'
import type { AccountContext } from '../account/account-presets.js'
import { renderResult } from '../cli/output.js'
import { outputFormatConflict, type HandlerResult, type OutputFlags } from './types.js'

export type AccountCommandOptions = OutputFlags & {
  account?: string
}

export async function runWithAccountContext<T>(
  options: AccountCommandOptions,
  handler: (context: AccountContext) => Promise<HandlerResult<T> | void> | (HandlerResult<T> | void),
): Promise<void> {
  const conflict = outputFormatConflict(options)
  if (conflict) {
    await renderResult(conflict, { yaml: true })
    return
  }

  let context: AccountContext
  try {
    context = resolveAccountContext({
      explicitName: options.account,
      dataDir: getDataDir(),
    })
  } catch (error) {
    await renderResult(accountFailureFromError(error), options)
    return
  }

  const result = await handler(context)
  if (result !== undefined) {
    await renderResult(result, options)
  }
}

export function accountFailureFromError(error: unknown): HandlerResult<never> {
  const message = error instanceof Error ? error.message : String(error)
  const [code, detail] = splitError(message)

  if (code === 'account_required' || code === 'account_not_found') {
    return {
      ok: false,
      error: {
        code,
        message: detail,
      },
    }
  }

  return {
    ok: false,
    error: {
      code: 'account_store_error',
      message,
    },
  }
}

function splitError(message: string): [string, string] {
  const separator = ': '
  const index = message.indexOf(separator)
  if (index < 0) {
    return ['', message]
  }
  return [message.slice(0, index), message.slice(index + separator.length)]
}
