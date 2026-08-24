#!/usr/bin/env python3
"""Deep-dive analysis of benchmark agent timeouts.

Runs in two phases:
1. Python pre-processing: extracts structured evidence from session artifacts
   for all AGENT_TIMEOUT trials, writes timeout-evidence.json.
2. Kimchi deep-dive: invokes Kimchi to analyze the structured evidence and
   produce an HTML report with root-cause classification.

The script exits 0 when there are no timeout trials to analyze.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from analyze_sessions import (
    _load_prompt,
    read_analysis_draft,
    run_kimchi_attempt,
    validate_analysis_html,
    write_analysis_html,
)
from summarize_results import find_trial_dirs, parse_time

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_TOOL_CALL_ARGS_DISPLAY = 200
MAX_TOOL_CALL_ARGS_HASH = 500
LAST_N_TOOL_CALLS = 15
LOOP_REPEAT_THRESHOLD = 3  # consecutive identical calls to flag a loop
SUBAGENT_GAP_THRESHOLD_SEC = 120  # gap indicating a stalled subagent


# ---------------------------------------------------------------------------
# JSONL / file helpers
# ---------------------------------------------------------------------------


def getenv(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def iter_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read all valid JSON objects from a JSONL file into a list.

    Sessions are typically 100-400KB, so loading into a list is acceptable
    and simplifies multi-pass analysis (timeline + tool calls + tokens).
    """
    entries: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict):
                    entries.append(entry)
    except OSError:
        pass
    return entries


