import React, { act } from 'react'
import { render, renderToString, Text } from 'ink'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  applyAutoDownloadEvent,
  acceptListenMessage,
  attachmentDownloadKeyAt,
  attachmentDownloadTarget,
  calculateListenMessagePaneHeight,
  canManuallyDownload,
  collectDownloadableAttachments,
  createInteractiveOperationController,
  flushListenBeforeExit,
  formatInteractiveListenSender,
  interactiveListenPreviewColorDepth,
  InteractiveListen,
  LISTEN_COMPOSER_THEME,
  ListenAttachmentLine,
  ListenAttachmentWithPreview,
  ListenComposer,
  ListenImagePreview,
  LISTEN_HISTORY_LIMIT,
  type ListenMessage,
  ListenMessageViewCache,
  ListenStatus,
  ListenStatusArea,
  pruneAttachmentDownloadStates,
  pruneListenMessageGroups,
  registerPendingAttachmentKeys,
  runInteractiveAutoDownloadLifecycle,
  runInteractiveListen,
  runOwnedAttachmentOperation,
  toListenMessage,
  useTerminalMetrics,
} from '../../src/presenters/ink/listen.js'
import { decodeImagePreview } from '../../src/presenters/ink/image-preview.js'
import { DISABLE_MOUSE_REPORTING, ENABLE_MOUSE_REPORTING } from '../../src/presenters/ink/mouse-scroll.js'
import { applyMessageArrival, applyScroll, takeListenViewport } from '../../src/presenters/ink/listen-scroll.js'
import type { ListenMessageRow } from '../../src/presenters/listen-message.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('runInteractiveListen', () => {
  it('wraps the interactive run with mouse reporting and preserves its result', async () => {
    const calls: string[] = []

    const result = await runInteractiveListen(
      (value) => calls.push(value),
      async () => {
        calls.push('run')
        return 'completed'
      },
    )

    expect(result).toBe('completed')
    expect(calls).toEqual([ENABLE_MOUSE_REPORTING, 'run', DISABLE_MOUSE_REPORTING])
  })
})

describe('useTerminalMetrics', () => {
  it('reacts to stdout resize and removes its sole listener on unmount', async () => {
    const stdout = new MockStdout(80, 24, 24)
    const renderStdout = new MockStdout(80, 24, 24)
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const onMetrics = vi.fn()
    const app = render(
      <TerminalMetricsHarness stdout={stdout} decodePreview={decodePreview} onMetrics={onMetrics} />,
      { stdout: renderStdout as unknown as NodeJS.WriteStream, patchConsole: false },
    )

    await vi.waitFor(() => expect(onMetrics).toHaveBeenLastCalledWith({ columns: 80, rows: 24, colorDepth: 24 }))
    expect(stdout.listenerCount('resize')).toBe(1)
    expect(decodePreview).toHaveBeenLastCalledWith(twoByTwoJpeg, 24)

    stdout.columns = 12
    stdout.rows = 10
    stdout.colorDepth = 8
    stdout.emit('resize')

    await vi.waitFor(() => expect(onMetrics).toHaveBeenLastCalledWith({ columns: 12, rows: 10, colorDepth: 8 }))
    expect(decodePreview).toHaveBeenCalledTimes(1)

    stdout.colorDepth = 24
    stdout.emit('resize')
    await vi.waitFor(() => expect(decodePreview).toHaveBeenLastCalledWith(twoByTwoJpeg, 9))

    app.unmount()
    expect(stdout.listenerCount('resize')).toBe(0)
  })
})

describe('ListenComposer', () => {
  it('renders a Codex-style three-row composer and colored status bar', () => {
    const output = renderToString(
      <ListenComposer
        input="hello"
        sendTargetLabel="Example|-1001"
        terminalWidth={64}
      />,
      { columns: 64 },
    )

    const lines = output.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('› hello')
    expect(lines[3]).toContain('To: Example|-1001')
    expect(lines[3]).toContain('Enter to send · Ctrl+C to exit')
    expect(LISTEN_COMPOSER_THEME).toEqual({
      background: '#454950',
      foreground: '#d7dae0',
      cursor: '#8ecbff',
      target: '#f0d38a',
      hint: '#9bdca8',
    })
  })
})

