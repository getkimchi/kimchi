#!/usr/bin/env python3
"""Tests for summarize_analysis.py."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib import error, request

import pytest

from summarize_analysis import (
    call_opus,
    compute_lookback_dates,
    filter_metadata,
    is_full_run,
    is_in_time_window,
    post_to_discord,
    split_by_ferment,
    truncate_to_2000,
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


# --- truncate_to_2000 ---

def test_truncate_to_2000_short_text() -> None:
    text = "Short summary."
    assert truncate_to_2000(text) == text


def test_truncate_to_2000_exact_boundary() -> None:
    text = "x" * 2000
    assert truncate_to_2000(text) == text


def test_truncate_to_2000_long_text() -> None:
    text = ("A. " * 600) + "x" * 2100  # Many sentence boundaries, last one near 2000
    result = truncate_to_2000(text)
    assert len(result) <= 2000
    # Should truncate at a sentence boundary after position 1000
    assert result.rstrip().endswith(".")


def test_truncate_to_2000_no_sentence_boundary() -> None:
    """When there's no sentence boundary, hard truncate at 2000."""
    text = "x" * 3000
    result = truncate_to_2000(text)
    assert len(result) == 2000


# --- call_opus ---

class _FakeResponse:
    def __init__(self, data: dict, status: int = 200) -> None:
        self._data = data
        self.status = status

    def read(self) -> bytes:
        return json.dumps(self._data).encode()

    def __enter__(self) -> "_FakeResponse":
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

def test_post_to_discord_headline_thread_and_summary() -> None:
    """post_to_discord posts headline, creates thread, then posts summary in thread."""
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
        # Call 1: post headline message -> returns message id
        if call_count == 1:
            return _FakeResponse({"id": "msg-123", "channel_id": "chan-456"})
        # Call 2: create thread from message -> returns thread channel id
        if call_count == 2:
            assert "threads" in req.full_url
            return _FakeResponse({"id": "thread-789"})
        # Call 3: post summary in thread
        if call_count == 3:
            assert "/channels/thread-789/messages" in req.full_url
            return _FakeResponse({"id": "reply-000"})
        return _FakeResponse({})

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen):
        result = post_to_discord(
            bot_token="test-bot-token",
            channel_id="chan-456",
            headline="🔬 Non-ferment benchmark summary — 2026-07-01",
            thread_name="Non-ferment runs — 2026-07-01",
            summary="Critical: task X failed due to agent loop.",
        )

    assert result is True
    assert call_count == 3
    # Headline posted to channel
    assert captured[0]["url"] == "https://discord.com/api/v10/channels/chan-456/messages"
    assert captured[0]["headers"]["Authorization"] == "Bot test-bot-token"
    assert captured[0]["body"]["content"] == "🔬 Non-ferment benchmark summary — 2026-07-01"
    # Thread created from headline message
    assert captured[1]["url"] == "https://discord.com/api/v10/channels/chan-456/messages/msg-123/threads"
    assert captured[1]["body"]["name"] == "Non-ferment runs — 2026-07-01"
    # Summary posted in thread
    assert captured[2]["url"] == "https://discord.com/api/v10/channels/thread-789/messages"
    assert captured[2]["body"]["content"] == "Critical: task X failed due to agent loop."


def test_post_to_discord_returns_false_on_headline_failure() -> None:
    """If the headline post fails, post_to_discord returns False without creating a thread."""

    def fake_urlopen(req: request.Request, timeout: float = 0) -> None:
        raise error.URLError("connection refused")

    with patch("summarize_analysis.request.urlopen", side_effect=fake_urlopen):
        result = post_to_discord(
            bot_token="test-bot-token",
            channel_id="chan-456",
            headline="headline",
            thread_name="thread",
            summary="summary",
        )

    assert result is False
