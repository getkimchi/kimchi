#!/usr/bin/env python3
"""Write an overall benchmark summary JSON from local GitLab artifacts."""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

PASS_REWARD = 1.0
SUMMARY_SCHEMA_VERSION = "benchmark-summary/v1"
KIMCHI_MODEL_PROVIDERS = frozenset({"kimchi-dev"})
ERROR_EVIDENCE_LIMIT = 1_000


@dataclass
class ErrorEvidence:
    text: str = ""
    source: str = ""


@dataclass
class VerifierSummary:
    status: str
    started_at: str | None
    finished_at: str | None

    def to_summary_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {"status": self.status}
        if self.started_at is not None:
            result["started_at"] = self.started_at
        if self.finished_at is not None:
            result["finished_at"] = self.finished_at
        duration_ms = seconds_between(self.started_at, self.finished_at)
        if duration_ms is not None:
            result["duration_ms"] = duration_ms * 1000
        return result


@dataclass(frozen=True)
class ErrorClassification:
    kind: str
    evidence_markers: tuple[str, ...] = ()


@dataclass(frozen=True)
class TrialErrorContext:
    exception_type: str | None
    reward: float | None
    exception_text: str

    @classmethod
    def from_result(cls, result: dict[str, Any]) -> TrialErrorContext:
        pieces = [
            get_path(result, "exception_info", "exception_type"),
            get_path(result, "exception_info", "exception_message"),
            get_path(result, "exception_info", "exception_traceback"),
        ]
        return cls(
            exception_type=string_or_none(get_path(result, "exception_info", "exception_type")),
            reward=numeric_reward(get_path(result, "verifier_result", "rewards", "reward")),
            exception_text="\n".join(str(piece) for piece in pieces if piece is not None).casefold(),
        )

    def contains_all(self, *needles: str) -> bool:
        return all(needle in self.exception_text for needle in needles)


@dataclass(frozen=True)
class ErrorRule:
    kind: str
    evidence_markers: tuple[str, ...]
    marker_groups: tuple[tuple[str, ...], ...] = ()
    exception_types: tuple[str, ...] = ()

    def matches(self, context: TrialErrorContext) -> bool:
        if self.exception_types and context.exception_type in self.exception_types:
            return True
        return any(context.contains_all(*group) for group in self.marker_groups)

    def classify(self) -> ErrorClassification:
        return ErrorClassification(kind=self.kind, evidence_markers=self.evidence_markers)


VERIFIER_FAILED_EVIDENCE_MARKERS = ("assertionerror", "failed", "failure", "error:")
AGENT_EXIT_AFTER_SUCCESS_EVIDENCE_MARKERS = (
    "socket connection was closed unexpectedly",
    "command aborted",
    "server disconnected",
    "exit 1",
)

ERROR_RULES = (
    ErrorRule(
        kind="agent_timeout",
        exception_types=("AgentTimeoutError",),
        evidence_markers=("agent execution timed out", "timed out"),
    ),
    ErrorRule(
        kind="verifier_timeout",
        exception_types=("VerifierTimeoutError",),
        evidence_markers=("verifier execution timed out", "timed out"),
    ),
    ErrorRule(
        kind="agent_stale_extension_context",
        marker_groups=(("extension ctx is stale",),),
        evidence_markers=("extension ctx is stale",),
    ),
    ErrorRule(
        kind="agent_model_catalog_unavailable",
        marker_groups=(
            ("kimchi_agent/gateway.py", "_fetch_model_metadata"),
            ("model list", "fetch", "model"),
            ("could not load the model list",),
            ("failed to fetch models",),
            ("models.json", "no models available"),
        ),
        evidence_markers=("could not load the model list", "failed to fetch models", "no models available"),
    ),
    ErrorRule(
        kind="agent_missing_api_key",
        marker_groups=(("no api key found",),),
        evidence_markers=("no api key found",),
    ),
    ErrorRule(
        kind="agent_request_aborted",
        marker_groups=(("request was aborted",),),
        evidence_markers=("request was aborted", "aborted"),
    ),
    ErrorRule(
        kind="provider_api_timeout",
        marker_groups=(("api error", "524"), ("origin_response_timeout",), ("cloudflare", "timeout")),
        evidence_markers=("origin_response_timeout", "cloudflare", "524"),
    ),
    ErrorRule(
        kind="agent_upstream_error",
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
        kind="agent_command_timeout",
        marker_groups=(("command timed out after",),),
        evidence_markers=("command timed out after",),
    ),
    ErrorRule(
        kind="agent_process_killed",
        marker_groups=(
            ("killed", "/installed-agent/bin/kimchi"),
            ("command failed (exit 137)",),
            ("command failed (exit 143)",),
        ),
        evidence_markers=("killed", "exit 137", "exit 143"),
    ),
    ErrorRule(
        kind="agent_environment_error",
        marker_groups=(("failed to resolve user",), ("cannot find -l",), ("no such file or directory",)),
        evidence_markers=("failed to resolve user", "cannot find -l", "no such file or directory"),
    ),
)


