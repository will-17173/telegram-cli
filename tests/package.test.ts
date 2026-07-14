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
  it('publishes version 0.4.0', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

    expect(packageJson.version).toBe('0.4.0')
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
    expect(packageJson.engines).toEqual({ node: '>=22' })
    expect(packageJson.scripts?.build).toBe('pnpm clean && tsc -p tsconfig.build.json')
    expect(readFileSync('src/index.ts', 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
  })

  it('documents CLI and unified interactive slash-command contracts', () => {
    const readme = readFileSync('README.md', 'utf8')

    for (const example of [
      'tg group member ban @team @alice --yes',
      'tg group chat slowmode @team 30s',
      '/reply <message-id> <content>',
      '/member mute @alice 2h',
      '`/rep`',
      '`/rpy`',
      '`/ban`',
      '--send-to',
      '--confirm-title',
      'password_required',
    ]) expect(readme).toContain(example)
  })

  it('links the published documentation from both readmes', () => {
    const english = readFileSync('README.md', 'utf8')
    const chinese = readFileSync('README.zh-CN.md', 'utf8')

    expect(english).toContain('[Documentation](https://will-17173.github.io/telegram-cli/docs/)')
    expect(english).toContain('[Read the complete Telegram CLI documentation →](https://will-17173.github.io/telegram-cli/docs/)')
    expect(chinese).toContain('[使用文档](https://will-17173.github.io/telegram-cli/zh-CN/docs/)')
    expect(chinese).toContain('[阅读完整的 Telegram CLI 文档 →](https://will-17173.github.io/telegram-cli/zh-CN/docs/)')
  })

  it('documents release security, output-stream, and ownership-transfer contracts in both languages', () => {
    const readmes = [
      {
        contents: readFileSync('README.md', 'utf8'),
        contracts: [
          'proxy usernames, passwords, and credential query parameters are always masked, even with `--show-secrets`',
          '`--show-secrets` reveals only the full API hash',
          'Successful finite output is written to stdout.',
          'JSON/YAML structured failures are written to stdout in the requested format',
          'Output-format conflicts also use stdout and a stable YAML envelope.',
          'Human-readable and Markdown failures are written to stderr.',
          'tg group admin transfer-owner @team @newowner --yes',
          'never a CLI argument, stdin input, or environment automation source',
        ],
      },
      {
        contents: readFileSync('README.zh-CN.md', 'utf8'),
        contracts: [
          '代理用户名、密码和凭据查询参数始终会被脱敏，即使使用 `--show-secrets`',
          '`--show-secrets` 只会显示完整的 API hash',
          '有限结果命令成功时写入 stdout。',
          'JSON/YAML 结构化失败按请求的格式写入 stdout',
          '输出格式冲突同样写入 stdout，并使用稳定的 YAML 信封。',
          '人类可读和 Markdown 失败信息写入 stderr。',
          'tg group admin transfer-owner @team @newowner --yes',
          '绝不会来自 CLI 参数、stdin 输入或环境变量等自动化来源',
        ],
      },
    ]

    for (const readme of readmes) {
      for (const contract of readme.contracts) expect(readme.contents).toContain(contract)
    }
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
