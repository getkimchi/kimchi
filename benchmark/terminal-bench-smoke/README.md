# terminal-bench-smoke

Three-task smoke suite for kimchi-code, ported from `benchmark/manual/`. Runs through the same harbor harness as `benchmark/terminal-bench-2/` (reuses its `kimchi_agent` package and venv).

| Task | Graded? | Verifier |
| --- | --- | --- |
| `go-rate-limiter` | yes | builds the agent's server, asserts 11th burst request returns 429, runs `go test ./...` |
| `go-task-api` | yes | builds the agent's server, exercises POST/GET/PATCH/DELETE end-to-end, runs `go test ./...` |
| `go-router-research` | no (trivial) | only asserts `/app/answer.md` exists and is ≥200 bytes — compare runs by session artifacts, not reward |

## Prereqs

Same as `terminal-bench-2/`. See its README for Apple Silicon caveats.

## Usage

```bash
export KIMCHI_API_KEY=...

# Whole dataset (all 3 tasks, default 4 trials in parallel)
./scripts/run-local.sh

# One task by name
./scripts/run-local.sh -i go-rate-limiter

# One task by directory
./scripts/run-local.sh --path tasks/go-task-api

# Run go-task-api in single-model mode, tagged for slicing
./scripts/run-local.sh \
  -i go-task-api \
  --ae KIMCHI_MULTI_MODEL=false \
  --ae KIMCHI_TAGS=mode:single
```

`run-release.sh` is the same but pulls the latest published kimchi-code release instead of cross-building from the working tree.

## How the single-model toggle works

The `kimchi_agent` package translates `KIMCHI_MULTI_MODEL=false` (forwarded via `--ae`) into `--multi-model=false` on the binary invocation. Same task definition, two runs, distinguishable server-side by tags.

## Results

`benchmark/terminal-bench-smoke/jobs/<timestamp>/<task>__<trial>/` — `result.json` for the reward, `agent/kimchi.txt` for the raw JSONL stream, `agent/sessions/*.jsonl` for resumable sessions (parent + each subagent).

For the `go-router-research` task, ignore reward; look at `agent/sessions/main.jsonl` token totals and the presence/absence of subagent session files.
