# Node.js tg-cli Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript/pnpm Node.js port of `tg-cli` in the repository root with the same first-release command behavior as the Python reference.

**Architecture:** The CLI parses commands in `src/cli`, delegates to typed command handlers in `src/commands`, and keeps Telegram access behind `src/telegram`. Local cache behavior lives in `src/storage`, business flows live in `src/services`, and output is split between structured machine output and Ink TTY presenters.

**Tech Stack:** TypeScript, pnpm, tsx, commander, @mtcute/node, better-sqlite3, React, Ink, yaml, Vitest.

---

## File Structure

- `package.json`: package metadata, `bin: tg`, scripts, dependencies.
- `tsconfig.json`: strict TypeScript config for Node ESM.
- `vitest.config.ts`: Vitest test config.
- `src/index.ts`: executable entrypoint.
- `src/cli/app.ts`: commander app construction and global options.
- `src/cli/output.ts`: output-mode selection and final rendering dispatch.
- `src/commands/types.ts`: shared command result, app context, and error types.
- `src/commands/query.ts`: `search`, `recent`, `stats`, `top`, `timeline`, `today`, `filter`.
- `src/commands/data.ts`: `export`, `purge`.
- `src/commands/telegram.ts`: `status`, `whoami`, `chats`, `info`, `history`, `sync`, `sync-all`, `refresh`, `listen`, `send`, `edit`, `delete`.
- `src/config/env.ts`: env loading, default data paths, API credentials, output env.
- `src/storage/message-db.ts`: SQLite schema and query API.
- `src/storage/chat-resolver.ts`: numeric, exact, and partial chat resolution.
- `src/services/query-service.ts`: local query workflows and `sync-first` hook.
- `src/services/data-service.ts`: export and purge workflows.
- `src/services/sync-service.ts`: history, sync, refresh, and bulk sync workflows.
- `src/services/message-service.ts`: send, edit, and delete workflows.
- `src/services/listen-service.ts`: listener reconnect loop.
- `src/telegram/types.ts`: project-owned Telegram adapter interface and normalized types.
- `src/telegram/mtcute-client.ts`: mtcute implementation of the adapter.
- `src/telegram/fake-client.ts`: deterministic fake adapter for tests.
- `src/presenters/structured.ts`: JSON/YAML envelope output.
- `src/presenters/ink/render.tsx`: TTY rendering entrypoint.
- `src/presenters/ink/components.tsx`: shared Ink components.
- `tests/fixtures/messages.ts`: message fixture builder.
- `tests/storage/message-db.test.ts`: storage behavior tests.
- `tests/presenters/structured.test.ts`: structured output tests.
- `tests/cli/contract.test.ts`: command and output contract tests.
- `tests/services/sync-service.test.ts`: fake Telegram sync tests.
- `tests/services/message-service.test.ts`: fake send/edit/delete tests.
- `docs/manual-smoke.md`: manual mtcute smoke test commands.

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/cli/app.ts`
- Create: `src/commands/types.ts`
- Create: `tests/cli/help.test.ts`

- [ ] **Step 1: Write the failing CLI help test**

Create `tests/cli/help.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/cli/app.js'

describe('cli help', () => {
  it('registers the tg command surface', () => {
    const app = createApp()
    const names = app.commands.map((command) => command.name()).sort()

    expect(names).toEqual([
      'chats',
      'delete',
      'edit',
      'export',
      'filter',
      'history',
      'info',
      'listen',
      'purge',
      'recent',
      'refresh',
      'search',
      'send',
      'stats',
      'status',
      'sync',
      'sync-all',
      'timeline',
      'today',
      'top',
      'whoami',
    ])
  })
})
```

- [ ] **Step 2: Add package metadata and tooling config**

Create `package.json`:

```json
{
  "name": "kabi-tg-cli-node",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "tg": "./src/index.ts"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mtcute/node": "^0.30.3",
    "better-sqlite3": "^12.10.0",
    "commander": "^14.0.2",
    "dotenv": "^17.2.3",
    "ink": "^6.5.1",
    "react": "^19.2.1",
    "yaml": "^2.8.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24.10.1",
    "@types/react": "^19.2.7",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
})
```

- [ ] **Step 3: Add minimal app and types**

Create `src/commands/types.ts`:

```ts
export type OutputFlags = {
  json?: boolean
  yaml?: boolean
}

export type CommandResult<T = unknown> = {
  ok: true
  data: T
  human?: HumanOutput
}

export type CommandFailure = {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type HandlerResult<T = unknown> = CommandResult<T> | CommandFailure

export type HumanOutput =
  | { kind: 'text'; text: string }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][] }
  | { kind: 'timeline'; rows: Array<{ period: string; count: number }> }

export type AppContext = {
  verbose: boolean
}
```

Create `src/cli/app.ts`:

```ts
import { Command } from 'commander'

const COMMAND_NAMES = [
  'chats',
  'delete',
  'edit',
  'export',
  'filter',
  'history',
  'info',
  'listen',
  'purge',
  'recent',
  'refresh',
  'search',
  'send',
  'stats',
  'status',
  'sync',
  'sync-all',
  'timeline',
  'today',
  'top',
  'whoami',
] as const

export function createApp(): Command {
  const app = new Command()
    .name('tg')
    .description('Telegram CLI for syncing chats, searching messages, and local analysis.')
    .option('-v, --verbose', 'Enable debug logging')
    .version('0.1.0')

  for (const name of COMMAND_NAMES) {
    app.command(name).description(`${name} command`)
  }

  return app
}
```

Create `src/index.ts`:

```ts
#!/usr/bin/env tsx
import { createApp } from './cli/app.js'

await createApp().parseAsync(process.argv)
```

- [ ] **Step 4: Run the scaffold tests**

Run:

```bash
pnpm install
pnpm test tests/cli/help.test.ts
```

Expected: `tests/cli/help.test.ts` passes.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/index.ts src/cli/app.ts src/commands/types.ts tests/cli/help.test.ts
git commit -m "feat: scaffold node tg cli"
```

## Task 2: Config and Structured Output

**Files:**
- Create: `src/config/env.ts`
- Create: `src/presenters/structured.ts`
- Create: `src/cli/output.ts`
- Create: `tests/presenters/structured.test.ts`

- [ ] **Step 1: Write structured output tests**

Create `tests/presenters/structured.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dumpStructured,
  errorPayload,
  resolveOutputFormat,
  successPayload,
} from '../../src/presenters/structured.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('structured output', () => {
  it('wraps success data in schema version 1', () => {
    expect(successPayload({ total: 2 })).toEqual({
      ok: true,
      schema_version: '1',
      data: { total: 2 },
    })
  })

  it('wraps errors in schema version 1', () => {
    expect(errorPayload('chat_not_found', "Chat 'x' not found.")).toEqual({
      ok: false,
      schema_version: '1',
      error: { code: 'chat_not_found', message: "Chat 'x' not found." },
    })
  })

  it('rejects json and yaml together', () => {
    expect(() => resolveOutputFormat({ json: true, yaml: true, isTty: true })).toThrow(
      'Use only one of --json or --yaml.',
    )
  })

  it('uses yaml for non-tty auto output', () => {
    vi.stubEnv('OUTPUT', 'auto')
    expect(resolveOutputFormat({ isTty: false })).toBe('yaml')
  })

  it('honors OUTPUT=rich', () => {
    vi.stubEnv('OUTPUT', 'rich')
    expect(resolveOutputFormat({ isTty: false })).toBe('rich')
  })

  it('serializes yaml without sorting keys', () => {
    const text = dumpStructured(successPayload({ value: '你好' }), 'yaml')
    expect(text).toContain('ok: true')
    expect(text).toContain('schema_version: "1"')
    expect(text).toContain('value: 你好')
  })
})
```

- [ ] **Step 2: Implement config**

Create `src/config/env.ts`:

