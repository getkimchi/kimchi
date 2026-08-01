#!/usr/bin/env python3
"""Unit tests for analyze_timeouts.py — evidence extraction and loop detection."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from analyze_timeouts import (
    TimeoutTrial,
    ToolCallEntry,
    _hash_args,
    _summarize_args,
    build_cross_trial_patterns,
    compute_time_distribution,
    detect_loops,
    extract_ferment_evidence,
    extract_session_evidence,
    extract_trial_evidence,
    find_timeout_trials,
    iter_jsonl,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def write_jsonl(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def make_session_entry(
    timestamp: str,
    role: str,
    *,
    content: list | None = None,
    usage: dict | None = None,
    is_error: bool = False,
    error_message: str | None = None,
) -> dict:
    message: dict = {"role": role}
    if content is not None:
        message["content"] = content
    if usage is not None:
        message["usage"] = usage
    if is_error:
        message["isError"] = True
    if error_message:
        message["errorMessage"] = error_message
    return {"type": "message", "timestamp": timestamp, "message": message}


def make_tool_call(name: str, args: dict | str = "") -> dict:
    args_str = json.dumps(args, sort_keys=True) if isinstance(args, dict) else args
    return {"type": "toolCall", "name": name, "input": args_str}


def make_tool_result_entry(timestamp: str, text: str, is_error: bool = False) -> dict:
    msg: dict = {"role": "toolResult", "content": [{"type": "text", "text": text}]}
    if is_error:
        msg["isError"] = True
    return {"type": "message", "timestamp": timestamp, "message": msg}


def make_timeout_trial(
    tmp_path: Path,
    trial_id: str = "task-a__abc123",
    task: str = "task-a",
    timeout_duration_sec: float = 600.0,
) -> TimeoutTrial:
    trial_dir = tmp_path / trial_id
    trial_dir.mkdir(parents=True, exist_ok=True)
    return TimeoutTrial(
        trial_id=trial_id,
        task=task,
        attempt=1,
        trial_dir=trial_dir,
        timeout_duration_sec=timeout_duration_sec,
        existing_analysis={"timeout_status": "inference_hang", "timeout_duration_sec": timeout_duration_sec},
        model="kimchi-dev/glm-5.2-fp8",
        duration_ms=600_000,
    )


def write_result_json(trial_dir: Path, occurred_at: str = "2026-07-01T12:10:00Z") -> None:
    write_json(trial_dir / "result.json", {
        "trial_name": trial_dir.name,
        "exception_info": {
            "exception_type": "AgentTimeoutError",
            "exception_message": "Agent execution timed out after 600.0 seconds",
            "occurred_at": occurred_at,
        },
        "agent_execution": {"started_at": "2026-07-01T12:00:00Z"},
        "finished_at": occurred_at,
    })


# ---------------------------------------------------------------------------
# iter_jsonl
# ---------------------------------------------------------------------------


def test_iter_jsonl_reads_valid_entries(tmp_path: Path) -> None:
    path = tmp_path / "test.jsonl"
    write_jsonl(path, [{"type": "session"}, {"type": "message"}, {"type": "message"}])
    entries = iter_jsonl(path)
    assert len(entries) == 3
    assert entries[0]["type"] == "session"
    assert entries[1]["type"] == "message"


def test_iter_jsonl_skips_malformed_lines(tmp_path: Path) -> None:
    path = tmp_path / "test.jsonl"
    path.write_text('{"type": "session"}\n{bad json}\n{"type": "message"}\n\n', encoding="utf-8")
    entries = iter_jsonl(path)
    assert len(entries) == 2


def test_iter_jsonl_returns_empty_for_missing_file(tmp_path: Path) -> None:
    entries = iter_jsonl(tmp_path / "nonexistent.jsonl")
    assert entries == []


# ---------------------------------------------------------------------------
# _summarize_args / _hash_args
# ---------------------------------------------------------------------------


def test_summarize_args_bash_extracts_command() -> None:
    args = json.dumps({"command": "npm test"})
    result = _summarize_args("bash", args)
    assert "npm test" in result


def test_summarize_args_edit_extracts_path() -> None:
    args = json.dumps({"path": "/src/file.ts"})
    result = _summarize_args("edit", args)
    assert "/src/file.ts" in result


def test_summarize_args_truncates_long_args() -> None:
    long_args = "x" * 500
    result = _summarize_args("grep", long_args)
    assert len(result) <= 200


def test_hash_args_same_input_same_hash() -> None:
    h1 = _hash_args("bash", "echo hello")
    h2 = _hash_args("bash", "echo hello")
    assert h1 == h2


def test_hash_args_different_input_different_hash() -> None:
    h1 = _hash_args("bash", "echo hello")
    h2 = _hash_args("bash", "echo world")
    assert h1 != h2


# ---------------------------------------------------------------------------
# detect_loops
# ---------------------------------------------------------------------------


def test_detect_loops_consecutive_repeat() -> None:
    calls = [
        ToolCallEntry(name="bash", args_summary="npm test", args_hash="h1", timestamp=None),
        ToolCallEntry(name="bash", args_summary="npm test", args_hash="h1", timestamp=None),
        ToolCallEntry(name="bash", args_summary="npm test", args_hash="h1", timestamp=None),
    ]
    patterns = detect_loops(calls)
    assert len(patterns) >= 1
    assert patterns[0]["type"] == "consecutive_repeat"
    assert patterns[0]["tool"] == "bash"
    assert patterns[0]["count"] == 3


def test_detect_loops_no_repeats() -> None:
    calls = [
        ToolCallEntry(name="bash", args_summary="cmd1", args_hash="h1", timestamp=None),
        ToolCallEntry(name="read", args_summary="file1", args_hash="h2", timestamp=None),
        ToolCallEntry(name="edit", args_summary="file2", args_hash="h3", timestamp=None),
    ]
    patterns = detect_loops(calls)
    assert patterns == []


def test_detect_loops_fewer_than_threshold() -> None:
    calls = [
        ToolCallEntry(name="bash", args_summary="cmd", args_hash="h1", timestamp=None),
        ToolCallEntry(name="bash", args_summary="cmd", args_hash="h1", timestamp=None),
    ]
    patterns = detect_loops(calls)
    assert patterns == []


def test_detect_loops_frequent_repeat_non_consecutive() -> None:
    calls = [
        ToolCallEntry(name="bash", args_summary="npm test", args_hash="h1", timestamp=None),
        ToolCallEntry(name="read", args_summary="file", args_hash="h2", timestamp=None),
        ToolCallEntry(name="bash", args_summary="npm test", args_hash="h1", timestamp=None),
        ToolCallEntry(name="edit", args_summary="f", args_hash="h3", timestamp=None),
        ToolCallEntry(name="bash", args_summary="npm test", args_hash="h1", timestamp=None),
    ]
    patterns = detect_loops(calls)
    assert len(patterns) >= 1
    found_frequent = any(p["type"] == "frequent_repeat" and p["count"] == 3 for p in patterns)
    assert found_frequent


# ---------------------------------------------------------------------------
# extract_session_evidence
# ---------------------------------------------------------------------------


def test_extract_session_evidence_basic(tmp_path: Path) -> None:
    session_path = tmp_path / "agent" / "sessions" / "main.jsonl"
    write_jsonl(session_path, [
        {"type": "session"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
        make_session_entry(
            "2026-07-01T12:00:10Z",
            "assistant",
            content=[make_tool_call("bash", {"command": "echo hello"})],
            usage={"input": 100, "output": 50, "cacheRead": 10, "cacheWrite": 5},
        ),
        make_tool_result_entry("2026-07-01T12:00:15Z", "hello"),
    ])

    evidence = extract_session_evidence(session_path, datetime(2026, 7, 1, 12, 10, tzinfo=UTC))
    assert evidence.is_subagent is False
    assert evidence.n_messages == 3
    assert len(evidence.tool_calls) == 1
    assert evidence.tool_calls[0].name == "bash"
    assert "echo hello" in evidence.tool_calls[0].args_summary
    assert evidence.llm_rounds == 1
    assert evidence.token_usage["input"] == 100
    assert evidence.token_usage["output"] == 50


def test_extract_session_evidence_detects_subagent(tmp_path: Path) -> None:
    session_path = tmp_path / "agent" / "sessions" / "123456_abc.jsonl"
    write_jsonl(session_path, [
        {"type": "session", "parentSession": "main"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
    ])

    evidence = extract_session_evidence(session_path, None)
    assert evidence.is_subagent is True
    assert evidence.parent_session_id == "main"


def test_extract_session_evidence_error_signals(tmp_path: Path) -> None:
    session_path = tmp_path / "agent" / "sessions" / "main.jsonl"
    write_jsonl(session_path, [
        {"type": "session"},
        make_tool_result_entry("2026-07-01T12:00:00Z", "Error: rate limit exceeded", is_error=True),
    ])

    evidence = extract_session_evidence(session_path, None)
    assert len(evidence.error_signals) > 0
    assert any("rate limit" in s.lower() for s in evidence.error_signals)


def test_extract_session_evidence_error_message_field(tmp_path: Path) -> None:
    session_path = tmp_path / "agent" / "sessions" / "main.jsonl"
    write_jsonl(session_path, [
        {"type": "session"},
        {
            "type": "message",
            "timestamp": "2026-07-01T12:00:00Z",
            "message": {"role": "assistant", "errorMessage": "429 Too Many Requests"},
        },
    ])

    evidence = extract_session_evidence(session_path, None)
    assert any("429" in s for s in evidence.error_signals)


def test_extract_session_evidence_dedupes_claude_code_split_entries(tmp_path: Path) -> None:
    """Claude Code splits a single API response into two JSONL entries
    (thinking + tool_use) with identical usage. Token counts must not be
    doubled, but tool calls from both entries are kept.
    """
    session_path = tmp_path / "agent" / "sessions" / "main.jsonl"
    usage = {"input": 100, "output": 50, "cacheRead": 10, "cacheWrite": 5}
    write_jsonl(session_path, [
        {"type": "session"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
        # First half of the API response (thinking block)
        make_session_entry(
            "2026-07-01T12:00:10Z",
            "assistant",
            content=[{"type": "thinking", "thinking": "..."}],
            usage=usage,
        ),
        # Second half of the same API response (tool_use block) — same usage
        make_session_entry(
            "2026-07-01T12:00:10Z",
            "assistant",
            content=[make_tool_call("bash", {"command": "echo hello"})],
            usage=usage,
        ),
        # A genuinely different API response
        make_session_entry(
            "2026-07-01T12:00:20Z",
            "assistant",
            content=[make_tool_call("read", {"path": "/app/foo.py"})],
            usage={"input": 200, "output": 80, "cacheRead": 20, "cacheWrite": 8},
        ),
    ])

    evidence = extract_session_evidence(session_path, datetime(2026, 7, 1, 12, 10, tzinfo=UTC))
    # 3 assistant entries, but only 2 distinct usage objects
    assert evidence.llm_rounds == 2
    assert evidence.token_usage["input"] == 100 + 200
    assert evidence.token_usage["output"] == 50 + 80
    assert evidence.token_usage["cache_read"] == 10 + 20
    assert evidence.token_usage["cache_write"] == 5 + 8
    # Tool calls from all entries are counted
    assert len(evidence.tool_calls) == 2
    assert evidence.tool_calls[0].name == "bash"
    assert evidence.tool_calls[1].name == "read"


def test_extract_session_evidence_no_dedupe_for_incremental_usage(tmp_path: Path) -> None:
    """Kimchi writes one entry per API call with varying usage — no
    deduplication should occur.
    """
    session_path = tmp_path / "agent" / "sessions" / "main.jsonl"
    write_jsonl(session_path, [
        {"type": "session"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
        make_session_entry(
            "2026-07-01T12:00:10Z", "assistant",
            usage={"input": 12, "output": 154, "cacheRead": 14336, "cacheWrite": 0},
        ),
        make_session_entry(
            "2026-07-01T12:00:20Z", "assistant",
            usage={"input": 235, "output": 81, "cacheRead": 14336, "cacheWrite": 0},
        ),
        make_session_entry(
            "2026-07-01T12:00:30Z", "assistant",
            usage={"input": 614, "output": 100, "cacheRead": 14336, "cacheWrite": 0},
        ),
    ])

    evidence = extract_session_evidence(session_path, datetime(2026, 7, 1, 12, 10, tzinfo=UTC))
    assert evidence.llm_rounds == 3
    assert evidence.token_usage["input"] == 12 + 235 + 614
    assert evidence.token_usage["output"] == 154 + 81 + 100


# ---------------------------------------------------------------------------
# compute_time_distribution
# ---------------------------------------------------------------------------


def test_compute_time_distribution_basic() -> None:
    entries = [
        {"type": "message", "timestamp": "2026-07-01T12:00:00Z",
         "message": {"role": "assistant", "content": [make_tool_call("bash", {"command": "sleep 5"})]}},
        {"type": "message", "timestamp": "2026-07-01T12:00:05Z",
         "message": {"role": "toolResult", "content": [{"type": "text", "text": "done"}]}},
        {"type": "message", "timestamp": "2026-07-01T12:00:10Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "thinking..."}]}},
    ]
    timeout = datetime(2026, 7, 1, 12, 0, 30, tzinfo=UTC)
    dist = compute_time_distribution(entries, timeout)
    assert dist["tool_exec_sec"] == 5.0  # 12:00:00 → 12:00:05
    assert dist["idle_sec"] == 20.0      # 12:00:10 → 12:00:30


def test_compute_time_distribution_empty() -> None:
    dist = compute_time_distribution([], None)
    assert dist["inference_sec"] == 0.0
    assert dist["tool_exec_sec"] == 0.0


def test_compute_time_distribution_inference_gap() -> None:
    entries = [
        {"type": "message", "timestamp": "2026-07-01T12:00:00Z",
         "message": {"role": "toolResult", "content": [{"type": "text", "text": "result"}]}},
        {"type": "message", "timestamp": "2026-07-01T12:00:30Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "thinking"}]}},
    ]
    dist = compute_time_distribution(entries, None)
    assert dist["inference_sec"] == 30.0


# ---------------------------------------------------------------------------
# extract_ferment_evidence
# ---------------------------------------------------------------------------


def test_extract_ferment_evidence_no_ferments_dir(tmp_path: Path) -> None:
    result = extract_ferment_evidence(tmp_path)
    assert result is None


def test_extract_ferment_evidence_basic(tmp_path: Path) -> None:
    ferments_dir = tmp_path / "agent" / "ferments"
    ferments_dir.mkdir(parents=True)
    write_json(ferments_dir / "ferment-123.json", {
        "id": "ferment-123",
        "phases": [
            {"id": "p1", "steps": [{"id": "s1"}, {"id": "s2"}]},
            {"id": "p2", "steps": [{"id": "s3"}]},
        ],
    })
    # Write lifecycle events
    write_jsonl(ferments_dir / "ferment-123.events.jsonl", [
        {"type": "phase_activated", "phase": {"id": "p1", "index": 0}},
        {"type": "step_started", "step": {"id": "s1"}},
        {"type": "step_completed"},
        {"type": "step_started", "step": {"id": "s2"}},
        {"type": "phase_activated", "phase": {"id": "p2", "index": 1}},
        {"type": "step_started", "step": {"id": "s3"}},
    ])

    result = extract_ferment_evidence(tmp_path)
    assert result is not None
    assert result["active"] is True
    assert result["ferment_id"] == "ferment-123"
    assert result["total_phases"] == 2
    assert result["total_steps"] == 3
    assert result["completed_phases"] == 0  # no phase_completed events
    assert result["completed_steps"] == 1   # one step_completed event
    assert result["current_phase"] == "p2"
    assert result["current_step"] == "s3"
    assert "1/3 steps" in result["progress"]


def test_extract_ferment_evidence_completed(tmp_path: Path) -> None:
    ferments_dir = tmp_path / "agent" / "ferments"
    ferments_dir.mkdir(parents=True)
    write_json(ferments_dir / "f1.json", {
        "id": "f1",
        "phases": [{"id": "p1", "steps": [{"id": "s1"}]}],
    })
    write_jsonl(ferments_dir / "f1.events.jsonl", [
        {"type": "phase_activated", "phase": {"id": "p1", "index": 0}},
        {"type": "step_started", "step": {"id": "s1"}},
        {"type": "step_completed"},
        {"type": "phase_completed"},
        {"type": "ferment_completed"},
    ])

    result = extract_ferment_evidence(tmp_path)
    assert result is not None
    assert result["completed_phases"] == 1
    assert result["completed_steps"] == 1
    assert result["total_phases"] == 1


# ---------------------------------------------------------------------------
# find_timeout_trials
# ---------------------------------------------------------------------------


def test_find_timeout_trials_filters_only_timeouts(tmp_path: Path) -> None:
    results_dir = tmp_path / "jobs"
    trial_dir = results_dir / "run-1" / "task-a__abc"
    trial_dir.mkdir(parents=True)
    write_json(trial_dir / "result.json", {"trial_name": "task-a__abc"})

    summary_path = tmp_path / "summary.json"
    write_json(summary_path, {
        "trials": [
            {"trial_id": "task-a__abc", "task": "task-a", "attempt": 1, "verdict": "agent_timeout",
             "agent_timeout_analysis": {"timeout_status": "inference_hang", "timeout_duration_sec": 600.0},
             "models": [{"model": "kimchi-dev/glm-5.2-fp8"}], "duration_ms": 600000},
            {"trial_id": "task-b__xyz", "task": "task-b", "attempt": 1, "verdict": "scored_pass"},
            {"trial_id": "task-c__def", "task": "task-c", "attempt": 1, "verdict": "scored_fail"},
        ],
    })

    trials = find_timeout_trials(summary_path, results_dir)
    assert len(trials) == 1
    assert trials[0].trial_id == "task-a__abc"
    assert trials[0].timeout_duration_sec == 600.0


def test_find_timeout_trials_empty_summary(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    write_json(summary_path, {"trials": []})
    results_dir = tmp_path / "jobs"
    trials = find_timeout_trials(summary_path, results_dir)
    assert trials == []


def test_find_timeout_trials_missing_trial_dir(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    write_json(summary_path, {
        "trials": [
            {"trial_id": "task-a__abc", "task": "task-a", "attempt": 1, "verdict": "agent_timeout"},
        ],
    })
    results_dir = tmp_path / "jobs"
    trials = find_timeout_trials(summary_path, results_dir)
    assert trials == []


# ---------------------------------------------------------------------------
# extract_trial_evidence
# ---------------------------------------------------------------------------


def test_extract_trial_evidence_full(tmp_path: Path) -> None:
    trial = make_timeout_trial(tmp_path)
    write_result_json(trial.trial_dir)

    # Write orchestrator session
    sessions_dir = trial.trial_dir / "agent" / "sessions"
    write_jsonl(sessions_dir / "main.jsonl", [
        {"type": "session"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
        make_session_entry(
            "2026-07-01T12:00:10Z",
            "assistant",
            content=[make_tool_call("bash", {"command": "npm test"})],
            usage={"input": 100, "output": 50, "cacheRead": 10, "cacheWrite": 5},
        ),
        make_tool_result_entry("2026-07-01T12:00:20Z", "all tests passed"),
        make_session_entry(
            "2026-07-01T12:00:30Z",
            "assistant",
            content=[make_tool_call("bash", {"command": "echo done"})],
            usage={"input": 80, "output": 20},
        ),
    ])

    evidence = extract_trial_evidence(trial)
    assert evidence["trial_id"] == trial.trial_id
    orch = evidence["orchestrator_session"]
    assert orch["n_messages"] == 4
    assert orch["n_tool_calls"] == 2
    assert orch["token_usage"]["input"] == 180
    assert orch["token_usage"]["output"] == 70
    assert len(orch["last_tool_calls"]) == 2
    # Last call is most recent first
    assert orch["last_tool_calls"][0]["name"] == "bash"
    assert "echo done" in orch["last_tool_calls"][0]["args_summary"]
    # Subagents should be empty
    assert evidence["subagents"] == []
    # Total tokens
    assert evidence["total_token_usage"]["input"] == 180


def test_extract_trial_evidence_with_subagent(tmp_path: Path) -> None:
    trial = make_timeout_trial(tmp_path)
    write_result_json(trial.trial_dir)

    sessions_dir = trial.trial_dir / "agent" / "sessions"

    # Orchestrator calls Agent tool
    write_jsonl(sessions_dir / "main.jsonl", [
        {"type": "session"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
        make_session_entry(
            "2026-07-01T12:00:05Z",
            "assistant",
            content=[make_tool_call("Agent", {"prompt": "do stuff"})],
        ),
        make_tool_result_entry("2026-07-01T12:05:00Z", "subagent result"),
    ])

    # Subagent session
    write_jsonl(sessions_dir / "123456_sub.jsonl", [
        {"type": "session", "parentSession": "main"},
        make_session_entry("2026-07-01T12:00:10Z", "user"),
        make_session_entry(
            "2026-07-01T12:00:20Z",
            "assistant",
            content=[make_tool_call("bash", {"command": "ls"})],
        ),
        make_tool_result_entry("2026-07-01T12:00:25Z", "file1.txt"),
    ])

    evidence = extract_trial_evidence(trial)
    assert len(evidence["subagents"]) == 1
    sub = evidence["subagents"][0]
    assert sub["session_file"] == "123456_sub.jsonl"
    assert sub["n_tool_calls"] == 1
    assert sub["last_tool_call"]["name"] == "bash"
    # The orchestrator's last tool call was Agent, so the subagent is
    # considered in-flight even though the gap is large (575 sec) —
    # this is the "subagent stall" pattern we want to detect.
    assert evidence["subagent_in_flight"] == "123456_sub.jsonl"


def test_extract_trial_evidence_subagent_in_flight(tmp_path: Path) -> None:
    trial = make_timeout_trial(tmp_path)
    write_result_json(trial.trial_dir, occurred_at="2026-07-01T12:00:30Z")

    sessions_dir = trial.trial_dir / "agent" / "sessions"

    # Orchestrator calls Agent at 12:00:10
    write_jsonl(sessions_dir / "main.jsonl", [
        {"type": "session"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
        make_session_entry(
            "2026-07-01T12:00:10Z",
            "assistant",
            content=[make_tool_call("Agent", {"prompt": "do stuff"})],
        ),
    ])

    # Subagent active until 12:00:25, timeout at 12:00:30 → gap = 5 sec (< 120)
    write_jsonl(sessions_dir / "123456_sub.jsonl", [
        {"type": "session", "parentSession": "main"},
        make_session_entry("2026-07-01T12:00:15Z", "user"),
        make_session_entry(
            "2026-07-01T12:00:25Z",
            "assistant",
            content=[make_tool_call("bash", {"command": "ls"})],
        ),
    ])

    evidence = extract_trial_evidence(trial)
    assert evidence["subagent_in_flight"] == "123456_sub.jsonl"


def test_extract_trial_evidence_with_ferment(tmp_path: Path) -> None:
    trial = make_timeout_trial(tmp_path)
    write_result_json(trial.trial_dir)

    sessions_dir = trial.trial_dir / "agent" / "sessions"
    write_jsonl(sessions_dir / "main.jsonl", [
        {"type": "session"},
        make_session_entry("2026-07-01T12:00:00Z", "user"),
    ])

    ferments_dir = trial.trial_dir / "agent" / "ferments"
    ferments_dir.mkdir(parents=True)
    write_json(ferments_dir / "f1.json", {
        "id": "f1",
        "phases": [
            {"id": "scope", "steps": [{"id": "s1"}, {"id": "s2"}]},
            {"id": "implement", "steps": [{"id": "s3"}]},
        ],
    })
    write_jsonl(ferments_dir / "f1.events.jsonl", [
        {"type": "phase_activated", "phase": {"id": "scope", "index": 0}},
        {"type": "step_started", "step": {"id": "s1"}},
        {"type": "step_completed"},
        {"type": "phase_activated", "phase": {"id": "implement", "index": 1}},
        {"type": "step_started", "step": {"id": "s3"}},
    ])

    evidence = extract_trial_evidence(trial)
    assert evidence["ferment"] is not None
    assert evidence["ferment"]["active"] is True
    assert evidence["ferment"]["total_phases"] == 2
    assert evidence["ferment"]["total_steps"] == 3
    assert evidence["ferment"]["completed_steps"] == 1
    assert evidence["ferment"]["current_phase"] == "implement"
    assert evidence["ferment"]["current_step"] == "s3"


def test_extract_trial_evidence_loop_detection(tmp_path: Path) -> None:
    trial = make_timeout_trial(tmp_path)
    write_result_json(trial.trial_dir)

    sessions_dir = trial.trial_dir / "agent" / "sessions"
    entries = [{"type": "session"}, make_session_entry("2026-07-01T12:00:00Z", "user")]
    # Same tool call repeated 4 times
    for i in range(4):
        entries.append(make_session_entry(
            f"2026-07-01T12:0{i}:00Z",
            "assistant",
            content=[make_tool_call("bash", {"command": "npm test"})],
        ))
        entries.append(make_tool_result_entry(f"2026-07-01T12:0{i}:30Z", "error"))
    write_jsonl(sessions_dir / "main.jsonl", entries)

    evidence = extract_trial_evidence(trial)
    orch = evidence["orchestrator_session"]
    assert len(orch["repeated_patterns"]) >= 1
    assert orch["repeated_patterns"][0]["count"] == 4


# ---------------------------------------------------------------------------
# build_cross_trial_patterns
# ---------------------------------------------------------------------------


def test_build_cross_trial_patterns_basic() -> None:
    trials = [
        {
            "task": "task-a",
            "model": "kimchi-dev/glm-5.2-fp8",
            "existing_classification": {"timeout_status": "inference_hang"},
            "orchestrator_session": {
                "last_tool_calls": [{"name": "bash"}],
                "repeated_patterns": [{"type": "consecutive_repeat"}],
                "error_signals": ["rate limit"],
            },
            "subagent_in_flight": None,
            "ferment": None,
        },
        {
            "task": "task-a",
            "model": "kimchi-dev/glm-5.2-fp8",
            "existing_classification": {"timeout_status": "tool_hang"},
            "orchestrator_session": {
                "last_tool_calls": [{"name": "edit"}],
                "repeated_patterns": [],
                "error_signals": [],
            },
            "subagent_in_flight": "sub1.jsonl",
            "ferment": None,
        },
    ]
    patterns = build_cross_trial_patterns(trials)
    assert patterns["total_timeouts"] == 2
    assert patterns["by_task"]["task-a"] == 2
    assert patterns["by_timeout_status"]["inference_hang"] == 1
    assert patterns["by_timeout_status"]["tool_hang"] == 1
    assert patterns["common_last_tools"]["bash"] == 1
    assert patterns["loop_detected_count"] == 1
    assert patterns["error_signal_count"] == 1
    assert patterns["subagent_in_flight_count"] == 1


def test_build_cross_trial_patterns_empty() -> None:
    patterns = build_cross_trial_patterns([])
    assert patterns["total_timeouts"] == 0
    assert patterns["by_task"] == {}


def test_build_cross_trial_patterns_ferment_phases() -> None:
    trials = [
        {
            "task": "task-a",
            "model": "m1",
            "existing_classification": None,
            "orchestrator_session": None,
            "subagent_in_flight": None,
            "ferment": {"active": True, "current_phase": "implement"},
        },
        {
            "task": "task-b",
            "model": "m1",
            "existing_classification": None,
            "orchestrator_session": None,
            "subagent_in_flight": None,
            "ferment": {"active": True, "current_phase": "implement"},
        },
    ]
    patterns = build_cross_trial_patterns(trials)
    assert patterns["common_ferment_phases"]["implement"] == 2
