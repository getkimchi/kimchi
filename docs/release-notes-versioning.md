# Release notes and version guidance

Release with the existing tag flow. The release workflow prepares notes, runs the
existing checks and builds, then publishes binaries, checksums, installers, and a
`CHANGELOG.md` asset. Stable releases still update Homebrew.

```sh
git tag -a v1.2.0 -m "v1.2.0"
git push getkimchi v1.2.0
```

Choose the version before creating the tag. Guidance is advisory for ordinary
patch/minor releases; major or declared breaking releases require explicit approval.

## Preview the next release

Every push to `master` runs **Release preview**. Its job summary shows the exact
commit, previous published stable ancestor, included PRs, unresolved changes, and
suggested version. Download the `release-preview` artifact for the full notes.
Preview does not create a tag, release, or commit.

To preview locally with Node 22.18+ and authenticated GitHub CLI:

```sh
pnpm install --frozen-lockfile
node src/ci/release-notes.ts
```

Output is written under `.kimchi/docs/release-notes/` (ignored by Git). Optional
`RELEASE_SHA` selects a full commit SHA; `GITHUB_REPOSITORY` defaults to
`getkimchi/kimchi`. `RELEASE_TAG` checks an existing tag against that SHA.

| Declared change | Suggested bump |
| --- | --- |
| `breaking change`, conventional `!`, or `BREAKING CHANGE:` in the PR body | Major |
| `new feature` or `feat:` | Minor |
| `bug`, `fix:`, or `perf:` | Patch |
| Documentation or maintenance only; empty range | No release needed |
| Unclassified PR, revert, or commit without an in-range merged PR | Needs classification |

Labels and conventional PR titles are alternatives. The highest declared impact
wins. Unknown changes suppress a definitive version suggestion; they never silently
become patch changes. Known breaking changes still require approval even when
another change is unclassified or the requested tag is only a patch bump.
This is metadata-based guidance, not a compatibility audit. Maintainers select the
actual tag; a patch/minor mismatch produces a warning without adding a release PR.

## Approve a major or breaking release

The tag-triggered run stops at preflight and saves its summary. Review the exact
SHA, change list, and migration instructions linked from the breaking PRs. Then
manually run **Release** on that same tag, enabling `approve_major` and
`publish_github_release`. Enable `publish_homebrew` for a stable release:

```sh
gh workflow run release.yml --repo getkimchi/kimchi --ref v2.0.0 \
  -f approve_major=true \
  -f publish_github_release=true \
  -f publish_homebrew=true
```

This is explicit maintainer approval through the existing workflow dispatch;
it does not configure a protected environment or require a separate reviewer.
A plain failed-job rerun cannot grant approval. Prereleases such as
`v2.0.0-rc.1` also require approval when they introduce a major/breaking change,
and never update stable latest or Homebrew.

## Notes and changelog

GitHub generates the detailed change list using `.github/release.yml`, with an
explicit previous stable tag and target SHA. The adapter adds a short Highlights
section and any in-range PRs or direct commits missing from that generated list.
Declared breaking changes receive a separate warning and links to their PRs.
Migration instructions remain maintained in those PRs.

`CHANGELOG.md` contains published stable release bodies through the current version.
It is a downloadable release asset, not a source-tree writeback. This avoids adding
a second PR or a branch-protection bypass to the tag workflow. Prerelease notes
appear on their own GitHub releases and are excluded from stable changelog history.

Published release bodies are reused on retries, preserving maintainer edits. A
retry of an older published release cannot promote it to latest or update Homebrew.
A new stable tag must be newer than every published stable version. The baseline
must be an ancestor of the target; canary, draft, and prerelease entries are ignored.
Accepted tags are `vMAJOR.MINOR.PATCH[-PRERELEASE]`, without build metadata.
The first stable release must already exist; this is not a bootstrap publisher.

Before publication, the workflow checks the prepared repository/tag/SHA identity,
the tag's current target, and whether the stable baseline changed during the build.
A mismatch stops publication; inspect the change before rerunning. Release runs use
one concurrency group: one active and one pending run. GitHub replaces an older
pending run if another arrives, so finish one release before pushing the next tag.

## Optional Kimchi-generated highlights

The default highlights use PR titles deterministically. To enable optional editorial
generation, configure these repository settings:

| Setting | Purpose |
| --- | --- |
| Secret `RELEASE_NOTES_API_KEY` | Dedicated Kimchi gateway credential |
| Variable `RELEASE_NOTES_MODEL` | Model available to that credential |
| Variable `RELEASE_NOTES_PROVIDER` | Optional `X-Provider-Type` routing header |

Only release preflight uses the model; master previews stay deterministic. The
request sends PR numbers and titles to the existing Kimchi gateway, with a 20-second
timeout, 600-token output limit, and bounded input. Output must contain one to three
short highlights referencing only included PR numbers. Markdown is escaped and links
are constructed locally. Missing configuration, API errors, timeouts, oversized
input, or invalid output fall back to deterministic highlights.

The model cannot select a version, remove the detailed change list, or remove the
breaking-change warning. Validation checks structure and references; it cannot prove
that every paraphrase is semantically correct. Leave it unconfigured when exact
PR-title wording is preferred.

## Verification and rationale

Run the release-specific tests and repository checks:

```sh
pnpm exec vitest run src/ci/release-notes.test.ts
pnpm run check
```

Tests cover version classification, ancestry, pagination, range completeness,
prereleases, retries, approval, optional-generation fallback, workflow wiring, and
the executable preflight/verification boundary with a fake GitHub CLI.

Read-only historical validation covered the six ranges ending in `v1.1.29` through
`v1.1.34`: 20 PRs were retained, and published release bodies and modification times
were unchanged. Labels alone covered 15 of those PRs; labels plus conventional titles
covered all 20. That supports the fallback policy, not automatic compatibility
inference. Node 22 execution and GitHub's non-publishing `generate-notes` endpoint
were exercised; an actual release remains a post-merge validation step.

GitHub's native notes already provide the detailed list. A release-PR tool would
change the requested tag process; a draft manager would still need custom handling
for unresolved metadata and ancestor selection. The repository adapter adds those
policies without a new action dependency, release bot, or source-version commit.
