"""Pure-function infra/quality classification for Harbor trial results.

Reads a trial's `result.json` and causal `trial.log` evidence, then returns a
Verdict. Pure: no I/O beyond reading the trial directory. Unknown primary-agent
exceptions remain agent failures when the log is available; incomplete verifier
outcomes and unscored trials whose logs are unavailable are retried because they
cannot provide meaningful pass@k evidence.

`ErrorRule` and `ERROR_RULES` are defined here and serve dual purposes:
  1. classify() uses them to assign outcome/category/subcategory.
  2. summarize_results.py imports them for evidence extraction (evidence_markers).

Intentional split: retry decisions use coarse error_category values, while
error_subcategory preserves the rule-level cause for analysis.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from math import isfinite
from pathlib import Path
from typing import Literal

from docker_health import (
    DOCKER_DAEMON_UNREACHABLE_MARKER,
    DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY,
)
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
API_KEY_BUDGET_EXCEEDED_SUBCATEGORY = "api_key_budget_exceeded"
VERIFIER_MISSING_REWARD_SUBCATEGORY = "verifier_missing_reward"
TRIAL_LOG_MISSING_SUBCATEGORY = "trial_log_missing"
TRIAL_CANCELLED_SUBCATEGORY = "trial_cancelled"
MOONSHOT_QUOTA_EXCEEDED_SUBCATEGORY = "moonshot_quota_exceeded"

# The only model-name provider whose quota exhaustion is retryable today:
# the native moonshotai/* account has a top-up mechanism that resolves
# suspension between retries. Gateway-routed or unknown provenance must
# not unlock retry (provenance of the exhausted account is unprovable).
_MOONSHOT_PROVIDER = "moonshotai"

_KIMCHI_EXIT_CODE_PATTERN = re.compile(r"\bkimchi exited with code\s+(\d+)\b")


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
    exit_code: int | None
    provider: str | None = None  # effective model provider from config (None = unproven)

    def contains_all(self, *needles: str) -> bool:
        return all(needle in self.exception_text for needle in needles)


@dataclass(frozen=True)
class ErrorRule:
    """A single classification rule used for both retry decisions and display.

    Fields:
      kind            — stable internal rule id used for evidence/debugging
      outcome         — Outcome assigned when this rule matches
      error_category  — "infra" | "agent" | null; only populated for ERROR outcome
      evidence_markers — text hints used by summarize_results.extract_error_evidence()
      exception_types — if non-empty, matches when exception_type is in this set
      exit_codes      — if non-empty, matches when the extracted process exit code
                        is in this set
      marker_groups   — text-based match: at least one group must have ALL its strings
                        present in the casefold exception text
      providers       — if not None, the rule can only match when the trial's
                        effective provider (config.agent.model_name prefix) is in
                        this set; None or unproven provider never matches
    """

    kind: str
    outcome: Outcome
    error_category: str | None
    evidence_markers: tuple[str, ...]
    exception_types: tuple[str, ...] = field(default_factory=tuple)
    exit_codes: tuple[int, ...] = field(default_factory=tuple)
    marker_groups: tuple[tuple[str, ...], ...] = field(default_factory=tuple)
    providers: tuple[str, ...] | None = None

    def matches(self, context: TrialErrorContext) -> bool:
        if self.providers is not None and context.provider not in self.providers:
            return False
        has_structured_matchers = bool(self.exception_types or self.exit_codes)
        type_matches = not self.exception_types or context.exception_type in self.exception_types
        exit_code_matches = not self.exit_codes or context.exit_code in self.exit_codes
        if has_structured_matchers and type_matches and exit_code_matches:
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
            "NetworkConnectionError",
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
    # ── Docker daemon unreachable during environment setup ──────────────────────
    # Harbor commonly wraps daemon failures in a plain RuntimeError. Match the
    # canonical connectivity marker while leaving other Docker errors, such as
    # missing images, to their phase-specific classification.
    ErrorRule(
        kind=DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY,
        outcome=Outcome.ERROR,
        error_category="infra",
        marker_groups=(
            (DOCKER_DAEMON_UNREACHABLE_MARKER,),
        ),
        evidence_markers=(DOCKER_DAEMON_UNREACHABLE_MARKER,),
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
    # ── Kimchi process failures ───────────────────────────────────────────────────
    # KimchiExitError is infra only when Kimchi used the reserved infra exit code.
    # Other Kimchi non-zero exits remain agent failures.
    ErrorRule(
        kind="kimchi_infra_exit",
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("KimchiExitError",),
        exit_codes=(os.EX_IOERR,),
        marker_groups=(("kimchi_infra_error",),),
        evidence_markers=(),
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
        marker_groups=(("api error", "524"), ("origin_response_timeout",)),
        evidence_markers=("origin_response_timeout", "524"),
    ),
    # ── Moonshot 429 account suspension (retryable: interim until the account is recharged) ──
    ErrorRule(
        kind=MOONSHOT_QUOTA_EXCEEDED_SUBCATEGORY,
        outcome=Outcome.ERROR,
        error_category="infra",
        # Moonshot-specific strings: the machine-readable type code and the
        # suspension verdict phrase. Deliberately separate from the generic
        # budget rule so retry policy can treat a rechargeable moonshot account
        # differently from a hard budget cap. Must stay before the budget rule.
        # Gated on proven moonshot provenance: only trials configured with a
        # moonshotai/* model are served by the topped-up account.
        providers=(_MOONSHOT_PROVIDER,),
        marker_groups=(
            ("exceeded_current_quota_error",),
            ("suspended due to insufficient balance",),
        ),
        evidence_markers=(
            "exceeded_current_quota_error",
            "suspended due to insufficient balance",
        ),
    ),
    # ── Provider budget / quota errors (direct exception type or in captured stdout) ──
    ErrorRule(
        kind=API_KEY_BUDGET_EXCEEDED_SUBCATEGORY,
        outcome=Outcome.ERROR,
        error_category="infra",
        exception_types=("ApiUsageLimitError",),
        marker_groups=(
            ("api key has reached its spend limit",),
            ("increase the budget in the console",),
            ("spend limit",),
            ("budget has been exceeded",),
            ("insufficient credits",),
            ("requires more credits",),
            ("usage limit has been reached",),
            ("key limit exceeded",),
            ("total limit",),
        ),
        evidence_markers=(
            "api key has reached its spend limit",
            "increase the budget in the console",
            "spend limit",
            "budget has been exceeded",
            "insufficient credits",
            "requires more credits",
            "usage limit has been reached",
            "key limit exceeded",
            "total limit",
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
        kind="model_access_error",
        outcome=Outcome.ERROR,
        error_category="agent",
        marker_groups=(("may not exist", "may not have access"),),
        evidence_markers=("may not exist", "may not have access"),
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


@dataclass(frozen=True)
class TrialLogEvidence:
    """Ordered signals from Harbor's trial log."""

    status: Literal["ok", "missing"]
    score_blocking_docker_failure: bool = False


