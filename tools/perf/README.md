# Perf gate

A CI gate against resource regressions of the built binary. It failed to
exist three times over: idle CPU scaling (v1.10), large-session resume cost
(v1.11), tripled disk writes (v1.22) — all shipped unnoticed.

Runs on Linux arm64 (one-SoC pool, exact hardware counters, and it measures
the linux-arm64 binary kimchi ships). The sampler keeps a macOS backend for
local development runs; CI never uses it, because macOS VMs cannot report
the counters the gate exists to measure.

## What it measures

Kernel-exact counters for the whole kimchi process tree. The measured
binary runs in a fresh cgroup v2, so counting is accounting, not sampling:
short-lived children (git pollers, the tar+gzip archiver in the reporting
pass) live 10–100 ms and any polling sampler misses them
nondeterministically — the cgroup never misses. Wall clock is never gated,
with the one deliberate exception of keystroke echo latency, gated as a
coarse absolute detector (below).

Three scenarios, one per shipped regression class:

| scenario | fixture | gated metrics | catches |
|---|---|---|---|
| `session` | clean HOME, 2-turn TUI session with tools | work units, MB written, peak MB | per-turn blowups, write churn (v1.22) |
| `resume` | 31 MB session, 12+ compactions, `--continue` | load/turn work units, peak MB | pre-compaction render cost (v1.11) |
| `idle` | aged synthetic install (ledger + stuck reporting queue), 90 s idle | steady-state work units, MB read, peak helper concurrency, keystroke p95 | background work scaling with data (v1.10) |

The fake LLM server (`fakellm.py`) answers chat deterministically and
rejects pr-cost snapshot uploads with HTTP 413 — the body-limit real
deployments enforce — so the reporting queue stays in its retry regime and
its per-pass cost stays measurable.

## Metrics and thresholds

Each scenario's records are reduced to a median over its reps (max for the
discrete/absolute metrics) and compared against `budgets.json`; any metric
over budget fails the run.

**Work units are tiered**: instructions retired, else cycles, else CPU
milliseconds — in that order of preference. On the CI runner the tier is
cgroup instructions: the workflow lowers `kernel.perf_event_paranoid` to
0 (the runners block perf by policy; per-CPU cgroup counters are classed
as CPU monitoring, which requires <= 0) and the sampler attaches an
instruction/cycle pair per online CPU to the run's cgroup — the summed
counters are the exact whole-tree total, children included. On this
kernel unprivileged cgroup attach requires a specific CPU (cpu=-1 is
EINVAL); the per-CPU fan-out is why. Every run records which tier it
measured; the budgets record the tier they were calibrated on, and a run
whose tier differs fails the gate — sampled CPU time must never be
silently compared against exact instruction budgets.

Counter sources: instructions/cycles via `perf_event_open` in cgroup
mode (the raw syscall; glibc has no wrapper), bytes via `/proc/<pid>/io`
of the root process (`rchar`/`wchar` — syscall-level, independent of
page cache and I/O scheduling; descendant byte traffic is represented by
the exact child *work* counters instead), peak memory via the cgroup's
`memory.peak`, peak helper concurrency via `pids.peak`; the macOS dev
backend reads per-process `proc_pid_rusage` and is sampling-tier. A work
metric that reads exactly zero fails the run (a dead counter is never a
pass). The idle scenario skips its first bucket (it mixes startup with
the first background pass and would dilute per-pass regressions).

**Thresholds are calibrated, not chosen**: `pnpm run perf:budgets` sets
each limit to `median x headroom` (byte/work counters), `max + 2`
(`pids.peak`: exact discrete counts — a ratio on small integers would be
noise-shaped), or a constant (`keylat max`, below). The historical
regressions were 1.5–9x — far above the headrooms. The workflow can
regenerate budgets on its actual runner via a calibrate dispatch; never
hand-edit a failing limit away.

**Keystroke echo latency** is the one wall-clock metric: during the idle
window the harness types a character, times the first PTY bytes back (its
echo), and erases it. Wall clock can never be 100% deterministic, so it
is gated as a coarse absolute blocker detector: p95 under 100 ms (p95,
not max — a VM pause can stall one probe; it cannot lift 95% of them).
Normal p95 is ~4 ms and the historical regressions stalled every
keystroke at 0.9–1.9 s, so the threshold sits 25x above noise and 9x
below a real regression — pass/fail is decided by orders of magnitude,
never scheduling jitter. p50/max stay advisory.

