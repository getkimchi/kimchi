"""Unit tests for classify.py — infra/quality verdict classification."""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from bench_config import is_retryable
from classify import ERROR_RULES, Verdict, _classify_exception, classify
from outcome import Outcome

API_KEY_BUDGET_EXCEEDED = "api_key_budget_exceeded"
TRIAL_CANCELLED = "trial_cancelled"
MOONSHOT_QUOTA_EXCEEDED = "moonshot_quota_exceeded"
USAGE_LIMIT_EXCEEDED = "usage_limit_exceeded"
# Z.AI's 5-hour windowed account quota 429 (verbatim shape from traced runs).
_ZAI_USAGE_LIMIT_429 = (
    "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. "
    "Your limit will reset at 2026-08-14 15:00:00]"
)
# Z.AI's transient per-minute rate limit — explicitly NOT the windowed quota.
_ZAI_TRANSIENT_1302_429 = (
    "API Error: Request rejected (429) · [1302][Rate limit reached for requests. "
    "Please try again later]"
)
_BUDGET_ERROR_EXACT_MESSAGE = (
    '429 "API key has reached its spend limit.\\n'
    "Increase the budget in the console or contact your "
    'organization admin to continue."'
)
# Moonshot's account-suspension 429 body (machine-readable type code).
_MOONSHOT_SUSPENSION_429 = (
    '429: {"message":"Your account org-35034d5421664cdda199c516433a6bd0 '
    "<ak-fbyqo61tbed111gpt9i1> is suspended due to insufficient balance, please recharge "
    'your account or check your plan and billing details","type":"exceeded_current_quota_error"}'
)
_NO_SESSION = object()


def _write_result(trial_dir: Path, payload: dict) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps(payload))
    (trial_dir / "trial.log").write_text("")


def _load_docker_daemon_fixtures() -> list[dict]:
    fixture_path = Path(__file__).parent / "fixtures" / "docker_daemon_classification.json"
    return json.loads(fixture_path.read_text(encoding="utf-8"))


def _reward_payload(reward: float | None) -> dict:
    return {"verifier_result": {"rewards": {"reward": reward}}}