class TrialErrorClassifier:
    PHASES = ("environment_setup", "agent_setup", "agent_execution", "verifier")

    def __init__(self, result: dict[str, Any]) -> None:
        self.result = result

    def classify(self) -> ErrorClassification | None:
        context = TrialErrorContext.from_result(self.result)
        if context.exception_type is None:
            if context.reward is not None and context.reward != PASS_REWARD:
                return ErrorClassification("verifier_failed", VERIFIER_FAILED_EVIDENCE_MARKERS)
            return None

        if context.reward == PASS_REWARD:
            return ErrorClassification("agent_exit_after_success", AGENT_EXIT_AFTER_SUCCESS_EVIDENCE_MARKERS)

        for rule in ERROR_RULES:
            if rule.matches(context):
                return rule.classify()

        phase = self._exception_phase()
        return ErrorClassification(f"{phase}_failed" if phase in self.PHASES else "unknown")

    def classify_kind(self) -> str | None:
        classification = self.classify()
        return classification.kind if classification is not None else None

    def _phase_contains_time(self, phase: str, timestamp: datetime) -> bool:
        start = parse_time(string_or_none(get_path(self.result, phase, "started_at")))
        end = parse_time(string_or_none(get_path(self.result, phase, "finished_at")))
        return start is not None and end is not None and start <= timestamp <= end

    def _exception_phase(self) -> str:
        occurred_at = parse_time(string_or_none(get_path(self.result, "exception_info", "occurred_at")))
        if occurred_at is not None:
            for phase in self.PHASES:
                if self._phase_contains_time(phase, occurred_at):
                    return phase
        if get_path(self.result, "agent_execution", "started_at") is not None:
            return "agent_execution"
        if get_path(self.result, "agent_setup", "started_at") is not None:
            return "agent_setup"
        if self.result.get("environment_setup") is not None:
            return "environment_setup"
        if self.result.get("verifier") is not None:
            return "verifier"
        return "unknown"


@dataclass
class ModelStats:
    provider: str
    model: str
    llm_rounds: int = 0
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    tool_calls: Counter[str] = field(default_factory=Counter)

    def model_name(self) -> str:
        if not self.model:
            return "unknown"
        if "/" in self.model:
            return self.model
        if self.provider and self.provider != "unknown":
            return f"{self.provider}/{self.model}"
        return self.model

    def to_summary_json(self) -> dict[str, Any]:
        return {
            "model": self.model_name(),
            "llm_rounds": self.llm_rounds,
            "tokens": {
                "input": self.input_tokens,
                "cache_read": self.cache_read_tokens,
                "cache_write": self.cache_write_tokens,
                "output": self.output_tokens,
            },
            "tools": [
                {"name": name, "calls": count}
                for name, count in sorted(self.tool_calls.items(), key=lambda item: (-item[1], item[0]))
            ],
        }


@dataclass
class SessionScan:
    start: str | None = None
    end: str | None = None
    models: dict[tuple[str, str], ModelStats] = field(default_factory=dict)


