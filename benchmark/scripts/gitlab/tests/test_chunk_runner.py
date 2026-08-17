"""Unit tests for chunk_runner — classification + GCS writeback (local artifact path)."""

from __future__ import annotations

import itertools
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from chunk_runner import (
    _agent_import_path,
    _all_trial_dirs_for_task,
    _build_gcs_key_prefix,
    _collect_docker_health,
    _compaction_disabled,
    _derive_configuration,
    _fetch_all_tasks,
    _selected_workflow,
    _selected_workflow_extension,
    _task_name_from_result,
    _write_chunk_meta,
    _write_run_metadata,
    main,
    run_id_from_chunk_attempt,
    write_enriched_results,
)
from outcome import Outcome

_BENCH_SCRIPTS_DIR = Path(__file__).parent.parent


def test_write_chunk_meta_includes_docker_health(tmp_path: Path) -> None:
    """chunk-meta folds in retry/pre-warm counters when their files exist."""
    results_dir = tmp_path / "jobs"
    results_dir.mkdir()
    # Files are chunk-namespaced; meta for chunk 0 must ignore chunk 1's files.
    (results_dir / "docker-retry-health-chunk-0.json").write_text(
        json.dumps({"retry_engagements": 7, "retry_recoveries": 6, "retry_exhausted": 1})
    )
    (results_dir / "pre-warm-result-chunk-0.json").write_text(
        json.dumps({"pulled": 28, "failed": 2, "images_total": 30})
    )
    (results_dir / "pre-warm-result-chunk-1.json").write_text(
        json.dumps({"pulled": 999, "failed": 0, "images_total": 999})
    )

    meta_path = _write_chunk_meta(
        results_dir=results_dir, chunk_index=0, chunk_attempt=1,
        chunk_attempt_budget=8, exit_code=0, needs_retry=[],
    )

    meta = json.loads(meta_path.read_text())
    assert meta["docker_health"]["retry"]["retry_recoveries"] == 6
    assert meta["docker_health"]["prewarm"]["pulled"] == 28


def test_write_chunk_meta_omits_docker_health_without_files(tmp_path: Path) -> None:
    """No health files → no docker_health key (clean meta for non-docker paths)."""
    results_dir = tmp_path / "jobs"
    results_dir.mkdir()

    meta_path = _write_chunk_meta(
        results_dir=results_dir, chunk_index=0, chunk_attempt=1,
        chunk_attempt_budget=8, exit_code=0, needs_retry=[],
    )

    meta = json.loads(meta_path.read_text())
    assert "docker_health" not in meta


def test_collect_docker_health_skips_corrupt_files(tmp_path: Path) -> None:
    results_dir = tmp_path / "jobs"
    results_dir.mkdir()
    (results_dir / "docker-retry-health-chunk-0.json").write_text("not json{")
    (results_dir / "pre-warm-result-chunk-0.json").write_text(json.dumps({"pulled": 1, "failed": 0}))

    health = _collect_docker_health(results_dir, 0)

    assert "retry" not in health
    assert health["prewarm"]["pulled"] == 1


def test_fetch_all_tasks_reads_terminal_bench_from_file() -> None:
    """_fetch_all_tasks reads terminal-bench tasks from the static JSON file."""
    tasks = _fetch_all_tasks("terminal-bench/terminal-bench-2-1", bench_dir=_BENCH_SCRIPTS_DIR)

    assert "adaptive-rejection-sampler" in tasks
    assert "fix-git" in tasks
    assert "install-windows-3.11" in tasks  # TB2.1 uses dots
    assert len(tasks) == 89



def test_fetch_all_tasks_reads_swebenchpro_from_file() -> None:
    """_fetch_all_tasks reads swebenchpro tasks from the static JSON file."""
    tasks = _fetch_all_tasks("swebenchpro", bench_dir=_BENCH_SCRIPTS_DIR)

    assert len(tasks) == 731
    assert tasks[0].startswith("instance_")


def test_fetch_all_tasks_reads_deep_swe_from_file() -> None:
    """_fetch_all_tasks reads deep-swe tasks from the static JSON file."""
    tasks = _fetch_all_tasks("deep-swe", bench_dir=_BENCH_SCRIPTS_DIR)

    assert len(tasks) == 113
    assert "fastapi-deprecation-response-headers" in tasks
    assert "abs-module-cache-flags" in tasks


def test_fetch_all_tasks_raises_for_unknown_dataset(tmp_path: Path) -> None:
    """_fetch_all_tasks raises RuntimeError for a dataset with no static file."""
    with pytest.raises(RuntimeError, match="No task list file for dataset"):
        _fetch_all_tasks("unknown-dataset", bench_dir=tmp_path)


def test_fetch_all_tasks_has_separate_files_per_dataset_version() -> None:
    """TB2 and TB2.1 have separate task list files because task names differ.

    install-windows-3-11 (TB2, hyphens) vs install-windows-3.11 (TB2.1, dots).
    The old hardcoded list used 'install-windows-3?11' as a wildcard
    to match both — now each file has the exact name.
    """
    tasks_v2 = _fetch_all_tasks("terminal-bench/terminal-bench-2", bench_dir=_BENCH_SCRIPTS_DIR)
    tasks_v21 = _fetch_all_tasks("terminal-bench/terminal-bench-2-1", bench_dir=_BENCH_SCRIPTS_DIR)

    assert len(tasks_v2) == 89
    assert len(tasks_v21) == 89
    assert "install-windows-3-11" in tasks_v2
    assert "install-windows-3.11" in tasks_v21


def test_all_trial_dirs_matches_long_name_via_prefix(tmp_results_dir: Path) -> None:
    """_all_trial_dirs_for_task finds trial dirs when Harbor truncates the task name.

    Instance IDs of 70+ chars. Harbor truncates them when
    creating trial directories (e.g. 'instance_flipt-io__flipt-02e2163__zB3HPks').
    The function should match by checking if the full task name starts with
    the trial dir's prefix (everything before the last '__').
    """
    long_task = "instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1"
    truncated_dir = "instance_flipt-io__flipt-02e2163__zB3HPks"
    trial = tmp_results_dir / "run-1" / truncated_dir
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(json.dumps({
        "trial_name": truncated_dir,
        "verifier_result": {"rewards": {"reward": 0.0}},
    }))

    found = _all_trial_dirs_for_task(tmp_results_dir, long_task)
    assert len(found) == 1
    assert found[0].name == truncated_dir