def _exception_payload(
    exception_type: str,
    exception_message: str | None = None,
    *,
    reward: float | None | object = _NO_SESSION,
    model_name: str | None = None,
) -> dict:
    payload = {"exception_info": {"exception_type": exception_type}}
    if exception_message is not None:
        payload["exception_info"]["exception_message"] = exception_message
    if reward is not _NO_SESSION:
        payload["verifier_result"] = {"rewards": {"reward": reward}}
    if model_name is not None:
        payload["config"] = {"agent": {"model_name": model_name}}
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
        {"verifier_result": {"rewards": {}}},
        {
            "outcome": "error",
            "error_category": "infra",
            "error_subcategory": "missing_verdict",
        },
        id="empty-rewards-are-not-a-scored-failure",
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
        _exception_payload("NetworkConnectionError"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "infra_network_error"},
        id="network-connection-error",
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
        {"outcome": "scored_fail", "error_category": None, "error_subcategory": None, "reward": 0.0},
        id="numeric-failure-overrides-infra-exception",
    ),
    pytest.param(
        _exception_payload("SSLError", reward=float("nan")),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "infra_network_error"},
        id="non-finite-reward-does-not-override-infra-exception",
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
        {"outcome": "error", "error_category": "infra", "error_subcategory": "kimchi_infra_exit", "reward": None},
        id="infra-marker-interrupted-attempt-discards-reward",
    ),
    pytest.param(
        _exception_payload("NonZeroAgentExitCodeError", "Command failed (exit 137): /installed-agent/bin/kimchi"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "agent_process_killed"},
        id="agent-process-killed",
    ),
    pytest.param(
        _exception_payload(
            "UnknownApiError",
            "It may not exist or you may not have access to it. Run --model to pick a different model.",
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "model_access_error"},
        id="model-access-error",
    ),
    # Verbatim failure string from the 2026-08-05 DinD outage: harbor wraps the
    # compose failure in a plain RuntimeError, so only the text matches.
    pytest.param(
        {
            **_exception_payload(
                "RuntimeError",
                "Docker compose command failed for environment bn-fit-modify. "
                "Command: docker compose --project-name bn-fit-modify__x3nfqrv__env "
                "up --detach --wait. Return code: 1. "
                "Stdout: unable to get image 'alexgshaw/bn-fit-modify:20251031': "
                "Cannot connect to the Docker daemon at tcp://docker:2375. "
                "Is the docker daemon running?. Stderr: None.",
            ),
            "environment_setup": {},
        },
        {"outcome": "error", "error_category": "infra", "error_subcategory": "docker_daemon_unreachable"},
        id="docker-daemon-unreachable",
    ),
    # Same wrapper, but a permanent missing-image error: must stay agent-level
    # and non-retryable — a task with a broken environment is task evidence.
    pytest.param(
        {
            **_exception_payload(
                "RuntimeError",
                "Docker compose command failed for environment bn-fit-modify. "
                "Command: docker compose up --detach --wait. Return code: 1. "
                "Stdout: unable to get image 'alexgshaw/missing:tag': not found.",
            ),
            "environment_setup": {},
        },
        {"outcome": "error", "error_category": "agent", "error_subcategory": "environment_setup_failed"},
        id="docker-missing-image-stays-agent",
    ),
    pytest.param(
        _exception_payload("AssertionError", reward=0.0),
        {"outcome": "scored_fail", "error_category": None, "error_subcategory": None, "reward": 0.0},
        id="numeric-failure-overrides-quality-exception",
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
    pytest.param(
        _exception_payload("ApiUsageLimitError", "403 Key limit exceeded (total limit)"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": API_KEY_BUDGET_EXCEEDED},
        id="openrouter-key-limit-by-type",
    ),
    pytest.param(
        _exception_payload(
            "UnknownApiError",
            "Command failed (exit 1): claude --verbose\nstdout: 403 Key limit exceeded (total limit)",
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": API_KEY_BUDGET_EXCEEDED},
        id="openrouter-key-limit-by-text",
    ),
    pytest.param(
        _exception_payload(
            "KimchiExitError",
            "Kimchi exited with code 1: /installed-agent/bin/kimchi "
            "--print --session /logs/agent/sessions/main.jsonl "
            "--dangerously-skip-permissions\n"
            f"stdout: {_MOONSHOT_SUSPENSION_429}\n",
            model_name="moonshotai/kimi-k3",
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": MOONSHOT_QUOTA_EXCEEDED},
        id="moonshot-account-suspension",
    ),
    pytest.param(
        _exception_payload(
            "KimchiExitError",
            f"Kimchi exited with code 1: /installed-agent/bin/kimchi\nstdouterr: {_MOONSHOT_SUSPENSION_429}\n",
            model_name="openai/gpt-5",
        ),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed"},
        id="moonshot-suspension-text-non-moonshot-provider-not-retried",
    ),
    pytest.param(
        _exception_payload(
            "KimchiExitError",
            f"Kimchi exited with code 1: /installed-agent/bin/kimchi\nstdouterr: {_MOONSHOT_SUSPENSION_429}\n",
        ),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed"},
        id="moonshot-suspension-text-no-provider-not-retried",
    ),
    pytest.param(
        _exception_payload(
            "KimchiExitError",
            f"Kimchi exited with code 1: /installed-agent/bin/kimchi\nstdouterr: {_MOONSHOT_SUSPENSION_429}\n",
            model_name="multi-model",
        ),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed"},
        id="moonshot-suspension-text-unqualified-model-not-retried",
    ),
    pytest.param(
        _exception_payload(
            "KimchiExitError",
            "Kimchi exited with code 74: /installed-agent/bin/kimchi\n"
            'stdout: 429: {"message":"Your account org-35034d5421664cdda199c516433a6bd0 '
            "request reached organization TPM rate limit, current: 3025143, limit: 3000000"
            '","type":"rate_limit_reached_error"}\n',
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "kimchi_infra_exit"},
        id="moonshot-tpm-rate-limit-is-not-budget",
    ),
    # ── Reward-present + exception matrix (score discard policy) ────────────────
    # Teardown/cleanup exceptions (outside the agent-execution families) never
    # overwrite a completed score.
    pytest.param(
        _exception_payload("RuntimeError", "docker compose down failed", reward=1.0),
        {"outcome": "scored_pass", "error_category": None, "error_subcategory": None, "reward": 1.0},
        id="teardown-runtime-error-keeps-score",
    ),
    # Transient-429 process death is retryable infra in both reward populations.
    pytest.param(
        _exception_payload("ApiRateLimitError", "429 too many requests"),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "infra_network_error"},
        id="api-rate-limit-error",
    ),
    pytest.param(
        _exception_payload("ApiRateLimitError", "429 too many requests", reward=0.0),
        {"outcome": "error", "error_category": "infra", "error_subcategory": "infra_network_error", "reward": None},
        id="api-rate-limit-error-discards-reward",
    ),
    # Z.AI windowed-quota 429 captured by the NonZero wrapper: terminal infra,
    # ungated on provider, reward discarded.
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            f"Command failed (exit 1): opencode run\nstdout: {_ZAI_USAGE_LIMIT_429}",
            model_name="zai/glm-5",
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": USAGE_LIMIT_EXCEEDED},
        id="zai-usage-limit",
    ),
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            f"Command failed (exit 1): opencode run\nstdout: {_ZAI_USAGE_LIMIT_429}",
            reward=1.0,
            model_name="zai/glm-5",
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": USAGE_LIMIT_EXCEEDED, "reward": None},
        id="zai-usage-limit-discards-reward",
    ),
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            f"Command failed (exit 1): opencode run\nstdout: {_ZAI_USAGE_LIMIT_429}",
            reward=0.0,
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": USAGE_LIMIT_EXCEEDED, "reward": None},
        id="zai-usage-limit-no-provider-discards-reward",
    ),
    # Transient [1302] per-minute rate limits are NOT the windowed quota.
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            f"Command failed (exit 1): opencode run\nstdout: {_ZAI_TRANSIENT_1302_429}",
            reward=1.0,
        ),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed", "reward": None},
        id="zai-transient-1302-not-usage-limit",
    ),
    # Typed budget exception with a verifier reward: discarded, non-retryable.
    pytest.param(
        _exception_payload("ApiUsageLimitError", "403 Key limit exceeded (total limit)", reward=0.0),
        {"outcome": "error", "error_category": "infra", "error_subcategory": API_KEY_BUDGET_EXCEEDED, "reward": None},
        id="openrouter-key-limit-discards-reward",
    ),
    # Structured docker-daemon marker in a NonZero wrapper: retryable infra,
    # reward discarded.
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            "Command failed (exit 1): Cannot connect to the Docker daemon at tcp://docker:2375",
            reward=1.0,
        ),
        {
            "outcome": "error",
            "error_category": "infra",
            "error_subcategory": "docker_daemon_unreachable",
            "reward": None,
        },
        id="nonzero-docker-daemon-discards-reward",
    ),
    # Agent-caused error-interruption: discarded under the agent bucket.
    pytest.param(
        _exception_payload(
            "NonZeroAgentExitCodeError",
            "error: This extension ctx is stale after session replacement",
            reward=0.0,
        ),
        {
            "outcome": "error",
            "error_category": "agent",
            "error_subcategory": "agent_stale_extension_context",
            "reward": None,
        },
        id="stale-context-discards-reward",
    ),
    pytest.param(
        {
            **_exception_payload(
                "NonZeroAgentExitCodeError",
                "Command failed (exit 1): /installed-agent/bin/kimchi --print",
                reward=0.0,
            ),
            "agent_execution": {"started_at": "2026-08-10T20:00:00Z"},
        },
        {"outcome": "error", "error_category": "agent", "error_subcategory": "agent_execution_failed", "reward": None},
        id="nonzero-exit-1-no-markers-discards-reward",
    ),
    # Project-defined NonZero subclasses discard their reward as well.
    pytest.param(
        _exception_payload("KimchiExitError", "Kimchi exited with code 255", reward=1.0),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed", "reward": None},
        id="kimchi-exit-error-discards-reward",
    ),
    pytest.param(
        _exception_payload("PiExitError", "Pi exited with code 255", reward=1.0),
        {"outcome": "error", "error_category": "agent", "error_subcategory": "unknown_failed", "reward": None},
        id="pi-exit-error-discards-reward",
    ),
    # Typed rules take precedence over docker-daemon text causality.
    pytest.param(
        _exception_payload(
            "CancelledError",
            "trial cancelled: Cannot connect to the Docker daemon at tcp://docker:2375",
        ),
        {"outcome": "error", "error_category": "infra", "error_subcategory": TRIAL_CANCELLED},
        id="cancelled-with-daemon-text-stays-trial-cancelled",
    ),
]


