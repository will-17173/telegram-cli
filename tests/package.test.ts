import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/cli/app.js'
import { GROUP_COMMANDS } from '../src/group-commands/catalog.js'
import { COMMAND_HANDLERS } from '../src/services/group-write-service.js'

type PackageJson = {
  name?: string
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
  it('publishes the compiled CLI as a public scoped package', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

    expect(packageJson.name).toBe('@will-17173/telegram-cli')
    expect(packageJson.private).toBeUndefined()
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/will-17173/telegram-cli.git',
    })
    expect(packageJson.homepage).toBe('https://github.com/will-17173/telegram-cli#readme')
    expect(packageJson.bugs).toEqual({ url: 'https://github.com/will-17173/telegram-cli/issues' })
    expect(packageJson.publishConfig).toEqual({ access: 'public' })
    expect(packageJson.bin).toEqual({ tg: './dist/index.js' })
    expect(packageJson.files).toEqual(['dist', 'README.md', 'README.zh-CN.md', 'LICENSE'])
    expect(packageJson.engines).toEqual({ node: '>=22' })
    expect(packageJson.scripts?.build).toBe('pnpm clean && tsc -p tsconfig.build.json')
    expect(readFileSync('src/index.ts', 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
  })

  it('documents CLI and interactive group management contracts', () => {
    const readme = readFileSync('README.md', 'utf8')

    for (const example of [
      'tg group member ban @team @alice --yes',
      'tg group chat slowmode @team 30s',
      '/member mute @alice 2h',
      '--send-to',
      '--confirm-title',
      'password_required',
    ]) expect(readme).toContain(example)
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