**The gate fails closed**: a metric missing from `budgets.json`, a scenario
with no completed records, any failed rep (a crash cannot hide behind a
green median of the surviving reps), a zero-reading counter, a
work-counter tier different from the budgets' calibration tier, or a
binary whose self-reported version differs from what CI built
(`--expect-version`) all fail the run. Unknown budget keys warn (rename drift in the other
direction); PR-controlled strings are sanitized before they reach the CI
step summary.

The current limits live in [budgets.json](budgets.json); its `_meta`
records the arch/commit/runner/counter tier they were calibrated on.

## Usage

```sh
pnpm run build:binary
pnpm run perf:gate          # run all scenarios, compare medians to budgets
pnpm run perf:budgets       # regenerate tools/perf/budgets.json
pnpm run perf:selfcheck     # harness self-test: fixtures, validators, scenarios
```

Run the selfcheck whenever you touch `fixtures.py`, `fakellm.py`,
`sampler.py` or `scenarios.py`: it regenerates every fixture twice and
asserts byte-identical output, runs the product's own validators over the
aged fixture (`tools/perf/validate-fixture.ts`, needs bun), smoke-runs all
three scenarios, and asserts the aged reporting queue actually engaged
(its state file is rewritten when the 413-rejected pass applies backoff).
The CI workflow runs it as its first step, before the timed scenarios.

Pass `--expect-version` (the workflow passes the built tree's package.json
version) to refuse measuring a binary whose self-reported version differs
— a stale re-exec presents a consistent version, so only an external
reference catches it.

Run one scenario by hand (results land in the given JSONL):

```sh
python3 tools/perf/scenarios.py --binary dist/bin/kimchi --scenario idle \
    --out runs.jsonl --reps 1 --idle 70
```

Classify recorded runs without re-running:

```sh
python3 tools/perf/gate.py --dry-run --runs runs.jsonl
```

## Budgets

`budgets.json` holds one limit per metric from a calibration run on one
runner class, each with a `budget_note`. Headroom and the fail-closed
rules are described under [Metrics and thresholds](#metrics-and-thresholds).
Budget changes are explicit, reviewable commits — never hand-edit a failing
limit away. If the number legitimately moved (schema change, runtime bump,
deliberate feature cost, runner-class migration), regenerate via
`pnpm run perf:budgets` (or the workflow's calibrate dispatch) and put the
reason in the commit message.

Budgets are architecture- and runner-class-specific: the workflow pins the
Linux arm64 runner label, and `budgets.json` records the calibration
context (arch, commit, runner, counter tier). A different runner class
needs its own budget set; the macOS backend is for local runs only.

## Fixtures

`fixtures.py` generates everything deterministically (seeded UUIDs, fixed
epoch): the multi-compaction session, small git repositories, and an aged
HOME — a synthetic ledger whose `work_records`, `costs` notes and frozen
snapshot queues match the recorded shapes of a long-lived real install at
CI scale (~18 MB ledger, ~1.4 MB reporting state). No real user data is
copied; when the underlying schemas change
(`src/extensions/pr-cost-reporting/ledger/schema.ts`, `queue.ts`
`ReportingState`, `snapshot.ts` `SnapshotContent`), regenerate and review.

`SCHEMA_VERSION` in `fixtures.py` must track the store's: a mismatch makes
kimchi refuse to open the ledger, which fails the gate loudly — update the
transcription in the same PR that bumps the schema.

## Detection proof

Each detector was proven against the regression it exists for, by
calibrating budgets on the pre-regression binary and gating the
post-regression one (or, for the idle detector, a code-level fault):

| detector | calibration | measured against | result |
|---|---|---|---|
| resume | v1.10.1 | v1.11.0 | FAIL: load 7.9x, turn 9.9x over budget |
| session writes | v1.21.6 | v1.22.5 | FAIL: disk_w 1.08x over budget (1.53x over median) |
| idle | master | master + reconcile tick 30s→10s | FAIL: instr 1.82x, reads 1.20x over budget |

A clean run of the same gate passes at ratio 0.65-0.78.

## Python

Stdlib only, Python 3.9+. No installs. The Linux backend uses
passwordless `sudo` to create its accounting cgroup (and the workflow for
the perf sysctl); without it, runs degrade to the sampling tier — fine
for local development, refused by the CI gate's tier check.
