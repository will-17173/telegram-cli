import type { HandlerResult } from '../commands/types.js'
import {
  dumpStructured,
  errorPayload,
  resolveOutputFormat,
  successPayload,
  type ResolveOutputOptions,
} from '../presenters/structured.js'
import { renderInkResult } from '../presenters/ink/render.js'
import { outputFormatConflict } from '../commands/types.js'
import { renderHumanMarkdown, renderMarkdownError } from '../presenters/markdown.js'

export async function renderResult(result: HandlerResult, options: ResolveOutputOptions): Promise<void> {
  const conflict = outputFormatConflict(options)
  if (conflict) {
    const payload = errorPayload(conflict.error.code, conflict.error.message, conflict.error.details)
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

  if (format === 'markdown') {
    if (!result.ok) {
      process.stderr.write(`${renderMarkdownError(result.error.code, result.error.message)}\n`)
      process.exitCode = 1
      return
    }

    if (result.human != null) {
      process.stdout.write(`${renderHumanMarkdown(result.human)}\n`)
      return
    }
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
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

  if (result.ok && result.human?.kind === 'text') {
    process.stdout.write(`${result.human.text}\n`)
    return
  }

  process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
}

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text.endsWith('\n') ? text : `${text}\n`)
}
