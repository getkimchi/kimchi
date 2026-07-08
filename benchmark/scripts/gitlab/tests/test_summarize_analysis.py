#!/usr/bin/env python3
"""Tests for summarize_analysis.py."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch
from urllib import error, request

from summarize_analysis import (
    build_runs_table,
    call_opus,
    compute_lookback_dates,
    extract_run_metrics,
    filter_metadata,
    is_full_run,
    is_in_time_window,
    metadata_dict,
    metadata_string,
    post_to_discord,
    run_configuration,
    run_label,
    split_by_ferment,
)

# --- compute_lookback_dates ---

def test_compute_lookback_dates_returns_yesterday_and_today() -> None:
    """At 06:30 UTC on July 2, lookback is July 1 (yesterday) and July 2 (today)."""
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    yesterday, today = compute_lookback_dates(now)
    assert yesterday == "2026-07-01"
    assert today == "2026-07-02"


def test_compute_lookback_dates_across_month_boundary() -> None:
    """At 06:30 UTC on August 1, lookback is July 31 and August 1."""
    now = datetime(2026, 8, 1, 6, 30, 0, tzinfo=UTC)
    yesterday, today = compute_lookback_dates(now)
    assert yesterday == "2026-07-31"
    assert today == "2026-08-01"


# --- is_in_time_window ---

def test_is_in_time_window_includes_run_at_18_00() -> None:
    """A run created at 18:00 UTC yesterday is within the window."""
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    created = datetime(2026, 7, 1, 18, 0, 0, tzinfo=UTC)
    assert is_in_time_window(created, now) is True


def test_is_in_time_window_includes_run_at_03_00() -> None:
    """A run created at 03:00 UTC today is within the window."""
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    created = datetime(2026, 7, 2, 3, 0, 0, tzinfo=UTC)
    assert is_in_time_window(created, now) is True


def test_is_in_time_window_boundary_at_06_00() -> None:
    """A run created exactly at 06:00 UTC today is within the window (inclusive)."""
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    created = datetime(2026, 7, 2, 6, 0, 0, tzinfo=UTC)
    assert is_in_time_window(created, now) is True


def test_is_in_time_window_excludes_run_at_16_00() -> None:
    """A run created at 16:00 UTC yesterday is before the window."""
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    created = datetime(2026, 7, 1, 16, 0, 0, tzinfo=UTC)
    assert is_in_time_window(created, now) is False


def test_is_in_time_window_excludes_run_at_07_00() -> None:
    """A run created at 07:00 UTC today is after the window."""
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    created = datetime(2026, 7, 2, 7, 0, 0, tzinfo=UTC)
    assert is_in_time_window(created, now) is False


# --- is_full_run ---

def test_is_full_run_with_tasks_all_true() -> None:
    metadata = {"run_metadata": {"tasks_all": True, "selected_tasks": ["a"] * 89}}
    assert is_full_run(metadata) is True


def test_is_full_run_with_tasks_all_false() -> None:
    metadata = {"run_metadata": {"tasks_all": False, "selected_tasks": ["a"] * 10}}
    assert is_full_run(metadata) is False


def test_is_full_run_with_89_tasks() -> None:
    """When tasks_all is absent, fall back to counting selected_tasks."""
    metadata = {"run_metadata": {"selected_tasks": [f"task-{i}" for i in range(89)]}}
    assert is_full_run(metadata) is True


def test_is_full_run_with_fewer_tasks() -> None:
    metadata = {"run_metadata": {"selected_tasks": ["a", "b", "c"]}}
    assert is_full_run(metadata) is False


# --- filter_metadata ---

def test_filter_metadata_includes_valid_run() -> None:
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    metadata = {
        "created_at": "2026-07-01T20:00:00Z",
        "ferment": True,
        "gitlab": {"target_ref": "master"},
        "run_metadata": {"tasks_all": True, "selected_tasks": ["a"] * 89},
    }
    assert filter_metadata(metadata, now) is True


def test_filter_metadata_excludes_non_master() -> None:
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    metadata = {
        "created_at": "2026-07-01T20:00:00Z",
        "ferment": False,
        "gitlab": {"target_ref": "master-test"},
        "run_metadata": {"tasks_all": True, "selected_tasks": ["a"] * 89},
    }
    assert filter_metadata(metadata, now) is False


def test_filter_metadata_excludes_partial_run() -> None:
    now = datetime(2026, 7, 2, 6, 30, 0, tzinfo=UTC)
    metadata = {
        "created_at": "2026-07-01T20:00:00Z",
        "ferment": False,
        "gitlab": {"target_ref": "master"},
        "run_metadata": {"tasks_all": False, "selected_tasks": ["a"] * 10},
    }
    assert filter_metadata(metadata, now) is False


# --- split_by_ferment ---

def test_split_by_ferment() -> None:
    ferment_run = {"ferment": True, "gcs": {"prefix": "runs/ferment1"}}
    non_ferment_run = {"ferment": False, "gcs": {"prefix": "runs/nonferment1"}}
    runs = [ferment_run, non_ferment_run]
    ferment, non_ferment = split_by_ferment(runs)
    assert len(ferment) == 1
    assert len(non_ferment) == 1
    assert ferment[0] is ferment_run
    assert non_ferment[0] is non_ferment_run


def test_split_by_ferment_defaults_to_non_ferment() -> None:
    """When ferment key is absent, the run goes to non-ferment."""
    run = {"gcs": {"prefix": "runs/some"}}
    ferment, non_ferment = split_by_ferment([run])
    assert len(ferment) == 0
    assert len(non_ferment) == 1


# --- metadata helpers ---

def test_metadata_string_returns_value() -> None:
    assert metadata_string({"key": "value"}, "key") == "value"


def test_metadata_string_returns_default_for_missing() -> None:
    assert metadata_string({}, "key", "default") == "default"


def test_metadata_string_returns_default_for_empty() -> None:
    assert metadata_string({"key": ""}, "key", "default") == "default"


def test_metadata_dict_returns_nested_dict() -> None:
    assert metadata_dict({"outer": {"inner": 1}}, "outer") == {"inner": 1}


def test_metadata_dict_returns_empty_for_invalid() -> None:
    assert metadata_dict({"outer": "not-a-dict"}, "outer") == {}


# --- run metrics and table ---

def test_extract_run_metrics_from_summary(tmp_path: Path) -> None:
    summary = {
        "totals": {
            "tasks": {
                "expected": 89,
                "scored_pass": 42,
                "scored_fail": 30,
                "agent_timeout": 10,
                "error": 7,
                "no_verdict": 0,
            }
        }
    }
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    metadata = {"_summary_local_path": str(summary_path)}
    metrics = extract_run_metrics(metadata)
    assert metrics == {
        "available": True,
        "tasks_expected": 89,
        "scored_pass": 42,
        "scored_fail": 30,
        "agent_timeout": 10,
        "error": 7,
        "no_verdict": 0,
    }


def test_extract_run_metrics_missing_summary() -> None:
    assert extract_run_metrics({"_summary_local_path": None}) == {"available": False}


def test_extract_run_metrics_bad_summary_file(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text("not json", encoding="utf-8")
    assert extract_run_metrics({"_summary_local_path": str(summary_path)}) == {"available": False}


def test_run_label_includes_provider() -> None:
    assert run_label({"model_provider": "kimchi-dev", "model": "kimi-k2.7"}) == "kimchi-dev/kimi-k2.7"


def test_run_label_falls_back_to_model() -> None:
    assert run_label({"model": "kimi-k2.7"}) == "kimi-k2.7"


def test_run_configuration_returns_value() -> None:
    assert run_configuration({"configuration": "multi-model"}) == "multi-model"


def test_run_configuration_defaults_to_na() -> None:
    assert run_configuration({}) == "na"


def test_build_runs_table_includes_metrics_and_pipeline_link() -> None:
    runs = [
        {
            "model_provider": "kimchi-dev",
            "model": "kimi-k2.7",
            "configuration": "single-model",
            "_summary_local_path": None,
            "gitlab": {"pipeline_url": "https://gitlab.com/castai/kimchi/kimchi/-/pipelines/1"},
        }
    ]
    table = build_runs_table(runs)
    assert "Runs in scope (1)" in table
    assert "kimchi-dev/kimi-k2.7" in table
    assert "single-model" in table
    assert "metrics unavailable" in table
    assert "[pipeline](https://gitlab.com/castai/kimchi/kimchi/-/pipelines/1)" in table


def test_build_runs_table_with_available_summary(tmp_path: Path) -> None:
    summary = {
        "totals": {
            "tasks": {
                "expected": 89,
                "scored_pass": 55,
                "scored_fail": 20,
                "agent_timeout": 8,
                "error": 6,
                "no_verdict": 0,
            }
        }
    }
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")
    runs = [
        {
            "model_provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "configuration": "multi-model",
            "_summary_local_path": str(summary_path),
            "gitlab": {"pipeline_url": "https://gitlab.com/castai/kimchi/kimchi/-/pipelines/2"},
        }
    ]
    table = build_runs_table(runs)
    assert "Runs in scope (1)" in table
    assert "anthropic/claude-sonnet-4-6" in table
    assert "89 tasks · 55 pass / 20 fail / 8 timeout / 6 error" in table
    assert "[pipeline](https://gitlab.com/castai/kimchi/kimchi/-/pipelines/2)" in table


def test_build_runs_table_empty() -> None:
    assert build_runs_table([]) == "No qualifying runs."


# --- call_opus ---

class _FakeResponse:
    def __init__(self, data: dict, status: int = 200) -> None:
        self._data = data
        self.status = status

    def read(self) -> bytes:
        return json.dumps(self._data).encode()

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        pass


def test_call_opus_success() -> None:
    """call_opus returns the summary text from a successful API response."""
    fake_response = {
        "choices": [
            {"message": {"content": "Summary of findings sorted by criticality."}}
        ]
    }

    captured: dict = {}

    def fake_urlopen(req: request.Request, timeout: float = 0) -> _FakeResponse:
        captured["url"] = req.full_url
        captured["headers"] = dict(req.headers)
        captured["data"] = json.loads(req.data.decode())
        return _FakeResponse(fake_response)

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen):
        result = call_opus("test prompt", "test-key")

    assert result == "Summary of findings sorted by criticality."
    assert captured["url"] == "https://llm.kimchi.dev/openai/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["data"]["model"] == "claude-opus-4-6"


def test_call_opus_retries_on_failure() -> None:
    """call_opus retries on network errors."""
    fake_response = {"choices": [{"message": {"content": "Retried summary."}}]}

    call_count = 0

    def fake_urlopen(req: request.Request, timeout: float = 0) -> _FakeResponse:
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise error.URLError("connection refused")
        return _FakeResponse(fake_response)

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen), \
         patch("summarize_analysis.time.sleep"):
        result = call_opus("test prompt", "test-key")

    assert result == "Retried summary."
    assert call_count == 3


def test_call_opus_returns_none_after_max_retries() -> None:
    def fake_urlopen(req: request.Request, timeout: float = 0) -> None:
        raise error.URLError("connection refused")

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen), \
         patch("summarize_analysis.time.sleep"):
        result = call_opus("test prompt", "test-key")

    assert result is None


# --- post_to_discord ---

def test_post_to_discord_creates_thread_and_posts_blocks() -> None:
    """post_to_discord creates a thread and posts each content block in order."""
    captured: list[dict] = []
    call_count = 0

    def fake_urlopen(req: request.Request, timeout: float = 0) -> _FakeResponse:
        nonlocal call_count
        call_count += 1
        body = json.loads(req.data.decode())
        captured.append({
            "url": req.full_url,
            "headers": dict(req.headers),
            "body": body,
        })
        # Call 1: create thread -> returns thread channel id
        if call_count == 1:
            assert "threads" in req.full_url
            return _FakeResponse({"id": "thread-789"})
        # Calls 2-4: post blocks in thread
        if call_count in (2, 3, 4):
            assert "/channels/thread-789/messages" in req.full_url
            return _FakeResponse({"id": f"reply-{call_count:03d}"})
        return _FakeResponse({})

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen):
        result = post_to_discord(
            bot_token="test-bot-token",
            channel_id="chan-456",
            thread_name="Non-ferment runs — 2026-07-01",
            content_blocks=[
                "🔬 Non-ferment benchmark summary — 2026-07-01",
                "**Runs in scope (1)**\n\n- run-1",
                "Critical: task X failed due to agent loop.",
            ],
        )

    assert result is True
    assert call_count == 4
    # Thread created in channel
    assert captured[0]["url"] == "https://discord.com/api/v10/channels/chan-456/threads"
    assert captured[0]["headers"]["Authorization"] == "Bot test-bot-token"
    assert captured[0]["body"]["name"] == "Non-ferment runs — 2026-07-01"
    # Blocks posted in thread in order
    assert captured[1]["body"]["content"] == "🔬 Non-ferment benchmark summary — 2026-07-01"
    assert captured[2]["body"]["content"] == "**Runs in scope (1)**\n\n- run-1"
    assert captured[3]["body"]["content"] == "Critical: task X failed due to agent loop."


def test_post_to_discord_returns_false_on_thread_creation_failure() -> None:
    """If thread creation fails, post_to_discord returns False."""

    def fake_urlopen(req: request.Request, timeout: float = 0) -> None:
        raise error.URLError("connection refused")

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen):
        result = post_to_discord(
            bot_token="test-bot-token",
            channel_id="chan-456",
            thread_name="thread",
            content_blocks=["headline", "summary"],
        )

    assert result is False


def test_post_to_discord_returns_false_on_block_post_failure() -> None:
    """If any block post fails, post_to_discord returns False without posting remaining blocks."""
    call_count = 0

    def fake_urlopen(req: request.Request, timeout: float = 0) -> _FakeResponse | None:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return _FakeResponse({"id": "thread-789"})
        # Second block post fails
        if call_count == 3:
            raise error.URLError("connection refused")
        return _FakeResponse({"id": "reply"})

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen):
        result = post_to_discord(
            bot_token="test-bot-token",
            channel_id="chan-456",
            thread_name="thread",
            content_blocks=["block-1", "block-2", "block-3"],
        )

    assert result is False
    assert call_count == 3  # thread + block 1 + failed block 2
