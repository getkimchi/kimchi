# Ferment Terminal-Bench Analysis

Use this as the stable map for analyzing terminal-bench runs that use
`--agent-kwarg ferment-oneshot=true`. Keep run-specific analysis under
`benchmark/terminal-bench-2/analysis/` so this file stays reusable.

## Quick Workflow

1. Summarize the run:

   ```bash
   benchmark/terminal-bench-2/scripts/analyze-ferment-bench.py run benchmark/terminal-bench-2/jobs/<run>
   ```

2. Generate reusable per-trial evidence reports when a task needs deeper inspection:

   ```bash
   benchmark/terminal-bench-2/scripts/analyze-ferment-bench.py trial --run benchmark/terminal-bench-2/jobs/<run> <task-or-trial> --cache
   ```

   Cached reports are written under `benchmark/terminal-bench-2/analysis/terminal-bench-trials/<run>/`. They summarize verifier grade, reward, exceptions, ferment lifecycle, phase/step timings, session/subagent timings, models, token counts, LLM rounds, worker-output cross-checks, and detected failure signals.

3. Compare repeated attempts for a task, or compare the same task across runs:

   ```bash
   benchmark/terminal-bench-2/scripts/analyze-ferment-bench.py compare --run benchmark/terminal-bench-2/jobs/<run> <task>
   benchmark/terminal-bench-2/scripts/analyze-ferment-bench.py compare --runs benchmark/terminal-bench-2/jobs/<run-a> benchmark/terminal-bench-2/jobs/<run-b> <task>
   ```

4. Inspect high-signal mismatches first:

   - `complete` ferment with reward `0`: ferment finalized, verifier rejected it.
   - non-`complete` ferment with reward `1`: benchmark passed even though ferment did
     not finalize.
   - missing verifier reward: verifier or agent timeout prevented a normal score.
   - `draft`, `planned`, `paused`, or long-lived `running`: planner stalled or was
     interrupted before the expected lifecycle finished.

5. If the script output is not enough, open the trial directory and compare these files:

   - `result.json`: reward, exception, agent timing, token counts.
   - `trial.log`: Harbor setup and command transcript.
   - `exception.txt`: timeout or nonzero trace when present.
   - `verifier/reward.txt`: scalar reward written by terminal-bench.
   - `verifier/test-stdout.txt`: verifier output and test failures.
   - `verifier/ctrf.json`: structured verifier test report.
   - `agent/sessions/main.jsonl`: planner conversation and tool calls.
   - `agent/sessions/agent-outputs/.../*.output`: worker outputs.
   - `agent/ferments/<uuid>.json`: final ferment snapshot.
   - `agent/ferments/<uuid>.events.jsonl`: append-only ferment event timeline.
   - `agent/ferments/<uuid>/runtime.json`: persisted runtime counters, when present.
   - `agent/ferments/<uuid>/reviews/*.json`: phase gate and review evidence.

## Artifact Layout

Terminal-bench writes runs under:

```text
benchmark/terminal-bench-2/jobs/<run>/
  config.json
  result.json
  job.log
  <task>__<trial>/
    config.json
    result.json
    trial.log
    exception.txt
    verifier/
      reward.txt
      test-stdout.txt
      ctrf.json
    agent/
      sessions/
        main.jsonl
        agent-outputs/<session>/tasks/*.output
      ferments/
        <uuid>.json
        <uuid>.events.jsonl
        <uuid>/
          runtime.json
          reviews/*.json
```

Some files are conditional. For example, `exception.txt` exists only on
exceptions, `reward.txt` can be missing after verifier failure, and
`runtime.json` or review sidecars can be absent when the run stops early.

## Code Pointers

- `benchmark/terminal-bench-2/src/kimchi_agent/agent.py` wraps the kimchi
  binary for Harbor. It sets `KIMCHI_FERMENTS_DIR=/logs/agent/ferments` when
  `ferment-oneshot` is enabled, which places ferment artifacts inside each
  trial's `agent/` directory.
- `src/extensions/ferment/events.ts` bootstraps `--ferment-oneshot`, creates
  the ferment, switches it to `exec`, and transforms the first prompt into the
  one-shot nudge.
- `src/extensions/ferment/oneshot.ts` defines the planner instruction envelope
  for autonomous scoping, phase execution, worker delegation, verification, and
  `complete_ferment`.
- `src/extensions/ferment/tools/steps.ts` runs step verification commands and
  records `step_verified`.
- `src/extensions/ferment/tools/phases.ts` validates phase gates, writes review
  evidence, and records `phase_completed`.
- `src/extensions/ferment/tools/lifecycle.ts` scopes and completes the ferment,
  including final gate checks and journey grading.
- `src/extensions/ferment/judge.ts` contains the remaining LLM judge surfaces:
  nonzero step-verification triage and final journey grade.

## Event Timeline

The event log is the fastest way to understand lifecycle progress:

```bash
jq -r '.timestamp + " " + .type' \
  benchmark/terminal-bench-2/jobs/<run>/<trial>/agent/ferments/*.events.jsonl
```

Common events:

- `ferment_created`
- `ferment_mode_set`
- `scoping_goal_set`, `scoping_criteria_set`, `scoping_constraints_set`,
  `scoping_phases_set`