@pytest.mark.parametrize(("payload", "expected"), RESULT_JSON_CASES)
def test_classify_result_json_cases(tmp_results_dir: Path, payload: dict, expected: dict) -> None:
    trial = tmp_results_dir / "run-1" / "case__1"
    _write_result(trial, payload)

    verdict = classify(trial)

    _assert_verdict(verdict, expected)


def test_docker_daemon_unreachable_is_retryable(tmp_results_dir: Path) -> None:
    """DinD-connectivity failures must re-schedule, not fill an attempt slot.

    reconcile.compute_task_progress() relies on is_retryable() to decide
    whether an infra error fills a pass@k slot; a docker_daemon_unreachable
    verdict that is NOT retryable silently burns the attempt (observed in the
    2026-08-05 child-pipeline traces: 44 attempt-1 slots lost).
    """
    trial = tmp_results_dir / "run-1" / "case__docker_retryable"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "RuntimeError",
                "exception_message": (
                    "Docker compose command failed for environment some-task. "
                    "Stdout: unable to get image 'img:tag': "
                    "Cannot connect to the Docker daemon at tcp://docker:2375."
                ),
            },
            "environment_setup": {},
        },
    )

    verdict = classify(trial)

    assert is_retryable(verdict.outcome, verdict.error_category, verdict.error_subcategory)


