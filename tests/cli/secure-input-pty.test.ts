import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const fixture = join(process.cwd(), 'tests', 'fixtures', 'secure-input-pty.ts')
const node = process.execPath
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe.runIf(process.platform !== 'win32' && existsSync('/usr/bin/expect'))('secure input PTY behavior', () => {
  it('does not echo the secret and restores the real terminal state', () => {
    const result = runExpect(`
      spawn -noecho sh -c {before=$(stty -g); ${node} --import tsx ${fixture} secret; status=$?; after=$(stty -g); echo TERMINAL_BEFORE:$before; echo TERMINAL_AFTER:$after; exit $status}
      expect -exact {2FA password: }
      send -- "super-secret-value\r"
      expect eof
      set child [wait]
      exit [lindex $child 3]
    `)

    expect(result.status).toBe(0)
    expect(result.output).not.toContain('super-secret-value')
    expect(result.output).toContain('secret-length:18')
    const before = /TERMINAL_BEFORE:([^\r\n]+)/.exec(result.output)?.[1]
    const after = /TERMINAL_AFTER:([^\r\n]+)/.exec(result.output)?.[1]
    expect(before).toBe(after)
  })

  it.each([
    ['SIGHUP', 'signal-hup', 129],
    ['SIGTERM', 'signal-term', 143],
  ])('restores the terminal and exits conventionally on %s', (_signal, mode, exitCode) => {
    const result = runExpect(`
      spawn -noecho sh -c {before=$(stty -g); ${node} --import tsx ${fixture} ${mode}; status=$?; after=$(stty -g); echo TERMINAL_BEFORE:$before; echo TERMINAL_AFTER:$after; exit $status}
      expect -exact {2FA password: }
      expect eof
      set child [wait]
      exit [lindex $child 3]
    `)

    expect(result.status).toBe(exitCode)
    const before = /TERMINAL_BEFORE:([^\r\n]+)/.exec(result.output)?.[1]
    const after = /TERMINAL_AFTER:([^\r\n]+)/.exec(result.output)?.[1]
    expect(before).toBe(after)
  })

  it.each([
    ['SIGHUP', 'stubborn-hup', 129],
    ['SIGTERM', 'stubborn-term', 143],
  ])('forces conventional %s termination when an operation ignores abort', (_signal, mode, exitCode) => {
    const result = runExpect(`
      spawn -noecho ${node} --import tsx ${fixture} ${mode}
      expect eof
      set child [wait]
      if {[lindex $child 4] eq "CHILDKILLED"} { exit ${exitCode} }
      exit [lindex $child 3]
    `)

    expect(result.status).toBe(exitCode)
  })

  it('sets a conventional exit status when SIGTERM is the last active event', () => {
    const result = runExpect(`
      spawn -noecho ${node} --import tsx ${fixture} handle-free-term
      expect eof
      set child [wait]
      if {[lindex $child 4] eq "CHILDKILLED"} { exit 1 }
      exit [lindex $child 3]
    `)

    expect(result.status).toBe(143)
  })

  it.each([
    ['phone', 'auth-phone', []],
    ['code', 'auth-code', ['+8613800138000']],
    ['password', 'auth-password', ['+8613800138000', '12345']],
  ])('exits 130 on Ctrl-C during the %s authentication prompt', (_label, mode, answers) => {
    const interactions = answers.map(answer => `expect -re {Phone number: |Login code: }; send -- "${answer}\\r"`).join('\n')
    const result = runExpect(`
      spawn -noecho ${node} --import tsx ${fixture} ${mode}
      ${interactions}
      expect -re {Phone number: |Login code: |2FA password: }
      send -- "\\003"
      expect eof
      set child [wait]
      exit [lindex $child 3]
    `)

    expect(result.status).toBe(130)
    expect(result.output).not.toContain('super-secret-value')
  })

  it('exits 130 promptly when logout confirmation is interrupted', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-logout-pty-'))
    tempDirs.push(dataDir)
    writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice', user_id: 42, username: 'alice', phone: '13800138000',
        display_name: 'Alice', auth_state: 'authenticated',
      }],
    })}\n`)

    const result = runExpect(`
      spawn -noecho env DATA_DIR=${dataDir} pnpm dev -- account logout alice
      expect -exact {Log out alice while keeping local messages? [y/N]}
      send -- "\\003"
      expect eof
      set child [wait]
      exit [lindex $child 3]
    `)

    expect(result.status).toBe(130)
  })
})

function runExpect(program: string): { status: number | null; output: string } {
  const result = spawnSync('/usr/bin/expect', ['-c', `log_user 1\nset timeout 5\n${program}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 8_000,
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}
