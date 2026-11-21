# Pi upgrade trigger

A daily job (`.github/workflows/pi-upgrade.yml`) that tells us **when** to upgrade the Pi stack
(`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-codemode`) and **how hard** it will be.
It never upgrades anything: no branch, no PR, no change to `patches/`.

The report goes to the job summary and to one rolling GitHub issue labelled `pi-upgrade`.

## When a version counts as ready

Baseline = the `pi-coding-agent` version pinned in `package.json` on `master`.

A version is **settled** once **2 days** passed with no newer release (first releases often get a
quick fix release; Pi has historically shipped those within hours to a day). The target is the
newest settled version newer than the baseline. A version that settled still counts while a newer
burst of releases is in flight.

The report is always cumulative: baseline → target. Skipping 1.4 and upgrading straight to 1.5 loses
nothing.

## What the report measures

Deterministic steps (no AI):

| Step | What it checks |
| --- | --- |
| `settle` | npm publish times → target version, how far behind we are |
| `fetch` | downloads and extracts every Pi package for each version in the range |
| `dry-run` | every hunk of every Pi patch in `patches/` against the target: clean, rebase (context drift), conflict, file gone |
| `internals` | private upstream members our runtime patches hook (`scripts/pi-upgrade/hooks.ts`) and files we overwrite: identical / changed / missing |
| `tests` | typecheck, unit, binary, smoke, TUI, ACP, MCP suites on the target **and** on `master`; only new failures count. Patches that do not apply strictly are left out of the target install and listed |

Then `analyze` runs the kimchi-workflows workflow `scripts/pi-upgrade/pi-upgrade.workflow.ts`
headless. It digests each upstream release once (cached in the issue) and writes the impact:
breaking and silent behaviour changes, upstream features to keep **disabled** in the first upgrade PR
(e.g. built-in MCP vs our adapter), patch rework, free wins, and triage of each failing test. Every
finding must cite evidence; findings without it are dropped.

`render` turns all of it into markdown; `publish` updates the issue.

## The rolling issue

| Situation | What the job does |
| --- | --- |
| No issue yet, target settled | opens one |
| Same target, nothing changed, report < 7 days old | nothing |
| Patches / hooked files changed, or report ≥ 7 days old | rewrites the body (no notification) |
| Target moved | rewrites the body, comments "Target moved X → Y" |
| Someone closed it | treated as "skip this target": quiet until a newer target settles, then the same issue is reopened |
| Baseline is the latest version | closes it ("Up to date") |

State (cached digests, last run) lives in a bot comment on the issue. Delete that comment to force a
full re-analysis.

A run that fails part-way still publishes what it has (e.g. "install failed", "analysis unavailable")
and does not record its inputs, so the next day retries.

## Running locally

Every step is a command; steps exchange JSON files in an output dir
(default `.kimchi/pi-upgrade/<target or latest>/`), so any step can be re-run alone.

```bash
pnpm pi-upgrade settle                          # is anything ready?
pnpm pi-upgrade fetch     --target 1.4.0
pnpm pi-upgrade dry-run   --target 1.4.0
pnpm pi-upgrade internals --target 1.4.0
pnpm pi-upgrade tests     --target 1.4.0 --suites typecheck   # default locally: typecheck,unit
pnpm pi-upgrade analyze   --target 1.4.0        # uses your kimchi login
pnpm pi-upgrade render    --target 1.4.0        # → report.md
pnpm pi-upgrade publish   --target 1.4.0        # prints the planned issue action only

pnpm pi-upgrade all --target 1.4.0              # whole pipeline
```

Nothing touches GitHub without `--publish`, and a forced `--target` run never edits the issue even
with it. `--state <file>` reads issue state from a file instead of GitHub.

**Replaying an old upgrade** to judge report quality: check out the commit before the upgrade in a
separate worktree, install there, then point the tool at it:

```bash
git worktree add /tmp/pre-upgrade <commit> && (cd /tmp/pre-upgrade && pnpm install)
pnpm pi-upgrade all --repo /tmp/pre-upgrade --target 0.85.1 --suites typecheck
```

## Maintaining it

- **New runtime patch on a private Pi member?** Add it to `scripts/pi-upgrade/hooks.ts`
  (a test checks every entry is still referenced by its file).
- **The workflow file must pass kimchi-workflows' strict TypeScript check** (mirrored in
  `scripts/pi-upgrade/tsconfig.workflow.json`, run by `pnpm run test:pi-upgrade`). A violation makes
  headless `/workflow run` silently do nothing; `analyze` then reports the loader error.
- **Another destination (Slack, Jira)**: add a publisher next to `executePublish` in
  `scripts/pi-upgrade/publish.ts`; it receives the same rendered report and planned action.
