import React from 'react'
import { Box, Text, render, type RenderOptions } from 'ink'
import type { HandlerResult } from '../../commands/types.js'
import { DetailView } from './DetailView.js'
import { TableView } from './TableView.js'
import { TimelineView } from './TimelineView.js'

export async function renderInkResult(
  result: HandlerResult,
  options: Pick<RenderOptions, 'stdout'> = {},
): Promise<void> {
  if (!result.ok) return
  let markRendered: () => void = () => {}
  const firstRender = new Promise<void>((resolve) => {
    markRendered = resolve
  })
  const terminalWidth = options.stdout?.columns ?? process.stdout.columns ?? 80
  const app = render(<InkRenderer result={result} terminalWidth={terminalWidth} />, {
    ...options,
    patchConsole: false,
    onRender: markRendered,
  })
  const exit = app.waitUntilExit()
  await firstRender
  app.unmount()
  await exit
}

export function InkRenderer({
  result,
  terminalWidth,
}: {
  result: HandlerResult
  terminalWidth?: number
}): React.JSX.Element {
  if (!result.ok) return <Text>error</Text>
  const human = result.human ?? { kind: 'text', text: JSON.stringify(result.data, null, 2) }

  if (human.kind === 'text') {
    return (
      <Text>{human.text}</Text>
    )
  }

  if (human.kind === 'table') {
    return <TableView {...human} terminalWidth={terminalWidth} />
  }

  if (human.kind === 'detail') {
    return <DetailView {...human} />
  }

  if (human.kind === 'summary') {
    return (
      <Box flexDirection="column">
        <DetailView title={human.title} fields={human.fields} />
        {human.table ? <TableView {...human.table} terminalWidth={terminalWidth} /> : null}
      </Box>
    )
  }

  if (human.kind === 'timeline') {
    return <TimelineView {...human} terminalWidth={terminalWidth} />
  }

  return <Text>No output.</Text>
}
