#!/usr/bin/env python3
"""Write an overall benchmark summary JSON from local GitLab artifacts."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from bench_config import is_retryable, should_retry_agent_timeout
from classify import ERROR_RULES, ErrorRule, classify
from outcome import Outcome

# Lookup used by extract_error_evidence() to find evidence_markers by kind.
_KIND_TO_RULE: dict[str, ErrorRule] = {r.kind: r for r in ERROR_RULES}

PASS_REWARD = 1.0
SUMMARY_SCHEMA_VERSION = "benchmark-summary/v2"
MAX_CHUNK_ATTEMPTS = 3  # 1 initial + 2 retries (matches YAML retry: 2)
KIMCHI_MODEL_PROVIDERS = frozenset({"kimchi-dev"})
ERROR_EVIDENCE_LIMIT = 1_000


def _convert_decimals(value: Any) -> Any:
    """Recursively convert Decimal values to float for JSON serialization."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _convert_decimals(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_convert_decimals(v) for v in value]
    return value


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
    total_time_seconds: int | None
    models: list[dict[str, Any]]
    trial_dir: Path
    start: str | None
    end: str | None
    error_category: str | None = None
    error_subcategory: str | None = None
    outcome: Outcome = Outcome.SCORED_FAIL
    agent_timeout_analysis: dict[str, Any] | None = None

    def status(self) -> str:
        return "passed" if self.outcome == Outcome.SCORED_PASS else "failed"

    def error(self) -> dict[str, str] | None:
        if self.outcome == Outcome.SCORED_PASS:
            return None
        return {
            "type": self.error_subcategory or self.exception or "",
            "message": self.exception_message or self.exception or "",
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
        result["error_category"] = self.error_category
        result["error_subcategory"] = self.error_subcategory
        result["verdict"] = self.outcome
        if self.agent_timeout_analysis is not None:
            result["agent_timeout_analysis"] = self.agent_timeout_analysis
        return result


@dataclass
class TaskVerdict:
    """Aggregated result for a single benchmark task across all attempts."""

    task: str
    attempts: list[TrialSummary]
    final_outcome: Outcome
    passed: bool

    def final_verdict(self) -> str:
        return "passed" if self.passed else "failed"

    def _attempt_label(self, trial: TrialSummary) -> str:
        label = str(trial.outcome)
        if trial.outcome == Outcome.ERROR and trial.error_subcategory:
            label = f"{label} ({trial.error_subcategory})"
        return label


def build_task_verdicts(trials: list[TrialSummary]) -> list[TaskVerdict]:
    """Group trials by task and compute the final task verdict.

    A task passes if any attempt passed. Otherwise the final outcome is the
    outcome of the last attempt (highest attempt number).
    """
    by_task: dict[str, list[TrialSummary]] = defaultdict(list)
    for trial in trials:
        by_task[trial.task].append(trial)

    verdicts: list[TaskVerdict] = []
    for task in sorted(by_task):
        # Sort by real start time so the table reflects chronological order,
        # not the alphabetical order of random trial directory suffixes.
        attempts = sorted(
            by_task[task],
            key=lambda t: parse_time(t.start) or datetime.min.replace(tzinfo=UTC),
        )
        passed = any(t.outcome == Outcome.SCORED_PASS for t in attempts)
        final_outcome = Outcome.SCORED_PASS if passed else (attempts[-1].outcome if attempts else Outcome.SCORED_FAIL)
        verdicts.append(TaskVerdict(task=task, attempts=attempts, final_outcome=final_outcome, passed=passed))
    return verdicts


def format_task_table(verdicts: list[TaskVerdict]) -> str:
    """Format a Markdown table of task outcomes suitable for CI logs."""
    if not verdicts:
        return "No task results to display."

    header = ["Task", "Outcomes", "Final verdict"]
    rows: list[list[str]] = [header]

    for v in verdicts:
        outcomes = " → ".join(v._attempt_label(t) for t in v.attempts)
        final = f"{v.final_verdict()} ({v._attempt_label(v.attempts[-1])})"
        rows.append([v.task, outcomes, final])

    widths = [max(len(row[i]) for row in rows) for i in range(len(header))]

    def fmt_row(cells: list[str]) -> str:
        return "| " + " | ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells)) + " |"

    separator = fmt_row(["-" * w for w in widths])
    return "\n".join([fmt_row(rows[0]), separator] + [fmt_row(row) for row in rows[1:]])


def format_totals(totals: dict[str, Any]) -> str:
    """Format the totals block as a readable summary for CI logs."""
    trials = totals.get("trials") or {}
    tasks = totals.get("tasks") or {}

    trial_breakdown = (
        f"scored_pass={trials.get('scored_pass', 0)} "
        f"scored_fail={trials.get('scored_fail', 0)} "
        f"agent_timeout={trials.get('agent_timeout', 0)} "
        f"error={trials.get('error', 0)}"
    )
    task_breakdown = (
        f"scored_pass={tasks.get('scored_pass', 0)} "
        f"scored_fail={tasks.get('scored_fail', 0)} "
        f"agent_timeout={tasks.get('agent_timeout', 0)} "
        f"error={tasks.get('error', 0)} "
        f"no_verdict={tasks.get('no_verdict', 0)}"
    )

    trial_line = (
        f"Trials:  recorded={trials.get('recorded', 0):>3} / "
        f"expected={trials.get('expected', 0):>3}  ({trial_breakdown})"
    )
    task_line = f"Tasks:   expected={tasks.get('expected', 0):>3}  ({task_breakdown})"

    lines = [
        "Benchmark totals",
        "================",
        trial_line,
        task_line,
        f"Tasks with retryable outcome: {totals.get('tasks_with_retryable_outcome', 0)}",
    ]
    return "\n".join(lines)


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


def metadata_bool(metadata: dict[str, Any], key: str, default: bool = False) -> bool:
    value = metadata.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return default


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


def _usage_tuple(usage: dict[str, Any]) -> tuple[int, int, int, int]:
    """Extract a hashable usage signature for deduplication."""
    return (
        int_from_keys(usage, "input", "input_tokens"),
        int_from_keys(usage, "cacheRead", "cache_read", "cache_read_input_tokens"),
        int_from_keys(usage, "cacheWrite", "cache_write", "cache_creation_input_tokens"),
        int_from_keys(usage, "output", "output_tokens"),
    )


def scan_session_file(path: Path, warnings: list[str]) -> SessionScan:
    scan = SessionScan()
    current_model: tuple[str, str] | None = None
    # Track the last usage tuple seen per (provider, model) to skip duplicate
    # entries. Claude Code splits a single API response into two JSONL entries
    # (e.g. a thinking block followed by a tool_use block) that carry identical
    # usage objects. Without deduplication, summing across both inflates token
    # counts by ~2x. Kimchi writes one entry per API call, so this is a no-op
    # for those sessions.
    last_usage: dict[tuple[str, str], tuple[int, int, int, int] | None] = {}
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
            current_usage = _usage_tuple(usage)
            key = (provider, model)
            if last_usage.get(key) == current_usage:
                # Duplicate of the previous assistant message for this model —
                # skip token accumulation but still process tool calls below.
                pass
            else:
                stats.llm_rounds += 1
                stats.input_tokens += current_usage[0]
                stats.cache_read_tokens += current_usage[1]
                stats.cache_write_tokens += current_usage[2]
                stats.output_tokens += current_usage[3]
                last_usage[key] = current_usage

        for name in tool_call_names(message.get("content")):
            stats.tool_calls[name] += 1
    return scan


def scan_trajectory_file(path: Path, warnings: list[str]) -> SessionScan:
    """Parse an opencode ATIF trajectory.json file into a SessionScan.

    Opencode writes ``agent/trajectory.json`` (schema ATIF-v1.x) instead of
    the JSONL session format used by kimchi/claude-code agents.  The file
    contains ``final_metrics`` for totals and per-step ``metrics`` with token
    counts.  This function extracts token and tool-call data from each step,
    matching the fields produced by ``scan_session_file``.
    """
    data = load_json(path, warnings)
    scan = SessionScan()
    if not data:
        return scan

    agent_block = data.get("agent")
    if isinstance(agent_block, dict):
        model_name = string_or_none(agent_block.get("model_name"))
        if model_name:
            provider, model = split_model_ref(model_name)
        else:
            provider, model = "unknown", "unknown"
    else:
        provider, model = "unknown", "unknown"

    steps = data.get("steps")
    if not isinstance(steps, list):
        return scan

    for step in steps:
        if not isinstance(step, dict):
            continue

        timestamp = string_or_none(step.get("timestamp"))
        if timestamp:
            scan.start = min(scan.start, timestamp) if scan.start else timestamp
            scan.end = max(scan.end, timestamp) if scan.end else timestamp

        # Per-step model may differ from the agent-level default.
        step_model = string_or_none(step.get("model_name"))
        if step_model:
            sp, sm = split_model_ref(step_model)
        else:
            sp, sm = provider, model

        stats = model_stats(scan.models, sp, sm)

        metrics = step.get("metrics")
        if isinstance(metrics, dict):
            prompt_tokens = int_from_keys(
                metrics, "prompt_tokens", "input", "input_tokens",
            )
            completion_tokens = int_from_keys(
                metrics, "completion_tokens", "output", "output_tokens",
            )
            cached_tokens = int_from_keys(
                metrics, "cached_tokens", "cacheRead",
                "cache_read", "cache_read_input_tokens",
            )
            if prompt_tokens or completion_tokens or cached_tokens:
                rounds = int_value(step.get("llm_call_count"))
                stats.llm_rounds += rounds or (1 if prompt_tokens or completion_tokens else 0)
                stats.input_tokens += prompt_tokens
                stats.output_tokens += completion_tokens
                stats.cache_read_tokens += cached_tokens

        # Tool calls in ATIF format use ``function_name`` instead of ``name``.
        tool_calls = step.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if isinstance(tc, dict):
                    name = tc.get("function_name") or tc.get("name")
                    stats.tool_calls[str(name) if name else "unknown"] += 1

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
    if not results_dir.is_dir():
        return []
    trials_by_id: dict[str, Path] = {}
    for path in sorted(results_dir.iterdir()):
        if is_trial_dir(path):
            trials_by_id.setdefault(path.name, path)
    run_dirs = sorted(
        (path for path in results_dir.iterdir() if path.is_dir()),
        key=lambda path: (path.name == "_checkpoint-restored", path.name),
    )
    for run_dir in run_dirs:
        for path in sorted(run_dir.iterdir()):
            if is_trial_dir(path):
                trials_by_id.setdefault(path.name, path)
    return sorted(trials_by_id.values(), key=lambda path: path.name)


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
    kind: str | None,
) -> ErrorEvidence:
    sources: list[tuple[str, str]] = []
    session_text = "\n".join(session_error_text(path, warnings) for path in session_files)
    if session_text.strip():
        sources.append(("agent/session", session_text))

    verifier_stdout = file_excerpt(trial_dir / "verifier" / "test-stdout.txt")
    if kind == "verifier_failed" and verifier_stdout.strip():
        sources.append(("verifier/test-stdout.txt", verifier_stdout))

    exception_text = string_or_none(get_path(result, "exception_info", "exception_message"))
    if exception_text:
        sources.append(("result.exception_info.exception_message", exception_text))

    for relative in (Path("exception.txt"), Path("trial.log")):
        text = file_excerpt(trial_dir / relative)
        if text.strip():
            sources.append((str(relative), text))

    if kind != "verifier_failed" and verifier_stdout.strip():
        sources.append(("verifier/test-stdout.txt", verifier_stdout))

    rule = _KIND_TO_RULE.get(kind or "")
    preferred_markers = rule.evidence_markers if rule else ()
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
    has_claude_code = (trial_dir / "agent" / "claude-code.txt").is_file()
    trajectory_file = trial_dir / "agent" / "trajectory.json"
    if not session_files and not has_claude_code:
        if trajectory_file.is_file():
            session_scan = scan_trajectory_file(trajectory_file, warnings)
        else:
            warnings.append(f"No agent transcript artifacts found for trial {trial_dir.name}")
            session_scan = SessionScan()
    else:
        session_scan = merge_session_scans([scan_session_file(path, warnings) for path in session_files])
    model_ref = configured_model_ref(result)
    if is_kimchi_model_provider(model_ref[0]):
        session_scan = normalize_session_scan_models(session_scan, model_ref)

    reward = numeric_reward(get_path(result, "verifier_result", "rewards", "reward"))
    exception = string_or_none(get_path(result, "exception_info", "exception_type"))
    exception_message = string_or_none(get_path(result, "exception_info", "exception_message"))

    raw_outcome = result.get("outcome")
    if isinstance(raw_outcome, str):
        try:
            outcome = Outcome(raw_outcome)
        except ValueError:
            verdict = classify(trial_dir)
            outcome = verdict.outcome
            error_category = verdict.error_category
            error_subcategory = verdict.error_subcategory
        else:
            error_category = (
                result.get("error_category")
                if isinstance(result.get("error_category"), str)
                else None
            )
            error_subcategory = (
                result.get("error_subcategory")
                if isinstance(result.get("error_subcategory"), str)
                else None
            )
    else:
        # Per-trial checkpoints are written by Harbor's END hook before
        # chunk_runner enriches result.json with classification fields. Apply
        # the canonical classifier here so GCS-only summaries preserve the
        # same retryable/final semantics as local reconciliation.
        verdict = classify(trial_dir)
        outcome = verdict.outcome
        error_category = verdict.error_category
        error_subcategory = verdict.error_subcategory

    error_evidence = extract_error_evidence(result, trial_dir, session_files, warnings, error_subcategory)
    error_message = error_evidence.text or exception_message
    total_time_seconds = trial_total_time(result, session_scan)
    # Prefer task_name from result.json (full name for swe-bench-pro, which
    # contains "__"). Strip any "source/" prefix Harbor adds (e.g.
    # "terminal-bench/sample-task"). Fall back to the trial dir name for
    # benchmarks that don't store task_name.
    task = (
        task.rsplit("/", 1)[-1]
        if (task := string_or_none(result.get("task_name")))
        else trial_dir.name.split("__", 1)[0]
    )

    agent_timeout_analysis = _convert_decimals(result.get("agent_timeout_analysis"))
    if not isinstance(agent_timeout_analysis, dict):
        agent_timeout_analysis = None

    return TrialSummary(
        task=task,
        trial_id=trial_dir.name,
        attempt=attempt,
        solved=reward == PASS_REWARD,
        reward=reward,
        exception=exception,
        exception_message=error_message,
        total_time_seconds=total_time_seconds,
        models=[stats.to_summary_json() for stats in sorted(session_scan.models.values(), key=model_sort_key)],
        trial_dir=trial_dir,
        start=string_or_none(get_path(result, "agent_execution", "started_at")) or session_scan.start,
        end=string_or_none(get_path(result, "verifier", "finished_at"))
        or string_or_none(get_path(result, "agent_execution", "finished_at"))
        or session_scan.end,
        outcome=outcome,
        error_category=error_category,
        error_subcategory=error_subcategory,
        agent_timeout_analysis=agent_timeout_analysis,
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
        "started_at": start,
        "ended_at": end,
        "agent": {
            "name": metadata_string(metadata, "coding_agent"),
            "version": source_sha,
        },
        "configuration": metadata_string(metadata, "configuration", "na"),
        "model": metadata_string(metadata, "model"),
        "retry_agent_timeout": metadata_bool(
            metadata_dict(metadata, "parameters"),
            "retry_agent_timeout",
            default=should_retry_agent_timeout(),
        ),
        "parameters": {
            "llm_params": _convert_decimals(metadata_dict(metadata, "parameters").get("llm_params", {})),
            "llm_per_model_params": _convert_decimals(
                metadata_dict(metadata, "parameters").get("llm_per_model_params", {})
            ),
            "thinking_level": metadata_dict(metadata, "parameters").get("thinking_level"),
        },
    }