def test_all_trial_dirs_matches_short_name_via_prefix(tmp_results_dir: Path) -> None:
    """Short task names (terminal-bench) still match via directory name prefix."""
    trial = tmp_results_dir / "run-1" / "fix-git__abc123"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(json.dumps({
        "trial_name": "fix-git",
        "verifier_result": {"rewards": {"reward": 1.0}},
    }))

    found = _all_trial_dirs_for_task(tmp_results_dir, "fix-git")
    assert len(found) == 1
    assert found[0].name == "fix-git__abc123"


def test_task_name_from_result_reads_field(tmp_path: Path) -> None:
    """_task_name_from_result reads the exact task_name Harbor recorded."""
    trial = tmp_path / "task-a__abc1234"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(json.dumps({"task_name": "task-a"}))

    assert _task_name_from_result(trial) == "task-a"


def test_task_name_from_result_strips_source_prefix(tmp_path: Path) -> None:
    """Harbor sometimes prefixes task_name with a source, e.g. 'terminal-bench/task-a'."""
    trial = tmp_path / "task-a__abc1234"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(json.dumps({"task_name": "terminal-bench/task-a"}))

    assert _task_name_from_result(trial) == "task-a"


def test_task_name_from_result_missing_file_returns_none(tmp_path: Path) -> None:
    """Returns None when result.json doesn't exist (trial still running/crashed)."""
    trial = tmp_path / "task-a__abc1234"
    trial.mkdir(parents=True)

    assert _task_name_from_result(trial) is None


def test_task_name_from_result_malformed_json_returns_none(tmp_path: Path) -> None:
    """Returns None when result.json is corrupted rather than raising."""
    trial = tmp_path / "task-a__abc1234"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text("not valid json{")

    assert _task_name_from_result(trial) is None


def test_task_name_from_result_missing_field_returns_none(tmp_path: Path) -> None:
    """Returns None when result.json lacks a task_name field."""
    trial = tmp_path / "task-a__abc1234"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(json.dumps({"trial_name": "task-a__abc1234"}))

    assert _task_name_from_result(trial) is None


def test_all_trial_dirs_prefers_exact_task_name_over_truncated_prefix(
    tmp_results_dir: Path,
) -> None:
    """Regression test: distinct SWE-bench Pro instance IDs sharing the same
    32-char truncated directory prefix must not collide.

    Real dataset example: 'instance_element-hq__element-web-<sha-1>-vnan' and
    'instance_element-hq__element-web-<sha-2>-vnan' both truncate to the
    identical 'instance_element-hq__element-web' prefix. Matching by
    truncated-prefix alone (the old behavior) would attribute task B's
    trial to task A. Matching against the authoritative task_name in
    result.json must not have this collision.
    """
    task_a = "instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan"
    task_b = "instance_element-hq__element-web-1216285ed2e82e62f8780b6702aa0f9abdda0b34-vnan"
    assert task_a[:32].rstrip("_-") == task_b[:32].rstrip("_-"), (
        "fixture must reproduce the real truncated-prefix collision"
    )

    trial_a = tmp_results_dir / "run-1" / "instance_element-hq__element-web__zB3HPks"
    trial_a.mkdir(parents=True)
    (trial_a / "result.json").write_text(json.dumps({
        "trial_name": "instance_element-hq__element-web__zB3HPks",
        "task_name": task_a,
        "verifier_result": {"rewards": {"reward": 1.0}},
    }))

    found_for_a = _all_trial_dirs_for_task(tmp_results_dir, task_a)
    found_for_b = _all_trial_dirs_for_task(tmp_results_dir, task_b)

    assert [p.name for p in found_for_a] == ["instance_element-hq__element-web__zB3HPks"]
    assert found_for_b == [], (
        "task_b must not match task_a's trial dir despite sharing a truncated prefix"
    )


def test_all_trial_dirs_falls_back_to_truncated_prefix_without_result_json(
    tmp_results_dir: Path,
) -> None:
    """Without a readable result.json (e.g. trial crashed before writing it),
    falls back to the truncated directory-name prefix heuristic."""
    long_task = "instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1"
    truncated_dir = "instance_flipt-io__flipt-02e2163__zB3HPks"
    trial = tmp_results_dir / "run-1" / truncated_dir
    trial.mkdir(parents=True)
    # No result.json written at all.

    found = _all_trial_dirs_for_task(tmp_results_dir, long_task)
    assert len(found) == 1
    assert found[0].name == truncated_dir


def _write_result(trial_dir: Path, payload: dict) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps(payload))
    (trial_dir / "trial.log").write_text("")


def test_run_id_format() -> None:
    rid = run_id_from_chunk_attempt(chunk_index=3, chunk_attempt=2)
    assert rid == "chunk-3-attempt-2"


def test_process_classifies_pass_and_writes_local(
    tmp_results_dir: Path,
) -> None:
    """A pass verdict writes the enriched result.json locally with outcome=scored_pass."""
    trial = tmp_results_dir / "run-1" / "task-a__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 1.0}}})

    write_enriched_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-a"],
    )

    # Local file overwritten with enriched version
    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "scored_pass"


def test_process_classifies_infra_and_writes_enriched(
    tmp_results_dir: Path,
) -> None:
    """An error/infra verdict writes the enriched file locally with outcome=error."""
    trial = tmp_results_dir / "run-1" / "task-b__1"
    _write_result(
        trial,
        {
            "exception_info": {"exception_type": "ConnectionError"},
        },
    )

    write_enriched_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-b"],
    )

    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "error"
    assert enriched["error_category"] == "infra"


