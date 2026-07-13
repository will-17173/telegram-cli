export type OutputFlags = {
  json?: boolean
  yaml?: boolean
  markdown?: boolean
}

export type CommandResult<T = unknown> = {
  ok: true
  data: T
  human?: HumanOutput
}

export type CommandFailure = {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type HandlerResult<T = unknown> = CommandResult<T> | CommandFailure

export type DetailField = {
  label: string
  value: string
  tone?: 'default' | 'success' | 'warning' | 'danger'
}

export type HumanOutput =
  | { kind: 'text'; text: string }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][]; emptyText?: string }
  | { kind: 'detail'; title: string; fields: DetailField[] }
  | {
    kind: 'summary'
    title: string
    fields: DetailField[]
    table?: { columns: string[]; rows: string[][]; emptyText?: string }
  }
  | { kind: 'timeline'; title: string; rows: Array<{ period: string; count: number }> }

export type AppContext = {
  verbose: boolean
}

export function outputFormatConflict(options: OutputFlags): CommandFailure | undefined {
  const selected = [options.json, options.yaml, options.markdown].filter(Boolean).length
  if (selected <= 1) return undefined
  return {
    ok: false,
    error: {
      code: 'invalid_output_format',
      message: 'Use only one of --json, --yaml, or --markdown.',
    },
  }
}
