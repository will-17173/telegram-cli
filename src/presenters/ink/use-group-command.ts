import { useCallback, useEffect, useRef, useState } from 'react'

import type { GroupCommandExecutionResult } from '../../group-commands/executor.js'
import { completeGroupCommand, parseGroupCommand, type ParsedGroupCommandRequest } from '../../group-commands/parser.js'

export type GroupCommandState =
  | { kind: 'closed' }
  | { kind: 'menu'; selectedIndex: number }
  | { kind: 'executing'; irreversible?: boolean }
  | { kind: 'result'; result: GroupCommandExecutionResult }
  | { kind: 'error'; message: string; usage?: string }
  | { kind: 'password'; request: ParsedGroupCommandRequest }
  | { kind: 'confirm'; pending: GroupCommandExecutionResult; request: ParsedGroupCommandRequest; originalInput: string; selectedIndex: number }
  | { kind: 'confirm-title'; pending: GroupCommandExecutionResult; request: ParsedGroupCommandRequest; originalInput: string; stage: 'confirm' | 'title'; selectedIndex: number; confirmText: string; mismatch?: boolean }
  | { kind: 'select-permissions'; pending: GroupCommandExecutionResult; request: ParsedGroupCommandRequest; originalInput: string; selectedIndex: number; selected: readonly string[]; warning?: string }

export type GroupCommandSubmitResult =
  | { kind: 'complete'; input: string }
  | { kind: 'error'; message: string; usage?: string }
  | { kind: 'result'; result: GroupCommandExecutionResult }
  | { kind: 'pending'; pending: GroupCommandExecutionResult; request: ParsedGroupCommandRequest; input: string }

type ExecutionOptions = { confirmed?: boolean; confirmationTitle?: string; ownershipPassword?: string }
export function createGroupCommandController({ execute }: {
  execute: (request: Extract<ReturnType<typeof parseGroupCommand>, { ok: true }>['request'], options?: ExecutionOptions) => Promise<GroupCommandExecutionResult>
}) {
  return { async submit(input: string, selectedIndex: number): Promise<GroupCommandSubmitResult> {
    const completed = completeGroupCommand(input, selectedIndex)
    if (completed !== input) return { kind: 'complete', input: completed }
    const parsed = parseGroupCommand(input)
    if (!parsed.ok) return { kind: 'error', message: parsed.error.message, usage: parsed.error.usage }
    let result: GroupCommandExecutionResult
    try { result = await execute(parsed.request) }
    catch (error) { return { kind: 'error', message: error instanceof Error ? error.message : String(error) } }
    if (!result.ok && ('confirmation' in result || 'selectionRequired' in result)) return {
      kind: 'pending', pending: result, request: freezeRequest(parsed.request), input,
    }
    return { kind: 'result', result }
  } }
}

function freezeRequest(request: ParsedGroupCommandRequest): ParsedGroupCommandRequest {
  const values = Object.fromEntries(Object.entries(request.values).map(([key, value]) => [
    key, Array.isArray(value) ? Object.freeze([...value]) : value,
  ]))
  return Object.freeze({ ...request, values: Object.freeze(values) }) as ParsedGroupCommandRequest
}

