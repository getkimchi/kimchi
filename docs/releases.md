# Release Methodology

How Kimchi releases are prepared, published, and consumed. The root [`CHANGELOG.md`](../CHANGELOG.md) is the **single source of truth for user-visible changes**.

## Lifecycle

1. **Curate.** Maintainers add user-visible changes to `## [Unreleased]` in `CHANGELOG.md` as PRs land on `master`. Formatting rules are defined in `AGENTS.md` → **Changelog**.

2. **Prepare & publish.** Go to **Actions → Release prepare → Run workflow** and enter the version, e.g. `1.2.0`. The workflow:
   - stamps `## [Unreleased]` as `## [X.Y.Z] - YYYY-MM-DD`;
   - bumps `package.json`;
   - creates `Release vX.Y.Z` and `Start next cycle [skip ci]` commits;
   - tags `vX.Y.Z`;
   - pushes `master` and the tag.

   The tag triggers the release workflow, which builds binaries, extracts notes from the changelog's `[X.Y.Z]` section using `scripts/release-notes.mjs extract`, publishes the GitHub release, and updates the Homebrew tap.

> **Why only `Start next cycle` has `[skip ci]`:** GitHub skips push-triggered workflows when the push's head commit contains a skip keyword. The `master` push ends with `Start next cycle [skip ci]`, suppressing CI. The tag push points to `Release vX.Y.Z`, so that commit must **not** contain `[skip ci]` or the tag-triggered Release workflow would be skipped.

> **Branch protection:** `master` remains protected. Only the `release-bot` deploy key can bypass the ruleset, and only through the Release prepare workflow. Humans release by clicking **Run workflow**.

## Changelog

Include **user-visible changes only**:

- New features and behavior changes
- User-visible bug fixes
- Removals and breaking changes

Exclude:

- Internal refactors
- CI, test-only, and build-tooling changes
- Dependency bumps without user-visible impact
- Docs-only changes

Use one bullet per change and link the corresponding PR:

```md
- Improved startup performance ([#456](https://github.com/getkimchi/kimchi/pull/456))
```

## Consuming Surfaces

- **TUI `/changelog` and "What's New"** read `CHANGELOG.md` and show versions newer than `lastChangelogVersion` in `~/.config/kimchi/harness/settings.json`.
- **GitHub release notes** are extracted from the matching `## [X.Y.Z]` section. PR labels are used for triage only.

## File Resolution

The TUI reads `CHANGELOG.md` from `PI_PACKAGE_DIR`:

- **Development:** `pnpm run dev` uses the repository root.
- **Standalone binaries:** the installed share directory, e.g. `~/.local/share/kimchi`.

Version headers must start at column 0:

```md
## [X.Y.Z]
```

Leading whitespace breaks parsing. `[Unreleased]` and non-semver headers are ignored.

## Local Preview

1. Add a temporary `## [9.9.9]` section to `CHANGELOG.md`.
2. Run `pnpm run dev` and use `/changelog`.
3. Restart Kimchi to test **What's New**.
4. To force the popup, set `lastChangelogVersion` in `~/.config/kimchi/harness/settings.json` to an older version such as `0.0.0`.

## Notes

- **Dry runs:** `workflow_dispatch` runs use a `0.0.0-dry-run` version and never publish a GitHub release. Only `v*` tags publish releases.
- **Older releases:** Releases before the changelog are documented on the [GitHub Releases page](https://github.com/getkimchi/kimchi/releases).

## One-Time Setup

Performed once by an administrator.

1. **Create the deploy key:**

   ```sh
   ssh-keygen -t ed25519 -C "release-bot" -f release-bot_key
   gh repo deploy-key add release-bot_key.pub --title release-bot --allow-write
   ```

2. **Allow the bypass.** Add the `release-bot` deploy key as a **bypass actor** in the `master` ruleset.

3. **Store the private key.** Add `release-bot_key` as the repository Actions secret `RELEASE_DEPLOY_KEY`.
