---
name: publish
description: Prepare and publish @will-17173/telegram-cli releases. Use when the user gives a new version number or asks to prepare, tag, push, or npm publish a telegram-cli release, including updating changelog/version/docs/site/skills, recreating an existing git tag when requested, and publishing with NPM_TOKEN from .env.
---

# Publish

Use this repository-specific release workflow for `/Volumes/T7/Code/telegram-cli`.

## Inputs

Require a target semver version from the user, such as `0.7.4`. Normalize the git tag as `v<version>`.

If the target npm version already exists, stop before publishing: npm package versions are immutable. Ask for a new version unless the user only wants local docs/tag work.

## Release Workflow

1. Confirm repository state:

```sh
git status --short --branch
git log --oneline --decorate -10
git tag --sort=-v:refname 'v*' | head
npm view @will-17173/telegram-cli@<version> version
```

Treat `npm view` `E404` as available. Treat any returned version as already published.

2. Identify changes since the previous release tag:

```sh
git tag --sort=-v:refname 'v*'
git log --oneline <previous-tag>..HEAD
git diff --stat <previous-tag>..HEAD
```

Use the previous semver tag before the target version. If the target tag already exists and the user asked to recreate it, compare from the previous tag, not from the stale target tag.

3. Update release files:

- `package.json`: set `"version"` to the target version.
- `src/cli/app.ts`: update `.version('<version>')`.
- Tests that assert the version: usually `tests/package.test.ts`, `tests/cli/help.test.ts`, and `tests/site/pages-site.test.ts`.
- `CHANGELOG.md`: create or update `## [<version>] - YYYY-MM-DD` from commits since the previous tag. Keep `## [Unreleased]` above it.
- `site/docs/index.html` and `site/zh-CN/docs/index.html`: update visible and metadata version strings.
- `README.md` and `README.zh-CN.md`: update only if release behavior changes user-facing examples or docs.
- `skills/using-telegram-cli`: update only if command behavior, flags, output contracts, or safety rules changed.

Prefer `rg -n '<old-version>|v<old-version>'` to find remaining hard-coded versions.

4. Verify before committing:

```sh
pnpm exec vitest run tests/package.test.ts tests/cli/help.test.ts tests/site/pages-site.test.ts
pnpm test
pnpm typecheck
pnpm build
node dist/index.js --version
npm pack --dry-run
```

If `pnpm pack --dry-run` is unsupported, use `npm pack --dry-run`. The package name and version in the notice must match the target.

5. Commit and tag:

```sh
git add <changed-files>
git commit -m "chore(release): prepare v<version>"
git tag v<version>
```

If `v<version>` already exists and the user explicitly requested retagging:

```sh
git tag -f v<version> HEAD
```

6. Push:

```sh
git push origin main
git push origin v<version>
```

If retagging an existing remote tag was explicitly requested:

```sh
git push origin v<version> --force
```

7. Publish npm using `.env`:

- Read `.env` locally and require `NPM_TOKEN`.
- Never print the token.
- Do not write the token to repository files or global `~/.npmrc`.
- Use a temporary npm config and delete it afterward.

Safe pattern:

```sh
tmp_npmrc=$(mktemp)
printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > "$tmp_npmrc"
set -a
. ./.env
set +a
npm publish --userconfig "$tmp_npmrc" --access public
publish_code=$?
node -e "require('node:fs').unlinkSync(process.argv[1])" "$tmp_npmrc"
exit $publish_code
```

If publish fails after creating the temp file, delete the temp file before continuing. Avoid shell variable name `status` in zsh because it is read-only.

8. Confirm publication:

```sh
npm view @will-17173/telegram-cli@<version> version dist.integrity time --json
npm view @will-17173/telegram-cli dist-tags --json
git status --short --branch
git ls-remote --tags origin v<version>
```

Report the commit, tag, npm version, `latest` dist-tag, and verification commands.

## Guardrails

- Do not publish if tests, typecheck, build, version output, or package dry-run fail.
- Do not overwrite an npm version; bump instead.
- Do not force-push branches. Only force-push a tag when the user explicitly requested retagging.
- Preserve unrelated user changes. If the worktree is dirty before release edits, inspect and avoid committing unrelated files.
- If `.env` is missing `NPM_TOKEN`, stop and ask for the token or for the user to update `.env`.
