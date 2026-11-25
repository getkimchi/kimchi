# Guardrails benchmark CI

Manually compares the same branch-built Kimchi harness through two provider configurations:

- **baseline**: guardrails disabled;
- **guarded**: guardrails enabled.

The GitHub Actions workflow is **Actions → Guardrails benchmark → Run workflow**. Select `kimi-k3`, `deepseek-v4.1-flash-1017`, or `both`. Only actors with write, maintain, or admin permission can start a run. It consumes paid model capacity.

## Required secrets

Configure repository or environment secrets; never put keys in dispatch inputs, files, or command arguments.

| GitHub secret | Runtime provider alias | Purpose |
|---|---|---|
| `GUARDRAILS_BENCHMARK_BASELINE_API_KEY` | `BASELINE_API_KEY` | Unguarded baseline model **and both AgentHarm graders** |
| `GUARDRAILS_BENCHMARK_GUARDED_API_KEY` | `GUARDED_API_KEY` | Guarded target model only |

Both routes use `https://llm.kimchi.dev/openai/v1` through distinct Inspect `openai-api` provider aliases (`baseline` and `guarded`). The refusal judge is `glm-5.3-flash` and the semantic judge is `kimi-k3`; both stay on the unguarded baseline route.

## What runs

The workflow checks out the dispatch ref, builds `dist/bin/kimchi` with `pnpm run build:binary`, and distributes that exact binary to every model/route matrix job. It never downloads a released Kimchi binary.

`kimchi_solver.py` replaces only Inspect's generation loop. For every sample, Inspect's `sandbox_agent_bridge` starts the branch-built binary as:

```text
dist/bin/kimchi --print --no-session --no-auto-update --no-builtin-tools \
  --dangerously-skip-permissions --model inspect/inspect \
  --mcp-config <sample-config> [--append-system-prompt <public-task-prompt>]
```

The sample prompt is sent on stdin. The custom `inspect` provider points to Inspect's loopback bridge, not the real gateway: the real baseline/guarded key remains in the Inspect parent process and is blanked in the Kimchi child environment. Benchmark tools are bridged back to their stock implementations with `toolPrefix: none`, preserving tool names expected by the deterministic scorers. Kimchi's built-in tools are disabled, and each sample uses an empty temporary working directory and isolated home.

Inspect runs this bridge in its `local` sandbox, which requires Linux for helper injection. The workflow uses `ubuntu-24.04`; local live runs should also use Linux.

The original datasets, setup solvers, prompts, message limit, and scorers remain in place:

- **AgentThreatBench**: `inspect_evals/agent_threat_bench_memory_poison`, `inspect_evals/agent_threat_bench_autonomy_hijack`, and `inspect_evals/agent_threat_bench_data_exfil`; 10 + 6 + 8 = 24 samples, one epoch. Utility and security are reported separately per task and as sample-weighted aggregates.
- **AgentHarm**: `inspect_evals/agentharm`, full harmful `test_public` split, 176 samples, one epoch. Reports include average harm, full score, refusals, non-refusal harm, and per-category harm/refusal metrics.

Both suites use Inspect AI `0.3.277`, Inspect Evals revision `eb5383efecd8ac6d23fd276757b811f3db05a1f5`, AgentHarm dataset revision `e23b3fe60a0da9037314b88e5ee3a0c054970dad`, `max_connections=8`, and `message_limit=20`. `pyproject.toml` and `uv.lock` pin the Python environment.

## Output and privacy

The final `guardrails-benchmark-reports` artifact contains only:

- `baseline.md`
- `guarded.md`

Artifact retention is one day. The GitHub step summary compares status and metrics across routes. Missing, failed, errored, or short runs are marked explicitly and make the report job fail.

Raw Inspect logs, console output, Kimchi sessions, prompts, completions, transcripts, API responses, and credentials are not uploaded or included in reports. Intermediate artifacts contain sanitized aggregate JSON only. Inspect's private logs are written below the runner temporary directory.

## Add a model

Add its label-to-gateway-model-ID entry to `models.json`, then add the label to the `workflow_dispatch.models.options` list in `.github/workflows/guardrails-benchmark.yml`. Matrix expansion, provider construction, metadata, and reports consume the shared map.

## Offline verification

No provider keys are needed for tests or report generation:

```bash
python3 -m unittest discover -s tools/guardrails-benchmark -p 'test_*.py'
uv run --frozen --project tools/guardrails-benchmark python \
  -m unittest discover -s tools/guardrails-benchmark -p 'test_*.py'
python3 tools/guardrails-benchmark/benchmark.py matrix --selection both
```

For a local live run, first build `dist/bin/kimchi`, export the runtime key variables shown above, choose private locations for raw logs, and call `benchmark.py run` with `--label`, `--route`, `--commit-sha`, `--binary`, `--output`, and `--log-root`. Do not run live benchmarks merely to validate this tooling; the unit tests and fixture report generation cover that without paid traffic.

The bridge deliberately targets these benchmarks' deterministic simulated tools. It is not a general isolation boundary for arbitrary host tools or an adversarial operating-system sandbox.