def _has_score_blocking_docker_failure(lines: list[str]) -> bool:
    """Match a daemon failure inside one verifier test-upload operation."""
    upload_in_progress = False
    upload_daemon_failure = False

    for line in lines:
        if "docker compose down failed" in line:
            # Teardown starts a different operation. Its daemon error cannot be
            # joined to an earlier upload failure or a later traceback line.
            upload_in_progress = False
            upload_daemon_failure = False
            continue

        if (
            "docker compose cp failed" in line
            or "tar upload fallback also failed" in line
            or ("docker compose command failed" in line and " exec " in line)
        ):
            upload_in_progress = True

        if upload_in_progress and DOCKER_DAEMON_UNREACHABLE_MARKER in line:
            upload_daemon_failure = True

        if "addtestsdirerror" in line or "failed to add tests directory" in line:
            if upload_in_progress and upload_daemon_failure:
                return True
            upload_in_progress = False
            upload_daemon_failure = False

    return False


def _effective_provider(result: dict) -> str | None:
    """Effective model provider for provider-gated rules.

    Sole source: the harness-written ``config.agent.model_name`` prefix before
    the first ``/`` (same semantics as summarize_results.split_model_ref — a
    slash-less name like ``multi-model`` yields no provider). Returns None
    when the name is missing or unqualified: no proven provenance, no match.

    ``agent_info.model_info.provider`` is deliberately NOT consulted: with a
    real model it merely re-splits the same name, and without one it degrades
    to an agent-identity constant (agent identity is not routing provenance).
    """
    model_name = _get_path(result, "config", "agent", "model_name")
    if not isinstance(model_name, str) or "/" not in model_name:
        return None
    provider = model_name.split("/", 1)[0]
    return provider or None


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
        reward = float(raw)
        return reward if isfinite(reward) else None
    return None


