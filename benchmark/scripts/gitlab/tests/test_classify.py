"""Unit tests for classify.py — infra/quality verdict classification."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from classify import ERROR_RULES, classify
from outcome import Outcome

API_KEY_BUDGET_EXCEEDED = "api_key_budget_exceeded"
_BUDGET_ERROR_EXACT_MESSAGE = (
    '429 "API key has reached its spend limit.\\n'
    "Increase the budget in the console or contact your "
    'organization admin to continue."'
)
_NO_SESSION = object()


def _write_result(trial_dir: Path, payload: dict) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps(payload))


def _reward_payload(reward: float | None) -> dict:
    return {"verifier_result": {"rewards": {"reward": reward}}}


def _exception_payload(
    exception_type: str,
    exception_message: str | None = None,
    *,
    reward: float | None | object = _NO_SESSION,
) -> dict:
    payload = {"exception_info": {"exception_type": exception_type}}
    if exception_message is not None:
        payload["exception_info"]["exception_message"] = exception_message
    if reward is not _NO_SESSION:
        payload["verifier_result"] = {"rewards": {"reward": reward}}
    return payload


def _assert_verdict(verdict, expected: dict) -> None:
    assert verdict.outcome == expected["outcome"]
    if "error_category" in expected:
        assert verdict.error_category == expected["error_category"]
    if "error_subcategory" in expected:
        assert verdict.error_subcategory == expected["error_subcategory"]
    if "reward" in expected:
        assert verdict.reward == expected["reward"]
    if "timeout_status" in expected:
        assert verdict.raw["agent_timeout_analysis"]["timeout_status"] == expected["timeout_status"]


RESULT_JSON_CASES = [
    pytest.param(
        _reward_payload(1.0),
        {"outcome": "scored_pass", "error_category": None, "error_subcategory": None, "reward": 1.0},
        id="scored-pass",
    ),
    pytest.param(
        _reward_payload(0.0),
        {"outcome": "scored_fail", "error_category": None, "error_subcategory": None, "reward": 0.0},
        id="scored-fail",
    ),
    pytest.param(
        _reward_payload(None),
        {"outcome": "scored_fail", "error_category": None},
        id="none-reward-scored-fail",
    ),
    pytest.param(
        _exception_payload("AgentTimeoutError"),
        {
            "outcome": "agent_timeout",
            "error_category": None,
            "error_subcategory": None,
            "timeout_status": "unknown",
        },
        id="agent-timeout",
    ),
    pytest.param(
        {},
        {"outcome": "error", "error_category": "infra", "error_subcategory": "missing_verdict"},
        id="empty-result",
    ),
    pytest.param(
        _exception_payload("VerifierTimeoutError"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "verifier_timeout"},
        id="verifier-timeout",
    ),
    pytest.param(
        _exception_payload("AgentSetupTimeoutError"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "agent_setup_timeout"},
        id="agent-setup-timeout",
    ),
    pytest.param(
        _exception_payload("EnvironmentStartTimeoutError"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "environment_setup_timeout"},
        id="environment-start-timeout",
    ),
    pytest.param(
        _exception_payload("NonZeroAgentExitCodeError", "command timed out after 300 seconds"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "agent_command_timeout"},
        id="command-timeout",
    ),
    pytest.param(
        _exception_payload(
            "KimchiExitError",
            f"Kimchi exited with code {os.EX_IOERR}: /installed-agent/bin/kimchi",
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "kimchi_infra_exit"},
        id="kimchi-exit-ioerr",
    ),
    pytest.param(
        _exception_payload("KimchiExitError", f"Kimchi exit {os.EX_IOERR}: /installed-agent/bin/kimchi"),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed"},
        id="bare-exit-code-is-not-structured",
    ),
    pytest.param(
        _exception_payload("KimchiExitError", "Kimchi exited with code 1: /installed-agent/bin/kimchi"),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed"},
        id="kimchi-exit-non-ioerr",
    ),
    pytest.param(
        _exception_payload("ConnectionError"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "infra_network_error"},
        id="connection-error",
    ),
    pytest.param(
        _exception_payload("OOMKilled"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "infra_container_error"},
        id="oom-killed",
    ),
    pytest.param(
        _exception_payload("SSLError", reward=0.0),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "infra_network_error"},
        id="infra-exception-allowlist",
    ),
    pytest.param(
        _exception_payload("NonZeroAgentExitCodeError", "request was aborted by the server"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "agent_request_aborted"},
        id="request-aborted",
    ),
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            f"Command failed (exit {os.EX_IOERR}): /installed-agent/bin/kimchi --print",
        ),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed"},
        id="generic-wrapper-exit-74-without-marker",
    ),
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            "KIMCHI_INFRA_ERROR: provider transport failure; exiting with code 74",
            reward=1.0,
        ),
        {"outcome": "scored_pass", "error_category": None, "error_subcategory": None, "reward": 1.0},
        id="infra-marker-after-success-is-terminal-pass",
    ),
    pytest.param(
        _exception_payload("NonZeroAgentExitCodeError", "Command failed (exit 137): /installed-agent/bin/kimchi"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "agent_process_killed"},
        id="agent-process-killed",
    ),
    pytest.param(
        _exception_payload("AssertionError", reward=0.0),
        {"outcome": "error", "error_category": "agent"},
        id="quality-exception",
    ),
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            "error: This extension ctx is stale after session replacement",
        ),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "agent_stale_extension_context"},
        id="stale-extension-context",
    ),
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            (
                "Command failed (exit 1): /installed-agent/bin/kimchi "
                "--print --session /logs/agent/sessions/main.jsonl "
                "--dangerously-skip-permissions\n"
                f"stdout: {_BUDGET_ERROR_EXACT_MESSAGE}\\n"
            ),
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": API_KEY_BUDGET_EXCEEDED},
        id="anthropic-spend-limit",
    ),
    pytest.param(
        _exception_payload("NonZeroAgentExitCodeError", "API error: insufficient credits to complete request"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": API_KEY_BUDGET_EXCEEDED},
        id="insufficient-credits",
    ),
]


@pytest.mark.parametrize(("payload", "expected"), RESULT_JSON_CASES)
def test_classify_result_json_cases(tmp_results_dir: Path, payload: dict, expected: dict) -> None:
    trial = tmp_results_dir / "run-1" / "case__1"
    _write_result(trial, payload)

    verdict = classify(trial)

    _assert_verdict(verdict, expected)


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


READ_FAILURE_CASES = [
    pytest.param(
        None,
        {"outcome": "error", "error_category": "infra", "error_subcategory": "missing_result"},
        id="missing-result-json",
    ),
    pytest.param(
        "{ not valid json",
        {"outcome": "error", "error_category": "infra", "error_subcategory": "corrupt_json"},
        id="corrupt-json",
    ),
    pytest.param(
        "[]",
        {"outcome": "error", "error_category": "infra", "error_subcategory": "corrupt_json"},
        id="non-dict-json",
    ),
]


@pytest.mark.parametrize(("result_json", "expected"), READ_FAILURE_CASES)
def test_classify_read_failure_cases(tmp_results_dir: Path, result_json: str | None, expected: dict) -> None:
    trial = tmp_results_dir / "run-1" / "case__1"
    trial.mkdir(parents=True)
    if result_json is not None:
        (trial / "result.json").write_text(result_json)

    verdict = classify(trial)

    _assert_verdict(verdict, expected)


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


# ── error/infra — API key budget (agent timed out because of budget) ─────────────


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


AGENT_TIMEOUT_BUDGET_CASES = [
    pytest.param(
        _BUDGET_ERROR_EXACT_MESSAGE,
        {"outcome": "error", "error_category": "infra", "error_subcategory": API_KEY_BUDGET_EXCEEDED},
        id="exact-budget-error-message",
    ),
    pytest.param(
        "api key has reached its spend limit",
        {"outcome": "agent_timeout", "error_category": None, "error_subcategory": None},
        id="near-miss-budget-message",
    ),
    pytest.param(
        None,
        {"outcome": "agent_timeout", "error_category": None, "error_subcategory": None},
        id="non-string-error-message",
    ),
    pytest.param(
        "I am working on the task but it is taking a long time...",
        {"outcome": "agent_timeout", "error_category": None, "error_subcategory": None},
        id="unrelated-error-message",
    ),
    pytest.param(
        _NO_SESSION,
        {"outcome": "agent_timeout", "error_category": None, "error_subcategory": None},
        id="no-sessions-dir",
    ),
]


@pytest.mark.parametrize(("session_error_message", "expected"), AGENT_TIMEOUT_BUDGET_CASES)
def test_agent_timeout_budget_session_refinement_cases(
    tmp_results_dir: Path,
    session_error_message: object,
    expected: dict,
) -> None:
    """Only the verbatim provider budget body refines AgentTimeoutError into api_key_budget_exceeded."""
    trial = tmp_results_dir / "run-1" / "case__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            }
        },
    )
    if session_error_message is not _NO_SESSION:
        _write_session_message_errorMessage(trial, session_error_message)

    verdict = classify(trial)

    _assert_verdict(verdict, expected)


def test_scored_pass_is_not_refined_by_non_exception_session_scan(tmp_results_dir: Path) -> None:
    """Sanity: session refinement only runs when result.json contains an exception."""
    trial = tmp_results_dir / "run-1" / "task-pass__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 1.0}}})
    # Even with the exact budget errorMessage in sessions, a passing trial stays scored_pass.
    _write_session_message_errorMessage(trial, _BUDGET_ERROR_EXACT_MESSAGE)

    verdict = classify(trial)

    assert verdict.outcome == "scored_pass"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None


def test_scored_pass_is_not_refined_by_budget_timeout_session(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-pass-budget-timeout__1"
    _write_result(
        trial,
        {
            "verifier_result": {"rewards": {"reward": 1.0}},
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            },
        },
    )
    _write_session_message_errorMessage(trial, _BUDGET_ERROR_EXACT_MESSAGE)

    verdict = classify(trial)

    assert verdict.outcome == "scored_pass"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None