def build_source(metadata: dict[str, Any]) -> dict[str, Any]:
    gitlab = metadata_dict(metadata, "gitlab")
    return {
        "gitlab": {
            "ref": str(gitlab.get("target_ref") or gitlab.get("ref") or ""),
            "commit_sha": str(gitlab.get("target_commit_sha") or gitlab.get("commit_sha") or ""),
        },
    }


def load_chunk_metas(results_dir: Path) -> dict[int, dict[str, Any]]:
    """Read all chunk-meta JSON files. Returns {chunk_index: meta_dict_with_exhausted_flag}.

    A chunk is 'exhausted' if its latest recorded attempt number is at MAX_CHUNK_ATTEMPTS
    AND needs_retry is non-empty.
    """
    metas: dict[int, dict[str, Any]] = {}
    meta_dir = results_dir / "chunk-meta"
    if not meta_dir.is_dir():
        return metas
    for meta_path in sorted(meta_dir.glob("chunk-*.json")):
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Warning: skipping chunk-meta {meta_path}: {exc}", file=sys.stderr)
            continue
        if not isinstance(data, dict):
            print(f"Warning: skipping chunk-meta {meta_path}: top-level JSON is not an object", file=sys.stderr)
            continue
        chunk_index = data.get("chunk_index")
        if not isinstance(chunk_index, int):
            print(f"Warning: skipping chunk-meta {meta_path}: missing or non-int 'chunk_index'", file=sys.stderr)
            continue
        if not isinstance(data.get("exhausted"), bool):
            # Backward compatibility for artifact-only metadata written before
            # the durable status schema carried an explicit exhaustion flag.
            attempt = data.get("chunk_attempt", 0)
            needs = data.get("needs_retry", []) or []
            data["exhausted"] = (
                attempt >= MAX_CHUNK_ATTEMPTS and len(needs) > 0
            )
        metas[chunk_index] = data
    return metas