describe('InteractiveListen slash commands', () => {
  it('reports an ambiguous multi-chat target without writing', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen
      chats={[100, 200]} persist retrySeconds={1} sendTo={undefined} showMedia={false} autoDownload={false} showChatName={false}
      createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined}
    />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/topic list')
    await vi.waitFor(() => expect(stdout.output).toContain('› /topic list'))
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('Select exactly one target chat'))
    expect(client.groups.getGroup).not.toHaveBeenCalled()
    expect(client.sendMessage).not.toHaveBeenCalled()
    controller.abort()
    app.unmount()
  })

  it('enters pending confirmation without invoking a write', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen
      chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false}
      createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined}
    />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/member kick 7')
    await vi.waitFor(() => expect(stdout.output).toContain('› /member kick 7'))
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('waiting for confirmation'))
    expect(client.groups.banMember).not.toHaveBeenCalled()
    stdin.write('\u001b')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/member kick 7'))
    controller.abort()
    app.unmount()
  })

  it('defaults confirmation to Cancel and locks rapid confirmed execution to one write', async () => {
    let release!: () => void
    const deferred = new Promise<void>(resolve => { release = resolve })
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    client.groups.banMember.mockImplementation(() => deferred)
    const stdout = new MockStdout(50, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen
      chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false}
      createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined}
    />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    await act(async () => { stdin.write('/member ban 7') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/member ban 7'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Confirm'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Running group command'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(client.groups.banMember).toHaveBeenCalledTimes(1))
    release()
    controller.abort()
    app.unmount()
  })

  it('requires an exact independently typed title before deleting a chat', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(50, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    await act(async () => { stdin.write('/chat delete') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/chat delete'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Confirm'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Type the exact title'))
    await act(async () => { stdin.write('Test Groux') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Test Groux'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('does not match exactly'))
    expect(client.groups.deleteGroup).not.toHaveBeenCalled()
    await act(async () => { stdin.write('\u001b') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Permanently delete the chat'))
    await act(async () => { stdin.write('\u001b') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).not.toContain('Permanently delete the chat'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Confirm'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Type the exact title'))
    await act(async () => { stdin.write('Test Group') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Test Group'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(client.groups.deleteGroup).toHaveBeenCalledTimes(1))
    controller.abort(); app.unmount()
  })

  it('returns from title verification to confirmation and then cancels without deleting', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(45, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/chat delete'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/chat delete')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel')); stdin.write('\u001b[A'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Confirm')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Type the exact title')); stdin.write('isolated')
    expect(lastTerminalFrame(stdout.output)).toContain('/chat delete')
    stdin.write('\u001b'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Permanently delete the chat'))
    stdin.write('\u001b'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/chat delete'))
    expect(client.groups.deleteGroup).not.toHaveBeenCalled()
    controller.abort(); app.unmount()
  })

  it('selects an exact admin-right subset before promotion confirmation', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(60, 30, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/admin promote 7'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/admin promote 7')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Administrator permissions'))
    expect(lastTerminalFrame(stdout.output)).toContain('[ ] change_info')
    stdin.write('\r'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Select at least one'))
    stdin.write(' '); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('[x] change_info')); stdin.write('\u001b[B'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› [ ] delete_messages')); stdin.write(' '); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› [x] delete_messages')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('permissions: change_info, delete_messages'))
    stdin.write('\u001b[A'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Confirm')); stdin.write('\r')
    await vi.waitFor(() => expect(client.groups.promoteAdmin).toHaveBeenCalledTimes(1))
    expect(client.groups.promoteAdmin.mock.calls[0]?.[0].rights).toEqual({ change_info: true, delete_messages: true, ban_users: false, invite_users: false, pin_messages: false, add_admins: false, manage_call: false, anonymous: false, manage_topics: false })
    controller.abort(); app.unmount()
  })

  it('renders known capability denial and blocks Tab and Enter without a Telegram call', async () => {
    const controller = new AbortController()
    const denied = { ...groupDetails(), forum: false, current_user_role: 'member' as const }
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(denied) })
    const stdout = new MockStdout(70, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(client.groups.getGroup).toHaveBeenCalled())
    stdin.write('/topic list'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('disabled: This command requires a'))
    stdin.write('\t'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('This command requires a forum'))
    stdin.write('\r'); await new Promise(resolve => setTimeout(resolve, 20))
    expect(client.groups.listTopics).not.toHaveBeenCalled()
    controller.abort(); app.unmount()
  })

  it('refreshes cached group details after a successful mutation', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(60, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(client.groups.getGroup).toHaveBeenCalledTimes(1))
    stdin.write('/chat title Renamed'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/chat title Renamed')); stdin.write('\r')
    await vi.waitFor(() => expect(client.groups.setTitle).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(client.groups.getGroup).toHaveBeenCalledTimes(2))
    controller.abort(); app.unmount()
  })

  it('clears title mismatch with Backspace and executes the corrected exact title without changing the composer', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(55, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/chat delete'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/chat delete')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel')); stdin.write('\u001b[A'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Confirm')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Type the exact title')); stdin.write('Test Groupx'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Test Groupx')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('does not match exactly'))
    stdin.write(Buffer.from([8])); await vi.waitFor(() => {
      const frame = lastTerminalFrame(stdout.output)
      expect(frame).toContain('› Test Group')
      expect(frame).not.toContain('does not match exactly')
    })
    expect(lastTerminalFrame(stdout.output)).toContain('› /chat delete')
    stdin.write('\r'); await vi.waitFor(() => expect(client.groups.deleteGroup).toHaveBeenCalledTimes(1))
    controller.abort(); app.unmount()
  })

  it('does not let an older initial group lookup overwrite a newer post-mutation refresh', async () => {
    let resolveInitial!: (group: ReturnType<typeof groupDetails>) => void
    const initial = new Promise<ReturnType<typeof groupDetails>>(resolve => { resolveInitial = resolve })
    const oldGroup = { ...groupDetails(), title: 'Old Group', forum: true }
    const currentGroup = { ...groupDetails(), title: 'Current Group', forum: true }
    const refreshedGroup = { ...groupDetails(), title: 'New Group', forum: false }
    const getGroup = vi.fn()
      .mockImplementationOnce(() => initial)
      .mockResolvedValueOnce(currentGroup)
      .mockResolvedValueOnce(refreshedGroup)
    const controller = new AbortController(); const client = interactiveClient({ getGroup })
    const stdout = new MockStdout(72, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(getGroup).toHaveBeenCalledTimes(1))
    stdin.write('/chat title New'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/chat title New')); stdin.write('\r')
    await vi.waitFor(() => expect(getGroup).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Done'))
    resolveInitial(oldGroup); await new Promise(resolve => setTimeout(resolve, 20))
    stdin.write('\u001b'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('message before command'))
    stdin.write('/topic list'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('disabled: This command requires a fo'))
    expect(client.groups.listTopics).not.toHaveBeenCalled()
    controller.abort(); app.unmount()
  })

  it('owns the content and input until Esc after a successful command', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen
      chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false}
      createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined}
    />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('message before command'))
    stdin.write('/topic list')
    await vi.waitFor(() => expect(stdout.output).toContain('› /topic list'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Done'))
    let frame = lastTerminalFrame(stdout.output)
    expect(frame).not.toContain('message before command')
    expect(frame).not.toContain('To:')
    expect(frame).toContain('Esc to return to chat')

    stdin.write('ordinary\t\u001b[A\u001b[B\r')
    await new Promise(resolve => setTimeout(resolve, 20))
    frame = lastTerminalFrame(stdout.output)
    expect(frame).toContain('Done')
    expect(frame).not.toContain('ordinary')
    expect(client.sendMessage).not.toHaveBeenCalled()

    stdin.write('\u001b')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('message before command'))
    frame = lastTerminalFrame(stdout.output)
    expect(frame).toContain('To:')
    expect(frame).not.toContain('/topic list')
    controller.abort()
    app.unmount()
  })

  it('ignores a stale command result after Esc and preserves newly typed input', async () => {
    let resolveLookup!: (value: unknown) => void
    const lookup = new Promise((resolve) => { resolveLookup = resolve })
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn(() => lookup) })
    const stdout = new MockStdout(80, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen
      chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false}
      createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined}
    />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })

    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/topic list')
    await vi.waitFor(() => expect(stdout.output).toContain('› /topic list'))
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('Running group command'))
    stdin.write('\u001b')
    await new Promise(resolve => setTimeout(resolve, 30))
    stdin.write('n')
    stdin.write('e')
    stdin.write('w')
    const outputBeforeResolve = stdout.output.length
    resolveLookup(groupDetails())
    await new Promise(resolve => setTimeout(resolve, 0))
    await vi.waitFor(() => expect(stdout.output).toContain('/topic listnew'))
    expect(stdout.output.slice(outputBeforeResolve)).not.toContain('Done')
    controller.abort()
    app.unmount()
  })

  it('keeps command input and unlocks editing when group lookup rejects', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockRejectedValue(new Error('lookup failed')) })
    const stdout = new MockStdout(80, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen
      chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false}
      createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined}
    />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/topic list')
    await vi.waitFor(() => expect(stdout.output).toContain('› /topic list'))
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('lookup failed'))
    stdin.write('x')
    await vi.waitFor(() => expect(stdout.output).toContain('/topic listx'))
    expect(client.sendMessage).not.toHaveBeenCalled()
    controller.abort()
    app.unmount()
  })
})

