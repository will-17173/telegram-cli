import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopStartup } from '../../web/src/DesktopStartup.js'
import { chooseDesktopPath, desktopBackendState, isDesktop, restartDesktop, revealDesktopPath } from '../../web/src/desktop.js'

afterEach(() => vi.unstubAllGlobals())

describe('desktop native integration', () => {
  it('uses the standalone frontend without native APIs', async () => {
    vi.stubGlobal('window', {})
    expect(isDesktop()).toBe(false)
    expect(desktopBackendState()).toEqual({ status: 'ready', error: '' })
    await expect(chooseDesktopPath({ kind: 'file' })).resolves.toBeNull()
    expect(renderToStaticMarkup(<DesktopStartup><p>Workspace</p></DesktopStartup>)).toBe('<p>Workspace</p>')
  })

  it('preserves native paths and cancellation without shell parsing', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(['/tmp/a file.txt', '/tmp/图片.png']).mockResolvedValueOnce(null)
    vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
    expect(isDesktop()).toBe(true)
    await expect(chooseDesktopPath({ kind: 'files' })).resolves.toEqual(['/tmp/a file.txt', '/tmp/图片.png'])
    await expect(chooseDesktopPath({ kind: 'save', defaultPath: '/tmp/output.json' })).resolves.toBeNull()
    expect(invoke).toHaveBeenLastCalledWith('choose_path', { kind: 'save', defaultPath: '/tmp/output.json' })
  })

  it('invokes scoped reveal and restart commands', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
    await revealDesktopPath('/tmp/download.txt')
    await restartDesktop()
    expect(invoke.mock.calls).toEqual([
      ['reveal_path', { path: '/tmp/download.txt' }],
      ['restart_app'],
    ])
  })

  it('waits for backend readiness before rendering data consumers', () => {
    vi.stubGlobal('window', { __TG_DESKTOP_STATE__: 'starting' })
    const html = renderToStaticMarkup(<DesktopStartup><p>Data consumer</p></DesktopStartup>)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('Data consumer')
  })

  it('shows a backend failure and an actionable restart', () => {
    vi.stubGlobal('window', { __TG_DESKTOP_STATE__: 'error', __TG_DESKTOP_ERROR__: 'Node sidecar exited' })
    const html = renderToStaticMarkup(<DesktopStartup><p>Data consumer</p></DesktopStartup>)
    expect(html).toContain('Node sidecar exited')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('Data consumer')
  })
})
