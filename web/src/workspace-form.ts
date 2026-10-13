import type { DesktopCommand, DesktopCommandInput, DesktopField, DesktopTask } from '../../src/web/workspace-types.js'

export type DraftValue = string | boolean | string[]
export type OperationDraft = Record<string, DraftValue>
export type FieldErrors = Record<string, 'required' | 'choice' | 'confirmation'>

export function fieldKey(kind: 'argument' | 'option', name: string): string {
  return `${kind}:${name}`
}

export function isConfirmationField(field: DesktopField): boolean {
  return field.name.replace(/[-_]/g, '').toLowerCase() === 'confirmtitle'
}

export function isSecretField(field: DesktopField): boolean {
  return /hash|password|secret|token|proxy/i.test(field.name)
}

export function isMultilineField(field: DesktopField): boolean {
  return /^(message|text|description|title)$/i.test(field.name)
}

export function pathSelectionKind(command: DesktopCommand, field: DesktopField): 'file' | 'files' | 'directory' | 'save' | null {
  if (/^(path|file)$/i.test(field.name)) return field.repeatable || field.variadic ? 'files' : 'file'
  if (field.name === 'output') return command.path[0] === 'export' ? 'save' : 'directory'
  return null
}

export function createOperationDraft(command: DesktopCommand, initialChat = ''): OperationDraft {
  const draft: OperationDraft = {}
  const add = (kind: 'argument' | 'option', field: DesktopField) => {
    if (kind === 'option' && field.name === 'yes') return
    const key = fieldKey(kind, field.name)
    if (field.kind === 'boolean') draft[key] = typeof field.defaultValue === 'boolean' ? field.defaultValue : field.negated === true
    else if (field.variadic || field.repeatable) draft[key] = Array.isArray(field.defaultValue) && field.defaultValue.length > 0 ? [...field.defaultValue] : ['']
    else draft[key] = typeof field.defaultValue === 'string' ? field.defaultValue : ''
    if (kind === 'argument' && field.name === 'chat' && initialChat !== '') draft[key] = initialChat
    if (kind === 'argument' && field.name === 'chats' && initialChat !== '' && field.variadic) draft[key] = [initialChat]
  }
  command.arguments.forEach(field => add('argument', field))
  command.options.forEach(field => add('option', field))
  return draft
}

export function operationRequiresAccount(command: DesktopCommand, draft: OperationDraft): boolean {
  return command.requiresAccount && !(command.id === 'data reset' && draft['option:allAccounts'] === true)
}

export function operationInput(command: DesktopCommand, draft: OperationDraft, account: string, confirmed = false): { input: DesktopCommandInput; errors: FieldErrors } {
  const input: DesktopCommandInput = { commandId: command.id, arguments: {}, options: {} }
  const requiresAccount = operationRequiresAccount(command, draft)
  if (requiresAccount && account !== '') input.account = account
  if (command.destructive) input.confirmed = confirmed
  const errors: FieldErrors = {}
  const add = (kind: 'argument' | 'option', field: DesktopField) => {
    if (kind === 'option' && field.name === 'yes') return
    const key = fieldKey(kind, field.name)
    const value = draft[key]
    const required = field.required || isConfirmationField(field)
    if (field.kind === 'boolean') {
      input.options![field.name] = typeof value === 'boolean' ? value : field.negated === true
      return
    }
    const normalized = field.variadic || field.repeatable
      ? (Array.isArray(value) ? value : [typeof value === 'string' ? value : '']).filter(item => item.trim() !== '')
      : (typeof value === 'string' ? value : '')
    const empty = Array.isArray(normalized) ? normalized.length === 0 : normalized.trim() === ''
    if (required && empty) errors[key] = 'required'
    if (!empty && field.choices && (Array.isArray(normalized) ? normalized : [normalized]).some(item => !field.choices!.includes(item))) errors[key] = 'choice'
    if (!empty) {
      if (kind === 'argument') input.arguments![field.name] = normalized
      else input.options![field.name] = normalized
    }
  }
  command.arguments.forEach(field => add('argument', field))
  command.options.forEach(field => add('option', field))
  if (requiresAccount && account === '') errors.account = 'required'
  if (command.destructive && !confirmed) errors.confirmation = 'confirmation'
  return { input, errors }
}

export function clearSecretValues(command: DesktopCommand, draft: OperationDraft): OperationDraft {
  const next = { ...draft }
  for (const [kind, fields] of [['argument', command.arguments], ['option', command.options]] as const) {
    for (const field of fields) if (isSecretField(field)) next[fieldKey(kind, field.name)] = field.repeatable || field.variadic ? [''] : ''
  }
  return next
}

export type TaskSummary = Omit<DesktopTask, 'stdout' | 'stderr' | 'result' | 'truncated'>

export function taskSummary(task: DesktopTask): TaskSummary {
  const { stdout: _stdout, stderr: _stderr, result: _result, truncated: _truncated, ...summary } = task
  return summary
}

export function boundedTask(task: DesktopTask): DesktopTask {
  const maxLogLength = 64_000
  return { ...task, stdout: task.stdout.slice(-maxLogLength), stderr: task.stderr.slice(-maxLogLength), truncated: task.truncated || task.stdout.length > maxLogLength || task.stderr.length > maxLogLength }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
