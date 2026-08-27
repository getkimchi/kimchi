# Terminal-Bench Baselines

Frozen anchors for the token-optimization initiative. See
`benchmark/manual/baselines/README.md` for the shared anchor policy and
`.kimchi/plans/token-optimization.md` for the initiative plan (git-ignored).

## Anchors

- `baseline-2026-08-tokopt-1.json` — first instrumented full-dataset run
  (terminal-bench/terminal-bench-2-1, 89 tasks, single trial per task, model
  `kimchi-dev/kimi-k2.7`). Generated 2026-08-27 from CI artifacts of the
  `feat/token-optimization-phase0` branch via
  `scripts/aggregate-baseline.py`. This is the reference every candidate change
  is compared against — frozen, never regenerated.

### Headline numbers (anchor 2026-08-tokopt-1)

- Reward mean: **0.7303** (65/89 pass)
- Total tokens: 188.5M input / 1.77M output / 183.2M cache-read
- Static surface at task start (from `context_assembly` entries): system prompt
  ~11.4k est tokens, tool surface ~11.2k est tokens — the two biggest targets
  for Phase 1 static-surface work.
- All 89 trials carry `cache_summary` + `context_assembly` journal entries.

## Regenerating a candidate comparison

```sh
# Sanity check (full-dataset runs cost real compute; prefer -i/-l subsets first)
python3 scripts/aggregate-baseline.py jobs/ > /tmp/candidate.json
```

Compare a candidate against the anchor with task-level paired stats
(`benchmark/manual/compare-sessions.py` shows the same reporting philosophy at a
smaller scale): per-task token/reward deltas, Wilson lower bound on win rate,
and category slicing. A pipeline-ready pair comparator is Phase 2 tooling.

`aggregate-baseline.py` accepts any jobs dir layout with `chunk-*/<task>__<trial>/`
children (config.json + result.json + agent/sessions/*.jsonl per trial).
