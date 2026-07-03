#!/usr/bin/env python3
"""Tests for analyze_sessions.py — specifically validate_analysis_json()."""

from __future__ import annotations

import json

from analyze_sessions import validate_analysis_json


def test_valid_json_full_schema() -> None:
    """Full schema with all fields passes validation."""
    data = {
        "run_id": "gitlab-p123",
        "model": "kimchi-dev/minimax-m3",
        "configuration": "single-model",
        "summary": "Run completed with 2 failures.",
        "run_stats": {
            "verdicts": {"pass": 40, "fail": 20, "timeout": 25, "error": 4},
            "total_trials": 89,
            "pass_rate": 0.449,
        },
        "timeout_breakdown": [
            {"mechanism": "agent_in_flight", "count": 11, "example_tasks": ["write-compressor"]},
        ],
        "findings": [
            {
                "task": "cross-run",
                "severity": "critical",
                "category": "timeout policy",
                "finding": "No per-inference-call timeout.",
                "evidence_path": "jobs/chunk-0/trial-x/result.json",
                "suspected_layer": "timeout policy",
                "confidence": "high",
                "recommendation": "Add per-inference-call timeout.",
            },
        ],
        "task_notes": [
            {"task": "build-cython-ext", "note": "7 steps started / 6 verified", "artifact_path": "jobs/chunk-0/trial-x/agent/sessions/main.jsonl"},
        ],
        "plan_churn": {"fail_ferment_step": 3, "refine_ferment_phase": 1, "skip": 0, "resume": 2, "ask_user": 5, "total": 11},
        "open_questions": [
            {"question": "Is cache_read working?", "requires": "Re-run with explicit memory overrides"},
        ],
    }
    assert validate_analysis_json(json.dumps(data)) is None


def test_valid_json_minimal() -> None:
    """Minimal valid JSON — just needs findings list."""
    data = {"summary": "ok", "findings": []}
    assert validate_analysis_json(json.dumps(data)) is None


def test_valid_json_findings_with_extra_fields() -> None:
    """Findings with enriched fields pass."""
    data = {
        "findings": [
            {
                "task": "fix-git",
                "severity": "warning",
                "category": "tool-use guidance",
                "finding": "Agent used bash for file reads.",
                "evidence_path": "jobs/chunk-0/fix-git/agent/sessions/main.jsonl",
                "suspected_layer": "tool-use guidance",
                "confidence": "medium",
                "recommendation": "Add tool-use guidance to prefer read tool.",
            },
        ],
    }
    assert validate_analysis_json(json.dumps(data)) is None


def test_invalid_json_string() -> None:
    assert validate_analysis_json("not json") is not None


def test_empty_string() -> None:
    assert validate_analysis_json("") is not None


def test_json_array_not_object() -> None:
    assert validate_analysis_json("[1, 2, 3]") is not None


def test_missing_findings_key() -> None:
    """JSON without findings should fail."""
    data = {"summary": "ok"}
    assert validate_analysis_json(json.dumps(data)) is not None


def test_findings_not_a_list() -> None:
    data = {"findings": "not a list"}
    assert validate_analysis_json(json.dumps(data)) is not None


def test_empty_findings_list_valid() -> None:
    """Empty findings list is valid (no issues found)."""
    data = {"findings": []}
    assert validate_analysis_json(json.dumps(data)) is None