def test_classify_exception_matches_structured_docker_daemon_error(
    tmp_results_dir: Path,
) -> None:
    """The shared cause engine classifies structured daemon evidence directly."""
    trial = tmp_results_dir / "run-1" / "case__docker_cause_engine"
    result = {
        "exception_info": {
            "exception_type": "RuntimeError",
            "exception_message": (
                "Cannot connect to the Docker daemon at tcp://docker:2375"
            ),
        },
        "environment_setup": {},
    }
    _write_result(trial, result)

    verdict = _classify_exception(trial, result, None)

    assert verdict.outcome == Outcome.ERROR
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "docker_daemon_unreachable"


def test_structured_docker_error_precedes_transcript_budget_marker(
    tmp_results_dir: Path,
) -> None:
    """Marker fallbacks cannot override structured Docker causality."""
    trial = tmp_results_dir / "run-1" / "case__docker_with_transcript_noise"
    _write_result(
        trial,
        _exception_payload(
            "NonZeroAgentExitCodeError",
            "Command failed (exit 1): Cannot connect to the Docker daemon at tcp://docker:2375",
            reward=1.0,
        ),
    )
    agent_dir = trial / "agent"
    agent_dir.mkdir()
    (agent_dir / "opencode.txt").write_text(
        "Earlier recoverable request failed with insufficient credits",
        encoding="utf-8",
    )

    verdict = classify(trial)

    assert verdict.outcome == Outcome.ERROR
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == "docker_daemon_unreachable"
    assert verdict.reward is None


def test_reviewed_docker_daemon_classification_manifest(tmp_results_dir: Path) -> None:
    for fixture in _load_docker_daemon_fixtures():
        trial = tmp_results_dir / "manifest" / fixture["name"]
        _write_result(trial, fixture["result"])
        if fixture["trial_log"] is None:
            (trial / "trial.log").unlink()
        else:
            (trial / "trial.log").write_text(fixture["trial_log"], encoding="utf-8")

        verdict = classify(trial)

        actual = [verdict.outcome, verdict.error_category, verdict.error_subcategory]
        assert actual == fixture["expected"], fixture["name"]
        if verdict.error_category == "infra":
            assert is_retryable(
                verdict.outcome,
                verdict.error_category,
                verdict.error_subcategory,
            ), fixture["name"]


@pytest.mark.parametrize(
    "exception_type",
    ["RewardFileEmptyError", "VerifierOutputParseError"],
)
def test_unscored_verifier_failure_is_retryable(
    tmp_results_dir: Path,
    exception_type: str,
) -> None:
    trial = tmp_results_dir / exception_type
    _write_result(
        trial,
        {
            "verifier": {
                "started_at": "2026-08-10T22:00:00Z",
                "finished_at": "2026-08-10T22:01:00Z",
            },
            "exception_info": {
                "exception_type": exception_type,
                "exception_message": "Verifier did not produce a numeric reward",
                "occurred_at": "2026-08-10T22:00:30Z",
            },
        },
    )

    verdict = classify(trial)

    _assert_verdict(
        verdict,
        {
            "outcome": Outcome.ERROR,
            "error_category": "infra",
            "error_subcategory": "missing_verdict",
        },
    )
    assert is_retryable(
        verdict.outcome,
        verdict.error_category,
        verdict.error_subcategory,
    )


def test_unreadable_trial_log_retries_unscored_result(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "unreadable-log"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "KimchiExitError",
                "exception_message": "Kimchi exited with code 255",
            }
        },
    )
    original_read_text = Path.read_text

    def read_text(path: Path, *args, **kwargs):
        if path == trial / "trial.log":
            raise PermissionError("trial log is unreadable")
        return original_read_text(path, *args, **kwargs)

    with patch.object(Path, "read_text", read_text):
        verdict = classify(trial)

    _assert_verdict(
        verdict,
        {
            "outcome": Outcome.ERROR,
            "error_category": "infra",
            "error_subcategory": "trial_log_missing",
        },
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"verifier_result": {"rewards": {}}},
    ],
)
def test_missing_trial_log_takes_precedence_for_every_unscored_result(
    tmp_results_dir: Path,
    payload: dict,
) -> None:
    trial = tmp_results_dir / "missing-log-without-exception"
    _write_result(trial, payload)
    (trial / "trial.log").unlink()

    verdict = classify(trial)

    _assert_verdict(
        verdict,
        {
            "outcome": Outcome.ERROR,
            "error_category": "infra",
            "error_subcategory": "trial_log_missing",
        },
    )


def test_causal_trial_log_applies_without_structured_exception(
    tmp_results_dir: Path,
) -> None:
    trial = tmp_results_dir / "causal-log-without-exception"
    _write_result(trial, {})
    (trial / "trial.log").write_text(
        "docker compose cp failed; retrying upload with tar stream\n"
        "Docker compose command failed. Stdout: Cannot connect to the Docker daemon.\n"
        "harbor.verifier.verifier.AddTestsDirError: Failed to add tests directory.\n",
        encoding="utf-8",
    )

    verdict = classify(trial)

    _assert_verdict(
        verdict,
        {
            "outcome": Outcome.ERROR,
            "error_category": "infra",
            "error_subcategory": "docker_daemon_unreachable",
        },
    )


