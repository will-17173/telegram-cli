import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/cli/app.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'

const SITE_PAGES = [
  'site/index.html',
  'site/zh-CN/index.html',
  'site/docs/index.html',
  'site/zh-CN/docs/index.html',
]

const DOC_PAGES = SITE_PAGES.slice(2)

const SITE_FILES = [
  ...SITE_PAGES,
  'site/assets/styles.css',
  'site/assets/docs.css',
  'site/assets/favicon.svg',
  'site/.nojekyll',
  'site/robots.txt',
  'site/sitemap.xml',
  '.github/workflows/pages.yml',
]

function readRequiredFile(path: string): string {
  expect(existsSync(path), `${path} should exist`).toBe(true)
  return readFileSync(path, 'utf8')
}

function cssVariable(styles: string, name: string): string {
  const match = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))
  expect(match, `--${name} should be a hex color`).not.toBeNull()
  return match![1]
}

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/.{2}/g)!.map(value => Number.parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

function resolvedLocalTarget(pagePath: string, reference: string): string {
  const target = resolve(dirname(pagePath), reference.split(/[?#]/)[0])
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, 'index.html')
  return target
}

function attributeValues(page: string, attribute: string): string[] {
  return [...page.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, 'g'))]
    .map(match => match[1])
}

describe('GitHub Pages site', () => {
  it('ships a complete static Pages artifact', () => {
    for (const path of SITE_FILES) {
      expect(existsSync(path), `${path} should exist`).toBe(true)
    }
  })

  it('offers equivalent English and Simplified Chinese entry points', () => {
    const english = readRequiredFile('site/index.html')
    const chinese = readRequiredFile('site/zh-CN/index.html')

    expect(english).toContain('<html lang="en">')
    expect(english).toContain('href="./docs/"')
    expect(english).toContain('href="./zh-CN/"')
    expect(english).toContain('hreflang="zh-CN"')
    expect(chinese).toContain('<html lang="zh-CN">')
    expect(chinese).toContain('href="./docs/"')
    expect(chinese).toContain('href="../"')
    expect(chinese).toContain('hreflang="en"')
    expect(english).toContain('Structured on demand')
    expect(chinese).toContain('需要时提供结构化输出')
    expect(english).toContain('Abridged example JSON output')
    expect(chinese).toContain('JSON 输出节选')

    for (const page of [english, chinese]) {
      expect(page).toContain('npm install -g @will-17173/telegram-cli')
      expect(page).toContain('tg account add')
      expect(page).toContain('tg search "release" --account work --json')
      expect(page).toContain('https://github.com/will-17173/telegram-cli')
      expect(page).toContain('GPL-3.0-only')
      expect(page).not.toContain('18 ms')
    }
  })

  it('publishes equivalent detailed documentation for both locales', () => {
    const english = readRequiredFile('site/docs/index.html')
    const chinese = readRequiredFile('site/zh-CN/docs/index.html')

    expect(english).toContain('<html lang="en">')
    expect(english).toContain('<link rel="canonical" href="https://will-17173.github.io/telegram-cli/docs/">')
    expect(english).toContain('href="../zh-CN/docs/"')
    expect(english).toContain('hreflang="zh-CN"')
    expect(chinese).toContain('<html lang="zh-CN">')
    expect(chinese).toContain('<link rel="canonical" href="https://will-17173.github.io/telegram-cli/zh-CN/docs/">')
    expect(chinese).toContain('href="../../docs/"')
    expect(chinese).toContain('hreflang="en"')

    const sectionIds = [
      'quick-start',
      'execution-model',
      'workflows',
      'accounts-config',
      'command-reference',
      'group-management',
      'automation',
      'safety',
      'troubleshooting',
    ]

    for (const page of [english, chinese]) {
      expect(page).toContain('v0.7.3')
      expect(page).not.toContain('v0.4.0')
      for (const id of sectionIds) expect(page).toContain(`id="${id}"`)
      expect(page).toContain('data-scope="live"')
      expect(page).toContain('data-scope="persist"')
      expect(page).toContain('data-scope="local"')
      expect(page).toContain('data-scope="write"')
      expect(page).toContain('"schema_version"')
      expect(page).toContain('tg data reset --yes')
      expect(page).toContain('tg sync-all')
      expect(page).toContain('--attachment 2')
      expect(page).toContain('attachments[]')
      expect(page).toContain('attachment_changed')
      expect(page).toContain('media_access_denied')
      expect(page).toContain('archive_partial_failure')
      expect(page).toContain('write_access_disabled')
      expect(page).toContain('tg config write-access off')
      expect(page).toContain('OUTPUT=markdown')
      expect(page).toContain('tg web')
      expect(page).not.toContain('not implemented yet')
      expect(page).not.toContain('尚未实现')

      const archiveRow = page.match(/<tr data-command="archive">[\s\S]*?<\/tr>/)
      expect(archiveRow, 'archive should have a command-reference row').not.toBeNull()
      expect(archiveRow![0]).toContain('data-scope="filesystem"')
    }

    expect(chinese.match(/<dl class="definition-grid">/g)).toHaveLength(2)
    expect(chinese).not.toMatch(/<div class="definition-grid">\s*<div>\s*<dt>/s)
  })

  it('keeps advanced safety and interactive contracts in the detailed documentation', () => {
    const english = readRequiredFile('site/docs/index.html')
    const chinese = readRequiredFile('site/zh-CN/docs/index.html')

    for (const page of [english, chinese]) {
      for (const contract of [
        '/reply &lt;message-id&gt; &lt;content&gt;',
        '/member mute @alice 2h',
        '--send-to',
        '--confirm-title',
        'password_required',
        '--show-secrets',
        'stdout',
        'stderr',
        'YAML',
        '2FA',
        'stdin',
        'TTY',
      ]) expect(page).toContain(contract)

      for (const alias of ['/rep', '/rpy', '/ban']) {
        expect(page).toMatch(new RegExp(`<code(?: translate="no")?>${alias}</code>`))
      }
    }

    expect(english).toContain('Proxy usernames, passwords, and credential query parameters remain masked')
    expect(english).toContain('The password is never a command argument, environment value, or piped stdin input')
    expect(chinese).toContain('代理用户名、密码和凭据查询参数始终显示为')
    expect(chinese).toContain('不要在参数、环境变量、stdin、日志或聊天中提供密码')
  })

  it('keeps both documentation locales aligned with the real command catalogs', () => {
    const commandNames = createApp().commands.map(command => command.name()).sort()
    const groupCommands = GROUP_COMMANDS.map(definition => definition.path.join(' ')).sort()

    for (const path of DOC_PAGES) {
      const page = readRequiredFile(path)

      expect(attributeValues(page, 'data-command').sort(), `${path} top-level command markers`).toEqual(commandNames)
      expect(attributeValues(page, 'data-group-command').sort(), `${path} group command markers`).toEqual(groupCommands)
      expect(page).toContain(`data-command-count="${commandNames.length}"`)
      expect(page).toContain(`data-group-command-count="${groupCommands.length}"`)
    }
  })

  it('uses project-path-safe assets and accessible page foundations', () => {
    const pages: Array<[string, string]> = SITE_PAGES.map(path => [path, readRequiredFile(path)])
    const styles = readRequiredFile('site/assets/styles.css')

    for (const [path, page] of pages) {
      expect(page).toContain('class="skip-link"')
      expect(page).toMatch(/<main\b[^>]*\bid="main-content"[^>]*>/)
      expect(page).toContain('aria-label=')
      expect(page).not.toMatch(/(?:href|src)="\/(?!\/)/)

      const localReferences = [...page.matchAll(/(?:href|src)="([^"]+)"/g)]
        .map(match => match[1])
        .filter(reference => !reference.startsWith('http') && !reference.startsWith('#'))
      for (const reference of localReferences) {
        const target = resolvedLocalTarget(path, reference)
        expect(existsSync(target), `${path} should resolve ${reference}`).toBe(true)
      }
    }

    expect(styles).toContain(':focus-visible')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('@media (max-width: 760px)')
  })

  it('keeps text and keyboard focus indicators above contrast thresholds', () => {
    const styles = readRequiredFile('site/assets/styles.css')

    expect(styles).toMatch(/\.capability-accent p\s*\{[^}]*color:\s*var\(--ink-soft\)/s)
    expect(contrastRatio(cssVariable(styles, 'ink-soft'), cssVariable(styles, 'telegram'))).toBeGreaterThanOrEqual(4.5)
    expect(styles).toMatch(/\.message-bubble small\s*\{[^}]*color:\s*var\(--muted\)[^}]*font-size:\s*10px/s)
    expect(styles).toContain('box-shadow: 0 0 0 3px var(--surface), 0 0 0 6px var(--blue-800)')
    expect(contrastRatio(cssVariable(styles, 'surface'), cssVariable(styles, 'blue-800'))).toBeGreaterThanOrEqual(3)
  })

  it('adds a responsive, no-script documentation reading layout', () => {
    const styles = readRequiredFile('site/assets/docs.css')

    expect(styles).toContain('.docs-layout')
    expect(styles).toContain('.docs-signal-rail')
    expect(styles).toContain('.mobile-docs-nav')
    expect(styles).toContain('.scope-badge')
    expect(styles).toContain('@media (max-width: 1120px)')
    expect(styles).toContain('@media (max-width: 760px)')
    expect(styles).toContain('@media (forced-colors: active)')
    expect(styles).toContain('.docs-page summary:focus-visible')
  })

  it('lists every localized route in the sitemap', () => {
    const sitemap = readRequiredFile('site/sitemap.xml')

    expect(sitemap).toContain('<loc>https://will-17173.github.io/telegram-cli/docs/</loc>')
    expect(sitemap).toContain('<loc>https://will-17173.github.io/telegram-cli/zh-CN/docs/</loc>')
    expect(sitemap.match(/hreflang="en"/g)).toHaveLength(4)
    expect(sitemap.match(/hreflang="zh-CN"/g)).toHaveLength(4)
  })

  it('deploys only the static site with the official Pages actions', () => {
    const workflow = readRequiredFile('.github/workflows/pages.yml')

    expect(workflow).toContain('branches: [main]')
    expect(workflow).toContain("- 'tests/site/pages-site.test.ts'")
    expect(workflow).toContain("- 'src/cli/app.ts'")
    expect(workflow).toContain("- 'src/commands/**'")
    expect(workflow).toContain("- 'src/group-commands/**'")
    expect(workflow).toContain('uses: actions/checkout@v7')
    expect(workflow).toContain('uses: pnpm/action-setup@v6')
    expect(workflow).toContain('uses: actions/setup-node@v7')
    expect(workflow).toContain('uses: actions/configure-pages@v6')
    expect(workflow).toContain('uses: actions/upload-pages-artifact@v5')
    expect(workflow).toContain('uses: actions/deploy-pages@v5')
    expect(workflow).toContain('path: site')
    expect(workflow).toContain('pages: write')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('name: github-pages')
    expect(workflow).toContain('needs: validate')
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    expect(workflow).toContain('pnpm exec vitest run tests/site/pages-site.test.ts tests/package.test.ts')
  })
})