describe('interactive listen sender formatting', () => {
  it('appends sender ids in single-chat and multi-chat headers', () => {
    expect(formatInteractiveListenSender({ sender: 'Alice', senderId: 123 }))
      .toBe('Alice (123)')
    expect(formatInteractiveListenSender({ sender: 'Alice', senderId: 123, chatName: 'News' }))
      .toBe('News | Alice (123)')
  })

  it('keeps the sender name unchanged when the id is missing', () => {
    expect(formatInteractiveListenSender({ sender: 'Alice', senderId: null }))
      .toBe('Alice')
  })

  it('does not repeat the id when it is already the sender fallback', () => {
    expect(formatInteractiveListenSender({ sender: '123', senderId: 123 }))
      .toBe('123')
  })
})

describe('ListenAttachmentLine', () => {
  it('shows a selectable download action and completed path', () => {
    const selectable = renderToString(
      <ListenAttachmentLine label="📎 Photo" selected state={{ status: 'idle' }} />,
    )
    const completed = renderToString(
      <ListenAttachmentLine
        label="📎 Photo"
        selected={false}
        state={{ status: 'completed', path: '/tmp/photo.jpg' }}
      />,
    )

    expect(selectable).toContain('󰇚 Download')
    expect(completed).toContain('/tmp/photo.jpg')
  })

  it('renders queued auto-downloads', () => {
    expect(renderToString(
      <ListenAttachmentLine label="📎 Photo" selected={false} state={{ status: 'queued' }} />,
    )).toContain('[Queued]')
  })
})

