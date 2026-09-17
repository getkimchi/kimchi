# Release methodology

How kimchi releases are prepared, published, and consumed. The single source of truth for user-facing changes is the root [`CHANGELOG.md`](../CHANGELOG.md).

## Lifecycle

1. **Curate.** Maintainers append user-visible changes to `## [Unreleased]` in `CHANGELOG.md` as PRs land on `main`. Format rules live in `AGENTS.md` → "Changelog".
2. **Prepare.** Run `node scripts/release.mjs X.Y.Z`. The script stamps `## [Unreleased]` as `## [X.Y.Z] - YYYY-MM-DD`, bumps `package.json`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, seeds a fresh empty `## [Unreleased]`, and prints the push instructions. It never pushes.
3. **Push.** Push `main` and the tag (`git push origin main && git push origin vX.Y.Z`).
4. **CI.** The tag push triggers the release workflow: binaries are built and a GitHub release is published with notes extracted from the changelog's `[X.Y.Z]` section (`scripts/release-notes.mjs`).
5. **Homebrew.** The workflow updates the homebrew-tap formula, as before. This step is unchanged.

`node scripts/release.mjs X.Y.Z --dry-run` previews the stamp/bump without touching the working tree or git history.

## What goes in the changelog

In — user-visible changes only:

- New features and behavior changes
- Bug fixes a user would notice
- Removals and breaking changes

Out:

- Internal refactors with no user-visible effect
- CI, test-only, and build-tooling changes
- Dependency bumps (unless they change user-visible behavior)
- Docs-only changes

One bullet per change, attributed to its PR: `([#456](https://github.com/getkimchi/kimchi/pull/456))`.

## Consuming surfaces

- **TUI `/changelog` and the startup "What's New" popup** read `CHANGELOG.md` and render version sections newer than the `lastChangelogVersion` setting in `~/.config/kimchi/harness/settings.json`. The recorder updates that setting to the running version, so each user sees every release since they last ran kimchi.
- **GitHub release notes** are extracted from the matching `## [X.Y.Z]` section at release time. PR labels are not used to generate release notes — labels drive triage only.

## How the TUI finds the file

The TUI reads `CHANGELOG.md` from the package dir (`PI_PACKAGE_DIR`):

- **Dev runs** (`pnpm run dev`): the repo root, so edits show up immediately.
- **Standalone binaries**: the installed share dir (e.g. `~/.local/share/kimchi`), where the release workflow ships the file next to `package.json`.

Parser constraint: version headers must be `## [X.Y.Z]` at column 0. Leading whitespace breaks parsing; `[Unreleased]` and non-semver headers are ignored by the renderer.

## Previewing locally

1. Edit the root `CHANGELOG.md` (or a scratch copy) with a `## [9.9.9]` section describing the change.
2. Run `pnpm run dev` and type `/changelog`, or restart to trigger the "What's New" popup.
3. To re-trigger the popup, lower `lastChangelogVersion` in `~/.config/kimchi/harness/settings.json` (e.g. to `0.0.0`).

## Notes

- **Dry-runs create no release.** `workflow_dispatch` runs of the release workflow only build binaries with a `0.0.0-dry-run` version label; they never create a GitHub release. Only `v*` tag pushes publish.
- **Upgrading from pre-changelog versions.** Users upgrading from a version older than the changelog introduction get one large "What's New" popup covering everything since their frozen `lastChangelogVersion`. This is a one-time effect and accepted.
- Releases prior to the changelog introduction are documented on the [GitHub Releases page](https://github.com/getkimchi/kimchi/releases).
