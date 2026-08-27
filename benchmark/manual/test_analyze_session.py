#!/usr/bin/env python3
"""Parser tests for analyze-session.py (token-optimization Phase 0 artifact fields).

Runnable standalone: `python3 benchmark/manual/test_analyze_session.py`.
Exits 0 on success, 1 with a readable failure list otherwise.
"""

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("analyze_session", Path(__file__).parent / "analyze-session.py")
_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_module)
analyze_jsonl = _module.analyze_jsonl
analyze_session = _module.analyze_session

FIXTURES = Path(__file__).parent / "fixtures"

failures = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def test_artifact_session():
    metrics = analyze_jsonl(FIXTURES / "session-artifact-sample.jsonl")
    assert metrics is not None, "artifact fixture returned None"

    check("artifact total_tokens", metrics["total_tokens"], 12300)
    check("artifact orch_tokens", metrics["orch_tokens"], 12300)

    cache = metrics.get("cache")
    assert cache is not None, "cache summary missing from artifact metrics"
    check("cache inputTokens", cache["inputTokens"], 12000)
    check("cache cacheReadTokens", cache["cacheReadTokens"], 9000)
    check("cache cacheWriteTokens", cache["cacheWriteTokens"], 1000)
    check("cache messages", cache["messages"], 1)

    context = metrics.get("context")
    assert context is not None, "context assembly missing from artifact metrics"
    check("context system_prompt_tokens_est", context["system_prompt_tokens_est"], 1000)
    check("context tool_surface_tokens_est", context["tool_surface_tokens_est"], 3000)
    check("context prefix_changes", context["prefix_changes"], 1)


def test_legacy_session_backward_compatible():
    metrics = analyze_jsonl(FIXTURES / "session-legacy-sample.jsonl")
    assert metrics is not None, "legacy fixture returned None"
    check("legacy total_tokens", metrics["total_tokens"], 10750)
    check("legacy cache", metrics["cache"], None)
    check("legacy context", metrics["context"], None)


def test_unknown_entry_types_are_ignored():
    with tempfile.TemporaryDirectory() as tmp:
        jsonl = Path(tmp) / "unknown.jsm.jsonl"
        lines = [
            {"type": "session_start", "timestamp": "2026-08-26T08:00:00.000Z"},
            {
                "type": "message",
                "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                "timestamp": "2026-08-26T08:00:01.000Z",
            },
            {
                "type": "custom",
                "customType": "future_schema_thing",
                "data": {"whatever": 42},
                "timestamp": "2026-08-26T08:00:01.500Z",
            },
            {
                "type": "custom",
                "customType": "context_assembly",
                "data": {"schemaVersion": 99, "reason": "composition", "systemPrompt": {"chars": 8, "tokensEstimated": 2}},
                "timestamp": "2026-08-26T08:00:01.600Z",
            },
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "usage": {"input": 10, "output": 5, "totalTokens": 15},
                },
                "timestamp": "2026-08-26T08:00:03.000Z",
            },
        ]
        jsonl.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
        metrics = analyze_jsonl(jsonl)

    assert metrics is not None, "unknown-entry fixture returned None"
    check("unknown-entry cache", metrics["cache"], None)
    # Unknown-but-parseable context_assembly data still surfaces generically.
    check(
        "unknown-entry system_prompt_tokens_est",
        metrics["context"]["system_prompt_tokens_est"],
        2,
    )


def test_analysis_json_round_trip():
    with tempfile.TemporaryDirectory() as tmp:
        runs = Path(tmp) / "session-99" / "runs" / "research"
        runs.mkdir(parents=True)
        for fixture in FIXTURES.glob("session-*.jsonl"):
            (runs / fixture.name).write_text(fixture.read_text())
        results = analyze_session(runs.parent.parent)
        assert results is not None, "session-level analysis returned None"
        (Path(tmp) / "session-99" / "analysis.json").write_text(json.dumps(results, indent=2))
        reloaded = json.loads((Path(tmp) / "session-99" / "analysis.json").read_text())
        assert "research" in reloaded, "analysis.json lost the run"


test_artifact_session()
test_legacy_session_backward_compatible()
test_unknown_entry_types_are_ignored()
test_analysis_json_round_trip()

if failures:
    print("FAILURES:")
    for failure in failures:
        print(f"  - {failure}")
    sys.exit(1)
print("All analyze-session parser tests passed.")