```ts
import { config as loadDotenv } from 'dotenv'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

loadDotenv({ path: resolve(process.cwd(), '.env'), quiet: true })

const APP_NAME = 'tg-cli'
const DEFAULT_API_ID = 2040
const DEFAULT_API_HASH = 'b18441a1ff607e10a989891a5462e627'

export function getApiId(): number {
  const raw = process.env.TG_API_ID
  return raw && raw.trim() ? Number.parseInt(raw, 10) : DEFAULT_API_ID
}

export function getApiHash(): string {
  const raw = process.env.TG_API_HASH
  return raw && raw.trim() ? raw : DEFAULT_API_HASH
}

export function isDefaultApiId(): boolean {
  return !(process.env.TG_API_ID && process.env.TG_API_ID.trim())
}

export function getSessionName(): string {
  return process.env.TG_SESSION_NAME || 'tg_cli'
}

export function getDataDir(): string {
  const raw = process.env.DATA_DIR
  const dir = raw && raw.trim() ? resolvePath(raw) : join(defaultDataHome(), APP_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDbPath(): string {
  const raw = process.env.DB_PATH
  const path = raw && raw.trim() ? resolvePath(raw) : join(getDataDir(), 'messages.db')
  mkdirSync(resolve(path, '..'), { recursive: true })
  return path
}

export function getSessionPath(): string {
  const dir = join(getDataDir(), 'sessions')
  mkdirSync(dir, { recursive: true })
  return join(dir, getSessionName())
}

function resolvePath(raw: string): string {
  const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

function defaultDataHome(): string {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(homedir(), '.local', 'share')
}
```

- [ ] **Step 3: Implement structured presenter and output dispatch**

Create `src/presenters/structured.ts`:

```ts
import YAML from 'yaml'

export type OutputFormat = 'json' | 'yaml' | 'rich'
const SCHEMA_VERSION = '1'

export type ResolveOutputOptions = {
  json?: boolean
  yaml?: boolean
  isTty?: boolean
}

export function resolveOutputFormat(options: ResolveOutputOptions): OutputFormat {
  if (options.json && options.yaml) {
    throw new Error('Use only one of --json or --yaml.')
  }
  if (options.yaml) return 'yaml'
  if (options.json) return 'json'

  const mode = (process.env.OUTPUT || 'auto').trim().toLowerCase()
  if (mode === 'yaml' || mode === 'json' || mode === 'rich') return mode
  return options.isTty === false ? 'yaml' : 'rich'
}

export function successPayload(data: unknown): Record<string, unknown> {
  return { ok: true, schema_version: SCHEMA_VERSION, data }
}

export function errorPayload(code: string, message: string, details?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message }
  if (details !== undefined) error.details = details
  return { ok: false, schema_version: SCHEMA_VERSION, error }
}

export function dumpStructured(payload: unknown, format: 'json' | 'yaml'): string {
  if (format === 'json') return JSON.stringify(payload, null, 2)
  return YAML.stringify(payload, { sortMapEntries: false })
}
```

Create `src/cli/output.ts`:

```ts
import type { HandlerResult } from '../commands/types.js'
import {
  dumpStructured,
  errorPayload,
  resolveOutputFormat,
  successPayload,
  type ResolveOutputOptions,
} from '../presenters/structured.js'

export async function renderResult(result: HandlerResult, options: ResolveOutputOptions): Promise<void> {
  const format = resolveOutputFormat({ ...options, isTty: options.isTty ?? process.stdout.isTTY })
  if (format === 'json' || format === 'yaml') {
    const payload = result.ok ? successPayload(result.data) : errorPayload(result.error.code, result.error.message, result.error.details)
    process.stdout.write(`${dumpStructured(payload, format)}\n`)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`)
    process.exitCode = 1
    return
  }

  if (result.human?.kind === 'text') {
    process.stdout.write(`${result.human.text}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test tests/presenters/structured.test.ts
pnpm typecheck
```

Expected: tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/presenters/structured.ts src/cli/output.ts tests/presenters/structured.test.ts
git commit -m "feat: add config and structured output"
```

## Task 3: SQLite Storage and Chat Resolution

**Files:**
- Create: `src/storage/message-db.ts`
- Create: `src/storage/chat-resolver.ts`
- Create: `tests/fixtures/messages.ts`
- Create: `tests/storage/message-db.test.ts`

- [ ] **Step 1: Write storage tests**

Create `tests/fixtures/messages.ts`:

```ts
import type { StoredMessageInput } from '../../src/storage/message-db.js'

export function message(overrides: Partial<StoredMessageInput> = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: 'Message about Web3 and TypeScript',
    timestamp: new Date('2026-03-09T10:00:00.000Z').toISOString(),
    raw_json: null,
    ...overrides,
  }
}

export function fixtureMessages(): StoredMessageInput[] {
  return [
    message({ msg_id: 1, sender_name: 'Alice', content: 'Message 1: Web3 remote role', timestamp: '2026-03-09T10:00:00.000Z' }),
    message({ msg_id: 2, sender_name: 'Bob', content: 'Message 2: Python and Rust', timestamp: '2026-03-09T11:00:00.000Z' }),
    message({ msg_id: 3, chat_id: 200, chat_name: 'OtherGroup', sender_name: 'Alice', content: 'Message 3: Golang', timestamp: '2026-03-08T10:00:00.000Z' }),
  ]
}
```

Create `tests/storage/message-db.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureMessages, message } from '../fixtures/messages.js'
import { MessageDB } from '../../src/storage/message-db.js'
import { canonicalChatId } from '../../src/storage/chat-resolver.js'

function db(): MessageDB {
  return new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-')), 'messages.db'))
}

describe('MessageDB', () => {
  it('inserts batches and ignores duplicates', () => {
    const store = db()
    expect(store.insertBatch(fixtureMessages())).toBe(3)
    expect(store.insertBatch(fixtureMessages())).toBe(0)
    expect(store.count()).toBe(3)
    store.close()
  })

  it('searches content by keyword and sender', () => {
    const store = db()
    store.insertBatch(fixtureMessages())
    expect(store.search('Web3', { sender: 'Ali', limit: 10 })).toHaveLength(1)
    expect(store.searchRegex('Python|Golang', { limit: 10 })).toHaveLength(2)
    store.close()
  })

  it('resolves chats by id, exact name, and partial name', () => {
    const store = db()
    store.insertBatch(fixtureMessages())
    expect(store.findChats('100')[0]?.chat_name).toBe('TestGroup')
    expect(store.findChats('testgroup')[0]?.chat_id).toBe(100)
    expect(store.findChats('Other')[0]?.chat_id).toBe(200)
    store.close()
  })

  it('canonicalizes telegram supergroup ids', () => {
    expect(canonicalChatId(-1001234567890)).toBe(1234567890)
    expect(canonicalChatId(100123)).toBe(100123)
  })

  it('computes top senders and timeline rows', () => {
    const store = db()
    store.insertBatch([
      ...fixtureMessages(),
      message({ msg_id: 4, sender_name: 'Alice', content: 'again', timestamp: '2026-03-09T12:00:00.000Z' }),
    ])
    expect(store.topSenders({ limit: 1 })[0]?.sender_name).toBe('Alice')
    expect(store.timeline({ granularity: 'day' })).toEqual([
      { period: '2026-03-08', msg_count: 1 },
      { period: '2026-03-09', msg_count: 3 },
    ])
    store.close()
  })
})
```

- [ ] **Step 2: Implement storage and resolver**

Create `src/storage/chat-resolver.ts`:

```ts
export function canonicalChatId(chatId: number): number {
  if (chatId < 0) {
    const digits = String(Math.abs(chatId))
    if (digits.startsWith('100') && digits.length > 3) return Number.parseInt(digits.slice(3), 10)
    return Math.abs(chatId)
  }
  return chatId
}
```

Create `src/storage/message-db.ts`:

```ts
import Database from 'better-sqlite3'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getDbPath } from '../config/env.js'
import { canonicalChatId } from './chat-resolver.js'

export type StoredMessage = {
  id: number
  platform: string
  chat_id: number
  chat_name: string | null
  msg_id: number
  sender_id: number | null
  sender_name: string | null
  content: string | null
  timestamp: string
  raw_json: string | null
}

export type StoredMessageInput = Omit<StoredMessage, 'id' | 'raw_json'> & {
  raw_json?: unknown
}

export type SearchOptions = {
  chatId?: number
  sender?: string
  hours?: number
  limit?: number
}

export class MessageDB {
  private readonly db: Database.Database

