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

# PiWorkflowAgent runs the same extension and workflows on stock pi — so it
# takes the workflow kwargs but none of kimchi's (no llm-sampling-params
# extension, no compaction). Passing either would fail at `harbor run`.
PI_WORKFLOW_CODING_AGENT = "pi-workflow"

WORKFLOW_CODING_AGENTS = (WORKFLOW_CODING_AGENT, PI_WORKFLOW_CODING_AGENT)


def is_kimchi_family(coding_agent: str | None = None) -> bool:
    """Return whether the selected agent is Kimchi or a subclass of it."""
    selected = coding_agent if coding_agent is not None else os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    return selected in (DEFAULT_CODING_AGENT, WORKFLOW_CODING_AGENT)


def is_workflow_agent(coding_agent: str | None = None) -> bool:
    """Whether the selected agent runs a kimchi-workflows workflow (kimchi or pi hosted)."""
    selected = coding_agent if coding_agent is not None else os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    return selected in WORKFLOW_CODING_AGENTS


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

# --- Execution engine ---
# When true, chunk_runner uses Pier (harbor fork) instead of Harbor.
# DeepSWE tasks require Pier for pre_artifacts.sh and air-gapped allowlists.
ENV_USE_PIER = "USE_PIER"
DEFAULT_USE_PIER = False

ENV_DEEP_SWE_TASKS_PATH = "DEEP_SWE_TASKS_PATH"
DEFAULT_DEEP_SWE_TASKS_PATH = "/tmp/deep-swe/tasks"


def use_pier() -> bool:
    """Return whether the current run should use Pier instead of Harbor."""
    return os.environ.get(ENV_USE_PIER, str(DEFAULT_USE_PIER)).lower() == "true"

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

# --- Durable checkpointing (per-trial GCS checkpoints) ---
# When true, completed trials are uploaded to GCS as they finish and restored
# at chunk startup, so a killed chunk loses no durable trial (Phase 1-7).
ENV_BENCH_TRIAL_CHECKPOINTS = "BENCH_TRIAL_CHECKPOINTS"
DEFAULT_BENCH_TRIAL_CHECKPOINTS = "false"

# GCS bucket used exclusively for per-trial checkpoints. Distinct from the
# final results bucket so checkpoint writes can never collide with the
# published jobs.tar.gz namespace. Set as a CI/CD variable in GitLab project
# settings (not a pipeline input) so it is shared across all benchmark pipelines.
ENV_BENCH_CHECKPOINT_BUCKET = "BENCH_CHECKPOINT_BUCKET"
DEFAULT_BENCH_CHECKPOINT_BUCKET = ""

# GitLab job timeout in seconds. The soft deadline is computed as a fraction of
# this value, leaving the remainder for checkpoint drain before GitLab's hard
# kill. Set per benchmark in the CI YAML (12h for terminal-bench, 24h for
# swe-bench-pro).
ENV_BENCH_JOB_TIMEOUT_SECONDS = "BENCH_JOB_TIMEOUT_SECONDS"
DEFAULT_BENCH_JOB_TIMEOUT_SECONDS = "43200"  # 12h (terminal-bench-2)

# The soft deadline fires at this fraction of the job timeout, leaving the
# remainder for the checkpoint drain cascade (SIGINT → SIGTERM → SIGKILL).
# 0.96 of 12h = ~11h31m, leaving ~29 min for drain (default grace: 5 min).
CHECKPOINT_SOFT_DEADLINE_RATIO = 0.96

# Retry budget for a single checkpoint object. A code constant, not
# configurable via env: the value is tuned for GCS transient-failure rates and
# should only change with a deliberate code review. Failure after this many
# attempts is an infrastructure failure that stops unprotected benchmark
# spending (Phase 3 failure policy).
CHECKPOINT_UPLOAD_RETRIES = 5

# --- Task selection ---
ENV_SELECTED_TASKS_JSON = "SELECTED_TASKS_JSON"
DEFAULT_SELECTED_TASKS_JSON = "[]"

ENV_BENCH_TASKS_ALL = "BENCH_TASKS_ALL"
DEFAULT_BENCH_TASKS_ALL = "false"

# --- Retry behavior ---
ENV_BENCH_RETRY_AGENT_TIMEOUT = "BENCH_RETRY_AGENT_TIMEOUT"
DEFAULT_BENCH_RETRY_AGENT_TIMEOUT = False
NON_RETRYABLE_INFRA_SUBCATEGORIES = frozenset({"api_key_budget_exceeded"})


def checkpoints_enabled() -> bool:
    """Return True when per-trial GCS checkpointing is active for this run.

    Reads $BENCH_TRIAL_CHECKPOINTS at call time so test fixtures can override it.
    """
    raw = os.environ.get(ENV_BENCH_TRIAL_CHECKPOINTS, DEFAULT_BENCH_TRIAL_CHECKPOINTS).strip().lower()
    return raw in ("true", "1", "yes")


