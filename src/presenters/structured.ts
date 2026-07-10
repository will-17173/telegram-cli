import YAML from 'yaml'

export type OutputFormat = 'json' | 'yaml' | 'rich'
const SCHEMA_VERSION = '1'

export type ResolveOutputOptions = {
  json?: boolean
  yaml?: boolean
  isTty?: boolean
}

export function resolveOutputFormat(options: ResolveOutputOptions): OutputFormat {
  if (options.json && options.yaml) {
    throw new Error('Use only one of --json or --yaml.')
  }
  if (options.yaml) return 'yaml'
  if (options.json) return 'json'

  const mode = (process.env.OUTPUT || 'auto').trim().toLowerCase()
  if (mode === 'yaml' || mode === 'json' || mode === 'rich') return mode
  return options.isTty === false ? 'yaml' : 'rich'
}

export function successPayload(data: unknown): Record<string, unknown> {
  return { ok: true, schema_version: SCHEMA_VERSION, data }
}

export function errorPayload(code: string, message: string, details?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message }
  if (details !== undefined) error.details = details
  return { ok: false, schema_version: SCHEMA_VERSION, error }
}

export function dumpStructured(payload: unknown, format: 'json' | 'yaml'): string {
  if (format === 'json') return JSON.stringify(payload, null, 2)
  return YAML.stringify(payload, { sortMapEntries: false })
}