describe('interactive auto-download state', () => {
  it('accepts a sent message immediately and rejects a later duplicate update', () => {
    const seen = new Set<string>()
    const order: string[] = []
    const emitted: StoredMessageInput[] = []
    const sent = storedPhoto(99, 'sent from composer')

    expect(acceptListenMessage(sent, seen, order, (message) => emitted.push(message))).toBe(true)
    expect(acceptListenMessage(sent, seen, order, (message) => emitted.push(message))).toBe(false)
    expect(emitted).toEqual([sent])
  })

  it('maps every coordinator event to display state and removes cancelled entries', () => {
    const key = '100:11:0'
    let state = applyAutoDownloadEvent({}, { status: 'queued', key })
    expect(state).toEqual({ [key]: { status: 'queued' } })
    state = applyAutoDownloadEvent(state, { status: 'downloading', key, progress: 42 })
    expect(state[key]).toEqual({ status: 'downloading', progress: 42 })
    state = applyAutoDownloadEvent(state, { status: 'completed', key, path: '/tmp/photo.jpg' })
    expect(state[key]).toEqual({ status: 'completed', path: '/tmp/photo.jpg' })
    state = applyAutoDownloadEvent(state, { status: 'failed', key, error: 'network' })
    expect(state[key]).toEqual({ status: 'failed', error: 'network' })
    expect(applyAutoDownloadEvent(state, { status: 'cancelled', key })).toEqual({})
  })

  it('suppresses duplicate manual downloads while automatic work is active', () => {
    expect(canManuallyDownload({ status: 'idle' })).toBe(true)
    expect(canManuallyDownload({ status: 'failed', error: 'retry me' })).toBe(true)
    expect(canManuallyDownload({ status: 'queued' })).toBe(false)
    expect(canManuallyDownload({ status: 'downloading', progress: 1 })).toBe(false)
    expect(canManuallyDownload({ status: 'completed', path: '/tmp/file' })).toBe(false)
  })

  it('uses per-source-message attachment indexes for album keys', () => {
    const row = toListenMessage([storedPhoto(11, ''), storedPhoto(12, 'caption')], true)
    expect(row.media.map((_, index) => attachmentDownloadKeyAt(row.media, index)))
      .toEqual(['100:11:0', '100:12:0'])
  })

  it('retains active states until their delayed album becomes visible', () => {
    expect(pruneAttachmentDownloadStates({
      queued: { status: 'queued' },
      active: { status: 'downloading', progress: 5 },
      done: { status: 'completed', path: '/tmp/done' },
    }, new Set(), new Set(['queued', 'active']))).toEqual({
      queued: { status: 'queued' },
      active: { status: 'downloading', progress: 5 },
    })
  })

  it('retains a terminal album download through an unrelated render, then releases it for history pruning', () => {
    const key = '100:11:0'
    const completed = applyAutoDownloadEvent({}, { status: 'completed', key, path: '/tmp/photo.jpg' })
    const whilePending = pruneAttachmentDownloadStates(completed, new Set(['other']), new Set([key]))
    expect(whilePending[key]).toEqual({ status: 'completed', path: '/tmp/photo.jpg' })
    expect(canManuallyDownload(whilePending[key]!)).toBe(false)

    const onceRendered = pruneAttachmentDownloadStates(whilePending, new Set([key]), new Set())
    expect(onceRendered[key]).toEqual({ status: 'completed', path: '/tmp/photo.jpg' })
    expect(pruneAttachmentDownloadStates(onceRendered, new Set(), new Set())).toEqual({})
  })

  it('does not retain hidden-media downloads as pending render ownership', () => {
    const pending = new Set<string>(['old-visible-key'])
    registerPendingAttachmentKeys(pending, storedPhoto(11, ''), false)
    registerPendingAttachmentKeys(pending, storedPhoto(12, ''), false)
    expect(pending).toEqual(new Set())

    const completed = applyAutoDownloadEvent({}, {
      status: 'completed', key: '100:12:0', path: '/tmp/photo.jpg',
    })
    expect(pruneAttachmentDownloadStates(completed, new Set(), pending)).toEqual({})
    expect(applyAutoDownloadEvent(completed, {
      status: 'completed', key: '100:13:0', path: '/tmp/another.jpg',
    }, false)).toEqual({})
  })
})

