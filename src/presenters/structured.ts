import YAML from 'yaml'

export type OutputFormat = 'json' | 'yaml' | 'markdown' | 'rich'
const SCHEMA_VERSION = '2'

export type ResolveOutputOptions = {
  json?: boolean
  yaml?: boolean
  markdown?: boolean
  isTty?: boolean
}

export function resolveOutputFormat(options: ResolveOutputOptions): OutputFormat {
  if (options.json && (options.yaml || options.markdown)) {
    throw new Error('Use only one of --json, --yaml, or --markdown.')
  }
  if (options.yaml && options.markdown) {
    throw new Error('Use only one of --json, --yaml, or --markdown.')
  }
  if (options.yaml) return 'yaml'
  if (options.json) return 'json'
  if (options.markdown) return 'markdown'

  const mode = (process.env.OUTPUT || 'auto').trim().toLowerCase()
  if (mode === 'yaml' || mode === 'json' || mode === 'rich' || mode === 'markdown') return mode
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
