# deep-swe

Run [DeepSWE](https://deepswe.datacurve.ai/) against kimchi via [Pier](https://github.com/datacurve-ai/pier).

DeepSWE is a long-horizon software engineering benchmark by Datacurve: 113 original tasks across 91 active open-source repositories in 5 languages (TypeScript, Go, Python, JavaScript, Rust). Tasks are written from scratch (contamination-free), with short prompts requiring large solutions (avg 668 lines of code). Verifiers test observable behavior, not implementation details.

This package uses Pier (a Harbor fork) instead of Harbor because DeepSWE v1.1 tasks require:
- **`pre_artifacts.sh`** — captures the agent's work as a git diff patch for separate verifier grading
- **Air-gapped network allowlists** — tasks set `allow_internet = false`; Pier provides per-agent network allowlists so the kimchi binary (running inside the container) can still reach `llm.kimchi.dev`

The Harbor project, `kimchi_agent` package, and Python dependencies live in `benchmark/terminal-bench-2/` and are shared. No separate `pyproject.toml` is needed.

## Prereqs

- Docker running locally
- `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- `pnpm` — only if you use `./scripts/run-local.sh` (it cross-builds the Linux binary from the working tree)
- `KIMCHI_API_KEY` exported on the host

### Apple Silicon

DeepSWE task Docker images are linux/amd64. The same Rosetta/QEMU caveats from terminal-bench-2 apply — do not trust reward numbers from local Apple Silicon runs. Use real x86_64 hardware for trusted results.

## Ways to run

| Script | Binary source |
| --- | --- |
| `./scripts/run-local.sh` | Cross-builds `kimchi` for linux-amd64 from the current working tree (`pnpm run build:binary-linux-x64`) |
| `./scripts/run-release.sh` | Downloads the latest release from `castai/kimchi` |

Both scripts clone the DeepSWE task repository from GitHub and run via Pier (`pier run -p /tmp/deep-swe/tasks`). Extra arguments are forwarded to `pier run`.

## Running a single task

```bash
export KIMCHI_API_KEY=...
./scripts/run-release.sh -i fastapi-deprecation-response-headers
```

## Running the full dataset

```bash
./scripts/run-release.sh -n 8
```

`-n 8` runs eight trials in parallel. DeepSWE has 113 tasks with 90-minute agent timeouts — a full run at parallelism=8 takes roughly 22 hours.

## Picking a model

```bash
MODEL=kimchi-dev/kimi-k2.7 ./scripts/run-release.sh -n 8
```

`MODEL` must be `<provider>/<id>`. Default is `kimchi-dev/minimax-m3`.

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `KIMCHI_API_KEY` | yes | Bearer token for `llm.kimchi.dev`; forwarded to the agent via `--ae` |
| `KIMCHI_CODE_BINARY` | no | Host path to a prebuilt Linux `kimchi` binary. Set by `run-local.sh` |
| `MODEL` | no | Default `kimchi-dev/minimax-m3` |
| `DEEP_SWE_REPO` | no | Git URL for DeepSWE tasks (default: `https://github.com/datacurve-ai/deep-swe`) |
| `DEEP_SWE_PATH` | no | Path to tasks directory after clone (default: `/tmp/deep-swe/tasks`) |
| `JOBS_DIR` | no | Default `benchmark/deep-swe/jobs` |

## Results

`benchmark/deep-swe/jobs/<timestamp>/<task>__<trial_id>/` — each trial directory contains `trial.log`, `result.json` (with `verifier_result.rewards.reward`), and `config.json`. Session files in `agent/sessions/*.jsonl`.

## Pier vs Harbor

DeepSWE v1.1 tasks use Harbor's task format (`task.toml`, `instruction.md`, `tests/`) but require Pier for execution. Pier is a Harbor fork that adds:
- `pre_artifacts.sh` support (patch extraction for separate verifier grading)
- Per-agent network allowlists for air-gapped tasks

The same `result.json` schema is produced, so classify, summarize, and GCS upload pipelines are shared with terminal-bench-2 and SWE-bench Pro.

The `USE_PIER=true` env var in `chunk_runner.py` selects Pier over Harbor. All other benchmarks default to Harbor (`USE_PIER=false`).
