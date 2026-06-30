"""Unit tests for chunk_runner — classification + GCS writeback (local artifact path)."""

from __future__ import annotations

import itertools
import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from chunk_runner import _build_gcs_key_prefix, _derive_configuration, _write_run_metadata, main, process_trial_results, run_id_from_chunk_attempt


def _write_result(trial_dir: Path, payload: dict) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps(payload))


def test_run_id_format() -> None:
    rid = run_id_from_chunk_attempt(chunk_index=3, chunk_attempt=2)
    assert rid == "chunk-3-attempt-2"


def test_process_classifies_pass_and_writes_local(
    tmp_results_dir: Path,
) -> None:
    """A pass verdict writes the enriched result.json locally and returns outcome=scored_pass."""
    trial = tmp_results_dir / "run-1" / "task-a__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 1.0}}})

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-a"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
    )

    assert needs_retry == []
    # Local file overwritten with enriched version
    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "scored_pass"


def test_process_classifies_infra_and_marks_needs_retry(
    tmp_results_dir: Path,
) -> None:
    """An error/infra verdict writes the enriched file locally and appears in needs_retry."""
    trial = tmp_results_dir / "run-1" / "task-b__1"
    _write_result(
        trial,
        {
            "verifier_result": {"rewards": {"reward": 0.0}},
            "exception_info": {"exception_type": "ConnectionError"},
        },
    )

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-b"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
    )

    assert needs_retry == ["task-b"]
    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "error"
    assert enriched["error_category"] == "infra"


def test_process_marks_missing_as_needs_retry(tmp_results_dir: Path) -> None:
    """A task with no local result.json is added to needs_retry."""
    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-missing"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
    )

    assert needs_retry == ["task-missing"]


def test_process_quality_fail_no_retry(tmp_results_dir: Path) -> None:
    """A quality-fail verdict (no infra exception) is terminal: needs_retry stays empty."""
    trial = tmp_results_dir / "run-1" / "task-c__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 0.0}}})

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-c"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
    )

    assert needs_retry == []


def test_main_exits_zero_when_no_tasks_need_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If all tasks classified as final, main exits 0 without invoking Harbor."""
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
    monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a","task-b"]')
    monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCH_PARALLELISM", "1")
    monkeypatch.setenv("BENCH_ATTEMPTS", "1")
    monkeypatch.setenv("BENCH_TIMEOUT_MULTIPLIER", "1")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
    monkeypatch.setenv("KIMCHI_MULTI_MODEL", "false")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")

    # Pre-populate the workspace with both tasks done as passes
    results_dir = tmp_path / "jobs"
    for task in ["task-a__1", "task-b__1"]:
        trial = results_dir / "run-1" / task
        trial.mkdir(parents=True)
        (trial / "result.json").write_text(
            json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
        )

    # Harbor MUST NOT be invoked when nothing needs retry
    with patch("chunk_runner.run_harbor") as mock_harbor:
        exit_code = main()

    assert exit_code == 0
    mock_harbor.assert_not_called()


def test_main_invokes_harbor_for_missing_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When tasks are missing locally, main invokes Harbor on them."""
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
    monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a","task-b"]')
    monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCH_PARALLELISM", "1")
    monkeypatch.setenv("BENCH_ATTEMPTS", "1")
    monkeypatch.setenv("BENCH_TIMEOUT_MULTIPLIER", "1")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
    monkeypatch.setenv("KIMCHI_MULTI_MODEL", "false")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")

    # Pre-populate: only task-a is done. task-b is missing.
    (tmp_path / "jobs" / "run-1" / "task-a__1").mkdir(parents=True)
    (tmp_path / "jobs" / "run-1" / "task-a__1" / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )

    # Mock Harbor to write a result for task-b then exit
    def fake_harbor(*, cmd, cwd, env):
        # Simulate Harbor producing a result for the missing task
        run_dir = Path(env["BENCHMARK_RESULTS_DIR"]) / "run-2"
        trial_dir = run_dir / "task-b__1"
        trial_dir.mkdir(parents=True, exist_ok=True)
        (trial_dir / "result.json").write_text(
            json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
        )

        proc = MagicMock()
        proc.wait.return_value = 0
        return proc

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor) as mock_harbor:
        exit_code = main()

    # Harbor was invoked
    assert mock_harbor.call_count == 1
    # And the command included only the missing task
    cmd = mock_harbor.call_args.kwargs["cmd"]
    task_args = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-i"]
    assert all("task-b" in t for t in task_args), f"expected task-b in {task_args}"
    assert all("task-a" not in t for t in task_args), f"task-a should be skipped, got {task_args}"
    # Exit 0 because task-b's Harbor run succeeded
    assert exit_code == 0


