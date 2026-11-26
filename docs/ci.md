# CI

The build and test checks for pull requests run in one workflow,
`.github/workflows/ci.yml`. Other workflows are separate: the perf gate
(`perf-gate.yml`), MCP live checks for labeled PRs (`mcp-live.yml`), PR
labeling and welcome messages, and the release workflows.

## What blocks a merge

The "Master" ruleset requires one check: `master-checks`. It is a small gate
job that passes only when every job in its `needs` list passed:

| Job | What it runs |
|---|---|
| `lint` | `pnpm run check` (biome and typecheck) |
| `unit` | unit tests in 4 shards (`vitest --shard`) |
| `build` | proxy-helper tests, then the binary, uploaded as the `kimchi-build` artifact |
| `smoke` | script tests and smoke tests against the built binary |

To make another job block merges, add it to `needs` of `master-checks`. Do
not change the ruleset: the gate keeps the same name.

The gate uses `if: always()`. Without it, a failed job makes the gate
"skipped", and GitHub treats a skipped required check as passing.

## Advisory suites

These jobs do not block merges, but a failure turns the CI run red. The
three e2e suites run after `build` and use its binary.

| Job | When it runs |
|---|---|
| `tui-e2e` | 6 shards. PRs whose change can affect the TUI |
| `acp-e2e` | PRs whose change can affect ACP, and every merge queue run |
| `mcp-conformance` | PRs whose change can affect the MCP client |
| `acp-wire-tripwire` | every PR |
| `documents-cross-os` | every PR, on macOS and Windows |

The `changes` job decides which suites a PR needs. The rules are in
`scripts/ci/changes.js`, with tests beside it. Docs-only changes skip all
three e2e suites. In the merge queue and in manual runs the `changes` job
does not filter, but `tui-e2e` and `mcp-conformance` still skip the merge
queue.

A suite result in the merge queue blocks nothing. The queue merges once
`master-checks` passes, so an `acp-e2e` failure there shows only in the
Actions tab.

## Where to change what

`ci.yml` says what runs and when. How a suite runs lives next to the suite,
so most suite changes do not touch `ci.yml`.

| To change | Edit |
|---|---|
| A test | the test file. CI picks up new files by itself |
| How a suite runs its files | its config or script, and its `test:e2e:<suite>:ci` script in `package.json` |
| When a suite runs | `scripts/ci/changes.js` |
| Shard count, timeout, logs to keep | the suite's block in `ci.yml` |
| Setup for every suite | `.github/workflows/_test-suite.yml` or `.github/actions/setup` |
| What blocks a merge | `needs` of `master-checks` |

The `test:e2e:<suite>:ci` scripts run the suite against a binary that is
already built, the way CI does. They set `KIMCHI_PROXY_HELPER`, because
kimchi does not look for proxy-helper in the repo's `bin/` folder. To run
one locally, build both first, then run the script:

```bash
pnpm run build:binary
make -C tools/proxy-helper copy-for-dev   # puts proxy-helper in bin/
pnpm run test:e2e:tui:ci --shard 2/6
```

## Adding a test suite

Add a `test:e2e:<suite>:ci` script to `package.json`. Then call it from
`ci.yml` through the reusable workflow `.github/workflows/_test-suite.yml`.
That workflow checks out the repo, sets up the tools, optionally downloads
the build, runs the command and uploads logs when the command fails.

```yaml
my-suite:
  needs: build
  uses: ./.github/workflows/_test-suite.yml
  with:
    name: my-suite
    use-build: true           # download dist/ and bin/proxy-helper
    shards: "[1, 2]"          # optional, one job per entry
    command: pnpm run test:e2e:my-suite:ci --shard="$SHARD_INDEX/$SHARD_TOTAL"
    failure-artifacts: "*.my-suite.log"
```

The command gets `$SHARD_INDEX` and `$SHARD_TOTAL`. Each suite decides how
to split its files.

## TUI shards and timings

TUI files take from a few seconds to several minutes each. A split by file
count puts several slow files in one shard, and that shard decides when the
job ends. So `scripts/run-tui-e2e.js --shard k/N` splits by measured time:

1. It reads the seconds per file from `tests/e2e/tui/timings.json`. A file
   with no timing counts as the median.
2. It gives each file, slowest first, to the shard with the least work so
   far (`scripts/tui-e2e/shards.js`).

Every shard computes the same plan, so each file runs in exactly one shard.

### Refreshing the timings

Each TUI shard uploads its measured times as a `tui-e2e-report-*` artifact,
kept for 7 days. To update `timings.json` from CI:

```bash
pnpm run test:e2e:tui:timings
```

This needs the GitHub CLI (`gh auth login`). It takes the latest finished CI
run that has TUI reports, merges the times, and prints how many files
changed. Then commit `tests/e2e/tui/timings.json`, in any PR.

To use a given run, pass its ID: `pnpm run test:e2e:tui:timings 45685439335`.
You can also pass a folder with reports that you downloaded before.

**When:** when a shard log shows the warning "The TUI timings are out of
date". It appears when a shard runs more than 1.5 times its planned time and
at least one minute longer. A shard with failing tests can also show it,
because failures often wait for timeouts. Old timings never skip a file or
run it twice. They only make the shards less even.
