import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { DesktopListenInput } from '../../src/web/workspace-types.js'
import { postJson } from './api.js'
import { chooseDesktopPath, isDesktop } from './desktop.js'
import type { Locale } from './i18n.js'
import { errorText, type OperationDraft } from './workspace-form.js'
import { fieldLabel, workspaceMessages } from './workspace-i18n.js'

export type ListenDraft = { chat: string; text: string; files: string[]; reply: string; linkPreview: boolean }
export type ListenErrors = Partial<Record<'chat' | 'text' | 'reply', 'required' | 'content' | 'reply'>>

export function listenDefaultChat(draft: OperationDraft): string {
  const sendTo = draft['option:sendTo']
  if (typeof sendTo === 'string' && sendTo.trim() !== '') return sendTo
  const chats = draft['argument:chats']
  if (!Array.isArray(chats)) return ''
  const selected = chats.filter(chat => chat.trim() !== '')
  return selected.length === 1 ? selected[0]! : ''
}

export function listenInput(draft: ListenDraft): { input: DesktopListenInput; errors: ListenErrors } {
  const errors: ListenErrors = {}
  const files = draft.files.filter(file => file.trim() !== '')
  if (draft.chat.trim() === '') errors.chat = 'required'
  if (draft.text.trim() === '' && files.length === 0) errors.text = 'content'
  const reply = draft.reply === '' ? undefined : /^\d+$/.test(draft.reply) ? Number(draft.reply) : Number.NaN
  if (reply !== undefined && (!Number.isSafeInteger(reply) || reply <= 0)) errors.reply = 'reply'
  return { errors, input: {
    chat: draft.chat.trim(),
    ...(draft.text === '' ? {} : { text: draft.text }),
    ...(files.length === 0 ? {} : { files }),
    ...(reply === undefined || errors.reply ? {} : { reply }),
    linkPreview: draft.linkPreview,
  } }
}