describe('interactive auto-download lifecycle', () => {
  it('keeps a rerendered generation current when the old listen finishes later', async () => {
    const controller = createInteractiveOperationController()
    const oldLifecycle = controller.beginGeneration()
    let resolveOld!: () => void
    const oldListen = new Promise<void>((resolve) => { resolveOld = resolve })
    let status = 'old-running'
    let exits = 0
    const oldFinally = oldListen.then(() => {
      if (oldLifecycle.isActive()) {
        status = 'old-stopped'
        exits += 1
      }
    })
    oldLifecycle.dispose()
    const newLifecycle = controller.beginGeneration()
    status = 'new-connected'
    resolveOld()
    await oldFinally
    expect(newLifecycle.isActive()).toBe(true)
    expect(status).toBe('new-connected')
    expect(exits).toBe(0)
  })

  it('rejects deferred send and download continuations after lifecycle cleanup', async () => {
    const controller = createInteractiveOperationController()
    const lifecycle = controller.beginGeneration()
    const sendIsCurrent = controller.beginSend()
    const downloadOwnership = controller.beginDownload('100:11:0')
    const updates: string[] = []
    const send = Promise.resolve().then(() => {
      if (sendIsCurrent()) updates.push('sent')
    })
    const download = Promise.resolve().then(() => {
      if (downloadOwnership.isCurrent()) updates.push('downloaded')
    })
    lifecycle.dispose()
    await Promise.all([send, download])
    expect(updates).toEqual([])
  })

  it('prevents deferred manual progress and completion from overwriting a newer auto event', async () => {
    const controller = createInteractiveOperationController()
    controller.beginGeneration()
    const manualOwnership = controller.beginDownload('100:11:0')
    let resolveManual!: () => void
    const manual = new Promise<void>((resolve) => { resolveManual = resolve })
    controller.claimDownload('100:11:0')
    let state = applyAutoDownloadEvent({}, {
      status: 'downloading', key: '100:11:0', progress: 75,
    })
    const progress = () => {
      if (manualOwnership.isCurrent()) state = { '100:11:0': { status: 'downloading', progress: 10 } }
    }
    const completion = manual.then(() => {
      if (manualOwnership.isCurrent()) state = { '100:11:0': { status: 'completed', path: '/tmp/manual.jpg' } }
    })
    progress()
    resolveManual()
    await completion
    expect(state['100:11:0']).toEqual({ status: 'downloading', progress: 75 })
  })

  it('bounds ownership across many terminal auto-downloads without reviving stale callbacks', () => {
    const controller = createInteractiveOperationController()
    const lifecycle = controller.beginGeneration()
    const stale = controller.beginDownload('same-key')
    stale.release()
    const replacement = controller.beginDownload('same-key')
    expect(stale.isCurrent()).toBe(false)
    expect(replacement.isCurrent()).toBe(true)
    replacement.release()

    const active = Array.from({ length: 1_000 }, (_, index) => (
      controller.claimDownload(`key-${index}`)
    ))
    expect(controller.downloadOwnershipSize()).toBe(1_000)
    active.forEach((ownership) => ownership.release())
    expect(controller.downloadOwnershipSize()).toBe(0)
    expect(stale.isCurrent()).toBe(false)

    controller.claimDownload('left-active')
    lifecycle.dispose()
    expect(controller.downloadOwnershipSize()).toBe(0)
  })

  it.each([
    ['no client', () => { throw new Error('not connected') }],
    ['setup failure', () => { throw new Error('mkdir failed') }],
  ])('releases manual ownership after %s', async (_, operation) => {
    const controller = createInteractiveOperationController()
    controller.beginGeneration()
    const ownership = controller.beginDownload('100:11:0')
    const errors: string[] = []

    await runOwnedAttachmentOperation(ownership, operation, (error) => errors.push(String(error)))

    expect(errors).toHaveLength(1)
    expect(controller.downloadOwnershipSize()).toBe(0)
    expect(ownership.isCurrent()).toBe(false)
  })

  it('creates one coordinator, pauses across disconnect, resumes replacement, and drains normally', async () => {
    const calls: string[] = []
    const first = lifecycleClient('disconnected', calls, 'first')
    const second = lifecycleClient('stopped', calls, 'second')
    const clients = [first, second]
    const coordinator = {
      setClient: vi.fn((client: unknown) => calls.push(client == null ? 'pause' : 'resume')),
      enqueue: vi.fn(() => true),
      waitForActive: vi.fn(async () => { calls.push('active-drained') }),
      waitForIdle: vi.fn(async () => { calls.push('idle-drained') }),
      stop: vi.fn(),
    }
    const createCoordinator = vi.fn(() => coordinator)
    const hiddenPending = new Set<string>(['stale'])

    await runInteractiveAutoDownloadLifecycle({
      autoDownload: true,
      chats: undefined,
      persist: true,
      retrySeconds: 0,
      signal: new AbortController().signal,
      createClient: () => clients.shift()!,
      createCoordinator,
      onBeforeEnqueue: (message) => registerPendingAttachmentKeys(hiddenPending, message, false),
      onMessage: () => undefined,
      sleep: async () => undefined,
    })

    expect(createCoordinator).toHaveBeenCalledOnce()
    expect(coordinator.enqueue).toHaveBeenCalledTimes(2)
    expect(hiddenPending).toEqual(new Set())
    expect(calls).toEqual([
      'resume', 'first-listen', 'pause', 'active-drained', 'first-close',
      'resume', 'second-listen', 'idle-drained', 'second-close',
    ])
  })

  it('stops and closes promptly on abort, then waits for active cleanup', async () => {
    const controller = new AbortController()
    let resolveListen!: (value: 'stopped') => void
    let resolveCleanup!: () => void
    const listen = new Promise<'stopped'>((resolve) => { resolveListen = resolve })
    const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve })
    const close = vi.fn(async () => { resolveListen('stopped') })
    const onMessage = vi.fn()
    let deliver!: (message: StoredMessageInput) => void
    const coordinator = {
      setClient: vi.fn(), enqueue: vi.fn(() => true), stop: vi.fn(),
      waitForIdle: vi.fn(async () => undefined), waitForActive: vi.fn(() => cleanup),
    }
    const run = runInteractiveAutoDownloadLifecycle({
      autoDownload: true, chats: undefined, persist: true, retrySeconds: 1,
      signal: controller.signal,
      createClient: () => ({
        listen: vi.fn((options: { onMessage: (message: StoredMessageInput) => void }) => {
          deliver = options.onMessage
          return listen
        }),
        close,
      } as unknown as import('../../src/telegram/types.js').TelegramClientAdapter),
      createCoordinator: () => coordinator,
      onMessage,
    })
    await Promise.resolve()
    controller.abort()
    deliver(storedPhoto(99, 'late'))
    expect(onMessage).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    expect(coordinator.stop).toHaveBeenCalled()
    let finished = false
    void run.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    resolveCleanup()
    await run
  })
})