def test_agent_transcript_docker_marker_is_not_structured_daemon_evidence(
    tmp_results_dir: Path,
) -> None:
    trial = tmp_results_dir / "agent-transcript-marker"
    _write_result(
        trial,
        {
            "agent_execution": {"started_at": "2026-08-10T20:00:00Z"},
            "exception_info": {
                "exception_type": "KimchiExitError",
                "exception_message": "Kimchi exited with code 255",
            },
        },
    )
    transcript = trial / "agent" / "opencode.txt"
    transcript.parent.mkdir()
    transcript.write_text(
        "User command output: Cannot connect to the Docker daemon\n",
        encoding="utf-8",
    )

    verdict = classify(trial)

    _assert_verdict(
        verdict,
        {
            "outcome": Outcome.ERROR,
            "error_category": "agent",
            "error_subcategory": "agent_execution_failed",
        },
    )


@pytest.mark.parametrize(
    ("log_available", "expected_subcategory"),
    [(True, TRIAL_CANCELLED), (False, "trial_log_missing")],
)
def test_unscored_cancelled_trial_respects_missing_log_policy(
    tmp_results_dir: Path,
    log_available: bool,
    expected_subcategory: str,
) -> None:
    trial = tmp_results_dir / f"cancelled-log-{log_available}"
    _write_result(trial, _exception_payload("CancelledError"))
    if not log_available:
        (trial / "trial.log").unlink()

    verdict = classify(trial)

    _assert_verdict(
        verdict,
        {
            "outcome": Outcome.ERROR,
            "error_category": "infra",
            "error_subcategory": expected_subcategory,
            "reward": None,
        },
    )
    assert is_retryable(
        verdict.outcome,
        verdict.error_category,
        verdict.error_subcategory,
    )


def test_numeric_reward_overrides_cancelled_exception(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "cancelled-after-score"
    _write_result(trial, _exception_payload("CancelledError", reward=0.0))

    verdict = classify(trial)

    _assert_verdict(
        verdict,
        {
            "outcome": Outcome.SCORED_FAIL,
            "error_category": None,
            "error_subcategory": None,
            "reward": 0.0,
        },
    )


def _write_session(
    trial_dir: Path,
    entries: list[dict],
    filename: str = "main.jsonl",
) -> None:
    session_dir = trial_dir / "agent" / "sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    with (session_dir / filename).open("w", encoding="utf-8") as fh:
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


def _write_session_message_errorMessage(
    trial: Path,
    error_message: object,
    filename: str = "main.jsonl",
) -> None:
    """Write a session jsonl containing one assistant message with the given errorMessage."""
    sessions = trial / "agent" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / filename).write_text(
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
        '429: {"message":"Your account org-35034d5421664cdda199c516433a6bd0 / '
        "proj-5d684da5acc2455cbb753e88c18fea37 <ak-fbyqo61tbed111gpt9i1> request reached "
        'organization TPM rate limit, current: 3025143, limit: 3000000, see '
        'https://platform.moonshot.ai/docs/pricing/limits","type":"rate_limit_reached_error"}',
        {"outcome": "agent_timeout", "error_category": None, "error_subcategory": None},
        id="moonshot-tpm-rate-limit-is-not-budget",
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
    """Provider-recognized budget/quota bodies refine AgentTimeoutError into a budget subcategory."""
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


# ── provider gate on the moonshot quota rule (timeout refinement path) ────────────


def _run_moonshot_suspension_timeout(tmp_results_dir: Path, config: dict | None) -> Verdict:
    """AgentTimeoutError + moonshot suspension errorMessage, with the given config key."""
    trial = tmp_results_dir / "run-1" / "case__1"
    payload = {
        "exception_info": {
            "exception_type": "AgentTimeoutError",
            "exception_message": "Agent execution timed out after 3600 seconds",
        }
    }
    if config is not None:
        payload["config"] = config
    _write_result(trial, payload)
    _write_session_message_errorMessage(trial, _MOONSHOT_SUSPENSION_429)
    return classify(trial)


def test_timeout_moonshot_suspension_with_proven_moonshot_provider(tmp_results_dir: Path) -> None:
    verdict = _run_moonshot_suspension_timeout(tmp_results_dir, {"agent": {"model_name": "moonshotai/kimi-k3"}})
    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == MOONSHOT_QUOTA_EXCEEDED


def test_timeout_moonshot_suspension_with_non_moonshot_provider_stays_agent_timeout(tmp_results_dir: Path) -> None:
    verdict = _run_moonshot_suspension_timeout(tmp_results_dir, {"agent": {"model_name": "openai/gpt-5"}})
    assert verdict.outcome == "agent_timeout"
    assert verdict.error_category is None


def test_timeout_moonshot_suspension_with_no_provider_stays_agent_timeout(tmp_results_dir: Path) -> None:
    verdict = _run_moonshot_suspension_timeout(tmp_results_dir, None)
    assert verdict.outcome == "agent_timeout"
    assert verdict.error_category is None


def test_exit_1_moonshot_suspension_agent_info_self_report_does_not_unlock_retry(tmp_results_dir: Path) -> None:
    """agent_info.model_info.provider is agent self-report, not routing provenance:
    config.agent.model_name absent => the moonshot rule must not match."""
    trial = tmp_results_dir / "run-1" / "case__1"
    payload = _exception_payload(
        "KimchiExitError",
        f"Kimchi exited with code 1: /installed-agent/bin/kimchi\nstdouterr: {_MOONSHOT_SUSPENSION_429}\n",
    )
    payload["agent_info"] = {
        "name": "kimchi",
        "version": "1.0",
        "model_info": {"name": "kimi-k3", "provider": "moonshotai"},
    }
    _write_result(trial, payload)

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "agent"
    assert verdict.error_subcategory == "unknown_failed"


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


def test_budget_blocked_timeout_with_reward_discards_score(tmp_results_dir: Path) -> None:
    """A timeout its driving session proves budget-blocked is error-interrupted:
    the verifier graded a blocked workspace, so the score is discarded."""
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

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == API_KEY_BUDGET_EXCEEDED
    assert verdict.reward is None
    assert not is_retryable(verdict.outcome, verdict.error_category, verdict.error_subcategory)


def test_clean_wallclock_timeout_with_reward_keeps_score(tmp_results_dir: Path) -> None:
    """A clean wall-clock cutoff is the benchmark's intentional scored cutoff:
    grading the partial workspace at the cutoff is valid pass@k evidence."""
    trial = tmp_results_dir / "run-1" / "task-clean-timeout__1"
    _write_result(
        trial,
        {
            "verifier_result": {"rewards": {"reward": 0.0}},
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            },
        },
    )
    _write_session(
        trial,
        [
            {"type": "message", "message": {"role": "user"}},
            {"type": "message", "message": {"role": "assistant"}},
            {"type": "message", "message": {"role": "toolResult"}},
        ],
    )

    verdict = classify(trial)

    assert verdict.outcome == "scored_fail"
    assert verdict.error_category is None
    assert verdict.error_subcategory is None
    assert verdict.reward == 0.0