export function ListenComposer({ taskId, locale, defaultChat = '' }: { taskId: string; locale: Locale; defaultChat?: string }) {
  const t = workspaceMessages[locale]
  const [draft, setDraft] = useState<ListenDraft>(() => ({ chat: defaultChat, text: '', files: [''], reply: '', linkPreview: true }))
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState<ListenErrors>({})
  const [sent, setSent] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const mounted = useRef(false)
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (defaultChat !== '') setDraft(current => current.chat === '' ? { ...current, chat: defaultChat } : current) }, [defaultChat])
  const update = <K extends keyof ListenDraft>(key: K, value: ListenDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
    setSent(false)
    setErrors(current => {
      const next = { ...current }
      if (key === 'chat') delete next.chat
      if (key === 'text' || key === 'files') delete next.text
      if (key === 'reply') delete next.reply
      return next
    })
  }
  const chooseFiles = async () => {
    setChoosing(true)
    setError('')
    try {
      const selected = await chooseDesktopPath({ kind: 'files' })
      if (selected !== null && mounted.current) {
        setDraft(current => ({ ...current, files: [...current.files.filter(file => file.trim() !== ''), ...(Array.isArray(selected) ? selected : [selected])] }))
        setSent(false)
        setErrors(current => { const next = { ...current }; delete next.text; return next })
      }
    } catch (problem) { if (mounted.current) setError(errorText(problem)) }
    finally { if (mounted.current) setChoosing(false) }
  }
  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const built = listenInput(draft)
    setErrors(built.errors)
    setError('')
    setSent(false)
    if (Object.keys(built.errors).length > 0) {
      if (built.errors.reply) setOptionsOpen(true)
      setTimeout(() => errorRef.current?.focus(), 0)
      return
    }
    setBusy(true)
    try {
      await postJson<unknown>(`/api/workspace/tasks/${encodeURIComponent(taskId)}/send`, built.input)
      if (!mounted.current) return
      setDraft(current => ({ ...current, text: '', files: [''] }))
      setSent(true)
    } catch (problem) { if (mounted.current) setError(errorText(problem)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const id = `listen-compose-${encodeURIComponent(taskId)}`
  return (
    <section className="workspace-listen-composer" aria-label={t.compose}>
      <h3>{t.compose}</h3><p className="workspace-hint">{t.composeHint}</p>
      <form onSubmit={event => { void send(event) }} noValidate>
        {Object.keys(errors).length > 0 ? <div className="workspace-error" role="alert" ref={errorRef} tabIndex={-1}>{errors.chat ? <p><a href={`#${id}-chat`}>{fieldLabel({ name: 'chat' }, locale)}: {t.requiredError}</a></p> : null}{errors.text ? <p><a href={`#${id}-text`}>{t.messageOrFile}</a></p> : null}{errors.reply ? <p><a href={`#${id}-reply`}>{t.invalidReply}</a></p> : null}</div> : null}
        <div className="workspace-field"><label htmlFor={`${id}-chat`} className="workspace-field-label">{fieldLabel({ name: 'chat' }, locale)}<span className="workspace-required">{t.required}</span></label><input id={`${id}-chat`} value={draft.chat} onChange={event => update('chat', event.target.value)} disabled={busy} aria-required="true" aria-invalid={Boolean(errors.chat)} aria-describedby={errors.chat ? `${id}-chat-error` : undefined} placeholder="@username / -100…" />{errors.chat ? <p className="workspace-inline-error" id={`${id}-chat-error`}>{t.requiredError}</p> : null}</div>
        <div className="workspace-field"><label htmlFor={`${id}-text`} className="workspace-field-label">{fieldLabel({ name: 'message' }, locale)}</label><textarea id={`${id}-text`} value={draft.text} onChange={event => update('text', event.target.value)} disabled={busy} rows={3} aria-invalid={Boolean(errors.text)} aria-describedby={errors.text ? `${id}-text-error` : undefined} />{errors.text ? <p className="workspace-inline-error" id={`${id}-text-error`}>{t.messageOrFile}</p> : null}</div>
        <details className="workspace-advanced" open={optionsOpen} onToggle={event => setOptionsOpen(event.currentTarget.open)}><summary>{t.composeOptions}</summary><div className="workspace-advanced-fields">
          <div className="workspace-field"><label htmlFor={`${id}-reply`} className="workspace-field-label">{fieldLabel({ name: 'reply' }, locale)}</label><input id={`${id}-reply`} value={draft.reply} onChange={event => update('reply', event.target.value)} disabled={busy} inputMode="numeric" aria-invalid={Boolean(errors.reply)} aria-describedby={errors.reply ? `${id}-reply-error` : undefined} />{errors.reply ? <p className="workspace-inline-error" id={`${id}-reply-error`}>{t.invalidReply}</p> : null}</div>
          <div className="workspace-field"><label htmlFor={`${id}-file-0`} className="workspace-field-label">{fieldLabel({ name: 'file' }, locale)}</label>{draft.files.map((file, index) => <div className="workspace-value-row" key={index}><input id={`${id}-file-${index}`} value={file} onChange={event => update('files', draft.files.map((current, position) => position === index ? event.target.value : current))} disabled={busy} aria-label={index === 0 ? undefined : `${fieldLabel({ name: 'file' }, locale)} ${index + 1}`} spellCheck={false} />{draft.files.length > 1 ? <button type="button" className="workspace-remove-value" aria-label={`${t.removeValue} ${index + 1}`} onClick={() => update('files', draft.files.filter((_, position) => position !== index))} disabled={busy}>×</button> : null}</div>)}<div className="workspace-field-tools"><button type="button" className="workspace-text-button" onClick={() => update('files', [...draft.files, ''])} disabled={busy}>{t.addValue}</button>{isDesktop() ? <button type="button" className="workspace-text-button" onClick={() => { void chooseFiles() }} disabled={busy || choosing}>{choosing ? t.starting : t.chooseFiles}</button> : null}</div><p className="workspace-field-hint">{t.manualPath}</p></div>
          <label className="workspace-check-label"><input type="checkbox" checked={draft.linkPreview} onChange={event => update('linkPreview', event.target.checked)} disabled={busy} /><span>{fieldLabel({ name: 'preview' }, locale)}</span></label>
        </div></details>
        {error ? <p className="workspace-error" role="alert">{error}</p> : null}
        {sent ? <p className="workspace-send-success" role="status">{t.messageSent}</p> : null}
        <button type="submit" className="workspace-button workspace-button-primary" disabled={busy || choosing}>{busy ? t.sendingMessage : t.sendMessage}</button>
      </form>
    </section>
  )
}
