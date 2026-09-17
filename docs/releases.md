# Release methodology

How kimchi releases are prepared, published, and consumed. The single source of truth for user-facing changes is the root [`CHANGELOG.md`](../CHANGELOG.md).

## Lifecycle

1. **Curate.** Maintainers append user-visible changes to `## [Unreleased]` in `CHANGELOG.md` as PRs land on `master`. Format rules live in `AGENTS.md` → "Changelog".
2. **Prepare & publish from GitHub.** Go to Actions → **Release prepare** → *Run workflow* and enter the version, e.g. `1.2.0`. The workflow stamps `## [Unreleased]` as `## [X.Y.Z] - YYYY-MM-DD` on master (bot commits `Release vX.Y.Z [skip ci]` and `Start next cycle [skip ci]`), bumps `package.json`, tags `vX.Y.Z`, and pushes master and the tag. The tag push triggers the release workflow: binaries are built, notes are extracted from the changelog's `[X.Y.Z]` section (`scripts/release-notes.mjs extract`), the GitHub release is published, and the homebrew tap formula is updated.

> **master stays protected for humans.** Direct pushes to master remain impossible for everyone; only the `release-bot` deploy key bypasses the ruleset, and only through the Release prepare workflow. Humans release by clicking *Run workflow*.

`node scripts/release.mjs X.Y.Z --dry-run` previews the stamp/bump without touching the working tree or git history. The script can also be run by hand on master (it stamps the changelog, bumps `package.json`, creates the release commits, and tags locally, then prints push instructions), but the GitHub workflow is the supported path.

## One-time setup

Performed once by an administrator; afterwards every release is a two-click affair.

1. **Create the deploy key.** Generate an SSH keypair, then add the **public** key as a deploy key with **write access** on this repository, named `release-bot`:

   ```sh
   ssh-keygen -t ed25519 -C "release-bot" -f release-bot_key
   gh repo deploy-key add release-bot_key.pub --title release-bot --allow-write
   ```

2. **Allow the bypass.** In the master branch ruleset, add the `release-bot` deploy key as a **bypass actor**. Without this the workflow's push to master is rejected.

3. **Store the private key.** Add the **private** key (`release-bot_key`) as a repository Actions secret named `RELEASE_DEPLOY_KEY`. The Release prepare workflow fails fast with a pointer to this section if the secret is missing.


Alternative: instead of a deploy key, use a GitHub App with `contents: write` added as the ruleset bypass actor, mint a short-lived token in the workflow with `actions/create-github-app-token`, and push with that token. Pick this if the team prefers app-based credentials over a long-lived deploy key; the rest of this document assumes the deploy key.

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
