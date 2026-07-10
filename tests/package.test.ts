import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type PackageJson = {
  name?: string
  private?: boolean
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
    expect(packageJson.publishConfig).toEqual({ access: 'public' })
    expect(packageJson.bin).toEqual({ tg: './dist/index.js' })
    expect(packageJson.files).toEqual(['dist', 'README.md', 'README.zh-CN.md', 'LICENSE'])
    expect(packageJson.engines).toEqual({ node: '>=22' })
    expect(packageJson.scripts?.build).toBe('pnpm clean && tsc -p tsconfig.build.json')
    expect(readFileSync('src/index.ts', 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
  })
})
