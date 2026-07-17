# swe-bench-pro

Run [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) against kimchi.

SWE-bench Pro is a challenging multi-language software engineering benchmark by Scale AI: 731 public instances across 11 open-source repositories (Python, JavaScript/TypeScript, Go). Given a codebase and an issue, the agent must produce a patch that passes hidden tests. Frontier models score ~25%.

This package reuses the Harbor `swebenchpro` adapter (v1.0, 731 tasks) and the same `kimchi_agent:Kimchi` Harbor agent as terminal-bench-2. The Harbor project, `kimchi_agent` package, and Python dependencies live in `benchmark/terminal-bench-2/` and are shared — no separate `pyproject.toml` is needed.

## Prereqs

- Docker running locally
- `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- `pnpm` — only if you use `./scripts/run-local.sh` (it cross-builds the Linux binary from the working tree)
- `KIMCHI_API_KEY` exported on the host

### Apple Silicon

SWE-bench Pro Docker images (`jefzda/sweap-images`) are linux/amd64 only. The same Rosetta/QEMU caveats from terminal-bench-2 apply — do not trust reward numbers from local Apple Silicon runs. Use real x86_64 hardware for trusted results.

## Ways to run

| Script | Binary source |
| --- | --- |
| `./scripts/run-local.sh` | Cross-builds `kimchi` for linux-amd64 from the current working tree (`pnpm run build:binary-linux-x64`) |
| `./scripts/run-release.sh` | Downloads the latest release from `castai/kimchi` |
| `./scripts/run-opencode-kimchi.sh` | Installs OpenCode in the task container and configures it to use the Kimchi gateway |
| `./scripts/run-claude-code-kimchi.sh` | Installs Claude Code in the task container and configures it to use the Kimchi gateway |
| `./scripts/run-gsd-kimchi.sh` | Installs GSD in the task container and configures it to use one selected Kimchi model |

All scripts target the `swebenchpro` dataset by default. Extra arguments are forwarded to `harbor run`.

## Running a single instance

```bash
export KIMCHI_API_KEY=...
./scripts/run-release.sh -i instance_ansible__ansible-cd473dfb2fdbc97acf3293c134b21cbbcfa89ec3
```

## Running the full dataset

```bash
./scripts/run-release.sh -n 8
```

`-n 8` runs eight trials in parallel. Aggregated results land in `benchmark/swe-bench-pro/jobs/<timestamp>/result.json`.

SWE-bench Pro has 731 instances — a full run at parallelism=8 with ~15 min average per instance takes roughly 23 hours. Use `--timeout-multiplier` to scale per-task timeouts if needed.

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
| `DATASET` | no | Default `swebenchpro` |
| `JOBS_DIR` | no | Default `benchmark/swe-bench-pro/jobs` |

## Results

`benchmark/swe-bench-pro/jobs/<timestamp>/<task>__<trial_id>/` — each trial directory contains `trial.log`, `result.json` (with `reward`), and `config.json`. Session files in `agent/sessions/*.jsonl`.
