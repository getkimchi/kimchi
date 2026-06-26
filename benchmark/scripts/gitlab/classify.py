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
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from outcome import Outcome


# Gap threshold used when inspecting the agent session JSONL for an
# AgentTimeoutError. Matches the default in scripts/analyze_timeouts.py.
_AGENT_TIMEOUT_GAP_SEC = 120


# Timeout-status labels stored in agent_timeout_analysis.timeout_status.
# These are bare strings (no prefix) — the verdict's error_subcategory
# remains None for AGENT_TIMEOUT so downstream consumers read the cause
# from the analysis dict instead.
_TIMEOUT_STATUS_AGENT_IN_FLIGHT = "agent_in_flight"
_TIMEOUT_STATUS_LOOP_STALLED = "loop_stalled"
_TIMEOUT_STATUS_TOOL_HANG = "tool_hang"
_TIMEOUT_STATUS_INFERENCE_HANG = "inference_hang"
_TIMEOUT_STATUS_TOOL_RETURNED = "tool_returned"
_TIMEOUT_STATUS_TOOL_IN_FLIGHT = "tool_in_flight"
_TIMEOUT_STATUS_FEW_TURNS = "few_turns"
_TIMEOUT_STATUS_UNKNOWN = "unknown"


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
    # ── Provider budget / quota errors (direct exception type or in captured stdout) ──
    ErrorRule(
        kind="api_key_budget_exceeded",
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(
            ("api key has reached its spend limit",),
            ("increase the budget in the console",),
            ("spend limit",),
            ("budget has been exceeded",),
            ("insufficient credits",),
            ("usage limit has been reached",),
        ),
        evidence_markers=(
            "api key has reached its spend limit",
            "increase the budget in the console",
            "spend limit",
            "budget has been exceeded",
            "insufficient credits",
            "usage limit has been reached",
        ),
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


def _iter_session_jsonl(trial_dir: Path, pattern: str = "*.jsonl") -> Iterator[dict]:
    """Yield valid JSON objects from agent/sessions JSONL files matching pattern."""
    sessions_dir = trial_dir / "agent" / "sessions"
    if not sessions_dir.is_dir():
        return
    for path in sessions_dir.rglob(pattern):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(entry, dict):
                        yield entry
        except OSError:
            continue


def _extract_timeout_duration(msg: str) -> float | None:
    """Pull the 'after X.Y seconds' value out of an exception message."""
    m = re.search(r"after\s+([0-9]+(?:\.[0-9]+)?)\s+seconds", msg or "")
    return float(m.group(1)) if m else None


def _empty_timeout_analysis(timeout_duration_sec: float | None) -> dict:
    """Return an agent_timeout_analysis dict for when we have no session data."""
    return {
        "timeout_status": _TIMEOUT_STATUS_UNKNOWN,
        "last_role": "",
        "last_tool_name": None,
        "n_messages": 0,
        "time_since_last_message_sec": None,
        "time_since_last_assistant_message_sec": None,
        "timeout_duration_sec": timeout_duration_sec,
        "gap_fraction": None,
    }


def _analyze_agent_timeout(trial_dir: Path, result: dict) -> dict:
    """Build an agent_timeout_analysis dict from agent/sessions/main.jsonl.

    Mirrors the state machine in scripts/analyze_timeouts.py (last-role × gap).
    Always returns a dict; when the session file is missing or unreadable,
    timeout_status is "unknown" and timing fields are null/0.
    """
    exception_message = str(_get_path(result, "exception_info", "exception_message") or "")
    timeout_duration_sec = _extract_timeout_duration(exception_message)

    entries = list(_iter_session_jsonl(trial_dir, "main.jsonl"))
    if not entries:
        return _empty_timeout_analysis(timeout_duration_sec)

    timeout_at = _parse_iso(_get_path(result, "exception_info", "occurred_at"))
    if timeout_at is None:
        timeout_at = _parse_iso(result.get("finished_at"))
    if timeout_at is None:
        return _empty_timeout_analysis(timeout_duration_sec)

    # Collect message entries: (timestamp, role).
    msg_pairs: list[tuple[datetime, str]] = []
    for e in entries:
        if e.get("type") != "message":
            continue
        msg = e.get("message") or {}
        ts = _parse_iso(e.get("timestamp"))
        if ts is not None:
            msg_pairs.append((ts, str(msg.get("role", ""))))

    n_messages = len(msg_pairs)
    last_role = ""
    last_tool_name: str | None = None
    time_since_last_message_sec: float | None = None
    time_since_last_assistant_message_sec: float | None = None

    if msg_pairs:
        last_msg_ts, last_role = msg_pairs[-1]
        gap = (timeout_at - last_msg_ts).total_seconds()
        time_since_last_message_sec = max(0.0, gap)

        asst_msgs = [ts for ts, _ in msg_pairs if _ == "assistant"]
        if asst_msgs:
            last_asst_ts = asst_msgs[-1]
            time_since_last_assistant_message_sec = max(
                0.0, (timeout_at - last_asst_ts).total_seconds()
            )

    # Last tool name from the final llm_response_debug entry.
    debug_entries = [e for e in entries if e.get("customType") == "llm_response_debug"]
    if debug_entries:
        last_calls = (debug_entries[-1].get("data") or {}).get("toolCalls") or []
        if last_calls and isinstance(last_calls, list):
            last_tool_name = (last_calls[0] or {}).get("name")

    # State machine — identical thresholds to analyze_timeouts.py.
    timeout_status = _TIMEOUT_STATUS_UNKNOWN
    if n_messages <= 2:
        timeout_status = _TIMEOUT_STATUS_FEW_TURNS
    elif msg_pairs:
        gap = time_since_last_message_sec if time_since_last_message_sec is not None else 0.0
        if last_tool_name == "Agent":
            timeout_status = _TIMEOUT_STATUS_AGENT_IN_FLIGHT
        elif last_role == "assistant" and last_tool_name is None and gap >= _AGENT_TIMEOUT_GAP_SEC:
            timeout_status = _TIMEOUT_STATUS_LOOP_STALLED
        elif last_role == "toolResult" and gap < _AGENT_TIMEOUT_GAP_SEC:
            timeout_status = _TIMEOUT_STATUS_TOOL_RETURNED
        elif last_role == "assistant" and gap < _AGENT_TIMEOUT_GAP_SEC:
            timeout_status = _TIMEOUT_STATUS_TOOL_IN_FLIGHT
        elif last_role == "toolResult":
            timeout_status = _TIMEOUT_STATUS_INFERENCE_HANG
        elif last_role == "assistant" and last_tool_name is not None:
            timeout_status = _TIMEOUT_STATUS_TOOL_HANG

    gap_fraction: float | None = None
    if time_since_last_message_sec is not None and timeout_duration_sec:
        gap_fraction = time_since_last_message_sec / timeout_duration_sec

    return {
        "timeout_status": timeout_status,
        "last_role": last_role,
        "last_tool_name": last_tool_name,
        "n_messages": n_messages,
        "time_since_last_message_sec": time_since_last_message_sec,
        "time_since_last_assistant_message_sec": time_since_last_assistant_message_sec,
        "timeout_duration_sec": timeout_duration_sec,
        "gap_fraction": gap_fraction,
    }


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


# Exact errorMessage body the anthropic provider returns on a 429 spend limit.
# Match exactly (not as a substring) so unrelated "spend limit" / "budget" mentions
# in agent logs do not false-positive the budget classification.
_BUDGET_ERROR_EXACT_MESSAGE = (
    '429 "API key has reached its spend limit.\\n'
    'Increase the budget in the console or contact your '
    'organization admin to continue."'
)


def _session_marks_budget_error(trial_dir: Path) -> bool:
    """Whether an agent session message has the exact anthropic 429 spend-limit errorMessage.

    Conservative: matches the verbatim errorMessage string from the provider's 429 response,
    not substrings or variants. False positives would re-classify legitimate timeouts as
    budget errors, so we trade off missing other providers' budget wording for precision.

    When True, an AGENT_TIMEOUT verdict should be re-classified as ERROR/infra/budget:
    the agent didn't time out because it was slow — it was blocked on a budget error and
    kept retrying until Harbor killed it for exceeding the wall-clock limit.
    """
    for entry in _iter_session_jsonl(trial_dir):
        error_message = _get_path(entry, "message", "errorMessage")
        if error_message == _BUDGET_ERROR_EXACT_MESSAGE:
            return True
    return False


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
            # A generic agent_timeout that was actually caused by a budget error is re-classified
            # before the Verdict is constructed — no Verdict-then-replace. Same wire values as the
            # direct 429 case, so dashboards can filter on error_subcategory alone.
            if rule.outcome == Outcome.AGENT_TIMEOUT and _session_marks_budget_error(trial_dir):
                return Verdict(
                    outcome=Outcome.ERROR,
                    error_category="infra",
                    error_subcategory="api_key_budget_exceeded",
                    reward=reward,
                    raw=result,
                )

            if rule.outcome == Outcome.AGENT_TIMEOUT:
                # Inspect the agent session JSONL to locate where the timeout
                # happened (model API, tool executor, subagent dispatch, etc.).
                # The cause lives in raw["agent_timeout_analysis"]; subcategory
                # stays None so consumers don't conflate it with retry buckets.
                analysis = _analyze_agent_timeout(trial_dir, result)
                result = {**result, "agent_timeout_analysis": analysis}
                subcategory: str | None = None
            else:
                subcategory = rule.kind

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
