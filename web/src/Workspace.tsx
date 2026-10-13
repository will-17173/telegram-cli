import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { DesktopCategory, DesktopCommand, DesktopField, DesktopTask } from '../../src/web/workspace-types.js'
import { deleteJson, getJson, postJson } from './api.js'
import { chooseDesktopPath, isDesktop } from './desktop.js'
import { formatDateForLocale, type Locale } from './i18n.js'
import { listenDefaultChat } from './ListenComposer.js'
import {
  boundedTask,
  clearSecretValues,
  createOperationDraft,
  errorText,
  fieldKey,
  isConfirmationField,
  isMultilineField,
  isSecretField,
  operationInput,
  operationRequiresAccount,
  pathSelectionKind,
  taskSummary,
  type DraftValue,
  type FieldErrors,
  type OperationDraft,
  type TaskSummary,
} from './workspace-form.js'
import { categoryLabels, commandLabel, fieldLabel, taskStatusLabel, workspaceMessages } from './workspace-i18n.js'
import { TaskResult } from './workspace-result.js'
import './workspace.css'

const CATEGORIES: DesktopCategory[] = ['telegram', 'messages', 'groups', 'contacts', 'folders', 'notifications', 'accounts', 'settings', 'data']
const MAX_TASK_HISTORY = 60

function inputId(command: DesktopCommand, kind: 'argument' | 'option', field: DesktopField): string {
  return `operation-${encodeURIComponent(command.id)}-${kind}-${encodeURIComponent(field.name)}`
}

function OperationField({ command, field, kind, value, locale, error, onChange }: {
  command: DesktopCommand
  field: DesktopField
  kind: 'argument' | 'option'
  value: DraftValue | undefined
  locale: Locale
  error?: FieldErrors[string]
  onChange: (value: DraftValue) => void
}) {
  const t = workspaceMessages[locale]
  const id = inputId(command, kind, field)
  const required = field.required || isConfirmationField(field)
  const multiple = field.repeatable || field.variadic
  const secret = isSecretField(field)
  const pathKind = pathSelectionKind(command, field)
  const [pickerError, setPickerError] = useState('')
  const [choosing, setChoosing] = useState(false)
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hintId, ...(error ? [errorId] : [])].join(' ')
  const pick = async () => {
    if (!pathKind) return
    setChoosing(true)
    setPickerError('')
    try {
      const selected = await chooseDesktopPath({ kind: pathKind, defaultPath: typeof value === 'string' && value !== '' ? value : undefined })
      if (selected !== null) {
        if (multiple) {
          const previous = Array.isArray(value) ? value.filter(item => item.trim() !== '') : []
          onChange([...previous, ...(Array.isArray(selected) ? selected : [selected])])
        } else onChange(Array.isArray(selected) ? selected[0] ?? '' : selected)
      }
    } catch (problem) { setPickerError(errorText(problem)) }
    finally { setChoosing(false) }
  }

  if (field.kind === 'boolean') return (
    <div className="workspace-field workspace-boolean-field">
      <label htmlFor={id} className="workspace-check-label">
        <input id={id} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} aria-describedby={hintId} />
        <span>{fieldLabel(field, locale)}</span>
      </label>
      <p id={hintId} className="workspace-field-hint">{field.description || (value ? t.enabled : t.disabled)}</p>
    </div>
  )

  const values = multiple ? (Array.isArray(value) && value.length > 0 ? value : ['']) : [typeof value === 'string' ? value : '']
  const changeValue = (index: number, next: string) => {
    if (!multiple) onChange(next)
    else onChange(values.map((item, current) => current === index ? next : item))
  }
  const pickerLabel = pathKind === 'files' ? t.chooseFiles : pathKind === 'directory' ? t.chooseDirectory : pathKind === 'save' ? t.chooseSave : t.chooseFile
  return (
    <div className={`workspace-field${error ? ' workspace-field-invalid' : ''}${isConfirmationField(field) ? ' workspace-confirm-title' : ''}`}>
      <label htmlFor={id} className="workspace-field-label"><span>{fieldLabel(field, locale)}</span><span className="workspace-required">{required ? t.required : t.optional}</span></label>
      {values.map((item, index) => (
        <div key={index} className="workspace-value-row">
          {field.choices && !secret ? (
            <select id={index === 0 ? id : `${id}-${index}`} value={item} onChange={event => changeValue(index, event.target.value)} aria-label={index === 0 ? undefined : `${fieldLabel(field, locale)} ${index + 1}`} aria-required={required} aria-invalid={Boolean(error)} aria-describedby={describedBy}>
              <option value="">—</option>{field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          ) : isMultilineField(field) && !secret ? (
            <textarea id={index === 0 ? id : `${id}-${index}`} value={item} onChange={event => changeValue(index, event.target.value)} rows={field.name === 'message' || field.name === 'text' ? 4 : 2} aria-label={index === 0 ? undefined : `${fieldLabel(field, locale)} ${index + 1}`} aria-required={required} aria-invalid={Boolean(error)} aria-describedby={describedBy} />
          ) : (
            <input id={index === 0 ? id : `${id}-${index}`} type={secret ? 'password' : 'text'} value={item} onChange={event => changeValue(index, event.target.value)} autoComplete={secret ? 'off' : undefined} spellCheck={false} aria-label={index === 0 ? undefined : `${fieldLabel(field, locale)} ${index + 1}`} aria-required={required} aria-invalid={Boolean(error)} aria-describedby={describedBy} placeholder={field.name === 'chat' ? '@username / -100…' : undefined} />
          )}
          {multiple && values.length > 1 ? <button type="button" className="workspace-remove-value" aria-label={`${t.removeValue} ${index + 1}: ${fieldLabel(field, locale)}`} onClick={() => onChange(values.filter((_, current) => current !== index))}>×</button> : null}
        </div>
      ))}
      <div className="workspace-field-tools">
        {multiple ? <button type="button" className="workspace-text-button" onClick={() => onChange([...values, ''])}>{t.addValue}</button> : null}
        {pathKind && isDesktop() ? <button type="button" className="workspace-text-button" onClick={() => { void pick() }} disabled={choosing}>{choosing ? t.starting : pickerLabel}</button> : null}
      </div>
      <div id={hintId} className="workspace-field-hint">
        {isConfirmationField(field) ? t.exactTitleHint : secret ? t.secretHint : field.description}
        {multiple ? <span>{t.multipleHint}</span> : null}
        {pathKind ? <span>{t.manualPath}</span> : null}
      </div>
      {error ? <p id={errorId} className="workspace-inline-error">{error === 'choice' ? t.invalidChoice : t.requiredError}</p> : null}
      {pickerError ? <p className="workspace-inline-error" role="alert">{pickerError}</p> : null}
    </div>
  )
}

