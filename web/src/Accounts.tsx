import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { DesktopAuthSession, DesktopCommand, DesktopCommandInput, DesktopTask } from '../../src/web/workspace-types.js'
import { deleteJson, getJson, postJson, type AccountData, type AccountSummary } from './api.js'
import type { Locale } from './i18n.js'
import { boundedTask, errorText } from './workspace-form.js'
import { workspaceMessages } from './workspace-i18n.js'
import { TaskResult } from './workspace-result.js'
import './workspace.css'

export function isAuthActive(session: DesktopAuthSession | null): boolean {
  return session !== null && !['done', 'error', 'cancelled'].includes(session.status)
}

export function authRetryAccount(session: DesktopAuthSession | null, localTarget?: string): string | undefined {
  return session?.requestedAccount ?? localTarget
}

export function authInputAttributes(status: DesktopAuthSession['status']): { type: 'tel' | 'text' | 'password'; autoComplete: string; inputMode: 'tel' | 'numeric' | 'text' } {
  if (status === 'phone') return { type: 'tel', autoComplete: 'tel', inputMode: 'tel' }
  if (status === 'password') return { type: 'password', autoComplete: 'current-password', inputMode: 'text' }
  return { type: 'text', autoComplete: 'one-time-code', inputMode: 'numeric' }
}

export function AuthenticationForm({ session, locale, value, busy, error, onValueChange, onSubmit, onCancel, onRestart }: {
  session: DesktopAuthSession
  locale: Locale
  value: string
  busy: boolean
  error: string
  onValueChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
  onRestart: () => void
}) {
  const t = workspaceMessages[locale]
  const inputRef = useRef<HTMLInputElement>(null)
  const credentials = session.status === 'phone' || session.status === 'code' || session.status === 'password'
  const label = session.status === 'phone' ? t.phone : session.status === 'password' ? t.password : t.code
  const hint = session.status === 'phone' ? t.phoneHint : session.status === 'password' ? t.passwordHint : t.codeHint
  const action = session.status === 'phone' ? t.continue : session.status === 'password' ? t.submitPassword : t.submitCode
  const missingValue = session.status === 'password' ? value.length === 0 : value.trim() === ''
  useEffect(() => { if (credentials) inputRef.current?.focus() }, [session.status, credentials])
  return (
    <section className="account-auth-panel" aria-label={t.authentication}>
      <div className="account-auth-heading"><div><span className="workspace-kicker">Telegram</span><h2>{session.status === 'done' ? t.authDone : t.authentication}</h2></div>{isAuthActive(session) ? <button type="button" className="workspace-button" onClick={onCancel} disabled={busy}>{t.cancel}</button> : null}</div>
      {isAuthActive(session) ? <ol className="account-auth-steps" aria-label={t.authentication}>
        {(['phone', 'code', 'password'] as const).map((step, index) => <li key={step} className={session.status === step ? 'is-current' : ''} aria-current={session.status === step ? 'step' : undefined}><span aria-hidden="true">{index + 1}</span>{step === 'phone' ? t.phone : step === 'code' ? t.code : t.password}</li>)}
      </ol> : null}
      {session.hint ? <p className="workspace-hint">{session.hint}</p> : null}
      {session.error ? <div className="workspace-error" role="alert"><strong>{session.error.code}</strong><p>{session.error.message}</p></div> : null}
      {error ? <p className="workspace-error" role="alert">{error}</p> : null}
      {session.status === 'working' ? <div className="account-connecting" role="status"><span className="workspace-running-indicator" aria-hidden="true" />{t.authenticating}</div> : null}
      {credentials ? <form className="account-auth-form" onSubmit={onSubmit}>
        <label htmlFor="account-auth-value" className="workspace-field-label">{label}<span className="workspace-required">{t.required}</span></label>
        <input id="account-auth-value" ref={inputRef} {...authInputAttributes(session.status)} value={value} onChange={event => onValueChange(event.target.value)} required aria-describedby="account-auth-hint" disabled={busy} spellCheck={false} />
        <p id="account-auth-hint" className="workspace-field-hint">{hint}</p>
        <button type="submit" className="workspace-button workspace-button-primary" disabled={busy || missingValue}>{busy ? t.authenticating : action}</button>
      </form> : null}
      {session.status === 'done' ? <div className="account-auth-success" role="status"><strong>{session.account?.display_name || session.account?.name || t.authDone}</strong>{session.account?.username ? <span>@{session.account.username}</span> : null}</div> : null}
      {session.status === 'error' || session.status === 'cancelled' ? <div className="workspace-form-actions"><p className="workspace-hint">{session.status === 'error' ? t.authError : t.authCancelled}</p><button type="button" className="workspace-button workspace-button-primary" onClick={onRestart} disabled={busy}>{t.tryLoginAgain}</button></div> : null}
    </section>
  )
}