@pytest.mark.parametrize("reward", [None, 1.0])
def test_timeout_zai_usage_limit_session_refinement(tmp_results_dir: Path, reward: float | None) -> None:
    """A Z.AI windowed-quota 429 terminal in the driving session refines the
    timeout to infra/usage_limit_exceeded — with or without a verifier reward."""
    trial = tmp_results_dir / "run-1" / "task-zai-timeout__1"
    payload = {
        "exception_info": {
            "exception_type": "AgentTimeoutError",
            "exception_message": "Agent execution timed out after 3600 seconds",
        }
    }
    if reward is not None:
        payload["verifier_result"] = {"rewards": {"reward": reward}}
    _write_result(trial, payload)
    _write_session_message_errorMessage(trial, _ZAI_USAGE_LIMIT_429)

    verdict = classify(trial)

    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == USAGE_LIMIT_EXCEEDED
    assert verdict.reward is None
    assert not is_retryable(verdict.outcome, verdict.error_category, verdict.error_subcategory)


def test_timeout_budget_error_uses_workflow_orchestrator_session(
    tmp_results_dir: Path,
) -> None:
    trial = tmp_results_dir / "run-1" / "task-workflow-timeout__1"
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
    _write_session(
        trial,
        [
            {"type": "message", "message": {"role": "user"}},
            {"type": "message", "message": {"role": "assistant"}},
            {"type": "message", "message": {"role": "toolResult"}},
        ],
        "subagent-worker.jsonl",
    )
    _write_session_message_errorMessage(
        trial,
        _BUDGET_ERROR_EXACT_MESSAGE,
        "workflow-orchestrator.jsonl",
    )

    verdict = classify(trial)

    assert verdict.outcome == Outcome.ERROR
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == API_KEY_BUDGET_EXCEEDED
    assert verdict.reward is None


def test_timeout_budget_error_uses_best_session_fallback(
    tmp_results_dir: Path,
) -> None:
    trial = tmp_results_dir / "run-1" / "task-fallback-timeout__1"
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
    _write_session(
        trial,
        [{"type": "message", "message": {"role": "assistant"}}],
        "short-session.jsonl",
    )
    _write_session(
        trial,
        [
            {"type": "message", "message": {"role": "user"}},
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "stopReason": "error",
                    "errorMessage": _BUDGET_ERROR_EXACT_MESSAGE,
                },
            },
        ],
        "long-session.jsonl",
    )

    verdict = classify(trial)

    assert verdict.outcome == Outcome.ERROR
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == API_KEY_BUDGET_EXCEEDED
    assert verdict.reward is None