describe('ListenImagePreview', () => {
  it('renders upper-half-block preview cells', () => {
    const preview = decodeImagePreview(twoByTwoJpeg, 2)

    expect(preview).not.toBeNull()
    expect(renderToString(<ListenImagePreview rows={preview?.rows ?? []} />)).toContain('▀')
  })
})

describe('ListenAttachmentWithPreview', () => {
  it('renders the download line before a true-color image preview', () => {
    const preview = decodeImagePreview(twoByTwoJpeg, 24)
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="📎 Photo"
        selected={false}
        state={{ status: 'idle' }}
        previewCells={preview?.rows}
      />,
    )

    expect(output).toContain('📎 Photo  [󰇚 Download]')
    expect(output).toContain('▀')
    expect(output.indexOf('📎 Photo')).toBeLessThan(output.indexOf('▀'))
  })

  it('keeps the download line but omits previews without true color', () => {
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="📎 Photo"
        selected={false}
        state={{ status: 'idle' }}
        previewCells={undefined}
      />,
    )

    expect(output).toContain('📎 Photo')
    expect(output).not.toContain('▀')
  })

  it('renders provided cells without requiring encoded image input', () => {
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="📎 Photo"
        selected={false}
        state={{ status: 'idle' }}
        previewCells={[[{ glyph: '▀', foreground: '#112233', background: '#445566' }]]}
      />,
    )

    expect(output).toContain('▀')
  })

  it('renders informational media without download state or action', () => {
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="👤 Contact · Zhang San · +86 13800138000"
        downloadable={false}
        selected={false}
        state={{ status: 'failed', error: 'should not be visible' }}
      />,
    )

    expect(output).toContain('👤 Contact · Zhang San · +86 13800138000')
    expect(output).not.toContain('Download')
    expect(output).not.toContain('Failed')
    expect(output).not.toContain('should not be visible')
  })

})

describe('collectDownloadableAttachments', () => {
  it('excludes informational media while preserving downloadable media indexes', () => {
    const message: ListenMessage = {
      key: '100:1',
      chatId: 100,
      msgId: 1,
      time: '16:44',
      sender: 'Alice',
      senderId: null,
      content: null,
      media: [
        {
          chatId: 100,
          messageId: 1,
          kind: 'Contact',
          label: '👤 Contact · Zhang San · +86 13800138000',
          fileName: null,
          mimeType: null,
          downloadable: false,
        },
        {
          chatId: 100,
          messageId: 2,
          kind: 'Photo',
          label: '📎 Photo',
          fileName: null,
          mimeType: null,
          downloadable: true,
        },
      ],
    }

    expect(collectDownloadableAttachments([message]).map(({ key, attachment }) => ({
      key,
      kind: attachment.kind,
    }))).toEqual([{ key: '100:2:0', kind: 'Photo' }])
  })
})

describe('ListenStatus', () => {
  it('reports unseen messages while history is being viewed', () => {
    expect(renderToString(<ListenStatus status="connected" unseenCount={3} />))
      .toContain('connected · ↓ 3 new messages')
    expect(renderToString(<ListenStatus status="connected" unseenCount={0} />))
      .toBe('connected')
  })

})

describe('ListenStatusArea', () => {
  it('shows the auto-download reminder when enabled', () => {
    expect(renderToString(
      <ListenStatusArea status="connected" unseenCount={0} autoDownload />,
    )).toContain('Auto-download enabled')
  })

  it('hides the auto-download reminder when disabled', () => {
    expect(renderToString(
      <ListenStatusArea status="connected" unseenCount={0} autoDownload={false} />,
    )).not.toContain('Auto-download enabled')
  })
})

describe('calculateListenMessagePaneHeight', () => {
  it('reserves one line each for the auto-download reminder and note', () => {
    expect(calculateListenMessagePaneHeight(20, false, false)).toBe(13)
    expect(calculateListenMessagePaneHeight(20, false, true)).toBe(12)
    expect(calculateListenMessagePaneHeight(20, true, false)).toBe(12)
    expect(calculateListenMessagePaneHeight(20, true, true)).toBe(11)
  })
})

