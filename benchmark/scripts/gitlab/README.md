# benchmark/scripts/gitlab

GitLab CI orchestration scripts for the **terminal-bench-2** benchmark suite.

These scripts run on the GitLab runner to slice the benchmark task list into chunks, invoke [Harbor] per chunk, classify trial verdicts, and write the artifacts (`run-metadata.json`, `summary.json`) that the analytics pipeline consumes.

[Harbor]: ../terminal-bench-2/

## Component map

| File | Role |
| --- | --- |
| `bench_config.py` | Single source of truth for env var names, defaults, and parsing helpers (`load_model`, `load_llm_params`, `should_retry_agent_timeout`). Reads `os.environ` at call time so test fixtures can override. |
| `outcome.py` | `Outcome` `StrEnum` (`scored_pass`, `scored_fail`, `agent_timeout`, `error`). Producer (`classify.py`) and consumer (`summarize_results.py`) share the wire strings. |
| `harbor_runner.py` | Pure-function builder for the `harbor run` argv list, plus a thin `subprocess.Popen` wrapper. No business logic. |
| `chunk_runner.py` | Entry point for one chunk. Restores prior-attempt artifacts, computes the chunk's task slice, classifies existing trials, invokes Harbor for the missing tasks, writes chunk-meta. |
| `chunk_recovery.py` | Derives the authoritative complete, recoverable, or exhausted state for every chunk from task ownership, final trials, durable statuses, and attempt ordinals. |
| `classify.py` | Reads each trial's `result.json`, causal `trial.log` evidence, and agent sessions; applies rule-based classification; and writes an enriched `result.json` with `outcome`, `error_category`, `error_subcategory`. |
| `docker_health.py` | Shared Docker daemon marker and error-subcategory constants used by classification and chunk health monitoring. |
| `prepare_summary.py` | Validates runner artifacts or hydrates durable run metadata, trials, chunk statuses, and immutable attempt ordinals before summary generation. |
| `summarize_results.py` | Reads `run-metadata.json` + all trial artifacts under `BENCHMARK_RESULTS_DIR` and writes `summary.json`. Builds totals, per-task verdicts, and emits the `benchmark-summary/v2`-shaped output. |
| `chunk_slicing.py` | Deterministic task-list slicing across `BENCH_CHUNK_COUNT` chunks. |
| `upload_gcs.py` | Summary-job helper that tars `BENCHMARK_RESULTS_DIR` into `jobs.tar.gz` and uploads it along with `metadata.json` to the run's GCS prefix. |
| `upload_summary_gcs.py` | Summary-job helper that uploads `summary.json` to the run's GCS prefix. |
| `redact_api_key.py` | Replaces `KIMCHI_API_KEY` with `***` in tarballs before they leave the runner. |
| `install_gcloud.sh`, `setup_image.sh` | Runner-image setup helpers invoked by the CI job templates. |
| `tests/` | Unit tests for every script that has logic worth testing. |

## Pipeline flow

```
GitLab pipeline
  └─ matrix job: chunk-N
        │
        │ 1. chunk_runner.main()
        │      ├─ _restore_prior_artifact()     # GitLab `retry:` strips prior workspace
        │      ├─ _expected_tasks_for_chunk()   # chunk_slicing.slice_tasks()
        │      ├─ load_llm_params()             # env → (global, {}) — per-model not supported via CI
        │      ├─ _write_run_metadata()         # writes .benchmark/run-metadata.json (idempotent)
        │      ├─ write_enriched_results()      # classify() anything already on disk
        │      ├─ build_harbor_command()       # forward params as --agent-kwarg
        │      └─ run_harbor()                  # subprocess
        │
        └─ summary job
              ├─ prepare_summary.main()
              │     ├─ restore run-metadata.json and trial checkpoints
              │     ├─ restore runner-authored chunk statuses
              │     └─ write immutable ordinals to chunk-attempts.json
              └─ summarize_results.write_summary()
                    ├─ load_json(run-metadata.json)
                    ├─ summarize_trial() per trial dir
                    ├─ derive_chunk_recovery_states() for frozen-budget runs
                    ├─ retain chunk-meta compatibility for legacy runs
                    ├─ build_task_verdicts()
                    └─ write summary.json (validated against benchmark-summary/v2)
```

Frozen-budget runs use the recovery states for both summary diagnostics and
the final success/failure decision. Legacy metadata without a frozen
`chunk_attempt_budget` stays on the historical `chunk-meta` compatibility
path; durable attempt markers alone never opt an old run into the new
exhaustion semantics.