  constructor(path = getDbPath()) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'telegram',
        chat_id INTEGER NOT NULL,
        chat_name TEXT,
        msg_id INTEGER NOT NULL,
        sender_id INTEGER,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE(platform, chat_id, msg_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_name);
    `)
  }

  insertBatch(messages: StoredMessageInput[]): number {
    if (messages.length === 0) return 0
    const before = this.db.totalChanges
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES (@platform, @chat_id, @chat_name, @msg_id, @sender_id, @sender_name, @content, @timestamp, @raw_json)
    `)
    const tx = this.db.transaction((rows: StoredMessageInput[]) => {
      for (const row of rows) {
        stmt.run({ ...row, raw_json: row.raw_json == null ? null : JSON.stringify(row.raw_json) })
      }
    })
    tx(messages)
    return this.db.totalChanges - before
  }

  search(keyword: string, options: SearchOptions = {}): StoredMessage[] {
    const query = this.filteredQuery('content LIKE ?', [`%${keyword}%`], options)
    return this.db.prepare(`${query.sql} ORDER BY timestamp DESC LIMIT ?`).all(...query.params, options.limit ?? 50) as StoredMessage[]
  }

  searchRegex(pattern: string, options: SearchOptions = {}): StoredMessage[] {
    const regex = new RegExp(pattern, 'i')
    const query = this.filteredQuery('content IS NOT NULL', [], { ...options, limit: (options.limit ?? 50) * 10 })
    const rows = this.db.prepare(`${query.sql} ORDER BY timestamp DESC LIMIT ?`).all(...query.params, (options.limit ?? 50) * 10) as StoredMessage[]
    return rows.filter((row) => regex.test(row.content ?? '')).slice(0, options.limit ?? 50)
  }

  getRecent(options: SearchOptions = {}): StoredMessage[] {
    const params: unknown[] = []
    const conditions: string[] = ['1=1']
    this.addFilters(conditions, params, options)
    const limit = options.limit ?? 500
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC LIMIT ?
      ) ORDER BY timestamp ASC
    `).all(...params, limit) as StoredMessage[]
  }

  findChats(chat: string): Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }> {
    const chats = this.getChats()
    const numeric = Number.parseInt(chat, 10)
    if (!Number.isNaN(numeric) && String(numeric) === chat.trim()) {
      const id = canonicalChatId(numeric)
      const matches = chats.filter((row) => row.chat_id === id)
      if (matches.length > 0) return matches
    }
    const exact = chats.filter((row) => row.chat_name?.toLocaleLowerCase() === chat.toLocaleLowerCase())
    if (exact.length > 0) return exact
    return chats.filter((row) => row.chat_name?.toLocaleLowerCase().includes(chat.toLocaleLowerCase()))
  }

  resolveChatId(chat: string): number | null {
    const matches = this.findChats(chat)
    return matches.length === 1 ? matches[0].chat_id : null
  }

  getChats(): Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }> {
    return this.db.prepare(`
      SELECT chat_id, chat_name, COUNT(*) as msg_count, MIN(timestamp) as first_msg, MAX(timestamp) as last_msg
      FROM messages GROUP BY chat_id ORDER BY msg_count DESC
    `).all() as Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }>
  }

  topSenders(options: { chatId?: number; hours?: number; limit?: number } = {}): Array<{ sender_name: string | null; sender_id: number | null; msg_count: number; first_msg: string; last_msg: string }> {
    const params: unknown[] = []
    const conditions = ['(sender_id IS NOT NULL OR sender_name IS NOT NULL)']
    this.addFilters(conditions, params, { chatId: options.chatId, hours: options.hours })
    return this.db.prepare(`
      SELECT MAX(sender_name) as sender_name, sender_id, COUNT(*) as msg_count, MIN(timestamp) as first_msg, MAX(timestamp) as last_msg
      FROM messages WHERE ${conditions.join(' AND ')}
      GROUP BY COALESCE(CAST(sender_id AS TEXT), 'name:' || COALESCE(sender_name, ''))
      ORDER BY msg_count DESC LIMIT ?
    `).all(...params, options.limit ?? 20) as Array<{ sender_name: string | null; sender_id: number | null; msg_count: number; first_msg: string; last_msg: string }>
  }

  timeline(options: { chatId?: number; hours?: number; granularity?: 'day' | 'hour' } = {}): Array<{ period: string; msg_count: number }> {
    const params: unknown[] = []
    const conditions = ['1=1']
    this.addFilters(conditions, params, { chatId: options.chatId, hours: options.hours })
    const expr = options.granularity === 'hour' ? 'substr(timestamp, 1, 13)' : 'substr(timestamp, 1, 10)'
    return this.db.prepare(`
      SELECT ${expr} as period, COUNT(*) as msg_count
      FROM messages WHERE ${conditions.join(' AND ')}
      GROUP BY period ORDER BY period ASC
    `).all(...params) as Array<{ period: string; msg_count: number }>
  }

  getLastMsgId(chatId: number): number | null {
    const row = this.db.prepare('SELECT MAX(msg_id) as value FROM messages WHERE chat_id = ?').get(chatId) as { value: number | null }
    return row.value
  }

  count(chatId?: number): number {
    const row = chatId == null
      ? this.db.prepare('SELECT COUNT(*) as value FROM messages').get() as { value: number }
      : this.db.prepare('SELECT COUNT(*) as value FROM messages WHERE chat_id = ?').get(chatId) as { value: number }
    return row.value
  }

  getLatestTimestamp(chatId?: number): string | null {
    const row = chatId == null
      ? this.db.prepare('SELECT MAX(timestamp) as value FROM messages').get() as { value: string | null }
      : this.db.prepare('SELECT MAX(timestamp) as value FROM messages WHERE chat_id = ?').get(chatId) as { value: string | null }
    return row.value
  }

  deleteChat(chatId: number): number {
    return this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId).changes
  }

  close(): void {
    this.db.close()
  }

  private filteredQuery(firstCondition: string, firstParams: unknown[], options: SearchOptions): { sql: string; params: unknown[] } {
    const conditions = [firstCondition]
    const params = [...firstParams]
    this.addFilters(conditions, params, options)
    return { sql: `SELECT * FROM messages WHERE ${conditions.join(' AND ')}`, params }
  }

  private addFilters(conditions: string[], params: unknown[], options: SearchOptions): void {
    if (options.chatId != null) {
      conditions.push('chat_id = ?')
      params.push(options.chatId)
    }
    if (options.sender) {
      conditions.push('sender_name LIKE ?')
      params.push(`%${options.sender}%`)
    }
    if (options.hours != null) {
      conditions.push('timestamp >= ?')
      params.push(new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString())
    }
  }
}
```

- [ ] **Step 3: Run storage tests**

Run:

```bash
pnpm test tests/storage/message-db.test.ts
pnpm typecheck
```

Expected: storage tests pass and TypeScript reports no errors.

- [ ] **Step 4: Commit**

```bash
git add src/storage/message-db.ts src/storage/chat-resolver.ts tests/fixtures/messages.ts tests/storage/message-db.test.ts
git commit -m "feat: add sqlite message storage"
```

## Task 4: Local Query and Data Commands

**Files:**
- Modify: `src/storage/message-db.ts`
- Create: `src/services/query-service.ts`
- Create: `src/services/data-service.ts`
- Create: `src/commands/query.ts`
- Create: `src/commands/data.ts`
- Modify: `src/cli/app.ts`
- Create: `tests/cli/contract.test.ts`

- [ ] **Step 1: Write CLI contract tests for local commands**