def test_main_writes_chunk_meta_on_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After successful chunk run, chunk-meta.json is written with attempt=1 and exit_code=0."""
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
    monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a"]')
    monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCH_PARALLELISM", "1")
    monkeypatch.setenv("BENCH_ATTEMPTS", "1")
    monkeypatch.setenv("BENCH_TIMEOUT_MULTIPLIER", "1")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
    monkeypatch.setenv("KIMCHI_MULTI_MODEL", "false")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")

    def fake_harbor(*, cmd, cwd, env):
        run_dir = Path(env["BENCHMARK_RESULTS_DIR"]) / "run-1"
        (run_dir / "task-a__1").mkdir(parents=True)
        (run_dir / "task-a__1" / "result.json").write_text(
            json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
        )
        proc = MagicMock()
        proc.wait.return_value = 0
        return proc

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor):
        exit_code = main()

    assert exit_code == 0
    meta_path = tmp_path / "jobs" / "chunk-meta" / "chunk-0.json"
    assert meta_path.is_file()
    meta = json.loads(meta_path.read_text())
    assert meta["chunk_index"] == 0
    assert meta["chunk_attempt"] == 1
    assert meta["exit_code"] == 0
    assert meta["needs_retry"] == []


def test_main_passes_unique_job_name_per_chunk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression guard: main() must pass --job-name chunk-{index}-{CI_JOB_ID} to Harbor.

    Without this, parallel chunks that start within the same second produce
    identical Harbor job directory names (default YYYY-MM-DD__HH-MM-SS) and
    clobber each other's config.json, result.json, job.log, and lock.json.
    """
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "3")
    monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a","task-b","task-c"]')
    monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCH_PARALLELISM", "1")
    monkeypatch.setenv("BENCH_ATTEMPTS", "1")
    monkeypatch.setenv("BENCH_TIMEOUT_MULTIPLIER", "1")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
    monkeypatch.setenv("KIMCHI_MULTI_MODEL", "false")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")
    monkeypatch.setenv("CI_JOB_ID", "12345")

    def fake_harbor(*, cmd, cwd, env):
        run_dir = Path(env["BENCHMARK_RESULTS_DIR"]) / "run-1"
        (run_dir / "task-a__1").mkdir(parents=True)
        (run_dir / "task-a__1" / "result.json").write_text(
            json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
        )
        proc = MagicMock()
        proc.wait.return_value = 0
        return proc

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor) as mock_harbor:
        main()

    assert mock_harbor.call_count == 1
    cmd = mock_harbor.call_args.kwargs["cmd"]
    pairs = list(itertools.pairwise(cmd))
    assert ("--job-name", "chunk-0-12345") in pairs, (
        f"expected --job-name chunk-0-12345 in cmd; got cmd={cmd!r}"
    )


