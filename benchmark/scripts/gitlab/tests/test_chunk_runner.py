"""Unit tests for chunk_runner — classification + GCS writeback (local artifact path)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from chunk_runner import _derive_configuration, main, process_trial_results, run_id_from_chunk_attempt


def _write_result(trial_dir: Path, payload: dict) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps(payload))


def test_run_id_format() -> None:
    rid = run_id_from_chunk_attempt(chunk_index=3, chunk_attempt=2)
    assert rid == "chunk-3-attempt-2"


def test_process_classifies_pass_and_writes_local_and_gcs(
    tmp_results_dir: Path,
) -> None:
    """A pass verdict writes to local and GCS, returns outcome=scored_pass."""
    trial = tmp_results_dir / "run-1" / "task-a__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 1.0}}})

    gcs = MagicMock()

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-a"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
        gcs_uploader=gcs,
    )

    assert needs_retry == []
    # Local file overwritten with enriched version
    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "scored_pass"
    # GCS upload called once with the trial dir name as key
    assert gcs.upload.call_count == 1
    assert gcs.upload.call_args.args[1] == "task-a__1"


def test_process_classifies_infra_and_skips_gcs_upload(
    tmp_results_dir: Path,
) -> None:
    """An error/infra verdict writes local enriched file but does NOT upload to GCS, returns in needs_retry."""
    trial = tmp_results_dir / "run-1" / "task-b__1"
    _write_result(
        trial,
        {
            "verifier_result": {"rewards": {"reward": 0.0}},
            "exception_info": {"exception_type": "ConnectionError"},
        },
    )

    gcs = MagicMock()

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-b"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
        gcs_uploader=gcs,
    )

    assert needs_retry == ["task-b"]
    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "error"
    assert enriched["error_category"] == "infra"
    # GCS upload NOT called for error/infra verdicts on non-final attempts
    gcs.upload.assert_not_called()


def test_process_uploads_infra_verdict_on_final_attempt(
    tmp_results_dir: Path,
) -> None:
    """On the final attempt, infra verdicts ARE uploaded to GCS so they remain visible."""
    trial = tmp_results_dir / "run-1" / "task-b__1"
    _write_result(
        trial,
        {
            "verifier_result": {"rewards": {"reward": 0.0}},
            "exception_info": {"exception_type": "ConnectionError"},
        },
    )

    gcs = MagicMock()
    gcs.upload.return_value = True

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-b"],
        chunk_attempt=3,
        run_id="chunk-0-attempt-3",
        gcs_uploader=gcs,
        is_final_attempt=True,
    )

    assert needs_retry == ["task-b"]
    # GCS upload IS called for infra verdict on final attempt
    assert gcs.upload.call_count == 1
    assert gcs.upload.call_args.args[1] == "task-b__1"


def test_process_marks_missing_as_needs_retry(tmp_results_dir: Path) -> None:
    """A task with no local result.json is added to needs_retry."""
    gcs = MagicMock()

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-missing"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
        gcs_uploader=gcs,
    )

    assert needs_retry == ["task-missing"]
    gcs.upload.assert_not_called()


def test_process_quality_fail_writes_to_gcs(tmp_results_dir: Path) -> None:
    """A quality-fail verdict (no infra exception) uploads to GCS as final."""
    trial = tmp_results_dir / "run-1" / "task-c__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 0.0}}})

    gcs = MagicMock()

    needs_retry = process_trial_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-c"],
        chunk_attempt=1,
        run_id="chunk-0-attempt-1",
        gcs_uploader=gcs,
    )

    assert needs_retry == []
    gcs.upload.assert_called_once()


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
    with patch("chunk_runner.run_harbor") as mock_harbor, \
         patch("chunk_runner._make_gcs_uploader", return_value=MagicMock()):
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

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor) as mock_harbor, \
         patch("chunk_runner._make_gcs_uploader", return_value=MagicMock()):
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

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor), \
         patch("chunk_runner._make_gcs_uploader", return_value=MagicMock()):
        exit_code = main()

    assert exit_code == 0
    meta_path = tmp_path / "jobs" / "chunk-meta" / "chunk-0.json"
    assert meta_path.is_file()
    meta = json.loads(meta_path.read_text())
    assert meta["chunk_index"] == 0
    assert meta["chunk_attempt"] == 1
    assert meta["exit_code"] == 0
    assert meta["needs_retry"] == []


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

    with patch("chunk_runner.run_harbor", side_effect=fake_harbor), \
         patch("chunk_runner._make_gcs_uploader", return_value=MagicMock()):
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