Create `tests/cli/contract.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/cli/app.js'
import { MessageDB } from '../../src/storage/message-db.js'
import { fixtureMessages } from '../fixtures/messages.js'

async function run(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const oldOut = process.stdout.write
  const oldErr = process.stderr.write
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
  process.exitCode = 0
  try {
    await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
  } catch (error) {
    if (typeof error === 'object' && error && 'exitCode' in error) process.exitCode = Number((error as { exitCode: number }).exitCode)
    else throw error
  } finally {
    process.stdout.write = oldOut
    process.stderr.write = oldErr
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), code: Number(process.exitCode ?? 0) }
}

function seed(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'tg-cli-contract-')), 'messages.db')
  const db = new MessageDB(dbPath)
  db.insertBatch(fixtureMessages())
  db.close()
  vi.stubEnv('DB_PATH', dbPath)
  return dbPath
}

afterEach(() => {
  vi.unstubAllEnvs()
  process.exitCode = 0
})

describe('local command contracts', () => {
  it('prints stats as yaml', async () => {
    seed()
    const result = await run(['stats', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ok: true')
    expect(result.stdout).toContain('total: 3')
  })

  it('returns structured chat_not_found', async () => {
    seed()
    const result = await run(['search', 'Web3', '--chat', 'MissingGroup', '--yaml'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('ok: false')
    expect(result.stdout).toContain('code: chat_not_found')
  })

  it('searches by keyword', async () => {
    seed()
    const result = await run(['search', 'Web3', '--yaml'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Message 1: Web3 remote role')
  })
})
```

- [ ] **Step 2: Add today support to storage**

Modify `src/storage/message-db.ts` by adding this method inside `MessageDB`:

```ts
  getToday(options: { chatId?: number; tzOffsetHours?: number; limit?: number } = {}): StoredMessage[] {
    const now = new Date()
    const local = options.tzOffsetHours == null
      ? new Date(now)
      : new Date(now.getTime() + options.tzOffsetHours * 60 * 60 * 1000)
    const startLocal = new Date(local)
    startLocal.setHours(0, 0, 0, 0)
    const cutoff = options.tzOffsetHours == null
      ? startLocal.toISOString()
      : new Date(startLocal.getTime() - options.tzOffsetHours * 60 * 60 * 1000).toISOString()
    const params: unknown[] = [cutoff]
    const conditions = ['timestamp >= ?']
    if (options.chatId != null) {
      conditions.push('chat_id = ?')
      params.push(options.chatId)
    }
    return this.db.prepare(`
      SELECT * FROM messages WHERE ${conditions.join(' AND ')}
      ORDER BY chat_name, timestamp ASC LIMIT ?
    `).all(...params, options.limit ?? 5000) as StoredMessage[]
  }
```

- [ ] **Step 3: Implement query and data services**

Create `src/services/query-service.ts`:

```ts
import { MessageDB } from '../storage/message-db.js'
import type { HandlerResult } from '../commands/types.js'

export class QueryService {
  constructor(private readonly db = new MessageDB()) {}

  search(options: { keyword: string; chat?: string; sender?: string; hours?: number; regex?: boolean; limit?: number }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    const data = options.regex
      ? this.db.searchRegex(options.keyword, { chatId: chatId.data, sender: options.sender, hours: options.hours, limit: options.limit })
      : this.db.search(options.keyword, { chatId: chatId.data, sender: options.sender, hours: options.hours, limit: options.limit })
    return { ok: true, data, human: { kind: 'text', text: data.length ? `Found ${data.length} messages` : 'No messages found.' } }
  }

  recent(options: { chat?: string; sender?: string; hours?: number; limit?: number }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    const data = this.db.getRecent({ chatId: chatId.data, sender: options.sender, hours: options.hours ?? 24, limit: options.limit ?? 50 })
    return { ok: true, data, human: { kind: 'text', text: data.length ? `Showing ${data.length} recent messages` : 'No recent messages found.' } }
  }

  stats(): HandlerResult {
    return { ok: true, data: { total: this.db.count(), chats: this.db.getChats() } }
  }

  top(options: { chat?: string; hours?: number; limit?: number }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    return { ok: true, data: this.db.topSenders({ chatId: chatId.data, hours: options.hours, limit: options.limit }) }
  }

  timeline(options: { chat?: string; hours?: number; granularity?: 'day' | 'hour' }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    return { ok: true, data: this.db.timeline({ chatId: chatId.data, hours: options.hours, granularity: options.granularity ?? 'day' }) }
  }

  today(options: { chat?: string }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    return { ok: true, data: this.db.getToday({ chatId: chatId.data }) }
  }

  filter(options: { keywords: string; chat?: string; hours?: number }): HandlerResult {
    const words = options.keywords.split(',').map((word) => word.trim()).filter(Boolean)
    if (words.length === 0) return { ok: false, error: { code: 'invalid_keywords', message: 'Please provide at least one keyword.' } }
    const source = options.hours == null ? this.today({ chat: options.chat }) : this.recent({ chat: options.chat, hours: options.hours, limit: 100000 })
    if (!source.ok) return source
    const regex = new RegExp(words.map((word) => escapeRegex(word)).join('|'), 'i')
    return { ok: true, data: (source.data as Array<{ content?: string | null }>).filter((row) => row.content && regex.test(row.content)) }
  }

  private resolveChat(chat?: string): HandlerResult<number | undefined> {
    if (!chat) return { ok: true, data: undefined }
    const matches = this.db.findChats(chat)
    if (matches.length === 1) return { ok: true, data: matches[0].chat_id }
    if (matches.length === 0) return { ok: false, error: { code: 'chat_not_found', message: `Chat '${chat}' not found in database.` } }
    return { ok: false, error: { code: 'ambiguous_chat', message: `Chat '${chat}' is ambiguous. Matches: ${matches.map((m) => m.chat_name ?? m.chat_id).join(', ')}` } }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
```

Create `src/services/data-service.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { MessageDB } from '../storage/message-db.js'
import { dumpStructured, successPayload } from '../presenters/structured.js'
import type { HandlerResult } from '../commands/types.js'

export class DataService {
  constructor(private readonly db = new MessageDB()) {}

  exportMessages(options: { chat: string; format: 'text' | 'json' | 'yaml'; output?: string; hours?: number }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    const messages = this.db.getRecent({ chatId: chatId.data, hours: options.hours, limit: 100000 })
    if (messages.length === 0) return { ok: false, error: { code: 'no_messages', message: `No messages found for '${options.chat}'.` } }
    const text = options.format === 'json'
      ? dumpStructured(successPayload(messages), 'json')
      : options.format === 'yaml'
        ? dumpStructured(successPayload(messages), 'yaml')
        : messages.map((msg) => `[${msg.timestamp.slice(0, 19)}] ${msg.sender_name ?? 'Unknown'}: ${msg.content ?? ''}`).join('\n')
    if (options.output) {
      writeFileSync(options.output, text, 'utf8')
      return { ok: true, data: { exported: messages.length, output: options.output } }
    }
    return { ok: true, data: text, human: { kind: 'text', text } }
  }

  purge(options: { chat: string; yes: boolean }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    if (!options.yes) return { ok: false, error: { code: 'confirmation_required', message: 'Use --yes to confirm purge in this Node port.' } }
    return { ok: true, data: { deleted: this.db.deleteChat(chatId.data) } }
  }

  private resolveChat(chat: string): HandlerResult<number> {
    const matches = this.db.findChats(chat)
    if (matches.length === 1) return { ok: true, data: matches[0].chat_id }
    if (matches.length === 0) return { ok: false, error: { code: 'chat_not_found', message: `Chat '${chat}' not found in database.` } }
    return { ok: false, error: { code: 'ambiguous_chat', message: `Chat '${chat}' is ambiguous. Matches: ${matches.map((m) => m.chat_name ?? m.chat_id).join(', ')}` } }
  }
}
```

- [ ] **Step 4: Wire query and data commands into commander**

Create `src/commands/query.ts`:

```ts
import type { Command } from 'commander'
import { renderResult } from '../cli/output.js'
import { QueryService } from '../services/query-service.js'

export function registerQueryCommands(app: Command): void {
  app.command('search').argument('<keyword>').option('-c, --chat <chat>').option('-s, --sender <sender>').option('--hours <hours>').option('--regex').option('-n, --limit <limit>', 'Max results', '50').option('--json').option('--yaml').action(async (keyword, options) => {
    await renderResult(new QueryService().search({ keyword, chat: options.chat, sender: options.sender, hours: numberOption(options.hours), regex: Boolean(options.regex), limit: numberOption(options.limit) }), options)
  })
  app.command('recent').option('-c, --chat <chat>').option('-s, --sender <sender>').option('--hours <hours>', 'Only show last N hours', '24').option('-n, --limit <limit>', 'Max messages', '50').option('--json').option('--yaml').action(async (options) => {
    await renderResult(new QueryService().recent({ chat: options.chat, sender: options.sender, hours: numberOption(options.hours), limit: numberOption(options.limit) }), options)
  })
  app.command('stats').option('--json').option('--yaml').action(async (options) => renderResult(new QueryService().stats(), options))
  app.command('top').option('-c, --chat <chat>').option('--hours <hours>').option('-n, --limit <limit>', 'Top N senders', '20').option('--json').option('--yaml').action(async (options) => {
    await renderResult(new QueryService().top({ chat: options.chat, hours: numberOption(options.hours), limit: numberOption(options.limit) }), options)
  })
  app.command('timeline').option('-c, --chat <chat>').option('--hours <hours>').option('--by <granularity>', 'day or hour', 'day').option('--json').option('--yaml').action(async (options) => {
    await renderResult(new QueryService().timeline({ chat: options.chat, hours: numberOption(options.hours), granularity: options.by }), options)
  })
  app.command('today').option('-c, --chat <chat>').option('--json').option('--yaml').action(async (options) => renderResult(new QueryService().today({ chat: options.chat }), options))
  app.command('filter').argument('<keywords>').option('-c, --chat <chat>').option('--hours <hours>').option('--json').option('--yaml').action(async (keywords, options) => {
    await renderResult(new QueryService().filter({ keywords, chat: options.chat, hours: numberOption(options.hours) }), options)
  })
}

function numberOption(value: string | undefined): number | undefined {
  return value == null ? undefined : Number.parseInt(value, 10)
}
```

Create `src/commands/data.ts`:

```ts
import type { Command } from 'commander'
import { renderResult } from '../cli/output.js'
import { DataService } from '../services/data-service.js'

export function registerDataCommands(app: Command): void {
  app.command('export').argument('<chat>').option('-f, --format <format>', 'text, json, or yaml', 'text').option('-o, --output <output>').option('--hours <hours>').action(async (chat, options) => {
    await renderResult(new DataService().exportMessages({ chat, format: options.format, output: options.output, hours: numberOption(options.hours) }), { isTty: process.stdout.isTTY })
  })
  app.command('purge').argument('<chat>').option('-y, --yes').action(async (chat, options) => {
    await renderResult(new DataService().purge({ chat, yes: Boolean(options.yes) }), { isTty: process.stdout.isTTY })
  })
}

function numberOption(value: string | undefined): number | undefined {
  return value == null ? undefined : Number.parseInt(value, 10)
}
```

Modify `src/cli/app.ts` to use real command registration:

```ts
import { Command } from 'commander'
import { registerDataCommands } from '../commands/data.js'
import { registerQueryCommands } from '../commands/query.js'

export function createApp(): Command {
  const app = new Command()
    .name('tg')
    .description('Telegram CLI for syncing chats, searching messages, and local analysis.')
    .option('-v, --verbose', 'Enable debug logging')
    .version('0.1.0')

  registerQueryCommands(app)
  registerDataCommands(app)
  registerReservedTelegramCommands(app)
  return app
}

function registerReservedTelegramCommands(app: Command): void {
  for (const name of ['chats', 'delete', 'edit', 'history', 'info', 'listen', 'refresh', 'send', 'status', 'sync', 'sync-all', 'whoami']) {
    app.command(name).description(`${name} command`)
  }
}
```

- [ ] **Step 5: Run local command tests**

Run:

```bash
pnpm test tests/storage/message-db.test.ts tests/cli/contract.test.ts
pnpm typecheck
```

Expected: storage and CLI contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/storage/message-db.ts src/services/query-service.ts src/services/data-service.ts src/commands/query.ts src/commands/data.ts src/cli/app.ts tests/cli/contract.test.ts
git commit -m "feat: add local query and data commands"
```

## Task 5: Telegram Adapter Interface and Fake Client

**Files:**
- Create: `src/telegram/types.ts`
- Create: `src/telegram/fake-client.ts`
- Create: `src/services/sync-service.ts`
- Create: `tests/services/sync-service.test.ts`

- [ ] **Step 1: Write sync service tests using a fake adapter**

Create `tests/services/sync-service.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MessageDB } from '../../src/storage/message-db.js'
import { SyncService } from '../../src/services/sync-service.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'

function service(): { sync: SyncService; db: MessageDB; fake: FakeTelegramClient } {
  const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
  const fake = new FakeTelegramClient()
  return { sync: new SyncService(fake, db), db, fake }
}

describe('SyncService', () => {
  it('fetches chat history into sqlite', async () => {
    const { sync, db } = service()
    const result = await sync.history({ chat: 'TestGroup', limit: 100 })
    expect(result).toEqual({ ok: true, data: { stored: 2, chat: 'TestGroup' } })
    expect(db.count()).toBe(2)
  })

  it('syncs all dialogs and continues on available chats', async () => {
    const { sync } = service()
    const result = await sync.refresh({ limit: 5000, delay: 0 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.new_messages).toBe(2)
  })
})
```

- [ ] **Step 2: Add adapter types and fake client**

Create `src/telegram/types.ts`:

```ts
import type { StoredMessageInput } from '../storage/message-db.js'

export type TelegramChatType = 'user' | 'group' | 'supergroup' | 'channel' | 'unknown'

export type TelegramChat = {
  id: number
  name: string
  type: TelegramChatType
  unread: number
}

export type TelegramUser = {
  id: number
  name: string
  username: string
  first_name: string
  last_name: string
  phone: string
}

export type FetchHistoryOptions = {
  chat: string | number
  limit: number
  minId?: number
  onProgress?: (count: number) => void
}

export interface TelegramClientAdapter {
  getCurrentUser(): Promise<TelegramUser>
  listChats(type?: TelegramChatType): Promise<TelegramChat[]>
  getChatInfo(chat: string | number): Promise<Record<string, string> | null>
  fetchHistory(options: FetchHistoryOptions): Promise<StoredMessageInput[]>
  sendMessage(options: { chat: string | number; message: string; reply?: number; linkPreview: boolean }): Promise<{ msg_id: number }>
  editMessage(options: { chat: string | number; msgId: number; text: string; linkPreview: boolean }): Promise<void>
  deleteMessages(options: { chat: string | number; msgIds: number[] }): Promise<void>
  listen(options: { chats?: Array<string | number>; onMessage: (message: StoredMessageInput) => void; signal: AbortSignal }): Promise<'stopped' | 'disconnected'>
}
```

Create `src/telegram/fake-client.ts`:

```ts
import type { StoredMessageInput } from '../storage/message-db.js'
import type { FetchHistoryOptions, TelegramChat, TelegramChatType, TelegramClientAdapter, TelegramUser } from './types.js'

export class FakeTelegramClient implements TelegramClientAdapter {
  private readonly chats: TelegramChat[] = [
    { id: 100, name: 'TestGroup', type: 'supergroup', unread: 0 },
  ]

  async getCurrentUser(): Promise<TelegramUser> {
    return { id: 1, name: 'Test User', username: 'test', first_name: 'Test', last_name: 'User', phone: '10086' }
  }

  async listChats(type?: TelegramChatType): Promise<TelegramChat[]> {
    return type ? this.chats.filter((chat) => chat.type === type) : this.chats
  }

  async getChatInfo(chat: string | number): Promise<Record<string, string> | null> {
    const found = this.chats.find((item) => item.id === chat || item.name === chat)
    return found ? { Title: found.name, ID: String(found.id), Type: found.type } : null
  }

  async fetchHistory(options: FetchHistoryOptions): Promise<StoredMessageInput[]> {
    const rows: StoredMessageInput[] = [
      row(1, 'Fake message 1'),
      row(2, 'Fake message 2'),
    ].filter((message) => message.msg_id > (options.minId ?? 0)).slice(0, options.limit)
    options.onProgress?.(rows.length)
    return rows
  }

  async sendMessage(): Promise<{ msg_id: number }> {
    return { msg_id: 99 }
  }

  async editMessage(): Promise<void> {}

  async deleteMessages(): Promise<void> {}

  async listen(options: { onMessage: (message: StoredMessageInput) => void; signal: AbortSignal }): Promise<'stopped'> {
    if (!options.signal.aborted) options.onMessage(row(3, 'Live fake message'))
    return 'stopped'
  }
}

function row(msgId: number, content: string): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content,
    timestamp: new Date(`2026-03-09T10:0${msgId}:00.000Z`).toISOString(),
    raw_json: null,
  }
}
```

- [ ] **Step 3: Implement sync service**

Create `src/services/sync-service.ts`:

```ts
import { setTimeout as delayMs } from 'node:timers/promises'
import type { HandlerResult } from '../commands/types.js'
import { MessageDB } from '../storage/message-db.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