def test_main_detects_retry_via_chunk_meta(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On chunk retry, the existing chunk-meta.json is detected and chunk_attempt increments."""
    # Pre-populate the chunk-meta from a previous (failed) attempt
    meta_dir = tmp_path / "jobs" / "chunk-meta"
    meta_dir.mkdir(parents=True)
    (meta_dir / "chunk-0.json").write_text(json.dumps({
        "chunk_index": 0, "chunk_attempt": 1, "exit_code": 1,
        "needs_retry": ["task-a"],
    }))

    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
    monkeypatch.setenv("BENCH_CHUNK_COUNT", "1")
    monkeypatch.setenv("SELECTED_TASKS_JSON", '["task-a"]')
    monkeypatch.setenv("BENCHMARK_RESULTS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("BENCHMARK_GCS_BUCKET", "test-bucket")
    monkeypatch.setenv("BENCH_PARALLELISM", "1")
    monkeypatch.setenv("BENCH_ATTEMPTS", "1")
    monkeypatch.setenv("BENCH_TIMEOUT_MULTIPLIER", "1")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("KIMCHI_API_KEY", "test-key")
    monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
    monkeypatch.setenv("KIMCHI_MULTI_MODEL", "false")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")

    def fake_harbor(*, cmd, cwd, env):
        # Existing infra result still on disk from attempt 1; Harbor runs task-a again
        run_dir = Path(env["BENCHMARK_RESULTS_DIR"]) / "run-2"
        (run_dir / "task-a__1").mkdir(parents=True)
        (run_dir / "task-a__1" / "result.json").write_text(
            json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
        )
        proc = MagicMock()
        proc.wait.return_value = 0
        return proc

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor):
        exit_code = main()

    assert exit_code == 0
    meta = json.loads((meta_dir / "chunk-0.json").read_text())
    # This run was attempt 2 (since previous attempt 1's meta existed)
    assert meta["chunk_attempt"] == 2
    assert meta["needs_retry"] == []



def test_restore_prior_artifact_noop_without_ci_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Without CI env vars, _restore_prior_artifact is a no-op (local dev)."""
    from chunk_runner import _restore_prior_artifact

    for var in ("CI_JOB_TOKEN", "CI_PROJECT_ID", "CI_PIPELINE_ID", "CI_JOB_ID", "CI_JOB_NAME"):
        monkeypatch.delenv(var, raising=False)

    assert _restore_prior_artifact(tmp_path, workspace=tmp_path) is False
    assert not any(tmp_path.iterdir())


def test_restore_prior_artifact_matches_only_same_chunk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Critical: must NOT restore a prior attempt of a DIFFERENT chunk index.

    If chunk-2 is retrying but only chunk-0 has a prior attempt in the pipeline,
    the function must skip (return False) — not restore chunk-0's artifact.
    """
    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", "terminal-bench-2-chunks: [2]")
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "2")  # we're chunk 2

    class FakeResp:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self) -> bytes:
            return self.data

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(req, timeout=None):
        # Prior attempts exist, but ALL for other chunks (0, 1, 3, 4, ...).
        # Chunk 2 has no prior attempt.
        return FakeResp(
            json.dumps([
                {"id": 200, "name": "terminal-bench-2-chunks: [2]"},  # current
                {"id": 150, "name": "terminal-bench-2-chunks: [0]"},
                {"id": 151, "name": "terminal-bench-2-chunks: [1]"},
                {"id": 153, "name": "terminal-bench-2-chunks: [3]"},
            ]).encode("utf-8")
        )

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        restored = _restore_prior_artifact(tmp_path, workspace=tmp_path)
    assert restored is False
    assert not any(tmp_path.iterdir())


def test_restore_prior_artifact_skips_when_chunk_meta_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If chunk-meta is already in the workspace, skip the API call (already restored)."""
    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", "terminal-bench-2-chunks: [0]")
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")
    (tmp_path / "chunk-meta").mkdir()
    (tmp_path / "chunk-meta" / "chunk-0.json").write_text("{}")

    # Should return False without making any HTTP call
    with patch("urllib.request.urlopen") as mock_urlopen:
        assert _restore_prior_artifact(tmp_path, workspace=tmp_path) is False
        mock_urlopen.assert_not_called()


def test_restore_prior_artifact_downloads_and_extracts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: API lists prior attempt → download archive → extract to workspace."""
    import io
    import zipfile as zf

    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", "terminal-bench-2-chunks: [0]")
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")

    # Build a fake archive that mirrors the chunk artifact layout.
    archive_buf = io.BytesIO()
    with zf.ZipFile(archive_buf, "w") as z:
        z.writestr("benchmark/terminal-bench-2/jobs/chunk-meta/chunk-0.json", '{"chunk_attempt": 1}')
        z.writestr("benchmark/terminal-bench-2/jobs/run-1/task-a__1/result.json", '{"verifier_result": {"rewards": {"reward": 1.0}}}')  # noqa: E501
    archive_bytes = archive_buf.getvalue()

    class FakeResp:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self) -> bytes:
            return self.data

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    list_call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        list_call_count["n"] += 1
        if list_call_count["n"] == 1:
            # First call: list jobs in pipeline (matrix-expanded names from API).
            return FakeResp(
                json.dumps([
                    {"id": 200, "name": "terminal-bench-2-chunks: [0]"},  # current attempt (chunk 0)
                    {"id": 150, "name": "terminal-bench-2-chunks: [0]"},  # prior attempt (chunk 0) ← match
                    {"id": 151, "name": "terminal-bench-2-chunks: [1]"},  # other chunk — must NOT match
                    {"id": 152, "name": "terminal-bench-2-chunks: [2]"},  # other chunk — must NOT match
                ]).encode("utf-8")
            )
        # Second call: download prior artifact
        return FakeResp(archive_bytes)

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        restored = _restore_prior_artifact(tmp_path, workspace=tmp_path)

    assert restored is True
    meta_file = tmp_path / "benchmark" / "terminal-bench-2" / "jobs" / "chunk-meta" / "chunk-0.json"
    assert meta_file.is_file()
    assert json.loads(meta_file.read_text()) == {"chunk_attempt": 1}
    result_file = tmp_path / "benchmark" / "terminal-bench-2" / "jobs" / "run-1" / "task-a__1" / "result.json"
    assert result_file.is_file()


def test_restore_prior_artifact_returns_false_when_api_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the API call fails, return False and proceed normally (don't crash the chunk)."""
    import urllib.error

    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", "terminal-bench-2-chunks: [0]")
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")

    def fake_urlopen(req, timeout=None):
        raise urllib.error.URLError("simulated network error")

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        assert _restore_prior_artifact(tmp_path, workspace=tmp_path) is False
    # Empty workspace — chunk will proceed as if first attempt
    assert not any(tmp_path.iterdir())


def test_restore_prior_artifact_returns_false_when_no_prior_attempts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the pipeline has no prior attempts of this job, return False (first attempt)."""
    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", "terminal-bench-2-chunks: [0]")
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")

    class FakeResp:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self) -> bytes:
            return self.data

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(req, timeout=None):
        # Only the current job exists, no prior
        return FakeResp(json.dumps([{"id": 200, "name": "terminal-bench-2-chunks: [0]"}]).encode("utf-8"))

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        assert _restore_prior_artifact(tmp_path, workspace=tmp_path) is False


def test_restore_prior_artifact_blocks_zip_slip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Paths in the archive that escape the workspace must be skipped, not extracted."""
    import io
    import zipfile as zf

    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", "terminal-bench-2-chunks: [0]")
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")

    archive_buf = io.BytesIO()
    with zf.ZipFile(archive_buf, "w") as z:
        z.writestr("../../etc/evil.conf", "pwned")
        z.writestr("benchmark/terminal-bench-2/jobs/legit.txt", "ok")
    archive_bytes = archive_buf.getvalue()

    class FakeResp:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self) -> bytes:
            return self.data

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return FakeResp(json.dumps([{"id": 150, "name": "terminal-bench-2-chunks: [0]"}]).encode("utf-8"))
        return FakeResp(archive_bytes)

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        restored = _restore_prior_artifact(tmp_path, workspace=tmp_path)

    assert restored is True
    # Legit file extracted
    assert (tmp_path / "benchmark" / "terminal-bench-2" / "jobs" / "legit.txt").is_file()
    # Zip-slip path not extracted anywhere inside or outside tmp_path
    assert not (tmp_path / "etc" / "evil.conf").exists()
    assert not (tmp_path.parent / "evil.conf").exists()


