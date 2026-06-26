"""Unit tests for bench_config — retry policy helpers."""

from __future__ import annotations

import pytest

from bench_config import is_retryable
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
