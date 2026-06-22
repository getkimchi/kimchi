"""Unit tests for classify.py — infra/quality verdict classification."""

from __future__ import annotations

import json
from pathlib import Path

from classify import ERROR_RULES, classify
from outcome import Outcome


def _write_result(trial_dir: Path, payload: dict) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps(payload))


# ── scored_pass ───────────────────────────────────────────────────────────────

def test_pass_when_reward_one_and_no_exception(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-a__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 1.0}}})

    verdict = classify(trial)

    assert verdict.outcome == "scored_pass"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None
    assert verdict.reward == 1.0


# ── scored_fail ───────────────────────────────────────────────────────────────

def test_scored_fail_when_reward_zero_and_no_exception(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-b__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 0.0}}})

    verdict = classify(trial)

    assert verdict.outcome == "scored_fail"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None
    assert verdict.reward == 0.0


def test_none_reward_no_exception_is_scored_fail(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-c__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": None}}})

    verdict = classify(trial)

    assert verdict.outcome == "scored_fail"
    assert verdict.error_category is None


# ── agent_timeout ─────────────────────────────────────────────────────────────

def test_agent_timeout_error_is_agent_timeout(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-timeout__1"
    _write_result(trial, {"exception_info": {"exception_type": "AgentTimeoutError"}})

    verdict = classify(trial)

    assert verdict.outcome == "agent_timeout"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None


# ── error/infra — read failures ───────────────────────────────────────────────

def test_missing_result_json_is_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-missing__1"
    trial.mkdir(parents=True)
    v = classify(trial)
    assert v.outcome == "error"
    assert v.error_category == "infra"
    assert v.error_subcategory == "missing_result"


def test_corrupt_result_json_is_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-corrupt__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text("{ not valid json")
    v = classify(trial)
    assert v.outcome == "error"
    assert v.error_category == "infra"
    assert v.error_subcategory == "corrupt_json"


def test_non_dict_result_is_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-nondict__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text("[]")
    v = classify(trial)
    assert v.outcome == "error"
    assert v.error_category == "infra"
    assert v.error_subcategory == "corrupt_json"


def test_empty_result_is_missing_verdict(tmp_results_dir: Path) -> None:
    """{} has no verifier_result and no exception_info → missing_verdict (infra)."""
    trial = tmp_results_dir / "run-1" / "task-empty__1"
    _write_result(trial, {})
    v = classify(trial)
    assert v.outcome == "error"
    assert v.error_category == "infra"
    assert v.error_subcategory == "missing_verdict"


# ── error/infra — internal timeouts ──────────────────────────────────────────

def test_verifier_timeout_error_is_error_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-vtimeout__1"
    _write_result(trial, {"exception_info": {"exception_type": "VerifierTimeoutError"}})

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "verifier_timeout"


def test_agent_setup_timeout_is_error_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-setuptimeout__1"
    _write_result(trial, {"exception_info": {"exception_type": "AgentSetupTimeoutError"}})

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "agent_setup_timeout"


def test_environment_start_timeout_is_error_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-envtimeout__1"
    _write_result(trial, {"exception_info": {"exception_type": "EnvironmentStartTimeoutError"}})

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "environment_setup_timeout"


def test_command_timeout_is_error_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-cmdtimeout__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": "command timed out after 300 seconds",
            }
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "agent_command_timeout"


# ── error/infra — exception type allowlist ────────────────────────────────────

def test_connection_error_is_infra_network(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-conn__1"
    _write_result(trial, {"exception_info": {"exception_type": "ConnectionError"}})

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "infra_network_error"


def test_oomkilled_is_infra_container(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-oom__1"
    _write_result(trial, {"exception_info": {"exception_type": "OOMKilled"}})

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "infra_container_error"


def test_infra_exception_in_allowlist(tmp_results_dir: Path) -> None:
    """Any INFRA_EXCEPTION_TYPES exception maps to error/infra."""
    trial = tmp_results_dir / "run-1" / "task-d__1"
    _write_result(
        trial,
        {
            "verifier_result": {"rewards": {"reward": 0.0}},
            "exception_info": {"exception_type": "SSLError"},
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "infra_network_error"


# ── error/infra — text-pattern rules ─────────────────────────────────────────

def test_non_zero_exit_infra_marker_is_error_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-nzeinfra__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": "request was aborted by the server",
            }
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "agent_request_aborted"


def test_agent_process_killed_exit_137_is_error_infra(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-exit137__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": "Command failed (exit 137): /installed-agent/bin/kimchi",
            }
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "agent_process_killed"


# ── error/quality ─────────────────────────────────────────────────────────────

def test_quality_exception_not_in_allowlist_is_error_quality(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-e__1"
    _write_result(
        trial,
        {
            "verifier_result": {"rewards": {"reward": 0.0}},
            "exception_info": {"exception_type": "AssertionError"},
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "agent"


def test_stale_extension_context_is_error_quality(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-stale__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": "error: This extension ctx is stale after session replacement",
            }
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "agent"
    assert verdict.error_subcategory == "agent_stale_extension_context"


# ── structural invariants ─────────────────────────────────────────────────────

def test_error_rules_have_no_duplicate_kinds() -> None:
    kinds = [r.kind for r in ERROR_RULES]
    assert len(kinds) == len(set(kinds)), f"Duplicate kinds: {[k for k in kinds if kinds.count(k) > 1]}"


def test_error_rules_outcomes_are_consistent() -> None:
    """All AGENT_TIMEOUT rules have null error_category; all ERROR rules have infra or quality."""
    for rule in ERROR_RULES:
        if rule.outcome == Outcome.AGENT_TIMEOUT:
            assert rule.error_category is None, f"{rule.kind}: AGENT_TIMEOUT should have no error_category"
        elif rule.outcome == Outcome.ERROR:
            assert rule.error_category in ("infra", "agent"), (
                f"{rule.kind}: ERROR outcome must have infra or quality category, got {rule.error_category!r}"
            )
