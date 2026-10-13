import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GuardDB } from '../../src/storage/guard-db.js'
import { DesktopGuardManager } from '../../src/web/guard-manager.js'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-desktop-guard-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('desktop Guard controller', () => {
  it('starts, reloads and stops an empty local Guard without requiring a Telegram session', async () => {
    const manager = new DesktopGuardManager({ dataDir: temporaryRoot() })
    try {
      expect((await manager.control('start')).status).toBe('running')
      expect((await manager.control('restart')).status).toBe('running')
      expect((await manager.control('stop')).status).toBe('stopped')
    } finally { await manager.close() }
  })

  it('recovers an allocated runtime after a listener error through the Start button action', async () => {
    const root = temporaryRoot()
    const manager = new DesktopGuardManager({ dataDir: root })
    try {
      await manager.control('start')
      const db = new GuardDB(join(root, 'guard.db'))
      try { db.setRuntimeState({ status: 'error', started_at: null, queue_length: 0, error: 'Listener disconnected' }) }
      finally { db.close() }
      expect(manager.getState().status).toBe('error')
      const restarted = await manager.control('start')
      expect(restarted.status).toBe('running')
      expect(restarted.error).toBeNull()
    } finally { await manager.close() }
  })

  it('blocks new control actions after shutdown admission closes', async () => {
    const manager = new DesktopGuardManager({ dataDir: temporaryRoot() })
    await manager.close()
    await expect(manager.control('start')).rejects.toMatchObject({ code: 'guard_closed' })
  })
})
