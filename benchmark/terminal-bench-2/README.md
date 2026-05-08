# terminal-bench-2

Run [terminal-bench](https://www.harborframework.com/) against kimchi.

The package ships a single harbor agent, `kimchi_agent:Kimchi`, that installs the `kimchi` binary inside each task container and runs it non-interactively (`--print --mode json --no-session`). Token and cost counters are parsed from the JSONL output and fed back into harbor's trial context.

## Prereqs

- Docker running locally
- `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- `pnpm` — only if you use `./scripts/run-local.sh` (it cross-builds the Linux binary from the working tree)
- `KIMCHI_API_KEY` exported on the host — kimchi routes every request through `https://llm.kimchi.dev/openai/v1`; no provider-specific keys are needed

### Apple Silicon (M-series Macs) — read before iterating locally

Terminal-bench task images are amd64-only. On Apple Silicon, Docker Desktop runs them under translation (Rosetta or QEMU), and **neither emulator covers the full x86 ISA**. This is a known Docker Desktop / QEMU limitation, not a bug in this repo — see e.g. [docker/for-mac#7172](https://github.com/docker/for-mac/issues/7172), [#5123](https://github.com/docker/for-mac/issues/5123), [#5883](https://github.com/docker/for-mac/issues/5883).

You will hit one of two failure modes:

| Emulator | Symptom | Cause |
| --- | --- | --- |
| **Rosetta** (Docker Desktop default) | Agent crashes with `Illegal instruction` (exit 132) | Bun runtime uses an instruction Rosetta can't translate |
| **QEMU** (Rosetta disabled) | Agent runs end-to-end, **but the verifier may segfault**: `qemu: uncaught target signal 11 (Segmentation fault) - core dumped`. Reward gets force-written to `0` even when the agent solved the task | `uv`/python/pytest hits an instruction QEMU can't translate (often jemalloc-related) |

**To switch emulator:** Docker Desktop → Settings → General → toggle **"Use Rosetta for x86_64/amd64 emulation on Apple Silicon"**, Apply & Restart.

**What this means in practice:**

- **Apple Silicon is fine for harness/agent iteration** — verifying the install path, the message-parsing extension, prompt enrichment, etc. The agent will run and you can read its tool calls and final reasoning out of `agent/kimchi.txt`.
- **Do not trust reward numbers from local Apple Silicon runs.** A `0.0` may be the verifier crashing under emulation, not the model failing. Compare your numbers against published terminal-bench results only after running on real x86_64.
- **For trusted reward numbers, run on real Linux x86_64 hardware** — a CI runner (GitHub Actions `ubuntu-latest`, etc.).

## Two ways to run

| Script | Binary source |
| --- | --- |
| `./scripts/run-local.sh` | Cross-builds `kimchi` for linux-amd64 from the current working tree (`pnpm run build:binary-linux-x64`) |
| `./scripts/run-release.sh` | Downloads the latest release from `castai/kimchi` |

Both scripts target the `terminal-bench/terminal-bench-2` dataset. Extra arguments are forwarded to `harbor run`, so everything below works for either script.

### Running a task

```bash
export KIMCHI_API_KEY=...
./scripts/run-local.sh -i terminal-bench/fix-git
```

### Running the full dataset

Drop `-i` to run all 89 tasks in `terminal-bench/terminal-bench-2`:

```bash
./scripts/run-local.sh -n 8
```

`-n 8` runs eight trials in parallel (default is 4). Aggregated results land in `jobs/<timestamp>/result.json`.

Each task declares its own per-attempt timeouts in `task.toml` (typically 10-15 min agent + 10-15 min verifier — `fix-git` is 15+15). Harbor enforces these, so a stuck agent doesn't block the run. Worst-case math for the full dataset at default timeouts: roughly 12 hours at `-n 4`, ~6 hours at `-n 8`. To shorten the worst case, scale all per-task timeouts down with `--timeout-multiplier`:

```bash
./scripts/run-local.sh -n 8 --timeout-multiplier 0.5    # halve all task timeouts
```

`-i` accepts glob patterns and `-x` excludes; `-l N` caps total tasks; `-k N` is attempts per trial.

```bash
./scripts/run-local.sh -i 'terminal-bench/build-*'   # run only build-* tasks
./scripts/run-local.sh -x 'terminal-bench/build-*'   # everything except build-*
./scripts/run-local.sh -l 5                          # first 5 tasks only
./scripts/run-local.sh -i terminal-bench/fix-git -k 3   # 3 attempts of one task
```

### Picking a model

```bash
MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-local.sh -i terminal-bench/fix-git
```

`MODEL` must be `<provider>/<id>`. Available `kimchi-dev` models include `kimi-k2.5`, `glm-5-fp8`, `minimax-m2.7`, `nemotron-3-super-fp4` (run `kimchi --list-models` for the live list). The qualifier is required because kimchi's built-in catalog also registers some IDs (notably `kimi-k2.5`) under the `opencode` provider — without `kimchi-dev/` the resolver picks `opencode` and fails auth with the kimchi key.

### Single-model run (no orchestration)

To benchmark a model on its own, bypassing kimchi's multi-model orchestration, pass `disable-multi-model=true`. The agent forwards `--multi-model=false` to kimchi.

```bash
MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-local.sh -n 8 --agent-kwarg disable-multi-model=true
```

The kwarg is named `disable-multi-model` (not `multi-model=false`) because harbor's `parse_kwargs` JSON-decodes `false` into Python `bool`, which the `str`/`enum` `CliFlag` coercers reject — and `bool`-typed flags only emit when truthy, so they can't render `--multi-model=false` directly.

### Tagging runs for tracking

kimchi attaches tags from `KIMCHI_TAGS` to every outgoing LLM request payload and telemetry event, which lets you slice usage/tokens/cost server-side by run, experiment, or branch.

The agent auto-injects `run:<timestamp>`, `task:<task_id>`, and `trial:<task_id>__<suffix>` derived from the trial directory layout (`jobs/<timestamp>/<task>__<trial>/`). You don't need to set these yourself — they're correct across globs (`-i 'terminal-bench/build-*'`), full-dataset runs, and parallel attempts (`-k N`, `-n N`).

To add custom tags, forward `KIMCHI_TAGS` with `--ae`:

```bash
./scripts/run-local.sh \
  -i terminal-bench/fix-git \
  --ae "KIMCHI_TAGS=bench:terminal-bench-2,experiment:baseline"
```

User-supplied values win on key collision: passing `--ae KIMCHI_TAGS=task:custom` overrides the auto-injected `task:<task_id>`.

Tag format is `key:value`, comma-separated; keys and values are alphanumeric plus `.`, `_`, `-`, max 64 chars each side. Invalid tags are dropped silently. Per-trial token/cost totals also land in `jobs/<timestamp>/<task>__<trial_id>/result.json` regardless of tags, so for local-only aggregation you can just group result files by the `KIMCHI_TAGS` value you ran them with.

`--ae` is the only mechanism for forwarding extra env: the agent passes an explicit env dict to the container and only `KIMCHI_API_KEY` is forwarded from the host by default. Harbor merges `--ae` values on top of that dict (`harbor/agents/installed/base.py` `_exec`).

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `KIMCHI_API_KEY` | yes | Bearer token for `llm.kimchi.dev`; forwarded to the agent via `--ae` |
| `KIMCHI_CODE_BINARY` | no | Host path to a prebuilt Linux `kimchi` binary (produced by `pnpm run build:binary-linux-x64` at `dist/bin/kimchi`). The agent uploads the binary's grandparent directory (the build/tarball root containing `bin/` + `share/kimchi/`), so the auxiliary files travel with it. When set, the agent skips the GitHub release download. `./scripts/run-local.sh` sets this for you. |
| `GITHUB_TOKEN` | no | Raises GitHub API rate limits when fetching the latest release. Not required for public repos |
| `MODEL` | no | Default `kimchi-dev/kimi-k2.5`. See "Picking a model" for the `<provider>/<id>` requirement |

## Results

`benchmark/terminal-bench-2/jobs/<timestamp>/<task>__<trial_id>/` — each trial directory contains `trial.log`, `result.json` (with `reward`), and `config.json`. The raw kimchi JSONL stream is in `agent/kimchi.txt`. Resumable session files (parent + each subagent, linked via `parentSession`) are in `agent/sessions/*.jsonl`; replay any of them with `kimchi --session <path>`.

## Troubleshooting

**`Illegal instruction` / exit 132** — Apple Silicon + Docker Desktop Rosetta emulating amd64 task images. See "Apple Silicon" under Prereqs.

**`qemu: uncaught target signal 11 (Segmentation fault)` in `verifier/test-stdout.txt`, reward forced to 0** — Apple Silicon + QEMU emulation. The agent's reward isn't real; re-run on x86_64 hardware. See "Apple Silicon" under Prereqs.

**`Unsupported container arch (ELF e_machine=...)`** — the task container's userland is neither amd64 nor arm64. Only those two are released; nothing to do at the bench layer.

**`sha256 mismatch for kimchi_linux_*.tar.gz`** — cached tarball at `~/.cache/kimchi-bench/releases/<tag>/` is corrupt or the release was replaced. `rm -rf` that tag's directory and retry.

**`KIMCHI_API_KEY is required`** — env var didn't reach the container. Set it on the host before invoking the script; both scripts forward it via `--ae`.

**`harbor: command not found`** — run via `uv run`; both scripts already do.