def _write_session_with_recovered_budget_error(trial: Path) -> None:
    """Terminal-state guard: an earlier budget error followed by progress."""
    _write_session(
        trial,
        [
            {"type": "message", "message": {"role": "user"}},
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "stopReason": "error",
                    "errorMessage": _BUDGET_ERROR_EXACT_MESSAGE,
                },
            },
            {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "retrying"}]}},
            {"type": "message", "message": {"role": "toolResult", "content": [{"type": "text", "text": "ok"}]}},
        ],
    )


def test_timeout_budget_error_followed_by_progress_stays_clean(tmp_results_dir: Path) -> None:
    """An error the agent recovered from does not prove the cutoff was budget-blocked."""
    trial = tmp_results_dir / "run-1" / "task-recovered-timeout__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            }
        },
    )
    _write_session_with_recovered_budget_error(trial)

    verdict = classify(trial)

    assert verdict.outcome == "agent_timeout"
    assert verdict.error_category is None


def test_timeout_budget_error_followed_by_progress_with_reward_keeps_score(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-recovered-timeout__1"
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
    _write_session_with_recovered_budget_error(trial)

    verdict = classify(trial)

    assert verdict.outcome == "scored_pass"
    assert verdict.reward == 1.0


def _write_sessions_with_subagent_budget_error(trial: Path) -> None:
    """Budget error confined to a non-driving subagent session; main is clean."""
    _write_session(
        trial,
        [
            {"type": "message", "message": {"role": "user"}},
            {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "working"}]}},
            {"type": "message", "message": {"role": "toolResult", "content": [{"type": "text", "text": "ok"}]}},
        ],
    )
    sessions = trial / "agent" / "sessions"
    (sessions / "subagent-worker.jsonl").write_text(
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "stopReason": "error",
                    "errorMessage": _BUDGET_ERROR_EXACT_MESSAGE,
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_timeout_budget_error_only_in_subagent_session_stays_clean(tmp_results_dir: Path) -> None:
    """An error in a non-driving subagent session is not the timeout's cause."""
    trial = tmp_results_dir / "run-1" / "task-subagent-error__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "AgentTimeoutError",
                "exception_message": "Agent execution timed out after 3600 seconds",
            }
        },
    )
    _write_sessions_with_subagent_budget_error(trial)

    verdict = classify(trial)

    assert verdict.outcome == "agent_timeout"
    assert verdict.error_category is None


def test_timeout_budget_error_only_in_subagent_session_with_reward_keeps_score(tmp_results_dir: Path) -> None:
    trial = tmp_results_dir / "run-1" / "task-subagent-error__1"
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
    _write_sessions_with_subagent_budget_error(trial)

    verdict = classify(trial)

    assert verdict.outcome == "scored_pass"
    assert verdict.reward == 1.0


def test_terminal_infra_subcategories_are_not_retryable() -> None:
    for subcategory in (API_KEY_BUDGET_EXCEEDED, USAGE_LIMIT_EXCEEDED, "model_access_error"):
        assert not is_retryable(Outcome.ERROR, "infra", subcategory)
    # Moonshot's top-up mechanism keeps its suspension retryable.
    assert is_retryable(Outcome.ERROR, "infra", MOONSHOT_QUOTA_EXCEEDED)


# ── OpenCode trajectory.json — credit exhaustion from opencode.txt ──────────────────


def _write_opencode_txt(trial_dir: Path, text: str) -> None:
    agent_dir = trial_dir / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "opencode.txt").write_text(text, encoding="utf-8")


def _write_trajectory(
    trial_dir: Path,
    steps: list[dict],
    *,
    model_name: str = "openrouter/@preset/glm-5-2-zai",
) -> None:
    agent_dir = trial_dir / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    trajectory = {
        "schema_version": "ATIF-v1.7",
        "session_id": "ses_test",
        "agent": {"name": "opencode", "version": "1.18.14", "model_name": model_name},
        "steps": steps,
        "final_metrics": {},
    }
    (agent_dir / "trajectory.json").write_text(json.dumps(trajectory))


def test_opencode_credit_exhaustion_in_opencode_txt(tmp_results_dir: Path) -> None:
    """Credit-exhaustion error in opencode.txt is classified as api_key_budget_exceeded.

    Opencode writes API errors to agent/opencode.txt, not to result.json's
    exception_message (which just says "Command failed (exit 1): ...").
    The classifier must read opencode.txt to find the real error.
    """
    trial = tmp_results_dir / "run-1" / "task__1"
    _write_result(trial, _exception_payload(
        "NonZeroAgentExitCodeError",
        "Command failed (exit 1): opencode --model=openrouter/@preset/glm-5-2-zai run --format=json",
    ))
    _write_opencode_txt(trial, (
        '{"type":"error","error":{"name":"APIError","data":{"message":'
        '"Insufficient credits. Add more using https://openrouter.ai/settings/credits",'
        '"statusCode":402,"isRetryable":false}}}'
    ))

    verdict = classify(trial)
    assert verdict.outcome == "error"
    assert verdict.error_category == "infra"
    assert verdict.error_subcategory == API_KEY_BUDGET_EXCEEDED


