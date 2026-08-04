"""Unit tests for bench_config — retry policy helpers and LLM params."""

from __future__ import annotations

import pytest

from bench_config import (
    DEFAULT_WORKFLOW_EXTENSION,
    is_kimchi_family,
    is_multi_model,
    is_retryable,
    is_workflow_agent,
    load_llm_params,
    parse_model,
)
from outcome import Outcome


def test_concrete_model_is_the_default_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MODEL", raising=False)

    assert is_multi_model() is False
    assert parse_model() == ("kimchi-dev", "minimax-m3")


def test_explicit_multi_model_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL", "multi-model")

    assert is_multi_model() is True
    assert parse_model() == ("kimchi", "multi-model")


@pytest.mark.parametrize(
    ("outcome", "error_category", "error_subcategory", "env_value", "expected"),
    [
        # Agent timeouts: follow the env flag (default is false)
        (Outcome.AGENT_TIMEOUT, None,    None,                       None,    False),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "true",  True),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "false", False),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "1",     True),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "yes",   True),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "0",     False),
        # Infra errors: retryable regardless of the flag, except terminal infra causes.
        (Outcome.ERROR,         "infra", None,                       "false", True),
        (Outcome.ERROR,         "infra", "kimchi_infra_exit",        "true",  True),
        (Outcome.ERROR,         "infra", "api_key_budget_exceeded",  "true",  False),
        (Outcome.ERROR,         "infra", "api_key_budget_exceeded",  "false", False),
        # Quality / other errors: never retryable
        (Outcome.ERROR,         "quality", None,                     "true",  False),
        (Outcome.ERROR,         None,      None,                     "true",  False),
        # Pass / scored-fail: never retryable
        (Outcome.SCORED_PASS,   None,    None,                       "true",  False),
        (Outcome.SCORED_FAIL,   None,    None,                       "true",  False),
    ],
)
def test_is_retryable(
    outcome: Outcome,
    error_category: str | None,
    error_subcategory: str | None,
    env_value: str,
    expected: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if env_value is None:
        monkeypatch.delenv("BENCH_RETRY_AGENT_TIMEOUT", raising=False)
    else:
        monkeypatch.setenv("BENCH_RETRY_AGENT_TIMEOUT", env_value)
    assert is_retryable(outcome, error_category, error_subcategory) is expected


# ---------------------------------------------------------------------------
# LLM sampling parameter loading — individual typed env vars
# ---------------------------------------------------------------------------

def _clear_llm_env(monkeypatch):
    for var in ("BENCH_LLM_TEMPERATURE", "BENCH_LLM_TOP_P", "BENCH_LLM_TOP_K", "BENCH_LLM_MAX_TOKENS"):
        monkeypatch.delenv(var, raising=False)


def test_load_llm_params_all_unset(monkeypatch):
    _clear_llm_env(monkeypatch)
    global_params, per_model = load_llm_params()
    assert global_params == {}
    assert per_model == {}


def test_load_llm_params_all_zero_sentinel(monkeypatch):
    """Zero is the 'not set' sentinel from the CI form default=0."""
    monkeypatch.setenv("BENCH_LLM_TEMPERATURE", "0")
    monkeypatch.setenv("BENCH_LLM_TOP_P", "0")
    monkeypatch.setenv("BENCH_LLM_TOP_K", "0")
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "0")
    global_params, per_model = load_llm_params()
    assert global_params == {}
    assert per_model == {}


def test_load_llm_params_temperature(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TEMPERATURE", "1.0")
    global_params, _ = load_llm_params()
    assert global_params == {"temperature": 1.0}


def test_load_llm_params_top_p(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TOP_P", "0.95")
    global_params, _ = load_llm_params()
    assert global_params == {"top_p": 0.95}


def test_load_llm_params_top_k(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TOP_K", "40")
    global_params, _ = load_llm_params()
    assert global_params == {"top_k": 40}


def test_load_llm_params_max_tokens(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "4096")
    global_params, _ = load_llm_params()
    assert global_params == {"max_tokens": 4096}


def test_load_llm_params_all_set(monkeypatch):
    monkeypatch.setenv("BENCH_LLM_TEMPERATURE", "1.0")
    monkeypatch.setenv("BENCH_LLM_TOP_P", "0.95")
    monkeypatch.setenv("BENCH_LLM_TOP_K", "40")
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "4096")
    global_params, per_model = load_llm_params()
    assert global_params == {"temperature": 1.0, "top_p": 0.95, "top_k": 40, "max_tokens": 4096}
    assert per_model == {}


def test_load_llm_params_gitlab_number_trailing_zero(monkeypatch):
    """GitLab number inputs may arrive as '40.0' for integers."""
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TOP_K", "40.0")
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "4096.0")
    global_params, _ = load_llm_params()
    assert global_params == {"top_k": 40, "max_tokens": 4096}


@pytest.mark.parametrize(
    ("env_var", "value", "expected_substring"),
    [
        ("BENCH_LLM_TEMPERATURE", "1.5",   "out of range"),
        ("BENCH_LLM_TEMPERATURE", "-0.1",  "out of range"),
        ("BENCH_LLM_TEMPERATURE", "hot",   "not a valid number"),
        ("BENCH_LLM_TOP_P",       "1.01",  "out of range"),
        ("BENCH_LLM_TOP_P",       "bad",   "not a valid number"),
        ("BENCH_LLM_TOP_K",       "-1",    "positive integer"),
        ("BENCH_LLM_TOP_K",       "abc",   "not a valid integer"),
        ("BENCH_LLM_MAX_TOKENS",  "-100",  "positive integer"),
        ("BENCH_LLM_MAX_TOKENS",  "x",     "not a valid integer"),
    ],
)
def test_load_llm_params_invalid(env_var, value, expected_substring, monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv(env_var, value)
    with pytest.raises(ValueError, match=expected_substring):
        load_llm_params()


@pytest.mark.parametrize(
    "coding_agent,kimchi_family,workflow_agent",
    [
        ("kimchi", True, False),
        ("kimchi-workflow", True, True),
        # Runs the same extension and workflows, but on stock pi — takes the
        # workflow kwargs and none of kimchi's (no llm-params, no compaction).
        ("pi-workflow", False, True),
        ("pi", False, False),
        ("opencode", False, False),
        ("claude-code", False, False),
        # near-misses must not be mistaken for the workflow agent
        ("kimchi-workflows", False, False),
        ("pi-workflows", False, False),
        ("workflow", False, False),
    ],
)
def test_agent_family_classification(
    coding_agent: str, kimchi_family: bool, workflow_agent: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CODING_AGENT", coding_agent)

    assert is_kimchi_family() is kimchi_family
    assert is_workflow_agent() is workflow_agent
    # the explicit argument takes precedence over the environment
    assert is_kimchi_family(coding_agent) is kimchi_family
    assert is_workflow_agent(coding_agent) is workflow_agent


def test_agent_family_defaults_to_kimchi_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CODING_AGENT", raising=False)

    assert is_kimchi_family() is True
    assert is_workflow_agent() is False


def test_default_workflow_extension_names_a_version_or_dist_tag() -> None:
    """A bare package name resolves through npm's `*` range, which excludes
    prereleases — and every published engine version is one, so a bare default
    fails at agent setup with ETARGET rather than at pipeline configuration."""
    spec = DEFAULT_WORKFLOW_EXTENSION.removeprefix("npm:")
    # Scoped name, so the version separator is the "@" after the scope's "/".
    assert spec.startswith("@")
    assert spec.find("@", spec.index("/")) != -1, f"{DEFAULT_WORKFLOW_EXTENSION} must carry @<version-or-tag>"
