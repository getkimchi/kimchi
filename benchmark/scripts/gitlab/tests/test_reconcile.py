"""Tests for reconcile.py — attempt-aware TaskProgress (Phase 5).

Covers the "attempt reconciliation for zero through five completed trials" and
"retryable infrastructure outcomes" acceptance criteria.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from outcome import Outcome
from reconcile import (
    compute_chunk_progress,
    compute_task_progress,
    is_chunk_complete,
    missing_tasks,
)


def _write_trial(trial_dir: Path, *, outcome: Outcome = Outcome.SCORED_PASS,
                 error_category: str | None = None, error_subcategory: str | None = None,
                 reward: float | None = 1.0,
                 exception_type: str | None = None,
                 exception_message: str | None = None) -> None:
    """Write a trial result.json that classify() will resolve to ``outcome``.

    classify() re-derives the outcome from verifier_result + exception_info
    (it does NOT respect a pre-set ``outcome`` field), so for ERROR/AGENT_TIMEOUT
    trials we write a real ``exception_info`` block that the classification
    rules match on.
    """
    trial_dir.mkdir(parents=True, exist_ok=True)
    payload: dict = {}
    if reward is not None and outcome in {Outcome.SCORED_PASS, Outcome.SCORED_FAIL}:
        payload["verifier_result"] = {"rewards": {"reward": reward}}
    if exception_type is not None:
        payload["exception_info"] = {
            "exception_type": exception_type,
            "exception_message": exception_message or "",
            "exception_traceback": "",
            "occurred_at": "2026-01-01T00:00:00Z",
        }
    (trial_dir / "result.json").write_text(json.dumps(payload))
    (trial_dir / "trial.log").write_text("")


def test_zero_completed_trials_all_missing(tmp_path: Path) -> None:
    progress = compute_task_progress(
        task="task-a", trial_dirs=[], target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.durable_final_trials == 0
    assert progress.retryable_trials == 0
    assert progress.missing_trials == 5
    assert not progress.complete


def test_five_final_trials_complete(tmp_path: Path) -> None:
    trial_dirs = []
    for i in range(5):
        d = tmp_path / f"task-a__{i}"
        _write_trial(d, outcome=Outcome.SCORED_PASS, reward=1.0)
        trial_dirs.append(d)
    progress = compute_task_progress(
        task="task-a", trial_dirs=trial_dirs, target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.durable_final_trials == 5
    assert progress.missing_trials == 0
    assert progress.complete


def test_mixed_pass_and_fail_both_fill_slots(tmp_path: Path) -> None:
    d1, d2 = tmp_path / "task-a__1", tmp_path / "task-a__2"
    _write_trial(d1, outcome=Outcome.SCORED_PASS, reward=1.0)
    _write_trial(d2, outcome=Outcome.SCORED_FAIL, reward=0.0)
    progress = compute_task_progress(
        task="task-a", trial_dirs=[d1, d2], target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.durable_final_trials == 2
    assert progress.missing_trials == 3


def test_retryable_trial_does_not_fill_slot(tmp_path: Path) -> None:
    d = tmp_path / "task-a__1"
    _write_trial(d, outcome=Outcome.ERROR, error_category="infra",
                 error_subcategory="agent_process_killed", reward=0.0,
                 exception_type="ConnectionError",
                 exception_message="connection reset by peer")
    progress = compute_task_progress(
        task="task-a", trial_dirs=[d], target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.retryable_trials == 1
    assert progress.durable_final_trials == 0
    assert progress.missing_trials == 5


def test_retryable_exhausted_fills_slot(tmp_path: Path) -> None:
    """On the final chunk attempt, retryable infra trials are terminal."""
    d = tmp_path / "task-a__1"
    _write_trial(d, outcome=Outcome.ERROR, error_category="infra",
                 error_subcategory="agent_process_killed", reward=0.0,
                 exception_type="ConnectionError",
                 exception_message="connection reset by peer")
    progress = compute_task_progress(
        task="task-a", trial_dirs=[d], target_trials=5, retry_budget_exhausted=True,
    )
    assert progress.exhausted_retryable_trials == 1
    assert progress.missing_trials == 4


@pytest.mark.parametrize(
    ("retry_budget_exhausted", "expected_exhausted", "expected_missing"),
    [(False, 0, 1), (True, 1, 0)],
)
def test_cancelled_checkpoint_follows_retry_exhaustion_semantics(
    tmp_path: Path,
    retry_budget_exhausted: bool,
    expected_exhausted: int,
    expected_missing: int,
) -> None:
    cancelled = tmp_path / "task-a__cancelled"
    _write_trial(
        cancelled,
        outcome=Outcome.ERROR,
        reward=None,
        exception_type="CancelledError",
        exception_message="",
    )

    progress = compute_task_progress(
        task="task-a",
        trial_dirs=[cancelled],
        target_trials=1,
        retry_budget_exhausted=retry_budget_exhausted,
    )

    assert progress.durable_final_trials == 0
    assert progress.retryable_trials == 1
    assert progress.exhausted_retryable_trials == expected_exhausted
    assert progress.missing_trials == expected_missing


def test_budget_exhausted_clamps_filled_to_target(tmp_path: Path) -> None:
    """Exhausted retryable trials never push the filled count above target."""
    trial_dirs = []
    for i in range(6):
        d = tmp_path / f"task-a__{i}"
        _write_trial(d, outcome=Outcome.ERROR, error_category="infra",
                     error_subcategory="agent_process_killed", reward=0.0,
                     exception_type="ConnectionError",
                     exception_message="connection reset by peer")
        trial_dirs.append(d)
    progress = compute_task_progress(
        task="task-a", trial_dirs=trial_dirs, target_trials=5, retry_budget_exhausted=True,
    )
    assert progress.missing_trials == 0
    assert progress.complete


def test_non_retryable_error_fills_slot(tmp_path: Path) -> None:
    """A quality/agent error is terminal benchmark evidence, not missing data."""
    d = tmp_path / "task-a__1"
    # No verifier result, no exception → classify() returns missing_verdict,
    # which is infra/retryable. Use an unknown exception type to land on the
    # generic agent-quality path (phase_failed), which is non-retryable.
    _write_trial(d, outcome=Outcome.ERROR, error_category="agent",
                 error_subcategory="environment_error", reward=0.0,
                 exception_type="SomeUnknownAgentError",
                 exception_message="failed to resolve user")
    progress = compute_task_progress(
        task="task-a", trial_dirs=[d], target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.durable_final_trials == 1
    assert progress.retryable_trials == 0
    assert progress.missing_trials == 4


def test_missing_trials_never_negative(tmp_path: Path) -> None:
    """More durable trials than target (defensive) yields zero, not negative."""
    trial_dirs = []
    for i in range(7):
        d = tmp_path / f"task-a__{i}"
        _write_trial(d, outcome=Outcome.SCORED_PASS, reward=1.0)
        trial_dirs.append(d)
    progress = compute_task_progress(
        task="task-a", trial_dirs=trial_dirs, target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.missing_trials == 0


def test_chunk_progress_and_missing_tasks(tmp_path: Path) -> None:
    """compute_chunk_progress aggregates across tasks; missing_tasks filters."""
    a1 = tmp_path / "task-a__1"
    _write_trial(a1, outcome=Outcome.SCORED_PASS, reward=1.0)
    progress = compute_chunk_progress(
        task_to_trial_dirs={"task-a": [a1], "task-b": []},
        target_trials=1, retry_budget_exhausted=False,
    )
    assert len(progress) == 2
    # task-a has its 1/1 target trial → complete; task-b has none → missing.
    assert is_chunk_complete(progress) is False
    assert missing_tasks(progress) == ["task-b"]


def test_chunk_complete_when_all_tasks_complete(tmp_path: Path) -> None:
    a1 = tmp_path / "task-a__1"
    _write_trial(a1, outcome=Outcome.SCORED_PASS, reward=1.0)
    progress = compute_chunk_progress(
        task_to_trial_dirs={"task-a": [a1]}, target_trials=1, retry_budget_exhausted=False,
    )
    assert is_chunk_complete(progress) is True
    assert missing_tasks(progress) == []


def test_agent_timeout_terminal_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """AgentTimeoutError is terminal (not retried) when retry_agent_timeout=false."""
    monkeypatch.delenv("BENCH_RETRY_AGENT_TIMEOUT", raising=False)
    d = tmp_path / "task-a__1"
    _write_trial(d, outcome=Outcome.AGENT_TIMEOUT, reward=0.0,
                 exception_type="AgentTimeoutError",
                 exception_message="agent execution timed out after 3600 seconds")
    progress = compute_task_progress(
        task="task-a", trial_dirs=[d], target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.retryable_trials == 0
    assert progress.durable_final_trials == 1
    assert progress.missing_trials == 4


def test_agent_timeout_retryable_when_opted_in(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """AgentTimeoutError is retried only when BENCH_RETRY_AGENT_TIMEOUT=true."""
    monkeypatch.setenv("BENCH_RETRY_AGENT_TIMEOUT", "true")
    d = tmp_path / "task-a__1"
    _write_trial(d, outcome=Outcome.AGENT_TIMEOUT, reward=0.0,
                 exception_type="AgentTimeoutError",
                 exception_message="agent execution timed out after 3600 seconds")
    progress = compute_task_progress(
        task="task-a", trial_dirs=[d], target_trials=5, retry_budget_exhausted=False,
    )
    assert progress.retryable_trials == 1
    assert progress.missing_trials == 5