const FIRST_SYNC_LIMIT = 500

export class SyncService {
  constructor(private readonly tg: TelegramClientAdapter, private readonly db = new MessageDB()) {}

  async history(options: { chat: string; limit: number }): Promise<HandlerResult> {
    const messages = await this.tg.fetchHistory({ chat: parseChat(options.chat), limit: options.limit })
    const stored = this.db.insertBatch(messages)
    return { ok: true, data: { stored, chat: options.chat } }
  }

  async sync(options: { chat: string; limit: number }): Promise<HandlerResult> {
    const chatId = this.db.resolveChatId(options.chat)
    const minId = chatId == null ? 0 : this.db.getLastMsgId(chatId) ?? 0
    const messages = await this.tg.fetchHistory({ chat: parseChat(options.chat), limit: options.limit, minId })
    const stored = this.db.insertBatch(messages)
    return { ok: true, data: { synced: stored, chat: options.chat } }
  }

  async refresh(options: { limit: number; delay: number; maxChats?: number }): Promise<HandlerResult<{ new_messages: number; chats: number; updated_chats: string[]; results: Record<string, number> }>> {
    const dialogs = await this.tg.listChats()
    const selected = options.maxChats == null ? dialogs : dialogs.slice(0, options.maxChats)
    const results: Record<string, number> = {}
    for (let index = 0; index < selected.length; index += 1) {
      const dialog = selected[index]
      const lastId = this.db.getLastMsgId(dialog.id) ?? 0
      const limit = lastId === 0 && options.limit > FIRST_SYNC_LIMIT ? FIRST_SYNC_LIMIT : options.limit
      try {
        const messages = await this.tg.fetchHistory({ chat: dialog.id, limit, minId: lastId })
        results[dialog.name] = this.db.insertBatch(messages)
      } catch {
        results[dialog.name] = 0
      }
      if (options.delay > 0 && index < selected.length - 1) {
        const jitter = options.delay * (Math.random() * 0.4 - 0.2)
        await delayMs((options.delay + jitter) * 1000)
      }
    }
    const updated_chats = Object.entries(results).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).map(([name]) => name)
    return { ok: true, data: { new_messages: Object.values(results).reduce((sum, count) => sum + count, 0), chats: selected.length, updated_chats, results } }
  }
}

function parseChat(chat: string): string | number {
  const parsed = Number.parseInt(chat, 10)
  return !Number.isNaN(parsed) && String(parsed) === chat.trim() ? parsed : chat
}
```

- [ ] **Step 4: Run sync service tests**

Run:

```bash
pnpm test tests/services/sync-service.test.ts
pnpm typecheck
```

Expected: sync service tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/types.ts src/telegram/fake-client.ts src/services/sync-service.ts tests/services/sync-service.test.ts
git commit -m "feat: add telegram adapter interface"
```

## Task 6: Message Operations and Telegram Commands

**Files:**
- Create: `src/services/message-service.ts`
- Create: `src/commands/telegram.ts`
- Modify: `src/cli/app.ts`
- Create: `tests/services/message-service.test.ts`

- [ ] **Step 1: Write message service tests**

Create `tests/services/message-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MessageService } from '../../src/services/message-service.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'

describe('MessageService', () => {
  it('maps send result', async () => {
    const result = await new MessageService(new FakeTelegramClient()).send({ chat: 'TestGroup', message: 'hello', linkPreview: false })
    expect(result).toEqual({ ok: true, data: { sent: true, msg_id: 99, chat: 'TestGroup' } })
  })

  it('maps edit result', async () => {
    const result = await new MessageService(new FakeTelegramClient()).edit({ chat: 'TestGroup', msgId: 1, text: 'new text', linkPreview: true })
    expect(result).toEqual({ ok: true, data: { edited: true, msg_id: 1, chat: 'TestGroup' } })
  })

  it('maps delete result', async () => {
    const result = await new MessageService(new FakeTelegramClient()).delete({ chat: 'TestGroup', msgIds: [1, 2] })
    expect(result).toEqual({ ok: true, data: { deleted: true, msg_ids: [1, 2], chat: 'TestGroup' } })
  })
})
```

- [ ] **Step 2: Implement message service**

Create `src/services/message-service.ts`:

```ts
import type { HandlerResult } from '../commands/types.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

export class MessageService {
  constructor(private readonly tg: TelegramClientAdapter) {}

  async send(options: { chat: string; message: string; reply?: number; linkPreview: boolean }): Promise<HandlerResult> {
    const sent = await this.tg.sendMessage({ chat: parseChat(options.chat), message: options.message, reply: options.reply, linkPreview: options.linkPreview })
    return { ok: true, data: { sent: true, msg_id: sent.msg_id, chat: options.chat, ...(options.reply == null ? {} : { reply_to: options.reply }) } }
  }

  async edit(options: { chat: string; msgId: number; text: string; linkPreview: boolean }): Promise<HandlerResult> {
    await this.tg.editMessage({ chat: parseChat(options.chat), msgId: options.msgId, text: options.text, linkPreview: options.linkPreview })
    return { ok: true, data: { edited: true, msg_id: options.msgId, chat: options.chat } }
  }

  async delete(options: { chat: string; msgIds: number[] }): Promise<HandlerResult> {
    await this.tg.deleteMessages({ chat: parseChat(options.chat), msgIds: options.msgIds })
    return { ok: true, data: { deleted: true, msg_ids: options.msgIds, chat: options.chat } }
  }
}

function parseChat(chat: string): string | number {
  const parsed = Number.parseInt(chat, 10)
  return !Number.isNaN(parsed) && String(parsed) === chat.trim() ? parsed : chat
}
```

- [ ] **Step 3: Register Telegram commands using fake adapter factory temporarily**

Create `src/commands/telegram.ts`:

```ts
import type { Command } from 'commander'
import { renderResult } from '../cli/output.js'
import { MessageService } from '../services/message-service.js'
import { SyncService } from '../services/sync-service.js'
import { FakeTelegramClient } from '../telegram/fake-client.js'

export function registerTelegramCommands(app: Command): void {
  app.command('status').option('--json').option('--yaml').action(async (options) => {
    const user = await new FakeTelegramClient().getCurrentUser()
    await renderResult({ ok: true, data: { authenticated: true, user } }, options)
  })
  app.command('whoami').option('--json').option('--yaml').action(async (options) => {
    const user = await new FakeTelegramClient().getCurrentUser()
    await renderResult({ ok: true, data: { user } }, options)
  })
  app.command('chats').option('--type <type>').option('--json').option('--yaml').action(async (options) => {
    const chats = await new FakeTelegramClient().listChats(options.type)
    await renderResult({ ok: true, data: chats }, options)
  })
  app.command('history').argument('<chat>').option('-n, --limit <limit>', 'Max messages to fetch', '1000').option('--json').option('--yaml').action(async (chat, options) => {
    await renderResult(await new SyncService(new FakeTelegramClient()).history({ chat, limit: numberOption(options.limit) ?? 1000 }), options)
  })
  app.command('sync').argument('<chat>').option('-n, --limit <limit>', 'Max messages per sync', '5000').option('--json').option('--yaml').action(async (chat, options) => {
    await renderResult(await new SyncService(new FakeTelegramClient()).sync({ chat, limit: numberOption(options.limit) ?? 5000 }), options)
  })
  app.command('sync-all').option('-n, --limit <limit>', 'Max messages per chat', '5000').option('--delay <delay>', 'Seconds between chat syncs', '1').option('--max-chats <maxChats>').option('--json').option('--yaml').action(async (options) => {
    await renderResult(await new SyncService(new FakeTelegramClient()).refresh({ limit: numberOption(options.limit) ?? 5000, delay: Number.parseFloat(options.delay), maxChats: numberOption(options.maxChats) }), options)
  })
  app.command('refresh').option('-n, --limit <limit>', 'Max messages per chat', '5000').option('--delay <delay>', 'Seconds between chat syncs', '1').option('--max-chats <maxChats>').option('--json').option('--yaml').action(async (options) => {
    await renderResult(await new SyncService(new FakeTelegramClient()).refresh({ limit: numberOption(options.limit) ?? 5000, delay: Number.parseFloat(options.delay), maxChats: numberOption(options.maxChats) }), options)
  })
  app.command('info').argument('<chat>').option('--json').option('--yaml').action(async (chat, options) => {
    const info = await new FakeTelegramClient().getChatInfo(chat)
    await renderResult(info ? { ok: true, data: info } : { ok: false, error: { code: 'chat_not_found', message: `Could not find chat: ${chat}` } }, options)
  })
  app.command('listen').argument('[chats...]').option('--persist').option('--retry-seconds <seconds>', 'Reconnect delay', '5').action(() => process.stdout.write('Listening is available after mtcute adapter registration.\n'))
  app.command('send').argument('<chat>').argument('<message>').option('-r, --reply <reply>').option('--no-preview').option('--json').option('--yaml').action(async (chat, message, options) => {
    await renderResult(await new MessageService(new FakeTelegramClient()).send({ chat, message, reply: numberOption(options.reply), linkPreview: !options.noPreview }), options)
  })
  app.command('edit').argument('<chat>').argument('<msgId>').argument('<newText>').option('--no-preview').option('--json').option('--yaml').action(async (chat, msgId, newText, options) => {
    await renderResult(await new MessageService(new FakeTelegramClient()).edit({ chat, msgId: Number.parseInt(msgId, 10), text: newText, linkPreview: !options.noPreview }), options)
  })
  app.command('delete').argument('<chat>').argument('<msgIds...>').option('--json').option('--yaml').action(async (chat, msgIds, options) => {
    await renderResult(await new MessageService(new FakeTelegramClient()).delete({ chat, msgIds: msgIds.map((id: string) => Number.parseInt(id, 10)) }), options)
  })
}

function numberOption(value: string | undefined): number | undefined {
  return value == null ? undefined : Number.parseInt(value, 10)
}
```