- `ferment_planned`
- `ferment_running`
- `phase_activated`
- `step_started`
- `step_verified`
- `phase_completed`
- `ferment_completed`
- `ferment_graded`
- `ferment_paused`

Approximate timings:

- planning: `ferment_created` to `ferment_planned`
- activation gap: `ferment_planned` to first `phase_activated`
- execution: first `phase_activated` to `ferment_completed`
- timeout/stall point: final event in `<uuid>.events.jsonl`

## Script Commands

The single supported entry point is:

```bash
benchmark/terminal-bench-2/scripts/analyze-ferment-bench.py <command> [args]
```

Commands:

- `run [run]`: aggregate one run; defaults to the latest directory under `benchmark/terminal-bench-2/jobs/`.
- `trial TARGET... --run RUN [--cache|--output-dir DIR]`: print or write self-contained Markdown reports for trial names, task names, or globs. `--cache` writes to `benchmark/terminal-bench-2/analysis/terminal-bench-trials/`.
- `compare TARGET... --run RUN`: print a Markdown comparison table for matching trials in one run.
- `compare TARGET... --runs RUN_A RUN_B ...`: print a cross-run comparison table for matching trials.

Use task names such as `code-from-image` to match all attempts in a run, or full trial names such as `code-from-image__kpp27bD` for one attempt. The `trial` command treats session JSONL files as the primary accounting source for timing, tokens, rounds, and model counts; worker output files are included as cross-check evidence but are not added again to totals.

## Accounting Semantics

The script intentionally separates canonical benchmark fields from derived triage signals:

- Reward, exception type, agent start/end time, and verifier start/end time come from each trial's `result.json`.
- Ferment status, grade, phases, steps, and lifecycle timing come from `agent/ferments/<uuid>.json` plus `agent/ferments/<uuid>.events.jsonl`.
- Session and subagent accounting comes from `agent/sessions/*.jsonl`. Per-session duration is first timestamp to last timestamp in that JSONL file. Session wall span is the earliest session timestamp to the latest session timestamp. Summed session seconds adds each session duration, so it can be greater than wall span when subagents overlap.
- LLM rounds are messages with a `usage` object. Token totals are summed from `usage.input`, `usage.output`, `usage.cacheRead`, and `usage.cacheWrite`. Model counts are counted per usage-bearing message, using message `provider/model` when present and falling back to the current `model_change` entry.
- Worker output files under `agent/sessions/agent-outputs/.../*.output` often mirror subagent session JSONL content. They are useful evidence for cross-checking what a worker reported, but the script does not add them to total seconds, tokens, rounds, or models to avoid double counting.
- Failure signals are regex-based triage labels over verifier/session text. Signal counts are computed independently from displayed excerpts, so `--max-notables` changes report verbosity but not the underlying counts. Treat signals as pointers to evidence, not canonical failure categories. Confirm root causes against verifier failures, session excerpts, and ferment events before drawing conclusions.
- Durations are displayed as integer seconds, rounded down from timestamp differences.

## Reusable jq Snippets

Reward and exception breakdown:

```bash
find benchmark/terminal-bench-2/jobs/<run> -mindepth 2 -maxdepth 2 -name result.json -print0 |
  xargs -0 jq -r '[.verifier_result.rewards.reward // "missing",
                   .exception_info.exception_type // "none"] | @tsv' |
  sort | uniq -c | sort -nr
```

Ferment status counts:

```bash
find benchmark/terminal-bench-2/jobs/<run> -path '*/agent/ferments/*.json' -type f |
  grep -E '/agent/ferments/[^/]+\.json$' |
  xargs jq -r '.status' |
  sort | uniq -c | sort -nr
```

Ferment grade counts:

```bash
find benchmark/terminal-bench-2/jobs/<run> -path '*/agent/ferments/*.json' -type f |
  grep -E '/agent/ferments/[^/]+\.json$' |
  xargs jq -r '.grade.grade // "none"' |
  sort | uniq -c | sort -nr
```

Event type counts:

```bash
find benchmark/terminal-bench-2/jobs/<run> -name '*.events.jsonl' -print0 |
  xargs -0 jq -r '.type' |
  sort | uniq -c | sort -nr
```

Final ferment snapshot for one trial:

```bash
jq '{id,name,status,mode,grade,
     phases: [.phases[] | {id,index,name,status,
       step_count:(.steps|length),
       steps:[.steps[] | {index,description,status,verification,result}]}]}' \
  benchmark/terminal-bench-2/jobs/<run>/<trial>/agent/ferments/*.json
```

## Interpretation Notes

- `result.json` is the benchmark source of truth for reward and exceptions.
- `agent/ferments/<uuid>.json` is the ferment source of truth for planner
  lifecycle state.
- The two can disagree. Treat disagreements as investigation targets, not as
  automatic bugs.
- A completed ferment with reward `0` usually means the planner believed its own
  gates and verification were enough, but terminal-bench tests disagreed.
- A non-complete ferment with reward `1` usually means the task was already
  solved before ferment reached `complete_ferment`, or the agent timed out after
  producing the required artifacts.
- Missing reward usually means verifier output was absent, empty, timed out, or
  the agent timed out before terminal-bench could run normal verification.
- Timeout failures need both `exception.txt` and the final ferment event. The
  exception tells where Harbor stopped the process; the event log tells what the
  ferment was trying to do at that moment.