def get_path(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


# ---------------------------------------------------------------------------
# Trial discovery
# ---------------------------------------------------------------------------


@dataclass
class TimeoutTrial:
    """A trial from summary.json with agent-timeout evidence."""

    trial_id: str
    task: str
    attempt: int
    trial_dir: Path
    timeout_duration_sec: float | None
    existing_analysis: dict[str, Any] | None
    model: str
    duration_ms: int | None


def find_timeout_trials(
    summary_path: Path,
    results_dir: Path,
) -> list[TimeoutTrial]:
    """Read summary.json and return trials with agent-timeout evidence."""
    summary = load_json(summary_path)
    if summary is None:
        return []

    trials_data = summary.get("trials")
    if not isinstance(trials_data, list):
        return []

    # Build a map of trial_id → trial_dir from the results directory.
    trial_dirs = {d.name: d for d in find_trial_dirs(results_dir)}

    result: list[TimeoutTrial] = []
    for entry in trials_data:
        if not isinstance(entry, dict):
            continue
        if entry.get("timed_out_during_agent") is not True and entry.get("verdict") != "agent_timeout":
            continue
        trial_id = str(entry.get("trial_id") or "")
        if not trial_id:
            continue
        trial_dir = trial_dirs.get(trial_id)
        if trial_dir is None:
            continue

        existing = entry.get("agent_timeout_analysis")
        if not isinstance(existing, dict):
            existing = None

        timeout_duration = None
        if existing is not None:
            td = existing.get("timeout_duration_sec")
            if isinstance(td, (int, float)):
                timeout_duration = float(td)

        models = entry.get("models")
        model = ""
        if isinstance(models, list) and models:
            first = models[0]
            if isinstance(first, dict):
                model = str(first.get("model") or "")

        duration_ms = entry.get("duration_ms")
        if not isinstance(duration_ms, (int, float)):
            duration_ms = None

        result.append(
            TimeoutTrial(
                trial_id=trial_id,
                task=str(entry.get("task") or ""),
                attempt=int(entry.get("attempt") or 0),
                trial_dir=trial_dir,
                timeout_duration_sec=timeout_duration,
                existing_analysis=existing,
                model=model,
                duration_ms=int(duration_ms) if duration_ms is not None else None,
            )
        )

    return result


# ---------------------------------------------------------------------------
# Session evidence extraction
# ---------------------------------------------------------------------------


@dataclass
class ToolCallEntry:
    name: str
    args_summary: str
    args_hash: str
    timestamp: str | None


@dataclass
class SessionEvidence:
    session_file: str
    is_subagent: bool
    parent_session_id: str | None
    model: str | None
    n_messages: int
    last_timestamp: str | None
    tool_calls: list[ToolCallEntry] = field(default_factory=list)
    token_usage: dict[str, int] = field(
        default_factory=lambda: {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    )
    llm_rounds: int = 0
    error_signals: list[str] = field(default_factory=list)
    models_used: list[str] = field(default_factory=list)


def _summarize_args(name: str, args_str: str) -> str:
    """Create a short human-readable summary of tool arguments."""
    if not args_str:
        return ""
    # For bash, extract the command string.
    if name == "bash":
        try:
            parsed = json.loads(args_str) if args_str.startswith("{") else None
            if isinstance(parsed, dict):
                cmd = parsed.get("command") or parsed.get("cmd") or ""
                if cmd:
                    return str(cmd)[:MAX_TOOL_CALL_ARGS_DISPLAY]
        except (json.JSONDecodeError, TypeError):
            pass
    # For edit, show the file path.
    if name in ("edit", "write", "read"):
        try:
            parsed = json.loads(args_str) if args_str.startswith("{") else None
            if isinstance(parsed, dict):
                path = parsed.get("path") or parsed.get("file") or ""
                if path:
                    return str(path)[:MAX_TOOL_CALL_ARGS_DISPLAY]
        except (json.JSONDecodeError, TypeError):
            pass
    return args_str[:MAX_TOOL_CALL_ARGS_DISPLAY]


def _hash_args(name: str, args_str: str) -> str:
    """Hash tool name + truncated args for loop detection."""
    content = f"{name}:{args_str[:MAX_TOOL_CALL_ARGS_HASH]}"
    return hashlib.md5(content.encode()).hexdigest()  # nosec: not for security


def _extract_tool_calls_from_message(message: dict[str, Any]) -> list[dict[str, str]]:
    """Extract tool calls from an assistant message's content list."""
    content = message.get("content")
    if not isinstance(content, list):
        return []
    calls: list[dict[str, str]] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "toolCall":
            continue
        name = str(item.get("name") or "unknown")
        args = item.get("input")
        if args is None:
            args = item.get("arguments")
        if isinstance(args, dict):
            args_str = json.dumps(args, sort_keys=True)
        elif isinstance(args, str):
            args_str = args
        else:
            args_str = ""
        calls.append({"name": name, "args": args_str})
    return calls


def _extract_token_usage(message: dict[str, Any]) -> dict[str, int] | None:
    """Extract token usage from an assistant message's usage field."""
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    return {
        "input": _int_from_keys(usage, "input", "input_tokens"),
        "output": _int_from_keys(usage, "output", "output_tokens"),
        "cache_read": _int_from_keys(usage, "cacheRead", "cache_read", "cache_read_input_tokens"),
        "cache_write": _int_from_keys(usage, "cacheWrite", "cache_write", "cache_creation_input_tokens"),
    }


def _int_from_keys(value: dict[str, Any], *keys: str) -> int:
    for key in keys:
        if key in value:
            v = value.get(key)
            if v is None or isinstance(v, bool):
                return 0
            try:
                return int(v)
            except (TypeError, ValueError):
                return 0
    return 0


def _extract_error_signals(entries: list[dict[str, Any]]) -> list[str]:
    """Extract error-related signals from session entries."""
    signals: list[str] = []
    for entry in entries:
        # agent_terminated custom event
        if entry.get("customType") == "agent_terminated":
            reason = get_path(entry, "data", "reason")
            if reason:
                signals.append(f"agent_terminated: {reason}")

        message = entry.get("message")
        if not isinstance(message, dict):
            continue

        # Error messages in tool results
        if message.get("isError") is True:
            content = message.get("content")
            text_parts: list[str] = []
            if isinstance(content, str):
                text_parts.append(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        t = item.get("text")
                        if isinstance(t, str):
                            text_parts.append(t)
            for text in text_parts:
                lowered = text.casefold()
                for marker in (
                    "rate limit", "rate_limit", "429", "too many requests",
                    "connection reset", "connection refused", "socket",
                    "timeout", "timed out", "econnreset", "epipe",
                    "oom", "out of memory", "killed", "signal 9",
                    "budget", "spend limit", "quota",
                    "internal server error", "503", "502", "500",
                ):
                    if marker in lowered:
                        # Take a short snippet around the marker
                        idx = lowered.index(marker)
                        start = max(0, idx - 50)
                        end = min(len(text), idx + 100)
                        snippet = text[start:end].strip()
                        if snippet not in signals:
                            signals.append(snippet[:300])
                        break

        # errorMessage field (provider errors)
        error_msg = message.get("errorMessage")
        if isinstance(error_msg, str) and error_msg:
            signals.append(f"errorMessage: {error_msg[:300]}")

    return signals


def extract_session_evidence(
    session_path: Path,
    timeout_at: datetime | None,
) -> SessionEvidence:
    """Extract structured evidence from a single session JSONL file."""
    entries = iter_jsonl(session_path)
    session_file = session_path.name
    is_subagent = session_file != "main.jsonl"

    # Read session metadata from first entry.
    parent_session_id: str | None = None
    current_model: str | None = None
    if entries and entries[0].get("type") == "session":
        parent_session_id = string_or_none(entries[0].get("parentSession"))

    evidence = SessionEvidence(
        session_file=session_file,
        is_subagent=is_subagent,
        parent_session_id=parent_session_id,
        model=current_model,
        n_messages=0,
        last_timestamp=None,
    )

    models_seen: set[str] = set()
    # Track the last usage tuple seen to skip duplicate entries. Claude Code
    # splits a single API response into two JSONL entries (e.g. a thinking
    # block followed by a tool_use block) that carry identical usage objects.
    # Without deduplication, summing across both inflates token counts by ~2x.
    # Kimchi writes one entry per API call, so this is a no-op for those
    # sessions.
    last_usage: tuple[int, int, int, int] | None = None

    for entry in entries:
        timestamp = string_or_none(entry.get("timestamp"))
        if timestamp:
            evidence.last_timestamp = timestamp

        # Track model changes
        if entry.get("type") == "model_change":
            provider = entry.get("provider")
            model_id = entry.get("modelId")
            if isinstance(provider, str) and isinstance(model_id, str):
                current_model = f"{provider}/{model_id}" if provider else model_id
                models_seen.add(current_model)
                # A model change resets the dedup state so that the first
                # message after the switch is always counted.
                last_usage = None

        entry_type = entry.get("type")
        if entry_type == "message":
            evidence.n_messages += 1
            message = entry.get("message")
            if not isinstance(message, dict):
                continue

            role = str(message.get("role", ""))

            if role == "assistant":
                # Extract tool calls
                for tc in _extract_tool_calls_from_message(message):
                    name = tc["name"]
                    args_str = tc["args"]
                    evidence.tool_calls.append(
                        ToolCallEntry(
                            name=name,
                            args_summary=_summarize_args(name, args_str),
                            args_hash=_hash_args(name, args_str),
                            timestamp=timestamp,
                        )
                    )

                # Extract token usage
                usage = _extract_token_usage(message)
                if usage is not None:
                    current_usage = (
                        usage.get("input", 0),
                        usage.get("cache_read", 0),
                        usage.get("cache_write", 0),
                        usage.get("output", 0),
                    )
                    if current_usage != last_usage:
                        evidence.llm_rounds += 1
                        for key in evidence.token_usage:
                            evidence.token_usage[key] += usage.get(key, 0)
                        last_usage = current_usage

                # Track model from message
                msg_provider = message.get("provider")
                msg_model = message.get("model")
                if isinstance(msg_provider, str) and isinstance(msg_model, str):
                    model_ref = f"{msg_provider}/{msg_model}" if msg_provider else msg_model
                    models_seen.add(model_ref)
                    if evidence.model is None:
                        evidence.model = model_ref

    evidence.error_signals = _extract_error_signals(entries)
    if models_seen:
        evidence.models_used = sorted(models_seen)
    if evidence.model is None and models_seen:
        evidence.model = sorted(models_seen)[0]

    return evidence


# ---------------------------------------------------------------------------
# Loop detection
# ---------------------------------------------------------------------------


def detect_loops(tool_calls: list[ToolCallEntry]) -> list[dict[str, Any]]:
    """Identify repeated tool call patterns that indicate a loop.

    Returns a list of patterns with tool name, args preview, count, and
    whether they were consecutive.
    """
    if len(tool_calls) < LOOP_REPEAT_THRESHOLD:
        return []

    patterns: list[dict[str, Any]] = []

    # Check for consecutive repeats
    i = 0
    while i < len(tool_calls):
        j = i
        while j < len(tool_calls) and tool_calls[j].args_hash == tool_calls[i].args_hash:
            j += 1
        run_length = j - i
        if run_length >= LOOP_REPEAT_THRESHOLD:
            patterns.append(
                {
                    "type": "consecutive_repeat",
                    "tool": tool_calls[i].name,
                    "args_preview": tool_calls[i].args_summary,
                    "count": run_length,
                    "start_index": i,
                }
            )
        i = j

    # Check for high frequency of same tool+args (non-consecutive)
    hash_counts: Counter[str] = Counter(tc.args_hash for tc in tool_calls)
    for h, count in hash_counts.most_common(5):
        if count < LOOP_REPEAT_THRESHOLD:
            continue
        # Skip if already captured as consecutive
        if any(p["count"] == count and p.get("args_hash") == h for p in patterns):
            continue
        # Find a representative call
        for tc in tool_calls:
            if tc.args_hash == h:
                patterns.append(
                    {
                        "type": "frequent_repeat",
                        "tool": tc.name,
                        "args_preview": tc.args_summary,
                        "count": count,
                    }
                )
                break

    return patterns


# ---------------------------------------------------------------------------
# Time distribution
# ---------------------------------------------------------------------------


def compute_time_distribution(
    entries: list[dict[str, Any]],
    timeout_at: datetime | None,
) -> dict[str, float]:
    """Estimate inference time, tool execution time, and idle/stall time.

    Approximate: pairs assistant(toolCall)→toolResult for tool exec,
    toolResult→assistant for inference, and last_message→timeout for idle.
    """
    timeline: list[tuple[datetime, str, bool]] = []
    for entry in entries:
        if entry.get("type") != "message":
            continue
        ts = parse_time(string_or_none(entry.get("timestamp")))
        if ts is None:
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", ""))
        has_tool_call = False
        if role == "assistant":
            content = message.get("content")
            if isinstance(content, list):
                has_tool_call = any(
                    isinstance(i, dict) and i.get("type") == "toolCall" for i in content
                )
        timeline.append((ts, role, has_tool_call))

    if not timeline:
        return {"inference_sec": 0.0, "tool_exec_sec": 0.0, "idle_sec": 0.0, "total_tracked_sec": 0.0}

    inference_sec = 0.0
    tool_exec_sec = 0.0

    for i in range(1, len(timeline)):
        prev_ts, prev_role, prev_has_tc = timeline[i - 1]
        curr_ts, curr_role, _ = timeline[i]
        gap = (curr_ts - prev_ts).total_seconds()
        if gap < 0:
            continue
        if prev_role == "assistant" and prev_has_tc and curr_role == "toolResult":
            tool_exec_sec += gap
        elif prev_role == "toolResult" and curr_role == "assistant":
            inference_sec += gap

    idle_sec = 0.0
    if timeout_at is not None:
        last_ts = timeline[-1][0]
        idle_sec = max(0.0, (timeout_at - last_ts).total_seconds())

    total = inference_sec + tool_exec_sec + idle_sec
    return {
        "inference_sec": round(inference_sec, 1),
        "tool_exec_sec": round(tool_exec_sec, 1),
        "idle_sec": round(idle_sec, 1),
        "total_tracked_sec": round(total, 1),
    }


# ---------------------------------------------------------------------------
# Ferment evidence
# ---------------------------------------------------------------------------


def extract_ferment_evidence(trial_dir: Path) -> dict[str, Any] | None:
    """Read ferment plan and lifecycle events to determine where the run stalled."""
    ferments_dir = trial_dir / "agent" / "ferments"
    if not ferments_dir.is_dir():
        return None

    # Find the ferment plan JSON
    plan_files = sorted(ferments_dir.glob("*.json"))
    if not plan_files:
        return None

    plan_path = plan_files[0]
    plan = load_json(plan_path)
    if plan is None:
        return None

    ferment_id = string_or_none(plan.get("id")) or plan_path.stem

    # Count phases and steps
    phases = plan.get("phases")
    total_phases = len(phases) if isinstance(phases, list) else 0
    total_steps = 0
    if isinstance(phases, list):
        for phase in phases:
            if isinstance(phase, dict):
                steps = phase.get("steps")
                if isinstance(steps, list):
                    total_steps += len(steps)

    # Read lifecycle events
    events_path = ferments_dir / f"{ferment_id}.events.jsonl"
    current_phase: str | None = None
    current_phase_index: int | None = None
    current_step: str | None = None
    completed_phases = 0
    completed_steps = 0
    last_event: str | None = None

    if events_path.is_file():
        for entry in iter_jsonl(events_path):
            event_type = string_or_none(entry.get("type"))
            if event_type is None:
                continue
            last_event = event_type

            if event_type == "phase_activated":
                phase = entry.get("phase")
                if isinstance(phase, dict):
                    current_phase = string_or_none(phase.get("id")) or string_or_none(phase.get("name"))
                    phase_idx = phase.get("index")
                    if isinstance(phase_idx, int):
                        current_phase_index = phase_idx
            elif event_type == "phase_completed":
                completed_phases += 1
            elif event_type == "step_started":
                step = entry.get("step")
                if isinstance(step, dict):
                    current_step = string_or_none(step.get("id")) or string_or_none(step.get("content"))
            elif event_type == "step_completed":
                completed_steps += 1
                current_step = None  # step finished, no current step
            elif event_type == "ferment_completed":
                completed_phases = total_phases
                completed_steps = total_steps

    progress_parts: list[str] = []
    if total_phases > 0:
        progress_parts.append(f"{completed_phases}/{total_phases} phases")
    if total_steps > 0:
        progress_parts.append(f"{completed_steps}/{total_steps} steps")

    return {
        "active": True,
        "ferment_id": ferment_id,
        "current_phase": current_phase,
        "current_phase_index": current_phase_index,
        "current_step": current_step,
        "completed_phases": completed_phases,
        "total_phases": total_phases,
        "completed_steps": completed_steps,
        "total_steps": total_steps,
        "progress": ", ".join(progress_parts) if progress_parts else "unknown",
        "last_event": last_event,
    }


# ---------------------------------------------------------------------------
# Trial evidence assembly
# ---------------------------------------------------------------------------


def _get_timeout_at(trial_dir: Path, existing_analysis: dict[str, Any] | None) -> datetime | None:
    """Determine the timeout timestamp from result.json or existing analysis."""
    result_path = trial_dir / "result.json"
    result = load_json(result_path)
    if result is not None:
        occurred = string_or_none(get_path(result, "exception_info", "occurred_at"))
        if occurred:
            ts = parse_time(occurred)
            if ts is not None:
                return ts
        finished = string_or_none(result.get("finished_at"))
        if finished:
            ts = parse_time(finished)
            if ts is not None:
                return ts
    return None


def extract_trial_evidence(trial: TimeoutTrial) -> dict[str, Any]:
    """Extract all structured evidence for a single timed-out trial."""
    trial_dir = trial.trial_dir
    timeout_at = _get_timeout_at(trial_dir, trial.existing_analysis)

    # Find all session files
    sessions_dir = trial_dir / "agent" / "sessions"
    session_files: list[Path] = []
    if sessions_dir.is_dir():
        session_files = sorted(sessions_dir.rglob("*.jsonl"))

    # Extract evidence from each session
    sessions_evidence: list[SessionEvidence] = []
    for sf in session_files:
        sessions_evidence.append(extract_session_evidence(sf, timeout_at))

    # Separate orchestrator from subagents
    orchestrator_ev: SessionEvidence | None = None
    subagent_evs: list[SessionEvidence] = []
    for ev in sessions_evidence:
        if ev.is_subagent:
            subagent_evs.append(ev)
        elif orchestrator_ev is None:
            orchestrator_ev = ev

    # If no main.jsonl was found, use the first session as orchestrator
    if orchestrator_ev is None and sessions_evidence:
        orchestrator_ev = sessions_evidence[0]
        subagent_evs = sessions_evidence[1:]

    # Determine which subagent was in flight at timeout
    subagent_in_flight: str | None = None
    if subagent_evs and timeout_at is not None:
        for ev in subagent_evs:
            if ev.last_timestamp is None:
                continue
            last_ts = parse_time(ev.last_timestamp)
            if last_ts is None:
                continue
            gap = (timeout_at - last_ts).total_seconds()
            # Subagent was recently active (within threshold) when timeout hit
            if 0 <= gap < SUBAGENT_GAP_THRESHOLD_SEC:
                subagent_in_flight = ev.session_file
                break
        # If no subagent was recently active, check if any was the last thing
        # the orchestrator called
        if subagent_in_flight is None and orchestrator_ev is not None:
            last_tool = orchestrator_ev.tool_calls[-1] if orchestrator_ev.tool_calls else None
            # Orchestrator's last call was Agent — find the most recent subagent
            if last_tool is not None and last_tool.name == "Agent" and subagent_evs:
                    latest_sub = max(
                        subagent_evs,
                        key=lambda e: parse_time(e.last_timestamp) or datetime.min.replace(tzinfo=UTC),
                    )
                    subagent_in_flight = latest_sub.session_file

    # Build the orchestrator evidence dict
    orch_dict: dict[str, Any] = {}
    if orchestrator_ev is not None:
        last_n = orchestrator_ev.tool_calls[-LAST_N_TOOL_CALLS:]
        orch_dict = {
            "n_messages": orchestrator_ev.n_messages,
            "n_tool_calls": len(orchestrator_ev.tool_calls),
            "last_tool_calls": [
                {"name": tc.name, "args_summary": tc.args_summary, "timestamp": tc.timestamp}
                for tc in reversed(last_n)  # most recent first
            ],
            "repeated_patterns": detect_loops(orchestrator_ev.tool_calls),
            "token_usage": orchestrator_ev.token_usage,
            "llm_rounds": orchestrator_ev.llm_rounds,
            "models_used": orchestrator_ev.models_used,
            "error_signals": orchestrator_ev.error_signals,
            "last_timestamp": orchestrator_ev.last_timestamp,
        }

    # Time distribution from orchestrator session
    time_dist: dict[str, float] = {
        "inference_sec": 0.0,
        "tool_exec_sec": 0.0,
        "idle_sec": 0.0,
        "total_tracked_sec": 0.0,
    }
    if orchestrator_ev is not None:
        orch_session_path = sessions_dir / "main.jsonl"
        if not orch_session_path.is_file() and session_files:
            orch_session_path = session_files[0]
        if orch_session_path.is_file():
            entries = iter_jsonl(orch_session_path)
            time_dist = compute_time_distribution(entries, timeout_at)

    # Subagent evidence
    subagent_dicts: list[dict[str, Any]] = []
    for ev in subagent_evs:
        last_tool = ev.tool_calls[-1] if ev.tool_calls else None
        time_since_activity: float | None = None
        if ev.last_timestamp and timeout_at is not None:
            last_ts = parse_time(ev.last_timestamp)
            if last_ts is not None:
                time_since_activity = round(
                    max(0.0, (timeout_at - last_ts).total_seconds()), 1
                )
        subagent_dicts.append(
            {
                "session_file": ev.session_file,
                "model": ev.model,
                "n_messages": ev.n_messages,
                "n_tool_calls": len(ev.tool_calls),
                "last_tool_call": (
                    {"name": last_tool.name, "args_summary": last_tool.args_summary}
                    if last_tool
                    else None
                ),
                "last_timestamp": ev.last_timestamp,
                "time_since_last_activity_sec": time_since_activity,
                "token_usage": ev.token_usage,
                "llm_rounds": ev.llm_rounds,
                "error_signals": ev.error_signals,
            }
        )

    # Aggregate tokens across all sessions
    total_tokens = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    total_llm_rounds = 0
    for ev in sessions_evidence:
        for key in total_tokens:
            total_tokens[key] += ev.token_usage.get(key, 0)
        total_llm_rounds += ev.llm_rounds

    # Ferment evidence
    ferment_evidence = extract_ferment_evidence(trial_dir)

    return {
        "trial_id": trial.trial_id,
        "task": trial.task,
        "attempt": trial.attempt,
        "trial_dir": str(trial_dir),
        "timeout_duration_sec": trial.timeout_duration_sec,
        "duration_ms": trial.duration_ms,
        "model": trial.model,
        "existing_classification": trial.existing_analysis,
        "orchestrator_session": orch_dict,
        "subagents": subagent_dicts,
        "subagent_in_flight": subagent_in_flight,
        "time_distribution": time_dist,
        "total_token_usage": total_tokens,
        "total_llm_rounds": total_llm_rounds,
        "ferment": ferment_evidence,
    }


# ---------------------------------------------------------------------------
# Cross-trial aggregation
# ---------------------------------------------------------------------------


def build_cross_trial_patterns(trials: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate patterns across all timed-out trials."""
    by_task: Counter[str] = Counter()
    by_model: Counter[str] = Counter()
    by_timeout_status: Counter[str] = Counter()
    common_last_tools: Counter[str] = Counter()
    common_ferment_phases: Counter[str] = Counter()
    subagent_in_flight_count = 0
    loop_detected_count = 0
    error_signal_count = 0

    for trial in trials:
        by_task[trial.get("task", "")] += 1
        if trial.get("model"):
            by_model[trial["model"]] += 1

        existing = trial.get("existing_classification")
        if isinstance(existing, dict):
            status = existing.get("timeout_status")
            if isinstance(status, str):
                by_timeout_status[status] += 1

        orch = trial.get("orchestrator_session")
        if isinstance(orch, dict):
            last_calls = orch.get("last_tool_calls")
            if isinstance(last_calls, list) and last_calls:
                first = last_calls[0]
                if isinstance(first, dict):
                    common_last_tools[first.get("name", "unknown")] += 1

            patterns = orch.get("repeated_patterns")
            if isinstance(patterns, list) and patterns:
                loop_detected_count += 1

            signals = orch.get("error_signals")
            if isinstance(signals, list) and signals:
                error_signal_count += 1

        if trial.get("subagent_in_flight"):
            subagent_in_flight_count += 1

        ferment = trial.get("ferment")
        if isinstance(ferment, dict) and ferment.get("active"):
            phase = ferment.get("current_phase")
            if isinstance(phase, str):
                common_ferment_phases[phase] += 1

    return {
        "by_task": dict(by_task.most_common()),
        "by_model": dict(by_model.most_common()),
        "by_timeout_status": dict(by_timeout_status.most_common()),
        "common_last_tools": dict(common_last_tools.most_common(10)),
        "common_ferment_phases": dict(common_ferment_phases.most_common()),
        "subagent_in_flight_count": subagent_in_flight_count,
        "loop_detected_count": loop_detected_count,
        "error_signal_count": error_signal_count,
        "total_timeouts": len(trials),
    }


# ---------------------------------------------------------------------------
# Evidence writing
# ---------------------------------------------------------------------------


def write_evidence(evidence: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Kimchi invocation
# ---------------------------------------------------------------------------


def build_timeout_analysis_prompt(
    *,
    evidence_path: Path,
    draft_path: Path,
) -> str:
    return _load_prompt(
        "timeout_analysis_prompt.txt",
        evidence_path=evidence_path,
        draft_path=draft_path,
    )


def build_timeout_retry_prompt(*, draft_path: Path, validation_error: str) -> str:
    return _load_prompt(
        "timeout_retry_prompt.txt",
        draft_path=draft_path,
        validation_error=validation_error,
    )


def run_timeout_analysis(
    *,
    evidence_path: Path,
    draft_path: Path,
    session_dir: Path,
    timeout_seconds: int,
    max_retries: int,
) -> str | None:
    """Run the Kimchi timeout analysis and resume on validation failures."""
    prompt = build_timeout_analysis_prompt(
        evidence_path=evidence_path,
        draft_path=draft_path,
    )

    for attempt in range(max_retries + 1):
        # Check if draft was already written by a previous attempt.
        html_content, html_error = read_analysis_draft(draft_path)
        if html_error is None:
            print("Timeout analysis draft already valid from a previous attempt", flush=True)
            return html_content

        if not run_kimchi_attempt(
            prompt=prompt,
            session_dir=session_dir,
            timeout_seconds=timeout_seconds,
            continue_session=attempt > 0,
        ):
            html_content, html_error = read_analysis_draft(draft_path)
            if html_error is None:
                print("Timeout analysis draft was written before the process failure", flush=True)
                return html_content

            if attempt == max_retries:
                return None
            print(
                f"Kimchi timeout analysis attempt {attempt + 1}/{max_retries + 1} failed; retrying...",
                file=sys.stderr,
                flush=True,
            )
            continue

        html_content, html_error = read_analysis_draft(draft_path)

        if html_error is None:
            return html_content

        print(
            f"Timeout analysis draft validation failed after attempt {attempt + 1}/{max_retries + 1}: {html_error}",
            file=sys.stderr,
            flush=True,
        )
        if attempt == max_retries:
            return None
        prompt = build_timeout_retry_prompt(draft_path=draft_path, validation_error=html_error)

    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run_preprocess(
    *,
    summary_path: Path,
    results_dir: Path,
    evidence_path: Path,
) -> int:
    """Phase 1: Extract structured evidence and write timeout-evidence.json."""
    timeout_trials = find_timeout_trials(summary_path, results_dir)
    print(f"Found {len(timeout_trials)} agent_timeout trials", flush=True)

    if not timeout_trials:
        print("No agent_timeout trials found; nothing to analyze", flush=True)
        # Write an empty evidence file for record-keeping.
        write_evidence(
            {
                "run_summary": {
                    "total_trials": 0,
                    "timeout_count": 0,
                    "tasks_with_timeouts": [],
                },
                "trials": [],
                "cross_trial_patterns": {"total_timeouts": 0},
            },
            evidence_path,
        )
        return 0

    # Load summary for total trial count.
    summary = load_json(summary_path)
    total_trials = 0
    if summary is not None:
        trials_data = summary.get("trials")
        if isinstance(trials_data, list):
            total_trials = len(trials_data)

    trial_evidence: list[dict[str, Any]] = []
    for trial in timeout_trials:
        print(f"  Extracting evidence for {trial.trial_id} ({trial.task})...", flush=True)
        evidence = extract_trial_evidence(trial)
        trial_evidence.append(evidence)

    cross_patterns = build_cross_trial_patterns(trial_evidence)

    output = {
        "run_summary": {
            "total_trials": total_trials,
            "timeout_count": len(timeout_trials),
            "tasks_with_timeouts": sorted({t.task for t in timeout_trials}),
        },
        "trials": trial_evidence,
        "cross_trial_patterns": cross_patterns,
    }

    write_evidence(output, evidence_path)
    print(f"Evidence written to {evidence_path}", flush=True)
    return 0


def run_analyze(
    *,
    evidence_path: Path,
    output_path: Path,
    draft_path: Path,
    session_dir: Path,
    timeout_seconds: int,
    max_retries: int,
) -> int:
    """Phase 2: Invoke Kimchi to produce the HTML report from structured evidence."""
    if not evidence_path.is_file():
        print(f"Error: evidence file not found at {evidence_path}", file=sys.stderr, flush=True)
        return 1

    # Check if there are any timeouts to analyze.
    evidence = load_json(evidence_path)
    if evidence is not None:
        trials = evidence.get("trials")
        if isinstance(trials, list) and len(trials) == 0:
            print("No timeout trials in evidence; skipping Kimchi analysis", flush=True)
            return 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.unlink(missing_ok=True)
    draft_path.unlink(missing_ok=True)
    session_dir.mkdir(parents=True, exist_ok=True)

    # Clean up stale temp file.
    temp_path = output_path.with_name(f".{output_path.name}.tmp")
    temp_path.unlink(missing_ok=True)

    html_content = run_timeout_analysis(
        evidence_path=evidence_path,
        draft_path=draft_path,
        session_dir=session_dir,
        timeout_seconds=timeout_seconds,
        max_retries=max(0, max_retries),
    )
    if html_content is None:
        return 1

    validation_error = validate_analysis_html(html_content)
    if validation_error:
        print(f"Error: {validation_error}", file=sys.stderr, flush=True)
        return 1

    write_analysis_html(output_path, html_content)
    print(f"Timeout analysis HTML written to {output_path}", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deep-dive analysis of benchmark agent timeouts.",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=Path(getenv("BENCHMARK_RESULTS_DIR", "benchmark/terminal-bench-2/jobs")),
        help="Path to benchmark results directory containing trial outputs.",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=Path(getenv("BENCHMARK_SUMMARY_PATH", ".benchmark/summary.json")),
        help="Path to summary.json.",
    )
    parser.add_argument(
        "--evidence",
        type=Path,
        default=Path(getenv("BENCHMARK_TIMEOUT_EVIDENCE", ".benchmark/timeout-evidence.json")),
        help="Path for the structured evidence JSON.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(getenv("BENCHMARK_TIMEOUT_ANALYSIS_OUTPUT", ".benchmark/timeout-analysis.html")),
        help="Path where the HTML timeout analysis report will be written.",
    )
    parser.add_argument(
        "--draft",
        type=Path,
        default=Path(getenv("BENCHMARK_TIMEOUT_ANALYSIS_DRAFT", ".benchmark/timeout-analysis-work/report.html")),
        help="Path Kimchi uses to iteratively write the report draft.",
    )
    parser.add_argument(
        "--session-dir",
        type=Path,
        default=Path(
            getenv("BENCHMARK_TIMEOUT_ANALYSIS_SESSION_DIR", f".benchmark/timeout-analysis-session-{os.getpid()}")
        ),
        help="Isolated Kimchi session directory used for corrective retries.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=int(getenv("KIMCHI_ANALYSIS_TIMEOUT_SECONDS", "3600")),
        help="Maximum seconds to wait for the Kimchi analysis subprocess.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=int(getenv("KIMCHI_ANALYSIS_MAX_RETRIES", "2")),
        help="Maximum corrective retries after draft validation failures.",
    )
    parser.add_argument(
        "--preprocess-only",
        action="store_true",
        help="Only run the Python evidence extraction phase, skip Kimchi analysis.",
    )
    args = parser.parse_args()

    # Resolve relative paths against cwd.
    results_dir = args.results_dir if args.results_dir.is_absolute() else Path.cwd() / args.results_dir
    summary_path = args.summary if args.summary.is_absolute() else Path.cwd() / args.summary
    evidence_path = args.evidence if args.evidence.is_absolute() else Path.cwd() / args.evidence

    if not summary_path.is_file():
        print(f"Error: summary not found at {summary_path}", file=sys.stderr, flush=True)
        return 1

    # Phase 1: Pre-processing
    rc = run_preprocess(
        summary_path=summary_path,
        results_dir=results_dir,
        evidence_path=evidence_path,
    )
    if rc != 0:
        return rc

    if args.preprocess_only:
        return 0

    # Check if there are timeouts to analyze.
    evidence = load_json(evidence_path)
    if evidence is not None:
        trials = evidence.get("trials")
        if isinstance(trials, list) and len(trials) == 0:
            return 0

    # Phase 2: Kimchi analysis
    output_path = args.output if args.output.is_absolute() else Path.cwd() / args.output
    draft_path = args.draft if args.draft.is_absolute() else Path.cwd() / args.draft
    session_dir = args.session_dir if args.session_dir.is_absolute() else Path.cwd() / args.session_dir

    return run_analyze(
        evidence_path=evidence_path,
        output_path=output_path,
        draft_path=draft_path,
        session_dir=session_dir,
        timeout_seconds=args.timeout,
        max_retries=args.max_retries,
    )


if __name__ == "__main__":
    raise SystemExit(main())
