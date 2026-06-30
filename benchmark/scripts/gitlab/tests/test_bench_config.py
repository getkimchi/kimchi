"""Unit tests for bench_config — retry policy helpers and LLM params."""

from __future__ import annotations

import pytest

from bench_config import is_retryable, load_llm_params
from outcome import Outcome


@pytest.mark.parametrize(
    ("outcome", "error_category", "env_value", "expected"),
    [
        # Agent timeouts: follow the env flag (default is false)
        (Outcome.AGENT_TIMEOUT, None,    None,    False),
        (Outcome.AGENT_TIMEOUT, None,    "true",  True),
        (Outcome.AGENT_TIMEOUT, None,    "false", False),
        (Outcome.AGENT_TIMEOUT, None,    "1",     True),
        (Outcome.AGENT_TIMEOUT, None,    "yes",   True),
        (Outcome.AGENT_TIMEOUT, None,    "0",     False),
        # Infra errors: always retryable regardless of the flag
        (Outcome.ERROR,         "infra", "false", True),
        (Outcome.ERROR,         "infra", "true",  True),
        # Quality / other errors: never retryable
        (Outcome.ERROR,         "quality", "true", False),
        (Outcome.ERROR,         None,      "true", False),
        # Pass / scored-fail: never retryable
        (Outcome.SCORED_PASS,   None,    "true",  False),
        (Outcome.SCORED_FAIL,   None,    "true",  False),
    ],
)
def test_is_retryable(
    outcome: Outcome,
    error_category: str | None,
    env_value: str,
    expected: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if env_value is None:
        monkeypatch.delenv("BENCH_RETRY_AGENT_TIMEOUT", raising=False)
    else:
        monkeypatch.setenv("BENCH_RETRY_AGENT_TIMEOUT", env_value)
    assert is_retryable(outcome, error_category) is expected


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
