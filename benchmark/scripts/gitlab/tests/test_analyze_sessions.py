#!/usr/bin/env python3
"""Tests for analyze_sessions.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from analyze_sessions import (
    build_analysis_prompt,
    find_session_files,
    main,
    validate_analysis_html,
)

VALID_HTML = "<!doctype html><html><body>Analysis</body></html>"


def _with_argv():
    """Patch sys.argv so argparse sees only the script name during tests."""
    return patch.object(sys, "argv", ["analyze_sessions.py"])


class FakePopen:
    """Minimal Popen mock for testing run_kimchi_attempt.

    ``side_effect`` is a callable that receives the ``cmd`` list and
    decides what to do (write files, raise, etc.).  It must return a
    ``(stdout, stderr, returncode)`` tuple.
    """

    pid = 99999

    def __init__(self, cmd: list[str], side_effect=None, **kwargs: object) -> None:
        self._cmd = cmd
        self._side_effect = side_effect
        self.returncode = 0
        self._stdout = ""
        self._stderr = ""
        self._timed_out = False

    def communicate(self, timeout: float | None = None):
        if self._side_effect is not None:
            result = self._side_effect(self._cmd)
            if isinstance(result, tuple):
                self._stdout, self._stderr, self.returncode = result
            else:
                # side_effect raised an exception or returned None
                self._stdout, self._stderr, self.returncode = "", "", 0
        return self._stdout, self._stderr


def _popen_factory(side_effect):
    """Return a Popen-like callable that uses *side_effect* for each call."""
    return lambda cmd, **kw: FakePopen(cmd, side_effect=side_effect)


class TimeoutPopen(FakePopen):
    """Popen mock whose communicate() always raises TimeoutExpired."""

    def communicate(self, timeout: float | None = None):
        raise subprocess.TimeoutExpired(cmd=self._cmd, timeout=timeout or 0)


def _timeout_popen_factory():
    return lambda cmd, **kw: TimeoutPopen(cmd)


class FailPopen(FakePopen):
    """Popen mock whose returncode is always 1."""

    def __init__(self, cmd, **kwargs):
        super().__init__(cmd, side_effect=None, **kwargs)
        self.returncode = 1
        self._stdout = VALID_HTML
        self._stderr = ""


def _fail_popen_factory():
    return lambda cmd, **kw: FailPopen(cmd)


def test_find_session_files_discovers_jsonl_under_agent_sessions(tmp_path: Path) -> None:
    results_dir = tmp_path / "jobs"
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')

    found = find_session_files(results_dir)
    assert found == [session_path]


def test_find_session_files_ignores_non_agent_sessions_jsonl(tmp_path: Path) -> None:
    results_dir = tmp_path / "jobs"
    other_path = results_dir / "run-1" / "task-a__1" / "other.jsonl"
    other_path.parent.mkdir(parents=True)
    other_path.write_text('{"type": "message"}\n')

    found = find_session_files(results_dir)
    assert found == []


def test_build_analysis_prompt_treats_sessions_as_untrusted_and_requests_html_file() -> None:
    prompt = build_analysis_prompt(
        results_dir=Path("/results"),
        summary_path=Path("/results/summary.json"),
        draft_path=Path("/analysis/report.html"),
    )
    assert "/results" in prompt
    assert "/results/summary.json" in prompt
    assert "untrusted data" in prompt
    assert "/analysis/report.html" in prompt
    assert "read the HTML report back" in prompt
    assert "results_dir/<chunk-run>/<trial_name>/agent/sessions/main.jsonl" in prompt
    assert "orchestrator session" in prompt
    assert "subagent sessions" in prompt
    assert "summary.json is outside the results directory" in prompt
    assert "recurring harness failure modes" in prompt
    assert "two-phase subagent strategy" in prompt
    assert "Key Harness Issues" in prompt
    assert "Suspected layer" in prompt or "suspected layer" in prompt
    assert "confidence (high/medium/low)" in prompt
    assert "Open Questions / Follow-up Checks" in prompt
    assert "ferment plan definition" in prompt
    assert "lifecycle event stream" in prompt
    assert "llm_response_debug" in prompt
    assert "Delegation protocol" in prompt or "delegation protocol" in prompt
    assert "Phase A - Overview" in prompt
    assert "Phase B - Deep inspection" in prompt


@pytest.mark.parametrize(
    ("content", "expected_error"),
    [
        ("", "empty"),
        ("```html\n<!doctype html><html><body></body></html>\n```", "must start"),
        ("<!doctype html><html></html>", "<body>"),
        ("<!doctype html><html><body><script>alert(1)</script></body></html>", "scripts"),
        ("<!doctype html><html><body><iframe src='https://example.com'></iframe></body></html>", "resources"),
        ("<!doctype html><html><body><style>@import 'https://example.com/x.css'</style></body></html>", "resources"),
        ("<!doctype html><html><body onload='alert(1)'></body></html>", "event handlers"),
    ],
)
def test_validate_analysis_html_rejects_unsafe_or_incomplete_output(content: str, expected_error: str) -> None:
    assert expected_error in (validate_analysis_html(content) or "")


def test_validate_analysis_html_accepts_complete_script_free_document() -> None:
    assert validate_analysis_html(VALID_HTML) is None


def test_validate_analysis_html_includes_line_number_and_snippet() -> None:
    content = "<!doctype html><html><body>\n<p>Some text</p>\n<script>alert(1)</script>\n</body></html>"
    error = validate_analysis_html(content)
    assert error is not None
    assert "line 3" in error
    assert "<script>alert(1)</script>" in error


def test_validate_analysis_html_reports_first_violation() -> None:
    content = (
        "<!doctype html><html><body>\n"
        "<img src='x.png'>\n"
        "<script>alert(1)</script>\n"
        "</body></html>"
    )
    error = validate_analysis_html(content)
    assert error is not None
    assert "line 2" in error
    assert "src='x.png'" in error


def test_validate_analysis_html_is_case_insensitive() -> None:
    content = "<!doctype html><html><body>\n<SCRIPT>alert(1)</SCRIPT>\n</body></html>"
    error = validate_analysis_html(content)
    assert error is not None
    assert "scripts" in error
    assert "line 2" in error


def test_main_returns_error_when_summary_missing(tmp_path: Path) -> None:
    results_dir = tmp_path / "jobs"
    results_dir.mkdir()
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')
    summary_path = tmp_path / "missing-summary.json"
    output_path = tmp_path / "analysis.html"
    output_path.write_text("stale")

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
            },
            clear=False,
        ),
        _with_argv(),
    ):
        assert main() == 1

    assert not output_path.exists()


def test_main_returns_error_when_no_session_files(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps({"schema_version": "benchmark-summary/v2"}))
    results_dir = tmp_path / "jobs"
    results_dir.mkdir()
    output_path = tmp_path / "analysis.html"

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
            },
            clear=False,
        ),
        _with_argv(),
    ):
        assert main() == 1


def test_main_runs_kimchi_and_succeeds(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps({"schema_version": "benchmark-summary/v2"}))
    results_dir = tmp_path / "jobs"
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')
    output_path = tmp_path / "analysis.html"
    draft_path = tmp_path / "analysis-work" / "report.html"
    session_dir = tmp_path / "analysis-session"

    def side_effect(cmd: list[str]):
        prompt = cmd[2]
        assert str(results_dir) in prompt
        assert str(draft_path) in prompt
        assert cmd[cmd.index("--tools") + 1] == "read,write,edit,grep,find,ls,bash,Agent"
        assert "--no-session" not in cmd
        assert cmd[cmd.index("--session-dir") + 1] == str(session_dir)
        assert "--no-extensions" in cmd
        assert "--no-skills" in cmd
        assert "--no-context-files" in cmd
        assert cmd[cmd.index("--model") + 1] == "kimchi-dev/glm-5.2-fp8"
        draft_path.parent.mkdir(parents=True, exist_ok=True)
        draft_path.write_text(VALID_HTML)
        return "Report written", "", 0

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
                "BENCHMARK_ANALYSIS_DRAFT": str(draft_path),
                "BENCHMARK_ANALYSIS_SESSION_DIR": str(session_dir),
                "KIMCHI_CODE_BINARY": "kimchi",
                "KIMCHI_ANALYSIS_MODEL": "kimchi-dev/glm-5.2-fp8",
            },
            clear=False,
        ),
        _with_argv(),
        patch("subprocess.Popen", side_effect=_popen_factory(side_effect)),
    ):
        assert main() == 0

    assert output_path.read_text() == f"{VALID_HTML}\n"
    assert not (output_path.parent / f".{output_path.name}.tmp").exists()


def test_main_returns_error_when_kimchi_fails(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps({"schema_version": "benchmark-summary/v2"}))
    results_dir = tmp_path / "jobs"
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')
    output_path = tmp_path / "analysis.html"
    output_path.write_text("stale")
    calls: list[list[str]] = []

    def fail_popen(cmd, **kw):
        calls.append(cmd)
        return FailPopen(cmd)

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
                "KIMCHI_ANALYSIS_MAX_RETRIES": "2",
            },
            clear=False,
        ),
        _with_argv(),
        patch("subprocess.Popen", side_effect=fail_popen),
    ):
        assert main() == 1

    assert not output_path.exists()
    assert len(calls) == 3


def test_main_returns_error_and_removes_stale_output_when_kimchi_times_out(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps({"schema_version": "benchmark-summary/v2"}))
    results_dir = tmp_path / "jobs"
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')
    output_path = tmp_path / "analysis.html"
    output_path.write_text("stale")
    calls: list[list[str]] = []

    def timeout_popen(cmd, **kw):
        calls.append(cmd)
        return TimeoutPopen(cmd)

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
                "KIMCHI_ANALYSIS_MAX_RETRIES": "2",
            },
            clear=False,
        ),
        _with_argv(),
        patch("subprocess.Popen", side_effect=timeout_popen),
        patch("analyze_sessions._kill_process_group"),
    ):
        assert main() == 1

    assert not output_path.exists()
    assert len(calls) == 3
    assert "--continue" not in calls[0]
    assert all("--continue" in cmd for cmd in calls[1:])


def test_main_returns_error_for_invalid_html(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps({"schema_version": "benchmark-summary/v2"}))
    results_dir = tmp_path / "jobs"
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')
    output_path = tmp_path / "analysis.html"
    draft_path = tmp_path / "analysis-work" / "report.html"
    calls: list[list[str]] = []

    def side_effect(cmd: list[str]):
        calls.append(cmd)
        draft_path.parent.mkdir(parents=True, exist_ok=True)
        draft_path.write_text("not html")
        return "Report written", "", 0

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
                "BENCHMARK_ANALYSIS_DRAFT": str(draft_path),
                "KIMCHI_ANALYSIS_MAX_RETRIES": "2",
            },
            clear=False,
        ),
        _with_argv(),
        patch("subprocess.Popen", side_effect=_popen_factory(side_effect)),
    ):
        assert main() == 1

    assert not output_path.exists()
    assert len(calls) == 3
    assert "--continue" not in calls[0]
    assert all("--continue" in cmd for cmd in calls[1:])


def test_main_resumes_session_and_publishes_corrected_draft(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps({"schema_version": "benchmark-summary/v2"}))
    results_dir = tmp_path / "jobs"
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')
    output_path = tmp_path / "analysis.html"
    draft_path = tmp_path / "analysis-work" / "report.html"
    calls: list[list[str]] = []

    def side_effect(cmd: list[str]):
        calls.append(cmd)
        draft_path.parent.mkdir(parents=True, exist_ok=True)
        if len(calls) == 1:
            draft_path.write_text("not html")
        else:
            assert "--continue" in cmd
            retry_prompt = cmd[cmd.index("-p") + 1]
            assert "must start with <!doctype html>" in retry_prompt
            draft_path.write_text(VALID_HTML)
        return "Report updated", "", 0

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
                "BENCHMARK_ANALYSIS_DRAFT": str(draft_path),
                "BENCHMARK_ANALYSIS_SESSION_DIR": str(tmp_path / "analysis-session"),
                "KIMCHI_ANALYSIS_MAX_RETRIES": "2",
            },
            clear=False,
        ),
        _with_argv(),
        patch("subprocess.Popen", side_effect=_popen_factory(side_effect)),
    ):
        assert main() == 0

    assert len(calls) == 2
    assert output_path.read_text() == f"{VALID_HTML}\n"


def test_main_resumes_session_when_first_attempt_does_not_write_draft(tmp_path: Path) -> None:
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(json.dumps({"schema_version": "benchmark-summary/v2"}))
    results_dir = tmp_path / "jobs"
    session_path = results_dir / "run-1" / "task-a__1" / "agent" / "sessions" / "main.jsonl"
    session_path.parent.mkdir(parents=True)
    session_path.write_text('{"type": "message"}\n')
    output_path = tmp_path / "analysis.html"
    draft_path = tmp_path / "analysis-work" / "report.html"
    calls: list[list[str]] = []

    def side_effect(cmd: list[str]):
        calls.append(cmd)
        if len(calls) == 2:
            retry_prompt = cmd[cmd.index("-p") + 1]
            assert "draft was not written" in retry_prompt
            draft_path.parent.mkdir(parents=True, exist_ok=True)
            draft_path.write_text(VALID_HTML)
        return "Done", "", 0

    with (
        patch.dict(
            os.environ,
            {
                "BENCHMARK_RESULTS_DIR": str(results_dir),
                "BENCHMARK_SUMMARY_PATH": str(summary_path),
                "BENCHMARK_ANALYSIS_OUTPUT": str(output_path),
                "BENCHMARK_ANALYSIS_DRAFT": str(draft_path),
                "BENCHMARK_ANALYSIS_SESSION_DIR": str(tmp_path / "analysis-session"),
                "KIMCHI_ANALYSIS_MAX_RETRIES": "2",
            },
            clear=False,
        ),
        _with_argv(),
        patch("subprocess.Popen", side_effect=_popen_factory(side_effect)),
    ):
        assert main() == 0

    assert len(calls) == 2
    assert "--continue" in calls[1]
    assert output_path.read_text() == f"{VALID_HTML}\n"
