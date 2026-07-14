# Detailed Site Documentation Design

## Goal

Add detailed English and Simplified Chinese documentation to the existing GitHub Pages site, with first-party navigation from each landing page and no separate deployment pipeline.

## Routes and deployment

The documentation is published as two static routes:

- `site/docs/index.html` → `/telegram-cli/docs/`
- `site/zh-CN/docs/index.html` → `/telegram-cli/zh-CN/docs/`

Both pages share `site/assets/styles.css`, `site/assets/docs.css`, and the existing favicon. The Pages workflow already uploads the complete `site/` directory, so the documentation deploys in the same artifact as the landing pages. The workflow remains build-free and the documentation remains readable without JavaScript.

## Information architecture

Each locale uses the same section order and command coverage:

1. Quick start: requirements, installation, account authentication, chat discovery, sync, and local search.
2. Execution model: distinguish live Telegram reads, Telegram-to-SQLite persistence, local-only queries, filesystem archives, and remote Telegram writes.
3. Everyday workflows: online reading, synchronization, local analysis, sending, listening, and archiving.
4. Accounts and configuration: account lifecycle, explicit selection, API credentials, proxy behavior, and local paths.
5. Command reference: every top-level Commander command, its execution scope, representative syntax, and purpose.
6. Group management: inspection routes and all generated member, administrator, chat, invite, topic, and message action families.
7. Automation: output selection, structured envelopes, exit behavior, and partial-failure handling.
8. Safety and troubleshooting: write-access gating, destructive confirmations, secrets, rate limits, local privacy, and common error recovery.

The documentation describes `history` as count-bounded, recommends `group member info` over the ambiguous legacy route, includes `OUTPUT=markdown`, and gives the Chinese page the same chat-type coverage as English.

## Visual direction

The subject is a terminal-first Telegram client used by people and coding agents. The page's single job is to help a reader choose the correct command while understanding where it runs and whether it changes remote state.

The documentation extends the existing palette and type system:

- Paper: `#eef6fb`
- Bright paper: `#f8fbfd`
- Surface: `#ffffff`
- Ink: `#0b1424`
- Telegram blue: `#229ed9`
- Local mint: `#2ac895`
- Write amber: `#f2b84b`
- Terminal: `#0d1727`

Desktop uses a three-column reading shell: a sticky section rail, a bounded article column, and a compact on-page status card. Tablet collapses the status card into the article. Mobile replaces the sticky rail with a native `details` section menu.

The signature element is a continuous “signal rail” beside the primary navigation. Scope badges reuse the same rail vocabulary throughout the page:

```text
┌──────────────┬──────────────────────────────────┬──────────────┐
│ tg› DOCS     │ Article                          │ THIS PAGE    │
│ ● Start      │ H1                               │ LIVE  cloud  │
│ │ Model      │ ┌ live ─ persist ─ local ─ write│ LOCAL sqlite │
│ │ Workflows  │ └ detailed sections             │ WRITE remote │
│ ● Reference  │                                  │              │
└──────────────┴──────────────────────────────────┴──────────────┘
```

This rail encodes the CLI's real data boundary rather than serving as decoration. Article surfaces stay quiet; terminal blocks and scope labels carry the visual emphasis.

## Responsive and accessible behavior

- Preserve skip links, semantic landmarks, heading order, canonical URLs, and reciprocal `hreflang` links.
- Use only project-relative paths so GitHub project Pages routes resolve correctly.
- Keep a visible keyboard focus indicator at or above 3:1 contrast and body text at or above 4.5:1.
- Make wide command tables horizontally scrollable without clipping the page.
- Give mobile readers a native `details` navigation fallback with no script dependency.
- Respect reduced motion and forced-colors preferences inherited from the shared stylesheet.
- Keep command examples selectable and fully visible without copy-button JavaScript.

## Accuracy contract

The site test imports the real Commander app and group command catalog. Both locales must include a `data-command` marker for every top-level command and a `data-group-command` marker for every generated group action. This intentionally turns a future command addition into a failing documentation test until both locales are updated.

The contract also checks route files, reciprocal locale links, landing-page navigation, sitemap entries, local asset resolution, section landmarks, structured-output examples, and Pages artifact configuration.

## Out of scope

- No documentation generator or client framework.
- No separate hosting provider or deployment job.
- No live Telegram calls in site tests.
- No client-side search index in this iteration; browser find and the detailed section rail cover a two-page static corpus without adding a stale second content index.