Modify `src/cli/app.ts`:

```ts
import { Command } from 'commander'
import { registerDataCommands } from '../commands/data.js'
import { registerQueryCommands } from '../commands/query.js'
import { registerTelegramCommands } from '../commands/telegram.js'

export function createApp(): Command {
  const app = new Command()
    .name('tg')
    .description('Telegram CLI for syncing chats, searching messages, and local analysis.')
    .option('-v, --verbose', 'Enable debug logging')
    .version('0.1.0')

  registerQueryCommands(app)
  registerDataCommands(app)
  registerTelegramCommands(app)
  return app
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test tests/services/message-service.test.ts tests/services/sync-service.test.ts tests/cli/help.test.ts
pnpm typecheck
```

Expected: service and help tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/message-service.ts src/commands/telegram.ts src/cli/app.ts tests/services/message-service.test.ts
git commit -m "feat: add telegram command handlers"
```

## Task 7: mtcute Adapter

**Files:**
- Create: `src/telegram/mtcute-client.ts`
- Create: `src/telegram/client-factory.ts`
- Modify: `src/commands/telegram.ts`
- Create: `docs/manual-smoke.md`

- [ ] **Step 1: Add the client factory**

Create `src/telegram/client-factory.ts`:

```ts
import { MtcuteTelegramClient } from './mtcute-client.js'
import type { TelegramClientAdapter } from './types.js'

export function createTelegramClient(): TelegramClientAdapter {
  return new MtcuteTelegramClient()
}
```

- [ ] **Step 2: Implement mtcute adapter**

Create `src/telegram/mtcute-client.ts`:

```ts
import { TelegramClient } from '@mtcute/node'
import { getApiHash, getApiId, getSessionPath, isDefaultApiId } from '../config/env.js'
import type { StoredMessageInput } from '../storage/message-db.js'
import type { FetchHistoryOptions, TelegramChat, TelegramChatType, TelegramClientAdapter, TelegramUser } from './types.js'

export class MtcuteTelegramClient implements TelegramClientAdapter {
  private client: TelegramClient | null = null
  private warned = false

  async getCurrentUser(): Promise<TelegramUser> {
    const tg = await this.started()
    const self = await tg.getMe()
    return {
      id: Number(self.id),
      name: self.displayName ?? [self.firstName, self.lastName].filter(Boolean).join(' '),
      username: self.username ?? '',
      first_name: self.firstName ?? '',
      last_name: self.lastName ?? '',
      phone: self.phone ?? '',
    }
  }

  async listChats(type?: TelegramChatType): Promise<TelegramChat[]> {
    const tg = await this.started()
    const dialogs = await tg.getDialogs()
    const chats = dialogs.map((dialog) => {
      const peer = dialog.chat
      const item: TelegramChat = {
        id: Number(peer.id),
        name: peer.displayName ?? String(peer.id),
        type: normalizeChatType(peer),
        unread: dialog.unreadCount ?? 0,
      }
      return item
    })
    return type ? chats.filter((chat) => chat.type === type) : chats
  }

  async getChatInfo(chat: string | number): Promise<Record<string, string> | null> {
    const tg = await this.started()
    try {
      const peer = await tg.resolvePeer(chat)
      return {
        Title: peer.displayName ?? String(peer.id),
        ID: String(peer.id),
        Type: normalizeChatType(peer),
      }
    } catch {
      return null
    }
  }

  async fetchHistory(options: FetchHistoryOptions): Promise<StoredMessageInput[]> {
    const tg = await this.started()
    const peer = await tg.resolvePeer(options.chat)
    const rows: StoredMessageInput[] = []
    for await (const msg of tg.iterMessages(peer, { limit: options.limit, offsetId: options.minId ?? 0 })) {
      const text = msg.text
      if (!text) continue
      rows.push({
        platform: 'telegram',
        chat_id: Number(peer.id),
        chat_name: peer.displayName ?? String(peer.id),
        msg_id: Number(msg.id),
        sender_id: msg.sender?.id == null ? null : Number(msg.sender.id),
        sender_name: msg.sender?.displayName ?? null,
        content: text,
        timestamp: msg.date.toISOString(),
        raw_json: null,
      })
      if (rows.length % 200 === 0) options.onProgress?.(rows.length)
    }
    options.onProgress?.(rows.length)
    return rows
  }

  async sendMessage(options: { chat: string | number; message: string; reply?: number; linkPreview: boolean }): Promise<{ msg_id: number }> {
    const tg = await this.started()
    const sent = await tg.sendText(options.chat, options.message, { replyTo: options.reply, disableWebPreview: !options.linkPreview })
    return { msg_id: Number(sent.id) }
  }

  async editMessage(options: { chat: string | number; msgId: number; text: string; linkPreview: boolean }): Promise<void> {
    const tg = await this.started()
    await tg.editMessage(options.chat, options.msgId, { text: options.text, disableWebPreview: !options.linkPreview })
  }

  async deleteMessages(options: { chat: string | number; msgIds: number[] }): Promise<void> {
    const tg = await this.started()
    await tg.deleteMessages(options.chat, options.msgIds)
  }

  async listen(): Promise<'stopped' | 'disconnected'> {
    throw new Error('listen will be connected to mtcute updates in the listener task')
  }

  private async started(): Promise<TelegramClient> {
    if (!this.client) {
      if (isDefaultApiId() && !this.warned) {
        this.warned = true
        process.stderr.write('Using default Telegram Desktop API credentials. Set TG_API_ID and TG_API_HASH for a safer account posture.\n')
      }
      this.client = new TelegramClient({ apiId: getApiId(), apiHash: getApiHash(), storage: getSessionPath() })
      await this.client.start()
    }
    return this.client
  }
}

