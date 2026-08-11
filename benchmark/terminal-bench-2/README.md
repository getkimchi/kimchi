# terminal-bench-2

Run [terminal-bench](https://www.harborframework.com/) against kimchi.

The package ships `kimchi_agent:Kimchi` and an opt-in `kimchi_agent:KimchiOpenViking` variant. Both install the `kimchi` binary inside each task container and run it non-interactively (`--print --session /logs/agent/sessions/main.jsonl`). Token and cost counters are parsed from session JSONL files and fed back into harbor's trial context.

The agent starts `kimchi` in its own process group and records the process-group id at `/logs/agent/kimchi-agent.pgid`. If Harbor cancels the agent phase on timeout, the cleanup path terminates that recorded process group before the verifier starts; on normal exit, the pgid file is removed.

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

- **Apple Silicon is fine for harness/agent iteration** — verifying the install path, the message-parsing extension, prompt enrichment, etc. The agent will run and you can read its tool calls and final reasoning out of `agent/sessions/*.jsonl`.
- **Do not trust reward numbers from local Apple Silicon runs.** A `0.0` may be the verifier crashing under emulation, not the model failing. Compare your numbers against published terminal-bench results only after running on real x86_64.
- **For trusted reward numbers, run on real Linux x86_64 hardware** — a CI runner (GitHub Actions `ubuntu-latest`, etc.).

## Ways to run

| Script | Binary source |
| --- | --- |
| `./scripts/run-local.sh` | Cross-builds `kimchi` for linux-amd64 from the current working tree (`pnpm run build:binary-linux-x64`) |
| `./scripts/run-openviking-learning.sh` | Runs sequential Terminal-Bench 2.1 attempts with the official OpenViking Pi extension and verified-result feedback |
| `./scripts/run-release.sh` | Downloads the latest release from `castai/kimchi` |
| `./scripts/run-opencode-kimchi.sh` | Installs OpenCode in the task container and configures it to use the Kimchi gateway |
| `./scripts/run-claude-code-kimchi.sh` | Installs Claude Code in the task container and configures it to use the Kimchi gateway |
| `./scripts/run-gsd-kimchi.sh` | Installs GSD in the task container and configures it to use one selected Kimchi model |

The standard helper scripts target `terminal-bench/terminal-bench-2`; the OpenViking learning runner targets `terminal-bench/terminal-bench-2-1`. Extra arguments are forwarded to `harbor run`.

## OpenViking learning experiment

Use `run-openviking-learning.sh` to test whether memory from verified attempts improves later attempts on the same Terminal-Bench 2.1 task. The runner deliberately launches one fresh task container at a time. The warm condition gives every attempt the same task-scoped OpenViking peer; the cold condition gives each attempt a new peer.

This is a learning experiment, not a standard leaderboard run. Later warm attempts receive information derived from earlier verifier output, so compare warm and cold curves rather than submitting the warm score as an independent Terminal-Bench result.

### Prerequisites

- Install the official OpenViking Pi extension and set `OPENVIKING_EXTENSION_DIR` to its directory containing `index.ts`. Kimchi's package installation commonly places it at `~/.config/kimchi/harness/packages/openviking`.
- Run an OpenViking server at an authenticated URL reachable from Docker task containers. `localhost` and `127.0.0.1` are rejected because they refer to the task container itself.
- Enable Agent Evolution for the experiment account. For a self-hosted server, set `server.agent_evolution.enabled` to `true` in `ov.conf` (or enable the account override through the OpenViking admin API). Session capture still works without it, but OpenViking will skip the case, experience, and trajectory memories this experiment measures.
- Use an experiment-only OpenViking account/user, or a separate server, if pre-existing global memories could contaminate the comparison.

```bash
export KIMCHI_API_KEY=...
export OPENVIKING_URL=https://openviking.example.test
export OPENVIKING_API_KEY=...
export OPENVIKING_ACCOUNT=tb21-experiment
export OPENVIKING_USER=kimchi
export OPENVIKING_EXTENSION_DIR="$HOME/.config/kimchi/harness/packages/openviking"
# Optional when the OpenViking server uses Ollama on this host:
export OPENVIKING_OLLAMA_URL=http://127.0.0.1:11434
```

When `OPENVIKING_OLLAMA_URL` is set, the shell runner starts warming `qwen3-embedding:4b` in parallel with the Kimchi Linux build. The Python runner verifies that warm-up before its first memory query and warms the model again after memory extraction. Override the model with `OPENVIKING_OLLAMA_EMBEDDING_MODEL`. For a local server that uses a separate generation model for memory extraction, configure Ollama to retain two models concurrently (`OLLAMA_MAX_LOADED_MODELS=2`) when VRAM permits. On a smaller GPU, extraction can still evict the embedding model; the second warm-up keeps the following recall query fast.

For faster extraction, OpenViking can use the same Kimi gateway as Kimchi while Ollama serves only embeddings. Configure its VLM as LiteLLM model `openai/kimi-k2.7` with API base `https://llm.kimchi.dev/openai/v1` and API key `${KIMCHI_API_KEY}`. If OpenViking runs as a user service, pass the key through a protected environment file or import it into the user service manager before restarting OpenViking. This uses additional Kimi tokens beyond the benchmark agent itself.

For a fully local alternative, OpenViking extraction prompts require more than Ollama's default 4,096-token context. Set `OLLAMA_CONTEXT_LENGTH=16384` on the Ollama service. When the local extraction model supports tool calls, use Ollama's OpenAI-compatible route in `ov.conf` (for example, model `openai/qwen3.5:9b` with `api_base` `http://localhost:11434/v1`); the native Ollama generate route can return prose instead of the structured memory operations OpenViking expects. A CPU-offloaded 9B model can still take several minutes to extract a trajectory, so the runner allows 30 minutes for each background memory task by default.

The benchmark adapter copies the extension into each task container, loads it explicitly with `--extension`, disables OpenViking context takeover, enables bounded tool-result capture, and commits the complete trajectory instead of retaining an unarchived live tail. It decorates the extension's capture session with an empty memory policy, so an unverified rollout is archived but cannot become learning memory. It fails the agent phase if no OpenViking turn was captured.

After Harbor verification, the runner replays the archived rollout into a separate OpenViking batch-training session. A structured CaseSpec and OutcomeEvaluation carry the verifier reward and output; that session enables only `cases`, `trajectories`, and `experiences`. This avoids unrelated profile/preference extraction, prevents failed and successful attempts from being learned without their verifier outcome, and removes competing Ollama generation jobs on single-slot local servers. The runner polls each background task before the next attempt. The exact upstream extension directory hash is recorded in trial metadata.

### Run warm and cold chains

Use distinct chain IDs and keep the task, model, attempt count, server configuration, and initial memory state equivalent between conditions:

```bash
./scripts/run-openviking-learning.sh \
  --task terminal-bench/fix-git \
  --attempts 5 \
  --condition warm \
  --chain-id fix-git-warm-01

./scripts/run-openviking-learning.sh \
  --task terminal-bench/fix-git \
  --attempts 5 \
  --condition cold \
  --chain-id fix-git-cold-01
```

The defaults are dataset `terminal-bench/terminal-bench-2-1` and model `kimchi-dev/kimi-k2.7`. Repeat `--task` to run more tasks. Arguments after `--` are forwarded to each `harbor run`, for example:

```bash
./scripts/run-openviking-learning.sh \
  --task terminal-bench/fix-git \
  --attempts 3 \
  --condition warm \
  -- --timeout-multiplier 0.5
```

Do not use Harbor's `-k` for this experiment. The runner controls repetition so that attempt N finishes verification and commits its lesson before attempt N+1 starts.

Results are written under `learning/<task>/<chain-id>/<condition>/`. Each Harbor trial contains `agent/openviking-learning/recall-before.json`, `capture-commit.json`, `lesson-submitted.json`, `memories-after.json`, and `memory-diff.md`; the condition directory's `summary.json` records the reward curve and artifact paths. Verifier output stored in memory is bounded to its last 4,000 characters by default.

Actor-peer scoping prevents one task chain from recalling another chain's peer memories. OpenViking global memory can still be visible, which is why a clean experiment account/user or separate server is the strongest control.

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

### OpenCode with the Kimchi gateway

Use `run-opencode-kimchi.sh` when the benchmark should evaluate the OpenCode scaffold while routing model calls through `llm.kimchi.dev`.

```bash
export KIMCHI_API_KEY=...
MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git
```

The script requires `KIMCHI_API_KEY` in the host environment and forwards it to Harbor with `--ae KIMCHI_API_KEY=$KIMCHI_API_KEY`; you do not need to pass that `--ae` manually when using the script.

The OpenCode adapter accepts any `kimchi-dev/<model-id>` returned by Kimchi's model metadata endpoint (`/v1/models/metadata?include_in_cli=true`). It writes an OpenCode provider config for the selected model at runtime, using the live model limits and reasoning flag, then runs OpenCode in JSON mode. Reasoning-capable models include `--thinking`:

```bash
opencode --model=<MODEL> run --format=json --thinking --dangerously-skip-permissions -- <instruction>
```

To change models, change only `MODEL`:

```bash
MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git
```

By default OpenCode uses the benchmark model for `small_model` too, keeping the whole run on the selected model. To use a cheaper Kimchi model for summary/title work, set `OPENCODE_SMALL_MODEL=kimchi-dev/<model-id>`; the adapter registers that model from the same metadata endpoint.

By default Harbor installs the latest `opencode-ai` package. Pin OpenCode for reproducible runs with `OPENCODE_VERSION`:

```bash
OPENCODE_VERSION=1.14.33 MODEL=kimchi-dev/kimi-k2.5 \
  ./scripts/run-opencode-kimchi.sh -i terminal-bench/fix-git
```

### Claude Code with the Kimchi gateway

Use `run-claude-code-kimchi.sh` when the benchmark should evaluate the Claude Code scaffold while routing model calls through `llm.kimchi.dev`.

```bash
export KIMCHI_API_KEY=...
MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
```

The Claude Code adapter accepts any `kimchi-dev/<model-id>` returned by Kimchi's model metadata endpoint (`/v1/models/metadata?include_in_cli=true`). It configures Claude Code with Kimchi's Anthropic-compatible endpoint (`https://llm.kimchi.dev/anthropic`), maps `KIMCHI_API_KEY` to `ANTHROPIC_AUTH_TOKEN`, clears `ANTHROPIC_API_KEY`, and pins Claude Code's default Sonnet/Opus/Haiku/subagent aliases to the selected model.

To change models, change only `MODEL`:

```bash
MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
```

By default Harbor installs the latest Claude Code package. Pin Claude Code for reproducible runs with `CLAUDE_CODE_VERSION`:

```bash
CLAUDE_CODE_VERSION=2.1.144 MODEL=kimchi-dev/kimi-k2.5 \
  ./scripts/run-claude-code-kimchi.sh -i terminal-bench/fix-git
```

### GSD with the Kimchi gateway

Use `run-gsd-kimchi.sh` when the benchmark should evaluate the GSD scaffold while routing model calls through `llm.kimchi.dev`.

```bash
export KIMCHI_API_KEY=...
MODEL=kimchi-dev/kimi-k2.5 ./scripts/run-gsd-kimchi.sh -i terminal-bench/fix-git
```

The GSD adapter accepts any `kimchi-dev/<model-id>` returned by Kimchi's model metadata endpoint (`/v1/models/metadata?include_in_cli=true`). It installs `gsd-pi@latest` by default, writes a temporary GSD home with only the selected model, writes minimal GSD preferences that route every role to that model, and runs GSD in non-interactive print mode:

```bash
gsd --mode text --print --model <MODEL> <instruction>
```

GSD's text output is captured at `agent/gsd.txt`, the resolved version at `agent/gsd-version.txt`, and the per-task `.gsd/` directory is copied to `agent/gsd/` after the run. The adapter records GSD's raw exit code in `agent/gsd-exit-code.txt` and normalized status in `agent/gsd-status.json`; if GSD returns its blocked exit code, Harbor still proceeds to verification. GSD's managed home stays under `/tmp` during execution and is removed before artifacts are collected; only the underlying pi session JSONL is copied to `agent/gsd-sessions/` for token accounting. GSD stdout JSON event streams are intentionally not captured because they can grow very large and are not needed for Terminal Bench scoring.

To change models, change only `MODEL`:

```bash
MODEL=kimchi-dev/minimax-m2.7 ./scripts/run-gsd-kimchi.sh -i terminal-bench/fix-git
```

Override the GSD package version with `GSD_VERSION`:

```bash
GSD_VERSION=3.0.0 MODEL=kimchi-dev/kimi-k2.5 \
  ./scripts/run-gsd-kimchi.sh -i terminal-bench/fix-git
```

### Single-model run (no orchestration)

To benchmark a model on its own, bypassing kimchi's multi-model orchestration, pass `--model <provider>/<id>` to select a specific model. The helper scripts do this by default through `MODEL`, which starts kimchi in single-model mode.

```bash
MODEL=kimchi-dev/kimi-k2.6 ./scripts/run-local.sh -n 8 -k 3
```

Do not use `--agent-kwarg disable-multi-model=true`; the adapter accepts that legacy kwarg for compatibility, but current kimchi has no `--multi-model` CLI flag.

### Multi-model run (orchestrator)

To run kimchi's default multi-model role configuration, select the adapter's virtual `multi-model` model. In this mode the adapter intentionally does not pass `--model` to kimchi, because an explicit model flag is what disables orchestration in the kimchi CLI.

```bash
MODEL=multi-model ./scripts/run-local.sh -n 8 -k 3
```

With no custom role config in the task container, the tested Kimchi revision supplies its default role configuration. The adapter writes `{"multiModel":true}` to the in-container harness settings before launching kimchi so orchestration is enabled even in a fresh benchmark image.

### Compaction

Compaction follows kimchi's default (on). Pass `disable-compaction=true` to turn it off for a run: the adapter then writes `{"compaction":{"enabled":false}}` to the in-container harness settings (`~/.config/kimchi/harness/settings.json`) before launching kimchi, which turns off upstream threshold auto-compaction, ferment stage-boundary and mid-turn compaction, and the model-guard mid-turn stopgap.

To A/B compaction on vs. off, hold model + dataset constant and toggle the kwarg:

```bash
# one-shot ferment, compaction on (default)
./scripts/run-local.sh -i terminal-bench/fix-git --agent-kwarg ferment-oneshot=true
# one-shot ferment, compaction off
./scripts/run-local.sh -i terminal-bench/fix-git --agent-kwarg ferment-oneshot=true --agent-kwarg disable-compaction=true
```

### One-shot ferment per task

Pass `ferment-oneshot=true` to wrap each trial in a one-shot exec-mode ferment. The agent boots into kimchi's progressive-refinement project mode and runs `scope_ferment` → `activate_ferment_phase` → `start_ferment_step` → `complete_ferment_step` → `complete_ferment` autonomously, delegating each step's implementation to a subagent worker. One-shot uses a static planner tool profile for the whole run, so current-ferment lifecycle tools are present from the first model call.

```bash
./scripts/run-local.sh -i terminal-bench/fix-git --agent-kwarg ferment-oneshot=true
```

State lands in `jobs/<timestamp>/<task>__<trial>/agent/ferments/`:

- `<uuid>.json` — final snapshot (phase + step state, decisions, memories)
- `<uuid>.events.jsonl` — append-only audit log of every state transition (`ferment_created`, `set_mode`, `phase_activated`, `step_started`, `step_completed`, …)

The mode is opt-in and default-off; without the kwarg, terminal-bench-2 behaves exactly as before — a single-shot `kimchi --print` call with no ferment bootstrap. To compare ferment-mode vs. baseline reward / tokens / cost, hold model + dataset constant and toggle the kwarg between runs.

Caveats:

- One extra LLM round-trip per trial: kimchi calls `shortenTitle` on the instruction to produce a ferment name (billed under the bench's `KIMCHI_API_KEY`, tagged `task:<task_id>`).
- Token / cost aggregation is unchanged — `populate_context_post_run` still reads `agent/sessions/*.jsonl`, which already includes subagent session files spawned during step execution.

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
| `OPENCODE_VERSION` | no | Pins the OpenCode version used by `run-opencode-kimchi.sh` |
| `CLAUDE_CODE_VERSION` | no | Pins the Claude Code version used by `run-claude-code-kimchi.sh` |
| `GSD_VERSION` | no | Overrides the GSD package version used by `run-gsd-kimchi.sh`; default install target is `gsd-pi@latest` |

## Results

`benchmark/terminal-bench-2/jobs/<timestamp>/<task>__<trial_id>/` — each trial directory contains `trial.log`, `result.json` (with `reward`), and `config.json`. Resumable session files (parent + each subagent, linked via `parentSession`) are in `agent/sessions/*.jsonl`; replay any of them with `kimchi --session <path>`.

## Troubleshooting

**`Illegal instruction` / exit 132** — Apple Silicon + Docker Desktop Rosetta emulating amd64 task images. See "Apple Silicon" under Prereqs.

**`qemu: uncaught target signal 11 (Segmentation fault)` in `verifier/test-stdout.txt`, reward forced to 0** — Apple Silicon + QEMU emulation. The agent's reward isn't real; re-run on x86_64 hardware. See "Apple Silicon" under Prereqs.

**`Unsupported container arch (ELF e_machine=...)`** — the task container's userland is neither amd64 nor arm64. Only those two are released; nothing to do at the bench layer.

**`sha256 mismatch for kimchi_linux_*.tar.gz`** — cached tarball at `~/.cache/kimchi-bench/releases/<tag>/` is corrupt or the release was replaced. `rm -rf` that tag's directory and retry.

**`KIMCHI_API_KEY is required`** — env var didn't reach the container. Set it on the host before invoking the script; the helper scripts forward it via `--ae`.

**`harbor: command not found`** — run via `uv run`; the helper scripts already do.