def test_process_classifies_budget_infra_writes_enriched(tmp_results_dir: Path) -> None:
    """Budget exhaustion is infra; enriched file records error_subcategory."""
    trial = tmp_results_dir / "run-1" / "task-budget__1"
    _write_result(
        trial,
        {
            "exception_info": {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": "API error: insufficient credits to complete request",
            },
        },
    )

    write_enriched_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-budget"],
    )

    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "error"
    assert enriched["error_category"] == "infra"
    assert enriched["error_subcategory"] == "api_key_budget_exceeded"


def test_process_quality_fail_writes_enriched(tmp_results_dir: Path) -> None:
    """A quality-fail verdict (no infra exception) writes enriched result with outcome=scored_fail."""
    trial = tmp_results_dir / "run-1" / "task-c__1"
    _write_result(trial, {"verifier_result": {"rewards": {"reward": 0.0}}})

    write_enriched_results(
        results_dir=tmp_results_dir,
        expected_tasks=["task-c"],
    )

    enriched = json.loads((trial / "result.json").read_text())
    assert enriched["outcome"] == "scored_fail"


def test_main_exits_zero_when_no_tasks_need_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If all tasks classified as final, main exits 0 without invoking Harbor."""
    _main_env(tmp_path, monkeypatch, SELECTED_TASKS_JSON='["task-a","task-b"]')

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
    _main_env(tmp_path, monkeypatch, SELECTED_TASKS_JSON='["task-a","task-b"]')

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
    _main_env(tmp_path, monkeypatch)

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
    _main_env(
        tmp_path, monkeypatch,
        BENCH_CHUNK_COUNT="3",
        SELECTED_TASKS_JSON='["task-a","task-b","task-c"]',
        CI_JOB_ID="12345",
    )

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
    # Job names now carry a round suffix (Phase 5 k=1 rounds): chunk-<i>-<jobid>-r1.
    assert ("--job-name", "chunk-0-12345-r1") in pairs, (
        f"expected --job-name chunk-0-12345-r1 in cmd; got cmd={cmd!r}"
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

    _main_env(tmp_path, monkeypatch)

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

    _ci_env(monkeypatch, CI_JOB_NAME="terminal-bench-2-chunks: [2]", BENCH_CHUNK_INDEX="2")

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

    _ci_env(monkeypatch)
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

    _ci_env(monkeypatch)

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


def test_restore_prior_artifact_skips_prewarm_keeps_retry_health(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pre-warm files are per-attempt (each attempt re-warms a fresh daemon in
    before_script, before restore) and must not be restored over the current
    attempt's counts; retry-health files must be restored (they accumulate)."""
    import io
    import zipfile as zf

    from chunk_runner import _restore_prior_artifact

    _ci_env(monkeypatch, BENCH_CHUNK_INDEX="0")

    archive_buf = io.BytesIO()
    with zf.ZipFile(archive_buf, "w") as z:
        z.writestr(
            "benchmark/terminal-bench-2/jobs/pre-warm-result-chunk-0.json",
            json.dumps({"pulled": 30, "failed": 0}),
        )
        z.writestr(
            "benchmark/terminal-bench-2/jobs/docker-retry-health-chunk-0.json",
            json.dumps({"retry_engagements": 3, "retry_recoveries": 3, "retry_exhausted": 0}),
        )
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

    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeResp(
                json.dumps([
                    {"id": 200, "name": "terminal-bench-2-chunks: [0]"},
                    {"id": 150, "name": "terminal-bench-2-chunks: [0]"},
                ]).encode("utf-8")
            )
        return FakeResp(archive_bytes)

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        restored = _restore_prior_artifact(tmp_path, workspace=tmp_path)

    assert restored is True
    jobs_dir = tmp_path / "benchmark" / "terminal-bench-2" / "jobs"
    assert not (jobs_dir / "pre-warm-result-chunk-0.json").exists()
    assert (jobs_dir / "docker-retry-health-chunk-0.json").is_file()


