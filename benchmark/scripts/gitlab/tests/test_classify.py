"""Unit tests for classify.py — infra/quality verdict classification."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

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
    assert verdict.raw["agent_timeout_analysis"]["timeout_status"] == "unknown"


def _write_session(trial_dir: Path, entries: list[dict]) -> None:
    session_dir = trial_dir / "agent" / "sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    with (session_dir / "main.jsonl").open("w", encoding="utf-8") as fh:
        for e in entries:
            fh.write(json.dumps(e) + "\n")


def _agent_timeout_payload(occurred_at: str) -> dict:
    return {
        "exception_info": {
            "exception_type": "AgentTimeoutError",
            "exception_message": "Agent execution timed out after 900.0 seconds",
            "occurred_at": occurred_at,
        }
    }


def test_agent_timeout_analysis_inference_hang(tmp_results_dir: Path) -> None:
    """Last message was a toolResult long before the timeout → model API hang."""
    trial = tmp_results_dir / "run-1" / "task-timeout-inference__1"
    _write_result(trial, _agent_timeout_payload("2026-06-25T12:30:00.000000Z"))
    _write_session(
        trial,
        [
            {"type": "message", "timestamp": "2026-06-25T12:00:00.000000Z", "message": {"role": "user"}},
            {"type": "message", "timestamp": "2026-06-25T12:05:00.000000Z", "message": {"role": "assistant"}},
            {"type": "message", "timestamp": "2026-06-25T12:20:00.000000Z", "message": {"role": "toolResult"}},
        ],
    )
    verdict = classify(trial)
    analysis = verdict.raw["agent_timeout_analysis"]
    assert verdict.outcome == "agent_timeout"
    assert verdict.error_subcategory is None
    assert analysis["timeout_status"] == "inference_hang"
    assert analysis["last_role"] == "toolResult"
    assert analysis["time_since_last_message_sec"] == pytest.approx(600.0)


def test_agent_timeout_analysis_tool_hang(tmp_results_dir: Path) -> None:
    """Last LLM call dispatched a non-Agent tool long before the timeout → tool hang."""
    trial = tmp_results_dir / "run-1" / "task-timeout-tool__1"
    _write_result(trial, _agent_timeout_payload("2026-06-25T12:30:00.000000Z"))
    _write_session(
        trial,
        [
            {
                "type": "message",
                "timestamp": "2026-06-25T11:50:00.000000Z",
                "message": {"role": "user"},
            },
            {
                "type": "message",
                "timestamp": "2026-06-25T11:55:00.000000Z",
                "message": {"role": "toolResult"},
            },
            {
                "type": "message",
                "timestamp": "2026-06-25T12:00:00.000000Z",
                "message": {"role": "assistant"},
            },
            {
                "customType": "llm_response_debug",
                "timestamp": "2026-06-25T12:00:01.000000Z",
                "data": {"toolCalls": [{"name": "bash"}]},
            },
        ],
    )
    verdict = classify(trial)
    analysis = verdict.raw["agent_timeout_analysis"]
    assert verdict.outcome == "agent_timeout"
    assert verdict.error_subcategory is None
    assert analysis["timeout_status"] == "tool_hang"


def test_agent_timeout_analysis_agent_in_flight(tmp_results_dir: Path) -> None:
    """Last LLM call dispatched the Agent tool → parent waiting on subagent."""
    trial = tmp_results_dir / "run-1" / "task-timeout-agent__1"
    _write_result(trial, _agent_timeout_payload("2026-06-25T12:30:00.000000Z"))
    _write_session(
        trial,
        [
            {
                "type": "message",
                "timestamp": "2026-06-25T11:50:00.000000Z",
                "message": {"role": "user"},
            },
            {
                "type": "message",
                "timestamp": "2026-06-25T11:55:00.000000Z",
                "message": {"role": "toolResult"},
            },
            {
                "type": "message",
                "timestamp": "2026-06-25T12:00:00.000000Z",
                "message": {"role": "assistant"},
            },
            {
                "customType": "llm_response_debug",
                "timestamp": "2026-06-25T12:00:01.000000Z",
                "data": {"toolCalls": [{"name": "Agent"}]},
            },
        ],
    )
    verdict = classify(trial)
    analysis = verdict.raw["agent_timeout_analysis"]
    assert verdict.outcome == "agent_timeout"
    assert verdict.error_subcategory is None
    assert analysis["timeout_status"] == "agent_in_flight"


def test_agent_timeout_analysis_few_turns(tmp_results_dir: Path) -> None:
    """Barely-started sessions are classified as few_turns regardless of last role."""
    trial = tmp_results_dir / "run-1" / "task-timeout-few__1"
    _write_result(trial, _agent_timeout_payload("2026-06-25T12:30:00.000000Z"))
    _write_session(
        trial,
        [
            {"type": "message", "timestamp": "2026-06-25T12:29:00.000000Z", "message": {"role": "user"}},
        ],
    )
    verdict = classify(trial)
    analysis = verdict.raw["agent_timeout_analysis"]
    assert verdict.outcome == "agent_timeout"
    assert verdict.error_subcategory is None
    assert analysis["timeout_status"] == "few_turns"


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


# ── error/infra — API key budget (direct, agent exits non-zero) ──────────────────

def test_anthropic_spend_limit_in_captured_stdout_is_api_key_budget(tmp_results_dir: Path) -> None:
    """Anthropic 429 'spend limit' captured in agent stdout → api_key_budget_exceeded."""
    trial = tmp_results_dir / "run-1" / "task-budget__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": (
                    "Command failed (exit 1): /installed-agent/bin/kimchi "
                    "--print --session /logs/agent/sessions/main.jsonl "
                    "--dangerously-skip-permissions\n"
                    'stdout: 429 "API key has reached its spend limit.\\n'
                    "Increase the budget in the console or contact your "
                    'organization admin to continue."\\n'
                ),
            }
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "api_key_budget_exceeded"


def test_insufficient_credits_is_api_key_budget(tmp_results_dir: Path) -> None:
    """Variant wording used by some providers → same subcategory."""
    trial = tmp_results_dir / "run-1" / "task-credits__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": "API error: insufficient credits to complete request",
            }
        },
    )

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "api_key_budget_exceeded"


# ── error/infra — API key budget (agent timed out because of budget) ─────────────

_BUDGET_ERROR_EXACT_MESSAGE = (
    '429 "API key has reached its spend limit.\\n'
    'Increase the budget in the console or contact your '
    'organization admin to continue."'
)


def _write_session_message_errorMessage(trial: Path, error_message: object) -> None:
    """Write a session jsonl containing one assistant message with the given errorMessage."""
    sessions = trial / "agent" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / "main.jsonl").write_text(
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "stopReason": "error",
                    "errorMessage": error_message,
                },
            }
        )
        + "\n"
    )


def test_agent_timeout_with_exact_budget_error_message_is_api_key_budget(tmp_results_dir: Path) -> None:
    """AgentTimeoutError + exact anthropic 429 errorMessage → ERROR/infra/api_key_budget_exceeded.

    Matches the actual production shape: a `type: message` entry with the verbatim provider
    errorMessage. Any deviation (substring, variant wording, extra whitespace) keeps the trial
    as agent_timeout.
    """
    trial = tmp_results_dir / "run-1" / "task-budget-timeout__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            }
        },
    )
    _write_session_message_errorMessage(trial, _BUDGET_ERROR_EXACT_MESSAGE)

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "api_key_budget_exceeded"


def test_agent_timeout_with_similar_budget_message_stays_agent_timeout(tmp_results_dir: Path) -> None:
    """A near-miss errorMessage (extra whitespace, lower-case, substring only) must not match.

    Validates the exact-match contract: only the verbatim provider body triggers the
    classification.
    """
    trial = tmp_results_dir / "run-1" / "task-budget-near-miss__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            }
        },
    )
    # Substring only (no 429 prefix, no closing quote) — must not match.
    _write_session_message_errorMessage(
        trial,
        "api key has reached its spend limit",
    )

    verdict = classify(trial)

    assert verdict.outcome == "agent_timeout"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None


def test_agent_timeout_with_non_string_error_message_stays_agent_timeout(tmp_results_dir: Path) -> None:
    """errorMessage that is not a string (e.g. null) must not match the exact string."""
    trial = tmp_results_dir / "run-1" / "task-budget-null__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            }
        },
    )
    _write_session_message_errorMessage(trial, None)

    verdict = classify(trial)

    assert verdict.outcome == "agent_timeout"


def test_agent_timeout_without_budget_error_message_stays_agent_timeout(tmp_results_dir: Path) -> None:
    """An AgentTimeoutError with an unrelated assistant message stays AGENT_TIMEOUT."""
    trial = tmp_results_dir / "run-1" / "task-pure-timeout__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            }
        },
    )
    _write_session_message_errorMessage(trial, "I am working on the task but it is taking a long time...")

    verdict = classify(trial)

    assert verdict.outcome == "agent_timeout"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None


def test_agent_timeout_with_no_sessions_dir_stays_agent_timeout(tmp_results_dir: Path) -> None:
    """An AgentTimeoutError with no agent/sessions/ directory stays AGENT_TIMEOUT."""
    trial = tmp_results_dir / "run-1" / "task-no-sessions__1"
    _write_result(
        trial,
        {"exception_info": {"exception_type": "AgentTimeoutError"}},
    )
    # no sessions dir

    verdict = classify(trial)

    assert verdict.outcome == "agent_timeout"


def test_scored_pass_is_not_refined_by_session_scan(tmp_results_dir: Path) -> None:
    """Sanity: the refinement only runs on AGENT_TIMEOUT — other outcomes are untouched."""
    trial = tmp_results_dir / "run-1" / "task-pass__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 1.0}}})
    # Even with the exact budget errorMessage in sessions, a passing trial stays scored_pass.
    _write_session_message_errorMessage(trial, _BUDGET_ERROR_EXACT_MESSAGE)

    verdict = classify(trial)

    assert verdict.outcome == "scored_pass"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None
