import React, { act } from 'react'
import { render, renderToString, Text } from 'ink'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  createInteractiveListenGroupQueue,
  createInteractiveListenRuntime,
  createInteractiveOperationController,
  flushListenBeforeExit,
  formatInteractiveListenHeader,
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
  ListenMessageBody,
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
import { DISABLE_MOUSE_REPORTING } from '../../src/presenters/ink/mouse-scroll.js'
import { applyMessageArrival, applyScroll, takeListenViewport } from '../../src/presenters/ink/listen-scroll.js'
import type { ListenMessageRow } from '../../src/presenters/listen-message.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('runInteractiveListen', () => {
  it('keeps mouse reporting disabled for native text selection', async () => {
    const calls: string[] = []

    const result = await runInteractiveListen(
      (value) => calls.push(value),
      async () => {
        calls.push('run')
        return 'completed'
      },
    )

    expect(result).toBe('completed')
    expect(calls).toEqual([DISABLE_MOUSE_REPORTING, 'run'])
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
  it('discovers reply with group commands and completes fuzzy reply input', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/'); await vi.waitFor(() => {
      const frame = lastTerminalFrame(stdout.output)
      expect(frame).toContain('reply  Reply to a message')
      expect(frame).toContain('member ban')
    })
    stdin.write('rpy'); await vi.waitFor(() => {
      const frame = lastTerminalFrame(stdout.output)
      expect(frame).toContain('Reply to a message')
      expect(frame).toContain('› /rpy')
    })
    stdin.write('\t'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› /reply'))
    controller.abort(); app.unmount()
  })

  it('resets selection after Tab completes the second discovered command', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› reply'))
    stdin.write('\u001b[B'); stdin.write('\t')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› /member add'))
    stdin.write('\r'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Missing argument: users'))
    expect(lastTerminalFrame(stdout.output)).not.toContain('No matching command')
    controller.abort(); app.unmount()
  })

  it('resets selection after Enter completes the second discovered command', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› reply'))
    stdin.write('\u001b[B'); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› /member add'))
    stdin.write('\r'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Missing argument: users'))
    expect(lastTerminalFrame(stdout.output)).not.toContain('No matching command')
    controller.abort(); app.unmount()
  })

  it('restores the first command after Down, Escape, then Tab', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› reply'))
    stdin.write('\u001b[B'); stdin.write('\u001b')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).not.toContain('Reply to a message'))
    stdin.write('\t')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› /reply'))
    expect(lastTerminalFrame(stdout.output)).not.toContain('› /member add')
    controller.abort(); app.unmount()
  })

  it('restores the first command after Down, Escape, then Enter', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› reply'))
    stdin.write('\u001b[B'); stdin.write('\u001b')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).not.toContain('Reply to a message'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› /reply'))
    expect(lastTerminalFrame(stdout.output)).not.toContain('› /member add')
    controller.abort(); app.unmount()
  })

  it('executes a selected reply without submitting it as a group command', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    client.sendMessage.mockResolvedValue({ sent_message: storedPhoto(99, 'reply sent') })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/reply 88 hello'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/reply 88 hello'))
    stdin.write('\r')
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith({ chat: 100, message: 'hello', reply: 88, linkPreview: true }))
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('replied to #88'))
    expect(client.groups.getGroup).toHaveBeenCalledTimes(1)
    controller.abort(); app.unmount()
  })

  it('locks repeated reply submission and does not clear newer input after Escape', async () => {
    let resolveSend!: (value: { sent_message: StoredMessageInput }) => void
    const pending = new Promise<{ sent_message: StoredMessageInput }>(resolve => { resolveSend = resolve })
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    client.sendMessage.mockReturnValue(pending)
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/reply 88 slow'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/reply 88 slow'))
    stdin.write('\r'); await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1)); stdin.write('\r')
    stdin.write('\u001b'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).not.toContain('(sending...)')); stdin.write(' newer')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/reply 88 slow newer'))
    resolveSend({ sent_message: storedPhoto(99, 'late') })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastTerminalFrame(stdout.output)).toContain('/reply 88 slow newer')
    controller.abort(); app.unmount()
  })

  it('retains a failed reply for retry and sends its exact files and caption', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const sendMedia = vi.fn().mockRejectedValueOnce(new Error('upload failed')).mockResolvedValue({ messages: [] })
    Object.assign(client, { sendMedia })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    const command = '/reply 88 exact caption --file ./a.jpg --file ./b.png'
    stdin.write(command); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain(command)); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('send failed: upload failed'))
    expect(lastTerminalFrame(stdout.output)).toContain(command)
    stdin.write('\r'); await vi.waitFor(() => expect(sendMedia).toHaveBeenCalledTimes(2))
    expect(sendMedia).toHaveBeenLastCalledWith({ chat: 100, files: ['./a.jpg', './b.png'], caption: 'exact caption', reply: 88 })
    controller.abort(); app.unmount()
  })

  it('does not send a reply when no single target is selected', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24); const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100, 200]} persist retrySeconds={1} sendTo={undefined} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    stdin.write('/reply 88 nope'); await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/reply 88 nope')); stdin.write('\r')
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('set --send-to before replying'))
    expect(client.sendMessage).not.toHaveBeenCalled()
    controller.abort(); app.unmount()
  })

  it('reports an ambiguous multi-chat target without writing', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:"
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
    const app = render(<InteractiveListen dbPath=":memory:"
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

  it('executes a read-only group command while write access is disabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-listen-read-only-'))
    const previousDataDir = process.env.DATA_DIR
    writeFileSync(join(dataDir, 'config.json'), '{"write_access":false}\n')
    process.env.DATA_DIR = dataDir
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(80, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:"
      chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false}
      createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined}
    />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })

    try {
      await vi.waitFor(() => expect(stdout.output).toContain('connected'))
      stdin.write('/topic list')
      await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/topic list'))
      stdin.write('\r')
      await vi.waitFor(() => expect(client.groups.listTopics).toHaveBeenCalledWith({ chat: 100, limit: 100 }))
    } finally {
      controller.abort()
      app.unmount()
      if (previousDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('defaults confirmation to Cancel and locks rapid confirmed execution to one write', async () => {
    let release!: () => void
    const deferred = new Promise<void>(resolve => { release = resolve })
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    client.groups.banMember.mockImplementation(() => deferred)
    const stdout = new MockStdout(50, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:"
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

  it.each([
    ['Escape', '\u001b'],
    ['Ctrl-C', '\u0003'],
  ])('keeps an in-flight ownership transfer visible through %s and renders its outcome', async (_name, keypress) => {
    let resolveTransfer!: (value: { operation: 'transferOwnership'; chat_id: number; target_id: number }) => void
    const transfer = new Promise<{ operation: 'transferOwnership'; chat_id: number; target_id: number }>(resolve => { resolveTransfer = resolve })
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    client.groups.transferOwnership.mockImplementation(() => transfer)
    const onRequestStop = vi.fn()
    const stdout = new MockStdout(60, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={onRequestStop} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    await act(async () => { stdin.write('/admin transfer-owner 7') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/admin transfer-owner 7'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Telegram 2FA password'))
    expect(client.groups.getGroup).toHaveBeenCalledTimes(2)
    await act(async () => { stdin.write('secret') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Running group command'))

    await act(async () => { stdin.write(keypress) })
    expect(lastTerminalFrame(stdout.output)).toContain('Running group command')
    expect(client.groups.transferOwnership).toHaveBeenCalledTimes(1)
    expect(onRequestStop).not.toHaveBeenCalled()
    resolveTransfer({ operation: 'transferOwnership', chat_id: 100, target_id: 7 })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Done'))
    expect(stdout.output).not.toContain('secret')
    if (_name === 'Ctrl-C') await vi.waitFor(() => expect(onRequestStop).toHaveBeenCalledOnce())
    else expect(onRequestStop).not.toHaveBeenCalled()

    controller.abort()
    app.unmount()
  })

  it('reports an indeterminate ownership outcome when external shutdown aborts an in-flight transfer', async () => {
    let resolveTransfer!: (value: { operation: 'transferOwnership'; chat_id: number; target_id: number }) => void
    const transfer = new Promise<{ operation: 'transferOwnership'; chat_id: number; target_id: number }>(resolve => { resolveTransfer = resolve })
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    client.groups.transferOwnership.mockImplementation(() => transfer)
    const stdout = new MockStdout(70, 24, 24)
    const stdin = new MockStdin()
    const onRequestStop = vi.fn()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={onRequestStop} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    await act(async () => { stdin.write('/admin transfer-owner 7') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Telegram 2FA password'))
    await act(async () => { stdin.write('secret') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Running group command'))

    controller.abort()
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('outcome is indeterminate'))
    await vi.waitFor(() => expect(onRequestStop).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce())

    expect(lastTerminalFrame(stdout.output)).not.toContain('Done')
    expect(client.groups.transferOwnership).toHaveBeenCalledTimes(1)
    expect(stdout.output).not.toContain('secret')
    resolveTransfer({ operation: 'transferOwnership', chat_id: 100, target_id: 7 })
    app.unmount()
  })

  it('forces ownership shutdown when raw Ctrl-C follows an external grace request', async () => {
    const transfer = new Promise<never>(() => undefined)
    let requestShutdown = (): void => undefined
    const shutdownRequests = { subscribe: (listener: () => void) => { requestShutdown = listener; return () => undefined } }
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    client.groups.transferOwnership.mockImplementation(() => transfer)
    const onRequestStop = vi.fn()
    const stdout = new MockStdout(70, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} shutdownRequests={shutdownRequests} onRequestStop={onRequestStop} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    await act(async () => { stdin.write('/admin transfer-owner 7') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Telegram 2FA password'))
    await act(async () => { stdin.write('secret') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Running group command'))

    requestShutdown()
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('waiting briefly'))
    await act(async () => { stdin.write('\u0003') })

    await vi.waitFor(() => expect(stdout.output).toContain('forced shutdown'))
    await vi.waitFor(() => expect(onRequestStop).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce())
    expect(stdout.output).not.toContain('secret')
    app.unmount()
  })

  it('closes an active interactive client once on ordinary unmount', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: new MockStdin() as unknown as NodeJS.ReadStream, stdout: new MockStdout(70, 24, 24) as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(client.listen).toHaveBeenCalledOnce())
    app.unmount()
    await vi.waitFor(() => expect(client.close).toHaveBeenCalled())
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('closes each interactive client once across dependency restart and unmount', async () => {
    const controller = new AbortController()
    const firstClient = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const secondClient = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const createClient = vi.fn().mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient)
    const props = { dbPath: ':memory:', chats: [100], persist: true, retrySeconds: 1, showMedia: false, autoDownload: false, showChatName: false, createClient, stopSignal: controller.signal, onRequestStop: () => undefined }
    const app = render(<InteractiveListen {...props} sendTo={100} />, { stdin: new MockStdin() as unknown as NodeJS.ReadStream, stdout: new MockStdout(70, 24, 24) as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(firstClient.listen).toHaveBeenCalledOnce())

    app.rerender(<InteractiveListen {...props} sendTo={200} />)

    await vi.waitFor(() => expect(firstClient.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(secondClient.listen).toHaveBeenCalledOnce())
    app.unmount()
    await vi.waitFor(() => expect(secondClient.close).toHaveBeenCalledOnce())
    expect(firstClient.close).toHaveBeenCalledOnce()
  })

  it('contains client close rejection during ordinary unmount', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    vi.mocked(client.close).mockRejectedValueOnce(new Error('close failed'))
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: new MockStdin() as unknown as NodeJS.ReadStream, stdout: new MockStdout(70, 24, 24) as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(client.listen).toHaveBeenCalledOnce())
    app.unmount()
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce())
  })

  it.each(['success', 'reject'] as const)('prefers a definitive ownership $outcome that settles during external shutdown grace', async (outcome) => {
    let resolveTransfer!: (value: { operation: 'transferOwnership'; chat_id: number; target_id: number }) => void
    let rejectTransfer!: (error: Error) => void
    const transfer = new Promise<{ operation: 'transferOwnership'; chat_id: number; target_id: number }>((resolve, reject) => { resolveTransfer = resolve; rejectTransfer = reject })
    const controller = new AbortController()
    const neverRefreshes = new Promise<never>(() => undefined)
    const getGroup = vi.fn().mockResolvedValueOnce(groupDetails()).mockResolvedValueOnce(groupDetails()).mockImplementationOnce(() => neverRefreshes)
    const client = interactiveClient({ getGroup })
    client.groups.transferOwnership.mockImplementation(() => transfer)
    const onRequestStop = vi.fn()
    const stdout = new MockStdout(70, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={onRequestStop} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    await act(async () => { stdin.write('/admin transfer-owner 7') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Telegram 2FA password'))
    await act(async () => { stdin.write('secret') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Running group command'))

    controller.abort()
    if (outcome === 'success') resolveTransfer({ operation: 'transferOwnership', chat_id: 100, target_id: 7 })
    else rejectTransfer(new Error('ownership rejected'))

    await vi.waitFor(() => expect(stdout.output).toContain(outcome === 'success' ? 'Done' : 'Telegram request failed.'))
    await vi.waitFor(() => expect(onRequestStop).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce())
    expect(getGroup).toHaveBeenCalledTimes(outcome === 'success' ? 3 : 2)
    expect(stdout.output).not.toContain('outcome is indeterminate')
    expect(stdout.output).not.toContain('secret')
    app.unmount()
  })

  it('refreshes creator capability immediately before requesting an ownership password', async () => {
    const freshNonCreator = { ...groupDetails(), current_user_role: 'admin' as const }
    const getGroup = vi.fn().mockResolvedValueOnce(groupDetails()).mockResolvedValueOnce(freshNonCreator)
    const controller = new AbortController()
    const client = interactiveClient({ getGroup })
    const stdout = new MockStdout(60, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(getGroup).toHaveBeenCalledTimes(1))
    await act(async () => { stdin.write('/admin transfer-owner 7') })
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await act(async () => { stdin.write('\r') })

    await vi.waitFor(() => expect(getGroup).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('requires the group creator'))
    expect(lastTerminalFrame(stdout.output)).not.toContain('Telegram 2FA password')
    expect(client.groups.transferOwnership).not.toHaveBeenCalled()
    controller.abort()
    app.unmount()
  })

  it('requires an exact independently typed title before deleting a chat', async () => {
    const controller = new AbortController()
    const client = interactiveClient({ getGroup: vi.fn().mockResolvedValue(groupDetails()) })
    const stdout = new MockStdout(50, 24, 24)
    const stdin = new MockStdin()
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
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
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
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
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
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
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
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
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
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
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
    await vi.waitFor(() => expect(stdout.output).toContain('connected'))
    await act(async () => { stdin.write('/chat delete') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('/chat delete'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Cancel'))
    await act(async () => { stdin.write('\u001b[A') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Confirm'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('Type the exact title'))
    await act(async () => { stdin.write('Test Groupx') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('› Test Groupx'))
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(lastTerminalFrame(stdout.output)).toContain('does not match exactly'))
    await act(async () => { stdin.write(Buffer.from([8])) })
    await vi.waitFor(() => {
      const frame = lastTerminalFrame(stdout.output)
      expect(frame).toContain('› Test Group')
      expect(frame).not.toContain('does not match exactly')
    })
    expect(lastTerminalFrame(stdout.output)).toContain('› /chat delete')
    await act(async () => { stdin.write('\r') })
    await vi.waitFor(() => expect(client.groups.deleteGroup).toHaveBeenCalledTimes(1))
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
    const app = render(<InteractiveListen dbPath=":memory:" chats={[100]} persist retrySeconds={1} sendTo={100} showMedia={false} autoDownload={false} showChatName={false} createClient={() => client} stopSignal={controller.signal} onRequestStop={() => undefined} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
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
    const app = render(<InteractiveListen dbPath=":memory:"
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
    const app = render(<InteractiveListen dbPath=":memory:"
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
    const app = render(<InteractiveListen dbPath=":memory:"
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
  it('shows the message id in the interactive header', () => {
    expect(formatInteractiveListenHeader({
      time: '18:03', msgId: 456, sender: 'Alice', senderId: 123,
    })).toBe('[18:03] #456 Alice (123)')
  })

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
    expect(close).toHaveBeenCalledOnce()
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
      mediaSummary: null,
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
  it('renders reply context, current content, media summary, then every album download row', () => {
    const row = toListenMessage([
      storedPhoto(11, ''),
      storedPhoto(12, 'album caption'),
    ], {
      showMedia: true,
      previewWidth: 24,
      colorDepth: 1,
      replyContext: { messageId: 7, resolved: true, timestamp: '2026-07-10T07:20:00.000Z', senderId: 2, senderName: 'Bob', content: 'earlier' },
    })

    const output = renderToString(<ListenMessageBody message={row} />)
    expect(output).toContain('📎 2 Photos')
    expect(output.match(/Download/g)).toHaveLength(2)
    expect(output.indexOf('Bob (#7): earlier')).toBeLessThan(output.indexOf('album caption'))
    expect(output.indexOf('album caption')).toBeLessThan(output.indexOf('📎 2 Photos'))
    expect(output.indexOf('📎 2 Photos')).toBeLessThan(output.indexOf('Download'))
  })

  it('renders a missing reply and hides all media when showMedia is false', () => {
    const row = toListenMessage([storedPhoto(11, 'current')], {
      showMedia: false,
      previewWidth: 24,
      colorDepth: 1,
      replyContext: { messageId: 99, resolved: false },
    })

    const output = renderToString(<ListenMessageBody message={row} />)
    expect(output).toContain('↳ Reply to message #99 (not found locally)')
    expect(output).toContain('current')
    expect(output).not.toContain('📎')
    expect(output).not.toContain('Download')
  })

  it('queues groups off the callback stack, preserves order, and closes after draining', async () => {
    const scheduled: Array<() => void> = []
    const calls: string[] = []
    const resolver = {
      resolve: vi.fn((messages: StoredMessageInput[]) => {
        calls.push(`resolve:${messages[0]!.msg_id}`)
        return undefined
      }),
      remember: vi.fn((messages: StoredMessageInput[]) => calls.push(`remember:${messages[0]!.msg_id}`)),
      close: vi.fn(() => calls.push('close')),
    }
    const committed: number[] = []
    const queue = createInteractiveListenGroupQueue({
      resolver,
      schedule: (run) => scheduled.push(run),
      isActive: () => true,
      onGroup: (group) => committed.push(group.messages[0]!.msg_id),
      onError: vi.fn(),
    })

    queue.enqueue([storedPhoto(11, 'first')])
    queue.enqueue([storedPhoto(12, 'second')])
    expect(calls).toEqual([])
    expect(scheduled).toHaveLength(1)
    scheduled.shift()!()
    await queue.close()

    expect(committed).toEqual([11, 12])
    expect(calls).toEqual(['resolve:11', 'remember:11', 'resolve:12', 'remember:12', 'close'])
  })

  it('uses one resolver across reconnect batches and closes it once at final cleanup', async () => {
    const scheduled: Array<() => void> = []
    const resolver = { resolve: vi.fn(() => undefined), remember: vi.fn(), close: vi.fn() }
    const factory = vi.fn(() => resolver)
    const runtime = createInteractiveListenRuntime('/tmp/messages.db', factory, {
      schedule: (run) => scheduled.push(run),
      isActive: () => true,
      onGroup: vi.fn(),
      onError: vi.fn(),
    })

    runtime.enqueue([storedPhoto(11, 'before disconnect')])
    scheduled.shift()!()
    await Promise.resolve()
    runtime.enqueue([storedPhoto(12, 'after reconnect')])
    scheduled.shift()!()
    await runtime.close()

    expect(factory).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledWith('/tmp/messages.db', LISTEN_HISTORY_LIMIT)
    expect(resolver.resolve).toHaveBeenCalledTimes(2)
    expect(resolver.close).toHaveBeenCalledOnce()
  })

  it('does not commit after generation cleanup and reports resolve errors without rejection', async () => {
    const scheduled: Array<() => void> = []
    let active = true
    const error = new Error('snapshot failed')
    const resolver = { resolve: vi.fn(() => { throw error }), remember: vi.fn(), close: vi.fn() }
    const onGroup = vi.fn()
    const onError = vi.fn()
    const queue = createInteractiveListenGroupQueue({
      resolver,
      schedule: (run) => scheduled.push(run),
      isActive: () => active,
      onGroup,
      onError,
    })
    queue.enqueue([storedPhoto(11, 'first')])
    active = false
    scheduled.shift()!()
    await queue.close()

    expect(onGroup).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(error)
    expect(resolver.close).toHaveBeenCalledOnce()
  })

  it('drains remembered work after unmount without committing stale state', async () => {
    const scheduled: Array<() => void> = []
    const resolver = { resolve: vi.fn(() => undefined), remember: vi.fn(), close: vi.fn() }
    const onGroup = vi.fn()
    const queue = createInteractiveListenGroupQueue({
      resolver,
      schedule: (run) => scheduled.push(run),
      isActive: () => false,
      onGroup,
      onError: vi.fn(),
    })

    queue.enqueue([storedPhoto(11, 'pending at unmount')])
    scheduled.shift()!()
    await queue.close()

    expect(resolver.remember).toHaveBeenCalledOnce()
    expect(onGroup).not.toHaveBeenCalled()
    expect(resolver.close).toHaveBeenCalledOnce()
  })

  it('keeps timers responsive while an async database reply is pending', async () => {
    const scheduled: Array<() => void> = []
    let finishResolve!: () => void
    const pending = new Promise<void>((resolve) => { finishResolve = resolve })
    const resolver = {
      resolve: vi.fn(() => undefined),
      resolveAsync: vi.fn(async () => { await pending; return undefined }),
      remember: vi.fn(), close: vi.fn(), closeAsync: vi.fn(async () => undefined),
    }
    const queue = createInteractiveListenGroupQueue({
      resolver, schedule: (run) => scheduled.push(run), isActive: () => true,
      onGroup: vi.fn(), onError: vi.fn(),
    })
    queue.enqueue([storedPhoto(11, 'db miss')])
    scheduled.shift()!()

    const sentinel = vi.fn()
    await new Promise<void>((resolve) => setTimeout(() => { sentinel(); resolve() }, 0))
    expect(sentinel).toHaveBeenCalledOnce()
    expect(resolver.remember).not.toHaveBeenCalled()

    finishResolve()
    await queue.close()
    expect(resolver.remember).toHaveBeenCalledOnce()
    expect(resolver.closeAsync).toHaveBeenCalledOnce()
  })

  it('awaits one shared resolver shutdown promise across repeated close calls', async () => {
    let finishClose!: () => void
    const pendingClose = new Promise<void>((resolve) => { finishClose = resolve })
    const resolver = {
      resolve: vi.fn(() => undefined), remember: vi.fn(), close: vi.fn(),
      closeAsync: vi.fn(() => pendingClose),
    }
    const queue = createInteractiveListenGroupQueue({
      resolver, isActive: () => true, onGroup: vi.fn(), onError: vi.fn(),
    })

    let settled = false
    const first = queue.close()
    const second = queue.close()
    void first.then(() => { settled = true })
    await Promise.resolve()

    expect(second).toBe(first)
    expect(settled).toBe(false)
    expect(resolver.closeAsync).toHaveBeenCalledOnce()
    finishClose()
    await first
    expect(settled).toBe(true)
  })
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

  it('rebuilds a resolved historical group for resize without resolving it again', () => {
    const decodePreview = vi.fn((_base64: string, width: number) => ({
      width,
      rows: Array.from({ length: width }, () => []),
    }))
    const group = [{ ...storedPhoto(11, 'caption'), preview_jpeg_base64: twoByTwoJpeg }]
    const resolved = {
      key: '100:11',
      messages: group,
      replyContext: { messageId: 7, resolved: false as const },
    }
    const cache = new ListenMessageViewCache()

    const before = cache.build([resolved], { showMedia: true, previewWidth: 2, colorDepth: 24, decodePreview })
    const after = cache.build([resolved], { showMedia: true, previewWidth: 4, colorDepth: 24, decodePreview })

    expect(before[0]?.media[0]?.previewRows).toBe(2)
    expect(after[0]?.media[0]?.previewRows).toBe(4)
    expect(after[0]?.replyContext).toEqual(resolved.replyContext)
    expect(decodePreview).toHaveBeenCalledTimes(2)
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
  it('accounts for reply and media summary lines without dropping attachment preview rows', () => {
    const old = message('old', 2)
    const current = message('current', 3)
    current.content = 'body'
    current.replyContext = { messageId: 1, resolved: false }
    current.mediaSummary = '📎 1 Photo'
    current.media[0] = { ...current.media[0]!, previewRows: 2, previewCells: [] }

    expect(takeListenViewport([old, current], 8, 0).map((item) => item.sender)).toEqual(['current'])
    expect(takeListenViewport([old, current], 10, 0).map((item) => item.sender)).toEqual(['old', 'current'])
  })
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
    mediaSummary: null,
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
      transferOwnership: vi.fn(),
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
  } as unknown as import('../../src/telegram/types.js').TelegramClientAdapter & { groups: { getGroup: ReturnType<typeof vi.fn>; listTopics: ReturnType<typeof vi.fn>; banMember: ReturnType<typeof vi.fn>; deleteGroup: ReturnType<typeof vi.fn>; promoteAdmin: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn>; transferOwnership: ReturnType<typeof vi.fn> }; sendMessage: ReturnType<typeof vi.fn> }
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
