#!/usr/bin/env python3
"""Tests for analyze_sessions.py — specifically validate_analysis_json()."""

from __future__ import annotations

import json

from analyze_sessions import validate_analysis_json


def test_valid_json_with_findings() -> None:
    data = {
        "run_id": "gitlab-p123",
        "model": "kimchi-dev/minimax-m3",
        "configuration": "single-model",
        "summary": "Run completed with 2 failures.",
        "findings": [
            {"task": "fix-git", "severity": "critical", "category": "agent_failure", "finding": "Agent looped."},
        ],
    }
    assert validate_analysis_json(json.dumps(data)) is None


def test_valid_json_minimal() -> None:
    """Minimal valid JSON — loose schema, just needs to be parseable with findings."""
    data = {"summary": "ok", "findings": []}
    assert validate_analysis_json(json.dumps(data)) is None


def test_invalid_json_string() -> None:
    assert validate_analysis_json("not json") is not None


def test_empty_string() -> None:
    assert validate_analysis_json("") is not None


def test_json_array_not_object() -> None:
    assert validate_analysis_json("[1, 2, 3]") is not None


def test_json_missing_findings_key() -> None:
    """JSON without findings array should fail validation."""
    data = {"summary": "ok"}
    assert validate_analysis_json(json.dumps(data)) is not None


def test_findings_not_a_list() -> None:
    data = {"findings": "not a list"}
    assert validate_analysis_json(json.dumps(data)) is not None
