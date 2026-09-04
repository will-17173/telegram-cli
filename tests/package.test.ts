import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/cli/app.js'
import { GROUP_COMMANDS } from '../src/group-commands/catalog.js'
import { COMMAND_HANDLERS } from '../src/services/group-write-service.js'

type PackageJson = {
  name?: string
  version?: string
  private?: boolean
  repository?: {
    type?: string
    url?: string
  }
  homepage?: string
  bugs?: {
    url?: string
  }
  bin?: Record<string, string>
  files?: string[]
  engines?: Record<string, string>
  publishConfig?: Record<string, string>
  scripts?: Record<string, string>
}

describe('npm package metadata', () => {
  it('publishes version 0.8.10', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

    expect(packageJson.version).toBe('0.8.10')
  })

  it('publishes the compiled CLI as a public scoped package', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

    expect(packageJson.name).toBe('@will-17173/telegram-cli')
    expect(packageJson.private).toBeUndefined()
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/will-17173/telegram-cli.git',
    })
    expect(packageJson.homepage).toBe('https://will-17173.github.io/telegram-cli/')
    expect(packageJson.bugs).toEqual({ url: 'https://github.com/will-17173/telegram-cli/issues' })
    expect(packageJson.publishConfig).toEqual({ access: 'public' })
    expect(packageJson.bin).toEqual({ tg: './dist/index.js' })
    expect(packageJson.files).toEqual(['dist', 'README.md', 'README.zh-CN.md', 'LICENSE'])
    expect(packageJson.engines).toEqual({ node: '>=22.12.0' })
    expect(packageJson.scripts?.['build:web']).toBe('vite build --config web/vite.config.ts')
    expect(packageJson.scripts?.build).toBe('pnpm clean && pnpm build:web && tsc -p tsconfig.build.json')
    expect(packageJson.scripts?.typecheck).toBe('tsc --noEmit && tsc -p web/tsconfig.json')
    expect(readFileSync('src/index.ts', 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
  })

  it('ships focused bilingual readmes with representative workflows and detailed documentation links', () => {
    const readmes = [
      {
        contents: readFileSync('README.md', 'utf8'),
        docsUrl: 'https://will-17173.github.io/telegram-cli/docs/',
        removedHeadings: ['## Command reference', '## Troubleshooting', '## Configuration'],
      },
      {
        contents: readFileSync('README.zh-CN.md', 'utf8'),
        docsUrl: 'https://will-17173.github.io/telegram-cli/zh-CN/docs/',
        removedHeadings: ['## 命令参考', '## 故障排查', '## 配置'],
      },
    ]

    for (const readme of readmes) {
      expect(readme.contents.split(/\r?\n/).length).toBeLessThanOrEqual(230)
      expect(readme.contents).toContain(readme.docsUrl)
      for (const example of [
        'npm install -g @will-17173/telegram-cli',
        'tg account add',
        'tg inbox',
        'tg search-online "incident" --chat @team --json',
        'tg sync @team',
        'tg listen @team --auto-download',
        'tg archive @team --download-media',
        'tg web',
        'tg send @team "Release is ready" --file ./report.pdf',
        'tg group members @team --type admins',
        'tg stats --account work --json',
        'tg config write-access off',
        'npx skills add https://github.com/will-17173/telegram-cli',
      ]) expect(readme.contents).toContain(example)
      expect(readme.contents).toContain('127.0.0.1')
      for (const heading of readme.removedHeadings) expect(readme.contents).not.toContain(heading)
    }
  })
})

describe('bundled Telegram CLI skill', () => {
  const skill = readFileSync('skills/using-telegram-cli/SKILL.md', 'utf8')
  const reference = readFileSync('skills/using-telegram-cli/references/command-reference.md', 'utf8')
  const metadata = readFileSync('skills/using-telegram-cli/agents/openai.yaml', 'utf8')

  it('is discoverable for downloads, the Web UI, and Guard automation', () => {
    for (const keyword of ['downloads', 'Web UI', 'Guard automation']) {
      expect(skill).toContain(keyword)
      expect(metadata).toContain(keyword)
    }
  })

  it('classifies listen, Web, and Guard side effects accurately', () => {
    expect(skill).toContain('`--save` writes SQLite; `--auto-download` writes files')
    expect(skill).toContain('| Browse local messages and trigger read-only sync | `web`')
    expect(skill).toContain('| Run rule-based group automation | `guard start`')
    expect(skill).not.toContain('persists normalized attachments; optional downloads')
    expect(skill).not.toContain('normalized `attachments[]` remain persisted and usable')
  })

  it('documents current Web, Guard, listen, download, and output contracts', () => {
    for (const expected of [
      '## Web UI',
      'tg web --no-open',
      '## Guard automation',
      'tg guard start --port 8734',
      'write access is disabled',
      '/history [count]',
      '/reply #<message-id>',
      '--all --ext jpg,png',
      '--force',
      '{sender_id}_{chat_id}_{message_id}_{timestamp}.{ext}',
      'attachment summaries',
      'OUTPUT=json|yaml|markdown|rich',
    ]) expect(reference).toContain(expected)
    expect(reference).not.toContain('Handle v0.5.0 errors')
  })
})

describe('group management package contracts', () => {
  const handlerPaths = [
    'member add', 'member kick', 'member ban', 'member unban', 'member mute', 'member unmute', 'member purge',
    'admin promote', 'admin demote', 'admin rank', 'admin transfer-owner',
    'chat title', 'chat description', 'chat username', 'chat photo', 'chat slowmode', 'chat ttl', 'chat protect', 'chat join-requests', 'chat join-to-send', 'chat default-permissions', 'chat sticker-set', 'chat leave', 'chat delete',
    'invite list', 'invite show', 'invite create', 'invite edit', 'invite revoke', 'invite members', 'invite approve', 'invite decline', 'invite approve-all', 'invite decline-all',
    'topic list', 'topic create', 'topic edit', 'topic close', 'topic reopen', 'topic pin', 'topic unpin', 'topic reorder', 'topic delete', 'topic general-hidden',
    'message pin', 'message unpin', 'message unpin-all', 'message delete',
  ]

  it('keeps the explicit handler registry aligned with the public catalog', () => {
    expect(Object.keys(COMMAND_HANDLERS).sort()).toEqual([...handlerPaths].sort())
    expect(GROUP_COMMANDS.map(command => command.path.join(' ')).sort()).toEqual([...handlerPaths].sort())
  })

  it('shows every catalog action in its family help output', () => {
    const group = createApp().commands.find(command => command.name() === 'group')!
    for (const family of new Set(GROUP_COMMANDS.map(command => command.path[0]))) {
      const familyCommand = group.commands.find(command => command.name() === family)!
      const help = familyCommand.helpInformation()
      for (const definition of GROUP_COMMANDS.filter(command => command.path[0] === family)) {
        expect(help, definition.path.join(' ')).toContain(definition.path[1])
      }
    }
  })
})