def _read_trial_log_evidence(trial_dir: Path) -> TrialLogEvidence:
    """Extract narrow, causal Docker evidence from ``trial.log``.

    A daemon marker is score-blocking only when Harbor's verifier test upload
    fails before ``AddTestsDirError``. A marker confined to compose teardown is
    deliberately not causal.
    """
    try:
        text = (trial_dir / "trial.log").read_text(
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return TrialLogEvidence(status="missing")

    lines = [line.casefold() for line in text.splitlines()]
    return TrialLogEvidence(
        status="ok",
        score_blocking_docker_failure=_has_score_blocking_docker_failure(lines),
    )


def _infra_verdict(result: dict, reward: float | None, subcategory: str) -> Verdict:
    return Verdict(
        outcome=Outcome.ERROR,
        error_category="infra",
        error_subcategory=subcategory,
        reward=reward,
        raw=result,
    )


def _build_structured_error_context(result: dict) -> TrialErrorContext:
    """Build matching context from ``result.json`` exception fields only."""
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
        exit_code=_extract_exit_code(exception_text),
    )


def _build_error_context(trial_dir: Path, result: dict) -> TrialErrorContext:
    structured = _build_structured_error_context(result)
    pieces = [structured.exception_text]
    # For opencode agents, the actual error details (e.g. credit exhaustion) are
    # in agent/opencode.txt, not in exception_info which just says "Command failed".
    # Append the transcript text so ErrorRule marker matching can see it.
    opencode_txt = trial_dir / "agent" / "opencode.txt"
    if opencode_txt.is_file():
        try:
            transcript = opencode_txt.read_text(encoding="utf-8", errors="replace")
            pieces.append(transcript)
        except OSError:
            pass
    exception_text = "\n".join(str(p) for p in pieces if p is not None).casefold()
    return TrialErrorContext(
        exception_type=structured.exception_type,
        exception_text=exception_text,
        exit_code=_extract_exit_code(exception_text),
        provider=_effective_provider(result),
    )


def _extract_exit_code(exception_text: str) -> int | None:
    match = _KIMCHI_EXIT_CODE_PATTERN.search(exception_text)
    return int(match.group(1)) if match is not None else None


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


def _read_session_jsonl(path: Path) -> Iterator[dict]:
    """Yield valid JSON objects from one session JSONL file."""
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
        return


def _iter_session_jsonl(trial_dir: Path, pattern: str = "*.jsonl") -> Iterator[dict]:
    """Yield valid JSON objects from agent/sessions JSONL files matching pattern."""
    sessions_dir = trial_dir / "agent" / "sessions"
    if not sessions_dir.is_dir():
        return
    for path in sessions_dir.rglob(pattern):
        yield from _read_session_jsonl(path)


def _read_trajectory(trial_dir: Path) -> dict | None:
    """Load opencode's agent/trajectory.json (ATIF v1.x format). Returns None if absent."""
    path = trial_dir / "agent" / "trajectory.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _trajectory_steps_to_session_entries(step: dict) -> list[dict]:
    """Convert an ATIF trajectory step into session-JSONL-style entries.

    The timeout state machine reads (timestamp, role) pairs from message entries
    and tool-call data from llm_response_debug entries. For steps with tool calls,
    we emit both: an assistant message (for the timeline) and an
    llm_response_debug entry (for last_tool_name extraction).
    """
    source = step.get("source", "agent")
    timestamp = step.get("timestamp")
    if isinstance(timestamp, str):
        ts = timestamp
    elif isinstance(timestamp, (int, float)):
        ts = datetime.fromtimestamp(timestamp / 1000, tz=UTC).isoformat()
    else:
        ts = None

    entries: list[dict] = []

    # Emit a message entry for every step (assistant or toolResult).
    role = "toolResult" if source == "tool" else "assistant"
    entries.append({
        "type": "message",
        "timestamp": ts,
        "message": {"role": role},
    })

    # If this step dispatched tools, also emit a debug entry.
    tool_calls = step.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        names = []
        for tc in tool_calls:
            if isinstance(tc, dict):
                name = tc.get("function_name") or tc.get("name")
                names.append(str(name) if name else "unknown")
        if names:
            entries.append({
                "customType": "llm_response_debug",
                "timestamp": ts,
                "data": {"toolCalls": [{"name": n} for n in names]},
            })

    return entries


