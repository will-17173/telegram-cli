type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export type DesktopBackendState = 'starting' | 'ready' | 'error'

type DesktopWindow = Window & {
  __TAURI__?: { core?: { invoke?: NativeInvoke } }
  __TG_DESKTOP_STATE__?: DesktopBackendState
  __TG_DESKTOP_ERROR__?: string
}

function desktopWindow(): DesktopWindow | undefined {
  return typeof window === 'undefined' ? undefined : window as DesktopWindow
}

export function isDesktop(): boolean {
  return typeof desktopWindow()?.__TAURI__?.core?.invoke === 'function'
}

export function desktopBackendState(): { status: DesktopBackendState; error: string } {
  const native = desktopWindow()
  return { status: native?.__TG_DESKTOP_STATE__ ?? 'ready', error: native?.__TG_DESKTOP_ERROR__ ?? '' }
}

export async function refreshDesktopBackendState(): Promise<{ status: DesktopBackendState; error: string }> {
  const invoke = desktopWindow()?.__TAURI__?.core?.invoke
  if (invoke == null) return desktopBackendState()
  const state = await invoke<{ status: DesktopBackendState; error: string }>('backend_status')
  const current = desktopBackendState()
  return current.status === 'starting' ? state : current
}

export async function chooseDesktopPath(options: {
  kind: 'file' | 'files' | 'directory' | 'save'
  defaultPath?: string
}): Promise<string | string[] | null> {
  const invoke = desktopWindow()?.__TAURI__?.core?.invoke
  if (invoke == null) return null
  const paths = await invoke<string[] | null>('choose_path', {
    kind: options.kind,
    defaultPath: options.defaultPath ?? null,
  })
  if (paths == null || paths.length === 0) return null
  return options.kind === 'files' ? paths : paths[0]
}

export async function revealDesktopPath(path: string): Promise<void> {
  const invoke = desktopWindow()?.__TAURI__?.core?.invoke
  if (invoke == null) return
  await invoke('reveal_path', { path })
}

export async function saveDesktopText(options: { filename: string; text: string }): Promise<string | null> {
  const invoke = desktopWindow()?.__TAURI__?.core?.invoke
  if (invoke == null) return null
  return invoke<string | null>('save_text', options)
}

export async function copyDesktopText(text: string): Promise<boolean> {
  const invoke = desktopWindow()?.__TAURI__?.core?.invoke
  if (invoke == null) return false
  await invoke('copy_text', { text })
  return true
}

export async function restartDesktop(): Promise<void> {
  const invoke = desktopWindow()?.__TAURI__?.core?.invoke
  if (invoke == null) return
  await invoke('restart_app')
}