@dataclass
class TrialSummary:
    task: str
    trial_id: str
    attempt: int
    solved: bool
    reward: float | None
    exception: str | None
    exception_message: str | None
    error_kind: str | None
    total_time_seconds: int | None
    models: list[dict[str, Any]]
    trial_dir: Path
    start: str | None
    end: str | None

    def status(self) -> str:
        if self.solved:
            return "passed"
        if self.exception is not None:
            return "error"
        return "failed"

    def error(self) -> dict[str, str]:
        error_type = self.error_kind or self.exception or ""
        error_message = self.exception_message or self.exception or ""
        return {
            "type": error_type,
            "message": error_message,
        }

    def to_summary_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "trial_id": self.trial_id,
            "task": self.task,
            "attempt": self.attempt,
            "status": self.status(),
            "score": self.reward,
            "error": self.error(),
            "models": self.models,
        }
        if self.total_time_seconds is not None:
            result["duration_ms"] = self.total_time_seconds * 1000
        return result


def getenv(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path: Path, warnings: list[str]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)
    except OSError as exc:
        warnings.append(f"Could not read JSON file {path}: {exc}")
        return {}
    except json.JSONDecodeError as exc:
        warnings.append(f"Could not parse JSON file {path}: {exc}")
        return {}
    if not isinstance(value, dict):
        warnings.append(f"JSON file {path} did not contain an object")
        return {}
    return value


def load_optional_json(path: Path, warnings: list[str]) -> dict[str, Any]:
    return load_json(path, warnings) if path.is_file() else {}


def iter_jsonl(path: Path, warnings: list[str]):
    try:
        file = path.open(encoding="utf-8", errors="replace")
    except OSError as exc:
        warnings.append(f"Could not read JSONL file {path}: {exc}")
        return
    with file:
        for line_no, line in enumerate(file, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line, parse_float=Decimal)
            except json.JSONDecodeError:
                warnings.append(f"Skipped malformed JSONL entry at {path}:{line_no}")
                continue
            if isinstance(value, dict):
                yield value