def exhausted_tasks_from_chunk_metas(
    chunk_metas: dict[int, dict[str, Any]],
) -> set[str]:
    """Tasks allowed to publish incomplete attempt sets after retry exhaustion."""
    exhausted_tasks: set[str] = set()
    for meta in chunk_metas.values():
        if not meta.get("exhausted"):
            continue
        needs_retry = meta.get("needs_retry", [])
        if isinstance(needs_retry, list):
            exhausted_tasks.update(
                task for task in needs_retry if isinstance(task, str)
            )
    return exhausted_tasks


def build_summary(
    metadata: dict[str, Any],
    trials: list[TrialSummary],
    started_at: str | None,
    finished_at: str | None,
    generated_at: str,
    results_dir: Path,
) -> dict[str, Any]:
    chunk_metas = load_chunk_metas(results_dir)
    chunks_exhausted = sorted(
        idx for idx, meta in chunk_metas.items() if meta.get("exhausted")
    )

    selected_tasks = metadata_dict(metadata, "parameters").get("selected_tasks") or metadata.get("selected_tasks")
    tasks_expected = (
        len(selected_tasks)
        if isinstance(selected_tasks, list)
        else len({t.task for t in trials})
    )

    attempts_per_task = int_value(metadata_dict(metadata, "parameters").get("attempts")) or 1
    trials_expected = tasks_expected * attempts_per_task

    # Exhausted tasks: chunks that ran out of retries and still had failures.
    exhausted_tasks = exhausted_tasks_from_chunk_metas(chunk_metas)

    # no_verdict: exhausted tasks with no result.json at all (true unknown, not in trials).
    trial_task_names = {t.task for t in trials}
    no_verdict = sum(1 for task in exhausted_tasks if task not in trial_task_names)

    # Trial-level counts by verdict.
    trial_counts: dict[Outcome, int] = Counter(t.outcome for t in trials)

    # Task-level counts by final verdict.
    task_verdicts = build_task_verdicts(trials)
    task_counts: dict[Outcome, int] = Counter()
    for verdict in task_verdicts:
        task_counts[verdict.final_outcome] += 1

    # Tasks that hit a retryable outcome at least once.
    tasks_with_retryable_outcome = len(
        {t.task for t in trials if is_retryable(t.outcome, t.error_category, t.error_subcategory)}
    )

    return {
        "schema_version": SUMMARY_SCHEMA_VERSION,
        "classification": {
            "classified_by": "classify.py@v1",
            "pipeline_run_id": os.environ.get("CI_PIPELINE_ID", "unknown"),
            "pipeline_url": os.environ.get("CI_PIPELINE_URL", ""),
            "generated_at": generated_at,
        },
        "totals": {
            "trials": {
                "recorded": len(trials),
                "expected": trials_expected,
                "scored_pass": trial_counts.get(Outcome.SCORED_PASS, 0),
                "scored_fail": trial_counts.get(Outcome.SCORED_FAIL, 0),
                "agent_timeout": trial_counts.get(Outcome.AGENT_TIMEOUT, 0),
                "error": trial_counts.get(Outcome.ERROR, 0),
            },
            "tasks": {
                "expected": tasks_expected,
                "scored_pass": task_counts.get(Outcome.SCORED_PASS, 0),
                "scored_fail": task_counts.get(Outcome.SCORED_FAIL, 0),
                "agent_timeout": task_counts.get(Outcome.AGENT_TIMEOUT, 0),
                "error": task_counts.get(Outcome.ERROR, 0),
                "no_verdict": no_verdict,
            },
            "tasks_with_retryable_outcome": tasks_with_retryable_outcome,
        },
        "chunks_exhausted_retries": [f"chunk-{idx}" for idx in chunks_exhausted],
        "run": build_run(metadata, started_at, finished_at, generated_at),
        "trials": [t.to_summary_json() for t in trials],
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

    # Build trials first, then sort chronologically and reassign attempt numbers.
    # The initial directory enumeration is alphabetical (due to random suffixes),
    # which does not reflect actual execution order.
    raw_trials: list[TrialSummary] = []
    for trial_dir in trial_dirs:
        raw_trials.append(summarize_trial(trial_dir, 0, warnings))

    raw_trials.sort(
        key=lambda t: (
            t.task,
            parse_time(t.start) or datetime.min.replace(tzinfo=UTC),
        )
    )
    attempts_by_task: defaultdict[str, int] = defaultdict(int)
    trials: list[TrialSummary] = []
    for trial in raw_trials:
        attempts_by_task[trial.task] += 1
        trial.attempt = attempts_by_task[trial.task]
        trials.append(trial)

    started_at, finished_at = run_bounds(results_dir, trials)
    generated_at = utc_now()
    summary = build_summary(metadata, trials, started_at, finished_at, generated_at, results_dir)

    task_verdicts = build_task_verdicts(trials)
    print(format_totals(summary["totals"]))
    print()
    print(format_task_table(task_verdicts))
    print()

    for warning in warnings:
        print(f"Warning: {warning}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote benchmark summary to {output_path}")

    # Distinguish between tasks that never ran (no trial dirs at all) and
    # tasks that were attempted but only produced error/infra verdicts.
    # - Never-ran tasks: fail unless chunk-meta explicitly records exhaustion.
    # - All-errored tasks: warn only — the chunk ran and produced evidence,
    #   the errors are visible in the summary for analysis.
    selected_tasks = metadata_dict(metadata, "parameters").get("selected_tasks") or metadata.get("selected_tasks")
    if isinstance(selected_tasks, list) and selected_tasks:
        exhausted_tasks = exhausted_tasks_from_chunk_metas(
            load_chunk_metas(results_dir)
        )
        trial_tasks = {t.task for t in trials}
        missing_tasks = sorted(
            set(selected_tasks) - trial_tasks - exhausted_tasks
        )
        if missing_tasks:
            print(
                f"ERROR: {len(missing_tasks)} expected task(s) never produced a trial: "
                f"{missing_tasks}",
                file=sys.stderr,
            )
            return 1

        attempts_per_task = (
            int_value(metadata_dict(metadata, "parameters").get("attempts")) or 1
        )
        final_attempts = Counter(
            trial.task
            for trial in trials
            if not is_retryable(
                trial.outcome,
                trial.error_category,
                trial.error_subcategory,
            )
        )
        incomplete_tasks = [
            f"{task} ({final_attempts[task]}/{attempts_per_task} final)"
            for task in selected_tasks
            if (
                task not in exhausted_tasks
                and final_attempts[task] < attempts_per_task
            )
        ]
        if incomplete_tasks:
            print(
                "ERROR: expected tasks have fewer than the configured attempts: "
                f"{incomplete_tasks}",
                file=sys.stderr,
            )
            return 1

        # Warn about tasks that ran but only have error/infra verdicts
        # (no scored_pass or scored_fail). These are attempted-but-failed
        # tasks — the errors are real benchmark evidence, not missing data.
        all_errored_tasks = sorted(
            task for task in trial_tasks
            if not any(
                t.outcome in (Outcome.SCORED_PASS, Outcome.SCORED_FAIL)
                for t in trials if t.task == task
            )
        )
        if all_errored_tasks:
            print(
                f"WARNING: {len(all_errored_tasks)} task(s) were attempted but only "
                f"produced error/infra verdicts (no scored pass/fail): "
                f"{all_errored_tasks}",
                file=sys.stderr,
            )

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
