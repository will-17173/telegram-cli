import { existsSync } from 'node:fs'
import { link, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { StoredMessageInput } from '../storage/message-db.js'
import type { TelegramClientAdapter } from '../telegram/types.js'
import {
  attachmentDownloadProgress,
  resolveAttachmentDestination,
} from './attachment-download.js'
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
  maxPending?: number
  maxRecent?: number
  homeDir?: string
  exists?: (path: string) => boolean
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>
  remove?: (path: string, options: { force: true }) => Promise<unknown>
  publish?: (temporary: string, destination: string) => Promise<unknown>
  randomUUID?: () => string
  temporaryPath?: (destination: string, key: string) => string
  onEvent?: (event: AutoDownloadEvent) => void
}

type DownloadTask = {
  key: string
  attachment: ListenAttachment
}

export class AutoDownloadCoordinator {
  private readonly concurrency: number
  private readonly maxPending: number
  private readonly maxRecent: number
  private readonly homeDir: string
  private readonly exists: (path: string) => boolean
  private readonly makeDirectory: (path: string, options: { recursive: true }) => Promise<unknown>
  private readonly removeFile: (path: string, options: { force: true }) => Promise<unknown>
  private readonly publishFile: (temporary: string, destination: string) => Promise<unknown>
  private readonly temporaryPath: (destination: string, key: string) => string
  private readonly onEvent: (event: AutoDownloadEvent) => void
  private readonly queue: DownloadTask[] = []
  private readonly inFlight = new Set<string>()
  private readonly recent = new Set<string>()
  private readonly reserved = new Set<string>()
  private readonly reservedTemporary = new Set<string>()
  private readonly activeWaiters = new Set<() => void>()
  private readonly idleWaiters = new Set<() => void>()
  private client: TelegramClientAdapter | null = null
  private active = 0
  private stopped = false

  constructor(options: AutoDownloadCoordinatorOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 3))
    this.maxPending = Math.max(0, Math.floor(options.maxPending ?? 5000))
    this.maxRecent = Math.max(0, Math.floor(options.maxRecent ?? 5000))
    this.homeDir = options.homeDir ?? homedir()
    this.exists = options.exists ?? existsSync
    this.makeDirectory = options.mkdir ?? mkdir
    this.removeFile = options.remove ?? rm
    this.publishFile = options.publish ?? link
    const createUUID = options.randomUUID ?? randomUUID
    this.temporaryPath = options.temporaryPath ?? ((destination) => join(dirname(destination), `.telegram-cli-${createUUID()}.part`))
    this.onEvent = options.onEvent ?? (() => undefined)
  }

  enqueue(message: StoredMessageInput): boolean {
    if (this.stopped) return false
    let added = false
    discoverListenAttachments(message).forEach((attachment, index) => {
      const key = listenAttachmentKey(attachment, index)
      if (!attachment.downloadable || this.inFlight.has(key) || this.recent.has(key)) return
      if (this.queue.length >= this.maxPending) {
        this.remember(key)
        this.emit({ status: 'failed', key, error: 'auto-download queue is full' })
        return
      }
      this.inFlight.add(key)
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
    for (const task of this.queue.splice(0)) {
      this.inFlight.delete(task.key)
      this.remember(task.key)
      this.emit({ status: 'cancelled', key: task.key })
    }
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
        this.inFlight.delete(task.key)
        this.remember(task.key)
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
    const temporary = this.reserveTemporary(destination, task.key)
    try {
      await this.makeDirectory(dirname(destination), { recursive: true })
      this.emit({ status: 'downloading', key: task.key, progress: 0 })
      await client.downloadMessageMedia({
        ...attachmentDownloadTarget(task.attachment),
        destination: temporary,
        onProgress: (downloaded, total) => {
          const progress = attachmentDownloadProgress(downloaded, total)
          this.emit({ status: 'downloading', key: task.key, progress })
        },
      })
      destination = await this.publish(temporary, destination, attachmentFileName(task.attachment))
      this.emit({ status: 'completed', key: task.key, path: destination })
    } catch (error) {
      this.emit({ status: 'failed', key: task.key, error: messageFromError(error) })
    } finally {
      this.reserved.delete(destination)
      this.reservedTemporary.delete(temporary)
      try {
        await this.removeFile(temporary, { force: true })
      } catch {
        // Cleanup is best-effort and never targets a user-owned final path.
      }
    }
  }

  private reserveTemporary(destination: string, key: string): string {
    while (true) {
      const candidate = this.temporaryPath(destination, key)
      if (this.exists(candidate) || this.reservedTemporary.has(candidate)) continue
      this.reservedTemporary.add(candidate)
      return candidate
    }
  }

  private remember(key: string): void {
    if (this.maxRecent === 0) return
    this.recent.delete(key)
    this.recent.add(key)
    while (this.recent.size > this.maxRecent) {
      const oldest = this.recent.values().next().value
      if (oldest != null) this.recent.delete(oldest)
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