type AccountAction = { account: AccountSummary; type: 'remove' | 'logout' | 'rename' }

export type AccountsProps = {
  accounts: AccountData
  account: string
  locale: Locale
  onAccountsChanged: () => void
  onSelectAccount: (name: string) => void
  onOpenOperation?: (commandId: string) => void
}

export function Accounts({ accounts, account, locale, onAccountsChanged, onSelectAccount, onOpenOperation }: AccountsProps) {
  const t = workspaceMessages[locale]
  const [session, setSession] = useState<DesktopAuthSession | null>(null)
  const [credentials, setCredentials] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authTarget, setAuthTarget] = useState<string | undefined>()
  const [action, setAction] = useState<AccountAction | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [task, setTask] = useState<DesktopTask | null>(null)
  const [taskError, setTaskError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [cancellingTask, setCancellingTask] = useState(false)
  const [taskVersion, setTaskVersion] = useState(0)
  const [catalog, setCatalog] = useState<DesktopCommand[]>([])
  const mounted = useRef(false)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const authGeneration = useRef(0)
  const completedSessions = useRef(new Set<string>())
  const completedTasks = useRef(new Set<string>())
  const switchTarget = useRef<{ taskId: string; name: string } | null>(null)
  const callbackRef = useRef({ onAccountsChanged, onSelectAccount })
  callbackRef.current = { onAccountsChanged, onSelectAccount }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let active = true
    const generation = authGeneration.current
    void getJson<DesktopAuthSession | null>('/api/auth/sessions').then(current => {
      if (active && generation === authGeneration.current) {
        setSession(current)
        setAuthTarget(current?.requestedAccount)
      }
    }).catch(problem => { if (active && generation === authGeneration.current) setAuthError(errorText(problem)) })
    void getJson<DesktopCommand[]>('/api/workspace/commands').then(commands => { if (active) setCatalog(commands) }).catch(problem => { if (active) setTaskError(errorText(problem)) })
    return () => { active = false }
  }, [])

  const sessionId = session?.id
  useEffect(() => {
    if (sessionId === undefined) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (!isAuthActive(sessionRef.current)) return
      const generation = authGeneration.current
      try {
        const updated = await getJson<DesktopAuthSession>(`/api/auth/sessions/${encodeURIComponent(sessionId)}`)
        if (active && generation === authGeneration.current) setSession(updated)
      } catch (problem) { if (active && generation === authGeneration.current) setAuthError(errorText(problem)) }
      finally { if (active) timer = setTimeout(() => { void poll() }, 1000) }
    }
    timer = setTimeout(() => { void poll() }, 500)
    return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
  }, [sessionId])

  useEffect(() => {
    if (session?.status !== 'done' || completedSessions.current.has(session.id)) return
    completedSessions.current.add(session.id)
    callbackRef.current.onAccountsChanged()
    if (session.account?.name) callbackRef.current.onSelectAccount(session.account.name)
  }, [session?.id, session?.status, session?.account?.name])

  const taskId = task?.id
  useEffect(() => {
    if (taskId === undefined) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let continuing = true
      try {
        const updated = await getJson<DesktopTask>(`/api/workspace/tasks/${encodeURIComponent(taskId)}`)
        if (!active) return
        setTask(boundedTask(updated))
        setTaskError('')
        continuing = updated.status === 'running'
      } catch (problem) { if (active) setTaskError(errorText(problem)) }
      finally { if (active && continuing) timer = setTimeout(() => { void poll() }, 800) }
    }
    void poll()
    return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
  }, [taskId, taskVersion])

  useEffect(() => {
    if (task?.status !== 'succeeded' || completedTasks.current.has(task.id)) return
    completedTasks.current.add(task.id)
    callbackRef.current.onAccountsChanged()
    if (switchTarget.current?.taskId === task.id) callbackRef.current.onSelectAccount(switchTarget.current.name)
  }, [task?.id, task?.status])

  const startAuth = async (name?: string) => {
    if (authBusy || isAuthActive(session)) return
    setAuthBusy(true)
    setAuthError('')
    setCredentials('')
    setAuthTarget(name)
    authGeneration.current += 1
    try {
      const created = await postJson<DesktopAuthSession>('/api/auth/sessions', name ? { account: name } : {})
      if (mounted.current) setSession(created)
    } catch (problem) { if (mounted.current) setAuthError(errorText(problem)) }
    finally { if (mounted.current) setAuthBusy(false) }
  }

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault()
    if (session === null || authBusy || (session.status === 'password' ? credentials.length === 0 : credentials.trim() === '')) return
    const value = credentials
    const submittingId = session.id
    setCredentials('')
    setAuthError('')
    setAuthBusy(true)
    authGeneration.current += 1
    try {
      const updated = await postJson<DesktopAuthSession>(`/api/auth/sessions/${encodeURIComponent(submittingId)}`, { value })
      if (mounted.current && sessionRef.current?.id === submittingId) setSession(updated)
    } catch (problem) { if (mounted.current) setAuthError(errorText(problem)) }
    finally { if (mounted.current) setAuthBusy(false) }
  }

  const cancelAuth = async () => {
    if (session === null || authBusy) return
    const cancellingId = session.id
    setCredentials('')
    setAuthBusy(true)
    authGeneration.current += 1
    try {
      const updated = await deleteJson<DesktopAuthSession>(`/api/auth/sessions/${encodeURIComponent(cancellingId)}`)
      if (mounted.current) setSession(updated)
    } catch (problem) { if (mounted.current) setAuthError(errorText(problem)) }
    finally { if (mounted.current) setAuthBusy(false) }
  }

  const runAction = async (input: DesktopCommandInput, selectedName?: string) => {
    if (actionBusy || task?.status === 'running') return
    setActionBusy(true)
    setTaskError('')
    try {
      const created = await postJson<DesktopTask>('/api/workspace/tasks', input)
      if (!mounted.current) return
      setTask(boundedTask(created))
      switchTarget.current = selectedName ? { taskId: created.id, name: selectedName } : null
      setAction(null)
      setConfirmation('')
      setReviewed(false)
    } catch (problem) { if (mounted.current) setTaskError(errorText(problem)) }
    finally { if (mounted.current) setActionBusy(false) }
  }

  const confirmAction = (event: FormEvent) => {
    event.preventDefault()
    if (action === null || !reviewed) return
    if (action.type === 'rename') {
      if (confirmation.trim() === '') return
      const command = catalog.find(item => item.id === 'account rename')
      if (!command) return
      const args = Object.fromEntries(command.arguments.map((field, index) => [field.name, index === 0 ? action.account.name : confirmation]))
      void runAction({ commandId: command.id, arguments: args, confirmed: true })
    } else {
      if (action.type === 'remove' && confirmation !== action.account.name) return
      void runAction({ commandId: `account ${action.type}`, arguments: { name: action.account.name }, ...(action.type === 'remove' ? { options: { force: true } } : {}), confirmed: true })
    }
  }

  const openAction = (selected: AccountSummary, type: AccountAction['type']) => {
    setAction({ account: selected, type })
    setConfirmation('')
    setReviewed(false)
    setTaskError('')
  }
  const cancelTask = async () => {
    if (task === null || cancellingTask) return
    const cancellingId = task.id
    setCancellingTask(true)
    try {
      const updated = await deleteJson<DesktopTask>(`/api/workspace/tasks/${encodeURIComponent(cancellingId)}`)
      if (mounted.current) {
        setTask(current => current?.id === cancellingId ? boundedTask(updated) : current)
        setTaskVersion(current => current + 1)
      }
    } catch (problem) { if (mounted.current) setTaskError(errorText(problem)) }
    finally { if (mounted.current) setCancellingTask(false) }
  }
  const actionDisabled = actionBusy || task?.status === 'running'
  const authDisabled = authBusy || isAuthActive(session)
  const hasRename = catalog.some(command => command.id === 'account rename')

  return (
    <main className="accounts-layout">
      <section className="account-registry" aria-label={t.accounts}>
        <header className="accounts-heading"><div><span className="workspace-kicker">Telegram</span><h2>{t.accounts}<span>{accounts.accounts.length}</span></h2><p>{t.accountHint}</p></div><button type="button" className="workspace-button workspace-button-primary" onClick={() => { void startAuth() }} disabled={authDisabled}>{authBusy ? t.starting : t.addAccount}</button></header>
        {accounts.accounts.length === 0 ? <div className="account-onboarding"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="m8 23 32-13-8 29-10-10-14-6Z" /><path d="m22 29 18-19M22 29l-2 10 7-6" /></svg><h2>{t.noAccounts}</h2><p>{t.noAccountsHint}</p>{onOpenOperation ? <button type="button" className="workspace-button" onClick={() => onOpenOperation('config set')}>{t.configure}</button> : null}</div> : <div className="account-card-list">{accounts.accounts.map(summary => <article key={summary.name} className={`account-card${account === summary.name ? ' is-selected' : ''}`}>
          <div className="account-card-header"><span className="account-avatar" aria-hidden="true">{(summary.display_name || summary.name).slice(0, 1).toUpperCase()}</span><div><h3>{summary.display_name || summary.name}</h3><code>{summary.name}</code>{summary.username ? <p>@{summary.username}</p> : null}</div></div>
          <div className="account-badges"><span className={`workspace-status ${summary.auth_state === 'authenticated' ? 'workspace-status-succeeded' : 'workspace-status-cancelled'}`}>{summary.auth_state === 'authenticated' ? t.signedIn : t.loggedOut}</span>{accounts.current_account === summary.name ? <span className="account-tag">{t.current}</span> : null}{account === summary.name ? <span className="account-tag">{t.selected}</span> : null}</div>
          <div className="account-card-actions"><button type="button" className="workspace-button" onClick={() => onSelectAccount(summary.name)} disabled={account === summary.name}>{t.select}</button>{accounts.current_account !== summary.name ? <button type="button" className="workspace-button" disabled={actionDisabled} onClick={() => { void runAction({ commandId: 'account switch', arguments: { name: summary.name } }, summary.name) }}>{t.switchDefault}</button> : null}{summary.auth_state === 'logged_out' ? <button type="button" className="workspace-button" disabled={authDisabled} onClick={() => { void startAuth(summary.name) }}>{t.signIn}</button> : <button type="button" className="workspace-button" disabled={actionDisabled} onClick={() => openAction(summary, 'logout')}>{t.logout}</button>}{hasRename ? <button type="button" className="workspace-button" disabled={actionDisabled} onClick={() => openAction(summary, 'rename')}>{t.rename}</button> : null}<button type="button" className="workspace-text-button workspace-danger-text" disabled={actionDisabled} onClick={() => openAction(summary, 'remove')}>{t.removeAccount}</button></div>
        </article>)}</div>}
        <div className="account-settings-link"><div><strong>{t.configure}</strong><p>{t.configurationHint}</p></div>{onOpenOperation ? <button type="button" className="workspace-button" onClick={() => onOpenOperation('config set')}>{t.operations}</button> : null}</div>
      </section>
      <aside className="account-detail-panel" aria-label={t.authentication}>
        {session ? <AuthenticationForm session={session} locale={locale} value={credentials} busy={authBusy} error={authError} onValueChange={setCredentials} onSubmit={event => { void submitCredentials(event) }} onCancel={() => { void cancelAuth() }} onRestart={() => { void startAuth(authRetryAccount(session, authTarget)) }} /> : <div className="account-auth-intro"><h2>{t.authentication}</h2><p>{t.noAccountsHint}</p>{authBusy ? <p className="workspace-hint" role="status">{t.authenticating}</p> : null}{authError ? <p className="workspace-error" role="alert">{authError}</p> : null}</div>}
        {action ? <form className="account-action-review" onSubmit={confirmAction}><h2>{action.type === 'remove' ? t.removeAccount : action.type === 'rename' ? t.rename : t.logout}</h2><code>{action.account.name}</code><p>{action.type === 'remove' ? t.removeAccountHint : action.type === 'logout' ? t.logoutHint : t.newName}</p>{action.type === 'remove' || action.type === 'rename' ? <label className="workspace-field"><span className="workspace-field-label">{action.type === 'rename' ? t.newName : t.exactAccount}</span><input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} required /></label> : null}<label className="workspace-check-label"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>{t.confirm}</span></label><div className="workspace-form-actions"><button type="submit" className="workspace-button workspace-button-danger" disabled={actionDisabled || !reviewed || (action.type === 'remove' ? confirmation !== action.account.name : action.type === 'rename' ? confirmation.trim() === '' : false)}>{actionBusy ? t.starting : action.type === 'remove' ? t.removeAccount : action.type === 'rename' ? t.rename : t.logout}</button><button type="button" className="workspace-button" onClick={() => setAction(null)} disabled={actionBusy}>{t.cancel}</button></div></form> : null}
        {taskError ? <p className="workspace-error" role="alert">{taskError}</p> : null}
        {task ? <section className="account-action-result" aria-label={t.result}><h2>{t.result}</h2><code>tg {task.commandId}</code><TaskResult key={task.id} task={task} locale={locale} onCancel={() => { void cancelTask() }} cancelling={cancellingTask} /></section> : null}
      </aside>
    </main>
  )
}
