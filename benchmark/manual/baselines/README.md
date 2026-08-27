# Frozen Baselines

The token-optimization initiative compares every candidate change against a **frozen
baseline anchor**, not just the previous iteration — cumulative drift is the signal
that matters over months (see `.kimchi/plans/token-optimization.md`, Decision Log #6
and Validation ladder).

## The anchor

- `baseline-2026-08-tokopt-1.json`, `baseline-2026-08-tokopt-2.json` — two
  `analysis.json` outputs from identical `benchmark/manual` sessions run at the
  Phase-0 commit (context-assembly + cache-summary instrumentation enabled, no
  behavior changes). Two reps so you can see the benchmark's natural variance; a
  candidate is a *regression* only when it consistently falls outside both.

These files are committed and never regenerated. If the harness changes so much that
the baseline is no longer meaningful, add a **new** numbered anchor
(`baseline-YYYY-MM-<name>-{1,2}.json`) and keep the old one — history stays visible.

## How to compare a candidate

```sh
# Run the same task set on your branch
./benchmark/manual/new-session.sh            # creates sessions/session-NN
./benchmark/manual/sessions/session-NN/run-all.sh

python3 benchmark/manual/analyze-session.py session-NN
python3 benchmark/manual/compare-sessions.py baseline session-NN   # when wiring exists
```

Until task-level A/B tooling lands (Phase 2), compare by eyeing `analysis.json`
against the baseline anchors for: `total_tokens` per run, `cache.cacheReadTokens`
(cache-read ratio), `context.system_prompt_tokens_est`, `context.prefix_changes`.

- Win rate guardrail: a candidate that wins on fewer than half the paired tasks is not
  distinguishable from noise (the Wilson lower bound in `compare-sessions.py` says
  this explicitly for session-vs-session compares).
- Ward against category collapse: totals can improve while one task class regresses —
  check the per-run rows, not just the aggregate.

## What counts as drift

The anchor goes stale by policy, not accident. Regenerate only when: the model
catalog changes materially, the benchmark task prompts change, or the estimator
chars/4 convention changes.