def checkpoint_bucket() -> str:
    """Return the GCS bucket used for per-trial checkpoints (empty if unset)."""
    return os.environ.get(ENV_BENCH_CHECKPOINT_BUCKET, DEFAULT_BENCH_CHECKPOINT_BUCKET)


def checkpoint_soft_deadline_seconds() -> int:
    """Return the soft chunk deadline, computed from the GitLab job timeout.

    The deadline is ``BENCH_JOB_TIMEOUT_SECONDS * CHECKPOINT_SOFT_DEADLINE_RATIO``,
    leaving the remainder for the checkpoint drain cascade before GitLab's
    hard kill.
    """
    raw = os.environ.get(
        ENV_BENCH_JOB_TIMEOUT_SECONDS,
        DEFAULT_BENCH_JOB_TIMEOUT_SECONDS,
    )
    try:
        job_timeout = int(float(raw))
    except ValueError:
        raise ValueError(
            f"{ENV_BENCH_JOB_TIMEOUT_SECONDS}={raw!r} is not a valid integer"
        ) from None
    if job_timeout <= 0:
        raise ValueError(
            f"{ENV_BENCH_JOB_TIMEOUT_SECONDS}={job_timeout} must be a positive integer"
        )
    return int(job_timeout * CHECKPOINT_SOFT_DEADLINE_RATIO)


def checkpoint_upload_retries() -> int:
    """Return the fixed retry budget for a single checkpoint upload."""
    return CHECKPOINT_UPLOAD_RETRIES


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

# --- Thinking / reasoning level ---
ENV_THINKING_LEVEL = "THINKING_LEVEL"
DEFAULT_THINKING_LEVEL = "default"
THINKING_LEVELS = frozenset({"off", "minimal", "low", "medium", "high", "xhigh", "max"})

# Agents that accept the --thinking CLI flag (kimchi and pi families).
# opencode wraps an external tool that does not use pi-ai's thinking-level
# mechanism, so the level is dropped for it.
PI_CODING_AGENT = "pi"
# Agents hosted by upstream pi. PiWorkflowAgent subclasses PiKimchi, so both
# take --thinking through the same CliFlag.
PI_THINKING_AGENTS = frozenset({PI_CODING_AGENT, PI_WORKFLOW_CODING_AGENT})
_THINKING_CAPABLE_AGENTS = frozenset(
    {DEFAULT_CODING_AGENT, WORKFLOW_CODING_AGENT, *PI_THINKING_AGENTS}
)

# Claude Code spells the same idea as reasoning effort: `--effort <level>`,
# accepting low/medium/high/xhigh/max. CLI 2.1.x has no flag to disable
# thinking, so off/minimal have no equivalent — they are rejected rather than
# silently rounded up to low, which would report a level the run never used.
CLAUDE_CODE_CODING_AGENT = "claude-code"
CLAUDE_CODE_STANDARD_CODING_AGENT = "claude-code-standard"
# Both Claude Code agents map thinking levels to --effort. The standard agent
# extends the Kimchi one, so both share the same effort level set.
CLAUDE_CODE_EFFORT_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})


def resolve_thinking_level(coding_agent: str | None = None) -> str | None:
    """Return a fixed thinking level for this run, or None for the harness default.

    Reads ``$THINKING_LEVEL`` at call time so test fixtures can override it.
    'default' (the CI default) means "let the harness choose dynamically" and
    returns None so no ``--thinking`` flag is passed to the agent.

    Raises ``ValueError`` on an unrecognized level, or on a level the selected
    agent cannot express, so a bad CI input fails the run loudly instead of
    silently benchmarking at a level nobody asked for.
    """
    raw = os.environ.get(ENV_THINKING_LEVEL, DEFAULT_THINKING_LEVEL).strip().lower()
    if raw == DEFAULT_THINKING_LEVEL or raw == "":
        return None
    if raw not in THINKING_LEVELS:
        raise ValueError(
            f"{ENV_THINKING_LEVEL}={raw!r} is not a valid thinking level; "
            f"expected one of: default, {', '.join(sorted(THINKING_LEVELS))}"
        )
    agent = coding_agent if coding_agent is not None else os.environ.get(ENV_CODING_AGENT, DEFAULT_CODING_AGENT)
    if agent in (CLAUDE_CODE_CODING_AGENT, CLAUDE_CODE_STANDARD_CODING_AGENT):
        if raw not in CLAUDE_CODE_EFFORT_LEVELS:
            raise ValueError(
                f"{ENV_THINKING_LEVEL}={raw!r} has no equivalent for "
                f"{ENV_CODING_AGENT}={agent}; Claude Code's --effort accepts: "
                f"{', '.join(sorted(CLAUDE_CODE_EFFORT_LEVELS))} (or 'default')"
            )
        return raw
    if agent not in _THINKING_CAPABLE_AGENTS:
        return None
    return raw


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