function normalizeChatType(peer: { type?: string; isBroadcast?: boolean }): TelegramChatType {
  if (peer.type === 'user') return 'user'
  if (peer.type === 'chat') return 'group'
  if (peer.type === 'channel' && peer.isBroadcast) return 'channel'
  if (peer.type === 'channel') return 'supergroup'
  return 'unknown'
}
```

During execution, verify method names against local `mtcute/packages/node/src` and adjust this adapter only. Keep services and commands unchanged.

- [ ] **Step 3: Switch command handlers to the real factory**

Modify `src/commands/telegram.ts` so every `new FakeTelegramClient()` expression becomes `createTelegramClient()`, and add:

```ts
import { createTelegramClient } from '../telegram/client-factory.js'
```

Remove this import:

```ts
import { FakeTelegramClient } from '../telegram/fake-client.js'
```

- [ ] **Step 4: Add manual smoke docs**

Create `docs/manual-smoke.md`:

```md
# Manual mtcute Smoke Tests

Run these only with a Telegram account you control.

```bash
export TG_API_ID=123456
export TG_API_HASH=your_hash
pnpm dev -- status --yaml
pnpm dev -- whoami --yaml
pnpm dev -- chats --yaml
pnpm dev -- refresh --max-chats 1 --delay 0 --yaml
pnpm dev -- search test --yaml
```

For send testing, use a private saved-message chat or a disposable test chat:

```bash
pnpm dev -- send "Saved Messages" "tg-cli node smoke test" --yaml
```
```

- [ ] **Step 5: Run typecheck and non-network tests**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: tests pass. If typecheck fails because mtcute method names differ, inspect `mtcute/packages/node/src` and adjust only `src/telegram/mtcute-client.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/mtcute-client.ts src/telegram/client-factory.ts src/commands/telegram.ts docs/manual-smoke.md
git commit -m "feat: add mtcute telegram adapter"
```

## Task 8: Listen Service and Ink TTY Presenters

**Files:**
- Create: `src/services/listen-service.ts`
- Create: `src/presenters/ink/components.tsx`
- Create: `src/presenters/ink/render.tsx`
- Modify: `src/cli/output.ts`
- Modify: `src/commands/telegram.ts`

- [ ] **Step 1: Implement Ink components**

Create `src/presenters/ink/components.tsx`:

```tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { HumanOutput } from '../../commands/types.js'

export function HumanView({ output }: { output: HumanOutput }): React.ReactElement {
  if (output.kind === 'text') return <Text>{output.text}</Text>
  if (output.kind === 'timeline') {
    const max = Math.max(1, ...output.rows.map((row) => row.count))
    return (
      <Box flexDirection="column">
        {output.rows.map((row) => (
          <Text key={row.period}>{row.period} {'█'.repeat(Math.round((row.count / max) * 40))} {row.count}</Text>
        ))}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text bold>{output.title}</Text>
      <Text>{output.columns.join(' | ')}</Text>
      {output.rows.map((row, index) => <Text key={index}>{row.join(' | ')}</Text>)}
    </Box>
  )
}
```

Create `src/presenters/ink/render.tsx`:

```tsx
import React from 'react'
import { render } from 'ink'
import type { HumanOutput } from '../../commands/types.js'
import { HumanView } from './components.js'

export async function renderInk(output: HumanOutput): Promise<void> {
  const instance = render(<HumanView output={output} />)
  await instance.waitUntilExit()
}
```

- [ ] **Step 2: Route rich output through Ink**

Modify the rich success branch in `src/cli/output.ts`:

```ts
  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`)
    process.exitCode = 1
    return
  }

  if (result.human) {
    const { renderInk } = await import('../presenters/ink/render.js')
    await renderInk(result.human)
    return
  }

  process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
```

- [ ] **Step 3: Implement listen service**

Create `src/services/listen-service.ts`:

```ts
import { setTimeout as delayMs } from 'node:timers/promises'
import { MessageDB } from '../storage/message-db.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

export class ListenService {
  constructor(private readonly tg: TelegramClientAdapter, private readonly db = new MessageDB()) {}

  async listen(options: { chats?: Array<string | number>; persist: boolean; retrySeconds: number; signal: AbortSignal }): Promise<void> {
    while (!options.signal.aborted) {
      const status = await this.tg.listen({
        chats: options.chats,
        signal: options.signal,
        onMessage: (message) => {
          this.db.insertBatch([message])
          process.stdout.write(`${message.timestamp.slice(11, 19)} ${message.chat_name ?? ''} | ${message.sender_name ?? 'Unknown'}: ${(message.content ?? '').slice(0, 200)}\n`)
        },
      })
      if (!options.persist || status === 'stopped') return
      await delayMs(options.retrySeconds * 1000)
    }
  }
}
```

- [ ] **Step 4: Wire listen command to service**

Modify the `listen` command action in `src/commands/telegram.ts`:

```ts
  app.command('listen').argument('[chats...]').option('--persist').option('--retry-seconds <seconds>', 'Reconnect delay', '5').action(async (chats: string[], options) => {
    const controller = new AbortController()
    process.once('SIGINT', () => controller.abort())
    const parsed = chats.map((chat) => {
      const id = Number.parseInt(chat, 10)
      return !Number.isNaN(id) && String(id) === chat.trim() ? id : chat
    })
    const { ListenService } = await import('../services/listen-service.js')
    await new ListenService(createTelegramClient()).listen({
      chats: parsed.length > 0 ? parsed : undefined,
      persist: Boolean(options.persist),
      retrySeconds: numberOption(options.retrySeconds) ?? 5,
      signal: controller.signal,
    })
  })
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: tests pass and TSX files typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/services/listen-service.ts src/presenters/ink/components.tsx src/presenters/ink/render.tsx src/cli/output.ts src/commands/telegram.ts
git commit -m "feat: add ink tty output and listen service"
```

## Task 9: Final Contract Pass and Manual Verification

**Files:**
- Modify: `README.md`
- Modify: `.gitignore`
- Modify: `docs/manual-smoke.md`

- [ ] **Step 1: Add root README**

Create or replace `README.md`:

```md
# tg-cli Node.js Port

TypeScript Telegram CLI using mtcute.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev -- --help
```

## Telegram Setup

Use your own API credentials when possible:

```bash
export TG_API_ID=123456
export TG_API_HASH=your_hash
```

Then run:

```bash
pnpm dev -- status
pnpm dev -- chats
pnpm dev -- refresh --max-chats 1
```

## Structured Output

Use `--yaml` or `--json` for machine-readable output. Non-TTY stdout defaults to YAML.
```

- [ ] **Step 2: Fix ignore rules for reference directories and generated files**

Modify `.gitignore` to include:

```gitignore
.DS_Store
node_modules/
dist/
coverage/
*.db
*.db-shm
*.db-wal
tg-cli/
mtcute/
```

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm dev -- --help
pnpm dev -- stats --yaml
```

Expected:

- Vitest passes.
- TypeScript reports no errors.
- Help prints the command list.
- `stats --yaml` prints a schema version `1` payload, even if the local database is empty.

- [ ] **Step 4: Run manual Telegram smoke tests when credentials are available**

Run:

```bash
TG_API_ID="$TG_API_ID" TG_API_HASH="$TG_API_HASH" pnpm dev -- status --yaml
TG_API_ID="$TG_API_ID" TG_API_HASH="$TG_API_HASH" pnpm dev -- whoami --yaml
TG_API_ID="$TG_API_ID" TG_API_HASH="$TG_API_HASH" pnpm dev -- chats --yaml
TG_API_ID="$TG_API_ID" TG_API_HASH="$TG_API_HASH" pnpm dev -- refresh --max-chats 1 --delay 0 --yaml
```

Expected: each command authenticates or prompts through mtcute, then emits a structured payload.

- [ ] **Step 5: Commit**

```bash
git add README.md .gitignore docs/manual-smoke.md
git commit -m "docs: add node tg cli usage"
```

## Self-Review

- Spec coverage: Tasks cover root TypeScript/pnpm scaffold, command surface, structured output, SQLite storage, local query/data commands, Telegram adapter interface, mtcute adapter, Ink output, listener behavior, and manual smoke verification.
- Scope: The plan is one cohesive implementation plan for a 1:1 first port. It intentionally does not include old Python DB compatibility or Telethon session migration.
- Type consistency: Shared result types are defined in Task 1 and reused by services and command modules. Telegram adapter types are defined before fake and mtcute implementations. Storage row types are defined before fixtures and services use them.
- Runtime dependency boundary: `tg-cli/` and `mtcute/` are never imported by application code. Task 7 allows reading local mtcute source only to correct adapter method names.
