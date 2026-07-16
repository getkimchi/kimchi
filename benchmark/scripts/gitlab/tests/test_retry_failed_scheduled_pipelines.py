"""Tests for retry_failed_scheduled_pipelines.py."""

from __future__ import annotations

import json
from io import BytesIO
from unittest.mock import MagicMock, patch
from urllib import error, request

import pytest

import retry_failed_scheduled_pipelines as m


def _resp(data: object) -> BytesIO:
    return BytesIO(json.dumps(data).encode())


@pytest.fixture
def urlopen(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    mock = MagicMock()
    monkeypatch.setattr(request, "urlopen", mock)
    return mock


@pytest.mark.parametrize(
    ("active", "tag", "tasks_all", "expected"),
    [
        (True, "daily-tb2", True, True),
        (False, "daily-tb2", True, False),
        (True, "adhoc", True, False),
        (True, "daily-tb2", False, False),
        (True, "daily-tb2", "true", False),
    ],
)
def test_is_daily_tb2(active: bool, tag: str, tasks_all: object, expected: bool) -> None:
    s = {
        "active": active,
        "inputs": [
            {"name": "benchmark_tag", "value": tag},
            {"name": "tasks_all", "value": tasks_all},
        ],
    }
    assert m._is_daily_tb2(s) is expected


@pytest.mark.parametrize(
    ("description", "expected"),
    [
        ("Daily TB2 - single-model - minimax-m3", True),
        ("Daily TB2 - multi-mode-ferment - default model", True),
        ("Harness benchmark - kimchi - claude-opus-4-6 (slot 1)", False),
        ("", False),
    ],
)
def test_is_daily_tb2_fallback_no_inputs(description: str, expected: bool) -> None:
    # Developer role can't see schedule inputs — fall back to description prefix.
    s = {"active": True, "description": description, "inputs": []}
    assert m._is_daily_tb2(s) is expected


def test_api_get(urlopen: MagicMock) -> None:
    urlopen.return_value = _resp([{"id": 1}])
    result = m._api("https://gitlab.com/api/v4", "tok", "proj", "GET", "pipeline_schedules?per_page=100&scope=active")
    assert result == [{"id": 1}]
    req = urlopen.call_args[0][0]
    assert req.get_full_url() == "https://gitlab.com/api/v4/projects/proj/pipeline_schedules?per_page=100&scope=active"
    assert req.get_header("Private-token") == "tok"


def test_api_post(urlopen: MagicMock) -> None:
    urlopen.return_value = _resp({"id": 42, "status": "pending"})
    result = m._api("https://gitlab.com/api/v4", "tok", "proj", "POST", "pipelines/42/retry")
    assert result == {"id": 42, "status": "pending"}
    req = urlopen.call_args[0][0]
    assert req.method == "POST"


def test_api_http_error(urlopen: MagicMock) -> None:
    urlopen.side_effect = error.HTTPError("url", 401, "Unauthorized", {}, BytesIO(b'{"message":"bad"}'))
    with pytest.raises(RuntimeError, match="401"):
        m._api("https://gitlab.com/api/v4", "tok", "proj", "GET", "pipeline_schedules")


def _schedule(sid: int, status: str | None = "failed") -> tuple[dict, dict | None]:
    s = {
        "id": sid, "description": f"S{sid}", "active": True,
        "inputs": [
            {"name": "benchmark_tag", "value": "daily-tb2"},
            {"name": "tasks_all", "value": True},
        ],
    }
    p = (
        None if status is None
        else {"id": sid * 1000, "status": status, "web_url": f"https://gitlab.com/p/{sid * 1000}"}
    )
    return s, p


@patch("retry_failed_scheduled_pipelines.request.urlopen")
@patch("retry_failed_scheduled_pipelines.open", create=True)
def test_main_retries_failed(mock_open: MagicMock, mock_urlopen: MagicMock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CI_PROJECT_PATH", "castai/kimchi/kimchi")
    monkeypatch.setenv("GITLAB_TOKEN", "tok")

    s1, p1 = _schedule(1, "failed")
    s2, p2 = _schedule(2, "success")
    mock_urlopen.side_effect = [
        _resp([s1, s2]),  # 1. list schedules
        _resp([p1]),       # 2. latest for s1
        _resp({"id": p1["id"], "status": "pending"}),  # 3. retry s1 (POST)
        _resp([p2]),       # 4. latest for s2
    ]

    assert m.main() == 0
    # The 3rd API call (index 2) is the retry POST for s1
    assert mock_urlopen.call_args_list[2][0][0].method == "POST"


@patch("retry_failed_scheduled_pipelines.request.urlopen")
@patch("retry_failed_scheduled_pipelines.open", create=True)
def test_main_dry_run(mock_open: MagicMock, mock_urlopen: MagicMock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CI_PROJECT_PATH", "castai/kimchi/kimchi")
    monkeypatch.setenv("GITLAB_TOKEN", "tok")
    monkeypatch.setenv("TB21_RETRY_DRY_RUN", "true")

    s1, p1 = _schedule(1, "failed")
    mock_urlopen.side_effect = [_resp([s1]), _resp([p1])]
    assert m.main() == 0
    assert all(c[0][0].method == "GET" for c in mock_urlopen.call_args_list)


@patch("retry_failed_scheduled_pipelines.request.urlopen")
@patch("retry_failed_scheduled_pipelines.open", create=True)
def test_main_skips_non_daily(mock_open: MagicMock, mock_urlopen: MagicMock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CI_PROJECT_PATH", "castai/kimchi/kimchi")
    monkeypatch.setenv("GITLAB_TOKEN", "tok")
    monkeypatch.setenv("TB21_RETRY_DRY_RUN", "true")

    daily, p_daily = _schedule(1, "failed")
    adhoc = {"id": 2, "active": True, "inputs": [{"name": "benchmark_tag", "value": "adhoc"}]}
    mock_urlopen.side_effect = [_resp([daily, adhoc]), _resp([p_daily])]
    assert m.main() == 0
    assert len(mock_urlopen.call_args_list) == 2  # list + 1 latest (adhoc skipped)


@patch("retry_failed_scheduled_pipelines.request.urlopen")
@patch("retry_failed_scheduled_pipelines.open", create=True)
def test_main_no_pipelines(mock_open: MagicMock, mock_urlopen: MagicMock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CI_PROJECT_PATH", "castai/kimchi/kimchi")
    monkeypatch.setenv("GITLAB_TOKEN", "tok")

    s1, _ = _schedule(1, None)
    mock_urlopen.side_effect = [_resp([s1]), _resp([])]
    assert m.main() == 0


def test_main_missing_project(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CI_PROJECT_ID", raising=False)
    monkeypatch.delenv("CI_PROJECT_PATH", raising=False)
    with pytest.raises(SystemExit, match="CI_PROJECT_ID"):
        m.main()


def test_main_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CI_PROJECT_PATH", "proj")
    monkeypatch.delenv("GITLAB_TOKEN", raising=False)
    with pytest.raises(SystemExit, match="GITLAB_TOKEN must be set"):
        m.main()