The `harbor run` command invokes the `Kimchi` Harbor agent in the container, which decodes the `--agent-kwarg llm-params=...` value, sets `KIMCHI_LLM_PARAMS_JSON` env var, and copies a bundled extension into `~/.config/kimchi/extensions/llm-sampling-params/`. See [LLM sampling parameters](#llm-sampling-parameters) below.

## LLM sampling parameters

The benchmark pipeline can forward optional LLM sampling parameters (`temperature`, `top_p`, `top_k`, `max_tokens`) to every LLM call the in-container kimchi agent makes, with per-model overrides. Parameters are reported in `run-metadata.json` and `summary.json` under `run.parameters`.

### Environment variables

Individual env vars set from typed CI inputs (number type avoids the `$[[ inputs.X ]]` curly-brace interpolation bug for string inputs). Zero (the default) means "not set" for each parameter.

| Variable | Type | Description |
| --- | --- | --- |
| `BENCH_LLM_TEMPERATURE` | float | Sampling temperature applied to every LLM call (0.0–1.0). |
| `BENCH_LLM_TOP_P` | float | Nucleus sampling top_p applied to every LLM call (0.0–1.0). |
| `BENCH_LLM_TOP_K` | int | Top-k sampling applied to every LLM call (positive int). |
| `BENCH_LLM_MAX_TOKENS` | int | Maximum output tokens per LLM call (positive int). |

Per-model overrides are not supported via CI inputs; `load_llm_params()` always returns an empty dict for the second element.

Example (CI inputs or manual env):

```bash
export BENCH_LLM_TEMPERATURE=0.3
export BENCH_LLM_TOP_P=0.9
export BENCH_LLM_MAX_TOKENS=4096
```

### Validation rules (`load_llm_params`)

- Each parameter is read individually; unset or zero means "not set".
- `temperature` and `top_p` must be numeric in `[0, 1]`.
- `top_k` and `max_tokens` must be positive integers. GitLab number inputs may arrive with a trailing `.0` (e.g. `40.0`); this is accepted and coerced via `int(float(raw))`.
- Invalid values raise `ValueError` with the env var name and the problematic value.

### How params reach the provider

```
bench_config.load_llm_params()                # env → dicts
  └─ chunk_runner.main()
        ├─ _write_run_metadata(.., llm_params, {})   # run-metadata.json
        └─ build_harbor_command(.., llm_params, {})
              └─ --agent-kwarg llm-params=<base64-json>
                 │
                 ▼
              Kimchi Harbor agent
                ├─ _decode_agent_kwarg() → dicts
                ├─ env["KIMCHI_LLM_PARAMS_JSON"] = json.dumps(global)
                ├─ env["KIMCHI_LLM_PER_MODEL_PARAMS_JSON"] = json.dumps(per_model)
                └─ install() uploads llm-sampling-params/index.ts to /tmp/kimchi-llm-ext
                   _kimchi_launch_command() copies it into
                     $HOME/.config/kimchi/extensions/llm-sampling-params/
                     (binary auto-discovers from this dir at startup)
                 │
                 ▼
              llm-sampling-params extension
                pi.on("before_provider_request", ..)
                  ├─ merged = { ...global, ...per_model[modelRef] }
                  ├─ payload.temperature = merged.temperature  (if set)
                  ├─ payload.top_p       = merged.top_p        (if set)
                  ├─ payload.top_k       = merged.top_k        (if set)
                  └─ payload[model.compat.maxTokensField ?? "max_tokens"] = merged.max_tokens
                     (and deletes the alternate field if it was already present)

Per-model overrides are not set via CI inputs (always empty), but the full
mechanism (env vars `KIMCHI_LLM_PARAMS_JSON` / `KIMCHI_LLM_PER_MODEL_PARAMS_JSON`
→ extension) supports them for local runs.
```

The extension mutates `event.payload` in-place and returns the same reference, matching the `tags.ts` contract. It is loaded automatically via the binary's extension auto-discovery — no `--extension` CLI flag is required.

### Output

`run-metadata.json`:

```json
{
  "parameters": {
    "attempts": "1",
    "parallelism": "1",
    "timeout_multiplier": "1.0",
    "retry_agent_timeout": false,
    "llm_params": {"temperature": 0.3, "top_p": 0.9},
    "llm_per_model_params": {}
  }
}
```

`summary.json` (`run.parameters`, validated by `benchmark-summary/v2`):

```json
{
  "run": {
    "...": "...",
    "parameters": {
      "llm_params": {"temperature": 0.3, "top_p": 0.9},
      "llm_per_model_params": {}
    }
  }
}
```

### Retry caveat

`_write_run_metadata` returns early if the metadata file already exists. On a `retry:` job that restores a prior attempt's artifact, an older `run-metadata.json` without the new params will be preserved. To pick up changed params on retry, delete the restored artifact or patch `run-metadata.json` after restoration before re-running the chunk.

## Development

```bash
cd benchmark/scripts/gitlab
uv sync                                          # one-time
uv run pytest                                    # run all unit tests
uv run pytest tests/test_bench_config.py -k llm  # just the LLM param tests
uv run ruff check .                              # lint (matches CI)
```

Tests are co-located as `tests/test_<module>.py`. The new LLM param tests are in `tests/test_bench_config.py` (parser + validation), `tests/test_harbor_runner.py` (forwarding), `tests/test_summarize_results.py` (surface in `run.parameters`), and `tests/test_chunk_runner.py` (chunk-level wiring).

`benchmark-summary/v2` validation is exercised by `tests/test_summarize_results.py::SummarySchemaValidationTest`, which runs `write_summary()` end-to-end and validates the result against `benchmark/schemas/benchmark-summary-v2.schema.json` via `jsonschema.validate`.

## Run locally

```bash
# from repo root, with KIMCHI_API_KEY exported
export BENCH_LLM_TEMPERATURE=0.3
export BENCH_LLM_MAX_TOKENS=2048
uv run --project benchmark/terminal-bench-2 --python 3.14 harbor run \
  --agent-import-path kimchi_agent:Kimchi \
  --env docker --model kimchi-dev/kimi-k2.6 \
  -d terminal-bench/terminal-bench-2 -n 1 -k 1 --timeout-multiplier 1.0 \
  -i terminal-bench/some-task
```
