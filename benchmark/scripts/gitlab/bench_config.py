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
MULTI_MODEL = "multi-model"
DEFAULT_MODEL = "kimchi-dev/minimax-m3"


def is_multi_model(model: str | None = None) -> bool:
    """Return whether the selected benchmark model is Kimchi's virtual multi-model mode."""
    selected = model if model is not None else os.environ.get(ENV_MODEL, DEFAULT_MODEL)
    return selected == MULTI_MODEL


def parse_model() -> tuple[str, str]:
    """Return (provider, name) for the value of $MODEL. Defaults to DEFAULT_MODEL.

    Reads `os.environ` at call time so test fixtures (monkeypatch.setenv)
    can override MODEL before the function is called.
    """
    model = os.environ.get(ENV_MODEL, DEFAULT_MODEL)
    if is_multi_model(model):
        return ("kimchi", MULTI_MODEL)
    provider, _, name = model.partition("/")
    return (provider, name) if name else ("unknown", model)


# --- Agent / mode flags ---
ENV_CODING_AGENT = "CODING_AGENT"
DEFAULT_CODING_AGENT = "kimchi"

# WorkflowAgent subclasses Kimchi, so it takes kimchi's agent kwargs — see
# is_kimchi_family.
WORKFLOW_CODING_AGENT = "kimchi-workflow"


def is_kimchi_family(coding_agent: str | None = None) -> bool:
    """Return whether the selected agent is Kimchi or a subclass of it."""
    selected = coding_agent if coding_agent is not None else os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    return selected in (DEFAULT_CODING_AGENT, WORKFLOW_CODING_AGENT)


def is_workflow_agent(coding_agent: str | None = None) -> bool:
    """Return whether the selected agent runs a kimchi-workflows workflow."""
    selected = coding_agent if coding_agent is not None else os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    return selected == WORKFLOW_CODING_AGENT


ENV_WORKFLOW = "BENCH_WORKFLOW"
DEFAULT_WORKFLOW = "ferment-oneshot"

# A dist-tag rather than a version, so CI picks up extension publishes without
# a pipeline change; each result.json records the version that actually
# resolved. The tag is explicit because a bare name resolves through the `*`
# range, which excludes prereleases — and every published engine version so far
# is one, so a bare spec fails with ETARGET.
ENV_WORKFLOW_EXTENSION = "BENCH_WORKFLOW_EXTENSION"
DEFAULT_WORKFLOW_EXTENSION = "npm:@kimchi-dev/kimchi-workflows@latest"

ENV_KIMCHI_FERMENT_ONESHOT = "KIMCHI_FERMENT_ONESHOT"
DEFAULT_KIMCHI_FERMENT_ONESHOT = "false"

ENV_KIMCHI_COMPACTION = "KIMCHI_COMPACTION"
DEFAULT_KIMCHI_COMPACTION = "auto"

ENV_DATASET = "DATASET"
DEFAULT_DATASET = "terminal-bench/terminal-bench-2-1"

# --- Paths ---
ENV_BENCHMARK_NAME = "BENCHMARK_NAME"
DEFAULT_BENCHMARK_NAME = "terminal-bench-2-1"

ENV_BENCHMARK_RESULTS_DIR = "BENCHMARK_RESULTS_DIR"
DEFAULT_BENCHMARK_RESULTS_DIR = "benchmark/terminal-bench-2-1/jobs"

ENV_BENCHMARK_RUN_METADATA = "BENCHMARK_RUN_METADATA"
DEFAULT_BENCHMARK_RUN_METADATA = ".benchmark/run-metadata.json"

ENV_BENCHMARK_SUMMARY_PATH = "BENCHMARK_SUMMARY_PATH"
DEFAULT_BENCHMARK_SUMMARY_PATH = ".benchmark/summary.json"

ENV_BENCHMARK_GCS_BUCKET = "BENCHMARK_GCS_BUCKET"
DEFAULT_BENCHMARK_GCS_BUCKET = ""

# Stable run date — set once by setup-image and passed downstream via
# bench.env so that retried chunk jobs (possibly days later) use the same
# date in the GCS prefix as the original run.
ENV_BENCH_RUN_DATE = "BENCH_RUN_DATE"

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
NON_RETRYABLE_INFRA_SUBCATEGORIES = frozenset({"api_key_budget_exceeded"})