def test_opencode_credit_exhaustion_requires_more_credits(tmp_results_dir: Path) -> None:
    """OpenRouter 'requires more credits, or fewer max_tokens' is budget exhaustion."""
    trial = tmp_results_dir / "run-1" / "task__1"
    _write_result(trial, _exception_payload(
        "NonZeroAgentExitCodeError",
        "Command failed (exit 1): opencode --model=openrouter/@preset/glm-5-2-zai run",
    ))
    _write_opencode_txt(trial, (
        '{"type":"error","error":{"name":"APIError","data":{"message":'
        '"This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, '
        'but can only afford 5495.","statusCode":402}}}'
    ))

    verdict = classify(trial)
    assert verdict.error_subcategory == API_KEY_BUDGET_EXCEEDED


def test_opencode_no_transcript_falls_back_to_exception_message(tmp_results_dir: Path) -> None:
    """Without opencode.txt, classification falls back to exception_message only."""
    trial = tmp_results_dir / "run-1" / "task__1"
    _write_result(trial, _exception_payload(
        "NonZeroAgentExitCodeError",
        "Command failed (exit 1): opencode run",
    ))
    verdict = classify(trial)
    assert verdict.outcome == "error"
    assert verdict.error_category == "agent"


# ── OpenCode trajectory.json — timeout analysis ─────────────────────────────────


def test_agent_timeout_with_trajectory_extracts_tool_and_messages(tmp_results_dir: Path) -> None:
    """Agent timeout with trajectory.json (no sessions/*.jsonl) produces real analysis.

    The timeout state machine should read step timestamps and tool calls from
    the ATIF trajectory, producing a non-unknown timeout_status.
    """
    trial = tmp_results_dir / "run-1" / "task__1"
    _write_result(trial, _agent_timeout_payload("2026-08-06T13:00:00.000000Z"))
    _write_trajectory(trial, [
        {"timestamp": "2026-08-06T12:00:00.000000+00:00", "source": "agent",
         "tool_calls": [{"function_name": "bash"}], "metrics": {}},
        {"timestamp": "2026-08-06T12:05:00.000000+00:00", "source": "agent",
         "tool_calls": [{"function_name": "edit"}], "metrics": {}},
        {"timestamp": "2026-08-06T12:10:00.000000+00:00", "source": "agent",
         "tool_calls": [{"function_name": "bash"}], "metrics": {}},
    ])

    verdict = classify(trial)
    assert verdict.outcome == "agent_timeout"
    analysis = verdict.raw["agent_timeout_analysis"]
    assert analysis["timeout_status"] != "unknown"
    assert analysis["n_messages"] > 0
    assert analysis["last_tool_name"] == "bash"


def test_agent_timeout_trajectory_few_turns(tmp_results_dir: Path) -> None:
    """Trajectory with very few steps is classified as few_turns."""
    trial = tmp_results_dir / "run-1" / "task__1"
    _write_result(trial, _agent_timeout_payload("2026-08-06T12:30:00.000000Z"))
    _write_trajectory(trial, [
        {"timestamp": "2026-08-06T12:29:00.000000+00:00", "source": "agent",
         "tool_calls": [], "metrics": {}},
    ])

    verdict = classify(trial)
    analysis = verdict.raw["agent_timeout_analysis"]
    assert analysis["timeout_status"] == "few_turns"


def test_agent_timeout_session_jsonl_preferred_over_trajectory(tmp_results_dir: Path) -> None:
    """When both session JSONL and trajectory.json exist, JSONL takes priority."""
    trial = tmp_results_dir / "run-1" / "task__1"
    _write_result(trial, _agent_timeout_payload("2026-06-25T12:30:00.000000Z"))
    _write_session(trial, [
        {"type": "message", "timestamp": "2026-06-25T11:50:00.000000Z", "message": {"role": "user"}},
        {"type": "message", "timestamp": "2026-06-25T11:55:00.000000Z", "message": {"role": "toolResult"}},
        {"type": "message", "timestamp": "2026-06-25T12:00:00.000000Z", "message": {"role": "assistant"}},
        {"customType": "llm_response_debug", "timestamp": "2026-06-25T12:00:01.000000Z",
         "data": {"toolCalls": [{"name": "bash"}]}},
    ])
    _write_trajectory(trial, [
        {"timestamp": "2026-06-25T12:28:00.000000+00:00", "source": "agent",
         "tool_calls": [{"function_name": "read"}], "metrics": {}},
    ])

    verdict = classify(trial)
    analysis = verdict.raw["agent_timeout_analysis"]
    assert analysis["timeout_status"] == "tool_hang"
    assert analysis["last_tool_name"] == "bash"
