import { useEffect, useState, type ReactNode } from 'react'
import { desktopBackendState, refreshDesktopBackendState, restartDesktop } from './desktop.js'

export function DesktopStartup({ children }: { children: ReactNode }) {
  const [state, setState] = useState(desktopBackendState)
  const [restarting, setRestarting] = useState(false)
  const chinese = typeof navigator !== 'undefined' && navigator.language.startsWith('zh')

  useEffect(() => {
    let mounted = true
    function refresh() { setState(desktopBackendState()) }
    window.addEventListener('tg-backend-state', refresh)
    refresh()
    void refreshDesktopBackendState().then((next) => { if (mounted) setState(next) }).catch((error) => {
      if (mounted) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      mounted = false
      window.removeEventListener('tg-backend-state', refresh)
    }
  }, [])

  if (state.status === 'ready') return children

  async function restart() {
    setRestarting(true)
    try {
      await restartDesktop()
    } catch (error) {
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      setRestarting(false)
    }
  }

  return (
    <main className="desktop-startup" aria-busy={state.status === 'starting'}>
      <div className="desktop-startup-card">
        <span className="brand-mark" aria-hidden="true">tg</span>
        <h1>Telegram CLI</h1>
        {state.status === 'starting' ? (
          <p role="status">{chinese ? '正在启动桌面工作区…' : 'Starting your desktop workspace…'}</p>
        ) : (
          <>
            <h2>{chinese ? '后台服务无法启动' : 'Unable to start the backend'}</h2>
            <p role="alert">{state.error}</p>
            <button type="button" disabled={restarting} onClick={() => void restart()}>
              {chinese ? (restarting ? '正在重启…' : '重启应用') : (restarting ? 'Restarting…' : 'Restart app')}
            </button>
          </>
        )}
      </div>
    </main>
  )
}
