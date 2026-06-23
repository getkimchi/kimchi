"""Centralised benchmark environment configuration.

Single source of truth for env var names and defaults used by multiple
benchmark scripts (chunk_runner.py, run-gitlab.py, summarize_results.py).

This module exposes two kinds of values:

- `ENV_*`: the env var **name** as a string. Use with
  `os.environ.get(ENV_X, DEFAULT_X)` so the read happens at call time and
  tests can override the environment after import. Reading env at import
  time here would freeze values before test fixtures like `monkeypatch.setenv`
  can take effect.
- `DEFAULT_*`: the default value if the env var is unset.
- `DEFAULT_MODEL`: a single canonical model identifier used by both
  `os.environ.get(ENV_MODEL, DEFAULT_MODEL)` call sites and the
  `parse_model()` helper.
- `parse_model()`: takes the resolved model string and returns
  `(provider, name)`. Reads from `os.environ` lazily.
"""

from __future__ import annotations

import os

# --- Model ---
ENV_MODEL = "MODEL"
DEFAULT_MODEL = "kimchi-dev/minimax-m3"


def parse_model() -> tuple[str, str]:
    """Return (provider, name) for the value of $MODEL. Defaults to DEFAULT_MODEL.

    Reads `os.environ` at call time so test fixtures (monkeypatch.setenv)
    can override MODEL before the function is called.
    """
    model = os.environ.get(ENV_MODEL, DEFAULT_MODEL)
    provider, _, name = model.partition("/")
    return (provider, name) if name else ("unknown", model)


# --- Agent / mode flags ---
ENV_CODING_AGENT = "CODING_AGENT"
DEFAULT_CODING_AGENT = "kimchi"

ENV_KIMCHI_MULTI_MODEL = "KIMCHI_MULTI_MODEL"
DEFAULT_KIMCHI_MULTI_MODEL = "true"

ENV_KIMCHI_FERMENT_ONESHOT = "KIMCHI_FERMENT_ONESHOT"
DEFAULT_KIMCHI_FERMENT_ONESHOT = "false"

ENV_DATASET = "DATASET"
DEFAULT_DATASET = "terminal-bench/terminal-bench-2"

# --- Paths ---
ENV_BENCHMARK_NAME = "BENCHMARK_NAME"
DEFAULT_BENCHMARK_NAME = "terminal-bench-2"

ENV_BENCHMARK_RESULTS_DIR = "BENCHMARK_RESULTS_DIR"
DEFAULT_BENCHMARK_RESULTS_DIR = "benchmark/terminal-bench-2/jobs"

ENV_BENCHMARK_RUN_METADATA = "BENCHMARK_RUN_METADATA"
DEFAULT_BENCHMARK_RUN_METADATA = ".benchmark/run-metadata.json"

ENV_BENCHMARK_SUMMARY_PATH = "BENCHMARK_SUMMARY_PATH"
DEFAULT_BENCHMARK_SUMMARY_PATH = ".benchmark/summary.json"

ENV_BENCHMARK_GCS_BUCKET = "BENCHMARK_GCS_BUCKET"
DEFAULT_BENCHMARK_GCS_BUCKET = ""

ENV_BENCHMARK_TARGET_REF = "BENCHMARK_TARGET_REF"
ENV_BENCHMARK_TARGET_SHA = "BENCHMARK_TARGET_SHA"

# --- Chunk orchestration ---
ENV_BENCH_CHUNK_INDEX = "BENCH_CHUNK_INDEX"
DEFAULT_BENCH_CHUNK_INDEX = "0"

ENV_BENCH_CHUNK_COUNT = "BENCH_CHUNK_COUNT"
DEFAULT_BENCH_CHUNK_COUNT = "1"

ENV_BENCH_JOB_MAX_RETRIES = "BENCH_JOB_MAX_RETRIES"
DEFAULT_BENCH_JOB_MAX_RETRIES = "0"

ENV_BENCH_PARALLELISM = "BENCH_PARALLELISM"
DEFAULT_BENCH_PARALLELISM = "1"

ENV_BENCH_ATTEMPTS = "BENCH_ATTEMPTS"
DEFAULT_BENCH_ATTEMPTS = "1"

ENV_BENCH_TIMEOUT_MULTIPLIER = "BENCH_TIMEOUT_MULTIPLIER"
DEFAULT_BENCH_TIMEOUT_MULTIPLIER = "1.0"

ENV_BENCH_HEARTBEAT_INTERVAL_SECONDS = "BENCH_HEARTBEAT_INTERVAL_SECONDS"
DEFAULT_BENCH_HEARTBEAT_INTERVAL_SECONDS = "60"

# --- Task selection ---
ENV_SELECTED_TASKS_JSON = "SELECTED_TASKS_JSON"
DEFAULT_SELECTED_TASKS_JSON = "[]"

ENV_BENCH_TASKS_ALL = "BENCH_TASKS_ALL"
DEFAULT_BENCH_TASKS_ALL = "false"
