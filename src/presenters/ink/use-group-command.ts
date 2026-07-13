import { useCallback, useRef, useState } from 'react'

import type { GroupCommandExecutionResult } from '../../group-commands/executor.js'
import { completeGroupCommand, parseGroupCommand } from '../../group-commands/parser.js'

export type GroupCommandState =
  | { kind: 'closed' }
  | { kind: 'menu'; selectedIndex: number }
  | { kind: 'executing' }
  | { kind: 'result'; result: GroupCommandExecutionResult }
  | { kind: 'error'; message: string; usage?: string }
  | { kind: 'confirm'; pending: GroupCommandExecutionResult }
  | { kind: 'confirm-title'; pending: GroupCommandExecutionResult }
  | { kind: 'select-permissions'; pending: GroupCommandExecutionResult }

export type GroupCommandSubmitResult =
  | { kind: 'complete'; input: string }
  | { kind: 'error'; message: string; usage?: string }
  | { kind: 'result'; result: GroupCommandExecutionResult }
  | { kind: 'pending'; pending: GroupCommandExecutionResult }

export function createGroupCommandController({ execute }: {
  execute: (request: Extract<ReturnType<typeof parseGroupCommand>, { ok: true }>['request']) => Promise<GroupCommandExecutionResult>
}) {
  return { async submit(input: string, selectedIndex: number): Promise<GroupCommandSubmitResult> {
    const completed = completeGroupCommand(input, selectedIndex)
    if (completed !== input) return { kind: 'complete', input: completed }
    const parsed = parseGroupCommand(input)
    if (!parsed.ok) return { kind: 'error', message: parsed.error.message, usage: parsed.error.usage }
    const result = await execute(parsed.request)
    if (!result.ok && ('confirmation' in result || 'selectionRequired' in result)) return { kind: 'pending', pending: result }
    return { kind: 'result', result }
  } }
}

export function useGroupCommand(execute: Parameters<typeof createGroupCommandController>[0]['execute']) {
  const [state, setState] = useState<GroupCommandState>({ kind: 'closed' })
  const generation = useRef(0)
  const controller = createGroupCommandController({ execute })
  const submit = useCallback(async (input: string, selectedIndex: number) => {
    const owned = ++generation.current
    setState({ kind: 'executing' })
    const outcome = await controller.submit(input, selectedIndex)
    if (owned !== generation.current) return outcome
    if (outcome.kind === 'error') setState(outcome)
    else if (outcome.kind === 'result') setState({ kind: 'result', result: outcome.result })
    else if (outcome.kind === 'pending') {
      const pending = outcome.pending
      setState('selectionRequired' in pending
        ? { kind: 'select-permissions', pending }
        : 'confirmation' in pending
          ? { kind: pending.confirmation.risk, pending }
          : { kind: 'result', result: pending })
    } else setState({ kind: 'menu', selectedIndex })
    return outcome
  }, [execute])
  const close = useCallback(() => { generation.current++; setState({ kind: 'closed' }) }, [])
  return { state, setState, submit, close }
}
