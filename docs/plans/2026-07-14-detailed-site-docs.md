# Detailed Site Documentation Implementation Plan

> **For agentic workers:** Execute this plan with test-driven development. Keep the existing static Pages architecture and review each locale for equivalent command coverage before completion.

**Goal:** Publish detailed English and Simplified Chinese CLI documentation in the same GitHub Pages artifact as the current landing pages.

**Architecture:** Add one static documentation route per locale, share a focused documentation stylesheet, and link both routes from the existing landing pages. Protect accuracy by comparing documentation markers with the actual Commander command tree and generated group command catalog.

**Tech Stack:** Static HTML, CSS, GitHub Pages, TypeScript, Vitest, pnpm

---

### Task 1: Protect the documentation artifact and coverage

**Files:**
- Modify: `tests/site/pages-site.test.ts`

- [ ] **Step 1: Add the real command sources and documentation routes**

Import `createApp` and `GROUP_COMMANDS`, then define the four HTML pages and the two documentation pages:

```ts
import { createApp } from '../../src/cli/app.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'

const SITE_PAGES = [
  'site/index.html',
  'site/zh-CN/index.html',
  'site/docs/index.html',
  'site/zh-CN/docs/index.html',
]

const DOC_PAGES = SITE_PAGES.slice(2)
```

- [ ] **Step 2: Add failing route, locale, and navigation assertions**

Require `site/assets/docs.css`, check `/docs/` landing links, reciprocal `hreflang` metadata, canonical URLs, all major documentation section IDs, and both documentation URLs in `site/sitemap.xml`.

- [ ] **Step 3: Add failing command-coverage assertions**

For each documentation page, require every real command marker:

```ts
const commandNames = createApp().commands.map(command => command.name())
for (const command of commandNames) {
  expect(page).toContain(`data-command="${command}"`)
}
for (const definition of GROUP_COMMANDS) {
  expect(page).toContain(`data-group-command="${definition.path.join(' ')}"`)
}
```

- [ ] **Step 4: Verify the focused test fails for the missing documentation**

Run: `pnpm exec vitest run tests/site/pages-site.test.ts`

Expected: FAIL because the documentation pages and stylesheet do not exist.

### Task 2: Build the bilingual documentation pages

**Files:**
- Create: `site/docs/index.html`
- Create: `site/zh-CN/docs/index.html`

- [ ] **Step 1: Add matching document metadata and shared landmarks**

Each page must include a skip link, sticky site header, locale-aware brand link, canonical and reciprocal alternate links, `main#main-content`, desktop section rail, native mobile `details` navigation, article, and footer.

- [ ] **Step 2: Add the common section contract**

Use these stable IDs in both locales:

```html
<section id="quick-start">…</section>
<section id="execution-model">…</section>
<section id="workflows">…</section>
<section id="accounts-config">…</section>
<section id="command-reference">…</section>
<section id="group-management">…</section>
<section id="automation">…</section>
<section id="safety">…</section>
<section id="troubleshooting">…</section>
```

- [ ] **Step 3: Add exhaustive command markers and practical examples**

Render one reference row for every `createApp().commands` entry with `data-command`, and one group action item for every `GROUP_COMMANDS` entry with `data-group-command`. Cover the defaults and caveats recorded in the design: first-sync cap, bounded history, archive partial failures, non-persisting online reads, non-persisting send, listen output restrictions, confirmation rules, and ownership-transfer interaction.

- [ ] **Step 4: Add equivalent Chinese content**

Translate explanatory text while preserving command syntax, IDs, marker values, code examples, scope assignments, output schema fields, and troubleshooting error codes.

### Task 3: Add the documentation visual system

**Files:**
- Create: `site/assets/docs.css`

- [ ] **Step 1: Implement the three-column documentation shell**

Build a sticky left signal rail, readable article measure, and right scope card using the existing color and typography variables. Keep documentation selectors under `.docs-page` to avoid landing-page regressions.

- [ ] **Step 2: Style content primitives**

Add scope badges, command blocks, callouts, definition grids, reference tables, group family matrices, inline options, and previous/next section links. Use semantic color plus text labels so scope never depends on color alone.

- [ ] **Step 3: Add responsive and accessibility states**

At tablet width, remove the right column. At mobile width, hide the desktop rail, reveal the native section menu, stack content grids, and make tables horizontally scrollable. Add explicit focus-visible and forced-colors treatment while inheriting reduced motion behavior.

### Task 4: Connect documentation to the site and deployment contract

**Files:**
- Modify: `site/index.html`
- Modify: `site/zh-CN/index.html`
- Modify: `site/assets/styles.css`
- Modify: `site/sitemap.xml`
- Modify: `.github/workflows/pages.yml`

- [ ] **Step 1: Replace external documentation links with first-party routes**

Add a visible `Docs` / `文档` header link and point footer documentation links to `./docs/` in both landing pages.

- [ ] **Step 2: Make mobile landing navigation class-based**

Replace the positional `nth-child` hiding rule with a `.landing-section-link` rule so adding documentation does not accidentally expose or hide the wrong links.

- [ ] **Step 3: Add both locale documentation routes to the sitemap**

Add canonical entries for `/telegram-cli/docs/` and `/telegram-cli/zh-CN/docs/`, each with reciprocal English and Simplified Chinese alternates.

- [ ] **Step 4: Include site contract changes in the Pages trigger**

Add `tests/site/pages-site.test.ts` to the workflow path filter. Keep artifact upload at `path: site`; nested documentation routes then deploy in the existing Pages artifact.

### Task 5: Verify content, behavior, and presentation

**Files:**
- No file changes expected

- [ ] **Step 1: Run the focused site contract**

Run: `pnpm exec vitest run tests/site/pages-site.test.ts tests/package.test.ts`

Expected: all site and package tests pass.

- [ ] **Step 2: Run the complete repository checks**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: all tests pass, TypeScript reports no diagnostics, and production compilation succeeds.

- [ ] **Step 3: Render both locales at desktop and mobile widths**

Use the system-installed Playwright with a local static server. Verify the English and Chinese routes return 200, local assets load, section links navigate, keyboard focus remains visible, no horizontal page overflow occurs at 390px, and screenshots show no overlaps or clipped code.

- [ ] **Step 4: Check repository hygiene**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors and only intended documentation, site, workflow, and test files are changed.

