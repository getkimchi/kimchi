"""Centralised benchmark environment configuration.

Single source of truth for env var names and defaults used by multiple
benchmark scripts (chunk_runner.py, summarize_results.py).

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

from outcome import Outcome

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

# --- Retry behavior ---
ENV_BENCH_RETRY_AGENT_TIMEOUT = "BENCH_RETRY_AGENT_TIMEOUT"
DEFAULT_BENCH_RETRY_AGENT_TIMEOUT = False


def should_retry_agent_timeout() -> bool:
    """Return True when chunks should retry AgentTimeoutError verdicts.

    Reads $BENCH_RETRY_AGENT_TIMEOUT at call time so test fixtures can override it.
    """
    raw = os.environ.get(ENV_BENCH_RETRY_AGENT_TIMEOUT, str(DEFAULT_BENCH_RETRY_AGENT_TIMEOUT)).strip().lower()
    return raw in ("true", "1", "yes")


def is_retryable(outcome: Outcome, error_category: str | None) -> bool:
    """Single source of truth: should this verdict outcome trigger a retry?

    Infra errors (outcome=ERROR, error_category='infra') are always retried.
    AgentTimeoutError retries are controlled by $BENCH_RETRY_AGENT_TIMEOUT (default false).
    """
    if outcome == Outcome.AGENT_TIMEOUT:
        return should_retry_agent_timeout()
    return outcome == Outcome.ERROR and error_category == "infra"
