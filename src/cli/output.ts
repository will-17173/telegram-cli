import type { HandlerResult } from '../commands/types.js'
import {
  dumpStructured,
  errorPayload,
  resolveOutputFormat,
  successPayload,
  type ResolveOutputOptions,
} from '../presenters/structured.js'
import { renderInkResult } from '../presenters/ink/render.js'

export async function renderResult(result: HandlerResult, options: ResolveOutputOptions): Promise<void> {
  if (options.json && options.yaml) {
    const payload = errorPayload('invalid_output_format', 'Use only one of --json or --yaml.')
    writeLine(process.stdout, dumpStructured(payload, 'yaml'))
    process.exitCode = 1
    return
  }

  const format = resolveOutputFormat({ ...options, isTty: options.isTty ?? process.stdout.isTTY === true })
  if (format === 'json' || format === 'yaml') {
    const payload = result.ok
      ? successPayload(result.data)
      : errorPayload(result.error.code, result.error.message, result.error.details)
    writeLine(process.stdout, dumpStructured(payload, format))
    if (!result.ok) process.exitCode = 1
    return
  }

  if (format === 'rich' && result.ok && result.human && result.human.kind !== 'text') {
    await renderInkResult(result)
    return
  }

  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`)
    process.exitCode = 1
    return
  }

  if (result.human?.kind === 'text') {
    process.stdout.write(`${result.human.text}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
  }
}

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text.endsWith('\n') ? text : `${text}\n`)
}
