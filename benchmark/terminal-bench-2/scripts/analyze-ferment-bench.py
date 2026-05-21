#!/usr/bin/env python3
"""Analyze terminal-bench runs that used kimchi ferment one-shot mode."""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter, defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
BENCH_DIR = SCRIPT_DIR.parent
JOBS_DIR = BENCH_DIR / "jobs"
REPO_ROOT = BENCH_DIR.parent.parent
DEFAULT_ANALYSIS_DIR = BENCH_DIR / "analysis"
DEFAULT_CACHE_DIR = DEFAULT_ANALYSIS_DIR / "terminal-bench-trials"
DEFAULT_MAX_LIST = 80
DEFAULT_MAX_LINE = 220
PASS_REWARDS = {"1", "1.0"}
ZERO_REWARDS = {"0", "0.0"}
EARLY_STOP_STATUSES = {"draft", "planned", "paused"}
INCOMPLETE_STATUSES = EARLY_STOP_STATUSES | {"running"}

SIGNAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("agent-timeout", re.compile(r"AgentTimeoutError|timed out after|TimeoutError", re.IGNORECASE)),
    ("nonzero-exit", re.compile(r"NonZeroAgentExitCodeError|Command exited with code [1-9]", re.IGNORECASE)),
    ("python-traceback", re.compile(r"Traceback \(most recent call last\)|\bTraceback\b")),
    ("assertion-failure", re.compile(r"AssertionError|assert .*==|FAILED .*::", re.IGNORECASE)),
    ("missing-dependency", re.compile(r"ModuleNotFoundError|No module named|ImportError", re.IGNORECASE)),
    ("missing-file", re.compile(r"No such file|does not exist|FileNotFoundError|not found at", re.IGNORECASE)),
    ("image-unavailable", re.compile(r"Image omitted|does not support images|could not be resized", re.IGNORECASE)),
    ("exact-output-mismatch", re.compile(r"does not start with|is not correct|OUTPUT MISMATCH|Expected .* got|expected .* actual", re.IGNORECASE)),
    ("protocol-mismatch", re.compile(r"not a real gRPC|Protocol message|RpcError|connection refused|handshake", re.IGNORECASE)),
    ("side-effect-structure", re.compile(r"protected files|Expected only|extra file|file hash|checksum|not in the correct state", re.IGNORECASE)),
    ("response-length", re.compile(r'"stopReason":"length"|stopReason.*length', re.IGNORECASE)),
)


@dataclass(frozen=True)
class TrialSummary:
    trial_dir: Path
    run: str
    trial: str
    task: str
    reward: str
    exception: str
    ferment_status: str
    grade: str
    agent_seconds: int | None
    verifier_seconds: int | None
    event_count: int
    last_event: str
    planning_seconds: int | None
    activation_seconds: int | None
    execution_seconds: int | None
    llm_rounds: int
    session_span_seconds: int | None
    session_sum_seconds: int
    input_tokens: int
    output_tokens: int
    cache_tokens: int
    models: Counter[str]
    failed_tests: list[str]
    signals: Counter[str]
    phase_seconds: dict[str, int | None]


def is_pass(summary: TrialSummary) -> bool:
    return summary.reward in PASS_REWARDS


def is_zero_reward(summary: TrialSummary) -> bool:
    return summary.reward in ZERO_REWARDS


