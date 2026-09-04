# Terminal-Bench reference

This document keeps the detailed benchmark options out of the
[quick-start tutorial](README.md). Use it after a basic Kimchi trial completes.

## Platform notes

Terminal-Bench task images are amd64. On Apple Silicon, Docker Desktop runs
them through Rosetta or QEMU, and neither path is reliable for scoring:

| Emulator | Common symptom |
| --- | --- |
| Rosetta | Kimchi can exit with `Illegal instruction` (132) |
| QEMU | The verifier can segfault and force the reward to `0` |

Apple Silicon is still useful for checking installation, prompt handling, and
session capture. Add `--disable-verification` to the Harbor command on these
machines so the emulated verifier does not report a misleading failure. The run
will produce agent artifacts but no benchmark score. Use Linux x86_64 hardware
for results you intend to compare or publish.

## Datasets and job directories

The main tutorial uses Terminal-Bench 2.1:

```bash
-d terminal-bench/terminal-bench-2-1
```

Select Terminal-Bench 2.0 with:

```bash
-d terminal-bench/terminal-bench-2
```

`--jobs-dir jobs` keeps local output under this project's ignored `jobs/`
directory. Set another path when a CI job or experiment needs isolated output.

## Other model routes

The Kimchi benchmark adapter can route selected models through providers other
than the Kimchi gateway. Replace `--model` and pass the matching key with
`--ae`:

| Model route | Credential |
| --- | --- |
| `kimchi-dev/*`, `multi-model` | `KIMCHI_API_KEY` |
| `openrouter/*` | `OPENROUTER_API_KEY` |
| `anthropic/*` | `ANTHROPIC_API_KEY` |
| `moonshotai/*` | `MOONSHOT_API_KEY` |
| `zai/*` | `ZAI_API_KEY` |

For example:

```bash
export ZAI_API_KEY=...
uv run --python 3.14 harbor run \
  --agent kimchi_agent:Kimchi \
  --env docker \
  --model zai/glm-5.3 \
  --ae "ZAI_API_KEY=$ZAI_API_KEY" \
  --agent-kwarg thinking=high \
  -d terminal-bench/terminal-bench-2-1 \
  --jobs-dir jobs \
  -i terminal-bench/fix-git
```

Provider support differs between agents. The helper scripts validate their
allowed routes before Harbor starts.

## Kimchi modes

### Single model and multi-model

An explicit `--model kimchi-dev/<id>` runs Kimchi in single-model mode. Use the
virtual model below to benchmark Kimchi's configured orchestration:

```bash
--model multi-model
--ae "KIMCHI_API_KEY=$KIMCHI_API_KEY"
```

The adapter intentionally omits Kimchi's CLI model flag for `multi-model`, so
the benchmark exercises the role configuration supplied by the tested build.

### Compaction

Compaction follows Kimchi's default. Disable it for a comparison with:

```bash
--agent-kwarg disable-compaction=true
```

Keep the model, dataset, task set, and attempt count fixed when comparing
compaction modes.

### One-shot Ferment

Run each task through Kimchi's one-shot Ferment flow with:

```bash
--agent-kwarg ferment-oneshot=true
```

Ferment snapshots and event logs are stored under each trial's
`agent/ferments/` directory. Session token and cost aggregation includes the
subagents created while executing Ferment steps. The mode also adds an LLM call
to name the Ferment.

### Request tags

Kimchi attaches `KIMCHI_TAGS` to LLM requests and telemetry. Forward custom
tags to the task container with:

```bash
--ae "KIMCHI_TAGS=bench:terminal-bench-2,experiment:baseline"
```

Tags are comma-separated `key:value` pairs. Keys and values may contain letters,
numbers, `.`, `_`, and `-`, with at most 64 characters on each side.

## Other coding-agent scaffolds

The project contains Harbor adapters for comparing the model with different
coding-agent scaffolds:

| Script | Scaffold |
| --- | --- |
| `scripts/run-opencode-kimchi.sh` | OpenCode |
| `scripts/run-claude-code-kimchi.sh` | Claude Code through a supported route |
| `scripts/run-claude-code.sh` | Claude Code with the native Anthropic API |
| `scripts/run-codex.sh` | Codex with the native OpenAI API |
| `scripts/run-cursor.sh` | Cursor Agent with Cursor's API |
| `scripts/run-gsd-kimchi.sh` | GSD |
| `scripts/run-pi-kimchi.sh` | Stock Pi with the Kimchi provider extension |
| `scripts/run-workflow.sh` | Kimchi running a `kimchi-workflows` workflow |
| `scripts/run-pi-workflow.sh` | Stock Pi running a `kimchi-workflows` workflow |

The scripts are executable references for the required Harbor selector, API-key
handling, retry configuration, and version arguments. They default to
Terminal-Bench 2.1 and accept `DATASET` overrides where applicable.

## Workflow benchmarks

`run-workflow.sh` builds Kimchi and runs a named published workflow. Its default
is `ferment-oneshot`. `run-pi-workflow.sh` hosts the same workflow engine in
stock Pi and defaults to `deep-solve`.

The relevant variables are:

| Variable | Purpose |
| --- | --- |
| `WORKFLOW` | Workflow's declared name, not a filename |
| `EXTENSION` | `npm:<package>@<version>` or `dir:<host-path>` workflow source |
| `PI_BUNDLE_DIR` | Location of the offline Pi installation bundle |
| `SKIP_PI_BUNDLE` | Skip the offline bundle and install through the network |
| `TB_AGENT_TIMEOUT_SEC` | Override the agent-phase budget for workflow debugging |

Task images may not include Node, so workflow extensions are resolved on the
host and uploaded into the container.

## Environment variables and version pins

| Variable | Purpose |
| --- | --- |
| `KIMCHI_CODE_BINARY` | Absolute path to a local Linux Kimchi binary |
| `GITHUB_TOKEN` | Raises GitHub API limits when downloading a release |
| `JOBS_DIR` | Output directory used by helper scripts |
| `OPENCODE_VERSION` | Pin OpenCode |
| `CLAUDE_CODE_VERSION` | Pin Claude Code |
| `GSD_VERSION` | Pin GSD |
| `PI_VERSION` | Pin Pi |

For reproducible scaffold comparisons, pin the scaffold version as well as the
model and Kimchi commit.

## Troubleshooting

### Model warnings or empty replies

Check the selected model against `kimchi --list-models`. A retired Kimchi model
can produce empty replies that resemble an agent failure.

### API key does not reach the task

Harbor does not forward arbitrary host variables. Pass the selected provider's
key with `--ae "NAME=$NAME"`.

### Corrupt release cache

If a downloaded Kimchi archive reports a SHA-256 mismatch, remove that release's
directory under `~/.cache/kimchi-bench/releases/` and retry.

### Architecture failures

`Illegal instruction` and QEMU verifier segfaults indicate Apple Silicon
emulation. `Unsupported container arch` means the task image is neither amd64
nor arm64. Use Linux x86_64 for trusted runs.

### Inspecting a failed trial

Start with `trial.log` and `result.json`, then inspect `agent/sessions/*.jsonl`.
Kimchi sessions can be replayed with `kimchi --session <path>`.