export function OperationFields({ command, draft, errors = {}, locale, onChange }: {
  command: DesktopCommand
  draft: OperationDraft
  errors?: FieldErrors
  locale: Locale
  onChange: (key: string, value: DraftValue) => void
}) {
  const t = workspaceMessages[locale]
  const requiredOptions = command.options.filter(field => field.name !== 'yes' && (field.required || isConfirmationField(field)))
  const advancedOptions = command.options.filter(field => field.name !== 'yes' && !field.required && !isConfirmationField(field))
  const hasAdvancedError = advancedOptions.some(field => errors[fieldKey('option', field.name)] !== undefined)
  const [advancedOpen, setAdvancedOpen] = useState(command.path[0] === 'config')
  const renderField = (field: DesktopField, kind: 'argument' | 'option') => <OperationField key={fieldKey(kind, field.name)} command={command} field={field} kind={kind} value={draft[fieldKey(kind, field.name)]} locale={locale} error={errors[fieldKey(kind, field.name)]} onChange={value => onChange(fieldKey(kind, field.name), value)} />
  return (
    <div className="workspace-fields">
      {command.arguments.map(field => renderField(field, 'argument'))}
      {requiredOptions.map(field => renderField(field, 'option'))}
      {command.arguments.length === 0 && requiredOptions.length === 0 && advancedOptions.length === 0 ? <p className="workspace-hint">{t.noParameters}</p> : null}
      {advancedOptions.length > 0 ? <details className="workspace-advanced" open={advancedOpen || hasAdvancedError} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
        <summary>{t.advanced}<span>{advancedOptions.length}</span></summary>
        <div className="workspace-advanced-fields">{advancedOptions.map(field => renderField(field, 'option'))}</div>
      </details> : null}
    </div>
  )
}

export type WorkspaceProps = {
  account: string
  locale: Locale
  onAccountsChanged?: () => void
  onDataChanged?: () => void
  initialCommand?: string
  initialChat?: string
}