def test_restore_prior_artifact_returns_false_when_api_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the API call fails, return False and proceed normally (don't crash the chunk)."""
    import urllib.error

    from chunk_runner import _restore_prior_artifact

    _ci_env(monkeypatch)

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

    _ci_env(monkeypatch)

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

    _ci_env(monkeypatch)

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

    _ci_env(monkeypatch)

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
        (
            {"CODING_AGENT": "claude-code", "MODEL": "kimchi-dev/kimi-k2.7", "KIMCHI_FERMENT_ONESHOT": "false"},
            "default",
        ),
        ({"CODING_AGENT": "opencode"}, "default"),
        # kimchi mode is selected through MODEL
        ({"CODING_AGENT": "kimchi", "MODEL": "multi-model", "KIMCHI_FERMENT_ONESHOT": "false"}, "multi-mode"),
        ({"CODING_AGENT": "kimchi", "MODEL": "multi-model", "KIMCHI_FERMENT_ONESHOT": "true"}, "multi-mode-ferment"),
        ({"CODING_AGENT": "kimchi", "MODEL": "kimchi-dev/kimi-k2.7", "KIMCHI_FERMENT_ONESHOT": "false"}, "single-model"),  # noqa: E501
        ({"CODING_AGENT": "kimchi", "MODEL": "kimchi-dev/kimi-k2.7", "KIMCHI_FERMENT_ONESHOT": "true"}, "single-model-ferment"),  # noqa: E501
        # defaults: CODING_AGENT=kimchi with a concrete model
        ({}, "single-model"),
        # KIMCHI_COMPACTION does not affect the configuration label; the resolved
        # value is recorded separately as run-metadata "compaction_disabled"
        ({"CODING_AGENT": "kimchi", "MODEL": "kimchi-dev/kimi-k2.7", "KIMCHI_COMPACTION": "disabled"}, "single-model"),
        ({"CODING_AGENT": "kimchi", "MODEL": "kimchi-dev/kimi-k2.7", "KIMCHI_FERMENT_ONESHOT": "true", "KIMCHI_COMPACTION": "auto"}, "single-model-ferment"),  # noqa: E501
        # the workflow agent is labelled by the workflow it runs, so a workflow
        # run and a stock run of the same model do not share a GCS prefix
        ({"CODING_AGENT": "kimchi-workflow"}, "workflow-ferment-oneshot"),
        ({"CODING_AGENT": "kimchi-workflow", "BENCH_WORKFLOW": "tb-solver"}, "workflow-tb-solver"),
        # the label names the workflow, not the model mode
        (
            {"CODING_AGENT": "kimchi-workflow", "BENCH_WORKFLOW": "tb-solver", "MODEL": "multi-model"},
            "workflow-tb-solver",
        ),
        # blank falls back to the default rather than producing "workflow-"
        ({"CODING_AGENT": "kimchi-workflow", "BENCH_WORKFLOW": "   "}, "workflow-ferment-oneshot"),
    ],
)
def test_derive_configuration(env: dict, expected: str, monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("CODING_AGENT", "MODEL", "KIMCHI_FERMENT_ONESHOT", "KIMCHI_COMPACTION", "BENCH_WORKFLOW"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert _derive_configuration() == expected


# ---------------------------------------------------------------------------
# _compaction_disabled
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "env,expected",
    [
        # default is auto: compaction stays on except for ferment one-shot runs
        ({}, False),
        ({"KIMCHI_FERMENT_ONESHOT": "true"}, True),
        ({"KIMCHI_COMPACTION": "enabled"}, False),
        ({"KIMCHI_COMPACTION": "disabled"}, True),
        # explicit values ignore ferment-oneshot
        ({"KIMCHI_COMPACTION": "enabled", "KIMCHI_FERMENT_ONESHOT": "true"}, False),
        ({"KIMCHI_COMPACTION": "disabled", "KIMCHI_FERMENT_ONESHOT": "false"}, True),
        # auto follows ferment-oneshot
        ({"KIMCHI_COMPACTION": "auto"}, False),
        ({"KIMCHI_COMPACTION": "auto", "KIMCHI_FERMENT_ONESHOT": "true"}, True),
        # tolerant parsing: case and surrounding whitespace, empty falls back to default
        ({"KIMCHI_COMPACTION": " Disabled "}, True),
        ({"KIMCHI_COMPACTION": ""}, False),
        # auto also covers workflow runs: the ferment one-shot baseline they are
        # compared against runs with compaction off, so the default must match
        ({"CODING_AGENT": "kimchi-workflow"}, True),
        ({"CODING_AGENT": "kimchi-workflow", "KIMCHI_COMPACTION": "auto"}, True),
        # explicit values still win for the workflow agent
        ({"CODING_AGENT": "kimchi-workflow", "KIMCHI_COMPACTION": "enabled"}, False),
    ],
)
def test_compaction_disabled_resolution(env: dict, expected: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("KIMCHI_COMPACTION", "KIMCHI_FERMENT_ONESHOT", "CODING_AGENT"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert _compaction_disabled() is expected


def test_compaction_disabled_rejects_unknown_value(monkeypatch: pytest.MonkeyPatch) -> None:
    """A typo in the CI input must fail loudly, not silently benchmark the wrong configuration."""
    monkeypatch.setenv("KIMCHI_COMPACTION", "off")
    with pytest.raises(ValueError, match="KIMCHI_COMPACTION"):
        _compaction_disabled()


# ---------------------------------------------------------------------------
# _agent_import_path
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "coding_agent,expected",
    [
        ("kimchi", "kimchi_agent:Kimchi"),
        ("opencode", "kimchi_agent:OpenCodeKimchi"),
        ("claude-code", "kimchi_agent:ClaudeCodeKimchi"),
        ("claude-code-standard", "kimchi_agent:ClaudeCodeStandard"),
        ("pi", "kimchi_agent:PiKimchi"),
        ("kimchi-workflow", "kimchi_agent:WorkflowAgent"),
        ("pi-workflow", "kimchi_agent:PiWorkflowAgent"),
        ("cursor", "kimchi_agent:CursorAgent"),
    ],
)
def test_agent_import_path(coding_agent: str, expected: str) -> None:
    assert _agent_import_path(coding_agent) == expected


def test_agent_import_path_rejects_unknown_agent() -> None:
    """An agent the pipeline cannot import must fail before Harbor starts."""
    with pytest.raises(SystemExit, match="Unknown CODING_AGENT"):
        _agent_import_path("kimchi-workflows")


# ---------------------------------------------------------------------------
# workflow selection
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("blank", [None, "", "   "])
def test_workflow_selection_falls_back_to_defaults(blank: str | None, monkeypatch: pytest.MonkeyPatch) -> None:
    """A cleared GitLab input field exports an empty variable, not an absent one."""
    for key in ("BENCH_WORKFLOW", "BENCH_WORKFLOW_EXTENSION"):
        monkeypatch.delenv(key, raising=False)
        if blank is not None:
            monkeypatch.setenv(key, blank)

    assert _selected_workflow() == "ferment-oneshot"
    assert _selected_workflow_extension() == "npm:@kimchi-dev/kimchi-workflows@latest"


def test_workflow_selection_trims_surrounding_whitespace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCH_WORKFLOW", "  tb-solver  ")
    monkeypatch.setenv("BENCH_WORKFLOW_EXTENSION", "  dir:/checkouts/kimchi-workflows  ")

    assert _selected_workflow() == "tb-solver"
    assert _selected_workflow_extension() == "dir:/checkouts/kimchi-workflows"


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
        "BENCHMARK_RUN_METADATA": str(tmp_path / ".benchmark" / "run-metadata.json"),
        "BENCHMARK_GCS_BUCKET": "test-bucket",
        "BENCH_PARALLELISM": "1",
        "BENCH_ATTEMPTS": "1",
        "BENCH_TIMEOUT_MULTIPLIER": "1",
        "CODING_AGENT": "kimchi",
        "MODEL": "kimchi-dev/kimi-k2.6",
        "KIMCHI_API_KEY": "test-key",
        "DATASET": "terminal-bench/terminal-bench-2",
        "KIMCHI_FERMENT_ONESHOT": "false",
        "BENCH_RUN_DATE": "2026-06-22",
    }
    for key, val in {**defaults, **overrides}.items():
        monkeypatch.setenv(key, val)


def _ci_env(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    """Set CI env vars needed by _restore_prior_artifact, with optional overrides."""
    defaults = {
        "CI_JOB_TOKEN": "tok",
        "CI_PROJECT_ID": "1",
        "CI_PIPELINE_ID": "100",
        "CI_JOB_ID": "200",
        "CI_JOB_NAME": "terminal-bench-2-chunks: [0]",
        "BENCH_CHUNK_INDEX": "0",
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


def test_multi_model_is_rejected_for_non_kimchi_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _main_env(tmp_path, monkeypatch, CODING_AGENT="opencode", MODEL="multi-model")

    assert main() == 1
    assert "MODEL=multi-model is only supported when CODING_AGENT=kimchi" in capsys.readouterr().err


def test_openrouter_model_is_rejected_for_agent_without_openrouter_routing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="claude-code-standard",
        MODEL="openrouter/z-ai/glm-5.1",
        OPENROUTER_API_KEY="sk-or-test",
        ANTHROPIC_API_KEY="sk-ant-test",
    )

    # claude-code-standard only supports anthropic/* models
    assert main() == 1
    assert "is not supported when CODING_AGENT=claude-code-standard" in capsys.readouterr().err


def test_openrouter_model_requires_openrouter_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _main_env(tmp_path, monkeypatch, CODING_AGENT="claude-code", MODEL="openrouter/z-ai/glm-5.1")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    assert main() == 1
    assert "OPENROUTER_API_KEY is required" in capsys.readouterr().err


def test_openrouter_model_runs_for_claude_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="claude-code",
        MODEL="openrouter/z-ai/glm-5.1",
        OPENROUTER_API_KEY="sk-or-test",
    )

    results_dir = tmp_path / "jobs"
    trial = results_dir / "run-1" / "task-a__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )

    with patch("chunk_runner.run_harbor"):
        assert main() == 0


def test_openrouter_model_runs_for_opencode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """opencode now supports openrouter/* models."""
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="opencode",
        MODEL="openrouter/@preset/glm-5-2-zai",
        OPENROUTER_API_KEY="sk-or-test",
    )

    results_dir = tmp_path / "jobs"
    trial = results_dir / "run-1" / "task-a__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )

    with patch("chunk_runner.run_harbor"):
        assert main() == 0