def _timeout_session_entries(trial_dir: Path) -> list[dict]:
    """The single session the timeout state machine reads.

    A workflow run writes no main.jsonl, so without a fallback every workflow timeout is
    undiagnosable (22 of 22 on TB2.1). One session, not all of them: the state machine is
    last-role x gap over a single conversation, and merging several invents a timeline.
    """
    entries = list(_iter_session_jsonl(trial_dir, "main.jsonl"))
    if entries:
        return entries

    sessions_dir = trial_dir / "agent" / "sessions"
    if not sessions_dir.is_dir():
        # Fall back to opencode trajectory.json (ATIF v1.x format).
        trajectory = _read_trajectory(trial_dir)
        if trajectory is not None:
            steps = trajectory.get("steps")
            if isinstance(steps, list):
                entries: list[dict] = []
                for s in steps:
                    if isinstance(s, dict):
                        entries.extend(_trajectory_steps_to_session_entries(s))
                return entries
        return []

    # `.events.jsonl` is a workflow's own run log, not a conversation the state machine can read.
    paths = [p for p in sorted(sessions_dir.rglob("*.jsonl")) if not p.name.endswith(".events.jsonl")]
    best: list[dict] = []
    for path in paths:
        candidate = list(_read_session_jsonl(path))
        if "orchestrator" in path.name and candidate:
            return candidate
        if len(candidate) > len(best):
            best = candidate
    return best


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
    """Build an agent_timeout_analysis dict from the trial's driving session.

    Mirrors the state machine in scripts/analyze_timeouts.py (last-role x gap).
    Always returns a dict; when the session file is missing or unreadable,
    timeout_status is "unknown" and timing fields are null/0.
    """
    exception_message = str(_get_path(result, "exception_info", "exception_message") or "")
    timeout_duration_sec = _extract_timeout_duration(exception_message)

    entries = _timeout_session_entries(trial_dir)
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


# Moonshot's account-suspension 429 carries a stable machine-readable type code
# while its human message embeds variable org/project/api-key IDs, so match the
# type code within the errorMessage instead of the full body.
_MOONSHOT_BUDGET_ERROR_TYPE = "exceeded_current_quota_error"


def _session_budget_error_subcategory(trial_dir: Path, provider: str | None) -> str | None:
    """Return the budget/quota subcategory when an agent session message marks one.

    Conservative: matches the verbatim errorMessage string the anthropic provider
    returns on a 429 spend limit (ungated), or moonshot's machine-readable
    suspension type code — but only when the trial's configured provider is
    proven moonshotai (top-up makes that account recoverable; any other
    provenance is not retried) — never free-form prose like "budget" or
    "balance". False positives would re-classify legitimate timeouts as budget
    errors, so we trade off missing other providers' budget wording for precision.

    When non-None, an AGENT_TIMEOUT verdict should be re-classified as ERROR/infra
    with this subcategory: the agent didn't time out because it was slow — it was
    blocked on a budget error and kept retrying until Harbor killed it for
    exceeding the wall-clock limit.
    """
    for entry in _iter_session_jsonl(trial_dir):
        error_message = _get_path(entry, "message", "errorMessage")
        if error_message == _BUDGET_ERROR_EXACT_MESSAGE:
            return API_KEY_BUDGET_EXCEEDED_SUBCATEGORY
        if (
            provider == _MOONSHOT_PROVIDER
            and isinstance(error_message, str)
            and _MOONSHOT_BUDGET_ERROR_TYPE in error_message
        ):
            return MOONSHOT_QUOTA_EXCEEDED_SUBCATEGORY
    return None