def test_restore_prior_artifact_uses_include_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: the GitLab API hides prior attempts unless include_retried=true.

    Without that query parameter, /pipelines/:id/jobs returns only the most
    recent attempt of each matrix child — the very prior attempts we need to
    restore. Verify the URL is constructed with the parameter so we catch a
    future refactor that drops it.
    """
    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", "terminal-bench-2-chunks: [0]")
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")

    seen_urls: list[str] = []

    class FakeResp:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self) -> bytes:
            return self.data

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(req, timeout=None):
        seen_urls.append(req.full_url)
        return FakeResp(json.dumps([]).encode("utf-8"))

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        _restore_prior_artifact(tmp_path, workspace=tmp_path)

    assert len(seen_urls) == 1, f"expected 1 API call, got {len(seen_urls)}: {seen_urls}"
    assert "include_retried=true" in seen_urls[0], (
        f"URL must include include_retried=true to surface prior attempts; got {seen_urls[0]}"
    )


# ---------------------------------------------------------------------------
# _derive_configuration
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "env,expected",
    [
        # non-kimchi agents always get "default"
        ({"CODING_AGENT": "claude-code", "KIMCHI_MULTI_MODEL": "true", "KIMCHI_FERMENT_ONESHOT": "false"}, "default"),
        ({"CODING_AGENT": "opencode"}, "default"),
        # kimchi + multi-model combinations
        ({"CODING_AGENT": "kimchi", "KIMCHI_MULTI_MODEL": "true", "KIMCHI_FERMENT_ONESHOT": "false"}, "multi-mode"),
        ({"CODING_AGENT": "kimchi", "KIMCHI_MULTI_MODEL": "true", "KIMCHI_FERMENT_ONESHOT": "true"}, "multi-mode-ferment"),  # noqa: E501
        ({"CODING_AGENT": "kimchi", "KIMCHI_MULTI_MODEL": "false", "KIMCHI_FERMENT_ONESHOT": "false"}, "single-model"),
        ({"CODING_AGENT": "kimchi", "KIMCHI_MULTI_MODEL": "false", "KIMCHI_FERMENT_ONESHOT": "true"}, "single-model-ferment"),  # noqa: E501
        # defaults: CODING_AGENT=kimchi, KIMCHI_MULTI_MODEL=true → multi-mode
        ({}, "multi-mode"),
    ],
)
def test_derive_configuration(env: dict, expected: str, monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("CODING_AGENT", "KIMCHI_MULTI_MODEL", "KIMCHI_FERMENT_ONESHOT"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert _derive_configuration() == expected


# ---------------------------------------------------------------------------
# tasks_all / BENCH_TASKS_ALL
# ---------------------------------------------------------------------------

def _main_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    """Set the minimal env vars required to call main(), with optional overrides."""
    defaults = {
        "BENCH_CHUNK_INDEX": "0",
        "BENCH_CHUNK_COUNT": "1",
        "SELECTED_TASKS_JSON": '["task-a"]',
        "BENCHMARK_RESULTS_DIR": str(tmp_path / "jobs"),
        "BENCHMARK_GCS_BUCKET": "test-bucket",
        "BENCH_PARALLELISM": "1",
        "BENCH_ATTEMPTS": "1",
        "BENCH_TIMEOUT_MULTIPLIER": "1",
        "CODING_AGENT": "kimchi",
        "MODEL": "kimchi-dev/kimi-k2.6",
        "KIMCHI_API_KEY": "test-key",
        "DATASET": "terminal-bench/terminal-bench-2",
        "KIMCHI_MULTI_MODEL": "false",
        "KIMCHI_FERMENT_ONESHOT": "false",
    }
    for key, val in {**defaults, **overrides}.items():
        monkeypatch.setenv(key, val)


def test_tasks_all_fetches_all_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """BENCH_TASKS_ALL=true calls _fetch_all_tasks regardless of SELECTED_TASKS_JSON."""
    _main_env(tmp_path, monkeypatch, BENCH_TASKS_ALL="true", SELECTED_TASKS_JSON='["task-a"]')

    all_tasks = ["task-x", "task-y"]
    results_dir = tmp_path / "jobs"
    for task in ["task-x__1", "task-y__1"]:
        trial = results_dir / "run-1" / task
        trial.mkdir(parents=True)
        (trial / "result.json").write_text(
            json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
        )

    with patch("chunk_runner._fetch_all_tasks", return_value=all_tasks) as mock_fetch, \
         patch("chunk_runner.run_harbor"):
        main()

    mock_fetch.assert_called_once()


def test_tasks_all_false_uses_selected_tasks_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """BENCH_TASKS_ALL=false (or unset) uses SELECTED_TASKS_JSON, not _fetch_all_tasks."""
    _main_env(tmp_path, monkeypatch, BENCH_TASKS_ALL="false", SELECTED_TASKS_JSON='["task-a"]')

    results_dir = tmp_path / "jobs"
    trial = results_dir / "run-1" / "task-a__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )

    with patch("chunk_runner._fetch_all_tasks") as mock_fetch, \
         patch("chunk_runner.run_harbor"):
        main()

    mock_fetch.assert_not_called()


# GCS key prefix
# ---------------------------------------------------------------------------


# Pinned UTC date so the test is stable across midnight boundaries.
_FROZEN_GMTIME = time.struct_time((2026, 6, 22, 12, 0, 0, 0, 173, 0))


def test_build_gcs_key_prefix_is_pipeline_level(monkeypatch: pytest.MonkeyPatch) -> None:
    """The GCS prefix identifies the benchmark run, not the chunk job.

    Two chunks in the same pipeline produce the same prefix; two pipelines
    produce different prefixes. Consumers use this prefix to locate
    jobs.tar.gz + per-trial result.json files.
    """
    pipeline_a = {
        "BENCHMARK_NAME": "terminal-bench-2",
        "CODING_AGENT": "kimchi",
        "MODEL": "anthropic/claude-sonnet-4-20250514",
        "KIMCHI_MULTI_MODEL": "true",
        "KIMCHI_FERMENT_ONESHOT": "false",
        "CI_COMMIT_REF_NAME": "benchmarks",
        "CI_COMMIT_SHA": "abc1234567890abcdef1234567890abcdef12345",
        "CI_PIPELINE_ID": "1001",
        "CI_JOB_ID": "9001",
    }
    pipeline_b = {**pipeline_a, "CI_PIPELINE_ID": "1002"}

    # Wipe vars the function consults so the dict above is the full env.
    for key in (
        "BENCHMARK_NAME",
        "CODING_AGENT",
        "MODEL",
        "KIMCHI_MULTI_MODEL",
        "KIMCHI_FERMENT_ONESHOT",
        "CI_COMMIT_REF_NAME",
        "CI_COMMIT_SHA",
        "CI_PIPELINE_ID",
        "CI_JOB_ID",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr("chunk_runner.time.gmtime", lambda: _FROZEN_GMTIME)

    for key, value in pipeline_a.items():
        monkeypatch.setenv(key, value)
    prefix_chunk_0 = _build_gcs_key_prefix()

    monkeypatch.setenv("CI_JOB_ID", "9002")
    prefix_chunk_1 = _build_gcs_key_prefix()

    monkeypatch.setenv("CI_PIPELINE_ID", "1002")
    monkeypatch.delenv("CI_JOB_ID")
    prefix_pipeline_b = _build_gcs_key_prefix()

    assert prefix_chunk_0 == prefix_chunk_1, (
        "Two chunks in the same pipeline must share the same GCS prefix; "
        f"got {prefix_chunk_0!r} vs {prefix_chunk_1!r}"
    )
    assert prefix_chunk_0 != prefix_pipeline_b, (
        "Different pipelines must produce different prefixes"
    )
    # Regression guard: the old code embedded CI_JOB_ID in the run= segment.
    assert "j9001" not in prefix_chunk_0, (
        f"GCS prefix must not embed CI_JOB_ID; got {prefix_chunk_0!r}"
    )
    assert "j9002" not in prefix_chunk_1, (
        f"GCS prefix must not embed CI_JOB_ID; got {prefix_chunk_1!r}"
    )


def test_write_run_metadata_is_pipeline_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_write_run_metadata writes a file with gcs.run_id == pipeline-level and
    gitlab.job_id == per-chunk CI_JOB_ID.

    Regression guard: a previous edit removed the `job_id` local from this
    function but left a downstream reference in the gitlab dict, raising
    NameError in production. This test exercises the full function and
    asserts both fields are populated correctly.
    """
    metadata_path = tmp_path / "run-metadata.json"
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(metadata_path))
    monkeypatch.setenv("BENCHMARK_NAME", "terminal-bench-2")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "anthropic/claude-sonnet-4-20250514")
    monkeypatch.setenv("KIMCHI_MULTI_MODEL", "true")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")
    monkeypatch.setenv("CI_COMMIT_REF_NAME", "benchmarks")
    monkeypatch.setenv("CI_COMMIT_SHA", "abc1234567890abcdef1234567890abcdef12345")
    monkeypatch.setenv("CI_PIPELINE_ID", "1001")
    monkeypatch.setenv("CI_JOB_ID", "9002")
    monkeypatch.setattr("chunk_runner.time.gmtime", lambda: _FROZEN_GMTIME)

    _write_run_metadata(tmp_path, ["task-a", "task-b"])

    assert metadata_path.is_file()
    metadata = json.loads(metadata_path.read_text())
    assert metadata["gcs"]["run_id"] == "gitlab-p1001"
    assert "j9002" not in metadata["gcs"]["run_id"]
    # gcs.prefix is also pipeline-level and must agree with gcs.run_id.
    assert metadata["gcs"]["prefix"].endswith(f"/run={metadata['gcs']['run_id']}")
    # gitlab.job_id is intentionally the per-chunk CI_JOB_ID — used for
    # traceability, not for the GCS prefix.
    assert metadata["gitlab"]["job_id"] == "9002"
    assert metadata["gitlab"]["pipeline_id"] == "1001"