describe('interactive album messages', () => {
  it('creates one row and keeps each attachment download message ID', () => {
    const row = toListenMessage([
      storedPhoto(11, ''),
      storedPhoto(12, 'album caption'),
    ], true)

    expect(row.content).toBe('album caption')
    expect(row.media).toHaveLength(2)
    expect(attachmentDownloadTarget(row.media[1]!)).toEqual({ chat: 100, msgId: 12 })
  })

  it('decodes an eligible preview once while constructing its view model', () => {
    const decodePreview = vi.fn(() => ({
      width: 1,
      rows: [[{ glyph: '▀' as const, foreground: '#ffffff', background: '#000000' }]],
    }))
    const photo = { ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }

    const row = toListenMessage([photo], {
      showMedia: true,
      previewWidth: 24,
      colorDepth: 24,
      decodePreview,
    })

    expect(decodePreview).toHaveBeenCalledOnce()
    expect(row.media[0]?.previewRows).toBe(1)
    expect(row.media[0]?.previewCells).toHaveLength(1)
  })

  it('keeps image previews hidden in the default interactive policy', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const colorDepth = interactiveListenPreviewColorDepth(24)

    const row = toListenMessage(
      [{ ...storedPhoto(99, ''), preview_jpeg_base64: twoByTwoJpeg }],
      { showMedia: true, previewWidth: 24, colorDepth, decodePreview },
    )

    expect(colorDepth).toBe(1)
    expect(decodePreview).not.toHaveBeenCalled()
    expect(row.media[0]?.previewRows).toBeUndefined()
    expect(row.media[0]?.previewCells).toBeUndefined()
  })

  it('does not decode unchanged previews again when a new group arrives', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const first = [{ ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }]
    const second = [{ ...storedPhoto(12, ''), preview_jpeg_base64: twoByTwoJpeg }]
    const cache = new ListenMessageViewCache()
    const context = { showMedia: true, previewWidth: 20, colorDepth: 24, decodePreview }

    cache.build([first], context)
    const rows = cache.build([first, second], context)

    expect(decodePreview).toHaveBeenCalledTimes(2)
    expect(rows.map((row) => row.key)).toEqual(['100:11', '100:12'])
  })

  it('bounds retained groups and cache entries while reusing retained previews', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const groups = Array.from({ length: LISTEN_HISTORY_LIMIT + 1 }, (_, index) => [
      { ...storedPhoto(index + 1, ''), preview_jpeg_base64: twoByTwoJpeg },
    ])
    const cache = new ListenMessageViewCache()
    const context = { showMedia: true, previewWidth: 20, colorDepth: 24, decodePreview }
    const initial = pruneListenMessageGroups(groups.slice(0, LISTEN_HISTORY_LIMIT))

    cache.build(initial.groups, context)
    const retained = pruneListenMessageGroups(groups)
    const rows = cache.build(retained.groups, context)

    expect(retained.groups).toHaveLength(LISTEN_HISTORY_LIMIT)
    expect(retained.removedKeys).toEqual(['100:1'])
    expect(rows[0]?.key).toBe('100:2')
    expect(cache.size).toBe(LISTEN_HISTORY_LIMIT)
    expect(decodePreview).toHaveBeenCalledTimes(LISTEN_HISTORY_LIMIT + 1)
  })

  it('rebuilds albums on resize while preserving grouping and stable keys', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const album = [
      { ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg },
      { ...storedPhoto(12, 'caption'), preview_jpeg_base64: twoByTwoJpeg },
    ]
    const cache = new ListenMessageViewCache()

    const before = cache.build([album], { showMedia: true, previewWidth: 10, colorDepth: 24, decodePreview })
    const after = cache.build([album], { showMedia: true, previewWidth: 12, colorDepth: 24, decodePreview })

    expect(decodePreview).toHaveBeenCalledTimes(4)
    expect(after).toHaveLength(1)
    expect(after[0]?.key).toBe(before[0]?.key)
    expect(new Set(after.map((row) => row.key)).size).toBe(after.length)
    expect(after[0]?.media.map((item) => item.messageId)).toEqual([11, 12])
  })

  it('caps preview decoding width at 24 cells', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))

    toListenMessage([{ ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }], {
      showMedia: true,
      previewWidth: 100,
      colorDepth: 24,
      decodePreview,
    })

    expect(decodePreview).toHaveBeenCalledWith(twoByTwoJpeg, 24)
  })

  it.each([
    { showMedia: false, colorDepth: 24 },
    { showMedia: true, colorDepth: 8 },
  ])('does not decode or expose preview cells for $showMedia/$colorDepth capability', (capability) => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const row = toListenMessage([{ ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }], {
      ...capability,
      previewWidth: 20,
      decodePreview,
    })

    expect(decodePreview).not.toHaveBeenCalled()
    expect(row.media.every((item) => item.previewRows == null && item.previewCells == null)).toBe(true)
  })

  it('flushes pending albums before deferring terminal exit', () => {
    vi.useFakeTimers()
    const calls: string[] = []

    flushListenBeforeExit({ flush: () => calls.push('flush') }, () => calls.push('exit'))

    expect(calls).toEqual(['flush'])
    vi.runAllTimers()
    expect(calls).toEqual(['flush', 'exit'])
    vi.useRealTimers()
  })
})

