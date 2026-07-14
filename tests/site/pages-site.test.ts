import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SITE_FILES = [
  'site/index.html',
  'site/zh-CN/index.html',
  'site/assets/styles.css',
  'site/assets/favicon.svg',
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
    expect(english).toContain('href="./zh-CN/"')
    expect(english).toContain('hreflang="zh-CN"')
    expect(chinese).toContain('<html lang="zh-CN">')
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

  it('uses project-path-safe assets and accessible page foundations', () => {
    const pages: Array<[string, string]> = [
      ['site/index.html', readRequiredFile('site/index.html')],
      ['site/zh-CN/index.html', readRequiredFile('site/zh-CN/index.html')],
    ]
    const styles = readRequiredFile('site/assets/styles.css')

    for (const [path, page] of pages) {
      expect(page).toContain('class="skip-link"')
      expect(page).toContain('<main id="main-content">')
      expect(page).toContain('aria-label=')
      expect(page).not.toMatch(/(?:href|src)="\/(?!\/)/)

      const localReferences = [...page.matchAll(/(?:href|src)="([^"]+)"/g)]
        .map(match => match[1])
        .filter(reference => !reference.startsWith('http') && !reference.startsWith('#'))
      for (const reference of localReferences) {
        const target = resolve(dirname(path), reference.split(/[?#]/)[0])
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

  it('deploys only the static site with the official Pages actions', () => {
    const workflow = readRequiredFile('.github/workflows/pages.yml')

    expect(workflow).toContain('branches: [main]')
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