def _classify_exception(trial_dir: Path, result: dict, reward: float | None) -> Verdict:
    context = _build_error_context(trial_dir, result)
    for rule in ERROR_RULES:
        # Docker causality is handled before this function using structured
        # exception fields and ordered trial.log evidence. Agent transcripts
        # may mention Docker errors without making them the trial's cause.
        if rule.kind == DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY:
            continue
        if rule.matches(context):
            # A generic agent_timeout that was actually caused by a budget error is re-classified
            # before the Verdict is constructed. Keep the budget-specific subcategory visible while
            # retaining error_category="infra" for retry behavior.
            budget_subcategory = (
                _session_budget_error_subcategory(trial_dir, context.provider)
                if rule.outcome == Outcome.AGENT_TIMEOUT
                else None
            )
            if budget_subcategory is not None:
                return Verdict(
                    outcome=Outcome.ERROR,
                    error_category="infra",
                    error_subcategory=budget_subcategory,
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

    # An unrecognized verifier failure without a numeric reward is not meaningful
    # pass@k evidence. Preserve primary agent failures, but retry an incomplete
    # verifier outcome within the existing infrastructure budget.
    phase = _exception_phase(result)
    if phase == "verifier":
        return Verdict(
            outcome=Outcome.ERROR,
            error_category="infra",
            error_subcategory="missing_verdict",
            reward=reward,
            raw=result,
        )
    return Verdict(
        outcome=Outcome.ERROR,
        error_category="agent",
        error_subcategory=f"{phase}_failed",
        reward=reward,
        raw=result,
    )


def classify(trial_dir: Path) -> Verdict:
    """Classify a trial into one of four outcomes.

    Returns a Verdict with outcome, error_category, error_subcategory, reward, and the raw result.
    Defaults structured unknown exceptions to error/agent. Missing log evidence
    for an unscored exception is retryable because the verdict cannot be audited.

    A finite numeric verifier reward is required for a scored pass or failure.
    A verifier result without that reward is an incomplete, retryable verdict.
    """
    status, result = _read_result(trial_dir)

    if status == "missing":
        return Verdict(
            outcome=Outcome.ERROR,
            error_category="infra",
            error_subcategory="missing_result",
            reward=None,
            raw={},
        )

    if status == "corrupt":
        return Verdict(
            outcome=Outcome.ERROR,
            error_category="infra",
            error_subcategory="corrupt_json",
            reward=None,
            raw={},
        )

    # status == "ok"; result is a dict
    assert result is not None  # narrowing for type checkers
    verifier_result = result.get("verifier_result")
    exception_info = result.get("exception_info")
    reward = _reward(result)

    if reward is not None:
        # A numeric verifier result is authoritative. Docker teardown and other
        # cleanup failures cannot overwrite a completed pass or scored failure.
        return Verdict(
            outcome=Outcome.SCORED_PASS if reward == 1.0 else Outcome.SCORED_FAIL,
            error_category=None,
            error_subcategory=None,
            reward=reward,
            raw=result,
        )

    log_evidence = _read_trial_log_evidence(trial_dir)
    if log_evidence.status == "missing":
        return _infra_verdict(result, reward, TRIAL_LOG_MISSING_SUBCATEGORY)
    if log_evidence.score_blocking_docker_failure:
        return _infra_verdict(
            result,
            reward,
            DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY,
        )

    if exception_info is not None:
        exception_type = _get_path(result, "exception_info", "exception_type")
        context = _build_structured_error_context(result)
        structured_docker_rule = next(
            rule
            for rule in ERROR_RULES
            if rule.kind == DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY
        )
        if structured_docker_rule.matches(context):
            return _infra_verdict(
                result,
                reward,
                DOCKER_DAEMON_UNREACHABLE_SUBCATEGORY,
            )

        if exception_type == "CancelledError":
            return _infra_verdict(result, reward, TRIAL_CANCELLED_SUBCATEGORY)

        if exception_type == "RewardFileNotFoundError":
            return _infra_verdict(
                result,
                reward,
                VERIFIER_MISSING_REWARD_SUBCATEGORY,
            )

        return _classify_exception(trial_dir, result, reward)

    # A verifier result without the benchmark's numeric reward is incomplete,
    # not evidence of a scored failure.
    if verifier_result is not None:
        return Verdict(
            outcome=Outcome.ERROR,
            error_category="infra",
            error_subcategory="missing_verdict",
            reward=reward,
            raw=result,
        )

    # Defensive fallback for future refactors: the equivalent state is handled
    # above, but classify() should never fall through and return None.
    return Verdict(
        outcome=Outcome.ERROR,
        error_category="infra",
        error_subcategory="missing_verdict",
        reward=reward,
        raw=result,
    )