@dataclass
class SessionSummary:
    path: Path
    entries: int = 0
    start: str | None = None
    end: str | None = None
    cwd: str | None = None
    parent_session: str | None = None
    current_model: str | None = None
    models: Counter[str] = field(default_factory=Counter)
    roles: Counter[str] = field(default_factory=Counter)
    custom_types: Counter[str] = field(default_factory=Counter)
    tool_calls: Counter[str] = field(default_factory=Counter)
    stop_reasons: Counter[str] = field(default_factory=Counter)
    input_tokens: int = 0
    output_tokens: int = 0
    cache_tokens: int = 0
    llm_rounds: int = 0
    last_assistant_stop: str | None = None
    last_assistant_text: str = ""
    last_assistant_tools: list[str] = field(default_factory=list)
    signals: Counter[str] = field(default_factory=Counter)
    notables: list[tuple[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class SessionAggregate:
    span_seconds: int | None
    sum_seconds: int
    llm_rounds: int
    input_tokens: int
    output_tokens: int
    cache_tokens: int
    models: Counter[str]
    signals: Counter[str]


@dataclass(frozen=True)
class TimingRow:
    kind: str
    name: str
    status: str
    start: str | None
    end: str | None
    seconds: int | None
    note: str = ""


@dataclass(frozen=True)
class TrialEvidence:
    trial_dir: Path
    result: dict[str, Any]
    ferment_path: Path | None
    ferment: dict[str, Any]
    event_path: Path | None
    events: list[dict[str, Any]]
    failures: list[dict[str, str]]
    sessions: list[SessionSummary]
    workers: list[SessionSummary]


def load_json(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            value = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def iter_jsonl(path: Path | None) -> Iterator[dict[str, Any]]:
    if path is None:
        return
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                yield value
    except OSError:
        return


def load_jsonl(path: Path | None) -> list[dict[str, Any]]:
    return list(iter_jsonl(path))


def get_path(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def display(value: Any, default: str = "n/a") -> str:
    if value is None:
        return default
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def seconds_between(start: str | None, end: str | None) -> int | None:
    start_dt = parse_time(start)
    end_dt = parse_time(end)
    if start_dt is None or end_dt is None:
        return None
    return int((end_dt - start_dt).total_seconds())


def seconds_display(value: int | None) -> str:
    if value is None:
        return "n/a"
    if value < 120:
        return f"{value}s"
    return f"{value // 60}m{value % 60:02d}s"


def seconds_mean(values: list[int | None]) -> str:
    present = [v for v in values if v is not None]
    if not present:
        return "n/a"
    return f"{mean(present):.1f}s across {len(present)} trials"


def truncate(text: str, limit: int = DEFAULT_MAX_LINE) -> str:
    text = " ".join(text.replace("\r", " ").split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def md_cell(value: Any) -> str:
    return display(value, "").replace("|", "\\|").replace("\n", " ")


def md_row(values: list[Any]) -> str:
    return "| " + " | ".join(md_cell(value) for value in values) + " |"


def counter_text(counter: Counter[str], limit: int | None = None) -> str:
    items = counter.most_common(limit)
    return ", ".join(f"{key}={count}" for key, count in items)


def tokens_text(summary: SessionSummary | TrialSummary) -> str:
    return f"{summary.input_tokens}/{summary.output_tokens}"


def text_from_content(content: Any, include_thinking: bool = False) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type == "text":
            parts.append(display(item.get("text"), ""))
        elif include_thinking and item_type == "thinking":
            parts.append(display(item.get("thinking"), ""))
        elif item_type == "toolCall":
            parts.append(f"[toolCall {display(item.get('name'))}] {json.dumps(item.get('arguments', {}), ensure_ascii=False)[:500]}")
    return "\n".join(part for part in parts if part)


def add_signals(counter: Counter[str], text: str) -> None:
    for label, pattern in SIGNAL_PATTERNS:
        if pattern.search(text):
            counter[label] += 1


def add_notable(notables: list[tuple[str, str]], text: str, limit: int) -> None:
    if len(notables) >= limit:
        return
    for label, pattern in SIGNAL_PATTERNS:
        if pattern.search(text):
            notables.append((label, truncate(text)))
            return


def record_signal_text(summary: SessionSummary, text: str, max_notables: int) -> None:
    if not text:
        return
    add_signals(summary.signals, text)
    add_notable(summary.notables, text, max_notables)


def resolve_run_dir(raw: str | None) -> Path:
    if not raw:
        runs = sorted(p for p in JOBS_DIR.iterdir() if p.is_dir())
        if not runs:
            raise SystemExit(f"error: no run directories under {JOBS_DIR}")
        return runs[-1]
    candidate = Path(raw)
    if candidate.is_dir():
        return candidate.resolve()
    for base in (BENCH_DIR, JOBS_DIR):
        candidate = base / raw
        if candidate.is_dir():
            return candidate.resolve()
    raise SystemExit(f"error: run directory not found: {raw}")


def is_trial_dir(path: Path) -> bool:
    return path.is_dir() and (path / "result.json").is_file()


def match_trials_in_run(run_dir: Path, target: str) -> list[Path]:
    exact = run_dir / target
    if is_trial_dir(exact):
        return [exact.resolve()]
    matches = sorted(p.resolve() for p in run_dir.glob(f"{target}__*") if is_trial_dir(p))
    if matches:
        return matches
    return sorted(p.resolve() for p in run_dir.glob(target) if is_trial_dir(p))


def resolve_trials(targets: list[str], run_raw: str | None, runs_raw: list[str] | None = None) -> list[Path]:
    trials: list[Path] = []
    if runs_raw:
        for raw in runs_raw:
            run_dir = resolve_run_dir(raw)
            if not targets:
                trials.extend(sorted(p.resolve() for p in run_dir.iterdir() if "__" in p.name and is_trial_dir(p)))
                continue
            for target in targets:
                matches = match_trials_in_run(run_dir, target)
                if not matches:
                    raise SystemExit(f"error: trial target not found in {run_dir}: {target}")
                trials.extend(matches)
        return sorted(dict.fromkeys(trials))

    run_dir = resolve_run_dir(run_raw) if run_raw else None
    trial_targets: list[str] = []
    for target in targets:
        path = Path(target)
        if is_trial_dir(path):
            trials.append(path.resolve())
            continue
        if run_dir is None and path.is_dir() and not is_trial_dir(path):
            run_dir = resolve_run_dir(str(path))
            continue
        trial_targets.append(target)
    for target in trial_targets:
        effective_run = run_dir or resolve_run_dir(None)
        matches = match_trials_in_run(effective_run, target)
        if not matches:
            raise SystemExit(f"error: trial target not found in {effective_run}: {target}")
        trials.extend(matches)
    if run_dir is not None and not trials and not trial_targets:
        trials.extend(sorted(p.resolve() for p in run_dir.iterdir() if "__" in p.name and is_trial_dir(p)))
    return sorted(dict.fromkeys(trials))


def primary_file(directory: Path, pattern: str) -> Path | None:
    if not directory.is_dir():
        return None
    files = sorted(p for p in directory.glob(pattern) if p.is_file())
    return files[0] if files else None


def artifact_rel(path: Path | None, root: Path) -> str:
    if path is None:
        return "n/a"
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def first_event_ts(events: list[dict[str, Any]], event_type: str) -> str | None:
    for event in events:
        if event.get("type") == event_type:
            timestamp = event.get("timestamp")
            return timestamp if isinstance(timestamp, str) else None
    return None


def summarize_events(events: list[dict[str, Any]]) -> tuple[int, str, int | None, int | None, int | None]:
    if not events:
        return 0, "none", None, None, None
    return (
        len(events),
        display(events[-1].get("type"), "none"),
        seconds_between(first_event_ts(events, "ferment_created"), first_event_ts(events, "ferment_planned")),
        seconds_between(first_event_ts(events, "ferment_planned"), first_event_ts(events, "phase_activated")),
        seconds_between(first_event_ts(events, "phase_activated"), first_event_ts(events, "ferment_completed")),
    )


def phase_step_maps(ferment: dict[str, Any]) -> tuple[dict[str, str], dict[tuple[str, str], str], dict[str, str], dict[tuple[str, str], str]]:
    phase_names: dict[str, str] = {}
    phase_statuses: dict[str, str] = {}
    step_names: dict[tuple[str, str], str] = {}
    step_statuses: dict[tuple[str, str], str] = {}
    phases = ferment.get("phases")
    if not isinstance(phases, list):
        return phase_names, step_names, phase_statuses, step_statuses
    for phase in phases:
        if not isinstance(phase, dict):
            continue
        phase_id = display(phase.get("id"), "")
        phase_names[phase_id] = display(phase.get("name"), phase_id)
        phase_statuses[phase_id] = display(phase.get("status"), "")
        for step in phase.get("steps") or []:
            if not isinstance(step, dict):
                continue
            step_id = display(step.get("id"), "")
            key = (phase_id, step_id)
            step_names[key] = display(step.get("description"), step_id)
            step_statuses[key] = display(step.get("status"), "")
    return phase_names, step_names, phase_statuses, step_statuses


def timing_rows(ferment: dict[str, Any], events: list[dict[str, Any]]) -> list[TimingRow]:
    phase_names, step_names, phase_statuses, step_statuses = phase_step_maps(ferment)
    final_ts = events[-1].get("timestamp") if events and isinstance(events[-1].get("timestamp"), str) else None
    phase_start: dict[str, str] = {}
    phase_end: dict[str, str] = {}
    step_start: dict[tuple[str, str], str] = {}
    step_end: dict[tuple[str, str], str] = {}
    phase_terminal = {"phase_completed", "phase_failed", "phase_skipped"}
    step_terminal = {"step_verified", "step_completed", "step_failed", "step_skipped"}
    for event in events:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            continue
        timestamp = event.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        event_type = event.get("type")
        phase_id = payload.get("phaseId")
        step_id = payload.get("stepId")
        if event_type == "phase_activated" and isinstance(phase_id, str):
            phase_start.setdefault(phase_id, timestamp)
        elif event_type in phase_terminal and isinstance(phase_id, str):
            phase_end[phase_id] = timestamp
        elif event_type == "step_started" and isinstance(phase_id, str) and isinstance(step_id, str):
            step_start.setdefault((phase_id, step_id), timestamp)
        elif event_type in step_terminal and isinstance(phase_id, str) and isinstance(step_id, str):
            step_end[(phase_id, step_id)] = timestamp

    rows: list[TimingRow] = []
    for phase_id, name in phase_names.items():
        start = phase_start.get(phase_id)
        end = phase_end.get(phase_id)
        note = ""
        if start and not end and final_ts:
            end = final_ts
            note = "open at final event"
        rows.append(TimingRow("phase", name, phase_statuses.get(phase_id, ""), start, end, seconds_between(start, end), note))
    for key, name in step_names.items():
        start = step_start.get(key)
        end = step_end.get(key)
        note = ""
        if start and not end and final_ts:
            end = final_ts
            note = "open at final event"
        rows.append(TimingRow("step", name, step_statuses.get(key, ""), start, end, seconds_between(start, end), note))
    return rows


def phase_seconds_map(ferment: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, int | None]:
    return {row.name: row.seconds for row in timing_rows(ferment, events) if row.kind == "phase"}


def failed_tests(ctrf_path: Path) -> list[dict[str, str]]:
    ctrf = load_json(ctrf_path)
    tests = get_path(ctrf, "results", "tests")
    if not isinstance(tests, list):
        return []
    failures: list[dict[str, str]] = []
    for test in tests:
        if not isinstance(test, dict) or test.get("status") != "failed":
            continue
        failures.append(
            {
                "name": display(test.get("name")),
                "message": display(test.get("message"), ""),
                "trace": display(test.get("trace"), ""),
            }
        )
    return failures


def summarize_session_file(path: Path, max_notables: int) -> SessionSummary:
    summary = SessionSummary(path=path)
    for entry in iter_jsonl(path):
        summary.entries += 1
        timestamp = entry.get("timestamp")
        if isinstance(timestamp, str):
            summary.start = summary.start or timestamp
            summary.end = timestamp
        entry_type = display(entry.get("type"), "unknown")
        if entry_type == "session":
            summary.cwd = display(entry.get("cwd"), summary.cwd or "n/a")
            parent = entry.get("parentSession")
            if isinstance(parent, str):
                summary.parent_session = parent
        elif entry_type == "model_change":
            summary.current_model = f"{display(entry.get('provider'), 'unknown')}/{display(entry.get('modelId'), 'unknown')}"
        elif entry_type in {"custom", "custom_message"}:
            summary.custom_types[display(entry.get("customType"), "unknown")] += 1
            record_signal_text(summary, json.dumps(entry, ensure_ascii=False), max_notables)
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        role = display(message.get("role"), "unknown")
        summary.roles[role] += 1
        provider = message.get("provider")
        model = message.get("model")
        usage = message.get("usage")
        if isinstance(usage, dict):
            summary.input_tokens += int(usage.get("input") or 0)
            summary.output_tokens += int(usage.get("output") or 0)
            summary.cache_tokens += int(usage.get("cacheRead") or 0) + int(usage.get("cacheWrite") or 0)
            summary.llm_rounds += 1
            if isinstance(provider, str) and isinstance(model, str):
                summary.models[f"{provider}/{model}"] += 1
            elif summary.current_model:
                summary.models[summary.current_model] += 1
        stop_reason = message.get("stopReason")
        if isinstance(stop_reason, str):
            summary.stop_reasons[stop_reason] += 1
        content = message.get("content")
        if role == "assistant":
            tools: list[str] = []
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "toolCall":
                        name = display(item.get("name"), "unknown")
                        summary.tool_calls[name] += 1
                        tools.append(name)
            summary.last_assistant_stop = stop_reason if isinstance(stop_reason, str) else None
            summary.last_assistant_tools = tools
            text = text_from_content(content, include_thinking=False)
            if text:
                summary.last_assistant_text = truncate(text, 500)
        elif role == "toolResult":
            summary.roles[f"toolResult:{display(message.get('toolName'), 'unknown')}"] += 1
        record_signal_text(summary, text_from_content(content, include_thinking=True), max_notables)
    return summary


def session_files(trial_dir: Path) -> list[Path]:
    return sorted(p for p in (trial_dir / "agent" / "sessions").glob("*.jsonl") if p.is_file())


def worker_output_files(trial_dir: Path) -> list[Path]:
    return sorted(p for p in (trial_dir / "agent" / "sessions").glob("agent-outputs/*/tasks/*.output") if p.is_file())


def load_trial_evidence(trial_dir: Path, max_notables: int = 5, include_workers: bool = False) -> TrialEvidence:
    ferment_path = primary_file(trial_dir / "agent" / "ferments", "*.json")
    event_path = primary_file(trial_dir / "agent" / "ferments", "*.events.jsonl")
    return TrialEvidence(
        trial_dir=trial_dir,
        result=load_json(trial_dir / "result.json"),
        ferment_path=ferment_path,
        ferment=load_json(ferment_path),
        event_path=event_path,
        events=load_jsonl(event_path),
        failures=failed_tests(trial_dir / "verifier" / "ctrf.json"),
        sessions=[summarize_session_file(path, max_notables) for path in session_files(trial_dir)],
        workers=[summarize_session_file(path, max_notables) for path in worker_output_files(trial_dir)] if include_workers else [],
    )


def aggregate_session_summaries(summaries: list[SessionSummary]) -> SessionAggregate:
    starts = [s.start for s in summaries if s.start]
    ends = [s.end for s in summaries if s.end]
    models: Counter[str] = Counter()
    signals: Counter[str] = Counter()
    for summary in summaries:
        models.update(summary.models)
        signals.update(summary.signals)
    span = seconds_between(min(starts) if starts else None, max(ends) if ends else None)
    summed = sum(seconds_between(s.start, s.end) or 0 for s in summaries)
    return SessionAggregate(
        span_seconds=span,
        sum_seconds=summed,
        llm_rounds=sum(s.llm_rounds for s in summaries),
        input_tokens=sum(s.input_tokens for s in summaries),
        output_tokens=sum(s.output_tokens for s in summaries),
        cache_tokens=sum(s.cache_tokens for s in summaries),
        models=models,
        signals=signals,
    )


def summarize_trial(evidence: TrialEvidence) -> TrialSummary:
    trial_dir = evidence.trial_dir
    result = evidence.result
    reward = display(get_path(result, "verifier_result", "rewards", "reward"), "missing")
    exception = display(get_path(result, "exception_info", "exception_type"), "none")
    agent_seconds = seconds_between(get_path(result, "agent_execution", "started_at"), get_path(result, "agent_execution", "finished_at"))
    verifier_seconds = seconds_between(get_path(result, "verifier", "started_at"), get_path(result, "verifier", "finished_at"))
    ferment = evidence.ferment
    events = evidence.events
    event_count, last_event, planning_seconds, activation_seconds, execution_seconds = summarize_events(events)
    aggregate = aggregate_session_summaries(evidence.sessions)
    signals: Counter[str] = Counter(aggregate.signals)
    if exception != "none":
        signals[exception] += 1
    for failure in evidence.failures:
        add_signals(signals, f"{failure['name']}\n{failure['message']}\n{failure['trace']}")
    return TrialSummary(
        trial_dir=trial_dir,
        run=trial_dir.parent.name,
        trial=trial_dir.name,
        task=trial_dir.name.split("__", 1)[0],
        reward=reward,
        exception=exception,
        ferment_status=display(ferment.get("status"), "missing"),
        grade=display(get_path(ferment, "grade", "grade"), "none"),
        agent_seconds=agent_seconds,
        verifier_seconds=verifier_seconds,
        event_count=event_count,
        last_event=last_event,
        planning_seconds=planning_seconds,
        activation_seconds=activation_seconds,
        execution_seconds=execution_seconds,
        llm_rounds=aggregate.llm_rounds,
        session_span_seconds=aggregate.span_seconds,
        session_sum_seconds=aggregate.sum_seconds,
        input_tokens=aggregate.input_tokens,
        output_tokens=aggregate.output_tokens,
        cache_tokens=aggregate.cache_tokens,
        models=aggregate.models,
        failed_tests=[failure["name"] for failure in evidence.failures],
        signals=signals,
        phase_seconds=phase_seconds_map(ferment, events),
    )


def count_files(run_dir: Path, pattern: str) -> int:
    return sum(1 for p in run_dir.glob(pattern) if p.is_file())


def print_kv(label: str, value: Any, width: int = 28) -> None:
    print(f"  {label:<{width}} {value}")


def print_file_count(label: str, count: int) -> None:
    print(f"  {label:<34} {count}")


def print_counter(title: str, counter: Counter[str]) -> None:
    print(f"\n== {title} ==")
    if not counter:
        print("  (none)")
        return
    for key, count in sorted(counter.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {count:5d} {key}")


def print_attention_list(title: str, rows: list[str], max_list: int) -> None:
    print(f"\n== {title} ==")
    if not rows:
        print("  (none)")
        return
    for row in rows[:max_list]:
        print(f"  {row}")
    if len(rows) > max_list:
        print(f"  ... {len(rows) - max_list} more (raise --max-list to print more)")


def run_result_eval(result: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    evals = get_path(result, "stats", "evals")
    if not isinstance(evals, dict) or not evals:
        return "n/a", {}
    key = sorted(evals.keys())[0]
    value = evals.get(key)
    return key, value if isinstance(value, dict) else {}


def print_run_section(run_dir: Path, trials: list[TrialSummary]) -> None:
    config = load_json(run_dir / "config.json")
    result = load_json(run_dir / "result.json")
    print("== Run ==")
    print_kv("directory", run_dir)
    if config:
        print_kv("job name", display(config.get("job_name")))
        print_kv("attempts", display(config.get("n_attempts")))
        print_kv("concurrency", display(config.get("n_concurrent_trials")))
        agents = config.get("agents")
        first_agent = agents[0] if isinstance(agents, list) and agents and isinstance(agents[0], dict) else {}
        datasets = config.get("datasets")
        first_dataset = datasets[0] if isinstance(datasets, list) and datasets and isinstance(datasets[0], dict) else {}
        print_kv("model", display(first_agent.get("model_name")))
        kwargs = first_agent.get("kwargs")
        oneshot = kwargs.get("ferment-oneshot") if isinstance(kwargs, dict) else False
        print_kv("ferment oneshot", display(oneshot))
        print_kv("dataset", display(first_dataset.get("name")))
    if result:
        eval_key, eval_value = run_result_eval(result)
        metrics = eval_value.get("metrics")
        metric0 = metrics[0] if isinstance(metrics, list) and metrics and isinstance(metrics[0], dict) else {}
        pass_at_k = eval_value.get("pass_at_k")
        pass_at_k = pass_at_k if isinstance(pass_at_k, dict) else {}
        print_kv("started", display(result.get("started_at")))
        print_kv("finished", display(result.get("finished_at")))
        print_kv("total trials", display(result.get("n_total_trials")))
        print_kv("eval key", eval_key)
        print_kv("scored trials", display(eval_value.get("n_trials")))
        print_kv("errors", display(eval_value.get("n_errors")))
        print_kv("mean reward", display(metric0.get("mean")))
        print_kv("pass_at_k 2", display(pass_at_k.get("2")))
    print_kv("trial dirs", len(trials))
    print_kv("unique tasks", len({t.task for t in trials}))


def print_artifact_counts(run_dir: Path) -> None:
    print("\n== Artifact Counts ==")
    print_file_count("all result.json files", count_files(run_dir, "**/result.json"))
    print_file_count("trial result.json files", count_files(run_dir, "*__*/result.json"))
    print_file_count("trial.log", count_files(run_dir, "*__*/trial.log"))
    print_file_count("exception.txt", count_files(run_dir, "*__*/exception.txt"))
    print_file_count("agent session jsonl files", count_files(run_dir, "*__*/agent/sessions/*.jsonl"))
    print_file_count("worker output files", count_files(run_dir, "*__*/agent/sessions/agent-outputs/*/tasks/*.output"))
    print_file_count("primary ferment snapshots", count_files(run_dir, "*__*/agent/ferments/*.json"))
    print_file_count("ferment event logs", count_files(run_dir, "*__*/agent/ferments/*.events.jsonl"))
    print_file_count("runtime state files", count_files(run_dir, "*__*/agent/ferments/*/runtime.json"))
    print_file_count("phase review files", count_files(run_dir, "*__*/agent/ferments/*/reviews/*.json"))
    print_file_count("verifier reward.txt", count_files(run_dir, "*__*/verifier/reward.txt"))
    print_file_count("verifier ctrf.json", count_files(run_dir, "*__*/verifier/ctrf.json"))
    print_file_count("verifier test-stdout.txt", count_files(run_dir, "*__*/verifier/test-stdout.txt"))


def print_timing_averages(trials: list[TrialSummary]) -> None:
    print("\n== Timing / Token Averages ==")
    print_kv("agent runtime", seconds_mean([t.agent_seconds for t in trials]))
    print_kv("verifier runtime", seconds_mean([t.verifier_seconds for t in trials]))
    print_kv("planning", seconds_mean([t.planning_seconds for t in trials]))
    print_kv("planned to first phase", seconds_mean([t.activation_seconds for t in trials]))
    print_kv("first phase to complete", seconds_mean([t.execution_seconds for t in trials]))
    print_kv("session wall span", seconds_mean([t.session_span_seconds for t in trials]))
    print_kv("llm rounds avg", f"{mean([t.llm_rounds for t in trials]):.1f} across {len(trials)} trials" if trials else "n/a")
    print_kv("input tokens avg", f"{mean([t.input_tokens for t in trials]):.1f} across {len(trials)} trials" if trials else "n/a")
    print_kv("output tokens avg", f"{mean([t.output_tokens for t in trials]):.1f} across {len(trials)} trials" if trials else "n/a")


def print_task_consistency(trials: list[TrialSummary]) -> None:
    by_task: dict[str, list[TrialSummary]] = defaultdict(list)
    for trial in trials:
        by_task[trial.task].append(trial)
    distribution = Counter(sum(1 for trial in rows if is_pass(trial)) for rows in by_task.values())
    print_counter("Task Pass Count Distribution", Counter({f"{passes} pass attempts": count for passes, count in distribution.items()}))
    all_failed = sorted(task for task, rows in by_task.items() if rows and not any(is_pass(t) for t in rows))
    print_attention_list("Tasks With All Attempts Failed", all_failed, DEFAULT_MAX_LIST)


def print_run_summary(run_dir: Path, max_list: int) -> None:
    trials = [summarize_trial(load_trial_evidence(p)) for p in sorted(run_dir.iterdir()) if "__" in p.name and is_trial_dir(p)]
    print_run_section(run_dir, trials)
    print_artifact_counts(run_dir)
    print_counter("Reward / Exception Breakdown", Counter(f"{t.reward}\t{t.exception}" for t in trials))
    print_counter("Ferment Status Counts", Counter(t.ferment_status for t in trials))
    print_counter("Ferment Grade Counts", Counter(t.grade for t in trials))
    print_counter("Ferment Status / Reward / Exception", Counter(f"{t.ferment_status}\t{t.reward}\t{t.exception}" for t in trials))
    print_counter("Final Ferment Event Counts", Counter(t.last_event for t in trials))
    print_counter("Failure Signal Counts", Counter(signal for t in trials if not is_pass(t) for signal in t.signals))
    model_counts: Counter[str] = Counter()
    for trial in trials:
        model_counts.update(trial.models)
    print_counter("Model Counts From Sessions", model_counts)
    print_timing_averages(trials)
    print_task_consistency(trials)
    print_attention_list(
        "Complete Ferment But Reward 0",
        [f"{t.trial}\tgrade={t.grade}\texception={t.exception}\trounds={t.llm_rounds}\ttokens={tokens_text(t)}" for t in trials if t.ferment_status == "complete" and is_zero_reward(t)],
        max_list,
    )
    print_attention_list(
        "Non-Complete Ferment But Reward 1",
        [f"{t.trial}\tstatus={t.ferment_status}\texception={t.exception}\tlast_event={t.last_event}" for t in trials if t.ferment_status != "complete" and is_pass(t)],
        max_list,
    )
    print_attention_list(
        "Missing Verifier Reward",
        [f"{t.trial}\tstatus={t.ferment_status}\texception={t.exception}\tlast_event={t.last_event}" for t in trials if t.reward == "missing"],
        max_list,
    )
    print_attention_list(
        "Draft / Planned / Paused Ferments",
        [f"{t.trial}\tstatus={t.ferment_status}\treward={t.reward}\texception={t.exception}\tlast_event={t.last_event}" for t in trials if t.ferment_status in EARLY_STOP_STATUSES],
        max_list,
    )
    print_attention_list(
        "Running Ferments With Exceptions",
        [f"{t.trial}\treward={t.reward}\texception={t.exception}\tlast_event={t.last_event}" for t in trials if t.ferment_status == "running" and t.exception != "none"],
        max_list,
    )


def render_kv(rows: list[tuple[str, Any]]) -> list[str]:
    width = max((len(label) for label, _ in rows), default=0)
    return [f"- {label:<{width}}: {display(value)}" for label, value in rows]


def event_payload_summary(event: dict[str, Any]) -> str:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return ""
    pieces: list[str] = []
    for key in ("phaseId", "stepId", "mode", "exitCode"):
        value = payload.get(key)
        if value is not None:
            pieces.append(f"{key}={value}")
    if "summary" in payload:
        pieces.append(f"summary={truncate(display(payload.get('summary')), 180)}")
    grade = payload.get("grade")
    if isinstance(grade, dict):
        pieces.append(f"grade={grade.get('grade')}")
        rationale = grade.get("rationale")
        if rationale:
            pieces.append(f"rationale={truncate(display(rationale), 180)}")
    decision = payload.get("decision")
    if isinstance(decision, dict):
        pieces.append(f"decision={truncate(display(decision.get('title')), 120)}")
    result = payload.get("result")
    if isinstance(result, dict):
        pieces.append(f"verify success={display(result.get('success'))}, exit={display(result.get('exitCode'))}")
    return "; ".join(pieces)


def render_top_level_section(evidence: TrialEvidence, summary: TrialSummary) -> list[str]:
    return [
        "## Top-Level Signals",
        "",
        *render_kv(
            [
                ("trial dir", evidence.trial_dir),
                ("run", summary.run),
                ("task", get_path(evidence.result, "task_name") or summary.task),
                ("reward", summary.reward),
                ("exception", summary.exception),
                ("ferment status", summary.ferment_status),
                ("ferment grade", summary.grade),
                ("final event", summary.last_event),
                ("failed tests", ", ".join(summary.failed_tests) or "none"),
                ("signals", counter_text(summary.signals) or "none"),
            ]
        ),
        "",
    ]


def render_execution_section(summary: TrialSummary) -> list[str]:
    return [
        "## Execution Accounting",
        "",
        *render_kv(
            [
                ("agent seconds", seconds_display(summary.agent_seconds)),
                ("verifier seconds", seconds_display(summary.verifier_seconds)),
                ("session wall span", seconds_display(summary.session_span_seconds)),
                ("summed session seconds", seconds_display(summary.session_sum_seconds)),
                ("llm rounds", summary.llm_rounds),
                ("input tokens", summary.input_tokens),
                ("output tokens", summary.output_tokens),
                ("cache tokens", summary.cache_tokens),
                ("models", counter_text(summary.models) or "none"),
            ]
        ),
        "",
    ]


def render_ferment_scope_section(evidence: TrialEvidence) -> list[str]:
    ferment = evidence.ferment
    lines = [
        "## Ferment Scope",
        "",
        *render_kv(
            [
                ("snapshot", artifact_rel(evidence.ferment_path, evidence.trial_dir)),
                ("id", ferment.get("id")),
                ("name", ferment.get("name")),
                ("mode", ferment.get("mode")),
            ]
        ),
        "",
    ]
    goal = ferment.get("goal")
    criteria = ferment.get("successCriteria")
    constraints = ferment.get("constraints")
    if goal:
        lines += ["### Goal", "", display(goal), ""]
    if criteria:
        lines += ["### Success Criteria", "", display(criteria), ""]
    if constraints:
        lines += ["### Constraints", ""]
        lines += [f"- {display(item)}" for item in constraints] if isinstance(constraints, list) else [display(constraints)]
        lines.append("")
    if get_path(ferment, "grade", "rationale"):
        lines += ["### Grade Rationale", "", display(get_path(ferment, "grade", "rationale")), ""]
    return lines


def render_timing_section(evidence: TrialEvidence) -> list[str]:
    lines = [
        "## Phase And Step Timing",
        "",
        "| Kind | Name | Status | Seconds | Start | End | Note |",
        "| --- | --- | --- | ---: | --- | --- | --- |",
    ]
    for row in timing_rows(evidence.ferment, evidence.events):
        lines.append(md_row([row.kind, truncate(row.name, 120), row.status, seconds_display(row.seconds), row.start, row.end, row.note]))
    lines.append("")
    return lines


def render_event_timeline_section(evidence: TrialEvidence) -> list[str]:
    events = evidence.events
    lines = ["## Ferment Event Timeline", ""]
    if not events:
        return [*lines, "No ferment event log found.", ""]
    lines += [
        f"- Event log: `{artifact_rel(evidence.event_path, evidence.trial_dir)}`",
        f"- Event count: {len(events)}",
        f"- Final event: `{display(events[-1].get('type'))}` at `{display(events[-1].get('timestamp'))}`",
        "",
        "| Timestamp | Event | Details |",
        "| --- | --- | --- |",
    ]
    for event in events:
        lines.append(md_row([event.get("timestamp"), event.get("type"), event_payload_summary(event)]))
    lines.append("")
    return lines


def render_trial_report(trial_dir: Path, max_trace_lines: int, max_notables: int, max_sessions: int) -> str:
    evidence = load_trial_evidence(trial_dir, max_notables=max_notables, include_workers=True)
    summary = summarize_trial(evidence)
    lines: list[str] = [
        f"# Terminal-Bench Trial Analysis: {trial_dir.name}",
        "",
        "This report is generated from local artifacts so repeated investigation can start from a stable evidence summary instead of rereading raw JSONL/session files.",
        "",
    ]
    lines += render_top_level_section(evidence, summary)
    lines += render_execution_section(summary)
    lines += render_ferment_scope_section(evidence)
    lines += render_timing_section(evidence)
    lines += render_event_timeline_section(evidence)
    lines += render_verifier_section(evidence, max_trace_lines)
    lines += render_sessions_section(evidence, max_notables, max_sessions)
    lines += render_investigation_hints(summary)
    return "\n".join(lines).rstrip() + "\n"


def render_verifier_section(evidence: TrialEvidence, max_trace_lines: int) -> list[str]:
    trial_dir = evidence.trial_dir
    lines = ["## Verifier", ""]
    reward_path = trial_dir / "verifier" / "reward.txt"
    lines.append(f"- reward.txt: `{reward_path.read_text(encoding='utf-8', errors='replace').strip()}`" if reward_path.is_file() else "- reward.txt: missing")
    lines.append(f"- ctrf.json: {'present' if (trial_dir / 'verifier' / 'ctrf.json').is_file() else 'missing'}")
    lines.append(f"- failed tests: {len(evidence.failures)}")
    lines.append("")
    for failure in evidence.failures:
        lines += [f"### Failed Test: `{failure['name']}`", "", f"Message: {failure['message']}", ""]
        trace_lines = failure["trace"].splitlines()
        if trace_lines:
            lines += ["```text", *trace_lines[:max_trace_lines], "```", ""]
    return lines


def render_sessions_section(evidence: TrialEvidence, max_notables: int, max_sessions: int) -> list[str]:
    trial_dir = evidence.trial_dir
    sessions = evidence.sessions
    workers = evidence.workers
    lines = [
        "## Sessions And Subagents",
        "",
        f"- session jsonl files: {len(sessions)}",
        f"- worker output files: {len(workers)}",
        "- execution totals use session JSONL files; worker output files are listed as cross-check evidence and are not added again.",
        "",
    ]
    if sessions:
        lines += ["### Session Files", "", "| File | Entries | Seconds | LLM Rounds | Tokens In/Out | Models | Tool Calls | Stop Reasons | Last Assistant |", "| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |"]
        for summary in sessions[:max_sessions]:
            duration = seconds_between(summary.start, summary.end)
            last = summary.last_assistant_stop or ""
            if summary.last_assistant_tools:
                last = f"{last}; tools={','.join(summary.last_assistant_tools)}"
            elif summary.last_assistant_text:
                last = f"{last}; text={summary.last_assistant_text}"
            lines.append(
                md_row(
                    [
                        artifact_rel(summary.path, trial_dir),
                        summary.entries,
                        seconds_display(duration),
                        summary.llm_rounds,
                        tokens_text(summary),
                        counter_text(summary.models, 3),
                        counter_text(summary.tool_calls, 6),
                        counter_text(summary.stop_reasons),
                        truncate(last, 220),
                    ]
                )
            )
        if len(sessions) > max_sessions:
            lines.append(f"| ... | {len(sessions) - max_sessions} more omitted; raise `--max-sessions` |  |  |  |  |  |  |  |")
        lines.append("")
        lines += ["### Notable Session Signals", ""]
        any_notables = False
        for summary in sessions[:max_sessions]:
            if not summary.notables:
                continue
            any_notables = True
            lines.append(f"#### `{artifact_rel(summary.path, trial_dir)}`")
            lines.extend(f"- `{label}`: {text}" for label, text in summary.notables[:max_notables])
            lines.append("")
        if not any_notables:
            lines += ["No notable session signals matched the built-in patterns.", ""]
    if workers:
        lines += ["### Worker Outputs", "", "| File | Entries | Seconds | LLM Rounds | Tokens In/Out | Models | Tool Calls | Stop Reasons | Signals |", "| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |"]
        for summary in workers[:max_sessions]:
            duration = seconds_between(summary.start, summary.end)
            signal_text = "; ".join(f"{label}: {text}" for label, text in summary.notables[:3])
            lines.append(
                md_row(
                    [
                        artifact_rel(summary.path, trial_dir),
                        summary.entries,
                        seconds_display(duration),
                        summary.llm_rounds,
                        tokens_text(summary),
                        counter_text(summary.models, 3),
                        counter_text(summary.tool_calls, 6),
                        counter_text(summary.stop_reasons),
                        truncate(signal_text, 260),
                    ]
                )
            )
        if len(workers) > max_sessions:
            lines.append(f"| ... | {len(workers) - max_sessions} more omitted; raise `--max-sessions` |  |  |  |  |  |  |  |")
        lines.append("")
    return lines


def render_investigation_hints(summary: TrialSummary) -> list[str]:
    hints: list[str] = []
    if summary.exception != "none":
        hints.append(f"Exception path is active: `{summary.exception}`. Start from `exception.txt`, then inspect final ferment event `{summary.last_event}` and the last assistant/tool call in `agent/sessions/main.jsonl`.")
    if summary.ferment_status == "complete" and is_zero_reward(summary):
        hints.append("Ferment completed but verifier rejected the result. Compare failed CTRF tests against lifecycle verification commands; this usually indicates weak gates, exact-output mismatch, side effects, protocol mismatch, or dependency leakage.")
    if summary.ferment_status in INCOMPLETE_STATUSES and not is_pass(summary):
        hints.append(f"Ferment did not reach completion (`{summary.ferment_status}` with final event `{summary.last_event}`). Inspect phase/step timing and session stop reasons for timeout, response-length, or worker-stall evidence.")
    for signal in summary.signals:
        hints.append(f"Detected `{signal}` signal. Use the verifier/session excerpt for that signal as primary evidence before opening long raw logs.")
    if not hints:
        hints.append("No automated hint matched; inspect verifier failures first, then compare against ferment gates and the final main-session assistant message.")
    return ["## Investigation Hints", "", *[f"- {hint}" for hint in dict.fromkeys(hints)], ""]


def cache_path_for_trial(trial_dir: Path, cache_dir: Path) -> Path:
    return cache_dir / trial_dir.parent.name / f"{trial_dir.name}.md"


def phase_summary_cell(summary: TrialSummary) -> str:
    if not summary.phase_seconds:
        return ""
    return "; ".join(f"{truncate(name, 32)}={seconds_display(seconds)}" for name, seconds in summary.phase_seconds.items())


def compare_trials(trials: list[Path]) -> str:
    summaries = [summarize_trial(load_trial_evidence(trial)) for trial in sorted(trials)]
    lines = [
        "| Run | Trial | Reward | Exception | Status | Grade | Agent | Verifier | Span | Rounds | Tokens In/Out | Models | Final Event | Failed Tests | Signals | Phase Seconds |",
        "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- |",
    ]
    for summary in summaries:
        lines.append(
            md_row(
                [
                    summary.run,
                    summary.trial,
                    summary.reward,
                    summary.exception,
                    summary.ferment_status,
                    summary.grade,
                    seconds_display(summary.agent_seconds),
                    seconds_display(summary.verifier_seconds),
                    seconds_display(summary.session_span_seconds),
                    summary.llm_rounds,
                    tokens_text(summary),
                    counter_text(summary.models, 3),
                    summary.last_event,
                    ", ".join(summary.failed_tests[:3]),
                    counter_text(summary.signals, 5),
                    phase_summary_cell(summary),
                ]
            )
        )
    return "\n".join(lines) + "\n"


def command_run(args: argparse.Namespace) -> int:
    print_run_summary(resolve_run_dir(args.run), args.max_list)
    return 0


def command_trial(args: argparse.Namespace) -> int:
    trials = resolve_trials(args.targets, args.run, args.runs)
    if not trials:
        raise SystemExit("error: no trial directories matched")
    reports = [(trial, render_trial_report(trial, args.max_trace_lines, args.max_notables, args.max_sessions)) for trial in trials]
    output_paths: list[Path] = []
    if args.cache or args.output_dir:
        base = args.output_dir.resolve() if args.output_dir else DEFAULT_CACHE_DIR
        for trial, report in reports:
            path = cache_path_for_trial(trial, base) if args.cache and not args.output_dir else base / f"{trial.name}.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(report, encoding="utf-8")
            output_paths.append(path)
    if output_paths:
        for path in output_paths:
            print(path)
        return 0
    for index, (_trial, report) in enumerate(reports):
        if index:
            print("\n---\n")
        print(report, end="")
    return 0


def command_compare(args: argparse.Namespace) -> int:
    trials = resolve_trials(args.targets, args.run, args.runs)
    if not trials:
        raise SystemExit("error: no trial directories matched")
    report = compare_trials(trials)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
        print(args.output)
        return 0
    print(report, end="")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze terminal-bench ferment runs, trials, sessions, subagents, verifier failures, timings, and tokens.")
    subparsers = parser.add_subparsers(dest="command")

    run_parser = subparsers.add_parser("run", help="Summarize one full run.")
    run_parser.add_argument("run", nargs="?", help="Run directory or run name under jobs/. Defaults to latest jobs/ run.")
    run_parser.add_argument("--max-list", type=int, default=int(os.environ.get("MAX_LIST", str(DEFAULT_MAX_LIST))))
    run_parser.set_defaults(func=command_run)

    trial_parser = subparsers.add_parser("trial", help="Write or print detailed per-trial evidence reports.")
    trial_parser.add_argument("targets", nargs="*", help="Trial path/name, task name under --run/--runs, or glob under --run/--runs.")
    trial_parser.add_argument("--run", help="Single run directory or run name.")
    trial_parser.add_argument("--runs", nargs="+", help="Multiple run directories or run names. Targets are matched in each run.")
    trial_parser.add_argument("--cache", action="store_true", help=f"Write reports under {DEFAULT_CACHE_DIR}.")
    trial_parser.add_argument("--output-dir", type=Path, help="Write one Markdown report per trial to this directory.")
    trial_parser.add_argument("--max-trace-lines", type=int, default=80)
    trial_parser.add_argument("--max-notables", type=int, default=10)
    trial_parser.add_argument("--max-sessions", type=int, default=24)
    trial_parser.set_defaults(func=command_trial)

    compare_parser = subparsers.add_parser("compare", help="Compare trials or task attempts within or across runs.")
    compare_parser.add_argument("targets", nargs="*", help="Trial path/name, task name under --run/--runs, or glob under --run/--runs.")
    compare_parser.add_argument("--run", help="Single run directory or run name.")
    compare_parser.add_argument("--runs", nargs="+", help="Multiple run directories or run names. Targets are matched in each run.")
    compare_parser.add_argument("--output", type=Path, help="Write comparison Markdown table to this file.")
    compare_parser.set_defaults(func=command_compare)

    args = parser.parse_args()
    if args.command is None:
        args.command = "run"
        args.run = None
        args.max_list = int(os.environ.get("MAX_LIST", str(DEFAULT_MAX_LIST)))
        args.func = command_run
    if getattr(args, "run", None) and getattr(args, "runs", None):
        raise SystemExit("error: use --run or --runs, not both")
    return args


def main() -> int:
    args = parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
