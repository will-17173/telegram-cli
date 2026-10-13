import { useState } from 'react'
import type { DesktopTask } from '../../src/web/workspace-types.js'
import { copyDesktopText, isDesktop, revealDesktopPath, saveDesktopText } from './desktop.js'
import { formatDateForLocale, formatMessage, type Locale } from './i18n.js'
import { errorText } from './workspace-form.js'
import { ListenComposer } from './ListenComposer.js'
import { taskStatusLabel, workspaceMessages } from './workspace-i18n.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function unwrapTaskResult(result: unknown): unknown {
  return isRecord(result) && result.ok === true && Object.hasOwn(result, 'data') ? result.data : result
}

export function taskResultError(result: unknown): { code: string; message: string; details?: unknown } | null {
  if (!isRecord(result) || result.ok !== false || !isRecord(result.error)) return null
  return {
    code: String(result.error.code ?? 'error'),
    message: String(result.error.message ?? ''),
    ...(Object.hasOwn(result.error, 'details') ? { details: result.error.details } : {}),
  }
}

export function resultColumns(rows: unknown[]): string[] {
  const columns = new Set<string>()
  for (const row of rows.slice(0, 100)) {
    if (isRecord(row)) for (const key of Object.keys(row)) columns.add(key)
  }
  return [...columns].slice(0, 16)
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function markdownCell(value: unknown): string {
  return compactValue(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

export function resultMarkdown(value: unknown): string {
  const data = unwrapTaskResult(value)
  if (Array.isArray(data) && data.length > 0 && data.every(isRecord)) {
    const columns = [...new Set(data.flatMap(row => Object.keys(row)))]
    return `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${data.map(row => `| ${columns.map(column => markdownCell(row[column])).join(' | ')} |`).join('\n')}\n`
  }
  if (isRecord(data)) return `| Field | Value |\n| --- | --- |\n${Object.entries(data).map(([key, item]) => `| ${markdownCell(key)} | ${markdownCell(item)} |`).join('\n')}\n`
  return `${compactValue(data)}\n`
}

function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export type ResultExportFormat = 'json' | 'yaml' | 'md'

function taskExportValue(task: DesktopTask): unknown {
  return task.result ?? { status: task.status, stdout: task.stdout, stderr: task.stderr, exitCode: task.exitCode }
}

export async function resultExportFile(task: DesktopTask, format: ResultExportFormat): Promise<{ filename: string; text: string; mime: string }> {
  const fileBase = `tg-${task.commandId.replace(/[^a-z0-9-]+/gi, '-')}-${task.id.slice(0, 8)}`
  const exported = taskExportValue(task)
  if (format === 'yaml') {
    const { stringify } = await import('yaml')
    return { filename: `${fileBase}.yaml`, text: stringify(exported), mime: 'application/yaml;charset=utf-8' }
  }
  if (format === 'md') return { filename: `${fileBase}.md`, text: resultMarkdown(exported), mime: 'text/markdown;charset=utf-8' }
  return { filename: `${fileBase}.json`, text: jsonText(exported), mime: 'application/json;charset=utf-8' }
}

export async function saveTaskResult(task: DesktopTask, format: ResultExportFormat): Promise<string | null> {
  const file = await resultExportFile(task, format)
  if (isDesktop()) return saveDesktopText({ filename: file.filename, text: file.text })
  downloadText(file.filename, file.text, file.mime)
  return null
}

export async function copyTaskResult(task: DesktopTask): Promise<void> {
  const text = jsonText(taskExportValue(task))
  if (isDesktop() && await copyDesktopText(text)) return
  await navigator.clipboard.writeText(text)
}

function ValuePreview({ value, locale, depth = 0 }: { value: unknown; locale: Locale; depth?: number }) {
  if (value == null) return <span className="workspace-null">—</span>
  if (typeof value === 'boolean') return <span>{value ? workspaceMessages[locale].enabled : workspaceMessages[locale].disabled}</span>
  if (typeof value !== 'object') return <span className="workspace-value">{String(value).slice(0, 4000)}{String(value).length > 4000 ? '…' : ''}</span>
  if (depth >= 4) return <pre className="workspace-nested-preview">{jsonText(value).slice(0, 4000)}</pre>
  return <StructuredResult data={value} locale={locale} depth={depth + 1} />
}

export function StructuredResult({ data, locale, depth = 0 }: { data: unknown; locale: Locale; depth?: number }) {
  const t = workspaceMessages[locale]
  if (Array.isArray(data)) {
    if (data.length === 0) return <p className="workspace-hint">{t.empty}</p>
    const rows = data.slice(0, 100)
    const columns = resultColumns(rows)
    return (
      <div className="workspace-data-collection">
        {columns.length > 0 && rows.every(isRecord) ? (
          <div className="workspace-table-scroll" tabIndex={0} role="region" aria-label={t.result}>
            <table className="workspace-result-table">
              <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
              <tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}><ValuePreview value={row[column]} locale={locale} depth={depth} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : <ol className="workspace-result-list">{rows.map((row, index) => <li key={index}><ValuePreview value={row} locale={locale} depth={depth} /></li>)}</ol>}
        {data.length > 100 ? <p className="workspace-hint">{formatMessage(t.limited, { count: 100 })}</p> : null}
      </div>
    )
  }
  if (isRecord(data)) {
    const fields = Object.entries(data)
    if (fields.length === 0) return <p className="workspace-hint">{t.empty}</p>
    return <dl className="workspace-result-details">{fields.slice(0, 50).map(([key, value]) => (
      <div key={key}>
        <dt>{key}</dt>
        <dd><ValuePreview value={value} locale={locale} depth={depth} /></dd>
      </div>
    ))}{fields.length > 50 ? <div><dt>…</dt><dd>{formatMessage(t.limited, { count: 50 })}</dd></div> : null}</dl>
  }
  return <ValuePreview value={data} locale={locale} depth={depth} />
}

export function resultPaths(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return [...new Set(value.slice(0, 100).flatMap(item => resultPaths(item, depth + 1)))].slice(0, 8)
  const paths: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /path|directory|destination|output/i.test(key) && /^(\/|[a-zA-Z]:[\\/])/.test(item)) paths.push(item)
    else paths.push(...resultPaths(item, depth + 1))
    if (paths.length >= 8) break
  }
  return [...new Set(paths)].slice(0, 8)
}

export function TaskResult({ task, locale, onCancel, cancelling = false, listenChat }: {
  task: DesktopTask | null
  locale: Locale
  onCancel?: () => void
  cancelling?: boolean
  listenChat?: string
}) {
  const t = workspaceMessages[locale]
  const [actionError, setActionError] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const [exporting, setExporting] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  if (task === null) return <div className="workspace-empty-result"><span className="workspace-empty-symbol" aria-hidden="true">↳</span><p>{t.noResult}</p></div>
  const error = taskResultError(task.result)
  const data = unwrapTaskResult(task.result)
  const native = isDesktop()
  const paths = native ? resultPaths(data) : []

  const copy = async () => {
    setActionError('')
    try {
      await copyTaskResult(task)
      setCopiedId(task.id)
    } catch (problem) { setActionError(errorText(problem)) }
  }

  const save = async (format: ResultExportFormat) => {
    if (exporting) return
    setActionError('')
    setExporting(true)
    setSavedPath(null)
    try {
      setSavedPath(await saveTaskResult(task, format))
    } catch (problem) { setActionError(errorText(problem)) }
    finally { setExporting(false) }
  }

  return (
    <div className="workspace-task-result" aria-busy={task.status === 'running'}>
      <div className="workspace-task-heading">
        <span className={`workspace-status workspace-status-${task.status}`} role="status">{taskStatusLabel(task.status, locale)}</span>
        {task.status === 'running' && onCancel ? <button type="button" className="workspace-button workspace-button-danger" onClick={onCancel} disabled={cancelling}>{cancelling ? t.stopping : t.stop}</button> : null}
      </div>
      <dl className="workspace-task-meta">
        {task.account ? <div><dt>{t.account}</dt><dd>{task.account}</dd></div> : null}
        <div><dt>{t.started}</dt><dd>{formatDateForLocale(task.startedAt, locale)}</dd></div>
        {task.finishedAt ? <div><dt>{t.finished}</dt><dd>{formatDateForLocale(task.finishedAt, locale)}</dd></div> : null}
        {task.exitCode !== null ? <div><dt>{t.exitCode}</dt><dd>{task.exitCode}</dd></div> : null}
      </dl>
      {error ? <div className="workspace-error" role="alert"><strong>{error.code}</strong><p>{error.message}</p>{error.details !== undefined ? <StructuredResult data={error.details} locale={locale} /> : null}</div> : null}
      {task.result !== null && !error ? <div className="workspace-structured-result"><StructuredResult data={data} locale={locale} /></div> : null}
      {task.status === 'failed' && !error ? <p className="workspace-error" role="alert">{task.stderr.trim() || `${t.failed}${task.exitCode === null ? '' : ` (${task.exitCode})`}`}</p> : null}
      {task.result === null && task.status === 'succeeded' && task.stdout === '' && task.stderr === '' ? <p className="workspace-hint">{t.empty}</p> : null}
      {paths.length > 0 ? <div className="workspace-result-paths">{paths.map(path => <button key={path} type="button" className="workspace-button" onClick={() => { void revealDesktopPath(path).catch(problem => setActionError(errorText(problem))) }} title={path}>{t.reveal}: {path}</button>)}</div> : null}
      <div className="workspace-result-actions" aria-busy={exporting}>
        <button type="button" className="workspace-button" onClick={() => { void copy() }}>{copiedId === task.id ? t.copied : t.copy}</button>
        <button type="button" className="workspace-button" onClick={() => { void save('json') }} disabled={exporting}>{native ? t.saveJson : t.json}</button>
        <button type="button" className="workspace-button" onClick={() => { void save('yaml') }} disabled={exporting}>{native ? t.saveYaml : t.yaml}</button>
        <button type="button" className="workspace-button" onClick={() => { void save('md') }} disabled={exporting}>{native ? t.saveMarkdown : t.markdown}</button>
      </div>
      {exporting ? <p className="workspace-hint" role="status">{t.savingResult}</p> : null}
      {savedPath ? <div className="workspace-result-paths"><p className="workspace-hint" role="status">{formatMessage(t.resultSavedTo, { path: savedPath })}</p><button type="button" className="workspace-button" onClick={() => { void revealDesktopPath(savedPath).catch(problem => setActionError(errorText(problem))) }}>{t.reveal}</button></div> : null}
      {actionError ? <p className="workspace-error" role="alert">{actionError}</p> : null}
      {task.commandId === 'listen' && task.status === 'running' ? <ListenComposer key={task.id} taskId={task.id} locale={locale} defaultChat={listenChat} /> : null}
      {task.result !== null ? <details className="workspace-raw"><summary>{t.raw}</summary><pre>{jsonText(task.result).slice(0, 64_000)}</pre></details> : null}
      <details className="workspace-logs" open={task.status === 'running' || task.result === null || task.stderr !== ''}>
        <summary>{t.liveOutput}</summary>
        {task.truncated ? <p className="workspace-hint">{t.truncated}</p> : null}
        <h4>{t.stdout}</h4><pre className="workspace-log">{task.stdout || t.noOutput}</pre>
        {task.stderr !== '' ? <><h4>{t.stderr}</h4><pre className="workspace-log workspace-log-error">{task.stderr}</pre></> : null}
      </details>
    </div>
  )
}