export function useGroupCommand(execute: Parameters<typeof createGroupCommandController>[0]['execute']) {
  const [state, setState] = useState<GroupCommandState>({ kind: 'closed' })
  const generation = useRef<object>({})
  const passwordGeneration = useRef<object>({})
  const executionLock = useRef<object | null>(null)
  const passwordToken = passwordGeneration.current
  useEffect(() => () => {
    generation.current = {}
    passwordGeneration.current = {}
  }, [])
  const controller = createGroupCommandController({ execute })
  const applyOutcome = useCallback((outcome: GroupCommandSubmitResult, selectedIndex: number) => {
    if (outcome.kind === 'error') setState(outcome)
    else if (outcome.kind === 'result') setState({ kind: 'result', result: outcome.result })
    else if (outcome.kind === 'pending') {
      const pending = outcome.pending
      setState('selectionRequired' in pending
        ? { kind: 'select-permissions', pending, request: outcome.request, originalInput: outcome.input, selectedIndex: 0, selected: [] }
        : 'confirmation' in pending
          ? pending.confirmation.risk === 'confirm-title'
            ? { kind: 'confirm-title', pending, request: outcome.request, originalInput: outcome.input, stage: 'confirm', selectedIndex: 1, confirmText: '' }
            : { kind: 'confirm', pending, request: outcome.request, originalInput: outcome.input, selectedIndex: 1 }
          : { kind: 'result', result: pending })
    } else setState({ kind: 'menu', selectedIndex })
  }, [])
  const submit = useCallback(async (input: string, selectedIndex: number) => {
    if (executionLock.current !== null) return { kind: 'error', message: 'Command is already running.', applied: false } as const
    passwordGeneration.current = {}
    const owned = {}
    generation.current = owned
    executionLock.current = owned
    setState({ kind: 'executing' })
    try {
      const outcome = await controller.submit(input, selectedIndex)
      if (owned !== generation.current) return { ...outcome, applied: false }
      applyOutcome(outcome, selectedIndex)
      return { ...outcome, applied: true }
    } finally {
      if (executionLock.current === owned) executionLock.current = null
    }
  }, [execute, applyOutcome])
  const submitParsed = useCallback(async (request: ParsedGroupCommandRequest, originalInput: string, selectedIndex = 0) => {
    if (executionLock.current !== null) return { kind: 'error', message: 'Command is already running.', applied: false } as const
    passwordGeneration.current = {}
    const owned = {}
    generation.current = owned
    executionLock.current = owned
    setState({ kind: 'executing' })
    let outcome: GroupCommandSubmitResult
    try {
      try {
        const result = await execute(request)
        outcome = !result.ok && ('confirmation' in result || 'selectionRequired' in result)
          ? { kind: 'pending', pending: result, request: freezeRequest(request), input: originalInput }
          : { kind: 'result', result }
      } catch (error) {
        outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      }
      if (owned !== generation.current) return { ...outcome, applied: false }
      applyOutcome(outcome, selectedIndex)
      return { ...outcome, applied: true }
    } finally {
      if (executionLock.current === owned) executionLock.current = null
    }
  }, [execute, applyOutcome])
  const close = useCallback(() => { generation.current = {}; passwordGeneration.current = {}; setState({ kind: 'closed' }) }, [])
  const replaceState = useCallback((next: GroupCommandState) => {
    generation.current = {}
    passwordGeneration.current = {}
    setState(next)
  }, [])
  const runConfirmed = useCallback(async (request: ParsedGroupCommandRequest, confirmationTitle?: string) => {
    if (executionLock.current !== null) return
    passwordGeneration.current = {}
    const owned = {}
    generation.current = owned
    executionLock.current = owned
    setState({ kind: 'executing' })
    try {
      const result = await execute(request, { confirmed: true, confirmationTitle })
      if (owned !== generation.current) return
      setState(result.ok ? { kind: 'result', result } : 'secretRequired' in result
        ? { kind: 'password', request }
        : 'error' in result
          ? { kind: 'error', message: result.error.message }
          : { kind: 'error', message: 'Telegram did not accept the confirmation.' })
    } catch (error) {
      if (owned === generation.current) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (executionLock.current === owned) executionLock.current = null
    }
  }, [execute])
  const runWithOwnershipPassword = useCallback(async (ownershipPassword: string) => {
    if (state.kind !== 'password' || passwordToken !== passwordGeneration.current || executionLock.current !== null) {
      ownershipPassword = ''
      return
    }
    const { request } = state
    passwordGeneration.current = {}
    const owned = {}
    generation.current = owned
    executionLock.current = owned
    setState({ kind: 'executing', irreversible: true })
    let execution: Promise<GroupCommandExecutionResult>
    try {
      execution = execute(request, { confirmed: true, ownershipPassword })
    } catch {
      ownershipPassword = ''
      if (owned === generation.current) setState({ kind: 'error', message: 'Telegram ownership transfer failed.' })
      if (executionLock.current === owned) executionLock.current = null
      return
    }
    ownershipPassword = ''
    try {
      const result = await execution
      if (owned !== generation.current) return
      setState(result.ok ? { kind: 'result', result } : 'error' in result
        ? { kind: 'error', message: result.error.message }
        : { kind: 'error', message: 'Telegram did not accept the password.' })
    } catch {
      if (owned === generation.current) setState({ kind: 'error', message: 'Telegram ownership transfer failed.' })
    } finally {
      ownershipPassword = ''
      if (executionLock.current === owned) executionLock.current = null
    }
  }, [execute, state, passwordToken])
  return { state, setState: replaceState, submit, submitParsed, close, runConfirmed, runWithOwnershipPassword }
}