describe('listen scroll state', () => {
  it('selects complete messages at the live and historical positions', () => {
    const messages = [message('old', 2), message('middle', 3), message('new', 2)]

    expect(takeListenViewport(messages, 5, 0).map((item) => item.sender)).toEqual(['middle', 'new'])
    expect(takeListenViewport(messages, 5, 1).map((item) => item.sender)).toEqual(['old', 'middle'])
  })

  it('clamps scrolling and clears unseen arrivals on return to live view', () => {
    expect(applyScroll({ offset: 0, unseenCount: 0 }, 'up', 3)).toEqual({ offset: 1, unseenCount: 0 })
    expect(applyScroll({ offset: 1, unseenCount: 2 }, 'down', 3)).toEqual({ offset: 0, unseenCount: 0 })
    expect(applyScroll({ offset: 3, unseenCount: 2 }, 'up', 3)).toEqual({ offset: 3, unseenCount: 2 })
  })

  it('anchors a historical viewport when a message arrives', () => {
    expect(applyMessageArrival({ offset: 2, unseenCount: 1 })).toEqual({ offset: 3, unseenCount: 2 })
    expect(applyMessageArrival({ offset: 0, unseenCount: 0 })).toEqual({ offset: 0, unseenCount: 0 })
  })

  it('counts image preview rows when selecting complete messages', () => {
    const old = message('old', 2)
    const current = message('current', 3)
    current.media[0] = {
      ...current.media[0]!,
      previewRows: 3,
      previewCells: [],
    }

    expect(takeListenViewport([old, current], 6, 0).map((item) => item.sender)).toEqual(['current'])
  })
})

function message(sender: string, lineCount: number): ListenMessageRow {
  const mediaCount = Math.max(0, lineCount - 2)
  return {
    time: '16:44',
    sender,
    senderId: null,
    content: null,
    media: Array.from({ length: mediaCount }, (_, index) => ({
      chatId: 100,
      kind: 'Photo',
      label: `Photo ${index}`,
      fileName: null,
      mimeType: null,
      downloadable: true,
      messageId: index + 1,
    })),
  }
}

function storedPhoto(msgId: number, content: string): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content,
    timestamp: '2026-07-10T07:22:00.000Z',
    raw_json: { _: 'message', media: { _: 'messageMediaPhoto', photo: {} } },
  }
}

function lifecycleClient(result: 'disconnected' | 'stopped', calls: string[], name: string) {
  return {
    listen: vi.fn(async (options: { onMessage: (message: StoredMessageInput) => void }) => {
      calls.push(`${name}-listen`)
      options.onMessage(storedPhoto(name === 'first' ? 11 : 12, ''))
      return result
    }),
    close: vi.fn(async () => { calls.push(`${name}-close`) }),
  } as unknown as import('../../src/telegram/types.js').TelegramClientAdapter
}

function groupDetails() {
  return { id: 100, title: 'Test Group', type: 'supergroup', forum: true, current_user_role: 'creator' }
}

function interactiveClient(groups: { getGroup: ReturnType<typeof vi.fn> }) {
  return {
    groups: {
      ...groups,
      listTopics: vi.fn().mockResolvedValue([]),
      banMember: vi.fn(),
      deleteGroup: vi.fn(),
      promoteAdmin: vi.fn(),
      setTitle: vi.fn(),
    },
    listen: vi.fn(async ({ onConnected, onMessage, signal }: { onConnected?: () => void; onMessage: (message: StoredMessageInput) => void; signal: AbortSignal }) => {
      onConnected?.()
      onMessage(storedPhoto(88, 'message before command'))
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return 'stopped' as const
    }),
    close: vi.fn(async () => undefined),
    getChatInfo: vi.fn(async () => null),
    sendMessage: vi.fn(),
  } as unknown as import('../../src/telegram/types.js').TelegramClientAdapter & { groups: { getGroup: ReturnType<typeof vi.fn>; listTopics: ReturnType<typeof vi.fn>; banMember: ReturnType<typeof vi.fn>; deleteGroup: ReturnType<typeof vi.fn>; promoteAdmin: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> }; sendMessage: ReturnType<typeof vi.fn> }
}

function lastTerminalFrame(output: string): string {
  return output.split('\u001b[H').at(-1) ?? output
}

const twoByTwoJpeg =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19i' +
  'Z2hnPk1xeXBkeFxlZ2MBERISGBUYLxoaL2NCOEJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj' +
  'Y2NjY//AABEIAAIAAgMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQEC' +
  'AwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm' +
  'Z2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq' +
  '8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIy' +
  'gQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SF' +
  'hoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEA' +
  'AhEDEQA/AOs0W1t30SwZ4ImZraMklASTtFViaFJVppRW76LuYujTm+aUU2/I/wD/2Q=='

class MockStdout extends EventEmitter {
  isTTY = true
  output = ''

  constructor(
    public columns: number,
    public rows: number,
    public colorDepth: number,
  ) {
    super()
  }

  getColorDepth(): number {
    return this.colorDepth
  }

  write(value: unknown): boolean {
    this.output += String(value)
    return true
  }
}

class MockStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

function TerminalMetricsHarness({
  stdout,
  decodePreview,
  onMetrics,
}: {
  stdout: MockStdout
  decodePreview: typeof decodeImagePreview
  onMetrics: (metrics: { columns: number; rows: number; colorDepth: number }) => void
}): React.JSX.Element {
  const metrics = useTerminalMetrics(stdout)
  React.useEffect(() => onMetrics(metrics), [metrics, onMetrics])
  toListenMessage([{ ...storedPhoto(99, ''), preview_jpeg_base64: twoByTwoJpeg }], {
    showMedia: true,
    previewWidth: metrics.columns - 3,
    colorDepth: metrics.colorDepth,
    decodePreview,
  })
  return <Text>{metrics.columns}x{metrics.rows}@{metrics.colorDepth}</Text>
}