def test_anthropic_model_runs_for_kimchi(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """anthropic/* models are supported on the kimchi agent via native Anthropic API."""
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="kimchi",
        MODEL="anthropic/claude-sonnet-5",
        ANTHROPIC_API_KEY="sk-ant-test",
    )

    results_dir = tmp_path / "jobs"
    trial = results_dir / "run-1" / "task-a__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )

    with patch("chunk_runner.run_harbor"):
        assert main() == 0


def test_anthropic_model_requires_anthropic_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="kimchi",
        MODEL="anthropic/claude-sonnet-5",
    )
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    assert main() == 1
    assert "ANTHROPIC_API_KEY is required" in capsys.readouterr().err


def test_anthropic_model_does_not_require_kimchi_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """anthropic/* models must not require KIMCHI_API_KEY."""
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="kimchi",
        MODEL="anthropic/claude-sonnet-5",
        ANTHROPIC_API_KEY="sk-ant-test",
    )
    monkeypatch.delenv("KIMCHI_API_KEY", raising=False)

    results_dir = tmp_path / "jobs"
    trial = results_dir / "run-1" / "task-a__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )

    with patch("chunk_runner.run_harbor"):
        assert main() == 0


def test_moonshot_model_does_not_require_kimchi_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="pi-workflow",
        MODEL="moonshotai/kimi-k3",
        MOONSHOT_API_KEY="sk-moonshot-test",
    )
    monkeypatch.delenv("KIMCHI_API_KEY", raising=False)

    results_dir = tmp_path / "jobs"
    trial = results_dir / "run-1" / "task-a__1"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps({"verifier_result": {"rewards": {"reward": 1.0}}})
    )

    with patch("chunk_runner.run_harbor"):
        assert main() == 0


def test_moonshot_model_requires_moonshot_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _main_env(tmp_path, monkeypatch, CODING_AGENT="kimchi", MODEL="moonshotai/kimi-k3")
    monkeypatch.delenv("MOONSHOT_API_KEY", raising=False)

    assert main() == 1
    assert "MOONSHOT_API_KEY is required" in capsys.readouterr().err


def test_moonshot_model_rejects_incompatible_sampling_params_before_harbor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="kimchi",
        MODEL="moonshotai/kimi-k3",
        MOONSHOT_API_KEY="sk-moonshot-test",
        BENCH_LLM_TEMPERATURE="0.7",
    )

    with patch("chunk_runner.run_harbor") as run_harbor:
        assert main() == 1

    run_harbor.assert_not_called()
    assert "moonshotai/kimi-k3 requires temperature=1.0" in capsys.readouterr().err


def test_moonshot_model_is_rejected_for_unsupported_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _main_env(
        tmp_path,
        monkeypatch,
        CODING_AGENT="claude-code-standard",
        MODEL="moonshotai/kimi-k3",
        MOONSHOT_API_KEY="sk-moonshot-test",
        ANTHROPIC_API_KEY="sk-anthropic-test",
    )

    assert main() == 1
    assert "is not supported when CODING_AGENT=claude-code-standard" in capsys.readouterr().err


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
_FROZEN_DATE = "2026-06-22"