export function Workspace({ account, locale, onAccountsChanged, onDataChanged, initialCommand, initialChat }: WorkspaceProps) {
  const t = workspaceMessages[locale]
  const [commands, setCommands] = useState<DesktopCommand[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [category, setCategory] = useState<DesktopCategory | 'all'>('all')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [commandId, setCommandId] = useState(initialCommand ?? 'status')
  const [drafts, setDrafts] = useState<Record<string, OperationDraft>>({})
  const [confirmed, setConfirmed] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState('')
  const [starting, setStarting] = useState(false)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<DesktopTask | null>(null)
  const [taskError, setTaskError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const errorSummary = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const selectedTaskId = useRef(taskId)
  selectedTaskId.current = taskId
  const callbackRef = useRef({ onAccountsChanged, onDataChanged })
  callbackRef.current = { onAccountsChanged, onDataChanged }
  const previousStatuses = useRef(new Map<string, DesktopTask['status']>())

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setCatalogError('')
    void getJson<DesktopCommand[]>('/api/workspace/commands').then(items => {
      if (!active) return
      setCommands(items)
      setCommandId(current => items.some(item => item.id === current) ? current : items[0]?.id ?? '')
    }).catch(problem => { if (active) setCatalogError(errorText(problem)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [catalogVersion])

  useEffect(() => {
    if (initialCommand === undefined) return
    setCommandId(initialCommand)
    setCategory('all')
    setSearch('')
  }, [initialCommand, initialChat])

  useEffect(() => {
    if (initialCommand === undefined) return
    if (initialChat !== undefined) {
      const target = commands.find(item => item.id === initialCommand)
      if (target?.arguments.some(field => field.name === 'chat')) {
        const key = `${account}\u0000${initialCommand}`
        setDrafts(current => ({ ...current, [key]: { ...createOperationDraft(target, initialChat), ...current[key], 'argument:chat': initialChat } }))
      }
    }
  }, [initialCommand, initialChat, commands, account])

  useEffect(() => {
    setConfirmed(false)
    setFieldErrors({})
    setSubmitError('')
  }, [commandId, account])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let delay = 4000
      try {
        const items = await getJson<DesktopTask[]>('/api/workspace/tasks')
        if (!active) return
        const summaries = items.slice(0, MAX_TASK_HISTORY).map(taskSummary)
        setTasks(summaries)
        setTaskError('')
        for (const item of summaries) {
          const previous = previousStatuses.current.get(item.id)
          if (item.status === 'succeeded' && previous === 'running') {
            if (item.commandId.startsWith('account ')) callbackRef.current.onAccountsChanged?.()
            else callbackRef.current.onDataChanged?.()
          }
        }
        previousStatuses.current = new Map(summaries.map(item => [item.id, item.status]))
        if (selectedTaskId.current === null && summaries.length > 0) setTaskId(summaries[0]!.id)
        delay = summaries.some(item => item.status === 'running') ? 1200 : 8000
      } catch (problem) { if (active) setTaskError(errorText(problem)) }
      finally { if (active) timer = setTimeout(() => { void poll() }, delay) }
    }
    void poll()
    return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
  }, [historyVersion])

  useEffect(() => {
    if (taskId === null) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setTask(current => current?.id === taskId ? current : null)
    const poll = async () => {
      let continuing = true
      try {
        const item = await getJson<DesktopTask>(`/api/workspace/tasks/${encodeURIComponent(taskId)}`)
        if (!active) return
        setTask(boundedTask(item))
        setTaskError('')
        continuing = item.status === 'running'
        setTasks(current => current.map(summary => summary.id === item.id ? taskSummary(item) : summary))
      } catch (problem) { if (active) setTaskError(errorText(problem)) }
      finally { if (active && continuing) timer = setTimeout(() => { void poll() }, 900) }
    }
    void poll()
    return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
  }, [taskId, historyVersion])

  const command = commands.find(item => item.id === commandId) ?? null
  const draftKey = `${account}\u0000${commandId}`
  const draft = command ? drafts[draftKey] ?? createOperationDraft(command, initialChat) : {}
  const requiresAccount = command ? operationRequiresAccount(command, draft) : false
  const scope = command?.id === 'data reset' && draft['option:allAccounts'] === true ? t.allAccounts : requiresAccount ? `${t.account}: ${account || '—'}` : t.globalOperation
  const listenChat = listenDefaultChat(drafts[`${task?.account ?? account}\u0000listen`] ?? (command?.id === 'listen' ? draft : {}))
  const visibleCommands = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase()
    return commands.filter(item => (category === 'all' || item.category === category) && (query === '' || `${item.id} ${commandLabel(item, locale)} ${commandLabel(item, locale === 'en' ? 'zh-CN' : 'en')} ${item.description} ${categoryLabels[locale][item.category]}`.toLowerCase().includes(query)))
  }, [commands, category, deferredSearch, locale])
  const counts = useMemo(() => {
    const result = new Map<DesktopCategory, number>()
    for (const item of commands) result.set(item.category, (result.get(item.category) ?? 0) + 1)
    return result
  }, [commands])

  const changeField = (key: string, value: DraftValue) => {
    if (!command) return
    setDrafts(current => ({ ...current, [draftKey]: { ...createOperationDraft(command, initialChat), ...current[draftKey], [key]: value } }))
    setFieldErrors(current => { const next = { ...current }; delete next[key]; return next })
    setConfirmed(false)
  }

  const run = async (event: FormEvent) => {
    event.preventDefault()
    if (!command || starting) return
    const { input, errors } = operationInput(command, draft, account, confirmed)
    setFieldErrors(errors)
    setSubmitError('')
    if (Object.keys(errors).length > 0) {
      setTimeout(() => errorSummary.current?.focus(), 0)
      return
    }
    setStarting(true)
    setDrafts(current => ({ ...current, [draftKey]: clearSecretValues(command, draft) }))
    setConfirmed(false)
    try {
      const created = await postJson<DesktopTask>('/api/workspace/tasks', input)
      if (!mounted.current) return
      setTaskId(created.id)
      setTask(boundedTask(created))
      setTasks(current => [taskSummary(created), ...current.filter(item => item.id !== created.id)].slice(0, MAX_TASK_HISTORY))
      previousStatuses.current.set(created.id, 'running')
      setHistoryVersion(current => current + 1)
    } catch (problem) { if (mounted.current) setSubmitError(errorText(problem)) }
    finally { if (mounted.current) setStarting(false) }
  }

  const cancel = async () => {
    if (taskId === null || cancelling) return
    const cancellingId = taskId
    setCancelling(true)
    try {
      const updated = await deleteJson<DesktopTask>(`/api/workspace/tasks/${encodeURIComponent(cancellingId)}`)
      if (!mounted.current) return
      if (selectedTaskId.current === cancellingId) setTask(boundedTask(updated))
      setTasks(current => current.map(item => item.id === updated.id ? taskSummary(updated) : item))
      setHistoryVersion(current => current + 1)
    } catch (problem) { if (mounted.current) setTaskError(errorText(problem)) }
    finally { if (mounted.current) setCancelling(false) }
  }

  return (
    <main className="workspace-layout">
      <aside className="workspace-navigation" aria-label={t.operations}>
        <div className="workspace-nav-top"><h2>{t.operations}<span>{commands.length}</span></h2><label className="workspace-search"><span className="workspace-sr-only">{t.searchOperations}</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t.searchOperations} /></label></div>
        <div className="workspace-categories" role="group" aria-label={t.operations}>
          <button type="button" className={category === 'all' ? 'is-selected' : ''} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>{t.all}<span>{commands.length}</span></button>
          {CATEGORIES.filter(item => counts.has(item)).map(item => <button key={item} type="button" className={category === item ? 'is-selected' : ''} aria-pressed={category === item} onClick={() => setCategory(item)}>{categoryLabels[locale][item]}<span>{counts.get(item)}</span></button>)}
        </div>
        <nav className="workspace-operation-list" aria-label={t.chooseOperation}>
          {loading ? <p className="workspace-hint" role="status">{t.loadingOperations}</p> : null}
          {catalogError ? <div className="workspace-error" role="alert"><p>{catalogError}</p><button type="button" className="workspace-button" onClick={() => setCatalogVersion(current => current + 1)}>{t.retry}</button></div> : null}
          {!loading && visibleCommands.length === 0 && !catalogError ? <p className="workspace-hint">{t.noOperations}</p> : null}
          {visibleCommands.map(item => <button key={item.id} type="button" className={`workspace-operation${commandId === item.id ? ' is-selected' : ''}`} aria-current={commandId === item.id ? 'page' : undefined} onClick={() => setCommandId(item.id)}><span>{commandLabel(item, locale)}</span><code>{item.id}</code>{item.destructive ? <span className="workspace-risk-dot" aria-label={t.review} title={t.review} /> : null}</button>)}
        </nav>
      </aside>
      <section className="workspace-form-panel" aria-label={t.parameters}>
        {command ? <>
          <header className="workspace-panel-heading"><span className="workspace-kicker">{categoryLabels[locale][command.category]}</span><h2>{commandLabel(command, locale)}</h2><p>{command.description}</p><div className="workspace-operation-context"><code>tg {command.id}</code><span>{scope}</span></div>{command.longRunning ? <p className="workspace-hint">{t.longRunning}</p> : null}</header>
          <form onSubmit={event => { void run(event) }} noValidate>
            {Object.keys(fieldErrors).length > 0 ? <div className="workspace-error workspace-error-summary" ref={errorSummary} role="alert" tabIndex={-1}>
              <strong>{t.problem}</strong><ul>{Object.entries(fieldErrors).map(([key, error]) => {
                if (key === 'account') return <li key={key}>{t.noAccount}</li>
                if (key === 'confirmation') return <li key={key}><a href="#operation-confirmation">{t.confirmError}</a></li>
                const [kind, ...parts] = key.split(':')
                const field = (kind === 'argument' ? command.arguments : command.options).find(item => item.name === parts.join(':'))
                return field ? <li key={key}><a href={`#${inputId(command, kind === 'argument' ? 'argument' : 'option', field)}`}>{fieldLabel(field, locale)}: {error === 'choice' ? t.invalidChoice : t.requiredError}</a></li> : null
              })}</ul>
            </div> : null}
            <OperationFields key={draftKey} command={command} draft={draft} errors={fieldErrors} locale={locale} onChange={changeField} />
            {requiresAccount && account === '' ? <p className="workspace-error" role="alert">{t.noAccount}</p> : null}
            {command.destructive ? <div className="workspace-confirmation"><h3>{t.review}</h3><p>{t.destructiveHint}</p><div className="workspace-confirm-target"><code>{command.id}</code><span>{scope}</span>{command.arguments.filter(field => !isSecretField(field)).map(field => {
              const value = draft[fieldKey('argument', field.name)]
              const text = Array.isArray(value) ? value.filter(item => item.trim() !== '').join(' · ') : typeof value === 'string' ? value : ''
              return text === '' ? null : <span key={field.name}>{fieldLabel(field, locale)}: {text.slice(0, 1200)}</span>
            })}</div><label className="workspace-check-label" htmlFor="operation-confirmation"><input id="operation-confirmation" type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setFieldErrors(current => { const next = { ...current }; delete next.confirmation; return next }) }} aria-invalid={Boolean(fieldErrors.confirmation)} /><span>{t.confirm}</span></label></div> : null}
            {submitError ? <p className="workspace-error" role="alert">{submitError}</p> : null}
            <div className="workspace-form-actions"><button type="submit" className={`workspace-button workspace-button-primary${command.destructive ? ' workspace-button-danger' : ''}`} disabled={starting || (requiresAccount && account === '')}>{starting ? t.starting : t.run}</button><button type="button" className="workspace-button" onClick={() => { setDrafts(current => ({ ...current, [draftKey]: createOperationDraft(command, initialChat) })); setFieldErrors({}); setConfirmed(false) }}>{t.reset}</button></div>
          </form>
        </> : <div className="workspace-empty"><h2>{t.chooseOperation}</h2><p>{t.chooseOperationHint}</p></div>}
      </section>
      <section className="workspace-output-panel" aria-label={t.result}>
        <header className="workspace-output-heading"><h2>{t.result}</h2>{taskId ? <code>{tasks.find(item => item.id === taskId)?.commandId ?? task?.commandId}</code> : null}</header>
        {taskError ? <div className="workspace-error" role="alert"><p>{taskError}</p><button type="button" className="workspace-button" onClick={() => setHistoryVersion(current => current + 1)}>{t.retry}</button></div> : null}
        {taskId !== null && task === null && taskError === '' ? <p className="workspace-hint" role="status">{t.loadingOperations}</p> : <TaskResult key={task?.id ?? 'empty'} task={task} locale={locale} onCancel={() => { void cancel() }} cancelling={cancelling} listenChat={listenChat} />}
        <section className="workspace-history" aria-label={t.history}><div className="workspace-history-heading"><h3>{t.history}</h3><button type="button" className="workspace-text-button" onClick={() => setHistoryVersion(current => current + 1)}>{t.refresh}</button></div>{tasks.length === 0 ? <p className="workspace-hint">{t.noHistory}</p> : <ol>{tasks.map(item => <li key={item.id}><button type="button" className={taskId === item.id ? 'is-selected' : ''} aria-pressed={taskId === item.id} onClick={() => setTaskId(item.id)}><div><strong>{commandLabel({ id: item.commandId, path: item.commandId.split(' ') }, locale)}</strong><span className={`workspace-status workspace-status-${item.status}`}>{taskStatusLabel(item.status, locale)}</span></div><div><span>{item.account || t.globalOperation}</span><time dateTime={item.startedAt}>{formatDateForLocale(item.startedAt, locale)}</time></div></button></li>)}</ol>}</section>
      </section>
    </main>
  )
}