def should_retry_agent_timeout() -> bool:
    """Return True when chunks should retry AgentTimeoutError verdicts.

    Reads $BENCH_RETRY_AGENT_TIMEOUT at call time so test fixtures can override it.
    """
    raw = os.environ.get(ENV_BENCH_RETRY_AGENT_TIMEOUT, str(DEFAULT_BENCH_RETRY_AGENT_TIMEOUT)).strip().lower()
    return raw in ("true", "1", "yes")


def is_retryable(
    outcome: Outcome,
    error_category: str | None,
    error_subcategory: str | None = None,
) -> bool:
    """Single source of truth: should this verdict outcome trigger a retry?

    Infra errors (outcome=ERROR, error_category='infra') are retried unless
    their subcategory is a known terminal infra condition.
    AgentTimeoutError retries are controlled by $BENCH_RETRY_AGENT_TIMEOUT (default false).
    """
    if outcome == Outcome.AGENT_TIMEOUT:
        return should_retry_agent_timeout()
    return (
        outcome == Outcome.ERROR
        and error_category == "infra"
        and error_subcategory not in NON_RETRYABLE_INFRA_SUBCATEGORIES
    )


# --- LLM sampling parameters ---
# Individual env vars set from typed CI inputs (number type avoids the
# $[[ inputs.X ]] curly-brace interpolation bug for string inputs).
ENV_BENCH_LLM_TEMPERATURE = "BENCH_LLM_TEMPERATURE"
ENV_BENCH_LLM_TOP_P = "BENCH_LLM_TOP_P"
ENV_BENCH_LLM_TOP_K = "BENCH_LLM_TOP_K"
ENV_BENCH_LLM_MAX_TOKENS = "BENCH_LLM_MAX_TOKENS"


def _read_optional_float(env_var: str, low: float, high: float) -> float | None:
    """Read a float env var; return None if unset or zero (sentinel for 'not set')."""
    raw = os.environ.get(env_var, "").strip()
    if not raw or raw == "0" or raw == "0.0":
        return None
    try:
        v = float(raw)
    except ValueError:
        raise ValueError(f"{env_var}={raw!r} is not a valid number") from None
    if not low <= v <= high:
        raise ValueError(f"{env_var}={v} is out of range [{low}, {high}]")
    return v


def _read_optional_int(env_var: str) -> int | None:
    """Read a positive-int env var; return None if unset or zero (sentinel for 'not set')."""
    raw = os.environ.get(env_var, "").strip()
    if not raw or raw == "0":
        return None
    try:
        v = int(float(raw))  # GitLab number inputs may have trailing .0
    except ValueError:
        raise ValueError(f"{env_var}={raw!r} is not a valid integer") from None
    if v <= 0:
        raise ValueError(f"{env_var}={v} must be a positive integer")
    return v


def load_llm_params() -> tuple[dict[str, float | int], dict[str, dict[str, float | int]]]:
    """Return (global_params, per_model_params) from individual env vars.

    CI inputs use number type to work around GitLab's $[[ inputs.X ]]
    interpolation bug that drops string values containing curly braces.
    Zero (the default) means "not set" for each parameter.

    Per-model overrides are not supported via CI inputs; the second
    return value is always an empty dict.
    """
    global_params: dict[str, float | int] = {}

    temperature = _read_optional_float(ENV_BENCH_LLM_TEMPERATURE, 0.0, 1.0)
    if temperature is not None:
        global_params["temperature"] = temperature

    top_p = _read_optional_float(ENV_BENCH_LLM_TOP_P, 0.0, 1.0)
    if top_p is not None:
        global_params["top_p"] = top_p

    top_k = _read_optional_int(ENV_BENCH_LLM_TOP_K)
    if top_k is not None:
        global_params["top_k"] = top_k

    max_tokens = _read_optional_int(ENV_BENCH_LLM_MAX_TOKENS)
    if max_tokens is not None:
        global_params["max_tokens"] = max_tokens

    return global_params, {}
