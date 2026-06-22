"""Pure-function infra/quality classification for Harbor trial results.

Reads a trial's `result.json` and returns a Verdict. Pure: no I/O beyond reading
the trial directory. Conservative: unknown exception types default to
error/quality (not retried), so we never silently retry what may be a real regression.

`ErrorRule` and `ERROR_RULES` are defined here and serve dual purposes:
  1. classify() uses them to assign (outcome, error_category, error_subcategory).
  2. summarize_results.py imports them for evidence extraction (evidence_markers).

Intentional split: this module uses fine-grained rules to drive both retry and
display, replacing the previously separate coarse retry allowlists and the
summarize_results.py TrialErrorClassifier.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from outcome import Outcome


@dataclass(frozen=True)
class Verdict:
    """Classification result for a single trial."""

    outcome: Outcome
    error_category: str | None
    error_subcategory: str | None
    reward: float | None
    raw: dict


@dataclass(frozen=True)
class TrialErrorContext:
    """Extracted error signals used by ErrorRule.matches()."""

    exception_type: str | None
    exception_text: str  # casefold of type + message + traceback

    def contains_all(self, *needles: str) -> bool:
        return all(needle in self.exception_text for needle in needles)


@dataclass(frozen=True)
class ErrorRule:
    """A single classification rule used for both retry decisions and display.

    Fields:
      kind            — wire value for error_subcategory
      outcome         — Outcome assigned when this rule matches
      error_category  — "infra" | "agent" | null; only populated for ERROR outcome
      evidence_markers — text hints used by summarize_results.extract_error_evidence()
      exception_types — if non-empty, matches when exception_type is in this set
      marker_groups   — text-based match: at least one group must have ALL its strings
                        present in the casefold exception text
    """

    kind: str
    outcome: Outcome
    error_category: str | None
    evidence_markers: tuple[str, ...]
    exception_types: tuple[str, ...] = field(default_factory=tuple)
    marker_groups: tuple[tuple[str, ...], ...] = field(default_factory=tuple)

    def matches(self, context: TrialErrorContext) -> bool:
        if self.exception_types and context.exception_type in self.exception_types:
            return True
        return any(context.contains_all(*group) for group in self.marker_groups)


# Exception-type rules are listed first so they take priority over text-pattern rules
# when both could match the same result (e.g. ConnectionError exception type vs
# socket-pattern text in agent_transport_error).
ERROR_RULES: tuple[ErrorRule, ...] = (
    # ── Harbor task timeout (agent was running, Harbor killed it) ────────────────
    ErrorRule(
        kind="agent_timeout",
        outcome=Outcome.AGENT_TIMEOUT,
        error_category=None,
        exception_types=("AgentTimeoutError",),
        evidence_markers=("agent execution timed out", "timed out"),
    ),
    # ── Internal timeouts (exception occurred, but not Harbor killing the agent) ─
    ErrorRule(
        kind="verifier_timeout",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("VerifierTimeoutError",),
        evidence_markers=("verifier execution timed out", "timed out"),
    ),
    ErrorRule(
        kind="agent_setup_timeout",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("AgentSetupTimeoutError",),
        evidence_markers=("agent setup timed out", "timed out"),
    ),
    ErrorRule(
        kind="environment_setup_timeout",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("EnvironmentStartTimeoutError",),
        evidence_markers=("environment start timed out", "timed out"),
    ),
    # ── Network / API infra errors (direct exception type) ───────────────────────
    ErrorRule(
        kind="infra_network_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=(
            "ConnectionError", "TimeoutError", "NetworkError", "HTTPError",
            "RequestException", "SSLError", "RateLimitError",
            "APIConnectionError", "APITimeoutError",
        ),
        evidence_markers=("connection", "network", "timeout", "ssl", "rate limit"),
    ),
    ErrorRule(
        kind="infra_auth_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("AuthenticationError", "AuthorizationError"),
        evidence_markers=("authentication", "authorization", "auth"),
    ),
    # ── Container / runtime infra errors (direct exception type) ─────────────────
    ErrorRule(
        kind="infra_container_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=(
            "OOMKilled", "SIGKILL", "SIGTERM",
            "DockerError", "DockerDaemonError", "ContainerStartError", "RegistryPullError",
        ),
        evidence_markers=("killed", "oom", "container", "docker", "registry"),
    ),
    ErrorRule(
        kind="infra_resource_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("DiskFullError", "NoSpaceLeftOnDeviceError"),
        evidence_markers=("disk full", "no space left"),
    ),
    # ── Service infra errors (direct exception type) ──────────────────────────────
    ErrorRule(
        kind="infra_verifier_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("VerifierInfrastructureError",),
        evidence_markers=("verifier infrastructure",),
    ),
    ErrorRule(
        kind="infra_service_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("GCSUploadError", "HarborInternalError"),
        evidence_markers=("gcs", "harbor", "upload"),
    ),
    # ── Text-pattern rules (all fire on NonZeroAgentExitCodeError or any type) ────
    ErrorRule(
        kind="agent_command_timeout",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(("command timed out after",), ("agent execution timed out",)),
        evidence_markers=("command timed out after",),
    ),
    ErrorRule(
        kind="agent_stale_extension_context",
        outcome=Outcome.ERROR,
        error_category="agent",
        marker_groups=(("extension ctx is stale",),),
        evidence_markers=("extension ctx is stale",),
    ),
    ErrorRule(
        kind="agent_model_catalog_unavailable",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(
            ("kimchi_agent/gateway.py", "_fetch_model_metadata"),
            ("could not load the model list",),
            ("failed to fetch models",),
            ("models.json", "no models available"),
        ),
        evidence_markers=("could not load the model list", "failed to fetch models", "no models available"),
    ),
    ErrorRule(
        kind="agent_missing_api_key",
        outcome=Outcome.ERROR,
        error_category="agent",
        marker_groups=(("no api key found",),),
        evidence_markers=("no api key found",),
    ),
    ErrorRule(
        kind="agent_request_aborted",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(("request was aborted",),),
        evidence_markers=("request was aborted", "aborted"),
    ),
    ErrorRule(
        kind="provider_api_timeout",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(("api error", "524"), ("origin_response_timeout",), ("cloudflare", "timeout")),
        evidence_markers=("origin_response_timeout", "cloudflare", "524"),
    ),
    ErrorRule(
        kind="agent_upstream_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(
            ("hosted_vllmexception",),
            ("internalservererror",),
            ("weighted dispatch",),
            ("organization id not found",),
        ),
        evidence_markers=(
            "hosted_vllmexception",
            "internalservererror",
            "weighted dispatch",
            "organization id not found",
        ),
    ),
    ErrorRule(
        kind="agent_transport_error",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(
            ("socket connection was closed unexpectedly",),
            ("connection reset by peer",),
            ("server disconnected",),
        ),
        evidence_markers=(
            "socket connection was closed unexpectedly",
            "connection reset by peer",
            "server disconnected",
        ),
    ),
    ErrorRule(
        kind="agent_process_killed",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(
            ("killed", "/installed-agent/bin/kimchi"),
            ("command failed (exit 137)",),
            ("command failed (exit 143)",),
        ),
        evidence_markers=("killed", "exit 137", "exit 143"),
    ),
    ErrorRule(
        kind="agent_environment_error",
        outcome=Outcome.ERROR,
        error_category="agent",
        marker_groups=(("failed to resolve user",), ("cannot find -l",), ("no such file or directory",)),
        evidence_markers=("failed to resolve user", "cannot find -l", "no such file or directory"),
    ),
)

_PHASES: tuple[str, ...] = ("environment_setup", "agent_setup", "agent_execution", "verifier")


ReadResult = tuple[Literal["ok", "missing", "corrupt"], dict | None]


def _read_result(trial_dir: Path) -> ReadResult:
    """Read result.json from a trial directory with a tagged outcome.

    Returns:
        ("ok", dict)      — file exists, valid JSON, top-level is a dict
        ("missing", None) — file does not exist
        ("corrupt", None) — file exists but JSON is invalid or top-level is not a dict
    """
    result_path = trial_dir / "result.json"
    if not result_path.is_file():
        return ("missing", None)
    try:
        data = json.loads(result_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ("corrupt", None)
    if not isinstance(data, dict):
        return ("corrupt", None)
    return ("ok", data)


def _get_path(value: dict, *keys: str) -> object:
    current: object = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _reward(result: dict) -> float | None:
    raw = _get_path(result, "verifier_result", "rewards", "reward")
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    return None


def _build_error_context(result: dict) -> TrialErrorContext:
    exception_type = _get_path(result, "exception_info", "exception_type")
    pieces = [
        exception_type,
        _get_path(result, "exception_info", "exception_message"),
        _get_path(result, "exception_info", "exception_traceback"),
    ]
    exception_text = "\n".join(str(p) for p in pieces if p is not None).casefold()
    return TrialErrorContext(
        exception_type=str(exception_type) if isinstance(exception_type, str) else None,
        exception_text=exception_text,
    )


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _phase_contains_time(result: dict, phase: str, timestamp: datetime) -> bool:
    start = _parse_iso(_get_path(result, phase, "started_at"))
    end = _parse_iso(_get_path(result, phase, "finished_at"))
    return start is not None and end is not None and start <= timestamp <= end


def _exception_phase(result: dict) -> str:
    """Return the pipeline phase where an unclassified exception most likely occurred."""
    occurred_at = _parse_iso(_get_path(result, "exception_info", "occurred_at"))
    if occurred_at is not None:
        for phase in _PHASES:
            if _phase_contains_time(result, phase, occurred_at):
                return phase
    if _get_path(result, "agent_execution", "started_at") is not None:
        return "agent_execution"
    if _get_path(result, "agent_setup", "started_at") is not None:
        return "agent_setup"
    if result.get("environment_setup") is not None:
        return "environment_setup"
    if result.get("verifier") is not None:
        return "verifier"
    return "unknown"


def classify(trial_dir: Path) -> Verdict:
    """Classify a trial into one of four outcomes.

    Returns a Verdict with outcome, error_category, error_subcategory, reward, and the raw result.
    Defaults to error/quality when classification is ambiguous (conservative: don't retry unknowns).

    The discriminator between "verifier ran and reported no score" (scored_fail) and
    "verifier never ran" (error/infra missing_verdict) is the presence of the
    `verifier_result` top-level key and the absence of `exception_info`.
    """
    status, result = _read_result(trial_dir)

    if status == "missing":
        return Verdict(outcome=Outcome.ERROR, error_category="infra", error_subcategory="missing_result", reward=None, raw={})

    if status == "corrupt":
        return Verdict(outcome=Outcome.ERROR, error_category="infra", error_subcategory="corrupt_json", reward=None, raw={})

    # status == "ok"; result is a dict
    assert result is not None  # narrowing for type checkers
    verifier_result = result.get("verifier_result")
    exception_info = result.get("exception_info")
    reward = _reward(result)

    if verifier_result is None and exception_info is None:
        # No verifier result and no exception — something silently failed.
        return Verdict(outcome=Outcome.ERROR, error_category="infra", error_subcategory="missing_verdict", reward=reward, raw=result)

    # A passed trial is never an error even if the agent process crashed afterward.
    if reward == 1.0:
        return Verdict(outcome=Outcome.SCORED_PASS, error_category=None, error_subcategory=None, reward=reward, raw=result)

    # Verifier ran to completion and produced a non-pass score with no exception.
    if verifier_result is not None and exception_info is None:
        return Verdict(outcome=Outcome.SCORED_FAIL, error_category=None, error_subcategory=None, reward=reward, raw=result)

    # Exception present — run ERROR_RULES to classify.
    context = _build_error_context(result)
    for rule in ERROR_RULES:
        if rule.matches(context):
            # agent_timeout verdict is self-describing — no subcategory needed.
            # error_subcategory only carries the kind for ERROR outcome verdicts.
            subcategory = rule.kind if rule.outcome == Outcome.ERROR else None
            return Verdict(
                outcome=rule.outcome,
                error_category=rule.error_category,
                error_subcategory=subcategory,
                reward=reward,
                raw=result,
            )

    # No rule matched — unknown exception, conservatively quality (don't retry).
    phase = _exception_phase(result)
    return Verdict(
        outcome=Outcome.ERROR,
        error_category="agent",
        error_subcategory=f"{phase}_failed",
        reward=reward,
        raw=result,
    )