def get_path(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def rfc3339_utc(value: str | None) -> str | None:
    parsed = parse_time(value)
    if parsed is None:
        return None
    return parsed.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def seconds_between(start: str | None, end: str | None) -> int | None:
    start_dt = parse_time(start)
    end_dt = parse_time(end)
    if start_dt is None or end_dt is None:
        return None
    seconds = int((end_dt - start_dt).total_seconds())
    return seconds if seconds >= 0 else None


def numeric_reward(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except ValueError:
        return None


def is_kimchi_model_provider(provider: str) -> bool:
    return provider.casefold() in KIMCHI_MODEL_PROVIDERS


def configured_model_ref(result: dict[str, Any]) -> tuple[str, str]:
    return split_model_ref(string_or_none(get_path(result, "config", "agent", "model_name")))


def priced_stats_ref(stats: ModelStats, fallback_model: tuple[str, str] | None) -> tuple[str, str]:
    if fallback_model is None:
        return stats.provider, stats.model

    fallback_provider, fallback_model_id = fallback_model
    if stats.provider == "unknown" and stats.model.casefold() == fallback_model_id.casefold():
        return fallback_provider, fallback_model_id
    return stats.provider, stats.model


def int_value(value: Any) -> int:
    if value is None or isinstance(value, bool):
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def int_from_keys(value: dict[str, Any], *keys: str) -> int:
    for key in keys:
        if key in value:
            return int_value(value.get(key))
    return 0


def string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def metadata_string(metadata: dict[str, Any], key: str, default: str = "unknown") -> str:
    value = metadata.get(key)
    if value is None:
        return default
    text = str(value)
    return text if text else default


def metadata_dict(metadata: dict[str, Any], key: str) -> dict[str, Any]:
    value = metadata.get(key)
    return value if isinstance(value, dict) else {}


def split_model_ref(value: str | None) -> tuple[str, str]:
    if value and "/" in value:
        provider, model = value.split("/", 1)
        return provider or "unknown", model or "unknown"
    return "unknown", value or "unknown"


def resolve_message_model(message: dict[str, Any], current_model: tuple[str, str] | None) -> tuple[str, str]:
    provider = message.get("provider")
    model = message.get("model")
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return provider, model
    if isinstance(model, str) and model:
        return split_model_ref(model)
    if current_model is not None:
        return current_model
    return "unknown", "unknown"


def model_stats(models: dict[tuple[str, str], ModelStats], provider: str, model: str) -> ModelStats:
    key = (provider, model)
    if key not in models:
        models[key] = ModelStats(provider=provider, model=model)
    return models[key]


def tool_call_names(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    names: list[str] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "toolCall":
            continue
        name = item.get("name")
        names.append(str(name) if name else "unknown")
    return names


def scan_session_file(path: Path, warnings: list[str]) -> SessionScan:
    scan = SessionScan()
    current_model: tuple[str, str] | None = None
    for entry in iter_jsonl(path, warnings):
        timestamp = entry.get("timestamp")
        if isinstance(timestamp, str):
            scan.start = min(scan.start, timestamp) if scan.start else timestamp
            scan.end = max(scan.end, timestamp) if scan.end else timestamp

        if entry.get("type") == "model_change":
            provider = entry.get("provider")
            model_id = entry.get("modelId")
            if isinstance(provider, str) and isinstance(model_id, str):
                current_model = (provider or "unknown", model_id or "unknown")

        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue

        provider, model = resolve_message_model(message, current_model)
        stats = model_stats(scan.models, provider, model)

        usage = message.get("usage")
        if isinstance(usage, dict):
            stats.llm_rounds += 1
            stats.input_tokens += int_from_keys(usage, "input", "input_tokens")
            stats.cache_read_tokens += int_from_keys(usage, "cacheRead", "cache_read", "cache_read_input_tokens")
            stats.cache_write_tokens += int_from_keys(
                usage,
                "cacheWrite",
                "cache_write",
                "cache_creation_input_tokens",
            )
            stats.output_tokens += int_from_keys(usage, "output", "output_tokens")

        for name in tool_call_names(message.get("content")):
            stats.tool_calls[name] += 1
    return scan


def merge_session_scans(scans: list[SessionScan]) -> SessionScan:
    merged = SessionScan()
    for scan in scans:
        if scan.start:
            merged.start = min(merged.start, scan.start) if merged.start else scan.start
        if scan.end:
            merged.end = max(merged.end, scan.end) if merged.end else scan.end
        for key, stats in scan.models.items():
            target = model_stats(merged.models, key[0], key[1])
            target.llm_rounds += stats.llm_rounds
            target.input_tokens += stats.input_tokens
            target.cache_read_tokens += stats.cache_read_tokens
            target.cache_write_tokens += stats.cache_write_tokens
            target.output_tokens += stats.output_tokens
            target.tool_calls.update(stats.tool_calls)
    return merged


def normalize_session_scan_models(scan: SessionScan, fallback_model: tuple[str, str]) -> SessionScan:
    normalized = SessionScan(start=scan.start, end=scan.end)
    for stats in scan.models.values():
        provider, model = priced_stats_ref(stats, fallback_model)
        target = model_stats(normalized.models, provider, model)
        target.llm_rounds += stats.llm_rounds
        target.input_tokens += stats.input_tokens
        target.cache_read_tokens += stats.cache_read_tokens
        target.cache_write_tokens += stats.cache_write_tokens
        target.output_tokens += stats.output_tokens
        target.tool_calls.update(stats.tool_calls)
    return normalized


def model_sort_key(stats: ModelStats) -> tuple[int, str, str]:
    total_tokens = stats.input_tokens + stats.cache_read_tokens + stats.cache_write_tokens + stats.output_tokens
    return -total_tokens, stats.provider, stats.model


def is_trial_dir(path: Path) -> bool:
    if not path.is_dir() or "__" not in path.name:
        return False
    result_path = path / "result.json"
    if not result_path.is_file():
        return False
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"), parse_float=Decimal)
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(result, dict) and isinstance(result.get("trial_name"), str)


def find_trial_dirs(results_dir: Path) -> list[Path]:
    if is_trial_dir(results_dir):
        return [results_dir]
    immediate = sorted(path for path in results_dir.iterdir() if is_trial_dir(path)) if results_dir.is_dir() else []
    if immediate:
        return immediate
    if not results_dir.is_dir():
        return []
    trials: list[Path] = []
    for run_dir in sorted(path for path in results_dir.iterdir() if path.is_dir()):
        trials.extend(sorted(path for path in run_dir.iterdir() if is_trial_dir(path)))
    return trials


def trial_total_time(result: dict[str, Any], session_scan: SessionScan) -> int | None:
    total = seconds_between(
        string_or_none(get_path(result, "agent_execution", "started_at")),
        string_or_none(get_path(result, "verifier", "finished_at")),
    )
    if total is not None:
        return total
    total = seconds_between(
        string_or_none(get_path(result, "agent_execution", "started_at")),
        string_or_none(get_path(result, "agent_execution", "finished_at")),
    )
    if total is not None:
        return total
    return seconds_between(session_scan.start, session_scan.end)


def verifier_summary(result: dict[str, Any]) -> VerifierSummary:
    started_at = string_or_none(get_path(result, "verifier", "started_at"))
    finished_at = string_or_none(get_path(result, "verifier", "finished_at"))
    exception = string_or_none(get_path(result, "exception_info", "exception_type"))
    if finished_at is not None:
        status = "timeout" if exception == "VerifierTimeoutError" else "completed"
    elif started_at is not None:
        status = "started"
    else:
        status = "not_started"
    return VerifierSummary(status=status, started_at=started_at, finished_at=finished_at)


def file_excerpt(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def session_error_text(path: Path, warnings: list[str]) -> str:
    pieces: list[str] = []
    for entry in iter_jsonl(path, warnings):
        if entry.get("customType") == "agent_terminated":
            reason = get_path(entry, "data", "reason")
            if reason:
                pieces.append(f"agent terminated: {reason}")

        message = entry.get("message")
        if not isinstance(message, dict):
            continue

        if message.get("role") == "tool" or message.get("isError") is True:
            for item in message_content_text(message.get("content")):
                pieces.append(item)
            continue

        if message.get("role") != "toolResult":
            continue
        for item in message_content_text(message.get("content")):
            pieces.append(item)
    return "\n".join(pieces)


def message_content_text(content: Any) -> list[str]:
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    pieces: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str):
            pieces.append(text)
    return pieces


def error_marker_line(text: str, preferred_markers: tuple[str, ...] = ()) -> str:
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        lowered = candidate.casefold()
        if any(marker in lowered for marker in preferred_markers):
            return candidate[:ERROR_EVIDENCE_LIMIT]
    return ""


def generic_error_marker_line(text: str) -> str:
    markers = (
        "error:",
        "exception",
        "traceback",
        "failed",
        "failure",
        "timeout",
        "timed out",
        "aborted",
        "no api key",
        "stale",
        "module not found",
        "assertionerror",
        "command failed",
        "exit 1",
        "no such file",
    )
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        lowered = candidate.casefold()
        if any(marker in lowered for marker in markers):
            return candidate[:ERROR_EVIDENCE_LIMIT]
    return ""


def first_nonempty_line(text: str) -> str:
    for line in text.splitlines():
        candidate = line.strip()
        if candidate:
            return candidate[:ERROR_EVIDENCE_LIMIT]
    return ""


def extract_error_evidence(
    result: dict[str, Any],
    trial_dir: Path,
    session_files: list[Path],
    warnings: list[str],
    classification: ErrorClassification,
) -> ErrorEvidence:
    error_kind = classification.kind
    sources: list[tuple[str, str]] = []
    session_text = "\n".join(session_error_text(path, warnings) for path in session_files)
    if session_text.strip():
        sources.append(("agent/session", session_text))

    verifier_stdout = file_excerpt(trial_dir / "verifier" / "test-stdout.txt")
    if error_kind == "verifier_failed" and verifier_stdout.strip():
        sources.append(("verifier/test-stdout.txt", verifier_stdout))

    exception_text = string_or_none(get_path(result, "exception_info", "exception_message"))
    if exception_text:
        sources.append(("result.exception_info.exception_message", exception_text))

    for relative in (Path("exception.txt"), Path("trial.log")):
        text = file_excerpt(trial_dir / relative)
        if text.strip():
            sources.append((str(relative), text))

    if error_kind != "verifier_failed" and verifier_stdout.strip():
        sources.append(("verifier/test-stdout.txt", verifier_stdout))

    preferred_markers = classification.evidence_markers
    if preferred_markers:
        for source, text in sources:
            evidence = error_marker_line(text, preferred_markers)
            if evidence:
                return ErrorEvidence(text=evidence, source=source)

    for source, text in sources:
        evidence = generic_error_marker_line(text)
        if evidence:
            return ErrorEvidence(text=evidence, source=source)

    for source, text in sources:
        evidence = first_nonempty_line(text)
        if evidence:
            return ErrorEvidence(text=evidence, source=source)

    reward = numeric_reward(get_path(result, "verifier_result", "rewards", "reward"))
    if reward is not None and reward != PASS_REWARD:
        return ErrorEvidence(text=f"Verifier reward was {reward}", source="verifier_result.rewards.reward")

    return ErrorEvidence()


def run_bounds(results_dir: Path, trials: list[TrialSummary]) -> tuple[str | None, str | None]:
    run_results: list[dict[str, Any]] = []
    warnings: list[str] = []
    for run_dir in sorted({trial.trial_dir.parent for trial in trials}):
        result = load_optional_json(run_dir / "result.json", warnings)
        if result:
            run_results.append(result)

    starts = [result.get("started_at") for result in run_results if isinstance(result.get("started_at"), str)]
    ends = [result.get("finished_at") for result in run_results if isinstance(result.get("finished_at"), str)]
    if starts or ends:
        return (min(starts) if starts else None, max(ends) if ends else None)

    trial_starts = [trial.start for trial in trials if trial.start is not None]
    trial_ends = [trial.end for trial in trials if trial.end is not None]
    if not trial_starts and not trial_ends and results_dir.is_file():
        return None, None
    return (min(trial_starts) if trial_starts else None, max(trial_ends) if trial_ends else None)


def summarize_trial(trial_dir: Path, attempt: int, warnings: list[str]) -> TrialSummary:
    result = load_json(trial_dir / "result.json", warnings)
    session_files = sorted(path for path in (trial_dir / "agent" / "sessions").rglob("*.jsonl") if path.is_file())
    if not session_files and not (trial_dir / "agent" / "claude-code.txt").is_file():
        warnings.append(f"No agent transcript artifacts found for trial {trial_dir.name}")
    session_scan = merge_session_scans([scan_session_file(path, warnings) for path in session_files])
    model_ref = configured_model_ref(result)
    if is_kimchi_model_provider(model_ref[0]):
        session_scan = normalize_session_scan_models(session_scan, model_ref)

    reward = numeric_reward(get_path(result, "verifier_result", "rewards", "reward"))
    exception = string_or_none(get_path(result, "exception_info", "exception_type"))
    exception_message = string_or_none(get_path(result, "exception_info", "exception_message"))
    classifier = TrialErrorClassifier(result)
    classification = classifier.classify()
    error_kind = classification.kind if classification is not None else None
    error_evidence = (
        extract_error_evidence(result, trial_dir, session_files, warnings, classification)
        if classification is not None
        else ErrorEvidence()
    )
    error_message = error_evidence.text or exception_message
    total_time_seconds = trial_total_time(result, session_scan)
    task = trial_dir.name.split("__", 1)[0]
    return TrialSummary(
        task=task,
        trial_id=trial_dir.name,
        attempt=attempt,
        solved=reward == PASS_REWARD,
        reward=reward,
        exception=exception,
        exception_message=error_message,
        error_kind=error_kind,
        total_time_seconds=total_time_seconds,
        models=[stats.to_summary_json() for stats in sorted(session_scan.models.values(), key=model_sort_key)],
        trial_dir=trial_dir,
        start=string_or_none(get_path(result, "agent_execution", "started_at")) or session_scan.start,
        end=string_or_none(get_path(result, "verifier", "finished_at"))
        or string_or_none(get_path(result, "agent_execution", "finished_at"))
        or session_scan.end,
    )


def build_run(
    metadata: dict[str, Any],
    started_at: str | None,
    finished_at: str | None,
    generated_at: str,
) -> dict[str, Any]:
    gitlab = metadata_dict(metadata, "gitlab")
    gcs = metadata_dict(metadata, "gcs")
    start = rfc3339_utc(started_at) or generated_at
    end = rfc3339_utc(finished_at) or start
    run_id = str(gcs.get("run_id") or gitlab.get("job_id") or gitlab.get("pipeline_id") or "") or "unknown"
    source_sha = str(gitlab.get("target_commit_sha") or gitlab.get("commit_sha") or "") or "unknown"
    return {
        "benchmark": metadata_string(metadata, "benchmark"),
        "run_id": run_id,
        "status": "completed",
        "started_at": start,
        "ended_at": end,
        "agent": {
            "name": metadata_string(metadata, "coding_agent"),
            "version": source_sha,
        },
        "configuration": metadata_string(metadata, "configuration", "na"),
        "model": metadata_string(metadata, "model"),
    }


def build_source(metadata: dict[str, Any]) -> dict[str, Any]:
    gitlab = metadata_dict(metadata, "gitlab")
    return {
        "gitlab": {
            "ref": str(gitlab.get("target_ref") or gitlab.get("ref") or ""),
            "commit_sha": str(gitlab.get("target_commit_sha") or gitlab.get("commit_sha") or ""),
        },
    }


def build_summary(
    metadata: dict[str, Any],
    trials: list[TrialSummary],
    started_at: str | None,
    finished_at: str | None,
    generated_at: str,
) -> dict[str, Any]:
    return {
        "schema_version": SUMMARY_SCHEMA_VERSION,
        "run": build_run(metadata, started_at, finished_at, generated_at),
        "trials": [trial.to_summary_json() for trial in trials],
        "source": build_source(metadata),
    }


def write_summary(metadata_path: Path, output_path: Path, results_dir_override: Path | None = None) -> int:
    warnings: list[str] = []
    if metadata_path.is_file():
        metadata = load_json(metadata_path, warnings)
    else:
        warnings.append(f"No benchmark run metadata found at {metadata_path}")
        metadata = {}
    results_dir = results_dir_override or Path(
        metadata_string(metadata, "results_dir", "benchmark/terminal-bench-2/jobs")
    )
    trial_dirs = find_trial_dirs(results_dir)
    if not trial_dirs:
        warnings.append(f"No trial result directories found under {results_dir}")

    attempts_by_task: defaultdict[str, int] = defaultdict(int)
    trials: list[TrialSummary] = []
    for trial_dir in sorted(trial_dirs, key=lambda path: (path.name.split("__", 1)[0], path.name)):
        task = trial_dir.name.split("__", 1)[0]
        attempts_by_task[task] += 1
        trials.append(summarize_trial(trial_dir, attempts_by_task[task], warnings))

    started_at, finished_at = run_bounds(results_dir, trials)
    generated_at = utc_now()
    summary = build_summary(metadata, trials, started_at, finished_at, generated_at)
    for warning in warnings:
        print(f"Warning: {warning}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote benchmark summary to {output_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write summary.json from benchmark job artifacts.")
    parser.add_argument(
        "--metadata",
        type=Path,
        default=Path(getenv("BENCHMARK_RUN_METADATA", ".benchmark/run-metadata.json")),
        help="Path to benchmark run metadata JSON.",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=None,
        help="Override benchmark results directory. Defaults to metadata.results_dir.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(getenv("BENCHMARK_SUMMARY_PATH", ".benchmark/summary.json")),
        help="Output summary JSON path.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return write_summary(args.metadata, args.output, args.results_dir)


if __name__ == "__main__":
    raise SystemExit(main())