def test_build_gcs_key_prefix_uses_benchmark_name_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The GCS prefix honors BENCHMARK_NAME so 2.0 runs stay separate from 2.1.

    With BENCHMARK_NAME=terminal-bench-2 the prefix is scoped to the 2.0
    benchmark; with BENCHMARK_NAME unset, the 2.1 default (terminal-bench-2-1)
    is used. This keeps per-trial result.json uploads from the two dataset
    versions from colliding under the same GCS prefix.
    """
    minimal_env = {
        "CODING_AGENT": "kimchi",
        "MODEL": "kimchi-dev/kimi-k2.6",
        "KIMCHI_MULTI_MODEL": "false",
        "KIMCHI_FERMENT_ONESHOT": "false",
        "CI_COMMIT_REF_NAME": "benchmarks",
        "CI_COMMIT_SHA": "abc1234567890abcdef1234567890abcdef12345",
        "CI_PIPELINE_ID": "1001",
    }
    # Mirror test_build_gcs_key_prefix_is_pipeline_level: wipe the vars the
    # function consults so `minimal_env` is the full env, then freeze time.
    for key in (
        "BENCHMARK_NAME",
        "CODING_AGENT",
        "MODEL",
        "KIMCHI_MULTI_MODEL",
        "KIMCHI_FERMENT_ONESHOT",
        "CI_COMMIT_REF_NAME",
        "CI_COMMIT_SHA",
        "CI_PIPELINE_ID",
        "CI_JOB_ID",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr("chunk_runner.time.gmtime", lambda: _FROZEN_GMTIME)
    for key, value in minimal_env.items():
        monkeypatch.setenv(key, value)
    # CI_JOB_ID intentionally absent: the prefix is pipeline-level, not job-level.
    monkeypatch.delenv("CI_JOB_ID", raising=False)

    # 2.0 benchmark: prefix scoped to terminal-bench-2.
    monkeypatch.setenv("BENCHMARK_NAME", "terminal-bench-2")
    prefix_2_0 = _build_gcs_key_prefix()
    assert prefix_2_0.startswith("runs/benchmark=terminal-bench-2/"), prefix_2_0

    # 2.1 default: BENCHMARK_NAME unset → terminal-bench-2-1.
    monkeypatch.delenv("BENCHMARK_NAME")
    prefix_default = _build_gcs_key_prefix()
    assert prefix_default.startswith("runs/benchmark=terminal-bench-2-1/"), prefix_default


@pytest.mark.parametrize(
    ("current_job_name", "prior_job_names"),
    [
        # 2.1 current job: 2.0 prior attempts must NOT match.
        (
            "terminal-bench-2-1-chunks: [0]",
            ["terminal-bench-2-chunks: [0]", "terminal-bench-2-chunks: [1]"],
        ),
        # 2.0 current job: 2.1 prior attempts must NOT match (vice versa).
        (
            "terminal-bench-2-chunks: [0]",
            ["terminal-bench-2-1-chunks: [0]", "terminal-bench-2-1-chunks: [1]"],
        ),
    ],
)
def test_restore_prior_artifact_does_not_collide_across_dataset_versions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    current_job_name: str,
    prior_job_names: list[str],
) -> None:
    """A 2.1 chunk job must NOT restore a 2.0 chunk's prior attempt (and vice versa).

    The base job name differs across dataset versions
    (terminal-bench-2-1-chunks vs terminal-bench-2-chunks), so the base-name
    matcher in _restore_prior_artifact must reject prior attempts from the
    other version. Otherwise a retry of a 2.1 chunk could silently pull in
    2.0 trial results, or vice versa.
    """
    from chunk_runner import _restore_prior_artifact

    monkeypatch.setenv("CI_JOB_TOKEN", "tok")
    monkeypatch.setenv("CI_PROJECT_ID", "1")
    monkeypatch.setenv("CI_PIPELINE_ID", "100")
    monkeypatch.setenv("CI_JOB_ID", "200")
    monkeypatch.setenv("CI_JOB_NAME", current_job_name)
    monkeypatch.setenv("BENCH_CHUNK_INDEX", "0")  # current job is a chunk

    class FakeResp:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self) -> bytes:
            return self.data

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(req, timeout=None):
        # Prior attempts exist, but ALL carry the OTHER version's base name.
        jobs = [{"id": 200, "name": current_job_name}]  # current attempt
        for offset, name in enumerate(prior_job_names, start=1):
            jobs.append({"id": 200 - offset, "name": name})
        return FakeResp(json.dumps(jobs).encode("utf-8"))

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        restored = _restore_prior_artifact(tmp_path, workspace=tmp_path)

    assert restored is False
    assert not any(tmp_path.iterdir())
