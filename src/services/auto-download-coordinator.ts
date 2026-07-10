import { existsSync } from 'node:fs'
import { link, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { StoredMessageInput } from '../storage/message-db.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import { resolveAttachmentDestination } from './attachment-download.js'
import {
  attachmentDownloadTarget,
  attachmentFileName,
  discoverListenAttachments,
  listenAttachmentKey,
  type ListenAttachment,
} from './listen-attachment.js'

export type AutoDownloadEvent =
  | { status: 'queued'; key: string }
  | { status: 'downloading'; key: string; progress: number | null }
  | { status: 'completed'; key: string; path: string }
  | { status: 'failed'; key: string; error: string }
  | { status: 'cancelled'; key: string }

type AutoDownloadCoordinatorOptions = {
  concurrency?: number
  homeDir?: string
  exists?: (path: string) => boolean
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>
  remove?: (path: string, options: { force: true }) => Promise<unknown>
  publish?: (temporary: string, destination: string) => Promise<unknown>
  temporaryPath?: (destination: string, key: string) => string
  onEvent?: (event: AutoDownloadEvent) => void
}

type DownloadTask = {
  key: string
  attachment: ListenAttachment
}

export class AutoDownloadCoordinator {
  private readonly concurrency: number
  private readonly homeDir: string
  private readonly exists: (path: string) => boolean
  private readonly makeDirectory: (path: string, options: { recursive: true }) => Promise<unknown>
  private readonly removeFile: (path: string, options: { force: true }) => Promise<unknown>
  private readonly publishFile: (temporary: string, destination: string) => Promise<unknown>
  private readonly temporaryPath: (destination: string, key: string) => string
  private readonly onEvent: (event: AutoDownloadEvent) => void
  private readonly queue: DownloadTask[] = []
  private readonly seen = new Set<string>()
  private readonly reserved = new Set<string>()
  private readonly activeWaiters = new Set<() => void>()
  private readonly idleWaiters = new Set<() => void>()
  private client: TelegramClientAdapter | null = null
  private active = 0
  private stopped = false

  constructor(options: AutoDownloadCoordinatorOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 3))
    this.homeDir = options.homeDir ?? homedir()
    this.exists = options.exists ?? existsSync
    this.makeDirectory = options.mkdir ?? mkdir
    this.removeFile = options.remove ?? rm
    this.publishFile = options.publish ?? link
    this.temporaryPath = options.temporaryPath ?? ((destination) => `${destination}.telegram-cli-${randomUUID()}.part`)
    this.onEvent = options.onEvent ?? (() => undefined)
  }

  enqueue(message: StoredMessageInput): boolean {
    if (this.stopped) return false
    let added = false
    discoverListenAttachments(message).forEach((attachment, index) => {
      const key = listenAttachmentKey(attachment, index)
      if (!attachment.downloadable || this.seen.has(key)) return
      this.seen.add(key)
      this.queue.push({ key, attachment })
      this.emit({ status: 'queued', key })
      added = true
    })
    this.pump()
    return added
  }

  setClient(client: TelegramClientAdapter | null): void {
    this.client = client
    this.pump()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const task of this.queue.splice(0)) this.emit({ status: 'cancelled', key: task.key })
    this.resolveWaiters()
  }

  waitForActive(): Promise<void> {
    if (this.active === 0) return Promise.resolve()
    return new Promise((resolve) => this.activeWaiters.add(resolve))
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  private pump(): void {
    if (this.stopped || this.client == null) return
    while (this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!
      const client = this.client
      this.active += 1
      void this.run(task, client).catch(() => undefined).finally(() => {
        this.active -= 1
        this.resolveWaiters()
        this.pump()
      })
    }
  }

  private async run(task: DownloadTask, client: TelegramClientAdapter): Promise<void> {
    let destination = resolveAttachmentDestination({
      homeDir: this.homeDir,
      fileName: attachmentFileName(task.attachment),
      exists: this.exists,
      reserved: this.reserved,
    })
    this.reserved.add(destination)
    const temporary = this.temporaryPath(destination, task.key)
    try {
      await this.makeDirectory(dirname(destination), { recursive: true })
      this.emit({ status: 'downloading', key: task.key, progress: 0 })
      await client.downloadMessageMedia({
        ...attachmentDownloadTarget(task.attachment),
        destination: temporary,
        onProgress: (downloaded, total) => {
          const progress = Number.isFinite(total) && total > 0
            ? Math.round(downloaded / total * 100)
            : null
          this.emit({ status: 'downloading', key: task.key, progress })
        },
      })
      destination = await this.publish(temporary, destination, attachmentFileName(task.attachment))
      this.emit({ status: 'completed', key: task.key, path: destination })
    } catch (error) {
      this.emit({ status: 'failed', key: task.key, error: messageFromError(error) })
    } finally {
      this.reserved.delete(destination)
      try {
        await this.removeFile(temporary, { force: true })
      } catch {
        // Cleanup is best-effort and never targets a user-owned final path.
      }
    }
  }

  private async publish(temporary: string, initialDestination: string, fileName: string): Promise<string> {
    let destination = initialDestination
    const collisions = new Set<string>()
    while (true) {
      try {
        await this.publishFile(temporary, destination)
        return destination
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error
        collisions.add(destination)
        this.reserved.delete(destination)
        const nextDestination = resolveAttachmentDestination({
          homeDir: this.homeDir,
          fileName,
          exists: this.exists,
          reserved: new Set([...this.reserved, ...collisions]),
        })
        destination = nextDestination
        this.reserved.add(destination)
      }
    }
  }

  private emit(event: AutoDownloadEvent): void {
    try {
      this.onEvent(event)
    } catch {
      // Observers cannot influence queue control flow.
    }
  }

  private resolveWaiters(): void {
    if (this.active === 0) {
      for (const resolve of this.activeWaiters) resolve()
      this.activeWaiters.clear()
    }
    if (this.active === 0 && this.queue.length === 0) {
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'EEXIST'
}