def test_build_gcs_key_prefix_is_pipeline_level(monkeypatch: pytest.MonkeyPatch) -> None:
    """The GCS prefix identifies the benchmark run, not the chunk job.

    Two chunks in the same pipeline produce the same prefix; two pipelines
    produce different prefixes. Consumers use this prefix to locate
    jobs.tar.gz + per-trial result.json files.
    """
    pipeline_a = {
        "BENCHMARK_NAME": "terminal-bench-2",
        "CODING_AGENT": "kimchi",
        "MODEL": "multi-model",
        "KIMCHI_FERMENT_ONESHOT": "false",
        "CI_COMMIT_REF_NAME": "benchmarks",
        "CI_COMMIT_SHA": "abc1234567890abcdef1234567890abcdef12345",
        "CI_PIPELINE_ID": "1001",
        "CI_JOB_ID": "9001",
    }

    # Wipe vars the function consults so the dict above is the full env.
    for key in (
        "BENCHMARK_NAME",
        "CODING_AGENT",
        "MODEL",
        "KIMCHI_FERMENT_ONESHOT",
        "CI_COMMIT_REF_NAME",
        "CI_COMMIT_SHA",
        "CI_PIPELINE_ID",
        "CI_JOB_ID",
        "BENCH_RUN_DATE",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BENCH_RUN_DATE", _FROZEN_DATE)

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
    monkeypatch.setenv("MODEL", "multi-model")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")
    monkeypatch.delenv("KIMCHI_COMPACTION", raising=False)
    monkeypatch.setenv("CI_COMMIT_REF_NAME", "benchmarks")
    monkeypatch.setenv("CI_COMMIT_SHA", "abc1234567890abcdef1234567890abcdef12345")
    monkeypatch.setenv("CI_PIPELINE_ID", "1001")
    monkeypatch.setenv("CI_JOB_ID", "9002")
    monkeypatch.setenv("BENCH_RUN_DATE", _FROZEN_DATE)

    _write_run_metadata(tmp_path, ["task-a", "task-b"], chunk_attempt_budget=8)

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
    assert metadata["model"] == "multi-model"
    assert metadata["model_provider"] == "kimchi"
    assert metadata["model_name"] == "multi-model"
    assert metadata["configuration"] == "multi-mode"
    assert metadata["multi_mode"] is True
    # KIMCHI_COMPACTION unset defaults to auto; ferment is off here, so
    # compaction stays enabled.
    assert metadata["compaction_disabled"] is False
    assert "/model_provider=kimchi/model=multi-model/configuration=multi-mode/" in metadata["gcs"]["prefix"]


def test_write_run_metadata_includes_tasks_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_write_run_metadata must include tasks_all so downstream consumers can filter full runs."""
    metadata_path = tmp_path / "run-metadata.json"
    monkeypatch.setenv("BENCHMARK_RUN_METADATA", str(metadata_path))
    monkeypatch.setenv("BENCHMARK_NAME", "terminal-bench-2")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "multi-model")
    monkeypatch.setenv("KIMCHI_FERMENT_ONESHOT", "false")
    monkeypatch.setenv("BENCH_TASKS_ALL", "true")
    monkeypatch.setenv("CI_COMMIT_REF_NAME", "benchmarks")
    monkeypatch.setenv("CI_COMMIT_SHA", "abc1234567890abcdef1234567890abcdef12345")
    monkeypatch.setenv("CI_PIPELINE_ID", "1001")
    monkeypatch.setenv("CI_JOB_ID", "9002")
    monkeypatch.setenv("BENCH_RUN_DATE", _FROZEN_DATE)

    _write_run_metadata(tmp_path, [f"task-{i}" for i in range(89)], chunk_attempt_budget=8)

    metadata = json.loads(metadata_path.read_text())
    assert metadata["tasks_all"] is True


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
        "KIMCHI_FERMENT_ONESHOT": "false",
        "CI_COMMIT_REF_NAME": "benchmarks",
        "CI_COMMIT_SHA": "abc1234567890abcdef1234567890abcdef12345",
        "CI_PIPELINE_ID": "1001",
    }
    # Mirror test_build_gcs_key_prefix_is_pipeline_level: wipe the vars the
    # function consults so `minimal_env` is the full env.
    for key in (
        "BENCHMARK_NAME",
        "CODING_AGENT",
        "MODEL",
        "KIMCHI_FERMENT_ONESHOT",
        "CI_COMMIT_REF_NAME",
        "CI_COMMIT_SHA",
        "CI_PIPELINE_ID",
        "CI_JOB_ID",
        "BENCH_RUN_DATE",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BENCH_RUN_DATE", _FROZEN_DATE)
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


def test_build_gcs_key_prefix_uses_bench_run_date_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BENCH_RUN_DATE is the sole source of the date= segment.

    setup-image computes BENCH_RUN_DATE once and passes it downstream via
    bench.env. If a chunk is retried on a different UTC day, the GCS prefix
    must still contain the original date, not the retry date.
    """
    pinned_date = "2026-06-20"

    for key in (
        "BENCHMARK_NAME",
        "CODING_AGENT",
        "MODEL",
        "KIMCHI_FERMENT_ONESHOT",
        "CI_COMMIT_REF_NAME",
        "CI_COMMIT_SHA",
        "CI_PIPELINE_ID",
        "CI_JOB_ID",
        "BENCH_RUN_DATE",
    ):
        monkeypatch.delenv(key, raising=False)

    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("CI_PIPELINE_ID", "1001")
    monkeypatch.setenv("BENCH_RUN_DATE", pinned_date)

    prefix = _build_gcs_key_prefix()
    assert f"date={pinned_date}" in prefix, (
        f"BENCH_RUN_DATE must appear in prefix; expected date={pinned_date} in {prefix!r}"
    )


def test_build_gcs_key_prefix_fails_without_bench_run_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing BENCH_RUN_DATE must raise SystemExit, not silently fall back to wall-clock.

    If setup-image didn't run or bench.env wasn't propagated, the job should
    fail loudly rather than embed a different date that breaks retry stability.
    """
    for key in (
        "BENCHMARK_NAME",
        "CODING_AGENT",
        "MODEL",
        "KIMCHI_FERMENT_ONESHOT",
        "CI_COMMIT_REF_NAME",
        "CI_COMMIT_SHA",
        "CI_PIPELINE_ID",
        "CI_JOB_ID",
        "BENCH_RUN_DATE",
    ):
        monkeypatch.delenv(key, raising=False)

    monkeypatch.setenv("CODING_AGENT", "kimchi")
    monkeypatch.setenv("MODEL", "kimchi-dev/kimi-k2.6")
    monkeypatch.setenv("CI_PIPELINE_ID", "1001")

    with pytest.raises(SystemExit, match="BENCH_RUN_DATE is required"):
        _build_gcs_key_prefix()


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


# ---------------------------------------------------------------------------
# _all_trial_dirs_for_task — returns ALL trial dirs, not just one
# ---------------------------------------------------------------------------

class TestAllTrialDirsForTask:
    def test_multiple_trial_dirs_across_run_subdirs(self, tmp_path: Path) -> None:
        """Returns all trial dirs for a task across multiple run subdirs."""
        (tmp_path / "run-1" / "task-a__abc1234").mkdir(parents=True)
        (tmp_path / "run-1" / "task-a__def5678").mkdir(parents=True)
        (tmp_path / "run-2" / "task-a__ghi9012").mkdir(parents=True)

        result = _all_trial_dirs_for_task(tmp_path, "task-a")

        assert len(result) == 3
        names = [p.name for p in result]
        assert "task-a__abc1234" in names
        assert "task-a__def5678" in names
        assert "task-a__ghi9012" in names
        assert result == sorted(result, key=lambda p: p.name)

    def test_zero_matches_returns_empty_list(self, tmp_path: Path) -> None:
        """Returns empty list when no trial dirs match."""
        (tmp_path / "run-1" / "task-b__xyz").mkdir(parents=True)

        result = _all_trial_dirs_for_task(tmp_path, "task-a")

        assert result == []

    def test_prefix_match_does_not_match_other_tasks(self, tmp_path: Path) -> None:
        """task-a does not match task-aa."""
        (tmp_path / "run-1" / "task-a__abc1234").mkdir(parents=True)
        (tmp_path / "run-1" / "task-aa__def5678").mkdir(parents=True)

        result = _all_trial_dirs_for_task(tmp_path, "task-a")

        assert len(result) == 1
        assert result[0].name == "task-a__abc1234"

    def test_results_dir_does_not_exist_returns_empty_list(self, tmp_path: Path) -> None:
        """Returns empty list when results_dir doesn't exist."""
        result = _all_trial_dirs_for_task(tmp_path / "nonexistent", "task-a")
        assert result == []

    def test_ignores_non_directory_files(self, tmp_path: Path) -> None:
        """Only returns directories, not files."""
        (tmp_path / "run-1").mkdir(parents=True)
        (tmp_path / "run-1" / "task-a__abc1234").mkdir()
        (tmp_path / "run-1" / "task-a__not_a_dir.txt").write_text("ignored")

        result = _all_trial_dirs_for_task(tmp_path, "task-a")

        assert len(result) == 1
        assert result[0].name == "task-a__abc1234"


# ---------------------------------------------------------------------------
# write_enriched_results — multi-trial enriched result.json writeback
# ---------------------------------------------------------------------------

def _write_enriched_result(
    trial_dir: Path,
    *,
    reward: float | None = None,
    outcome: Outcome = Outcome.SCORED_PASS,
    error_category: str | None = None,
    error_subcategory: str | None = None,
) -> None:
    """Write a minimal enriched result.json for write_enriched_results tests.

    This helper writes a pre-classified result (with ``outcome`` already set),
    bypassing the real ``classify()`` call that ``write_enriched_results`` makes
    internally.  That is intentional: ``classify()`` reads ``result.json`` and,
    when it finds an ``outcome`` field already present, propagates it through
    the enriched schema — so the round-trip is consistent.  Tests that need
    real classification (e.g. ``TestMainRetryFlow``) should use the lower-level
    ``_write_result`` helper instead, which writes raw verifier/exception payloads.
    """
    raw: dict = {}
    if reward is not None:
        raw["verifier_result"] = {"rewards": {"reward": reward}}
    enriched = {
        **raw,
        "outcome": outcome,
        "error_category": error_category,
        "error_subcategory": error_subcategory,
    }
    (trial_dir / "result.json").write_text(json.dumps(enriched) + "\n")


class TestWriteEnrichedResultsMultiTrial:
    def test_enriched_result_json_written_for_every_trial(self, tmp_path: Path) -> None:
        """Every trial dir gets an enriched result.json, not just one."""
        t1 = tmp_path / "run-1" / "task-a__abc1234"
        t2 = tmp_path / "run-1" / "task-a__def5678"
        t1.mkdir(parents=True)
        t2.mkdir(parents=True)
        _write_enriched_result(t1, reward=1.0, outcome=Outcome.SCORED_PASS)
        _write_enriched_result(t2, outcome=Outcome.ERROR, error_category="infra",
                               error_subcategory="agent_process_killed")

        write_enriched_results(
            results_dir=tmp_path, expected_tasks=["task-a"]
        )

        for trial_dir in [t1, t2]:
            data = json.loads((trial_dir / "result.json").read_text())
            assert "outcome" in data
            assert "error_category" in data
            assert "error_subcategory" in data

    def test_multiple_tasks_all_enriched(self, tmp_path: Path) -> None:
        """Two tasks: every trial dir across both tasks gets enriched."""
        pass_dir = tmp_path / "run-1" / "task-a__abc1234"
        infra_dir = tmp_path / "run-1" / "task-b__def5678"
        pass_dir.mkdir(parents=True)
        infra_dir.mkdir(parents=True)
        _write_enriched_result(pass_dir, reward=1.0, outcome=Outcome.SCORED_PASS)
        _write_enriched_result(infra_dir, outcome=Outcome.ERROR, error_category="infra",
                               error_subcategory="agent_process_killed")

        write_enriched_results(
            results_dir=tmp_path, expected_tasks=["task-a", "task-b"]
        )

        for trial_dir in [pass_dir, infra_dir]:
            data = json.loads((trial_dir / "result.json").read_text())
            assert "outcome" in data
            assert "error_category" in data
            assert "error_subcategory" in data

    def test_task_with_no_trials_no_error(self, tmp_path: Path) -> None:
        """A task with zero trial dirs is silently skipped (no crash)."""
        write_enriched_results(
            results_dir=tmp_path, expected_tasks=["task-a"]
        )
        # Nothing to assert beyond not raising.


# ---------------------------------------------------------------------------
# main() retry flow — harbor_attempts on first attempt vs retry
# ---------------------------------------------------------------------------

class TestMainRetryFlow:
    """Verify that main() passes the correct -k to Harbor on retry."""

    def test_first_attempt_runs_k1_round_and_completes(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """First attempt: k=1 round scheduling, completes when the trial passes.

        Phase 5 replaced the global -k=BENCH_ATTEMPTS single invocation with
        k=1 rounds (exact attempt accounting). With BENCH_ATTEMPTS=1 and one
        task, a single passing trial completes the task in one round.
        pass@k multiplicity is covered by test_reconcile.py.
        """
        _main_env(tmp_path, monkeypatch, BENCH_ATTEMPTS="1")
        monkeypatch.setenv("BENCHMARK_NAME", "terminal-bench-2")
        monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
        monkeypatch.setenv("BENCH_RETRY_AGENT_TIMEOUT", "false")

        import chunk_runner

        captured_attempts: list[int] = []

        def mock_build(**kwargs):
            captured_attempts.append(kwargs["attempts"])
            return ["echo", "mocked"]

        monkeypatch.setattr(chunk_runner, "build_harbor_command", mock_build)

        class FakeProc:
            def poll(self):
                return 0
            def wait(self):
                return 0
            def terminate(self):
                pass

        results_dir = Path(str(tmp_path / "jobs"))

        def mock_run_harbor(**kw):
            # Simulate Harbor creating a passing trial dir
            trial_dir = results_dir / "run-1" / "task-a__mock1234"
            trial_dir.mkdir(parents=True, exist_ok=True)
            _write_result(trial_dir, {"verifier_result": {"rewards": {"reward": 1.0}}})
            return FakeProc()

        monkeypatch.setattr(chunk_runner, "run_harbor", mock_run_harbor)

        exit_code = main()
        assert exit_code == 0
        # One k=1 round sufficed because the trial passed.
        assert len(captured_attempts) == 1
        assert captured_attempts[0] == 1

    def test_retry_runs_k1_round_and_completes(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Retry with 3 durable infra-error trials: k=1 round completes it.

        The 3 existing trials are retryable infra errors, so they don't fill
        pass@k slots. With BENCH_ATTEMPTS=1, a single passing trial from the
        first k=1 round fills the one slot and completes the task.
        """
        _main_env(tmp_path, monkeypatch, BENCH_ATTEMPTS="1")
        monkeypatch.setenv("BENCHMARK_NAME", "terminal-bench-2")
        monkeypatch.setenv("DATASET", "terminal-bench/terminal-bench-2")
        monkeypatch.setenv("BENCH_RETRY_AGENT_TIMEOUT", "false")
        # chunk_attempt=2; keep this attempt below the final work attempt so
        # the 3 infra trials remain retryable (don't fill slots) and Harbor
        # actually runs.
        monkeypatch.setenv("BENCH_CHUNK_ATTEMPT_BUDGET", "3")

        results_dir = Path(str(tmp_path / "jobs"))

        # Create 3 infra-error trial dirs with proper exception_info
        # so real classify() returns ERROR/infra/agent_process_killed
        for suffix in ["abc1234", "def5678", "ghi9012"]:
            d = results_dir / "run-1" / f"task-a__{suffix}"
            d.mkdir(parents=True)
            _write_result(d, {
                "exception_info": {
                    "exception_type": "NonZeroAgentExitCodeError",
                    "exception_message": "command failed (exit 137)",
                    "exception_traceback": "Process killed\n/installed-agent/bin/kimchi",
                },
            })

        # Write chunk-meta so _detect_chunk_attempt returns 2
        meta_dir = results_dir / "chunk-meta"
        meta_dir.mkdir(parents=True)
        (meta_dir / "chunk-0.json").write_text(json.dumps({
            "chunk_index": 0,
            "chunk_attempt": 1,
            "exit_code": 1,
            "needs_retry": ["task-a"],
            "timestamp": "2026-07-12T00:00:00Z",
        }))

        import chunk_runner

        captured_attempts: list[int] = []

        def mock_build(**kwargs):
            captured_attempts.append(kwargs["attempts"])
            return ["echo", "mocked"]

        monkeypatch.setattr(chunk_runner, "build_harbor_command", mock_build)

        class FakeProc:
            def poll(self):
                return 0
            def wait(self):
                return 0
            def terminate(self):
                pass

        def mock_run_harbor(**kw):
            # Simulate Harbor creating a passing trial dir
            trial_dir = results_dir / "run-1" / "task-a__mock1234"
            trial_dir.mkdir(parents=True, exist_ok=True)
            _write_result(trial_dir, {"verifier_result": {"rewards": {"reward": 1.0}}})
            return FakeProc()

        monkeypatch.setattr(chunk_runner, "run_harbor", mock_run_harbor)

        exit_code = main()
        assert exit_code == 0
        # k=1 round scheduling: the passing trial filled a slot in one round.
        assert len(captured_attempts) == 1
        assert captured_attempts[0] == 1


def test_main_rejects_unsupported_moonshot_thinking_level_at_pipeline_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """moonshotai/kimi-k3 + THINKING_LEVEL=medium fails before Harbor launches."""
    _main_env(
        tmp_path,
        monkeypatch,
        MODEL="moonshotai/kimi-k3",
        THINKING_LEVEL="medium",
        MOONSHOT_API_KEY="test-key",
    )

    with patch("chunk_runner.run_harbor") as mock_harbor:
        exit_code = main()

    assert exit_code == 1
    assert (
        "THINKING_LEVEL='medium' is not supported by MODEL=moonshotai/kimi-k3"
        in capsys.readouterr().err
    )
    mock_harbor.assert_not_called()
